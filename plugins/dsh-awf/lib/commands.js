/**
 * 六条人工命令：`/etp-awf-start`、`/etp-awf-run`、`/etp-awf-status`、
 * `/etp-awf-gate`、`/etp-awf-rerun`、`/etp-awf-review`。
 *
 * 命令与工具共用 `lib/a0.js`，所以两条入口的语义只有一份实现。命令比工具多
 * 做的两件事：门禁必须由人回答（无参数时只打印预览与提问），以及重跑/复核
 * 这类只改本地状态的动作用的是命令而不是模型工具。
 */

import {
  startWorkflow,
  runDispatch,
  renderStatus,
  evaluate,
  recordGate,
  gatePreview,
  rerunWorkflow,
  forceReview,
  renderDispatchResult,
} from './a0.js'
import { GATES, RERUN_CLASSES } from './constants.js'

const GATE_IDS = Object.keys(GATES)
const RERUN_IDS = Object.keys(RERUN_CLASSES)

/** Split a command line into positional words and `--flag value` pairs. */
export function parseArgs(rawInput) {
  const words = []
  const flags = {}
  const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter(token => token !== '')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = tokens[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
        continue
      }
      flags[name] = next
      index += 1
      continue
    }
    words.push(token)
  }
  return { words, flags }
}

/** Render a status body with a one-line headline first. */
async function statusBody(store, usId) {
  const { context, results } = await evaluate(store, usId)
  return renderStatus(usId, context, results)
}

