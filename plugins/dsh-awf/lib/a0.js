/**
 * A0 执行层：把「读状态 → 装配 prompt → 跑 workflow → 回收结果」串起来。
 *
 * DS-V5 §2.3 把 A0 拆成三层。这一层是执行层里由插件（而不是子代理）承担的
 * 部分：它读 manifest 与基线、判定停点、装配 prompt、调 `ctx.workflowEngine`，
 * 再把结果落回 `00-workflow/`。子代理负责每个阶段的产物与校验的实质判断，
 * 插件负责机械可判定的部分——两者边界见 `checks.js` 与 `prompts.js` 的注释。
 *
 * 这一层刻意不判断「产物内容对不对」：那是 controller 子代理的职责，也是
 * DS-V5 P9「机器可判定的事不交给 LLM」的镜像——需要理解语义的判定不交给脚本。
 */

import {
  STAGES,
  STAGE_ORDER,
  STAGE_OF_STATE,
  STOP_STATES,
  DEFAULT_MAX_ACTIONS,
  MAX_ACTIONS_LIMIT,
  RERUN_CLASSES,
  GATES,
  CHECKS,
  CHECK_IDS,
  ARTIFACTS,
} from './constants.js'
import {
  Store,
  StoreError,
  nowIso,
  dumpYaml,
  sha256,
  emptyManifest,
} from './store.js'
import {
  buildStagePrompt,
  buildVerifyPrompt,
  buildPreflightPrompt,
  buildRevisionPrompt,
  briefGate,
} from './prompts.js'
import {
  WORKFLOW_SCRIPT,
  WORKFLOW_META,
  STAGE_SCHEMA,
  VERIFY_SCHEMA,
  REVISION_SCHEMA,
  clampMaxActions,
} from './workflow.js'
import { runChecks, gateChecks, gatePassed } from './checks.js'

/** The state a stage's verification currently expects next. */
const DEFAULT_NEXT_STATE = {
  A1: 'WAITING_G1',
  A2: 'WAITING_G1',
  A3: 'WAITING_G2',
  A4: 'WAITING_G3',
  A5: 'WAITING_G3',
}

/** Stage that should run next, derived only from the persisted state. */
export function stageOf(state) {
  return STAGE_OF_STATE[state]
}

/** True when the state is a stop the plugin may not pass on its own. */
export function isStopState(state) {
  return STOP_STATES[state] !== undefined
}

/** The gate whose decision the state is waiting for, if any. */
export function gateOfState(state) {
  const entry = STOP_STATES[state]
  return entry !== undefined && entry.gate !== undefined ? entry.gate : undefined
}

/**
 * Load everything a decision needs. One read pass, then pure decisions — no
 * artifact is read twice, and nothing is written here.
 */
export async function loadContext(store, usId) {
  const manifestRecord = await store.readManifest(usId)
  const manifest = manifestRecord?.manifest
  const baseline = await store.readBaseline(usId)
  const ledger = await store.readLedger(usId)
  const artifacts = {}
  const markdown = {}
  for (const [artifactId, entry] of Object.entries(ARTIFACTS)) {
    if (entry.kind === 'yaml') {
      const value = await store.readYaml(usId, artifactId)
      if (value !== undefined) artifacts[artifactId] = value
    } else if (entry.kind === 'markdown') {
      const text = await store.readMarkdown(usId, artifactId)
      if (text !== undefined) markdown[artifactId] = text
    }
  }
  return { manifestRecord, manifest, baseline, ledger, artifacts, markdown }
}

/** Evaluate the C rules against the current artifacts. */
export async function evaluate(store, usId, options = {}) {
  const context = await loadContext(store, usId)
  const existsFile = async (relative) => {
    if (relative === undefined || relative === null || String(relative).trim() === '') return false
    const info = await store.io.stat(String(relative))
    return info !== undefined && info.type === 'file'
  }
  const results = await runChecks({
    artifacts: context.artifacts,
    manifest: context.manifest,
    baseline: context.baseline,
    markdown: context.markdown,
    ledger: context.ledger,
    notes: options.notes,
    existsFile,
    modules: options.modules,
    mode: context.manifest?.mode || options.mode || 'final',
    only: options.only,
  })
  return { context, results }
}

