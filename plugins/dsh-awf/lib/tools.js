/**
 * 面向模型的工具：`awf_start` / `awf_run` / `awf_status` / `awf_gate`。
 *
 * 工具与命令共用 `lib/a0.js` 的同一套函数，所以「人在命令行里做的」和「模型
 * 自己推进的」不会出现两套语义。门禁永远是人的决定：`awf_gate` 要求真实审批
 * 人姓名，阻断项未通过时拒绝写 APPROVED（DS-V5 §10.1）。
 *
 * 这里用普通对象注册工具，不 `import '@deepseek-ai/dsh-tools'`：插件从工作区
 * 目录安装，运行时按包名解析 DSH 内部包并不可靠；`ctx.tools.register` 只要求
 * `{name, description, parameters, output, execute}` 这个形状。
 */

import {
  startWorkflow,
  runDispatch,
  renderStatus,
  evaluate,
  recordGate,
  gatePreview,
  renderDispatchResult,
} from './a0.js'
import { GATES } from './constants.js'

const GATE_IDS = Object.keys(GATES)

/** Text block helper. */
const text = content => [{ type: 'text', text: content }]

/** Error text that never leaks a stack to the model. */
export function renderError(error) {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const code = 'code' in error ? `${error.code} ` : ''
    return `${code}${String(error.message)}`
  }
  return String(error)
}

/** `release/10.x@8f3a9c2` style label → the protocol's object shape. */
export function parseLabel(value) {
  const label = String(value ?? '').trim()
  if (label === '') return {}
  const at = label.lastIndexOf('@')
  if (at > 0) {
    const left = label.slice(0, at).trim()
    const right = label.slice(at + 1).trim()
    return { name: left, branch: left, commit: right, version: label }
  }
  return { version: label }
}

