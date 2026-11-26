/**
 * Prompt assembly for the five stages, the verifying pass, the preflight and the
 * revision read-back.
 *
 * DS-V5 K4 says a subagent has no persistent memory, so every prompt must be
 * self-contained: role, hard constraints, the skills to load, the exact input
 * files, the mission, the outputs, the checks and the return contract all travel
 * with the dispatch. Nothing here reads the disk — the caller has already loaded
 * the artifacts and passes a plain object.
 */

import { STAGES, STAGE_ORDER, ARTIFACTS, CHECKS, GATES, STAGE_ARTIFACTS } from './constants.js'

/** Render the four baseline lines; a missing item says so instead of going blank. */
export function briefBaseline(baseline) {
  const b = baseline || {}
  const repo = b.repository || {}
  const graph = b.knowledge_graph || {}
  const docs = b.documentation || {}
  const skills = b.skills || {}
  const line = (value, fallback) => {
    const text = String(value ?? '').trim()
    return text === '' ? fallback : text
  }
  return [
    `- 仓库：${line(repo.branch, '未提供')} @ ${line(repo.commit, '未提供')}`,
    `- 知识图谱：${line(graph.version, '未提供')}${graph.available === false ? '（不可用，影响分析需降级为静态证据）' : ''}`,
    `- 文档：${line(docs.version, '未提供')}`,
    `- 技能：${line(skills.version, '未提供')}`,
  ].join('\n')
}

/**
 * The seven hard constraints every producing agent carries. They are the part of
 * the contract that does not change between stages, so they live in one place.
 */
export function briefCommon() {
  return [
    '## 硬约束（违反即判定失败）',
    '1. 只写本阶段目录，不得写入其它阶段目录、不得改 `01-source/` 已固化的正文与附件。',
    '2. 双产物纪律：YAML 是唯一事实来源，Markdown 只能由 YAML 渲染；改 YAML 必须重渲染 Markdown 并更新哈希。',
    '3. 证据必须带前缀，只能是这六种之一：`graph:<节点或查询>`、`file:<相对路径>:<行号>`、`git:<commit>`、`doc:#<文档锚点>`、`runtime:<命令或观测点>`、`human:<确认人与时间>`。',
    '4. 不扩大需求：发现遗漏只能写成待确认问题，不得把推断写成已确认需求。',
    '5. ID 与版本按 `.claude/skills/etp-awf-workflow/references/artifact-protocol.md`：bundle 内所有文件 version 相同，新版本为旧版本 + 1。',
    '6. 阶段适用检查项必须逐条给 `pass` / `fail` / `not_applicable`，`not_applicable` 必须写理由；不得默认通过。',
    '7. 不写业务代码，只产出文档与结构化产物。',
    '',
    '只返回 JSON schema 约束的结构化结果，不要附加解释段落。',
  ].join('\n')
}

/** Human-readable list of the artifacts a stage must leave behind. */
function briefOutputs(stageId) {
  const stage = STAGES[stageId]
  const required = STAGE_ARTIFACTS[stageId] || []
  const rows = required.map(id => `- ${id} \`${ARTIFACTS[id].dir}/${ARTIFACTS[id].file}\`（${ARTIFACTS[id].label}）`)
  return rows.join('\n')
}

/** The checks the stage must self-evaluate, with their titles. */
function briefChecks(stageId) {
  const stage = STAGES[stageId]
  return stage.checks.map(id => {
    const check = CHECKS.find(entry => entry.id === id)
    return `- ${id}：${check ? check.title : id}`
  }).join('\n')
}

/**
 * The dispatch prompt for one stage.
 *
 * @param {string} stageId `A1`…`A5`
 * @param {object} options
 * @param {string} options.usId
 * @param {string} options.mode `draft`|`final`|`batch`
 * @param {string} options.usRef human-supplied US identifier or link
 * @param {string} options.workdir `docs/awf/<US-ID>`
 * @param {object} [options.baseline]
 * @param {string[]} [options.inputDigest] one line per upstream artifact present
 * @param {object} [options.revision] {round, targetAgent, issues[]}
 * @param {string[]} [options.priorNotes] short notes from the previous attempt
 */
