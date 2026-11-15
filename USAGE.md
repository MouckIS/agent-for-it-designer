# ETP 技术方案设计工作流（AWF）使用说明

面向存量 Spring Boot SaaS 仓库：把「US 获取 → 需求澄清 → 代码影响分析 → 技术设计 → 独立评审 → 交付」做成一条可追溯、可中断、可回流的流程。

- 入口约定：`CLAUDE.md`（何时启用、角色边界、硬性规则）
- 完整流程：`.claude/workflows/awf.md`（状态机、派发协议、门禁、回流）
- 本套资产统一以 `etp-` 为前缀，可直接放入仓库 `.claude/`，也可按目录结构上传到公司平台

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 运行环境 | 支持 subagent / skill / slash command 的 Claude Code 或兼容客户端 |
| 代码仓库 | 存量 Spring Boot 仓库，主线程可执行 `git` 与只读检索命令 |
| 人工基线 | 启动前需由人提供四项：repository（仓库+分支+commit）、knowledge_graph（图谱版本+commit+lag_policy）、documentation（文档版本）、skills（各技能版本） |
| 需求输入 | US 标识 + 平台链接，或本地 US 文件（`.md`） |

基线必须由人给出：A0 可以用只读命令给出建议值，但必须经人确认后才写入，不会自行确定 HEAD 或猜版本。

## 2. 资产清单

### 2.1 子代理（`.claude/agents/`）

| 名称 | 阶段 | 职责 |
| --- | --- | --- |
| `etp-requirement-collector` | A1 | 调 `etp-requirement-fetch` 取回 US 原始内容，固化快照，过滤后端范围，登记缺口 |
| `etp-requirement-analyst` | A2 | 需求澄清：规则与来源、范围、角色、验收标准、待确认决策 |
| `etp-impact-analyst` | A3 | 代码触点、功能影响、数据/契约/租户风险、证据、跨 US 冲突 |
| `etp-technical-designer` | A4 | 详细设计、ADR、兼容迁移、发布回滚、检查项回应、文件清单 |
| `etp-design-reviewer` | A5 | 独立复核（需求/影响/设计/检查项/一致性），输出 PASS / CONDITIONAL_PASS / FAIL 与修订指令 |

A0 由主线程承担，不派发为子代理。子代理之间不能互相派发（客户端限制），阶段衔接全部由 `/etp-awf-run` 完成。

### 2.2 技能（`.claude/skills/<name>/SKILL.md`）

| 名称 | 何时读 | 内容 |
| --- | --- | --- |
| `etp-awf-workflow` | 每次 `/etp-awf-*`、每个子代理启动 | 状态机、产物协议、门禁与一致性检查、上下文装配 |
| `etp-requirement-fetch` | A1 获取 US 前 | 需求平台对接（当前占位） |
| `etp-project-checklist` | A3/A4/A5 执行检查项前 | 项目特有检查项（当前占位） |
| `etp-code-graph-query` | A3/A5 检索代码前 | 图谱 MCP 优先，无图谱降级 ripgrep/Glob |
| `etp-legacy-saas-analysis` | A2–A5 做 SaaS 判断 | 多租户、存量兼容、迁移、权限、计费、MQ、可观测性 |
| `etp-design-doc-writing` | A1–A4 落盘文档前 | 双产物规范与五类文档模板 |
| `etp-design-review` | A5 评审、G3 前自查 | 八层评审标准、问题分级、修订指令格式 |

技能的 `name` 字段必须与目录名一致。

### 2.3 命令（`.claude/commands/`）

| 命令 | 参数 | 作用 | 是否改文件 |
| --- | --- | --- | --- |
| `/etp-awf-start` | `<US-ID> [链接或文件路径]` | 建产物目录，登记人工基线，写 workflow/baseline/artifact 三个 manifest | 是 |
| `/etp-awf-run` | `[US-ID]` | 按当前状态派发 A1–A5，直到人工门禁、阻断或完成 | 是 |
| `/etp-awf-gate` | `<G1/G2/G3> [US-ID]` | 计算并展示阻断项与待决策项，记录人的结论后推进状态 | 是 |
| `/etp-awf-status` | `[US-ID]` | 查看阶段、版本、门禁、C01–C16、失效与下一步 | 否（只读） |
| `/etp-awf-rerun` | `<A1/A2/A3/A4/A5> [US-ID]` | 检测产物/快照/基线变化，标记失效，重置门禁，定位最早受影响阶段 | 是 |
| `/etp-awf-review` | `[US-ID]` | 强制重跑 A5 独立评审 | 是 |

