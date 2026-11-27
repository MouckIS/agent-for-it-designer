/**
 * dsh-awf — 把 DS-V5 的技术方案设计工作流做成 DeepSeek Harness 能力。
 *
 * 三件事必须同时成立，插件才有意义：
 *
 *   1. **状态只有一处写**：`docs/awf/<US-ID>/00-workflow/workflow-manifest.yaml`
 *      是唯一事实来源；工具、命令与 workflow 脚本都只从它读、只往它写
 *      （DS-V5 K7）。
 *   2. **门禁只由人写**：`recordGate` 要求真实审批人姓名，阻断项未通过时拒绝
 *      APPROVED，插件永远不自动通过（DS-V5 §10.1）。
 *   3. **技能可被加载**：仓库 `.claude/skills/**` 被注册进 `ctx.skills`，
 *      阶段子代理因此能在自己的上下文里读到协议、模板与检查清单。
 *
 * 与 DS-V5 §2.3 的三层对应关系：本文件与 `lib/tools.js`、`lib/commands.js` 是
 * 门禁层（人机交互入口）；`lib/workflow.js` 是决策层（无文件系统的路由脚本）；
 * 阶段派发出去的子代理是执行层，负责产物内容与校验的实质判断。
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store, createServiceIo } from './lib/store.js'
import { registerTools } from './lib/tools.js'
import { registerCommands } from './lib/commands.js'
import { registerSkills } from './lib/skills.js'
import { STAGES, STAGE_ORDER } from './lib/constants.js'
import { checkTable } from './lib/a0.js'

/** 插件在 Loader 里的名字。 */
export const name = 'awf'

/**
 * 根作用域依赖的 Host 服务。
 *
 * `fs` 必须在 `inject` 里：Cordis 的 `ctx.fs` 只能通过 inject 声明后读取，
 * 否则访问会抛 "cannot get property fs without inject"。
 *
 * `subagents` 必须在 inject 里：决策层脚本的 `agent()` 通过
 * `ctx.subagents.startActivation` 派发子代理。
 *
 * 故意不注入 `workflowEngine`：本 profile 把 `@deepseek-ai/dsh-workflow-ptc`
 * 放在 agent 预设的 `cordis:group` 里并对 `workflowEngine` 做了 `isolate: true`，
 * 根作用域根本拿不到；硬注入会让插件永远停在 pending。插件改为在进程内用
 * `node:vm` 跑同一份决策层脚本（`lib/runner.js`），DS-V5 §2.3 的三层划分不变。
 */
export const inject = ['tools', 'commands', 'skills', 'fs', 'subagents']

/** 包根目录，用于给出技能与文档的绝对路径。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 提示词段落顺序：紧跟在团队规则之后、PTC 说明之前。 */
const SECTION_ORDER = 660

/** 每个 Agent 的 Store 缓存：键是 workspace 根，避免重复建对象。 */
const storeCache = new WeakMap()

/**
 * 取当前 Agent 的工作区根。`workingDirectory.get()` 读已提交目录，不做 I/O；
 * 服务不可用时退回 `fs` 的默认解析行为（由 `ctx.fs.resolve` 决定）。
 */
function workspaceRootOf(ctx, agent) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && agent !== undefined && agent.session !== undefined) {
    try {
      return workingDirectory.get(agent.session)
    } catch {
      // 无已提交目录时继续往下走。
    }
  }
  return process.cwd()
}

/** 为一个 Agent 取 Store（按 workspace 根缓存）。 */
function storeFor(ctx, agent) {
  const root = workspaceRootOf(ctx, agent)
  const cached = storeCache.get(ctx)
  if (cached !== undefined && cached.root === root) return cached.store
  const store = new Store(createServiceIo(ctx.fs, root), { root })
  storeCache.set(ctx, { root, store })
  return store
}

/**
 * 注册系统提示段落。把「本工作区有 AWF」告诉模型，并给出唯一正确的入口
 * （命令优先），避免模型自己拼一套产物格式。
 */
