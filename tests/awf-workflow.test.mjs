// awf.js 编排脚本自测：不调用任何子代理，用 stub 验证格式约束、状态路由与停点行为。
//
// 运行：node tests/awf-workflow.test.mjs
//
// 为什么需要这个测试：`.claude/workflows/awf.js` 里的顶层 `return`、全局 agent()/log()/phase()
// 都只在 Workflow 运行时存在，普通 node 无法直接执行。这里用 AsyncFunction 包一层，
// 把这些全局替换成 stub，就能在本地验证「脚本能不能被解析、路由表是否自洽、停点是否按预期返回」。

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const scriptPath = path.join(repoRoot, '.claude/workflows/awf.js')
const rulesPath = path.join(repoRoot, '.claude/skills/etp-awf-workflow/references/orchestration-rules.md')

const src = fs.readFileSync(scriptPath, 'utf8')

// ── 1. 拆出 meta 与脚本正文 ─────────────────────────────────────────────────

const metaMatch = src.match(/^export const meta = (\{[\s\S]*?\n\})\n/)
assert.ok(metaMatch, '脚本必须以 `export const meta = {...}` 作为第一条语句开头')
const metaLiteral = metaMatch[1]
const body = src.slice(metaMatch[0].length)
assert.ok(body.trim().length > 0, 'meta 之后必须有脚本正文')

// meta 必须是纯字面量：能被求值成对象，且不含函数/引用
const meta = new Function(`return (${metaLiteral})`)()
assert.equal(typeof meta.name, 'string', 'meta.name 必填')
assert.equal(typeof meta.description, 'string', 'meta.description 必填')

// 确定性约束：脚本不得使用 Date.now()/Math.random()/new Date()
for (const banned of ['Date.now', 'Math.random', 'new Date']) {
  assert.ok(!src.includes(banned), `脚本不得使用 ${banned}（破坏 resume 的确定性）`)
}
// 脚本环境无 fs / Node API
for (const banned of ['require(', 'from "node:', "from 'node:", 'process.env', 'import ']) {
  assert.ok(!src.includes(banned), `脚本不得使用 ${banned}（workflow 环境无 Node API）`)
}
// 不许 TS 语法
assert.ok(!/^\s*(interface|type)\s+\w+/m.test(body), '脚本必须是纯 JavaScript，不能出现 TS 类型声明')

// ── 2. 静态一致性：phase 标题、agentType、C 检查项 ──────────────────────────

const phaseTitles = (meta.phases || []).map((p) => p.title)
assert.ok(phaseTitles.length > 0, 'meta.phases 不能为空')

// 所有 phase()/opts.phase 用到的标题都必须在 meta.phases 里（标题必须完全一致）
const usedPhases = new Set()
for (const m of body.matchAll(/^\s*phase:\s*'([^']+)'/gm)) usedPhases.add(m[1])
for (const t of usedPhases) {
  assert.ok(phaseTitles.includes(t), `脚本使用了未在 meta.phases 声明的阶段标题：${t}`)
}

// 每个阶段派发的 agentType 必须在 .claude/agents/ 下存在
const agentTypes = new Set()
for (const m of body.matchAll(/agentType:\s*'([^']+)'/g)) agentTypes.add(m[1])
assert.ok(agentTypes.size >= 6, `至少应派发 6 类代理（A0 控制器 + A1–A5），实际 ${agentTypes.size}`)
for (const t of agentTypes) {
  const f = path.join(repoRoot, '.claude/agents', `${t}.md`)
  assert.ok(fs.existsSync(f), `agentType「${t}」没有对应的 .claude/agents/${t}.md`)
  const fm = fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/)
  assert.ok(fm, `${t}.md 缺少 frontmatter`)
  assert.ok(new RegExp(`^name:\\s*${t}$`, 'm').test(fm[1]), `${t}.md 的 frontmatter name 必须等于文件名`)
}