省略 US-ID 时，命令会扫描 `docs/awf/*/00-workflow/workflow-manifest.yaml`：只有一个就自动使用，多个则让你选。

## 3. 安装

### 3.1 放入仓库

把以下内容复制到目标仓库根目录：

```text
.claude/agents/etp-*.md
.claude/skills/etp-*/
.claude/commands/etp-awf-*.md
.claude/workflows/awf.md
CLAUDE.md
AGENTS.md
```

`examples/US-2026-001.md` 只作输入样例，可不带。

### 3.2 上传到公司平台

保持目录层级不变，注意命名契约：

| 资产 | 命名来源 | 规则 |
| --- | --- | --- |
| 子代理 | frontmatter `name` | 与文件名一致，如 `etp-impact-analyst` |
| 技能 | frontmatter `name` + 目录名 | 两者一致，如 `etp-code-graph-query/SKILL.md` |
| 命令 | 文件名（去 `.md`） | 如 `etp-awf-run.md` → `/etp-awf-run` |
| 工作流 | 文件路径 | `.claude/workflows/awf.md` 保持原名，被命令与技能按路径引用 |

全部使用小写字母 + 连字符。新增资产继续加 `etp-` 前缀，避免与其他项目组资产重名。

## 4. 快速开始

```text
# 1. 启动并登记基线（会追问四项基线）
/etp-awf-start US-2026-001 docs/requirements/US-2026-001.md

# 2. 推进到 G1
/etp-awf-run

# 3. 看状态、确认需求
/etp-awf-status
/etp-awf-gate G1

# 4. 继续 A3 → G2 → A4 → A5 → G3
/etp-awf-run
/etp-awf-gate G2
/etp-awf-run
/etp-awf-gate G3
```

`/etp-awf-run` 一次最多执行 8 个阶段动作，遇到门禁或阻断就停；需要继续时再执行一次。

## 5. 流程与状态

```text
CREATED → BASELINE_CONFIRMED → A1 → A2 → WAITING_G1（人工）
      → A3 → WAITING_G2（人工） → A4 → A5
      → WAITING_G3（人工） → COMPLETED
A5 FAIL → DESIGN_REVISION → 定向回流 A1/A2/A3/A4 → A5 复审
```

| 状态 | 含义 |
| --- | --- |
| `CREATED` | 工作流已创建，等待人工基线 |
| `BASELINE_CONFIRMED` | 基线已登记，等待 A1 |
| `A1_RUNNING` / `A2_RUNNING` / `A3_RUNNING` / `A4_RUNNING` / `A5_RUNNING` | 对应阶段执行中 |
| `WAITING_G1` / `WAITING_G2` / `WAITING_G3` | 停在人工门禁 |
| `DESIGN_REVISION` | 按修订指令定向回流 |
| `WAITING_DEPENDENCY` | 批次模式下等待上游 US 冻结 |
| `COMPLETED` | 已冻结并交付 |
| `BLOCKED` | 阻断，等待人工处理 |

三个门禁都是人工的：

| 门禁 | 确认什么 | 通过后 |
| --- | --- | --- |
| G1 | 后端范围、规则来源、验收标准、推断项、待决策 | `A3_RUNNING` |
| G2 | 高风险数据写路径、权限、多租户、对外契约、证据缺口 | `A4_RUNNING` |
| G3 | A5 结论、条件关闭、检查项与覆盖矩阵完整、发布回滚完整 | `COMPLETED` |

命令只列出阻断项和待决策项，不会「默认同意」，也不会代你选。

`final` 模式必须过全部人工门禁；`draft` 模式可跳过门禁，但产物强制带 `DRAFT` 标记，不能作为开发交接依据。

## 6. 产物

每个 US 的产物都在 `docs/awf/<US-ID>/`：

```text
00-workflow/     workflow-manifest、analysis-baseline、artifact-manifest、workflow-report
01-source/       source-package.yaml、backend-scope.md、raw.md、assets/
02-requirement/  requirement-package.yaml、requirement-clarification.md、decision-log.yaml
03-impact/       impact-package.yaml、impact-analysis.md、evidence-manifest.yaml
04-design/       technical-design-package.yaml、technical-design.md、adrs/、design-coverage.yaml、expected-file-changes.yaml
05-review/       review-report.yaml、review-report.md、revision-instructions.yaml、revision-history/、DISPUTE.md
```