function registerPrompt(ctx) {
  const stageLines = STAGE_ORDER.map(id => {
    const stage = STAGES[id]
    return `${id} ${stage.name}（${stage.dir}/，检查项 ${stage.checks.join('/')}）`
  })
  const prompt = [
    'The user has the AWF plugin: a state-machine-driven technical design workflow for legacy Spring Boot SaaS requirements, kept under `docs/awf/<US-ID>/`.',
    'Its state lives in `docs/awf/<US-ID>/00-workflow/` — `workflow-manifest.yaml` is the only source of truth for the workflow state; `analysis-baseline.yaml` holds the human-provided baseline; `artifact-manifest.yaml` holds each artifact hash; `workflow-report.md` is the audit log.',
    'Five stages run in order, each writing exactly one directory: ' + stageLines.join('；') + '.',
    'When the user asks to start, advance, inspect or gate this workflow, use the `/etp-awf-*` commands or the `awf_*` tools instead of writing these files by hand: the plugin computes the C01–C20 rules (' + checkTable().length + ' rules), refuses approvals with failing blocking items, and never fabricates a baseline.',
    'The human gate decisions G1 (requirements), G2 (impact) and G3 (design) belong to the user alone. Record one only after the user answers with a real name; never infer approval from silence.',
    'When the baseline or the code has changed, prefer `/etp-awf-rerun <class>` over a full rerun: it marks downstream artifacts STALE and resets only the affected gates.',
  ].join(' ')
  const dispose = ctx.systemPrompt.section({
    name: 'plugin:awf',
    order: SECTION_ORDER,
    text: prompt,
    interpolate: false,
  })
  ctx.effect(() => dispose, 'dsh-awf: prompt section')
}

/**
 * 插件入口。分四步：技能 → 工具 → 命令 → 提示段落；任一步可选时降级而不是
 * 让整个插件不激活（技能注册失败不应让命令消失）。
 */
export function apply(ctx) {
  const deps = {
    getStore: agent => storeFor(ctx, agent),
    /**
     * 组装一次派发所需的依赖。
     *
     * 不用 `ctx.workflowEngine`：本 profile 把 workflow-ptc 放在 agent 预设的
     * `cordis:group` 里并 isolate 了 `workflowEngine`，根作用域拿不到。改为在插件
     * 进程内用 vm 跑同一份决策层脚本，`agent()` 落到根作用域的 `ctx.subagents`。
     */
    dispatch: (store, agent, usId, signal) => ({
      store,
      ctx,
      agent,
      usId,
      signal,
      cwd: store.root,
      onProgress: () => {},
    }),
  }

  // 技能：把 AWF 的协议、模板与检查清单放进 `ctx.skills`，供阶段子代理加载。
  const skills = registerSkills(ctx)
  if (skills.skipped.length > 0) {
    ctx.logger?.warn?.(`dsh-awf: 跳过 ${skills.skipped.length} 个技能：${skills.skipped.map(entry => `${entry.name}(${entry.reason})`).join(', ')}`)
  }

  // 工具与命令共用同一套 a0 函数。
  const toolNames = registerTools(ctx, deps)
  const commandNames = registerCommands(ctx, deps)

  // 提示段落是可选的：没有 `systemPrompt` 的宿主仍然有工具与命令。
  ctx.inject(['systemPrompt'], promptCtx => registerPrompt(promptCtx))

  ctx.logger?.info?.(`dsh-awf: ${toolNames.length} 个工具、${commandNames.length} 条命令、${skills.registered.length} 个技能已就绪`)
}

/** `--dump` 之类的宿主检查可以读这份清单确认插件内容。 */
export const inventory = {
  packageRoot: PACKAGE_ROOT,
  tools: ['awf_start', 'awf_run', 'awf_status', 'awf_gate'],
  commands: ['etp-awf-start', 'etp-awf-run', 'etp-awf-status', 'etp-awf-gate', 'etp-awf-rerun', 'etp-awf-review'],
  stages: STAGE_ORDER,
}