// 14 个状态必须全部出现在 ROUTE 表里
const STATES = [
  'CREATED', 'BASELINE_CONFIRMED', 'A1_RUNNING', 'A2_RUNNING', 'WAITING_G1',
  'A3_RUNNING', 'WAITING_G2', 'A4_RUNNING', 'A5_RUNNING', 'DESIGN_REVISION',
  'WAITING_DEPENDENCY', 'WAITING_G3', 'COMPLETED', 'BLOCKED',
]
for (const s of STATES) {
  assert.ok(new RegExp(`^\\s{2}${s}:`, 'm').test(body), `ROUTE 表缺少状态 ${s}`)
}
// 状态清单必须与 state-machine.md 一致
const stateMachine = fs.readFileSync(
  path.join(repoRoot, '.claude/skills/etp-awf-workflow/references/state-machine.md'), 'utf8')
for (const s of STATES) {
  assert.ok(stateMachine.includes(`\`${s}\``), `state-machine.md 缺少状态 ${s}`)
}

// 五个阶段与其 C 检查项必须与 orchestration-rules.md §2.4 一致
const rules = fs.readFileSync(rulesPath, 'utf8')
const EXPECT_CHECKS = {
  A1: ['C13', 'C14'],
  A2: ['C01', 'C02'],
  A3: ['C03', 'C04'],
  A4: ['C05', 'C06', 'C07', 'C11', 'C15'],
  A5: ['C08', 'C09', 'C12', 'C15'],
}
for (const [stage, checks] of Object.entries(EXPECT_CHECKS)) {
  const m = body.match(new RegExp(`\\n  ${stage}: \\{[\\s\\S]*?checks: \\[([^\\]]+)\\]`))
  assert.ok(m, `STAGES.${stage} 缺少 checks`)
  const got = m[1].match(/C\d+/g)
  assert.deepEqual(got, checks, `STAGES.${stage}.checks 与规则不一致：${got} ≠ ${checks}`)
  const ruleLine = rules.match(new RegExp(`- ${stage} → ([^\\n]+)`))
  assert.ok(ruleLine, `orchestration-rules.md §2.4 缺少 ${stage} 的 C 检查项`)
  assert.deepEqual(ruleLine[1].match(/C\d+/g), checks, `orchestration-rules.md §2.4 中 ${stage} 的 C 检查项不一致`)
}

// ── 3. 用 stub 执行脚本 ────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflow = new AsyncFunction('args', 'agent', 'log', 'phase', 'budget', body)

async function run(args, script, opts = {}) {
  const calls = []
  const logs = []
  const phases = []
  const agentImpl = async (prompt, options = {}) => {
    calls.push({ label: options.label, agentType: options.agentType, phase: options.phase, prompt })
    const next = script.shift()
    if (next === undefined) throw new Error(`未预设的 agent 调用：${options.label}`)
    if (typeof next === 'function') return next(prompt)
    return next
  }
  const budget = opts.budget || { total: null, spent: () => 0, remaining: () => Infinity }
  const result = await workflow(args, agentImpl, (m) => logs.push(m), (t) => phases.push(t), budget)
  return { result, calls, logs, phases, leftover: script }
}

const PREFLIGHT = (state, extra = {}) => ({
  repoRoot: '/repo',
  usId: 'US-2026-001',
  mode: 'final',
  state,
  nextStage: 'A1',
  artifacts: [],
  baseline: { repository: 'etp@abc123', knowledgeGraph: 'none', documentation: 'v1', skills: 'v1' },
  stop: { stop: false, reason: '' },
  ...extra,
})

const STAGE_OK = (stage, extra = {}) => ({
  stage,
  bundleId: `${stage}-001`,
  version: 1,
  status: 'final',
  files: [{ path: `${stage}/x.yaml` }],
  counts: { summary: 'ok' },
  blocked: [],
  needHuman: [],
  next: 'next',
  ...extra,
})

