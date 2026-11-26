/**
 * DS-V5 as data: the state machine, the five stages, the artifact registry, the
 * C-rule table and the three gates.
 *
 * Everything in this module is a transcription of `Agent技术方案设计-DS-V5.md`
 * (and of the `.claude/` assets it revises). The point of keeping it as data is
 * that the tools, the commands, the workflow script and the tests all read the
 * same table — a rule can never drift between the dispatcher and the checker.
 */

/** @typedef {'CREATED'|'BASELINE_CONFIRMED'|'A1_RUNNING'|'A2_RUNNING'|'A3_RUNNING'|'A4_RUNNING'|'A5_RUNNING'|'WAITING_G1'|'WAITING_G2'|'WAITING_G3'|'DESIGN_REVISION'|'WAITING_DEPENDENCY'|'COMPLETED'|'BLOCKED'} WorkflowState */

/** All fourteen workflow states, in lifecycle order. */
export const STATES = [
  'CREATED',
  'BASELINE_CONFIRMED',
  'A1_RUNNING',
  'A2_RUNNING',
  'A3_RUNNING',
  'A4_RUNNING',
  'A5_RUNNING',
  'WAITING_G1',
  'WAITING_G2',
  'WAITING_G3',
  'DESIGN_REVISION',
  'WAITING_DEPENDENCY',
  'COMPLETED',
  'BLOCKED',
]

/**
 * States that end a dispatch pass: the script returns instead of starting an
 * agent. `gate` is set when a human decision is what unblocks the run.
 * @type {Record<string, {reason: string, gate?: 'G1'|'G2'|'G3'}>}
 */
export const STOP_STATES = {
  CREATED: { reason: '尚未登记人工基线：需要人提供 repository / knowledge_graph / documentation / skills 四项后执行 /etp-awf-start' },
  WAITING_G1: { reason: '等待人工门禁 G1（需求确认）', gate: 'G1' },
  WAITING_G2: { reason: '等待人工门禁 G2（影响分析确认）', gate: 'G2' },
  WAITING_G3: { reason: '等待人工门禁 G3（设计确认）', gate: 'G3' },
  WAITING_DEPENDENCY: { reason: '等待依赖 US 完成（批次模式）' },
  COMPLETED: { reason: '本 US 设计已完成并冻结' },
  BLOCKED: { reason: '已 BLOCKED：见 blocked_reasons 与 /etp-awf-status' },
}

/**
 * Stage executable states → the stage they run. A stage re-enters its own
 * `*_RUNNING` state when a pass starts and leaves it after verification.
 */
export const STAGE_OF_STATE = {
  BASELINE_CONFIRMED: 'A1',
  A1_RUNNING: 'A1',
  A2_RUNNING: 'A2',
  A3_RUNNING: 'A3',
  A4_RUNNING: 'A4',
  A5_RUNNING: 'A5',
}

/**
 * The five deliverable stages. `dir` is the only directory the stage may write,
 * `skills` are the skill names its agent must load, `checks` are the C rules the
 * verifying pass must evaluate, `outputs` are the artifact ids it must produce.
 * @type {Record<string, {id: string, name: string, dir: string, phase: string, agent: string, skills: string[], refs: string[], checks: string[], inputs: string[], outputs: string[], mission: string[]}>}
 */