/** Render the status command's text body. */
export function renderStatus(usId, context, results) {
  const { manifest, baseline, artifacts, ledger } = context
  const lines = []
  if (manifest === undefined) {
    lines.push(`US ${usId} 尚未初始化：先执行 /etp-awf-start ${usId} <US 链接或文件路径>`)
    return lines.join('\n')
  }
  const gate = gateOfState(manifest.status)
  lines.push(`US: ${usId} | 模式: ${manifest.mode} | 状态: ${manifest.status}${gate ? ` | 门禁: ${gate}` : ''}`)
  const repo = baseline?.baseline?.repository || {}
  const graph = baseline?.baseline?.knowledge_graph || {}
  lines.push(`基线: ${manifest.baseline_id} | 仓库 ${repo.branch || '—'}@${repo.commit || '—'} | 图谱 ${graph.version || '—'}`)
  lines.push('')
  lines.push('产物')
  for (const stage of STAGE_ORDER) {
    const slot = manifest.artifacts?.[stage] || {}
    const ids = Object.entries(ledger.entries || {}).filter(([, entry]) => entry.dir === STAGES[stage].dir).map(([id]) => id)
    const present = ids.length > 0 ? ids.join(',') : '—'
    lines.push(`  ${stage} v${slot.version ?? 0} ${String(slot.status || 'not_started').padEnd(12)} ${present}`)
  }
  lines.push('')
  lines.push('门禁')
  for (const gateId of ['G1', 'G2', 'G3']) {
    const approval = manifest.approvals?.[gateId] || { status: 'not_started' }
    lines.push(`  ${gateId} ${String(approval.status).padEnd(20)} ${approval.approver || '—'} ${approval.decided_at || ''}`)
  }
  lines.push('')
  const failed = results.filter(entry => entry.result === 'fail')
  const passed = results.filter(entry => entry.result === 'pass')
  const na = results.filter(entry => entry.result === 'not_applicable')
  lines.push(`一致性: pass ${passed.length} | fail ${failed.length} | N/A ${na.length}`)
  if (failed.length > 0) {
    lines.push('失败明细:')
    for (const entry of failed) lines.push(`  ${entry.id} ${entry.evidence}`)
  }
  const stale = manifest.stale || []
  const edits = manifest.human_edits || []
  lines.push('')
  lines.push(`失效: ${stale.length} 条 | 人工修改: ${edits.length} 条`)
  const blocked = manifest.blocked_reasons || []
  if (blocked.length > 0) {
    lines.push('')
    lines.push('阻断原因:')
    for (const entry of blocked) lines.push(`  ${entry.id} ${entry.stage} ${entry.summary || ''} → 恢复: ${entry.return_to || '—'}`)
  }
  lines.push('')
  lines.push(`下一步: ${nextStepFor(manifest.status)}`)
  return lines.join('\n')
}

/** Render a dispatch summary. */
export function renderDispatchResult(result) {
  const lines = []
  const label = result.status === 'stopped' && result.gate
    ? `停在人工门禁 ${result.gate}`
    : result.status === 'stopped'
      ? `停在 ${result.state}`
      : result.status === 'max_actions'
        ? '本轮达到动作上限'
        : result.status === 'error'
          ? '执行中断'
          : '本轮结束'
  lines.push(`AWF：${label}`)
  if (result.reason) lines.push(`原因：${result.reason}`)
  if (result.stateBefore && result.state !== result.stateBefore) lines.push(`状态：${result.stateBefore} → ${result.state}`)
  else if (result.state) lines.push(`状态：${result.state}`)
  if (result.agentsStarted !== undefined) lines.push(`本轮子代理数：${result.agentsStarted}`)
  if (Array.isArray(result.trail) && result.trail.length > 0) {
    lines.push('')
    lines.push('过程：')
    for (const entry of result.trail) lines.push(`- ${entry.stage} ${entry.phase}：${entry.detail}`)
  }
  if (result.next) lines.push('', `下一步：${result.next}`)
  return lines.join('\n')
}

