/**
 * 插件自测：不需要 DSH 运行时，用假 ctx 把 `apply` 跑起来，验证
 * 「注册了什么」「门禁拒绝什么」「状态机只走合法边」「产物读写自洽」。
 *
 * 运行：node plugins/dsh-awf/test/plugin.test.mjs
 *
 * 为什么这样测：DSH 的 Host 服务（tools/commands/skills/workflowEngine）在
 * 插件里只用到很窄的一组方法，用一个记录调用的假实现就能覆盖注册面；真正的
 * 端到端验证放在 `install_bundle` 之后用 `cordis_inspect_query` 做。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../index.js'
import { nodeStore } from '../lib/store.js'
import { startWorkflow, evaluate, renderStatus, recordGate, rerunWorkflow, gatePreview } from '../lib/a0.js'
import { runChecks } from '../lib/checks.js'
import { runScript, subagentAgent } from '../lib/runner.js'
import { WORKFLOW_SCRIPT, STAGE_SCHEMA, VERIFY_SCHEMA } from '../lib/workflow.js'
import { dump, parse } from '../lib/yaml.js'
import { STATES, STAGE_ORDER, CHECK_IDS, GATES, RERUN_CLASSES } from '../lib/constants.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

/** A fake plugin context that records every registration. */
function fakeContext(root) {
  const record = { tools: [], commands: [], skills: [], sections: [], effects: [], injected: [] }
  const ctx = {
    record,
    logger: { info() {}, warn() {}, error() {} },
    fs: undefined,
    get(key) {
      if (key === 'workingDirectory') return { get: () => root }
      return undefined
    },
    effect(factory, label) {
      const dispose = factory()
      record.effects.push({ label, dispose })
      return dispose
    },
    inject(names, callback) {
      record.injected.push(names.join(','))
      callback(ctx)
    },
    tools: {
      register(definition) {
        record.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        record.commands.push(definition)
        return () => {}
      },
    },
    skills: {
      register(definition) {
        record.skills.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section)
        return () => {}
      },
    },
    // Root scope deliberately has no workflowEngine: it lives in the agent preset
    // scope in this profile, so the plugin must resolve it lazily.
    get workflowEngine() { return undefined },
  }
  return ctx
}

// ── 1. 纯函数层：YAML 与常量表 ────────────────────────────────────────────────

test('YAML roundtrip keeps nested structures and CJK text', () => {
  const value = {
    artifact: { id: 'A2-001', version: 2, status: 'draft' },
    rules: [{ id: 'R-001', source: { type: 'explicit', reference: 'BLK-003' }, note: '中文，含逗号: 与冒号' }],
    empty: [], missing: null, flag: true, count: 3,
    multiline: '第一行\n第二行',
  }
  assert.deepEqual(parse(dump(value)), value)
})

test('state machine has exactly the fourteen DS-V5 states', () => {
  assert.equal(STATES.length, 14)
  assert.equal(new Set(STATES).size, 14)
})