/** The four tool definitions, as plain data plus an execute function. */
export function buildTools(deps) {
  return [
    {
      name: 'awf_start',
      description:
        '登记一个 US 的 AWF 分析基线与产物目录（等价 /etp-awf-start）。基线四项必须由人提供：repository、knowledge_graph、documentation、skills；缺少任一项会被拒绝——插件不会用当前 HEAD 猜一个基线。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['us_id', 'repository', 'knowledge_graph', 'documentation', 'skills'],
        properties: {
          us_id: { type: 'string', description: 'US 标识，格式 US-YYYY-NNN' },
          us_ref: { type: 'string', description: 'US 平台链接或本地文件路径，透传给 A1 需求获取' },
          mode: { type: 'string', enum: ['final', 'draft'], description: 'final（默认，可交付）或 draft（内部推演，不得作为交付依据）' },
          repository: { type: 'string', description: '仓库身份，例如 legacy-saas/10.x@8f3a9c2；由人指定，不用当前 HEAD' },
          knowledge_graph: { type: 'string', description: '知识图谱版本与 commit；不可用时写 unavailable' },
          documentation: { type: 'string', description: '规范文档版本；没有写 none' },
          skills: { type: 'string', description: '技能与检查项版本标识' },
          provided_by: { type: 'string', description: '基线提供人的真实姓名' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'usId', 'state', 'next'],
          properties: {
            ok: { type: 'boolean' },
            usId: { type: 'string' },
            state: { type: 'string' },
            dir: { type: 'string' },
            next: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok !== true) return text(`AWF 启动失败：${value.error ?? '未知原因'}`)
          return text(`已创建 ${value.dir}（状态 ${value.state}）。下一步：${value.next}`)
        },
      },
      async execute(args, exec) {
        const store = await deps.getStore(exec.agent)
        try {
          const result = await startWorkflow(store, {
            usId: args.us_id,
            usRef: args.us_ref,
            mode: args.mode,
            providedBy: args.provided_by,
            baseline: {
              repository: parseLabel(args.repository),
              knowledge_graph: parseLabel(args.knowledge_graph),
              documentation: parseLabel(args.documentation),
              skills: parseLabel(args.skills),
            },
          })
          return { ok: true, usId: result.usId, state: result.state, dir: result.dir, next: result.next }
        } catch (error) {
          return { ok: false, usId: args.us_id, state: 'CREATED', next: '/etp-awf-start', error: renderError(error) }
        }
      },
    },

    {
      name: 'awf_run',
      description:
        '按 AWF 状态机推进一轮：派发当前阶段的子代理，再由独立的校验子代理复核产物，直到停在人工门禁或阻断（等价 /etp-awf-run）。一次调用最多推进 8 个阶段动作；状态只从 workflow-manifest.yaml 读取，不推断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['us_id'],
        properties: {
          us_id: { type: 'string', description: 'US 标识' },
          us_ref: { type: 'string', description: 'US 来源（仅 A1 需要）：平台链接或本地文件路径' },
          mode: { type: 'string', enum: ['draft', 'final'], description: '本轮运行模式，默认取 manifest 的记录' },
          max_actions: { type: 'integer', description: '本轮最多推进几个阶段动作，默认 8，上限 20' },
          dry_run: { type: 'boolean', description: '只做 Preflight 并返回，不派发子代理' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'status', 'state', 'summary'],
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string' },
            state: { type: 'string' },
            gate: { type: 'string' },
            next: { type: 'string' },
            agentsStarted: { type: 'integer' },
            summary: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          return text(value.summary)
        },
      },
      async execute(args, exec) {
        const store = await deps.getStore(exec.agent)
        if (exec.agent === undefined) {
          return { ok: false, status: 'error', state: 'UNKNOWN', summary: 'AWF 需要会话内的 Agent 才能拉起子代理', error: 'no agent' }
        }
        try {
          const result = await runDispatch(
            deps.dispatch(store, exec.agent, args.us_id, exec.signal),
            {
              usRef: args.us_ref,
              mode: args.mode,
              maxActions: args.max_actions,
              dryRun: args.dry_run === true,
            },
          )
          const summary = renderDispatchResult(result)
          return {
            ok: result.status !== 'error',
            status: String(result.status),
            state: String(result.state),
            ...(result.gate ? { gate: String(result.gate) } : {}),
            ...(result.next ? { next: String(result.next) } : {}),
            ...(result.agentsStarted === undefined ? {} : { agentsStarted: result.agentsStarted }),
            summary,
            ...(result.status === 'error' ? { error: String(result.reason ?? '') } : {}),
          }
        } catch (error) {
          const message = renderError(error)
          return { ok: false, status: 'error', state: 'UNKNOWN', summary: `AWF 推进失败：${message}`, error: message }
        }
      },
    },

    {
      name: 'awf_status',
      description:
        '只读查看一个 US 的 AWF 状态：五个阶段的产物与版本、三道门禁、C01–C20 通过情况、失效与人工修改、阻断原因与下一步（等价 /etp-awf-status）。不修改任何文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['us_id'],
        properties: {
          us_id: { type: 'string', description: 'US 标识' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'usId', 'text'],
          properties: {
            ok: { type: 'boolean' },
            usId: { type: 'string' },
            state: { type: 'string' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          return text(value.text)
        },
      },
      async execute(args, exec) {
        const store = await deps.getStore(exec.agent)
        try {
          if (!(await store.isInitialized(args.us_id))) {
            return {
              ok: true,
              usId: args.us_id,
              state: 'CREATED',
              text: `US ${args.us_id} 尚未初始化。先登记四项基线：/etp-awf-start ${args.us_id} <US 链接或文件路径>`,
            }
          }
          const { context, results } = await evaluate(store, args.us_id)
          return { ok: true, usId: args.us_id, state: context.manifest?.status, text: renderStatus(args.us_id, context, results) }
        } catch (error) {
          const message = renderError(error)
          return { ok: false, usId: args.us_id, text: `读取状态失败：${message}`, error: message }
        }
      },
    },

    {
      name: 'awf_gate',
      description:
        '预览或记录 AWF 人工门禁 G1/G2/G3 的结论（等价 /etp-awf-gate）。省略 decision 时只预览阻断项与待决策项；带 decision 时写入审批记录。审批人必须是真实姓名；存在未通过的阻断项时拒绝 APPROVED；插件绝不自动通过门禁。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['us_id', 'gate'],
        properties: {
          us_id: { type: 'string', description: 'US 标识' },
          gate: { type: 'string', enum: GATE_IDS, description: 'G1 需求确认 / G2 影响确认 / G3 设计确认' },
          decision: { type: 'string', enum: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'], description: '省略则只预览，不写任何记录' },
          approver: { type: 'string', description: '审批人的真实姓名（写结论时必填）' },
          notes: { type: 'string', description: '审批说明' },
          accepted_gaps: { type: 'array', items: { type: 'string' }, description: '显式接受的风险缺口编号，例如 IMPACT-011' },
          rejected_to: { type: 'string', enum: ['A1', 'A2', 'A3', 'A4'], description: '退回目标阶段（REJECTED 时）' },
          pending_items: { type: 'array', items: { type: 'string' }, description: 'PARTIALLY_APPROVED 的待定清单：条目、责任人、期限' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'gate', 'preview', 'text'],
          properties: {
            ok: { type: 'boolean' },
            gate: { type: 'string' },
            decision: { type: 'string' },
            state: { type: 'string' },
            blocking: { type: 'array', items: { type: 'string' } },
            preview: { type: 'boolean' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          return text(value.text)
        },
      },
      async execute(args, exec) {
        const store = await deps.getStore(exec.agent)
        try {
          if (args.decision === undefined) {
            const preview = await gatePreview(store, args.us_id, args.gate)
            return { ok: true, gate: args.gate, preview: true, blocking: preview.blocking, text: preview.text }
          }
          const result = await recordGate(store, {
            usId: args.us_id,
            gate: args.gate,
            decision: args.decision,
            approver: args.approver,
            notes: args.notes,
            acceptedGaps: args.accepted_gaps,
            rejectedTo: args.rejected_to,
            pendingItems: args.pending_items,
          })
          const lines = [
            `${args.gate} 已记录：${result.decision}（审批人 ${result.approver}）`,
            `状态：${result.state}`,
            `检查项：${result.checks.map(entry => `${entry.id}:${entry.result}`).join(' ') || '（无）'}`,
            `下一步：${result.next}`,
          ]
          return { ok: true, gate: args.gate, decision: result.decision, state: result.state, blocking: [], preview: false, text: lines.join('\n') }
        } catch (error) {
          const message = renderError(error)
          return { ok: false, gate: args.gate, preview: args.decision === undefined, text: `门禁操作被拒绝：${message}`, error: message }
        }
      },
    },
  ]
}

/**
 * Register the four tools on `ctx.tools`. The disposer is owned by an effect, so
 * unloading the plugin removes them (DSH practice: registrations are effects).
 */
export function registerTools(ctx, deps) {
  const names = []
  for (const definition of buildTools(deps)) {
    const dispose = ctx.tools.register(definition)
    ctx.effect(() => dispose, `dsh-awf: tool ${definition.name}`)
    names.push(definition.name)
  }
  return names
}
