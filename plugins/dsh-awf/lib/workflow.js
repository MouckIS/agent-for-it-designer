/**
 * The A0 decision layer: the workflow script body the DSH engine executes.
 *
 * DS-V5 §2.3 splits A0 three ways, and this module is the decision layer. The
 * split is enforced by what the workflow engine can and cannot do:
 *
 *   - the script has no filesystem, no clock, no network and no `budget`
 *     (DS-V5 K1, K2) — so it cannot read a manifest or judge a field;
 *   - the host tool does Preflight and every post-run read;
 *   - a controller subagent — the execution layer — reads the artifacts,
 *     evaluates the C rules, updates the hash ledger and the manifest.
 *
 * So the script only routes: start a stage, start the verifying pass, take the
 * next state from the verifying pass, stop at a gate. Prompts and the state
 * table arrive as plain data through `args`; nothing is baked into the source,
 * which keeps the script small and reviewable.
 *
 * One DS-V5 constraint shows up in code below: §2.3 describes dispatch by
 * `agentType`, and the DSH engine rejects that option (`workflow-ptc/runtime.ts`
 * lists `agentType` in DEFERRED_AGENT_OPTIONS). The stage role therefore travels
 * inside the prompt — which K4 requires anyway, since a subagent has no memory.
 */

import { DEFAULT_MAX_ACTIONS, MAX_ACTIONS_LIMIT } from './constants.js'

/**
 * Routing logic only. `args` carries:
 *   usId, mode, workdir, state, maxActions,
 *   stopStates: {STATE: {reason, gate?}},
 *   stageOfState: {STATE: stageId},
 *   prompts: {stageId: promptText},
 *   verifyPrompts: {stageId: promptText},
 *   revisionPrompt, revisionState
 *   schemas: {stage, verify, revision} — object-rooted JSON schemas
 */
export const WORKFLOW_SCRIPT = [
  "'use strict'",
  '',
  'const US_ID = args.usId',
  'const WORKDIR = args.workdir',
  'const STOP = args.stopStates',
  'const STAGE_OF_STATE = args.stageOfState',
  'const PROMPTS = args.prompts',
  'const VERIFY_PROMPTS = args.verifyPrompts',
  'const REVISION_PROMPT = args.revisionPrompt',
  'const REVISION_STATE = args.revisionState',
  'const SCHEMAS = args.schemas',
  'const MAX_ACTIONS = typeof args.maxActions === "number" && args.maxActions > 0',
  '  ? Math.min(Math.floor(args.maxActions), 20)',
  '  : 8',
  '',
  'const trail = []',
  'const record = function (stage, phase, detail) {',
  '  trail.push({ stage: stage, phase: phase, detail: detail })',
  '  log(stage + " " + phase + "：" + detail)',
  '}',
  '',
  'let state = args.state',
  'let actions = 0',
  'let last = null',
  '',
  'const settle = function (result) {',
  '  result.trail = trail',
  '  result.actions = actions',
  '  // A branch that decided its own state (BLOCKED, max_actions) keeps it; only',
  '  // an unstamped result falls back to the loop variable.',
  '  if (result.state === undefined) result.state = state',
  '  if (last !== null) result.last = last',
  '  return result',
  '}',
  '',
  'const stopFor = function (target) {',
  '  const entry = STOP[target]',
  '  const gate = entry !== undefined && entry.gate !== undefined ? entry.gate : null',
  '  return settle({',
  '    status: "stopped",',
  '    reason: entry !== undefined ? entry.reason : target,',
  '    gate: gate,',
  '    next: gate !== null ? "/etp-awf-gate " + gate : "/etp-awf-status"',
  '  })',
  '}',
  '',
  'while (true) {',
  '  if (STOP[state] !== undefined) return stopFor(state)',
  '',
  '  if (actions >= MAX_ACTIONS) {',
  '    return settle({',
  '      status: "max_actions",',
  '      reason: "本轮已达到阶段动作上限 " + MAX_ACTIONS + "，可再次执行 /etp-awf-run 继续",',
  '      next: "/etp-awf-run"',
  '    })',
  '  }',
  '',
  '  if (state === REVISION_STATE) {',
  '    actions += 1',
  '    phase("设计回流")',
  '    const revision = await agent(REVISION_PROMPT, {',
  '      label: "read revision",',
  '      phase: "设计回流",',
  '      schema: SCHEMAS.revision',
  '    })',
  '    if (revision === null || revision === undefined) {',
  '      record("A0", "设计回流", "读取修订指令返回空")',
  '      return settle({ status: "error", reason: "修订指令读取失败：controller 未返回结构化结果" })',
  '    }',
  '    if (revision.stop === true) {',
  '      record("A0", "设计回流", "轮次 " + revision.round + " 已用尽，需人工裁决")',
  '      state = "BLOCKED"',
  '      return settle({',
  '        status: "stopped",',
  '        reason: revision.stopReason || "评审轮次用尽，见 05-review/DISPUTE.md",',
  '        gate: null,',
  '        next: "/etp-awf-status"',
  '      })',
  '    }',
  '    state = revision.targetAgent + "_RUNNING"',
  '    record("A0", "设计回流", "轮次 " + revision.round + " 定向回派 " + revision.targetAgent)',
  '    last = { stage: "A0", bundleId: revision.targetAgent + "-revision", version: revision.round, status: "revision" }',
  '    continue',
  '  }',
  '',
  '  const stage = STAGE_OF_STATE[state]',
  '  if (stage === undefined) {',
  '    return settle({ status: "error", reason: "状态 " + state + " 没有对应的可执行阶段" })',
  '  }',
  '',
  '  actions += 1',
  '  let advanced = false',
  '',
  '  for (let attempt = 1; attempt <= 2; attempt += 1) {',
  '    phase("A" + stage.slice(1) + " 阶段执行")',
  '    const stageOut = await agent(PROMPTS[stage], {',
  '      label: stage,',
  '      schema: SCHEMAS.stage',
  '    })',
  '    if (stageOut === null || stageOut === undefined) {',
  '      record(stage, "派发", "子代理返回空（第 " + attempt + " 次）")',
  '      if (attempt === 2) {',
  '        state = "BLOCKED"',
  '        return settle({',
  '          status: "stopped",',
  '          reason: stage + " 连续两次空返回：按 K5 记为未产出，不得按成功推进",',
  '          gate: null,',
  '          next: "/etp-awf-status"',
  '        })',
  '      }',
  '      continue',
  '    }',
  '    last = stageOut',
  '',
  '    phase("产物校验")',
  '    const verify = await agent(VERIFY_PROMPTS[stage], {',
  '      label: "verify " + stage,',
  '      schema: SCHEMAS.verify',
  '    })',
  '    if (verify === null || verify === undefined) {',
  '      record(stage, "产物校验", "校验代理返回空（第 " + attempt + " 次）")',
  '      continue',
  '    }',
  '',
  '    if (verify.passed === true) {',
  '      const checks = verify.checks.map(function (entry) { return entry.id + ":" + entry.result }).join(" ")',
  '      state = verify.nextState',
  '      record(stage, "产物校验", "通过，状态 → " + state + "（" + checks + "）")',
  '      advanced = true',
  '      break',
  '    }',
  '',
  '    record(stage, "产物校验", "未通过（第 " + attempt + " 次）：" + verify.failures.join("；"))',
  '    if (attempt === 2) {',
  '      state = "BLOCKED"',
  '      return settle({',
  '        status: "stopped",',
  '        reason: stage + " 两次校验未通过：" + verify.failures.join("；"),',
  '        gate: null,',
  '        next: "/etp-awf-status"',
  '      })',
  '    }',
  '  }',
  '',
  '  if (advanced === false) {',
  '    return settle({ status: "error", reason: stage + " 未产出可用结果，状态未变，可修复后重跑 /etp-awf-run" })',
  '  }',
  '}',
].join('\n')