export function buildStagePrompt(stageId, options) {
  const stage = STAGES[stageId]
  if (stage === undefined) throw new Error(`unknown stage ${stageId}`)
  const revision = options.revision
  const lines = []
  lines.push(`你是 AWF 工作流中负责「A${stageId.slice(1)} ${stage.name}」的执行代理（角色 ${stage.agent}）。你的唯一职责是产出本阶段的双产物，不越界到其它阶段。`)
  lines.push('')
  lines.push('## 本次任务')
  lines.push(`- US：${options.usId}`)
  lines.push(`- 模式：${options.mode}${options.mode === 'draft' ? '（draft 可跳过门禁，但产物不得作为开发交接依据）' : ''}`)
  lines.push(`- 工作目录：${options.workdir}（只允许在此目录下的 ${stage.dir}/ 内写入）`)
  lines.push(`- 基线：`)
  lines.push(briefBaseline(options.baseline))
  lines.push('')
  lines.push('## 开始前必须加载的技能')
  lines.push(`- 先调用 skill 工具加载 \`etp-awf-workflow\`（流程、产物协议、门禁细则、状态机都在里面）`)
  for (const skill of stage.skills) lines.push(`- 再加载 \`${skill}\``)
  lines.push(`- 需要引用协议原文时读 \`etp-awf-workflow\` 的资源文件：${stage.refs.join('、')}`)
  lines.push('')
  lines.push('## 输入（先读，再动手）')
  for (const input of stage.inputs) lines.push(`- ${input}`)
  if (options.inputDigest && options.inputDigest.length > 0) {
    lines.push('')
    lines.push('已核对的输入摘要：')
    for (const line of options.inputDigest) lines.push(`- ${line}`)
  }
  if (stageId === 'A1') {
    lines.push('')
    lines.push('US 来源：')
    lines.push(options.usRef && String(options.usRef).trim() !== '' ? `- ${options.usRef}（人提供的标识或链接，原样使用，不要自行猜测）` : '- 人未提供 US 链接：先按 `etp-requirement-fetch` 的约定取回，取不到就写 gaps[] 并返回 blocked，不得虚构需求内容。')
  }
  lines.push('')
  lines.push('## 本阶段使命')
  for (const mission of stage.mission) lines.push(`- ${mission}`)
  lines.push('')
  lines.push('## 必须产出的产物')
  lines.push(briefOutputs(stageId))
  lines.push('')
  lines.push('## 本阶段检查项（在产物里逐条给结论）')
  lines.push(briefChecks(stageId))
  lines.push('这些结论会由 A0 控制面独立复核，你的自报不作为验收依据。')
  if (revision !== undefined) {
    lines.push('')
    lines.push('## 设计回流（本轮为修订，不是重写）')
    lines.push(`- 轮次：${revision.round}`)
    lines.push(`- 定向回派给：${revision.targetAgent}`)
    lines.push('- 逐条处理下列问题，未回应的不算完成：')
    for (const issue of revision.issues || []) {
      lines.push(`  - ${issue.id}${issue.severity ? `（${issue.severity}）` : ''}：${issue.problem || issue.description || ''}${issue.requiredFix ? ` → 要求：${issue.requiredFix}` : ''}`)
    }
    lines.push('- 只改被点到的地方与因此失效的下游内容，不要顺带重写无关段落。')
  }
  if (options.priorNotes && options.priorNotes.length > 0) {
    lines.push('')
    lines.push('## 上一次尝试被驳回的原因（必须修复）')
    for (const note of options.priorNotes) lines.push(`- ${note}`)
  }
  lines.push('')
  lines.push(briefCommon())
  return lines.join('\n')
}