/** The one-line next step for a state. */
export function nextStepFor(state) {
  switch (state) {
    case 'CREATED': return '/etp-awf-start <US-ID> <US 链接或文件路径>'
    case 'BASELINE_CONFIRMED': return '/etp-awf-run'
    case 'A1_RUNNING': return '/etp-awf-run'
    case 'A2_RUNNING': return '/etp-awf-run'
    case 'A3_RUNNING': return '/etp-awf-run'
    case 'A4_RUNNING': return '/etp-awf-run'
    case 'A5_RUNNING': return '/etp-awf-run'
    case 'WAITING_G1': return '/etp-awf-gate G1'
    case 'WAITING_G2': return '/etp-awf-gate G2'
    case 'WAITING_G3': return '/etp-awf-gate G3'
    case 'DESIGN_REVISION': return '/etp-awf-run（按 05-review/revision-instructions.yaml 回派）'
    case 'WAITING_DEPENDENCY': return '/etp-awf-status（等待上游 US 冻结）'
    case 'COMPLETED': return '/etp-awf-status（已冻结交付）'
    case 'BLOCKED': return `/etp-awf-rerun <阶段> ${''}`.trim() + '（解阻后回流）'
    default: return '/etp-awf-status'
  }
}

/**
 * Register a baseline and create the layout. This mirrors `/etp-awf-start`:
 * the four baseline items come from the human verbatim, and nothing here
 * derives a baseline from the current HEAD (DS-V5 hard rule 2).
 */
export async function startWorkflow(store, request) {
  const usId = String(request.usId ?? '').trim()
  if (!/^US-\d{4}-\d{3}$/u.test(usId)) {
    throw new StoreError('EUSID', `US 标识格式应为 US-YYYY-NNN，收到「${usId}」`)
  }
  if (await store.isInitialized(usId)) {
    throw new StoreError('EEXISTS', `${usId} 已有 workflow-manifest.yaml：用 /etp-awf-status 查看，不要重复 start`)
  }
  const baseline = request.baseline || {}
  const missing = ['repository', 'knowledge_graph', 'documentation', 'skills'].filter(key => {
    const value = baseline[key]
    return value === undefined || value === null || String(value).trim?.() === '' || (typeof value === 'object' && Object.keys(value).length === 0)
  })
  if (missing.length > 0) {
    throw new StoreError('EBASELINE', `基线缺少：${missing.join('、')}。基线必须由人提供，插件不自行取当前 HEAD。`)
  }
  const mode = request.mode === 'draft' ? 'draft' : 'final'
  await store.ensureLayout(usId)
  const baselineId = request.baselineId || 'BASE-001'
  const baselineDoc = {
    baseline: {
      id: baselineId,
      us_id: usId,
      provided_by: String(request.providedBy ?? '').trim() || null,
      provided_at: nowIso(),
      confirmed: request.confirmed !== false,
      repository: baseline.repository,
      knowledge_graph: baseline.knowledge_graph,
      documentation: baseline.documentation,
      skills: baseline.skills,
    },
  }
  await store.writeYaml(usId, 'ART-01', baselineDoc)
  const manifestRecord = await store.readManifest(usId)
  const manifest = manifestRecord?.manifest ?? emptyManifest(usId, mode, baselineId)
  manifest.mode = mode
  manifest.baseline_id = baselineId
  manifest.status = 'BASELINE_CONFIRMED'
  manifest.current_stage = 'A1'
  manifest.transitions.push({ from: 'CREATED', to: 'BASELINE_CONFIRMED', detail: '人工登记基线', at: nowIso() })
  await store.saveManifest(usId, manifest)
  const ledger = { id: `${usId}-AM`, us_id: usId, entries: {}, updated_at: nowIso() }
  await store.saveLedger(usId, ledger)
  await store.appendReport(usId, [
    `# AWF 执行报告 ${usId}`,
    '',
    `- 创建时间：${nowIso()}`,
    `- 模式：${mode}`,
    `- 基线：${baselineId}`,
    `- US 来源：${String(request.usRef ?? '').trim() || '未提供，由 A1 获取'}`,
    `- 提供人：${String(request.providedBy ?? '').trim() || '未记录'}`,
  ])
  return {
    usId,
    mode,
    baselineId,
    state: manifest.status,
    dir: store.usDir(usId),
    next: '/etp-awf-run',
  }
}