/** Build the six command definitions. */
export function buildCommands(deps) {
  const ok = (text) => ({ kind: 'success', text })
  const fail = (text) => ({ kind: 'error', text })

  return [
    {
      name: 'etp-awf-start',
      description: '登记 AWF 分析基线与产物目录（基线四项由人提供，插件不自行建立基线）',
      input: { hint: '<US-ID> --repo <branch@commit> --graph <version@commit> --docs <version> --skills <version> [--us-ref <链接>] [--mode final|draft] [--by <姓名>]' },
      async handler(invocation) {
        const { words, flags } = parseArgs(invocation.rawInput)
        const usId = words[0]
        if (usId === undefined) return fail('用法：/etp-awf-start <US-ID> --repo <branch@commit> --graph <version@commit> --docs <version> --skills <version>')
        const store = await deps.getStore(invocation.agent)
        try {
          const result = await startWorkflow(store, {
            usId,
            usRef: flags['us-ref'],
            mode: flags.mode === 'draft' ? 'draft' : 'final',
            providedBy: flags.by,
            baseline: {
              repository: labelOf(flags.repo),
              knowledge_graph: labelOf(flags.graph),
              documentation: labelOf(flags.docs),
              skills: labelOf(flags.skills),
            },
          })
          return ok([
            `已创建 ${result.dir}`,
            `基线 ${result.baselineId} | 模式 ${result.mode} | 状态 ${result.state}`,
            `下一步：${result.next}`,
          ].join('\n'))
        } catch (error) {
          return fail(renderError(error))
        }
      },
    },
    {
      name: 'etp-awf-run',
      description: '按状态机推进一轮 AWF：派发阶段子代理并在人工门禁或阻断处停下',
      input: { hint: '[US-ID] [--max-actions 8] [--dry-run] [--mode draft|final]' },
      async handler(invocation) {
        const { words, flags } = parseArgs(invocation.rawInput)
        const store = await deps.getStore(invocation.agent)
        const usId = words[0] ?? (await resolveSingleUs(store))
        if (usId === undefined) return fail('未指定 US，且 docs/awf/ 下有多个 US）：请写 /etp-awf-run <US-ID>')
        if (invocation.agent === undefined) return fail('本命令需要在会话内执行')
        try {
          const result = await runDispatch(
            deps.dispatch(store, invocation.agent, usId, invocation.signal),
            {
              maxActions: flags['max-actions'] === undefined ? undefined : Number(flags['max-actions']),
              dryRun: flags['dry-run'] === true,
              mode: flags.mode,
            },
          )
          return ok(renderDispatchResult(result))
        } catch (error) {
          return fail(renderError(error))
        }
      },
    },
    {
      name: 'etp-awf-status',
      description: '只读查看 AWF 状态：产物版本、门禁、C 规则、失效与下一步',
      input: { hint: '[US-ID]' },
      async handler(invocation) {
        const { words } = parseArgs(invocation.rawInput)
        const store = await deps.getStore(invocation.agent)
        const usIds = await store.listUs()
        if (words.length === 0) {
          if (usIds.length === 0) return ok('docs/awf/ 下没有任何 US：先 /etp-awf-start')
          return ok((await Promise.all(usIds.map(id => statusBody(store, id)))).join('\n\n'))
        }
        const usId = words[0]
        if (!(await store.isInitialized(usId))) {
          return fail(`US ${usId} 尚未初始化：先 /etp-awf-start ${usId}`)
        }
        return ok(await statusBody(store, usId))
      },
    },
    {
      name: 'etp-awf-gate',
      description: '人工门禁 G1/G2/G3：预览阻断项，或在人明确回答后记录结论',
      input: { hint: '<G1|G2|G3> [US-ID] [--decision APPROVED|PARTIALLY_APPROVED|REJECTED] --approver <姓名> [--notes <说明>] [--rejected-to A1|A2|A3|A4] [--accept-gaps IMPACT-011,...]' },
      async handler(invocation) {
        const { words, flags } = parseArgs(invocation.rawInput)
        const gate = String(words[0] ?? '').toUpperCase()
        if (!GATE_IDS.includes(gate)) return fail(`用法：/etp-awf-gate ${GATE_IDS.join('|')} [US-ID]`)
        const store = await deps.getStore(invocation.agent)
        const usId = words[1] ?? (await resolveSingleUs(store))
        if (usId === undefined) return fail('未指定 US，且 docs/awf/ 下有多个 US：请写 /etp-awf-gate ' + gate + ' <US-ID>')
        try {
          if (flags.decision === undefined) {
            const preview = await gatePreview(store, usId, gate)
            return ok(`${preview.text}\n\n请人明确回答：结论（APPROVED / PARTIALLY_APPROVED / REJECTED）、审批人真实姓名、说明。未回答前不会写入任何审批记录。`)
          }
          const decision = String(flags.decision).toUpperCase()
          const acceptedGaps = typeof flags['accept-gaps'] === 'string' ? flags['accept-gaps'].split(',').map(item => item.trim()).filter(Boolean) : []
          const result = await recordGate(store, {
            usId,
            gate,
            decision,
            approver: flags.approver,
            notes: flags.notes,
            acceptedGaps,
            rejectedTo: flags['rejected-to'],
          })
          return ok([
            `${gate} 已记录：${result.decision}（审批人 ${result.approver}）`,
            `状态：${result.state}`,
            `检查项：${result.checks.map(entry => `${entry.id}:${entry.result}`).join(' ') || '（无）'}`,
            `下一步：${result.next}`,
          ].join('\n'))
        } catch (error) {
          return fail(renderError(error))
        }
      },
    },
    {
      name: 'etp-awf-rerun',
      description: '按 12 类变化标记产物失效、重置门禁，并迁回最早受影响阶段',
      input: { hint: '<变化类型> [US-ID]；类型见 /etp-awf-status 的 RERUN 列表' },
      async handler(invocation) {
        const { words } = parseArgs(invocation.rawInput)
        const changeClass = words[0]
        if (!RERUN_IDS.includes(changeClass)) {
          return fail([
            '用法：/etp-awf-rerun <类型> [US-ID]',
            '可用类型（DS-V5 §12.6 的 12 类）：',
            ...RERUN_IDS.map(id => `- ${id}：${RERUN_CLASSES[id].label}`),
          ].join('\n'))
        }
        const store = await deps.getStore(invocation.agent)
        const usId = words[1] ?? (await resolveSingleUs(store))
        if (usId === undefined) return fail('未指定 US，且 docs/awf/ 下有多个 US：请写 /etp-awf-rerun ' + changeClass + ' <US-ID>')
        try {
          const result = await rerunWorkflow(store, { usId, changeClass })
          return ok([
            `检测到变化：${result.label}`,
            `失效：${result.invalidated.map(stage => `${stage}-001`).join(', ') || '（无）'}`,
            `重置门禁：${result.resetGates.join(', ') || '（无）'}`,
            `当前状态：${result.state}`,
            `下一步：${result.next}`,
          ].join('\n'))
        } catch (error) {
          return fail(renderError(error))
        }
      },
    },
    {
      name: 'etp-awf-review',
      description: '强制重新执行 A5 独立评审（不复用上一轮结论）',
      input: { hint: '[US-ID]' },
      async handler(invocation) {
        const { words } = parseArgs(invocation.rawInput)
        const store = await deps.getStore(invocation.agent)
        const usId = words[0] ?? (await resolveSingleUs(store))
        if (usId === undefined) return fail('未指定 US，且 docs/awf/ 下有多个 US：请写 /etp-awf-review <US-ID>')
        try {
          const result = await forceReview(store, { usId })
          return ok([
            '已把状态置为 A5_RUNNING，上一轮评审已归档',
            `归档目录：${result.archive}`,
            '下一步：/etp-awf-run（会派发 etp-design-reviewer 重新独立检索）',
          ].join('\n'))
        } catch (error) {
          return fail(renderError(error))
        }
      },
    },
  ]
}

/** One US in the workspace → use it; several → ask. */
async function resolveSingleUs(store) {
  const ids = await store.listUs()
  return ids.length === 1 ? ids[0] : undefined
}

/** `release/10.x@8f3a9c2` style label → the protocol's object shape. */
export function labelOf(text) {
  const value = String(text ?? '').trim()
  if (value === '') return {}
  const atIndex = value.lastIndexOf('@')
  if (atIndex > 0) {
    const left = value.slice(0, atIndex).trim()
    const right = value.slice(atIndex + 1).trim()
    return { name: left, branch: left, commit: right, version: value }
  }
  return { version: value }
}

/** Error text without a stack. */
function renderError(error) {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const code = 'code' in error ? `${error.code} ` : ''
    return `${code}${String(error.message)}`
  }
  return String(error)
}

/** Register the six commands on `ctx.commands`. */
export function registerCommands(ctx, deps) {
  const names = []
  for (const definition of buildCommands(deps)) {
    const dispose = ctx.commands.register({
      name: definition.name,
      description: definition.description,
      input: definition.input,
      handler: definition.handler,
    })
    ctx.effect(() => dispose, `dsh-awf: command ${definition.name}`)
    names.push(definition.name)
  }
  return names
}