/** The workflow identity block; the engine validates it before running. */
export const WORKFLOW_META = {
  name: 'awf',
  description:
    'AWF 技术方案设计工作流：按 14 状态机派发 A1–A5 阶段子代理，由 controller 子代理校验产物并推进状态，在人工门禁 G1/G2/G3 与阻断处停下',
  whenToUse:
    '已用 /etp-awf-start 登记基线、需要推进 US 的需求获取、需求澄清、代码影响分析、技术设计或独立评审时。请用 /etp-awf-run 触发，不要直接调用 workflow 工具。',
  phases: [
    { title: 'Preflight', detail: '读 manifest 与基线，确定本轮从哪个阶段开始' },
    { title: 'A1 阶段执行', detail: '取回 US、固化快照、过滤后端范围' },
    { title: 'A2 阶段执行', detail: '产出规则、验收标准、待确认问题与决策记录' },
    { title: 'A3 阶段执行', detail: '产出触点、证据、风险与缺口' },
    { title: 'A4 阶段执行', detail: '产出设计、ADR、覆盖矩阵与文件清单' },
    { title: 'A5 阶段执行', detail: '独立检索复核，给结论与修订指令' },
    { title: '产物校验', detail: 'controller 子代理执行六步校验与 C 规则，更新 manifest' },
    { title: '设计回流', detail: '按修订指令定向回派到 A1–A4' },
  ],
}

/**
 * Object-rooted schemas handed to `agent({schema})`. The engine enforces a strict
 * subset — `type`/`properties`/`required`/`additionalProperties`/`items`/`enum`/
 * `const`/`oneOf` plus annotations — so these are written in exactly that subset.
 */
export const STAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'bundleId', 'version', 'status', 'files', 'blocked', 'needHuman', 'next'],
  properties: {
    stage: { type: 'string', enum: ['A1', 'A2', 'A3', 'A4', 'A5'] },
    bundleId: { type: 'string' },
    version: { type: 'integer' },
    status: { type: 'string', enum: ['draft', 'final', 'STALE'] },
    files: { type: 'array', items: { type: 'string' } },
    counts: { type: 'string', description: '一行计数摘要，例如 mandatory=4 potential=8 gaps=2' },
    blocked: { type: 'array', items: { type: 'string' }, description: '每条写成「ID:原因」' },
    needHuman: { type: 'array', items: { type: 'string' } },
    conclusion: { type: 'string', enum: ['PASS', 'CONDITIONAL_PASS', 'FAIL'], description: '仅 A5 填写' },
    next: { type: 'string', description: '一句话说明下一步建议' },
  },
}

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'nextState', 'checks', 'failures'],
  properties: {
    passed: { type: 'boolean' },
    nextState: {
      type: 'string',
      description: '校验通过时状态应迁往的状态；不通过时原样写回当前状态',
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'result'],
        properties: {
          id: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'not_applicable'] },
          evidence: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    failures: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

export const REVISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetAgent', 'round', 'issues', 'stop'],
  properties: {
    targetAgent: { type: 'string', enum: ['A1', 'A2', 'A3', 'A4'] },
    round: { type: 'integer' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'problem'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          problem: { type: 'string' },
          requiredFix: { type: 'string' },
        },
      },
    },
    stop: { type: 'boolean' },
    stopReason: { type: 'string' },
  },
}

/** Clamp a caller-supplied action budget to the DS-V5 ceiling. */
export function clampMaxActions(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ACTIONS
  return Math.min(Math.floor(value), MAX_ACTIONS_LIMIT)
}