const VERIFY_OK = (stateAfter, checks = []) => ({
  passed: true,
  stateAfter,
  checks,
  failures: [],
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ── 3.1 入参与模式 ──────────────────────────────────────────────────────────

test('缺少 usId 直接报错，不派发任何代理', async () => {
  const { result, calls } = await run({}, [])
  assert.equal(result.status, 'error')
  assert.match(result.error, /usId/)
  assert.equal(calls.length, 0)
})

test('dryRun 只做 Preflight，不改状态', async () => {
  const { result, calls } = await run({ usId: 'US-2026-001', dryRun: true }, [PREFLIGHT('A3_RUNNING')])
  assert.equal(result.status, 'stopped')
  assert.equal(result.state, 'A3_RUNNING')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agentType, 'etp-awf-controller')
})

test('未知状态报错并列出合法状态', async () => {
  const { result } = await run({ usId: 'US-2026-001' }, [PREFLIGHT('WHATEVER')])
  assert.equal(result.status, 'error')
  assert.ok(result.detail.allowed.includes('WAITING_G1'))
})

test('forceStage 与 manifest 状态不一致时拒绝执行', async () => {
  const { result, calls } = await run({ usId: 'US-2026-001', forceStage: 'A4' }, [PREFLIGHT('BASELINE_CONFIRMED')])
  assert.equal(result.status, 'error')
  assert.match(result.error, /forceStage=A4/)
  assert.equal(calls.length, 1, '不应派发阶段代理')
})

// ── 3.2 停点 ────────────────────────────────────────────────────────────────

test('CREATED 是停点，指向 /etp-awf-start', async () => {
  const { result } = await run({ usId: 'US-2026-001' }, [PREFLIGHT('CREATED')])
  assert.equal(result.status, 'stopped')
  assert.match(result.next, /\/etp-awf-start/)
})

test('WAITING_G1/G2/G3 都停点并给出门禁命令', async () => {
  for (const [state, gate] of [['WAITING_G1', 'G1'], ['WAITING_G2', 'G2'], ['WAITING_G3', 'G3']]) {
    const { result } = await run({ usId: 'US-2026-001' }, [PREFLIGHT(state)])
    assert.equal(result.status, 'stopped')
    assert.equal(result.gate, gate)
    assert.equal(result.next, `/etp-awf-gate ${gate}`)
  }
})

test('COMPLETED / BLOCKED / WAITING_DEPENDENCY 停点且不再派发', async () => {
  for (const state of ['COMPLETED', 'BLOCKED', 'WAITING_DEPENDENCY']) {
    const { result, calls } = await run({ usId: 'US-2026-001' }, [PREFLIGHT(state)])
    assert.equal(result.status, 'stopped')
    assert.equal(result.state, state)
    assert.equal(calls.length, 1)
  }
})

// ── 3.3 正常推进 ────────────────────────────────────────────────────────────

test('final 模式：A1 → A2 → 停在 G1', async () => {
  const script = [
    PREFLIGHT('BASELINE_CONFIRMED'),
    STAGE_OK('A1'), VERIFY_OK('A2_RUNNING', [{ id: 'C13', result: 'pass' }]),
    STAGE_OK('A2'), VERIFY_OK('WAITING_G1', [{ id: 'C01', result: 'pass' }]),
  ]
  const { result, calls, leftover } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(leftover.length, 0, '脚本用光了预设响应')
  assert.equal(result.status, 'stopped')
  assert.equal(result.gate, 'G1')
  assert.equal(result.lastStage.stage, 'A2')
  const order = calls.map((c) => c.label)
  assert.deepEqual(order, ['preflight', 'a1 etp-requirement-collector', 'verify A1', 'a2 etp-requirement-analyst', 'verify A2'])
  assert.deepEqual(calls.map((c) => c.agentType), [
    'etp-awf-controller', 'etp-requirement-collector', 'etp-awf-controller',
    'etp-requirement-analyst', 'etp-awf-controller',
  ])
  assert.equal(result.actions, 2)
})

test('draft 模式：A2/A3 通过后不经过 G1/G2，直到 G3 才停', async () => {
  const script = [
    PREFLIGHT('A2_RUNNING'),
    STAGE_OK('A2'), VERIFY_OK('A3_RUNNING'),
    STAGE_OK('A3'), VERIFY_OK('A4_RUNNING'),
    STAGE_OK('A4'), VERIFY_OK('A5_RUNNING'),
    STAGE_OK('A5', { conclusion: 'PASS' }), VERIFY_OK('WAITING_G3'),
  ]
  const { result, calls, leftover } = await run({ usId: 'US-2026-001', mode: 'draft' }, script)
  assert.equal(leftover.length, 0)
  assert.equal(result.status, 'stopped')
  assert.equal(result.gate, 'G3', 'draft 模式应跳过 G1/G2，只停在 G3')
  assert.equal(result.mode, 'draft')
  const stages = calls.map((c) => c.label)
  assert.deepEqual(stages, [
    'preflight',
    'a2 etp-requirement-analyst', 'verify A2',
    'a3 etp-impact-analyst', 'verify A3',
    'a4 etp-technical-designer', 'verify A4',
    'a5 etp-design-reviewer', 'verify A5',
  ])
})

test('maxActions 达到上限时返回 max_actions 停点', async () => {
  const script = [
    PREFLIGHT('BASELINE_CONFIRMED'),
    STAGE_OK('A1'), VERIFY_OK('A2_RUNNING'),
    STAGE_OK('A2'), VERIFY_OK('WAITING_G1'),
  ]
  const { result } = await run({ usId: 'US-2026-001', maxActions: 1 }, script)
  assert.equal(result.status, 'max_actions')
  assert.equal(result.state, 'A2_RUNNING')
  assert.equal(result.actions, 1)
})

test('token 预算不足时主动停下，不改状态', async () => {
  const budget = { total: 100000, spent: () => 60000, remaining: () => 40000 }
  const { result, calls } = await run({ usId: 'US-2026-001' }, [PREFLIGHT('A1_RUNNING')], { budget })
  assert.equal(result.status, 'max_actions')
  assert.equal(result.state, 'A1_RUNNING')
  assert.match(result.reason, /预算/)
  assert.equal(calls.length, 1)
})

// ── 3.4 失败与重试 ──────────────────────────────────────────────────────────

test('阶段校验连续两次失败 → BLOCKED', async () => {
  const script = [
    PREFLIGHT('A1_RUNNING'),
    STAGE_OK('A1'), { passed: false, stateAfter: 'A1_RUNNING', checks: [], failures: ['字段缺失'] },
    STAGE_OK('A1'), { passed: false, stateAfter: 'A1_RUNNING', checks: [], failures: ['字段缺失'] },
  ]
  const { result, leftover } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(leftover.length, 0)
  assert.equal(result.status, 'stopped')
  assert.equal(result.state, 'BLOCKED')
})

test('第二次校验通过则继续推进', async () => {
  const script = [
    PREFLIGHT('A1_RUNNING'),
    STAGE_OK('A1'), { passed: false, stateAfter: 'A1_RUNNING', checks: [], failures: ['引用未闭合'] },
    STAGE_OK('A1', { version: 2 }), VERIFY_OK('A2_RUNNING'),
    STAGE_OK('A2'), VERIFY_OK('WAITING_G1'),
  ]
  const { result, leftover } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(leftover.length, 0)
  assert.equal(result.gate, 'G1')
  assert.equal(result.lastStage.stage, 'A2')
})

test('子代理返回 null 两次 → 报错停止，不按成功推进', async () => {
  const { result } = await run({ usId: 'US-2026-001' }, [PREFLIGHT('A1_RUNNING'), null, null])
  assert.equal(result.status, 'error')
  assert.match(result.error, /A1/)
})

test('Preflight 返回 null → 直接报错', async () => {
  const { result } = await run({ usId: 'US-2026-001' }, [null])
  assert.equal(result.status, 'error')
  assert.match(result.error, /Preflight/)
})

test('A0 控制面返回非法状态时报错', async () => {
  const script = [PREFLIGHT('A1_RUNNING'), STAGE_OK('A1'), VERIFY_OK('NOT_A_STATE')]
  const { result } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(result.status, 'error')
  assert.match(result.error, /非法状态|未知状态/)
})

// ── 3.5 评审回流 ────────────────────────────────────────────────────────────

test('A5 FAIL → DESIGN_REVISION → 定向回派 A3 → 重跑 A5', async () => {
  const script = [
    PREFLIGHT('A5_RUNNING'),
    STAGE_OK('A5', { conclusion: 'FAIL' }), VERIFY_OK('DESIGN_REVISION'),
    { targetAgent: 'A3', round: 1, issues: ['IMPACT-007 缺运行时证据'], invalidated: ['A3-001'], stop: false },
    STAGE_OK('A3', { version: 2 }), VERIFY_OK('A5_RUNNING'),
    STAGE_OK('A5', { version: 2, conclusion: 'PASS' }), VERIFY_OK('WAITING_G3'),
  ]
  const { result, calls, leftover } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(leftover.length, 0)
  assert.equal(result.gate, 'G3')
  const labels = calls.map((c) => c.label)
  assert.ok(labels.includes('a3 etp-impact-analyst'), '必须回派 A3')
  assert.equal(labels.filter((l) => l === 'a5 etp-design-reviewer').length, 2, 'A5 必须重跑')
  // 修订指令必须进 prompt
  const a3Call = calls.find((c) => c.label === 'a3 etp-impact-analyst')
  assert.match(a3Call.prompt, /IMPACT-007/)
  assert.match(a3Call.prompt, /本轮修订指令/)
})

test('回流轮次超过两轮 → DISPUTE 并 BLOCKED，不再派发', async () => {
  const script = [
    PREFLIGHT('DESIGN_REVISION'),
    { targetAgent: 'A4', round: 3, issues: ['DESIGN-003'], invalidated: [], stop: true, stopReason: '超过两轮' },
  ]
  const { result, calls } = await run({ usId: 'US-2026-001' }, script)
  assert.equal(result.status, 'stopped')
  assert.equal(result.state, 'BLOCKED')
  assert.equal(calls.length, 2, '不应再派发阶段代理')
})

// ── 3.6 prompt 装配 ─────────────────────────────────────────────────────────

test('阶段 prompt 含必读、基线、约束与输出目录', async () => {
  const script = [
    PREFLIGHT('BASELINE_CONFIRMED'),
    STAGE_OK('A1'), VERIFY_OK('A2_RUNNING'),
    STAGE_OK('A2'), VERIFY_OK('WAITING_G1'),
  ]
  const { calls } = await run({ usId: 'US-2026-001', usRef: 'https://us/1' }, script)
  const a1 = calls.find((c) => c.label === 'a1 etp-requirement-collector').prompt
  for (const must of [
    '/repo', 'docs/awf/US-2026-001/01-source/',
    'etp-awf-workflow/SKILL.md', 'orchestration-rules.md', 'artifact-protocol.md',
    'etp-requirement-fetch/SKILL.md', 'https://us/1',
    'repository: etp@abc123', 'evidence_gap', 'not_applicable',
  ]) {
    assert.ok(a1.includes(must), `A1 prompt 缺少「${must}」`)
  }
  const a2 = calls.find((c) => c.label === 'a2 etp-requirement-analyst').prompt
  assert.ok(a2.includes('docs/awf/US-2026-001/02-requirement/'))
  assert.ok(a2.includes('C01'), 'A2 prompt 应提示适用检查项所在文件')
  const ctrl = calls.find((c) => c.label === 'verify A1').prompt
  for (const must of ['校验六步', 'C13', 'C14', 'sha256', 'workflow-report.md']) {
    assert.ok(ctrl.includes(must), `校验 prompt 缺少「${must}」`)
  }
})

// ── 4. 运行 ────────────────────────────────────────────────────────────────

let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log(`  ✓ ${t.name}`)
  } catch (e) {
    failed += 1
    console.log(`  ✗ ${t.name}`)
    console.log(`    ${e.message.split('\n').join('\n    ')}`)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exit(1)