/**
 * Build the routing table the workflow script consumes. Kept pure so a test can
 * assert the state → stage map without a live engine.
 */
export function routingTables() {
  const stopStates = {}
  for (const [state, entry] of Object.entries(STOP_STATES)) stopStates[state] = { reason: entry.reason, gate: entry.gate }
  const stageOfState = { ...STAGE_OF_STATE }
  return { stopStates, stageOfState }
}

/**
 * Run one dispatch pass: preflight, then let the engine dispatch stages until a
 * stop. Returns a plain summary the tool renders.
 */
export async function runDispatch(deps, request) {
  const { store, engine, agent, usId } = deps
  const manifestRecord = await store.readManifest(usId)
  if (manifestRecord === undefined) {
    return {
      status: 'stopped',
      state: 'CREATED',
      reason: `US ${usId} 尚未初始化：先执行 /etp-awf-start`,
      next: '/etp-awf-start',
    }
  }
  const manifest = manifestRecord.manifest
  const mode = request.mode === 'draft' ? 'draft' : manifest.mode || 'final'
  if (request.forceStage !== undefined) {
    const expected = STAGE_OF_STATE[manifest.status]
    if (expected !== request.forceStage) {
      return {
        status: 'error',
        state: manifest.status,
        reason: `forceStage=${request.forceStage} 与状态 ${manifest.status} 不一致（该状态对应 ${expected ?? '非阶段动作'}）。不要用 forceStage 跳过上游：先用 /etp-awf-rerun 让状态回到目标阶段。`,
      }
    }
  }
  if (isStopState(manifest.status)) {
    return {
      status: 'stopped',
      state: manifest.status,
      reason: STOP_STATES[manifest.status].reason,
      gate: gateOfState(manifest.status) || null,
      next: nextStepFor(manifest.status),
    }
  }
  if (request.dryRun === true) {
    return {
      status: 'stopped',
      state: manifest.status,
      reason: 'dryRun：只做 Preflight，不派发子代理',
      next: nextStepFor(manifest.status),
    }
  }

  const context = await loadContext(store, usId)
  const workdir = store.usDir(usId)
  const baselineSummary = context.baseline?.baseline

  const prompts = {}
  const verifyPrompts = {}
  for (const stageId of STAGE_ORDER) {
    prompts[stageId] = buildStagePrompt(stageId, {
      usId,
      mode,
      usRef: request.usRef,
      workdir,
      baseline: baselineSummary,
      inputDigest: summarizeInputs(stageId, context),
    })
    verifyPrompts[stageId] = buildVerifyPrompt(stageId, {}, { workdir })
  }
  const tables = routingTables()
  const args = {
    usId,
    mode,
    workdir,
    state: manifest.status,
    maxActions: clampMaxActions(request.maxActions),
    stopStates: tables.stopStates,
    stageOfState: tables.stageOfState,
    prompts,
    verifyPrompts,
    revisionPrompt: buildRevisionPrompt({ workdir }),
    revisionState: 'DESIGN_REVISION',
    schemas: { stage: STAGE_SCHEMA, verify: VERIFY_SCHEMA, revision: REVISION_SCHEMA },
  }
  const run = engine.start({
    script: WORKFLOW_SCRIPT,
    meta: WORKFLOW_META,
    args,
    parent: agent,
  })
  let result
  try {
    result = await run.result
  } finally {
    try {
      await run.dispose()
    } catch {
      // Disposal failure must not hide the run's settled result.
    }
  }
  if (result.stopReason !== 'completed') {
    return {
      status: 'error',
      state: manifest.status,
      reason: result.error || `workflow 以 ${result.stopReason} 结束`,
      agentsStarted: result.agentsStarted,
    }
  }
  const value = result.value || {}
  const after = await store.readManifest(usId)
  return {
    status: value.status || 'stopped',
    state: after?.manifest?.status ?? value.state ?? manifest.status,
    stateBefore: manifest.status,
    reason: value.reason || '',
    gate: value.gate || gateOfState(after?.manifest?.status ?? '') || null,
    next: value.next || nextStepFor(after?.manifest?.status ?? manifest.status),
    trail: value.trail || [],
    actions: value.actions ?? 0,
    last: value.last ?? null,
    agentsStarted: result.agentsStarted,
  }
}

