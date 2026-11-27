/**
 * 决策层的执行载体：在插件进程内用 `node:vm` 跑 `WORKFLOW_SCRIPT`，并把
 * `agent()` 绑定到 `ctx.subagents`。
 *
 * 为什么不用 `ctx.workflowEngine`：本 profile 把 `@deepseek-ai/dsh-workflow-ptc`
 * 放在 agent 预设的 `cordis:group` 里并对 `workflowEngine` 做了 `isolate: true`
 * （`dsh --profile web --dump-config` 可见），根作用域的插件拿不到它——硬注入会
 * 让插件永远 pending。而 `ctx.subagents` 在根作用域，`spawn` provider 也支持
 * `outputSchema`，所以这里直接驱动子代理，DS-V5 §2.3 的三层划分仍然成立：
 *
 *   - 决策层：`WORKFLOW_SCRIPT` 里的纯路由逻辑，跑在受限 vm 里，没有 fs；
 *   - 执行层：`agent()` 拉起的子代理，产物与校验由它们做；
 *   - 门禁层：插件写 approvals，人给结论。
 *
 * vm 里只注入 `agent`/`phase`/`log`/`args` 四个全局，与 DSH 引擎的脚本契约一致，
 * 因此 `WORKFLOW_SCRIPT` 无需改动即可复用。
 */

import vm from 'node:vm'

/** 把子代理返回的 content blocks 压成纯文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block !== null && typeof block === 'object' && block.type === 'text').map(block => block.text).join('')
}

/**
 * 在 vm 里执行一段 AWF 脚本。
 *
 * @param {object} options
 * @param {string} options.script 脚本体（`WORKFLOW_SCRIPT`）
 * @param {object} options.args 传给脚本的 `args` 全局
 * @param {(prompt: string, opts: object) => Promise<any>} options.agent 派发一个子代理
 * @param {(title: string) => void} [options.onPhase]
 * @param {(message: string) => void} [options.onLog]
 * @param {number} [options.timeoutMs] 同步切片上限
 * @returns {Promise<{value: any, error: string|null, agentsStarted: number}>}
 */
export async function runScript(options) {
  const { script, args } = options
  let agentsStarted = 0
  const trail = []
  const onLog = options.onLog ?? (() => {})
  const onPhase = options.onPhase ?? (() => {})

  const agentHook = async (prompt, opts) => {
    if (typeof prompt !== 'string' || prompt === '') throw new Error('agent() 需要非空 prompt')
    const callOptions = opts === null || opts === undefined ? {} : opts
    agentsStarted += 1
    const answer = await options.agent(prompt, callOptions)
    return answer
  }

  const globals = {
    agent: agentHook,
    phase: title => {
      if (typeof title !== 'string' || title === '') throw new Error('phase() 需要非空标题')
      trail.push({ at: 'phase', title })
      onPhase(title)
    },
    log: message => {
      if (typeof message !== 'string') throw new Error('log() 需要字符串')
      trail.push({ at: 'log', message })
      onLog(message)
    },
    args,
  }

  const context = vm.createContext({ ...globals })
  let compiled
  try {
    compiled = new vm.Script(`(async () => {\n${script}\n})()`, { filename: 'workflow:awf', lineOffset: -1 })
  } catch (error) {
    return { value: null, error: `脚本解析失败：${String(error.message ?? error)}`, agentsStarted }
  }

  let value
  try {
    const pending = compiled.runInContext(context, { timeout: options.timeoutMs ?? 5000 })
    value = await Promise.resolve(pending)
  } catch (error) {
    return { value: null, error: `脚本执行失败：${String(error?.message ?? error)}`, agentsStarted }
  }
  // 结果必须能跨过 vm 边界：脚本只返回普通对象。
  return { value, error: null, agentsStarted }
}

/**
 * 把 `ctx.subagents.startActivation` 包成脚本契约里的 `agent()`：
 * 传入 object-rooted schema 时返回结构化对象，否则返回文本。
 *
 * DS-V5 K5：子代理返回空按「未产出」处理，由脚本决定重试或 BLOCKED，
 * 所以这里在 `stopReason !== 'completed'` 或结构化结果缺失时返回 `null`。
 */
export function subagentAgent(ctx, parentAgent, options = {}) {
  const provider = options.provider ?? 'spawn'
  const signal = options.signal ?? new AbortController().signal
  const cwd = options.cwd
  return async (prompt, opts) => {
    const spec = {
      provider,
      label: typeof opts.label === 'string' && opts.label !== '' ? opts.label : 'awf',
      prompt: [{ type: 'text', text: prompt }],
      parent: parentAgent,
      signal,
      delivery: 'caller',
      ...(cwd === undefined ? {} : { cwd }),
      ...(opts.schema === undefined ? {} : { outputSchema: opts.schema }),
    }
    let activation
    try {
      activation = await ctx.subagents.startActivation(spec)
    } catch (error) {
      // 启动失败不是一个可重试的空结果，交给脚本当作 null 并在两次后 BLOCKED。
      return null
    }
    try {
      const result = await activation.result
      if (result.stopReason !== 'completed') return null
      if (opts.schema !== undefined) {
        if (result.structured === undefined) return null
        return result.structured
      }
      const text = textOf(result.output)
      return text === '' ? null : text
    } finally {
      try {
        await activation.dispose()
      } catch {
        // 释放失败不覆盖已取得的结论。
      }
    }
  }
}