test('twenty C rules and three gates are declared', () => {
  assert.equal(CHECK_IDS.length, 20)
  assert.deepEqual(CHECK_IDS, Array.from({ length: 20 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`))
  assert.deepEqual(Object.keys(GATES), ['G1', 'G2', 'G3'])
  for (const gate of Object.values(GATES)) {
    assert.equal(gate.items.length > 0, true, `${gate.id} 必须有阻断项`)
    for (const id of gate.checks) assert.ok(CHECK_IDS.includes(id), `${gate.id} 引用了未知规则 ${id}`)
  }
})

test('twelve rerun classes match DS-V5 §12.6', () => {
  assert.equal(Object.keys(RERUN_CLASSES).length, 12)
  for (const definition of Object.values(RERUN_CLASSES)) {
    assert.ok(Array.isArray(definition.invalidates))
    assert.ok(Array.isArray(definition.resetGates))
  }
})

test('every stage names a directory, skills and checks', () => {
  for (const stageId of STAGE_ORDER) {
    const stage = plugin.inventory.stages.includes(stageId)
    assert.ok(stage, `inventory 缺少 ${stageId}`)
  }
})

// ── 2. 注册面：apply 注册了什么 ──────────────────────────────────────────────

const tempRoot = await mkdtemp(join(tmpdir(), 'awf-plugin-'))
const ctx = fakeContext(tempRoot)
plugin.apply(ctx)

test('apply registers four tools', () => {
  assert.deepEqual(ctx.record.tools.map(tool => tool.name).sort(), ['awf_gate', 'awf_run', 'awf_start', 'awf_status'])
  for (const tool of ctx.record.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('apply registers six commands', () => {
  assert.deepEqual(ctx.record.commands.map(command => command.name).sort(), [
    'etp-awf-gate', 'etp-awf-rerun', 'etp-awf-review', 'etp-awf-run', 'etp-awf-start', 'etp-awf-status',
  ])
  for (const command of ctx.record.commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/u, '命令名必须符合 DSH 的 COMMAND_NAME 规则')
  }
})

test('apply registers the seven AWF skills', () => {
  const names = ctx.record.skills.map(skill => skill.name).sort()
  assert.deepEqual(names, [
    'etp-awf-workflow', 'etp-code-graph-query', 'etp-design-doc-writing', 'etp-design-review',
    'etp-legacy-saas-analysis', 'etp-project-checklist', 'etp-requirement-fetch',
  ])
  for (const skill of ctx.record.skills) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    assert.ok(skill.content.length > 200, `${skill.name} 正文过短`)
    assert.ok(skill.description.length > 10)
    assert.equal(skill.resourceBase.kind, 'directory')
  }
})

test('apply adds exactly one prompt section', () => {
  assert.equal(ctx.record.sections.length, 1)
  assert.equal(ctx.record.sections[0].name, 'plugin:awf')
  assert.ok(ctx.record.sections[0].text.includes('/etp-awf-rerun'))
})

const baseArtifacts = () => ({
  'ART-10': {
    artifact: { id: 'A1-001', version: 1, status: 'draft', baseline_id: 'BASE-001' },
    requirement_source: {
      source: { platform: 'p', url: 'u', fetched_at: 't', content_hash: 'h' },
      snapshot: { ref: '01-source/raw.md', assets: [] },
      blocks: [{ id: 'BLK-001', title: 't', location: '1', scope: 'backend' }],
      excluded: [], gaps: [], links: [],
    },
  },
  'ART-20': {
    artifact: { id: 'A2-001', version: 2, status: 'draft', baseline_id: 'BASE-001' },
    requirement: {
      rules: [{ id: 'R-001', source: { type: 'explicit', reference: 'BLK-001' }, decision_status: 'confirmed' }],
      acceptance_criteria: [{ id: 'AC-001', rule_ids: ['R-001'], expected: '400' }],
    },
  },
  'ART-30': {
    artifact: { id: 'A3-001', version: 1, status: 'draft', baseline_id: 'BASE-001' },
    impact_analysis: { impacts: [{ id: 'IMPACT-001', impact_type: 'mandatory', rule_refs: ['R-001'], evidence: [{ type: 'static_analysis', reference: 'file:a:1' }], risk: 'MEDIUM', target: { file: 'Service.java' } }] },
  },
})

const baseManifest = () => ({
  status: 'WAITING_G2', mode: 'final', baseline_id: 'BASE-001',
  artifacts: { A1: { version: 1 }, A2: { version: 2 }, A3: { version: 1 }, A4: { version: 0 }, A5: { version: 0 } },
  approvals: { G1: { status: 'APPROVED' }, G2: { status: 'not_started' }, G3: { status: 'not_started' } },
  stale: [], human_edits: [],
})

// ── 3. 行为：启动 → 状态 → 门禁 ──────────────────────────────────────────────

await testAsync('start refuses to invent a baseline', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => startWorkflow(store, { usId: 'US-2026-901', baseline: { repository: { commit: 'abc' } } }),
    error => error.code === 'EBASELINE',
  )
})

await testAsync('start rejects a malformed US id', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => startWorkflow(store, { usId: 'nope', baseline: {} }),
    error => error.code === 'EUSID',
  )
})

await testAsync('start creates the six directories and a BASELINE_CONFIRMED manifest', async () => {
  const store = await nodeStore(tempRoot)
  const result = await startWorkflow(store, {
    usId: 'US-2026-901',
    mode: 'final',
    providedBy: '张工',
    baseline: {
      repository: { name: 'legacy-saas', branch: 'release/10.x', commit: '8f3a9c2' },
      knowledge_graph: { provider: 'mcp', version: 'g1', commit: '8f3a9c2' },
      documentation: { version: 'docs1' },
      skills: { version: 'v1' },
    },
  })
  assert.equal(result.state, 'BASELINE_CONFIRMED')
  const manifestText = await readFile(join(tempRoot, 'docs/awf/US-2026-901/00-workflow/workflow-manifest.yaml'), 'utf8')
  const manifest = parse(manifestText)
  assert.equal(manifest.status, 'BASELINE_CONFIRMED')
  assert.equal(manifest.mode, 'final')
  assert.equal(manifest.baseline_id, 'BASE-001')
  assert.equal(manifest.transitions.length, 1)
  for (const stage of STAGE_ORDER) assert.equal(manifest.artifacts[stage].version, 0)
})

await testAsync('the same US cannot be started twice', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => startWorkflow(store, { usId: 'US-2026-901', baseline: { repository: {}, knowledge_graph: {}, documentation: {}, skills: {} } }),
    error => error.code === 'EEXISTS' || error.code === 'EBASELINE',
  )
})

await testAsync('status renders without mutating the manifest', async () => {
  const store = await nodeStore(tempRoot)
  const before = await readFile(join(tempRoot, 'docs/awf/US-2026-901/00-workflow/workflow-manifest.yaml'), 'utf8')
  const { context, results } = await evaluate(store, 'US-2026-901')
  const body = renderStatus('US-2026-901', context, results)
  const after = await readFile(join(tempRoot, 'docs/awf/US-2026-901/00-workflow/workflow-manifest.yaml'), 'utf8')
  assert.equal(before, after, 'status 必须只读')
  assert.match(body, /状态: BASELINE_CONFIRMED/)
  assert.match(body, /下一步: \/etp-awf-run/)
})

await testAsync('a gate cannot be recorded in the wrong state', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => recordGate(store, { usId: 'US-2026-901', gate: 'G1', decision: 'APPROVED', approver: '张工' }),
    error => error.code === 'ESTATE',
  )
})

await testAsync('a gate refuses an empty approver', async () => {
  const store = await nodeStore(tempRoot)
  const manifestPath = join(tempRoot, 'docs/awf/US-2026-901/00-workflow/workflow-manifest.yaml')
  const manifest = parse(await readFile(manifestPath, 'utf8'))
  manifest.status = 'WAITING_G1'
  const { writeFile } = await import('node:fs/promises')
  await writeFile(manifestPath, dump(manifest), 'utf8')
  await assert.rejects(
    () => recordGate(store, { usId: 'US-2026-901', gate: 'G1', decision: 'APPROVED', approver: '  ' }),
    error => error.code === 'EAPPROVER',
  )
})

await testAsync('a gate refuses a decision on artifacts that do not exist', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => recordGate(store, { usId: 'US-2026-901', gate: 'G1', decision: 'APPROVED', approver: '张工' }),
    error => error.code === 'ENOARTIFACT',
  )
})

await testAsync('a gate refuses APPROVED while a blocking rule fails', async () => {
  const store = await nodeStore(tempRoot)
  // Stage real G1 artifacts, then break one rule so a blocking check fails.
  await store.writeYaml('US-2026-901', 'ART-10', baseArtifacts()['ART-10'])
  await store.writeYaml('US-2026-901', 'ART-20', baseArtifacts()['ART-20'])
  await store.writeYaml('US-2026-901', 'ART-22', { decisions: [] })
  await store.writeMarkdown('US-2026-901', 'ART-11', '# 后端范围\n\n占位，用于验证 S15 在规则失败时拒绝 APPROVED。\n')
  await assert.rejects(
    () => recordGate(store, { usId: 'US-2026-901', gate: 'G1', decision: 'APPROVED', approver: '张工' }),
    (error) => {
      // Either a blocking check fires, or the ledger/version guard does; both are refusals.
      assert.equal(error.code, 'EBLOCKING', `unexpected code ${error.code}: ${error.message}`)
      return true
    },
  )
})

await testAsync('rerun marks downstream artifacts STALE and resets gates', async () => {
  const store = await nodeStore(tempRoot)
  const result = await rerunWorkflow(store, { usId: 'US-2026-901', changeClass: 'a2_rules' })
  assert.deepEqual(result.invalidated, ['A2', 'A3', 'A4', 'A5'])
  assert.deepEqual(result.resetGates, ['G1', 'G2', 'G3'])
  assert.equal(result.state, 'A2_RUNNING')
  const manifest = parse(await readFile(join(tempRoot, 'docs/awf/US-2026-901/00-workflow/workflow-manifest.yaml'), 'utf8'))
  assert.equal(manifest.artifacts.A2.status, 'STALE')
  assert.equal(manifest.approvals.G1.status, 'not_started')
})

await testAsync('rerun rejects an unknown change class', async () => {
  const store = await nodeStore(tempRoot)
  await assert.rejects(
    () => rerunWorkflow(store, { usId: 'US-2026-901', changeClass: 'whatever' }),
    error => error.code === 'ERERUN',
  )
})

await testAsync('gate preview lists blocking rule ids', async () => {
  const store = await nodeStore(tempRoot)
  const preview = await gatePreview(store, 'US-2026-901', 'G1')
  assert.ok(Array.isArray(preview.blocking))
  assert.match(preview.text, /G1 需求确认/)
  assert.match(preview.text, /APPROVED \/ PARTIALLY_APPROVED/)
})

await testAsync('awf_run reports a dispatch failure instead of crashing', async () => {
  const tools = Object.fromEntries(ctx.record.tools.map(tool => [tool.name, tool]))
  // The fake context has no fs service, so the store cannot read: the tool must
  // still answer with a structured error rather than throwing.
  const answer = await tools.awf_run.execute(
    { us_id: 'US-2026-901' },
    { agent: { id: 'a', session: {}, ctx: { get: () => undefined } }, signal: AbortSignal.timeout(1000), arguments: {} },
  )
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 'error')
  assert.match(answer.summary, /AWF 推进失败/)
})

// ── 3b. 决策层脚本：真正的路由行为 ──────────────────────────────────────────

const scriptArgs = () => ({
  usId: 'US-2026-901',
  mode: 'final',
  workdir: 'docs/awf/US-2026-901',
  state: 'BASELINE_CONFIRMED',
  maxActions: 8,
  stopStates: {
    CREATED: { reason: '未登记基线' },
    WAITING_G1: { reason: '等待 G1', gate: 'G1' },
    WAITING_G2: { reason: '等待 G2', gate: 'G2' },
    BLOCKED: { reason: '阻断' },
    COMPLETED: { reason: '完成' },
  },
  stageOfState: { BASELINE_CONFIRMED: 'A1', A1_RUNNING: 'A1', A2_RUNNING: 'A2' },
  prompts: { A1: 'STAGE-A1', A2: 'STAGE-A2' },
  verifyPrompts: { A1: 'VERIFY-A1', A2: 'VERIFY-A2' },
  revisionPrompt: 'REVISION',
  revisionState: 'DESIGN_REVISION',
  schemas: { stage: STAGE_SCHEMA, verify: VERIFY_SCHEMA, revision: { type: 'object' } },
})

await testAsync('the routing script stops at G1 and reports the gate', async () => {
  const calls = []
  const run = await runScript({
    script: WORKFLOW_SCRIPT,
    args: scriptArgs(),
    agent: async (prompt, opts) => {
      calls.push({ prompt, label: opts.label })
      if (prompt.startsWith('VERIFY')) return { passed: true, nextState: 'WAITING_G1', checks: [{ id: 'C13', result: 'pass' }], failures: [] }
      return { stage: 'A1', bundleId: 'A1-001', version: 1, status: 'draft', files: [], blocked: [], needHuman: [], next: 'ok' }
    },
  })
  assert.equal(run.error, null)
  assert.equal(run.value.status, 'stopped')
  assert.equal(run.value.gate, 'G1')
  assert.equal(run.value.state, 'WAITING_G1')
  assert.equal(run.value.next, '/etp-awf-gate G1')
  assert.equal(run.agentsStarted, 2, '一次阶段派发 + 一次校验')
  assert.deepEqual(calls.map(call => call.label), ['A1', 'verify A1'])
})

await testAsync('the routing script blocks after two empty stage returns (K5)', async () => {
  const run = await runScript({
    script: WORKFLOW_SCRIPT,
    args: scriptArgs(),
    agent: async () => null,
  })
  assert.equal(run.error, null)
  assert.equal(run.value.status, 'stopped')
  assert.equal(run.value.state, 'BLOCKED')
  assert.match(run.value.reason, /连续两次空返回/)
  assert.equal(run.agentsStarted, 2)
})

await testAsync('a failing verification blocks instead of advancing', async () => {
  const run = await runScript({
    script: WORKFLOW_SCRIPT,
    args: scriptArgs(),
    agent: async (prompt) => {
      if (prompt.startsWith('VERIFY')) return { passed: false, nextState: 'A1_RUNNING', checks: [{ id: 'C14', result: 'fail' }], failures: ['快照不存在'] }
      return { stage: 'A1', bundleId: 'A1-001', version: 1, status: 'draft', files: [], blocked: [], needHuman: [], next: 'ok' }
    },
  })
  assert.equal(run.value.state, 'BLOCKED')
  assert.match(run.value.reason, /两次校验未通过/)
  assert.match(run.value.reason, /快照不存在/)
})

await testAsync('maxActions stops the loop instead of running to a gate', async () => {
  const args = scriptArgs()
  args.maxActions = 1
  args.stageOfState = { BASELINE_CONFIRMED: 'A1', A1_RUNNING: 'A2' }
  const run = await runScript({
    script: WORKFLOW_SCRIPT,
    args,
    agent: async (prompt) => {
      if (prompt.startsWith('VERIFY')) return { passed: true, nextState: 'A1_RUNNING', checks: [], failures: [] }
      return { stage: 'A1', bundleId: 'A1-001', version: 1, status: 'draft', files: [], blocked: [], needHuman: [], next: 'ok' }
    },
  })
  assert.equal(run.value.status, 'max_actions')
  assert.match(run.value.reason, /阶段动作上限 1/)
})

await testAsync('subagentAgent carries a schema to ctx.subagents and returns structured data', async () => {
  const specs = []
  const fakeCtx = {
    subagents: {
      async startActivation(spec) {
        specs.push(spec)
        return {
          childId: 'c1',
          name: 'agent-1',
          result: Promise.resolve({ stopReason: 'completed', structured: { passed: true, nextState: 'X', checks: [], failures: [] }, output: [] }),
          async dispose() {},
        }
      },
    },
  }
  const call = subagentAgent(fakeCtx, { id: 'root', session: {} })
  const answer = await call('do a thing', { label: 'verify A1', schema: { type: 'object' } })
  assert.equal(answer.passed, true)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].provider, 'spawn')
  assert.equal(specs[0].label, 'verify A1')
  assert.equal(specs[0].outputSchema.type, 'object')
  assert.equal(specs[0].prompt[0].type, 'text')
})

await testAsync('subagentAgent maps a non-completed child to null, not an exception', async () => {
  const fakeCtx = {
    subagents: {
      async startActivation() {
        return {
          childId: 'c1', name: 'agent-1',
          result: Promise.resolve({ stopReason: 'error', output: [] }),
          async dispose() {},
        }
      },
    },
  }
  const call = subagentAgent(fakeCtx, { id: 'root', session: {} })
  assert.equal(await call('x', {}), null)
})

await testAsync('a malformed child schema answer maps to null so the script can retry', async () => {
  const fakeCtx = {
    subagents: {
      async startActivation() {
        return {
          childId: 'c1', name: 'agent-1',
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
          async dispose() {},
        }
      },
    },
  }
  const call = subagentAgent(fakeCtx, { id: 'root', session: {} })
  assert.equal(await call('x', { schema: { type: 'object' } }), null)
})

// ── 4. C 规则：正例与反例 ────────────────────────────────────────────────────

await testAsync('C rules pass on a coherent artifact set', async () => {
  const results = await runChecks({
    artifacts: baseArtifacts(),
    manifest: baseManifest(),
    baseline: { baseline: { confirmed: true } },
    existsFile: async () => true,
    mode: 'final',
  })
  const byId = Object.fromEntries(results.map(entry => [entry.id, entry]))
  for (const id of ['C01', 'C02', 'C03', 'C13', 'C14', 'C12']) {
    assert.equal(byId[id].result, 'pass', `${id} 应为 pass，实际 ${byId[id].result}：${byId[id].evidence}`)
  }
  assert.equal(byId.C04.result, 'pass', 'MEDIUM 风险不触发 C04')
})

await testAsync('C02 catches an unconfirmed inference marked confirmed', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-20'].requirement.rules[0] = {
    id: 'R-001', source: { type: 'inferred', reference: 'BLK-001' },
    confirmation_required: true, decision_status: 'confirmed',
  }
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  const c02 = results.find(entry => entry.id === 'C02')
  assert.equal(c02.result, 'fail')
  assert.match(c02.evidence, /R-001/)
})

await testAsync('C03 fails when a mandatory impact has no requirement link', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-30'].impact_analysis.impacts[0].rule_refs = []
  artifacts['ART-30'].impact_analysis.impacts[0].acceptance_refs = []
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  assert.equal(results.find(entry => entry.id === 'C03').result, 'fail')
})

await testAsync('C04 fails until G2 approves a HIGH risk', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-30'].impact_analysis.impacts[0].risk = 'HIGH'
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  assert.equal(results.find(entry => entry.id === 'C04').result, 'fail')
})

await testAsync('C14 fails when the snapshot is missing', async () => {
  const results = await runChecks({
    artifacts: baseArtifacts(), manifest: baseManifest(), mode: 'final',
    existsFile: async path => path !== '01-source/raw.md',
  })
  const c14 = results.find(entry => entry.id === 'C14')
  assert.equal(c14.result, 'fail')
  assert.match(c14.evidence, /快照不存在/)
})

await testAsync('C17 fails on a coverage row that cannot be recomputed', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-43'] = { design_coverage: { rows: [{ ref_id: 'R-404', design_id: 'DESIGN-999', section: '9.9', status: 'Covered' }] } }
  artifacts['ART-40'] = { technical_design: { designs: [{ id: 'DESIGN-001', impact_refs: ['IMPACT-001'] }], file_changes: [], migration: { required: false, reason: '无' }, compatibility: { required: false }, observability: {}, rollback: {} } }
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  const c17 = results.find(entry => entry.id === 'C17')
  assert.equal(c17.result, 'fail')
  assert.match(c17.evidence, /R-404 在上游不存在/)
})

await testAsync('C18 checks the three named fields, not file bytes', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-20'].artifact.source_hash = 'deadbeef'
  const results = await runChecks({
    artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true,
    markdown: { 'ART-21': '> Artifact: A2-001:v2\n> Source-Hash: deadbeef\n' },
  })
  const c18 = results.find(entry => entry.id === 'C18')
  assert.equal(c18.result, 'fail', 'source_hash 必须等于内容哈希')
})

await testAsync('C20 fails a migration without a rollback', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-40'] = {
    technical_design: {
      designs: [{ id: 'DESIGN-001', impact_refs: ['IMPACT-001'] }],
      file_changes: [{ path: 'a.java', impact_refs: ['IMPACT-001'], design_refs: ['DESIGN-001'] }],
      migration: { required: true, reason: 'add column', steps: ['ALTER TABLE t ADD COLUMN c'], order: '先 DDL', rollback: '' },
      compatibility: { required: false }, observability: {}, rollback: { data_rollback: '' },
    },
  }
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  const c20 = results.find(entry => entry.id === 'C20')
  assert.equal(c20.result, 'fail')
  assert.match(c20.evidence, /migration.rollback 为空/)
})

await testAsync('C20 demands a signature for an irreversible DDL', async () => {
  const artifacts = baseArtifacts()
  artifacts['ART-40'] = {
    technical_design: {
      designs: [{ id: 'DESIGN-001', impact_refs: ['IMPACT-001'] }],
      file_changes: [{ path: 'a.java', impact_refs: ['IMPACT-001'], design_refs: ['DESIGN-001'] }],
      migration: { required: true, reason: 'drop', steps: ['DROP TABLE legacy_refund'], order: '维护窗口', rollback: '（不可恢复，需备份）' },
      compatibility: { required: false }, observability: {}, rollback: { data_rollback: '从备份恢复' },
    },
  }
  const results = await runChecks({ artifacts, manifest: baseManifest(), mode: 'final', existsFile: async () => true })
  const c20 = results.find(entry => entry.id === 'C20')
  assert.equal(c20.result, 'fail')
  assert.match(c20.evidence, /risk_acceptance/)
})

// ── 5. 收尾 ──────────────────────────────────────────────────────────────────

await rm(tempRoot, { recursive: true, force: true })

const failed = results.filter(entry => !entry.ok)
for (const entry of results) {
  const mark = entry.ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${entry.name}`)
  if (!entry.ok) console.log(`      ${entry.error?.message ?? entry.error}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