/**
 * One line per upstream artifact the stage will read, plus the version each one
 * is at — DS-V5 K4 needs the version inside the prompt, because the subagent
 * cannot look it up from a previous turn.
 */
function summarizeInputs(stageId, context) {
  const stage = STAGES[stageId]
  const lines = [...stage.inputs]
  const registered = []
  for (const [artifactId, value] of Object.entries(context.artifacts)) {
    const entry = ARTIFACTS[artifactId]
    if (entry === undefined || !stage.inputs.some(input => input.startsWith(`${entry.dir}/`))) continue
    const header = value?.artifact
    registered.push(`${artifactId} v${header?.version ?? 0}（${header?.status ?? 'draft'}）`)
  }
  if (registered.length > 0) lines.push(`已登记产物：${registered.join('；')}`)
  return lines
}

/**
 * A gate may only be decided against the artifacts it is defined to review. An
 * absent artifact is a blocking condition, not an empty set: DS-V5 §10.2 lists
 * what a human signs, and "nothing to sign" is never an approval.
 */
async function missingGateArtifacts(store, usId, gateId) {
  const missing = []
  for (const artifactId of GATES[gateId].artifacts) {
    const entry = ARTIFACTS[artifactId]
    if (entry.kind === 'directory') {
      const listing = await store.listArtifactDir(usId, artifactId)
      if (listing.length === 0) missing.push(artifactId)
      continue
    }
    if (!(await store.exists(usId, artifactId))) missing.push(artifactId)
  }
  return missing
}

/**
 * Record a gate decision. The plugin refuses to write an approval that has not
 * been given by a human and never promotes a blocking failure to approved.
 */