/** The verifying prompt: an independent pass over what the stage claimed. */
export function buildVerifyPrompt(stageId, stageOutput, options) {
  const stage = STAGES[stageId]
  const lines = []
  lines.push(`你是 AWF 工作流 A0 控制面的产物校验代理，负责复核「A${stageId.slice(1)} ${stage.name}」的结果。子代理的自报不可作为验收依据，必须自己读文件复核。`)
  lines.push('')
  lines.push('## 被校验的返回（仅供参考，不作为证据）')
  lines.push('```json')
  lines.push(JSON.stringify(stageOutput ?? {}, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## 校验六步（全部做完才能判定 passed）')
  lines.push(`1. 文件齐全：实际列出 \`${options.workdir}/${stage.dir}/\`，缺任何必需产物即 fail。`)
  lines.push('2. 字段齐全：必填字段非空、ID 前缀符合协议、bundle 内版本一致。')
  lines.push('3. 引用闭合：所有 `*_ref` 指向的 ID 与版本必须真实存在。')
  lines.push('4. 职责边界：' + boundaryFor(stageId))
  lines.push('5. 一致性检查：逐条给出 pass / fail / not_applicable 与证据；无法判定的转人工，不得默认 pass。')
  lines.push('6. 登记：为每个产物文件算 sha256 写进 `00-workflow/artifact-manifest.yaml`，更新 `00-workflow/workflow-manifest.yaml` 的 artifacts / status / current_stage / review_rounds，并把本轮结论追加到 `00-workflow/workflow-report.md`。')
  lines.push('')
  lines.push('## 本阶段适用检查项')
  lines.push(briefChecks(stageId))
  lines.push('')
  lines.push('## 允许的下一步状态')
  lines.push(`- 通过：${STAGES[stageId].id} 完成 → ${nextStateHint(stageId)}`)
  lines.push('- 不通过：保持原状态并写清 failures，不要替子代理补写产物。')
  lines.push('')
  lines.push('## 禁止')
  lines.push('- 不放宽判定标准凑通过。')
  lines.push('- 不替子代理补写缺失的产物内容。')
  lines.push('- 不改业务代码，不改 `01-source/raw.md` 与已固化附件。')
  lines.push('')
  lines.push('只返回 JSON schema 约束的结构化结果。')
  return lines.join('\n')
}

function boundaryFor(stageId) {
  switch (stageId) {
    case 'A1': return 'A1 只做获取与范围过滤，出现需求解释或代码影响判断即 fail。'
    case 'A2': return 'A2 只做需求澄清，出现代码影响或实现方案即 fail。'
    case 'A3': return 'A3 只做影响分析，出现实现方案或新增需求即 fail。'
    case 'A4': return 'A4 只做技术设计，出现新增需求或改动影响范围即 fail。'
    case 'A5': return 'A5 只做评审，代替 A4 改设计即 fail。'
    default: return '不得越界到其它阶段的职责。'
  }
}

function nextStateHint(stageId) {
  switch (stageId) {
    case 'A1': return '存在未处理的后端范围缺口则 BLOCKED，否则 WAITING_G1'
    case 'A2': return 'final 为 WAITING_G1，draft 为 A3_RUNNING；上报了 scope_errors 则回 A1_RUNNING'
    case 'A3': return 'final 为 WAITING_G2，draft 为 A4_RUNNING'
    case 'A4': return 'A5_RUNNING'
    case 'A5': return 'PASS/CONDITIONAL_PASS 且条件已关 → WAITING_G3；FAIL 且轮次 ≤2 → DESIGN_REVISION；轮次用尽 → BLOCKED'
    default: return '保持当前状态'
  }
}

/** The preflight prompt: read the state, decide what to do, change nothing. */
export function buildPreflightPrompt(options) {
  return [
    '你是 AWF 工作流的 Preflight 检查代理。只读，不派发、不写产物、不改状态（唯一例外：US 目录完全不存在时可以创建目录骨架）。',
    '',
    '## 要做的事（按顺序）',
    '1. 用 Bash 执行 `pwd` 与 `git rev-parse --show-toplevel` 求仓库根，二者不一致时以 git 根为准。',
    `2. 读 \`${options.workdir}/00-workflow/workflow-manifest.yaml\`，取 status / mode / current_stage / review_rounds / approvals / stale / blocked_reasons。/etp-awf-run 的状态判定只以 status 为唯一事实来源。`,
    `3. 读 \`${options.workdir}/00-workflow/artifact-manifest.yaml\`，列出已登记产物与版本。`,
    `4. 读 \`${options.workdir}/00-workflow/analysis-baseline.yaml\`，压成基线四项（repository / knowledge_graph / documentation / skills）。`,
    '5. 检查六个目录（00-workflow / 01-source / 02-requirement / 03-impact / 04-design / 05-review）是否存在；目录或 manifest 缺失时 state 记为 CREATED 并在 stop.reason 写明原因。',
    `6. 模式为 batch 时读 \`docs/awf/portfolio.yaml\`，把依赖与冲突摘要放进 artifacts 字段。`,
    '7. nextStage 只能取：A1 / A2 / A3 / A4 / A5 / GATE_G1 / GATE_G2 / GATE_G3 / COMPLETED / BLOCKED / WAITING_DEPENDENCY / DESIGN_REVISION。',
    '8. status 为 WAITING_G1/G2/G3 时把 stop.stop 置为 true，并在 stop.gates 写该门禁的已知摘要。',
    '',
    '## 禁止',
    '- 不派发子代理。',
    '- 不写任何产物。',
    '- 不改 workflow-manifest.yaml 的 status（目录缺失的初始化除外）。',
    '- 不通过任何门禁。',
    '',
    '只返回 JSON schema 约束的结构化结果。',
  ].join('\n')
}

/** The revision prompt: read ART-52 and re-dispatch exactly one stage. */
export function buildRevisionPrompt(options) {
  return [
    '你是 AWF 工作流的回流调度代理。读取修订指令，决定把哪一个阶段重新派发。只回派，不重写指令、不改评审结论。',
    '',
    '## 要做的事',
    `1. 读 \`${options.workdir}/05-review/revision-instructions.yaml\`，取 target_agent / round / issues[]。`,
    '2. 把 invalidated_artifacts[] 对应的产物在 workflow-manifest.yaml 里标为 STALE，并追加到 stale[]（写明原因与时间）。',
    '3. round > 2 时：写 `05-review/DISPUTE.md`（争议焦点、双方依据、卡住的轮次），把状态置 BLOCKED，stop=true。',
    '4. round ≤ 2 时：把状态置为 target_agent 对应的 *_RUNNING，stop=false。',
    '',
    '## 禁止',
    '- 不重写修订指令的内容。',
    '- 不改 A5 的评审结论。',
    '- 不自行挑选 target_agent，只按文件里写的回派。',
    '',
    '只返回 JSON schema 约束的结构化结果。',
  ].join('\n')
}

/** Short summary of the gate a stopped run is waiting on. */
export function briefGate(gate) {
  const definition = GATES[gate]
  if (definition === undefined) return ''
  const rows = definition.items.map((item, index) => `${index + 1}. ${item}`)
  return [`## ${gate}（${definition.name}）人工确认要点`, ...rows].join('\n')
}

/** The stage order, re-exported for callers that build prompts in bulk. */
export { STAGE_ORDER }
