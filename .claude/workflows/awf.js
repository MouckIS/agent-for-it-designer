export const meta = {
  name: 'awf',
  description: 'AWF 技术方案设计工作流：按状态机派发 A1–A5 子代理，A0 控制面自动校验产物并推进状态，在人工门禁 G1/G2/G3 与阻断处停下',
  whenToUse: '已有 docs/awf/<US-ID>/00-workflow/workflow-manifest.yaml，需要对存量 Spring Boot SaaS 仓库推进 US 需求获取、需求澄清、代码影响分析、技术设计或设计评审时。用法：Workflow({name:"awf", args:{usId:"US-2026-001"}})',
  phases: [
    { title: 'Preflight', detail: '读 manifest 与基线，确定当前状态对应的下一步' },
    { title: 'A1 需求获取', detail: 'etp-requirement-collector 取回 US、固化快照、过滤后端范围' },
    { title: 'A2 需求澄清', detail: 'etp-requirement-analyst 产出规则、AC、决策与冲突' },
    { title: 'A3 代码影响分析', detail: 'etp-impact-analyst 产出触点、风险与证据' },
    { title: 'A4 技术设计', detail: 'etp-technical-designer 产出设计、ADR、兼容迁移与文件清单' },
    { title: 'A5 独立评审', detail: 'etp-design-reviewer 独立复核，给结论与修订指令' },
    { title: '设计回流', detail: '读 revision-instructions，按 target_agent 定向回派' },
    { title: '产物校验', detail: 'A0 控制面执行六步校验与 C 检查，更新 manifest' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// AWF（Agent 技术方案设计工作流）A0 编排脚本
//
// 本脚本是 A0 控制面的「决策层」：状态机、派发顺序、停点判定都在这里，确定性执行。
// A0 的「执行层」（读写 manifest、sha256、C 检查、workflow-report）由 etp-awf-controller
// 代理完成；人工门禁由人执行 /etp-awf-gate。
//
// 流程规则全文见 .claude/skills/etp-awf-workflow/references/orchestration-rules.md
// 产物协议见 .claude/skills/etp-awf-workflow/references/artifact-protocol.md
//
// 输入 args：
//   usId        必填，US 标识（如 US-2026-001）
//   usRef       可选，US 平台链接或本地文件路径，透传给 A1
//   mode        可选，final（默认）| draft
//   maxActions  可选，本轮最多执行几个阶段动作，默认 8，上限 20
//   dryRun      可选，true 时只做 Preflight 并返回，不派发子代理
//   forceStage  可选，显式指定本轮起始阶段（A1–A5）；与 manifest 状态不一致时拒绝
//
// 输出：status ∈ stopped | done | max_actions | blocked | error
//   stopped 表示停点（门禁 / 阻断 / 依赖等待 / 完成），next 给出下一步命令
// ─────────────────────────────────────────────────────────────────────────────

// ── 0. 入参归一化 ────────────────────────────────────────────────────────────

const A = args && typeof args === 'object' ? args : {}
const US_ID = typeof A.usId === 'string' ? A.usId.trim() : typeof args === 'string' ? args.trim() : ''

if (!US_ID) {
  return {
    status: 'error',
    error: '缺少 args.usId。用法：Workflow({name:"awf", args:{usId:"US-2026-001"}})',
  }
}

const MODE = A.mode === 'draft' ? 'draft' : 'final'
const US_REF = typeof A.usRef === 'string' ? A.usRef : null
const DRY_RUN = A.dryRun === true
const FORCE_STAGE = typeof A.forceStage === 'string' && /^A[1-5]$/.test(A.forceStage) ? A.forceStage : null
const MAX_ACTIONS = typeof A.maxActions === 'number' && A.maxActions > 0 ? Math.min(Math.floor(A.maxActions), 20) : 8
const MIN_BUDGET_LEFT = 50000

// ── 1. 状态路由表（唯一的状态 → 动作映射，来自 state-machine.md） ────────────

const ROUTE = {
  CREATED: { stop: '尚未登记人工基线：需要人提供 repository / knowledge_graph / documentation / skills 四项后执行 /etp-awf-start', next: '/etp-awf-start <US-ID> <US 链接或文件路径>' },
  BASELINE_CONFIRMED: { stage: 'A1' },
  A1_RUNNING: { stage: 'A1' },
  A2_RUNNING: { stage: 'A2' },
  A3_RUNNING: { stage: 'A3' },
  A4_RUNNING: { stage: 'A4' },
  A5_RUNNING: { stage: 'A5' },
  WAITING_G1: { gate: 'G1' },
  WAITING_G2: { gate: 'G2' },
  WAITING_G3: { gate: 'G3' },
  DESIGN_REVISION: { revision: true },
  WAITING_DEPENDENCY: { stop: '批次模式下等待上游 US 冻结；上游完成后重新执行 /etp-awf-run', next: '/etp-awf-status' },
  COMPLETED: { stop: '工作流已冻结并交付，不再自动推进', next: '/etp-awf-status' },
  BLOCKED: { stop: '工作流处于 BLOCKED：读 00-workflow/workflow-report.md 的阻断原因，人工处理后用 /etp-awf-rerun 或 /etp-awf-run 恢复', next: '/etp-awf-status' },
}

// ── 2. 阶段规格（派发对象、读写目录、必读技能、适用检查项） ──────────────────

const STAGES = {
  A1: {
    agentType: 'etp-requirement-collector',
    phase: 'A1 需求获取',
    dir: '01-source',
    skills: ['etp-requirement-fetch'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'state-machine.md'],
    checks: ['C13', 'C14'],
    inputs: '无上游产物（本阶段是链条起点）；输入为 US 来源与人工基线，见下方「US 来源」',
    outputs: '01-source/source-package.yaml（ART-10）、01-source/backend-scope.md（ART-11）、01-source/raw.md（只读快照）、01-source/assets/',
    mission: [
      '把 US 完整、可追溯地取回来，并明确哪些内容属于后端实现范围。核心是三件事：取全、留痕、过滤。',
      '通过 etp-requirement-fetch 技能取回正文、附件、图片与外部参考，固化原始快照，按内容块拆分并判定 scope（backend/shared/frontend/out_of_scope/unknown）。',
      '不解释业务规则、不写验收标准、不评估技术可行性；这些是 A2 及以后的事。',
      '图片由你用多模态直接 Read 识读（默认模型支持视觉，不依赖外部 OCR）：一次一张、长图分区重读，逐张产出识读卡（text 逐字照录 / description 客观结论 / backend_signals[] / confidence / parse_status），读完一张立即落盘。',
      '图内后端信号（接口、字段、枚举、状态机、错误码）必须单独成块，不得因为整图是前端原型就整体归 frontend 而丢掉后端信息；识读不全或格式不支持时写 missing_parts 并登记 gaps[]（image_partial / image_unreadable / image_unsupported）。',
      '内容块不得静默丢弃：frontend 与 out_of_scope 必须在 excluded[] 给出理由；无法解析的附件登记 gaps[]，并说明是否影响后端范围判断。',
    ],
  },
  A2: {
    agentType: 'etp-requirement-analyst',
    phase: 'A2 需求澄清',
    dir: '02-requirement',
    skills: ['etp-design-doc-writing', 'etp-legacy-saas-analysis'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C01', 'C02'],
    inputs: '01-source/source-package.yaml（ART-10）、01-source/backend-scope.md（ART-11）、00-workflow/analysis-baseline.yaml（ART-01）',
    outputs: '02-requirement/requirement-package.yaml（ART-20）、02-requirement/requirement-clarification.md（ART-21）、02-requirement/decision-log.yaml（ART-22）',
    mission: [
      '把后端范围内的 US 转成「可以验收、可以追溯、可以裁决」的需求澄清包。核心不是改写 US，而是暴露不确定性与冲突，让 G1 有明确决策对象。',
      '每条规则必须给 source.type（explicit/specification/existing/inferred/unknown/human）与 source.reference；inferred 且 confirmation_required=true 的规则不得是 confirmed。',
      '每条非 rejected 规则至少 1 条 AC；判别不了的写 open_questions[]（标 blocking）或 decision-log.yaml 的 DEC（status=pending），不要猜。',
      '代码现状只能写进 baseline_behavior[]，不得混入 rules[]。US 与规范/历史决策矛盾时写 conflicts[]。',
      '发现 ART-10 的归属判断与需求实质不符时写 scope_errors[]，由 A0 退回 A1，不要自行改 01-source。',
      'A2 不分析代码影响、不给实现方案。',
    ],
  },
  A3: {
    agentType: 'etp-impact-analyst',
    phase: 'A3 代码影响分析',
    dir: '03-impact',
    skills: ['etp-code-graph-query', 'etp-legacy-saas-analysis', 'etp-project-checklist'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C03', 'C04'],
    inputs: '02-requirement/requirement-package.yaml（ART-20）、02-requirement/decision-log.yaml（ART-22）、00-workflow/analysis-baseline.yaml（ART-01），以及基线 commit 上的代码与图谱',
    outputs: '03-impact/impact-package.yaml（ART-30）、03-impact/impact-analysis.md（ART-31）、03-impact/evidence-manifest.yaml（ART-32）',
    mission: [
      '回答「改哪里、影响什么、哪里没证据」，不回答「怎么改」。',
      '每个触点必须挂 rule_refs 或 acceptance_refs 指向存在的 A2 条目；没有需求依据的触点不成立。',
      'evidence 只能用固定类型：graph_proven / static_analysis / runtime_proven / configuration_proven / git_history / heuristic / needs_runtime_confirm。图谱不可用时降级静态检索并标 degraded。',
      '无证据不得断言「无影响」：写 evidence_gap，并给出 severity。风险等级 BLOCKER/HIGH 且 evidence_gap 非空的，必须在报告里明确列为 G2 待确认项。',
      '重点覆盖：数据写路径、权限、多租户、对外 API/MQ 契约、存量行为变化、特殊租户、无法静态确认的调用链。',
      'A3 不设计实现、不改需求。',
    ],
  },
  A4: {
    agentType: 'etp-technical-designer',
    phase: 'A4 技术设计',
    dir: '04-design',
    skills: ['etp-design-doc-writing', 'etp-legacy-saas-analysis', 'etp-project-checklist'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C05', 'C06', 'C07', 'C11', 'C15'],
    inputs: '02-requirement/*（ART-20/21/22）、03-impact/*（ART-30/31/32）、00-workflow/analysis-baseline.yaml（ART-01），以及必要的现有实现代码片段',
    outputs: '04-design/technical-design-package.yaml（ART-40）、04-design/technical-design.md（ART-41）、04-design/adrs/ADR-<nnn>.md（ART-42）、04-design/design-coverage.yaml（ART-43）、04-design/expected-file-changes.yaml（ART-44）',
    mission: [
      '把「改哪里」变成「怎么改、为什么这样改、如何兼容与回滚」，并保证每个 mandatory 触点都有设计归属。',
      '每个 mandatory 触点必须出现在某个 designs[].impact_refs；每个 DESIGN 至少被一条 ADR 的 references[] 覆盖；ADR 的 options 至少 2 个并写明 selected 与理由。',
      '存在契约类触点（Controller/API/Listener/Producer/Consumer/MQ）时，compatibility.required=true 且 contracts[] 覆盖这些触点。',
      '迁移必须给 steps/order/rollback；不需要迁移时必须写 reason。发布顺序、灰度、应用回滚、数据回滚都要有内容。',
      '适用检查项逐条给 pass/fail/not_applicable，not_applicable 必须给理由。',
      'A4 不扩大影响范围、不改需求；无法复用现有封装时写 compatibility.deviations[] 交 G3 确认。',
    ],
  },
  A5: {
    agentType: 'etp-design-reviewer',
    phase: 'A5 独立评审',
    dir: '05-review',
    skills: ['etp-design-review', 'etp-code-graph-query', 'etp-legacy-saas-analysis', 'etp-project-checklist'],
    refs: ['artifact-protocol.md', 'context-assembly.md', 'gates-and-checks.md'],
    checks: ['C08', 'C09', 'C12', 'C15'],
    inputs: '01-source/*、02-requirement/*、03-impact/*、04-design/*、00-workflow/analysis-baseline.yaml（ART-01）',
    outputs: '05-review/review-report.yaml（ART-50）、05-review/review-report.md（ART-51）、05-review/revision-instructions.yaml（ART-52）',
    mission: [
      '发现 A1–A4 的共同盲区，而不是复述他们的结论。评审对象是产物与代码事实，不是文笔。',
      '必须做独立检索（不少于 10 次），记录检索次数与覆盖节点；不得直接复用 A3 的检索结果——那正是共同盲区的来源。',
      '结论只能取 PASS / CONDITIONAL_PASS / FAIL。每个问题给 category、references、evidence、recommendation、return_to、blocking。',
      'FAIL 时必须写 revision-instructions.yaml：target_agent（A1–A4）、round、issues[]、invalidated_artifacts[]、preserved_artifacts[]。',
      'CONDITIONAL_PASS 的条件写 conditions[]（status=open），关闭由人确认后由 A0 处理，A5 不自行关闭。',
      '适用检查项逐条复核，识别虚假 not_applicable；批次模式下检查跨 US 冲突。',
      'A5 不修改 A4 设计内容来「帮助通过」。',
    ],
  },
}

// ── 3. 结构化输出 schema ─────────────────────────────────────────────────────

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['repoRoot', 'usId', 'mode', 'state', 'nextStage', 'artifacts', 'baseline', 'stop'],
  properties: {
    repoRoot: { type: 'string' },
    usId: { type: 'string' },
    mode: { enum: ['final', 'draft', 'batch'] },
    state: { type: 'string' },
    nextStage: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['stage', 'bundleId', 'version', 'status'],
        properties: {
          stage: { type: 'string' },
          bundleId: { type: 'string' },
          version: { type: 'integer' },
          status: { type: 'string' },
        },
      },
    },
    baseline: {
      type: 'object',
      required: ['repository', 'knowledgeGraph', 'documentation', 'skills'],
      properties: {
        repository: { type: 'string' },
        knowledgeGraph: { type: 'string' },
        documentation: { type: 'string' },
        skills: { type: 'string' },
      },
    },
    stop: {
      type: 'object',
      required: ['stop', 'reason'],
      properties: {
        stop: { type: 'boolean' },
        reason: { type: 'string' },
        gates: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
      },
    },
    portfolio: { type: 'string' },
    notes: { type: 'string' },
  },
}

const STAGE_SCHEMA = {
  type: 'object',
  required: ['stage', 'bundleId', 'version', 'status', 'files', 'counts', 'blocked', 'needHuman', 'next'],
  properties: {
    stage: { enum: ['A1', 'A2', 'A3', 'A4', 'A5'] },
    bundleId: { type: 'string' },
    version: { type: 'integer' },
    status: { enum: ['draft', 'final', 'STALE'] },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          kind: { enum: ['yaml', 'markdown', 'adr', 'other'] },
        },
      },
    },
    counts: { type: 'object', properties: { summary: { type: 'string' } } },
    blocked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    needHuman: { type: 'array', items: { type: 'string' } },
    gateSignals: {
      type: 'object',
      properties: {
        pendingDecisions: { type: 'array', items: { type: 'string' } },
        blockingQuestions: { type: 'array', items: { type: 'string' } },
        unhandledGaps: { type: 'array', items: { type: 'string' } },
        scopeErrors: { type: 'array', items: { type: 'string' } },
        unacceptedGaps: { type: 'array', items: { type: 'string' } },
        openConditions: { type: 'array', items: { type: 'string' } },
        conflicts: { type: 'array', items: { type: 'string' } },
        checklist: { type: 'string' },
      },
    },
    conclusion: { enum: ['PASS', 'CONDITIONAL_PASS', 'FAIL'] },
    next: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'stateAfter', 'checks', 'failures'],
  properties: {
    passed: { type: 'boolean' },
    stateAfter: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'result'],
        properties: {
          id: { type: 'string' },
          result: { enum: ['pass', 'fail', 'not_applicable'] },
          evidence: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    failures: { type: 'array', items: { type: 'string' } },
    blockedReasons: { type: 'array', items: { type: 'string' } },
    manifestWrites: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const REVISION_SCHEMA = {
  type: 'object',
  required: ['targetAgent', 'round', 'issues', 'stop'],
  properties: {
    targetAgent: { enum: ['A1', 'A2', 'A3', 'A4'] },
    round: { type: 'integer' },
    issues: { type: 'array', items: { type: 'string' } },
    invalidated: { type: 'array', items: { type: 'string' } },
    stop: { type: 'boolean' },
    stopReason: { type: 'string' },
  },
}

// ── 4. 运行时上下文 ─────────────────────────────────────────────────────────

const ctx = {
  root: '',
  workdir: '',
  usId: US_ID,
  mode: MODE,
  baseline: {},
  artifacts: [],
  state: '',
  portfolio: '',
  actions: 0,
}

const trail = []

const push = (entry) => {
  trail.push(entry)
  log(`${entry.stage} ${entry.phase}：${entry.detail}`)
}

// ── 5. 停点与错误返回 ───────────────────────────────────────────────────────

const baseResult = () => ({
  usId: US_ID,
  mode: ctx.mode,
  workdir: ctx.workdir,
  artifacts: ctx.artifacts,
  baseline: ctx.baseline,
  actions: ctx.actions,
  trail,
})

const stopAt = (state, route, last) => {
  const out = baseResult()
  out.status = 'stopped'
  out.state = state
  out.stateAfter = state
  out.reason = route.stop || ''
  out.next = route.next || ''
  if (route.gate) {
    out.state = state
    out.gate = route.gate
    out.next = `/etp-awf-gate ${route.gate}`
    out.gatePreview = last && last.gateSignals ? last.gateSignals : null
  }
  if (last) {
    out.lastStage = {
      stage: last.stage,
      bundleId: last.bundleId,
      version: last.version,
      status: last.status,
      counts: last.counts,
      conclusion: last.conclusion || null,
      blocked: last.blocked,
      needHuman: last.needHuman,
    }
  }
  log(`停在 ${state}${route.gate ? `（人工门禁 ${route.gate}）` : ''}，下一步：${out.next}`)
  return out
}

const failResult = (message, detail) => {
  const out = baseResult()
  out.status = 'error'
  out.error = message
  if (detail) out.detail = detail
  log(`中断：${message}`)
  return out
}

// ── 6. Prompt 装配 ──────────────────────────────────────────────────────────

const briefBaseline = () => {
  const b = ctx.baseline || {}
  return [
    '分析基线（只能使用这四项，不得自行取当前 HEAD 或切换图谱版本）：',
    `- repository: ${b.repository || '未提供'}`,
    `- knowledge_graph: ${b.knowledgeGraph || '未提供'}`,
    `- documentation: ${b.documentation || '未提供'}`,
    `- skills: ${b.skills || '未提供'}`,
  ].join('\n')
}

const briefCommon = () => [
  '## 硬约束',
  '- 只写本阶段目录，不修改其他阶段产物、不修改 00-workflow/ 下的 manifest、不修改仓库业务代码。manifest 由 A0 控制面维护。',
  '- 双产物纪律：先写结构化 YAML，再按模板渲染 Markdown；同一 bundle 内所有文件版本号相同；改 YAML 必须重渲染 Markdown。',
  '- 证据优先：每条结论带证据，格式 graph:<node-id> / file:line / git:<commit> / doc:<doc-id>#<clause> / runtime:<source> / human:<decision-id>；无证据写 evidence_gap，不得断言「无影响」。',
  '- 不扩大需求、不替其他阶段做结论、不编造缺失数据；缺数据写 null 并在 notes 说明。',
  '- ID 与字段严格按 artifact-protocol.md；旧版本不覆盖，新版本 = 旧版本 + 1。',
  '- 检查项（若本阶段适用）逐条给 pass / fail / not_applicable，not_applicable 必须给理由。',
  '- 不写业务代码，不改仓库实现。',
  '',
  '## 返回',
  '只返回 schema 约束的结构化结果，不要写给人看的散文。files[] 列出你实际写出的每个文件路径（相对工作目录）。',
].join('\n')

const buildStagePrompt = (stage, revision) => {
  const s = STAGES[stage]
  const root = ctx.root
  const wd = `${root}/${ctx.workdir}`
  const L = []
  L.push(`你是 AWF 工作流的 A${stage[1]} 执行代理（agentType: ${s.agentType}），由 .claude/workflows/awf.js 的 A0 编排脚本派发。`)
  L.push('')
  L.push(`仓库根目录：${root}`)
  L.push(`本 US 工作目录：${wd}/`)
  L.push(`本阶段输出目录：${wd}/${s.dir}/`)
  L.push('')
  L.push('## 必读（按顺序，全部读绝对路径）')
  L.push(`- ${root}/.claude/skills/etp-awf-workflow/SKILL.md`)
  s.refs.forEach((r) => L.push(`- ${root}/.claude/skills/etp-awf-workflow/references/${r}`))
  s.skills.forEach((k) => L.push(`- ${root}/.claude/skills/${k}/SKILL.md`))
  L.push(`- ${root}/.claude/skills/etp-awf-workflow/references/orchestration-rules.md（§2 子代理派发协议、§3 门禁）`)
  if (stage === 'A3' || stage === 'A4' || stage === 'A5') {
    L.push(`- ${root}/.claude/skills/etp-legacy-saas-analysis/references/saas-checklist.md（适用检查项来源）`)
    L.push(`- ${root}/.claude/skills/etp-project-checklist/SKILL.md（项目特有检查项来源）`)
  }
  L.push('')
  L.push('## 输入产物')
  L.push(`版本与依赖以 ${wd}/00-workflow/workflow-manifest.yaml 与 ${wd}/00-workflow/artifact-manifest.yaml 为准，先读再用，不要用磁盘上未登记的版本。`)
  L.push(s.inputs)
  if (stage === 'A1') {
    L.push(`- US 来源：${US_REF ? US_REF : '未提供链接/文件，按 etp-requirement-fetch 的要求先定位，找不到就登记 gap 并停在 BLOCKED'}`)
  }
  L.push('')
  L.push(briefBaseline())
  L.push('')
  L.push('## 本阶段任务')
  s.mission.forEach((m) => L.push(`- ${m}`))
  L.push('')
  L.push('## 本阶段产出')
  L.push(s.outputs)
  L.push('')
  L.push('## 适用检查项')
  L.push(`本阶段适用 ${s.checks.join('、')}（判定口径见 gates-and-checks.md）。你在产物里逐条给 pass / fail / not_applicable + 理由；最终判定由 A0 控制面复核。`)
  L.push('')
  if (revision) {
    L.push('## 本轮修订指令（必须逐条回应）')
    L.push(`回流轮次：${revision.round}；修订对象：${revision.targetAgent}`)
    L.push('修订正文见 05-review/revision-instructions.yaml，issues 如下：')
    revision.issues.forEach((i) => L.push(`- ${i}`))
    L.push('逐条在产物里给出回应（写入 modifications[] 或对应章节），未回应的不算完成。')
    L.push('')
  }
  L.push(briefCommon())
  return L.join('\n')
}

const TRANSITIONS = {
  A1: '通过 → A2_RUNNING；存在影响后端范围判断且未处理的 gap → BLOCKED',
  A2: '通过 → final 模式 WAITING_G1，draft 模式 A3_RUNNING；存在未上报的 scope_errors → A1_RUNNING',
  A3: '通过 → final 模式 WAITING_G2，draft 模式 A4_RUNNING',
  A4: '通过 → A5_RUNNING',
  A5: 'PASS 或 CONDITIONAL_PASS → WAITING_G3；FAIL 且 round ≤ 2 → DESIGN_REVISION；FAIL 且 round > 2 → 写 05-review/DISPUTE.md 并 BLOCKED',
}

const buildVerifyPrompt = (stage, stageOut) => {
  const s = STAGES[stage]
  const wd = `${ctx.root}/${ctx.workdir}`
  const L = []
  L.push(`你是 AWF 的 A0 控制面执行代理（agentType: etp-awf-controller）。你只做校验与登记，不做需求 / 影响 / 设计 / 评审结论。`)
  L.push('')
  L.push(`仓库根目录：${ctx.root}`)
  L.push(`本 US 工作目录：${wd}/`)
  L.push(`本轮校验对象：${stage}（${s.agentType}）刚产出的 ${stageOut.bundleId}:v${stageOut.version}`)
  L.push('')
  L.push('## 必读')
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/SKILL.md`)
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/references/artifact-protocol.md`)
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/references/gates-and-checks.md（C01–C16 判定口径）`)
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/references/state-machine.md（合法迁移与退出条件）`)
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/references/orchestration-rules.md`)
  L.push(`- ${wd}/00-workflow/workflow-manifest.yaml、artifact-manifest.yaml、analysis-baseline.yaml、workflow-report.md`)
  L.push('')
  L.push('## 子代理自报（不可作为验收依据，必须自己读文件复核）')
  L.push(`bundle: ${stageOut.bundleId}:v${stageOut.version}，status=${stageOut.status}`)
  L.push(`files: ${(stageOut.files || []).map((f) => f.path).join(', ') || '（未列出）'}`)
  L.push(`counts: ${stageOut.counts && stageOut.counts.summary ? stageOut.counts.summary : '（未提供）'}`)
  L.push(`conclusion: ${stageOut.conclusion || '（本阶段无结论字段）'}`)
  L.push(`blocked: ${(stageOut.blocked || []).map((b) => `${b.id}:${b.reason}`).join('; ') || '无'}`)
  L.push(`needHuman: ${(stageOut.needHuman || []).join('; ') || '无'}`)
  L.push('')
  L.push('## 校验六步（全部做完才算通过）')
  L.push(`1. 文件齐全：artifact-protocol.md 规定的 ${stage} 阶段文件是否都存在（ls 实际目录，不要只看自报）。`)
  L.push('2. 字段齐全：必填字段非空；ID 前缀与版本号合法；bundle 内版本一致。')
  L.push('3. 引用闭合：所有 *_ref / rule_refs / impact_refs / references 指向存在的 ID 与版本。')
  L.push('4. 职责边界：A1 只获取与过滤；A2 无代码影响；A3 无实现方案；A4 无新增需求；A5 未改设计内容。越界即 fail。')
  L.push(`5. 一致性检查：逐条执行 ${s.checks.join('、')}，每条给 pass/fail/not_applicable + 证据；无法判定的转人工，不得默认 pass。`)
  L.push('6. 登记：为每个文件算 sha256 并更新 artifact-manifest.yaml（bundle、version、files、sha256、dependencies、status）；更新 workflow-manifest.yaml 的 artifacts / status / current_stage / review_rounds；把本次执行与校验结果追加到 00-workflow/workflow-report.md。')
  L.push('')
  L.push('## 状态迁移（按校验结果判定 stateAfter）')
  L.push(`${stage}：${TRANSITIONS[stage]}`)
  L.push(`本次运行模式：${ctx.mode}`)
  if (stage === 'A5') {
    L.push('A5 额外：读 05-review/review-report.yaml 的 conclusion 与 revision-instructions.yaml，核对 round；round 取 workflow-manifest.yaml.review_rounds。FAIL 时递增 review_rounds。')
  }
  L.push('')
  L.push('## 禁止')
  L.push('- 不得为了推进而放宽判定；不得把无法判定的规则记为 pass。')
  L.push('- 不得替子代理补写其阶段内容；不得修改 01-source/raw.md。')
  L.push('- 不得改动仓库业务代码。')
  return L.join('\n')
}

const buildPreflightPrompt = () => {
  const L = []
  L.push('你是 AWF 的 A0 控制面执行代理（agentType: etp-awf-controller），负责 Preflight：读状态、算下一步，不派发、不改产物内容。')
  L.push('')
  L.push(`目标 US：${US_ID}`)
  L.push('')
  L.push('## 必读')
  L.push('- .claude/skills/etp-awf-workflow/SKILL.md')
  L.push('- .claude/skills/etp-awf-workflow/references/state-machine.md')
  L.push('- .claude/skills/etp-awf-workflow/references/artifact-protocol.md')
  L.push('- .claude/skills/etp-awf-workflow/references/orchestration-rules.md')
  L.push(`- docs/awf/${US_ID}/00-workflow/workflow-manifest.yaml、artifact-manifest.yaml、analysis-baseline.yaml`)
  L.push(`- docs/awf/portfolio.yaml（存在则读；不存在说明是单 US）`)
  L.push('')
  L.push('## 要做的事')
  L.push('1. 用 Bash 求仓库根目录绝对路径（pwd，必要时 git rev-parse --show-toplevel），写入 repoRoot。')
  L.push(`2. 读 docs/awf/${US_ID}/00-workflow/workflow-manifest.yaml，取 status、mode、current_stage、review_rounds、approvals、stale、blocked_reasons。status 以 manifest 为唯一事实来源，不得推断。`)
  L.push('3. 读 artifact-manifest.yaml，列出已登记 bundle（stage、bundleId、version、status）。')
  L.push('4. 读 analysis-baseline.yaml，把基线四项压成单行字符串（repository / knowledgeGraph / documentation / skills）；缺失项写「未提供」。')
  L.push('5. 检查目录是否存在：docs/awf/<US-ID>/{00-workflow,01-source,02-requirement,03-impact,04-design,05-review}。缺目录或没有 workflow-manifest.yaml 时 state 记 CREATED 并在 stop.reason 写明缺什么。')
  L.push('6. 批次模式（portfolio_id 非空）时读 docs/awf/portfolio.yaml，把 depends_on 的上游状态压成一行写入 portfolio。')
  L.push('7. nextStage 填状态对应的下一步动作：A1–A5 或 GATE_G1/GATE_G2/GATE_G3/COMPLETED/BLOCKED/WAITING_DEPENDENCY/DESIGN_REVISION。')
  L.push('8. 若状态是 WAITING_G*，stop.stop=true 并在 stop.gates 写明已通过的门禁与已计算的主要阻断项（只做摘要，不通过门禁）。')
  L.push('')
  L.push('## 禁止')
  L.push('- 不派发子代理、不写阶段产物、不改 status（除非目录缺失需要初始化 CREATED）。')
  L.push('- 不通过门禁、不替人做决策。')
  return L.join('\n')
}

const buildRevisionPrompt = () => {
  const wd = `${ctx.root}/${ctx.workdir}`
  const L = []
  L.push('你是 AWF 的 A0 控制面执行代理（agentType: etp-awf-controller）。当前状态 DESIGN_REVISION，需要读出定向回流目标。')
  L.push('')
  L.push('## 必读')
  L.push(`- ${wd}/05-review/revision-instructions.yaml（target_agent、round、issues[]、invalidated_artifacts[]、preserved_artifacts[]）`)
  L.push(`- ${wd}/05-review/review-report.yaml（conclusion、blocking_issues）`)
  L.push(`- ${wd}/00-workflow/workflow-manifest.yaml（review_rounds）`)
  L.push(`- ${ctx.root}/.claude/skills/etp-awf-workflow/references/orchestration-rules.md（§4 增量重跑、§3 门禁）`)
  L.push('')
  L.push('## 要做的事')
  L.push('1. 读 revision-instructions.yaml，取 target_agent（A1/A2/A3/A4）、round、issues[] 每条压成一行文本。')
  L.push('2. 把 invalidated_artifacts[] 对应的 bundle 在 artifact-manifest.yaml 与 workflow-manifest.yaml 标 STALE，并在 stale[] 追加记录。')
  L.push('3. round > 2 时：写 05-review/DISPUTE.md（争议点、双方证据、已尝试的修订、待人工裁决事项），把 status 置 BLOCKED，返回 stop=true。')
  L.push('4. round ≤ 2 时：把 status 置 target_agent 对应的 *_RUNNING，返回 stop=false。')
  L.push('')
  L.push('## 禁止：不重写修订指令内容，不改 A5 结论，不自行选择 target_agent。')
  return L.join('\n')
}

// ── 7. 派发与校验 ───────────────────────────────────────────────────────────

const dispatchStage = async (stage, revision) => {
  const s = STAGES[stage]
  log(`派发 ${stage} → ${s.agentType}${revision ? `（修订回流 round ${revision.round}）` : ''}`)
  const out = await agent(buildStagePrompt(stage, revision), {
    label: `${stage.toLowerCase()} ${s.agentType}`,
    phase: s.phase,
    agentType: s.agentType,
    schema: STAGE_SCHEMA,
  })
  return out
}

const verifyStage = async (stage, stageOut) => {
  log(`校验 ${stage} 产物 → etp-awf-controller`)
  const out = await agent(buildVerifyPrompt(stage, stageOut), {
    label: `verify ${stage}`,
    phase: '产物校验',
    agentType: 'etp-awf-controller',
    schema: VERIFY_SCHEMA,
  })
  return out
}

const readRevision = async () => {
  log('读取修订指令 → etp-awf-controller')
  return await agent(buildRevisionPrompt(), {
    label: 'read revision',
    phase: '设计回流',
    agentType: 'etp-awf-controller',
    schema: REVISION_SCHEMA,
  })
}

const preflight = async () => {
  log(`Preflight：读取 ${US_ID} 的工作流状态 → etp-awf-controller`)
  return await agent(buildPreflightPrompt(), {
    label: 'preflight',
    phase: 'Preflight',
    agentType: 'etp-awf-controller',
    schema: PREFLIGHT_SCHEMA,
  })
}

// ── 8. 主流程 ───────────────────────────────────────────────────────────────

let pre = await preflight()
if (!pre) {
  return failResult('Preflight 返回空：etp-awf-controller 被跳过或终端错误，未做任何推进')
}

ctx.root = (pre.repoRoot || '').trim() || '.'
ctx.workdir = `docs/awf/${US_ID}`
ctx.mode = MODE === 'draft' ? 'draft' : pre.mode === 'batch' ? 'batch' : MODE
ctx.baseline = pre.baseline || {}
ctx.artifacts = pre.artifacts || []
ctx.portfolio = pre.portfolio || ''
ctx.state = (pre.state || '').trim()

push({ stage: 'A0', phase: 'Preflight', detail: `state=${ctx.state}，已登记产物 ${ctx.artifacts.length} 个，基线已读` })

if (DRY_RUN) {
  const out = baseResult()
  out.status = 'stopped'
  out.state = ctx.state
  out.stateAfter = ctx.state
  out.reason = 'dryRun：只做 Preflight，不派发子代理'
  out.next = pre.stop && pre.stop.stop ? pre.stop.reason : '/etp-awf-run'
  out.portfolio = ctx.portfolio
  return out
}

if (!ROUTE[ctx.state]) {
  return failResult(`workflow-manifest.yaml 的 status「${ctx.state}」不在合法状态清单内`, {
    allowed: Object.keys(ROUTE),
  })
}

if (FORCE_STAGE) {
  const r = ROUTE[ctx.state]
  const expect = r.stage || (ctx.state === 'DESIGN_REVISION' ? 'DESIGN_REVISION' : null)
  if (expect !== FORCE_STAGE) {
    return failResult(
      `forceStage=${FORCE_STAGE} 与 manifest 状态 ${ctx.state} 不一致（该状态对应 ${expect || '非阶段动作'}）。不要用 forceStage 跳过上游：先用 /etp-awf-rerun 让状态回到目标阶段。`,
    )
  }
}

let state = ctx.state
let last = null

while (true) {
  const route = ROUTE[state]
  if (!route) return failResult(`未知状态 ${state}`)

  if (route.stop || route.gate) return stopAt(state, route, last)

  if (ctx.actions >= MAX_ACTIONS) {
    const out = baseResult()
    out.status = 'max_actions'
    out.state = state
    out.stateAfter = state
    out.reason = `本轮已达到阶段动作上限 ${MAX_ACTIONS}，未进入停点`
    out.next = '/etp-awf-run（再次执行继续推进）'
    return out
  }

  if (typeof budget === 'object' && budget !== null && budget.total !== null && budget.remaining() < MIN_BUDGET_LEFT) {
    const out = baseResult()
    out.status = 'max_actions'
    out.state = state
    out.stateAfter = state
    out.reason = `token 预算剩余 ${budget.remaining()} 低于 ${MIN_BUDGET_LEFT}，主动停下`
    out.next = '/etp-awf-run（预算补充后继续）'
    return out
  }

  // ── 分支 A：评审回流 ──
  if (route.revision) {
    ctx.actions += 1
    const rev = await readRevision()
    if (!rev) return failResult('读取修订指令返回空，未做任何推进')
    if (rev.stop) {
      state = 'BLOCKED'
      push({ stage: 'A0', phase: '设计回流', detail: `round=${rev.round} 超过两轮，已写 DISPUTE.md 并 BLOCKED` })
      return stopAt(state, ROUTE.BLOCKED, last)
    }
    push({ stage: 'A0', phase: '设计回流', detail: `round=${rev.round} → 定向回派 ${rev.targetAgent}` })

    const stage = rev.targetAgent
    const revision = { round: rev.round, targetAgent: rev.targetAgent, issues: rev.issues || [] }
    let dispatched = 0
    let advanced = false
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const stageOut = await dispatchStage(stage, revision)
      if (!stageOut) break
      dispatched += 1
      last = stageOut
      const verify = await verifyStage(stage, stageOut)
      if (!verify) break
      if (verify.passed) {
        state = verify.stateAfter
        ctx.artifacts = pre.artifacts
        push({ stage, phase: '产物校验', detail: `通过，状态 → ${state}（checks: ${(verify.checks || []).map((c) => `${c.id}:${c.result}`).join(' ')}）` })
        advanced = true
        break
      }
      push({ stage, phase: '产物校验', detail: `未通过（第 ${attempt} 次）：${(verify.failures || []).join('；')}` })
      if (attempt === 2) {
        state = 'BLOCKED'
        return stopAt(state, ROUTE.BLOCKED, last)
      }
    }
    if (!advanced) {
      return failResult(`${stage} 修订重跑未产出可用结果（dispatched=${dispatched}）`)
    }
    continue
  }

  // ── 分支 B：正常阶段推进 ──
  const stage = route.stage
  ctx.actions += 1
  let advanced = false

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const stageOut = await dispatchStage(stage, null)
    if (!stageOut) {
      push({ stage, phase: '派发', detail: `子代理返回空（第 ${attempt} 次）：被跳过或终端错误` })
      continue
    }
    last = stageOut
    const verify = await verifyStage(stage, stageOut)
    if (!verify) {
      push({ stage, phase: '产物校验', detail: `校验代理返回空（第 ${attempt} 次）` })
      continue
    }
    if (verify.passed) {
      state = verify.stateAfter
      push({
        stage,
        phase: '产物校验',
        detail: `通过，状态 → ${state}（checks: ${(verify.checks || []).map((c) => `${c.id}:${c.result}`).join(' ')}）`,
      })
      advanced = true
      break
    }
    push({ stage, phase: '产物校验', detail: `未通过（第 ${attempt} 次）：${(verify.failures || []).join('；')}` })
    if (attempt === 2) {
      state = 'BLOCKED'
      return stopAt(state, ROUTE.BLOCKED, last)
    }
  }

  if (!advanced) {
    return failResult(`${stage} 连续两次未产出可用结果，已停止（未改状态，可修复后重跑 /etp-awf-run）`)
  }
  if (!ROUTE[state]) return failResult(`A0 控制面返回了非法状态「${state}」`)
}