| 阶段 | 主要产物（ART） |
| --- | --- |
| A1 | ART-10 快照、ART-11 后端范围 |
| A2 | ART-20 结构化需求、ART-21 需求澄清、ART-22 决策 |
| A3 | ART-30 结构化影响、ART-31 影响报告、ART-32 证据 |
| A4 | ART-40 结构化设计、ART-41 设计方案、ART-42 ADR、ART-43 覆盖矩阵、ART-44 文件清单 |
| A5 | ART-50 结构化评审、ART-51 评审报告、ART-52 修订指令 |

每个阶段同时产出 YAML 与 Markdown：YAML 用于校验与追溯，Markdown 由 YAML 渲染。改 YAML 后必须重新渲染 Markdown，否则视为版本不一致。

## 7. 常见场景

| 场景 | 做法 |
| --- | --- |
| 只想看进度 | `/etp-awf-status`（只读，不改任何文件） |
| US 内容变更 | 重新获取并生成 `01-source` 新版本，再 `/etp-awf-rerun`，失效会自动向下游传播 |
| 只改了措辞 | `/etp-awf-rerun` 判定为 `*_text`：生成新版本、重渲染、不重跑、不重置门禁 |
| 改了业务规则 | 判定为 `a2_rules`：A2 起重跑，G1/G2/G3 全部重置 |
| 代码基线前移 | 先求触点交集；命中则 A3 起重跑，未命中只记录 |
| A5 结论 FAIL | 读 `revision-instructions.yaml` 的 `return_to`，只重跑最早受影响阶段，最多两轮；超限写 `DISPUTE.md` 并 `BLOCKED` |
| A5 条件通过 | 逐条关闭 `conditions[]`（用户确认 → 写 closed_at 与 note → 生成 A5 新版本 → 重跑 C08）后才可走 G3 |
| 人工直接改产物 | 改完执行 `/etp-awf-rerun` 让系统判断失效范围，不要手工改 manifest |
| 多 US 批次 | 人工维护 `docs/awf/portfolio.yaml`（依赖/冲突），`WAITING_DEPENDENCY` 时不会越序派发 A4 |
| 没有代码图谱 | 走 `etp-code-graph-query` 的 ripgrep 降级，证据类型记 `static_analysis` 并标注降解 |
| 被 BLOCKED | 读 `00-workflow/workflow-report.md` 的阻断原因，人工处理后用 `/etp-awf-rerun` 或 `/etp-awf-run` 恢复 |

## 8. 按团队定制

| 要改什么 | 改哪里 | 注意 |
| --- | --- | --- |
| SaaS 检查项 | `.claude/skills/etp-legacy-saas-analysis/references/saas-checklist.md` | 输出需带 `pass/fail/not_applicable`，后者要理由 |
| 项目特有检查项 | `.claude/skills/etp-project-checklist/SKILL.md` | 当前占位，接入在线文档来源后补解析规则 |
| 文档模板 | `.claude/skills/etp-design-doc-writing/references/*.md` | 章节号需与产物协议一致，否则校验对不上 |
| 评审标准 | `.claude/skills/etp-design-review/SKILL.md` | 改判定口径前同步 `gates-and-checks.md` |
| 业务规范 | `docs/knowledge/` | 在 `analysis-baseline.yaml` 登记版本，A1 只引用命中条款 |
| 代码图谱 | 接入图谱 MCP 工具 | 未接入时自动降级静态检索，不阻断流程 |
| 框架约定 | 仓库 `CLAUDE.md` / `AGENTS.md` | 写清 Controller/Service/Repository/异常/事务/缓存/MQ/权限/租户规范，A3 必须遵循 |

新增或重命名资产时，至少同步这三处引用：命令与工作流里的路径、`CLAUDE.md` 的角色/技能表、`AGENTS.md` 的清单。

## 9. 边界

- 只产出文档与结构化产物，不写业务代码、不做 Code Review、不负责发布。
- 不替代人的需求判断与架构决策；它负责把决策过程结构化、把证据摆出来。
- 不保证一次生成即正确。质量来自门禁、证据链和独立评审，而不是模型自信。
- 没有证据就写 `evidence_gap`，不允许输出「无影响」这类无依据结论。
