# AWF 技术方案设计工作流插件

把 `Agent技术方案设计-DS-V5.md` 描述的工作流做成一枚 DeepSeek Harness Host 插件：一个 14 状态机、五个阶段、二十条一致性规则、三道人工门禁，以及七个可被阶段子代理加载的技能。

## 它解决什么

存量 Spring Boot SaaS 系统的技术设计有两个结构性难题：**需求在图片里**，**影响在暗处**。这份插件不靠模型的自信来保证质量，而是把过程拆成可校验的阶段：

| 层 | 载体 | 只做 | 绝不做 |
| --- | --- | --- | --- |
| 决策层 | `lib/workflow.js` 的路由脚本 | 状态路由、阶段派发、停点返回 | 读文件、判断产物内容 |
| 执行层 | 每阶段派发的子代理 + 校验子代理 | 产出双产物、复核字段与引用 | 改状态、碰其它阶段目录 |
| 门禁层 | `lib/tools.js` / `lib/commands.js` | 展示阻断项、写审批记录 | 替人签字、自动通过 |

脚本没有文件系统（DS-V5 K1），所以「读 manifest、算哈希、判定规则」都由插件进程里的 `lib/store.js` 与 `lib/checks.js` 完成；子代理没有记忆（K4），所以每次派发的 prompt 都自带角色、基线、输入、使命、产出、检查项与返回契约。

## 状态机

十四个状态，每个都有入口、出口与失败去向：

```
CREATED → BASELINE_CONFIRMED → A1_RUNNING → WAITING_G1 → A3_RUNNING → WAITING_G2
        → A4_RUNNING → A5_RUNNING → WAITING_G3 → COMPLETED
```

外加 `A2_RUNNING`（需求澄清）、`DESIGN_REVISION`（评审回流）、`WAITING_DEPENDENCY`、`BLOCKED`。`WAITING_G1/G2/G3` 是停点——脚本返回、命令接手，插件永远不会自己把门禁记成通过。

## 产物

`docs/awf/<US-ID>/` 下六个目录，YAML 是唯一事实来源，Markdown 只能由它渲染：

| 阶段 | 目录 | 产物 |
| --- | --- | --- |
| A1 需求获取 | `01-source/` | ART-10 来源包、ART-11 后端范围、`raw.md` 只读快照 |
| A2 需求澄清 | `02-requirement/` | ART-20 规则与验收、ART-21 澄清说明、ART-22 决策记录 |
| A3 影响分析 | `03-impact/` | ART-30 影响包、ART-31 影响说明、ART-32 证据清单 |
| A4 技术设计 | `04-design/` | ART-40 设计包、ART-41 设计说明、ART-42 ADR、ART-43 覆盖矩阵、ART-44 文件清单 |
| A5 独立评审 | `05-review/` | ART-50 评审报告、ART-51 评审说明、ART-52 修订指令 |

`00-workflow/` 是控制面：`workflow-manifest.yaml`（状态，唯一事实来源）、`analysis-baseline.yaml`（人工基线）、`artifact-manifest.yaml`（每个文件的 sha256）、`workflow-report.md`（审计日志）。

## 用法

六条命令，与四条模型工具一一对应：

| 命令 | 工具 | 作用 |
| --- | --- | --- |
| `/etp-awf-start` | `awf_start` | 登记四项人工基线，建目录与 manifest |
| `/etp-awf-run` | `awf_run` | 推进一轮，停在门禁或阻断 |
| `/etp-awf-status` | `awf_status` | 只读查看状态、规则、失效 |
| `/etp-awf-gate` | `awf_gate` | 预览或记录 G1/G2/G3 结论 |
| `/etp-awf-rerun` | — | 按 12 类变化标失效、重置门禁 |
| `/etp-awf-review` | — | 强制重跑 A5 独立评审 |

```text
/etp-awf-start US-2026-001 --repo release/10.x@8f3a9c2 --graph g-20261114-001@8f3a9c2 \
  --docs docs-v1 --skills v1 --by 张工 --us-ref https://internal/us/1001
/etp-awf-run US-2026-001
/etp-awf-status US-2026-001
/etp-awf-gate G1 US-2026-001                                   # 只预览，不写记录
/etp-awf-gate G1 US-2026-001 --decision APPROVED --approver 张工 --notes "范围认可"
/etp-awf-rerun a2_rules US-2026-001                            # 只失效 A2 及其下游
```

## 二十条一致性规则

`lib/checks.js` 把 DS-V5 §4.2 的 C01–C20 实现成纯函数，输入是磁盘上的产物，输出是 `{id, result: pass|fail|not_applicable, evidence}`。其中 C01–C16 沿用仓库 `.claude/skills/etp-awf-workflow/references/gates-and-checks.md` 的语义，C17–C20 是 DS-V5 新增的：覆盖矩阵可复算、双产物三字段一致、引用文档必须 ACTIVE、迁移与回滚成对。

**判不了就写 `not_applicable` 并给理由**，不会被当成通过——`C15` 专门检查这一点。

## 三道门禁

门禁记录拒绝以下几种情况，这是插件的核心承诺：

- 审批人为空 → `EAPPROVER`（"审批人必须是真实姓名"）。
- 当前状态不在该门禁 → `ESTATE`。
- 审批对象缺失 → `ENOARTIFACT`（人要对机器消费的那份 YAML 签字）。
- 阻断项仍有 `fail` 却要 `APPROVED` → `EBLOCKING`。
- `PARTIALLY_APPROVED` 没给待定清单 → `EPARTIAL`。

## 七个技能

`skills/` 是仓库 `.claude/skills/` 的副本：`etp-awf-workflow`（流程、协议、门禁、状态机五份 references）、`etp-requirement-fetch`、`etp-design-doc-writing`（五类文档模板）、`etp-legacy-saas-analysis`（SaaS 检查清单与证据规则）、`etp-code-graph-query`、`etp-project-checklist`、`etp-design-review`。

注册进 `ctx.skills` 而不是放进 `skills/` 目录等 `dsh-skill-filesystem` 扫描——那个 provider 不认 `.claude/skills`。

## 配置

无需配置。插件从当前会话的工作目录解析 `docs/awf/`，用 `ctx.fs` 读写（受沙箱约束），依赖 `tools`、`commands`、`skills`、`workflowEngine` 四个 Host 服务。

## 限制

- **workflow 引擎不支持 `agentType`**（`dsh-workflow-ptc` 把它列为 deferred option），所以阶段角色写在 prompt 里，而不是靠子代理类型。这与 DS-V5 K4「子代理无持久记忆」的要求一致。
- 脚本没有 `budget`，所以 DS-V5 K6 的预算停止改为 `maxActions`（默认 8，上限 20）。
- 阶段产物的语义正确性由子代理负责；插件只判定能被机械复算的部分（DS-V5 P9）。
- 没有 Web 面板：这是 Host-only 插件，界面就是命令与工具的结果。

## 自测

```bash
node plugins/dsh-awf/test/plugin.test.mjs
```

覆盖：YAML 子集 round-trip、状态数、规则表与门禁一致性、`apply` 的注册面（4 工具 / 6 命令 / 7 技能 / 1 提示段落）、启动拒绝伪造基线、重复启动、status 只读、门禁四种拒绝、重跑失效与门禁重置、C02/C03/C04/C14/C17/C18/C20 的正反例。当前 30/30 通过。