export async function recordGate(store, request) {
  const usId = request.usId
  const gateId = request.gate
  const definition = GATES[gateId]
  if (definition === undefined) throw new StoreError('EGATE', `未知门禁 ${gateId}，只能是 G1/G2/G3`)
  const manifestRecord = await store.readManifest(usId)
  if (manifestRecord === undefined) throw new StoreError('ENOSTATE', `US ${usId} 尚未初始化`)
  const manifest = manifestRecord.manifest
  if (manifest.status !== definition.state) {
    throw new StoreError('ESTATE', `当前状态 ${manifest.status}，不能在 ${gateId} 上记录结论（需要 ${definition.state}）`)
  }
  const decision = String(request.decision ?? '').toUpperCase()
  if (!['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'].includes(decision)) {
    throw new StoreError('EDECISION', `结论只能是 APPROVED / PARTIALLY_APPROVED / REJECTED，收到「${request.decision}」`)
  }
  const approver = String(request.approver ?? '').trim()
  if (approver === '') throw new StoreError('EAPPROVER', '审批人必须是真实姓名：空审批人的记录无效')

  const missing = await missingGateArtifacts(store, usId, gateId)
  if (missing.length > 0) {
    throw new StoreError(
      'ENOARTIFACT',
      `${gateId} 缺少审批对象：${missing.join('、')}。门禁要对机器消费的那一份产物签字，缺失时不能给结论。`,
    )
  }

  const { context, results } = await evaluate(store, usId)
  const gateResults = gateChecks(gateId, results)
  const failing = gateResults.filter(entry => entry.result === 'fail')
  if (decision === 'APPROVED' && failing.length > 0) {
    throw new StoreError(
      'EBLOCKING',
      `${gateId} 存在未通过的阻断项，不能记为 APPROVED：${failing.map(entry => `${entry.id} ${entry.evidence}`).join('；')}`,
    )
  }
  if (decision === 'PARTIALLY_APPROVED') {
    const pending = request.pendingItems
    if (!Array.isArray(pending) || pending.length === 0) {
      throw new StoreError('EPARTIAL', 'PARTIALLY_APPROVED 必须给出待定清单（待定条目、责任人、期限）')
    }
    if (failing.length > 0) {
      throw new StoreError(
        'EBLOCKING',
        `PARTIALLY_APPROVED 只允许非阻断项待定；以下阻断项仍未通过：${failing.map(entry => entry.id).join('、')}`,
      )
    }
  }

  const approval = {
    status: decision,
    approver,
    decided_at: nowIso(),
    notes: String(request.notes ?? ''),
    decisions: Array.isArray(request.decisions) ? request.decisions : [],
    accepted_gaps: Array.isArray(request.acceptedGaps) ? request.acceptedGaps : [],
    rejected_to: request.rejectedTo ?? null,
  }
  manifest.approvals[gateId] = approval
  const transitions = []
  if (decision === 'REJECTED') {
    const target = String(request.rejectedTo ?? '').toUpperCase()
    const allowed = ['A1', 'A2', 'A3', 'A4']
    if (target !== '' && !allowed.includes(target)) {
      throw new StoreError('EREJECT', `rejected_to 只能是 A1/A2/A3/A4，收到「${request.rejectedTo}」`)
    }
    const nextState = target === '' ? 'BLOCKED' : `${target}_RUNNING`
    manifest.status = nextState
    transitions.push({ from: definition.state, to: nextState, detail: `${gateId} 退回${target || '（未指定，置 BLOCKED）'}`, at: nowIso() })
  } else if (decision === 'APPROVED') {
    const next = gateSuccessor(gateId, manifest.mode)
    manifest.status = next
    transitions.push({ from: definition.state, to: next, detail: `${gateId} 批准`, at: nowIso() })
    if (next === 'COMPLETED') {
      manifest.frozen_at = nowIso()
      for (const stage of STAGE_ORDER) {
        if (manifest.artifacts[stage] !== undefined) {
          manifest.artifacts[stage].status = 'final'
          const value = context.artifacts
          void value
        }
      }
    }
  } else {
    transitions.push({ from: definition.state, to: definition.state, detail: `${gateId} 部分批准，停留原状态等待补齐`, at: nowIso() })
  }
  manifest.transitions.push(...transitions)
  await store.saveManifest(usId, manifest)
  await store.appendReport(usId, [
    '',
    `## ${gateId} ${definition.name}：${decision}`,
    `- 审批人：${approver}`,
    `- 时间：${approval.decided_at}`,
    `- 说明：${approval.notes || '（无）'}`,
    `- 阻断项通过情况：${gateResults.map(entry => `${entry.id}:${entry.result}`).join(' ') || '（无）'}`,
  ])
  return {
    usId,
    gate: gateId,
    decision,
    approver,
    state: manifest.status,
    next: nextStepFor(manifest.status),
    checks: gateResults.map(entry => ({ id: entry.id, result: entry.result })),
  }
}

/** The state a gate's approval leads to, per DS-V5 §12.5. */
export function gateSuccessor(gateId, mode) {
  if (gateId === 'G1') return 'A3_RUNNING'
  if (gateId === 'G2') return 'A4_RUNNING'
  // G3: draft runs stop at the design, final runs freeze for delivery.
  return 'COMPLETED'
}

/**
 * Mark artifacts stale, reset gates and move to the earliest affected stage.
 * The class table is DS-V5 §12.6 — twelve classes, and nothing else.
 */
export async function rerunWorkflow(store, request) {
  const usId = request.usId
  const changeClass = String(request.changeClass ?? '').trim()
  const definition = RERUN_CLASSES[changeClass]
  if (definition === undefined) {
    throw new StoreError('ERERUN', `未知变化类型「${changeClass}」，可用：${Object.keys(RERUN_CLASSES).join(' / ')}`)
  }
  const manifestRecord = await store.readManifest(usId)
  if (manifestRecord === undefined) throw new StoreError('ENOSTATE', `US ${usId} 尚未初始化`)
  const manifest = manifestRecord.manifest
  if (definition.invalidates.length === 0) {
    return { usId, changeClass, state: manifest.status, invalidated: [], resetGates: [], next: nextStepFor(manifest.status) }
  }
  const earliest = definition.invalidates.slice().sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))[0]
  store.markStale(manifest, definition.invalidates, `${changeClass}：${definition.label}`)
  for (const gateId of definition.resetGates) {
    manifest.approvals[gateId] = { status: 'not_started' }
  }
  const nextState = `${earliest}_RUNNING`
  manifest.status = nextState
  manifest.transitions.push({ from: manifestRecord.manifest.status, to: nextState, detail: `rerun ${changeClass}（${definition.label}）`, at: nowIso() })
  await store.saveManifest(usId, manifest)
  await store.appendReport(usId, [
    '',
    `## 增量重跑 ${changeClass}`,
    `- 变化：${definition.label}`,
    `- 失效阶段：${definition.invalidates.join('、')}`,
    `- 重置门禁：${definition.resetGates.join('、') || '（无）'}`,
    `- 迁往状态：${nextState}`,
  ])
  return {
    usId,
    changeClass,
    label: definition.label,
    invalidated: definition.invalidates,
    resetGates: definition.resetGates,
    state: nextState,
    next: nextStepFor(nextState),
  }
}