export const STAGES = {
  A1: {
    id: 'A1',
    name: '需求获取',
    dir: '01-source',
    phase: 'A1 需求获取',
    agent: 'etp-requirement-collector',
    skills: ['etp-requirement-fetch'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'state-machine.md'],
    checks: ['C13', 'C14'],
    inputs: ['00-workflow/analysis-baseline.yaml', '人工提供的 US 标识或链接（args.usRef）'],
    outputs: ['01-source/source-package.yaml', '01-source/backend-scope.md', '01-source/raw.md', '01-source/assets/'],
    mission: [
      '取回 US 正文与全部附件，正文逐字写入 01-source/raw.md 并记录 content_hash；01-source/ 下除本阶段产物外不得出现别的文件。',
      '按 artifact-protocol.md 产 ART-10 source-package.yaml（source/snapshot/blocks/excluded/links/gaps/backend_scope）与 ART-11 backend-scope.md（Markdown 只能由 YAML 渲染）。',
      '每个内容块必须有 scope（backend / frontend / out_of_scope / infrastructure），被排除的块在 excluded[] 写明理由；前端与越界内容不得丢弃。',
      '图片按识读卡处理：id/path/type/kind/parse_status/text/description/backend_signals/related_blocks/confidence/missing_parts 全部填写；parse_status 非 parsed 时 missing_parts 必填并登记 gap，不得凭猜测补全文字。',
      '取不到 US 或附件无法读取时写 gaps[] 并返回 blocked，不得虚构需求内容。',
      '不解释需求、不评估代码影响、不写设计——那是 A2/A3/A4 的职责。',
    ],
  },
  A2: {
    id: 'A2',
    name: '需求澄清',
    dir: '02-requirement',
    phase: 'A2 需求澄清',
    agent: 'etp-requirement-analyst',
    skills: ['etp-design-doc-writing', 'etp-legacy-saas-analysis'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C01', 'C02'],
    inputs: ['01-source/source-package.yaml', '01-source/backend-scope.md', '00-workflow/analysis-baseline.yaml'],
    outputs: ['02-requirement/requirement-package.yaml', '02-requirement/requirement-clarification.md', '02-requirement/decision-log.yaml'],
    mission: [
      '产 ART-20 requirement-package.yaml（rules[]/acceptance[]/open_questions[]/baseline_behavior[]）、ART-21 requirement-clarification.md、ART-22 decision-log.yaml（存在待确认决策时才建）。',
      '每条规则必须有 source（explicit/specification/existing/inferred/unknown/human 六选一）与 confidence；推断来源的规则必须 confirmation_required=true 且 decision_status 不得为 confirmed（C02）。',
      '验收标准 AC 的 expected 必须可被测试验证：写清前置条件、步骤、预期结果；涉及角色/租户的写 role_scope/tenant_scope。',
      'open_questions 中 blocking=true 且 status=open 的条目会阻断 G1；不得为了推进而把未确认问题标成 resolved。',
      '只处理 01-source 已登记的块；发现需求块缺失或越界时写 scope_errors[] 上报回 A1，不得自行补全。',
      '不读业务代码、不评估实现、不写技术方案。',
    ],
  },
  A3: {
    id: 'A3',
    name: '代码影响分析',
    dir: '03-impact',
    phase: 'A3 代码影响分析',
    agent: 'etp-impact-analyst',
    skills: ['etp-code-graph-query', 'etp-project-checklist', 'etp-legacy-saas-analysis'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C03', 'C04', 'C15'],
    inputs: ['02-requirement/requirement-package.yaml', '00-workflow/analysis-baseline.yaml'],
    outputs: ['03-impact/impact-package.yaml', '03-impact/impact-analysis.md', '03-impact/evidence-manifest.yaml'],
    mission: [
      '按七步法顺序执行：规则→入口映射、调用链追踪、静态复核、运行时证据、六类横向检查（DB/缓存/MQ/API/权限/租户）、存量行为对比、风险分级。静态复核不可跳过。',
      '产 ART-30 impact-package.yaml、ART-31 impact-analysis.md、ART-32 evidence-manifest.yaml（每条证据可复现：查询语句/文件路径/运行命令）。',
      '每个 impact 的 evidence[].type 取七型之一：graph_proven / static_analysis / runtime_proven / configuration_proven / git_history / heuristic / needs_runtime_confirm；后两型不得单独支撑 mandatory 判定。',
      '每条 mandatory 必须能指向 A2 的规则或验收标准（C03）；存在 BLOCKER/HIGH 风险时 G2 必须已完成（C04，draft 模式除外）。',
      '拿不到证据时写 evidence_gap 四要素（what / why_static_insufficient / would_mislead / how_to_fill），不得推断为「无影响」。',
      'risk 用稳定 ID RSK-01…RSK-12 计算：risk(impact)=max_level(命中 RSK)，无命中记 MEDIUM；risk_rule_hits 只允许写 RSK-NN。',
      '不改需求范围、不写技术方案、不改代码。',
    ],
  },
  A4: {
    id: 'A4',
    name: '技术设计',
    dir: '04-design',
    phase: 'A4 技术设计',
    agent: 'etp-technical-designer',
    skills: ['etp-design-doc-writing', 'etp-project-checklist', 'etp-legacy-saas-analysis'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C05', 'C06', 'C07', 'C10', 'C17', 'C20'],
    inputs: ['03-impact/impact-package.yaml', '02-requirement/requirement-package.yaml'],
    outputs: ['04-design/technical-design-package.yaml', '04-design/technical-design.md', '04-design/adrs/', '04-design/design-coverage.yaml', '04-design/expected-file-changes.yaml'],
    mission: [
      '产 ART-40 technical-design-package.yaml、ART-41 technical-design.md、ART-42 adrs/ADR-NNN.yaml、ART-43 design-coverage.yaml、ART-44 expected-file-changes.yaml。',
      '每个 DESIGN 的 approach 必须具体到「在 X 类 Y 方法增加 Z 校验」，不得写「优化逻辑」这类空话；每个 mandatory 触点都要被某个 designs[].impact_refs 覆盖（C05）。',
      '每个 DESIGN 至少被一个 ADR 的 references[] 覆盖；有迁移时必须存在 ADR（C06）。ADR 的 options 至少两个，被否项必须写 rejected_because。',
      '契约类触点（Controller/API/Listener/Producer/Consumer/MQ）时 compatibility.required=true、strategy 非空、contracts[] 覆盖（C07）；偏差走 compatibility.deviations[] 并带 waiver_ref。',
      'migration / compatibility / observability / rollback 四段不得为空；required=false 也要写理由。migration.required=true 时 rollback 必填，不可逆 DDL 必须有人工签署的 risk_acceptance（C20）。',
      'file_changes 每条必须同时挂 impact_refs 与 design_refs（C11）；超过 25 个文件或新增文件超过 3 个时必须有 ADR 说明。',
      'ART-43 每行可复算：ref_id 在上游存在、design_id 在 designs[] 存在、section 能在 ART-41 定位、status=Missing 必须有 note（C17）。',
      '不改影响范围、不改需求、不写业务代码。',
    ],
  },
  A5: {
    id: 'A5',
    name: '独立评审',
    dir: '05-review',
    phase: 'A5 独立评审',
    agent: 'etp-design-reviewer',
    skills: ['etp-design-review', 'etp-project-checklist', 'etp-code-graph-query'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C08', 'C09', 'C12', 'C15', 'C16'],
    inputs: ['01-source/…', '02-requirement/…', '03-impact/…', '04-design/…'],
    outputs: ['05-review/review-report.yaml', '05-review/review-report.md', '05-review/revision-instructions.yaml'],
    mission: [
      '产 ART-50 review-report.yaml（conclusion/blocking_issues/suggestions/conditions/coverage/checklist/independent_verification/cross_us/round）与 ART-51 review-report.md；需要回流时产 ART-52 revision-instructions.yaml。',
      '独立检索不得少于 10 次，query 逐条记入 independent_verification.queries[]；不复用 A3 的结论，自己查一遍。',
      '按八层评审：L1 需求覆盖、L2 影响覆盖、L3 设计正确性、L4 数据与契约、L5 SaaS 与检查项、L6 发布与回滚、L7 合理性、L8 跨 US 一致性。',
      '结论只取 PASS / CONDITIONAL_PASS / FAIL；CONDITIONAL_PASS 必须把每个条件写成 conditions[] 条目（含责任人），条件未关闭不得进入 G3。',
      '发现问题写进 blocking_issues[]，每条带 references/evidence/recommendation/return_to；回流指令写 ART-52 并限定到具体 DESIGN 或 IMPACT。',
      '不替 A4 改设计、不替 A3 改影响范围：只给要求和证据。',
    ],
  },
}

/** Ordered stage ids. */
export const STAGE_ORDER = ['A1', 'A2', 'A3', 'A4', 'A5']

/** The state a stage leaves behind when its verification passes. */
export const STAGE_DONE_STATE = {
  A1: 'WAITING_G1',
  A2: 'WAITING_G1',
  A3: 'WAITING_G2',
  A4: 'WAITING_G3',
  A5: 'WAITING_G3',
}

/**
 * State transitions with their guard. A guard returns `null` when the move is
 * legal and a human-readable reason when it is not — the dispatcher turns that
 * into a stop instead of guessing.
 * @type {{id: string, from: string, to: string, note: string}[]}
 */
export const TRANSITIONS = [
  { id: 'T01', from: 'CREATED', to: 'BASELINE_CONFIRMED', note: '/etp-awf-start 登记四项基线后进入' },
  { id: 'T02', from: 'BASELINE_CONFIRMED', to: 'A1_RUNNING', note: 'A1 派发' },
  { id: 'T03', from: 'A1_RUNNING', to: 'WAITING_G1', note: 'A1 校验通过' },
  { id: 'T04', from: 'WAITING_G1', to: 'A2_RUNNING', note: 'G1 APPROVED' },
  { id: 'T05', from: 'A2_RUNNING', to: 'WAITING_G1', note: 'A2 校验通过（同门禁复审）' },
  { id: 'T06', from: 'WAITING_G1', to: 'A3_RUNNING', note: 'G1 APPROVED 后继续' },
  { id: 'T07', from: 'A3_RUNNING', to: 'WAITING_G2', note: 'A3 校验通过' },
  { id: 'T08', from: 'WAITING_G2', to: 'A4_RUNNING', note: 'G2 APPROVED' },
  { id: 'T09', from: 'A4_RUNNING', to: 'WAITING_G3', note: 'A4 校验通过' },
  { id: 'T10', from: 'WAITING_G3', to: 'A5_RUNNING', note: 'G3 APPROVED' },
  { id: 'T11', from: 'A5_RUNNING', to: 'WAITING_G3', note: 'A5 结论非 FAIL 且条件已关' },
  { id: 'T12', from: 'WAITING_G3', to: 'COMPLETED', note: 'G3 APPROVED 后冻结' },
  { id: 'T13', from: 'WAITING_G2', to: 'DESIGN_REVISION', note: 'G2 REJECTED 且需重做影响分析' },
  { id: 'T14', from: 'WAITING_G3', to: 'DESIGN_REVISION', note: 'G3 REJECTED 或 A5 FAIL' },
  { id: 'T15', from: 'DESIGN_REVISION', to: 'A4_RUNNING', note: '回流 A4' },
  { id: 'T16', from: 'DESIGN_REVISION', to: 'A3_RUNNING', note: '回流 A3' },
  { id: 'T17', from: 'DESIGN_REVISION', to: 'A2_RUNNING', note: '回流 A2' },
  { id: 'T18', from: 'DESIGN_REVISION', to: 'A1_RUNNING', note: '回流 A1' },
  { id: 'T19', from: '*', to: 'BLOCKED', note: '任一阶段两次空返回 / 证据缺口超限 / 轮次用尽' },
  { id: 'T20', from: 'BLOCKED', to: 'A1_RUNNING', note: '解阻后回流 A1' },
  { id: 'T21', from: 'BLOCKED', to: 'A2_RUNNING', note: '解阻后回流 A2' },
  { id: 'T22', from: 'BLOCKED', to: 'A3_RUNNING', note: '解阻后回流 A3' },
  { id: 'T23', from: 'BLOCKED', to: 'A4_RUNNING', note: '解阻后回流 A4' },
  { id: 'T24', from: 'BLOCKED', to: 'A5_RUNNING', note: '解阻后回流 A5' },
  { id: 'T25', from: 'WAITING_DEPENDENCY', to: 'BASELINE_CONFIRMED', note: '依赖 US 完成' },
  { id: 'T26', from: 'COMPLETED', to: 'DESIGN_REVISION', note: '冻结后变更需新版本回流' },
  { id: 'T27', from: 'BASELINE_CONFIRMED', to: 'WAITING_G1', note: 'A1 产物已存在且校验通过时跳过派发' },
]

/** Artifact registry: id → {dir, file, kind, label}. `yaml` artifacts carry the machine truth. */
export const ARTIFACTS = {
  'ART-00': { dir: '00-workflow', file: 'workflow-manifest.yaml', kind: 'yaml', label: '工作流状态机' },
  'ART-01': { dir: '00-workflow', file: 'analysis-baseline.yaml', kind: 'yaml', label: '分析基线' },
  'ART-02': { dir: '00-workflow', file: 'artifact-manifest.yaml', kind: 'yaml', label: '产物清单与哈希' },
  'ART-03': { dir: '00-workflow', file: 'workflow-report.md', kind: 'markdown', label: '执行报告' },
  'ART-04': { dir: '..', file: 'portfolio.yaml', kind: 'yaml', label: '多 US 批次' },
  'ART-10': { dir: '01-source', file: 'source-package.yaml', kind: 'yaml', label: '需求来源包' },
  'ART-11': { dir: '01-source', file: 'backend-scope.md', kind: 'markdown', label: '后端范围' },
  'ART-20': { dir: '02-requirement', file: 'requirement-package.yaml', kind: 'yaml', label: '需求规则与验收' },
  'ART-21': { dir: '02-requirement', file: 'requirement-clarification.md', kind: 'markdown', label: '需求澄清说明' },
  'ART-22': { dir: '02-requirement', file: 'decision-log.yaml', kind: 'yaml', label: '决策记录' },
  'ART-30': { dir: '03-impact', file: 'impact-package.yaml', kind: 'yaml', label: '影响分析包' },
  'ART-31': { dir: '03-impact', file: 'impact-analysis.md', kind: 'markdown', label: '影响分析说明' },
  'ART-32': { dir: '03-impact', file: 'evidence-manifest.yaml', kind: 'yaml', label: '证据清单' },
  'ART-40': { dir: '04-design', file: 'technical-design-package.yaml', kind: 'yaml', label: '技术设计包' },
  'ART-41': { dir: '04-design', file: 'technical-design.md', kind: 'markdown', label: '技术设计说明' },
  'ART-42': { dir: '04-design', file: 'adrs', kind: 'directory', label: '架构决策记录' },
  'ART-43': { dir: '04-design', file: 'design-coverage.yaml', kind: 'yaml', label: '设计覆盖矩阵' },
  'ART-44': { dir: '04-design', file: 'expected-file-changes.yaml', kind: 'yaml', label: '预期文件变更' },
  'ART-50': { dir: '05-review', file: 'review-report.yaml', kind: 'yaml', label: '评审报告' },
  'ART-51': { dir: '05-review', file: 'review-report.md', kind: 'markdown', label: '评审说明' },
  'ART-52': { dir: '05-review', file: 'revision-instructions.yaml', kind: 'yaml', label: '修订指令' },
}

/** Artifact ids each stage must produce, in gate order. */
export const STAGE_ARTIFACTS = {
  A1: ['ART-10', 'ART-11'],
  A2: ['ART-20', 'ART-21'],
  A3: ['ART-30', 'ART-31', 'ART-32'],
  A4: ['ART-40', 'ART-41', 'ART-43', 'ART-44'],
  A5: ['ART-50', 'ART-51'],
}

/** Optional artifacts a stage may add when the situation requires them. */
export const STAGE_OPTIONAL_ARTIFACTS = {
  A2: ['ART-22'],
  A4: ['ART-42'],
  A5: ['ART-52'],
}

/**
 * The C rules. `strength` is DS-V5 §4.2: A = the plugin decides, B = it flags and
 * a human signs, C = human only. `gate` lists the gates where the rule gates entry.
 * @type {{id: string, title: string, strength: 'A'|'B'|'C', stage: string|null, gate: string[], blocking: boolean}[]}
 */
export const CHECKS = [
  { id: 'C01', title: '每条规则都有非 unknown 来源，验收标准覆盖规则', strength: 'A', stage: 'A2', gate: ['G1'], blocking: true },
  { id: 'C02', title: '不存在 inferred + confirmation_required + confirmed 的规则', strength: 'A', stage: 'A2', gate: ['G1'], blocking: true },
  { id: 'C03', title: 'mandatory 触点至少指向一条存在的 A2 规则或验收标准', strength: 'A', stage: 'A3', gate: ['G2'], blocking: true },
  { id: 'C04', title: '存在 BLOCKER/HIGH 时 G2 已完成（draft 除外）', strength: 'A', stage: 'A3', gate: ['G3'], blocking: true },
  { id: 'C05', title: '每个 mandatory 触点被某个 DESIGN 的 impact_refs 覆盖', strength: 'A', stage: 'A4', gate: ['G3'], blocking: true },
  { id: 'C06', title: '每个 DESIGN 至少被一个 ADR 覆盖，迁移必须有 ADR', strength: 'A', stage: 'A4', gate: ['G3'], blocking: true },
  { id: 'C07', title: '契约类触点必须声明兼容策略并覆盖 contracts', strength: 'A', stage: 'A4', gate: ['G3'], blocking: true },
  { id: 'C08', title: 'A5 结论非 FAIL 且无 open 阻断问题', strength: 'A', stage: 'A5', gate: ['G3'], blocking: true },
  { id: 'C09', title: '所有 *_ref 与当前上游版本一致（纯文字修改可豁免）', strength: 'B', stage: null, gate: ['G2', 'G3'], blocking: true },
  { id: 'C10', title: '关键人工修改后对应门禁已重新确认', strength: 'B', stage: null, gate: ['G3'], blocking: true },
  { id: 'C11', title: 'DESIGN 引用可回溯；每个 file_change 同时挂 DESIGN 与 IMPACT', strength: 'A', stage: 'A4', gate: ['G3'], blocking: true },
  { id: 'C12', title: '所有产物 baseline_id 一致，final 下基线有效且无 STALE', strength: 'A', stage: null, gate: ['G1', 'G2', 'G3'], blocking: true },
  { id: 'C13', title: '内容块都有 scope，排除项有理由，图片独有信息单独成块', strength: 'A', stage: 'A1', gate: ['G1'], blocking: true },
  { id: 'C14', title: '来源含 url/fetched_at/content_hash，assets 真实且识读卡完整', strength: 'A', stage: 'A1', gate: ['G1'], blocking: true },
  { id: 'C15', title: '当前阶段适用检查项都有结论，not_applicable 有理由', strength: 'B', stage: null, gate: ['G1', 'G2', 'G3'], blocking: true },
  { id: 'C16', title: '批次模式触点重叠的 US 已在 ART-04 登记依赖或冲突', strength: 'A', stage: 'A5', gate: ['G3'], blocking: true },
  { id: 'C17', title: '设计覆盖矩阵每行可复算（上游存在、design 存在、section 可定位）', strength: 'A', stage: 'A4', gate: ['G3'], blocking: true },
  { id: 'C18', title: '双产物一致：version 相等、source_hash 等于内容哈希、artifact.id 相等', strength: 'A', stage: null, gate: ['G1', 'G2', 'G3'], blocking: true },
  { id: 'C19', title: '引用文档 status=ACTIVE 且 applicable_modules 与本 US 模块有交集', strength: 'A', stage: null, gate: ['G2', 'G3'], blocking: true },
  { id: 'C20', title: '迁移与回滚成对，不可逆 DDL 需人工 risk_acceptance', strength: 'B', stage: 'A4', gate: ['G3'], blocking: true },
]

/** Every C-rule id, in table order. */
export const CHECK_IDS = CHECKS.map(check => check.id)

/**
 * Gate definitions: which artifacts a human inspects and which conditions block
 * the decision. Blocking items are evaluated by the plugin; a gate can never be
 * recorded as approved while one of them fails.
 */
export const GATES = {
  G1: {
    id: 'G1',
    name: '需求确认',
    state: 'WAITING_G1',
    artifacts: ['ART-11', 'ART-20', 'ART-22'],
    checks: ['C01', 'C02', 'C12', 'C13', 'C14', 'C15', 'C18'],
    items: [
      '需求来源可追溯：source 五项齐全（platform/url/fetched_at/platform_updated_at/content_hash）',
      '后端范围已明确，被排除内容都有理由',
      '每条规则有来源与置信度，推断项已标注待确认',
      '验收标准可测试，前置条件与预期结果明确',
      '阻断型未决问题（blocking 且 open）已清零或经人工明确接受',
      '无 frontend / out_of_scope 内容被静默丢弃',
      '图片识读卡完整，非 parsed 的已登记缺口',
      '规则之间无相互矛盾',
      'A1/A2 产物版本与 baseline_id 一致',
      '人工修改过的地方已确认（C10 前置）',
    ],
  },
  G2: {
    id: 'G2',
    name: '影响分析确认',
    state: 'WAITING_G2',
    artifacts: ['ART-30', 'ART-31', 'ART-32'],
    checks: ['C03', 'C12', 'C15', 'C18', 'C19'],
    items: [
      'mandatory 触点都能指向需求规则或验收标准',
      '每个触点都有证据，证据类型合规（heuristic / needs_runtime_confirm 未单独支撑 mandatory）',
      '证据缺口已登记四要素，未推断为「无影响」',
      'BLOCKER 级风险已处理：accepted / fixed / rejected 三选一并留痕',
    ],
  },
  G3: {
    id: 'G3',
    name: '设计确认',
    state: 'WAITING_G3',
    artifacts: ['ART-40', 'ART-42', 'ART-43', 'ART-44', 'ART-51'],
    checks: ['C05', 'C06', 'C07', 'C08', 'C09', 'C11', 'C12', 'C15', 'C17', 'C18', 'C20'],
    items: [
      '每个 mandatory 触点都被设计覆盖',
      '每个设计都有 ADR 支撑，迁移存在 ADR',
      '兼容性与契约变更已声明并覆盖',
      '迁移有顺序与回滚，不可逆操作有风险接受记录',
      '预期文件变更与影响、设计双向可追溯',
      '设计覆盖矩阵无 Missing 无说明项',
      '评审结论非 FAIL，条件已全部关闭',
      '无 STALE 产物参与评审',
      'A5 独立检索次数达标（≥10）',
      'SaaS 六项检查有结论',
    ],
  },
}

/** Approval status values a record may carry. */
export const APPROVAL_STATUS = ['not_started', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED']

/** Every incremental rerun class from DS-V5 §12.6, with what it invalidates. */
export const RERUN_CLASSES = {
  source: { label: '来源正文或附件变化', invalidates: ['A1', 'A2', 'A3', 'A4', 'A5'], resetGates: ['G1', 'G2', 'G3'] },
  a1_scope: { label: '后端范围调整', invalidates: ['A1', 'A2', 'A3', 'A4', 'A5'], resetGates: ['G1', 'G2', 'G3'] },
  a2_rules: { label: '规则或验收标准变更', invalidates: ['A2', 'A3', 'A4', 'A5'], resetGates: ['G1', 'G2', 'G3'] },
  a2_decision: { label: '待确认决策落定', invalidates: ['A2', 'A3', 'A4', 'A5'], resetGates: ['G1', 'G2', 'G3'] },
  a2_text: { label: '仅文字表述修改', invalidates: ['A2'], resetGates: [] },
  a3_impacts: { label: '影响点增删或重分类', invalidates: ['A3', 'A4', 'A5'], resetGates: ['G2', 'G3'] },
  a3_text: { label: '影响分析文字修改', invalidates: ['A3'], resetGates: [] },
  a4_design: { label: '设计或文件清单变更', invalidates: ['A4', 'A5'], resetGates: ['G3'] },
  a5_review: { label: '评审结论变化', invalidates: ['A5'], resetGates: [] },
  checklist: { label: '检查项定义更新', invalidates: ['A3', 'A4', 'A5'], resetGates: ['G2', 'G3'] },
  code: { label: '基线代码变化', invalidates: ['A3', 'A4', 'A5'], resetGates: ['G2', 'G3'] },
  none: { label: '无失效', invalidates: [], resetGates: [] },
}

/** Default runtime budget knobs (DS-V5 K6). */
export const DEFAULT_MAX_ACTIONS = 8
export const MAX_ACTIONS_LIMIT = 20

/** Directory names created under docs/awf/<US-ID>/. */
export const US_DIRECTORIES = ['00-workflow', '01-source', '02-requirement', '03-impact', '04-design', '05-review']

/** Regexes for every identifier shape the protocol defines. */
export const ID_PATTERNS = {
  us: /^US-\d{4}-\d{3}$/u,
  batch: /^BATCH-\d{3}$/u,
  baseline: /^BASE-\d{3}$/u,
  rule: /^R-\d{3}$/u,
  acceptance: /^AC-\d{3}$/u,
  openQuestion: /^OQ-\d{3}$/u,
  decision: /^DEC-\d{3}$/u,
  impact: /^IMPACT-\d{3}$/u,
  evidence: /^EVIDENCE-\d{3}$/u,
  conflict: /^CONFLICT-\d{3}$/u,
  adr: /^ADR-\d{3}$/u,
  design: /^DESIGN-\d{3}$/u,
  check: /^CHK-\d{3}$/u,
  review: /^REVIEW-\d{3}$/u,
  revision: /^REV-\d{3}$/u,
  condition: /^COND-\d{3}$/u,
  risk: /^RSK-\d{2}$/u,
}

/** Build the canonical `docs/awf` layout path for one artifact. */
export function artifactPath(usDir, artifactId) {
  const entry = ARTIFACTS[artifactId]
  if (entry === undefined) throw new Error(`unknown artifact ${artifactId}`)
  return entry.dir === '..' ? `${usDir}/${entry.file}` : `${usDir}/${entry.dir}/${entry.file}`
}