/** Force an A5 re-review (mirrors `/etp-awf-review`). */
export async function forceReview(store, request) {
  const usId = request.usId
  const manifestRecord = await store.readManifest(usId)
  if (manifestRecord === undefined) throw new StoreError('ENOSTATE', `US ${usId} 尚未初始化`)
  const manifest = manifestRecord.manifest
  const context = await loadContext(store, usId)
  for (const stage of ['A1', 'A2', 'A3', 'A4']) {
    const present = Object.entries(context.artifacts).some(([id, value]) => id.startsWith(`ART-${stage.slice(1)}`) && value !== undefined)
    if (!present) throw new StoreError('ENOPREREQ', `A${stage.slice(1)} 产物缺失，无法强制评审`)
  }
  const design = manifest.artifacts.A4
  if (design !== undefined && design.status === 'STALE') {
    throw new StoreError('ESTALE', 'A4 产物为 STALE，先 /etp-awf-rerun 重做设计')
  }
  if (manifest.status !== 'A5_RUNNING') {
    manifest.status = 'A5_RUNNING'
    manifest.transitions.push({ from: manifestRecord.manifest.status, to: 'A5_RUNNING', detail: '强制重跑 A5', at: nowIso() })
    await store.saveManifest(usId, manifest)
  }
  const archive = `05-review/revision-history/round-${(manifest.review_rounds?.length ?? 0) + 1}`
  const review = await store.readYaml(usId, 'ART-50')
  if (review !== undefined) {
    await store.writeMarkdown(usId, 'ART-51', `# 上一轮评审归档（${archive}）\n\n已在 ${nowIso()} 被强制重审取代。\n`)
  }
  return { usId, state: 'A5_RUNNING', next: '/etp-awf-run', archive }
}

/** Build the gate preview a human inspects before deciding. */
export async function gatePreview(store, usId, gateId) {
  const definition = GATES[gateId]
  if (definition === undefined) throw new StoreError('EGATE', `未知门禁 ${gateId}`)
  const { context, results } = await evaluate(store, usId)
  const gateResults = gateChecks(gateId, results)
  const lines = []
  lines.push(`# ${gateId} ${definition.name}`)
  lines.push('')
  lines.push(`状态：${context.manifest?.status ?? '未知'}`)
  lines.push(`审批对象：${definition.artifacts.join('、')}`)
  lines.push('')
  lines.push('## 检查项')
  for (const entry of gateResults) lines.push(`- ${entry.id} ${entry.result}${entry.evidence ? `：${entry.evidence}` : ''}`)
  lines.push('')
  lines.push(briefGate(gateId))
  lines.push('')
  lines.push('## 结论候选')
  lines.push('APPROVED / PARTIALLY_APPROVED（需待定清单）/ REJECTED（需 rejected_to）')
  lines.push('')
  lines.push(`写入方式：/etp-awf-gate ${gateId} <APPROVED|PARTIALLY_APPROVED|REJECTED> --approver "姓名" [--notes "说明"]`)
  return {
    gate: gateId,
    text: lines.join('\n'),
    checks: gateResults,
    blocking: gateResults.filter(entry => entry.result === 'fail').map(entry => entry.id),
  }
}

/** A compact summary of the check table, for tool descriptions and docs. */
export function checkTable() {
  return CHECKS.map(check => `${check.id}（${check.strength}）${check.title}`)
}

export { CHECK_IDS, sha256, dumpYaml }
