# AWF 编排规则（A0）

本文件是 AWF 的流程规则全文：状态与派发、子代理派发协议、门禁、增量重跑、多 US 批次、异常处理、完成条件。

两份文件分工固定：

- **可执行编排** `.claude/workflows/awf.js` —— 状态路由、阶段规格、JSON Schema、主循环、停点返回。要改「谁来跑、跑完去哪」改脚本。
- **流程规则**（本文件）—— 规则文本与判定口径。要改「什么叫通过、什么情况退回、失效范围怎么算」改这里。

两者必须一致：脚本里的 `ROUTE` / `STAGES` 与本文 §1、§2 表格一一对应，改动任一侧都要同步另一侧并在 PR 说明。

## 0. 输入与输出

输入：

- 产品 US：平台链接，或用户提供的文件/正文；由 A1 调用 `etp-requirement-fetch` 获取，落到 `01-source/`。
- 代码基线（**人工提供**）：branch、commit、图谱版本与 commit、docs 版本、skills 版本。
- 知识来源（可选）：业务规范、领域词典、历史设计、框架封装约定、运行时证据。

输出：`docs/awf/<US-ID>/` 下的完整交付包，正式交付物为 ART-41 技术设计方案及其追溯链。多 US 批次额外输出 `docs/awf/portfolio.yaml`（ART-04）。

边界：A0 **不建立、不切换、不回退** 代码基线，只做校验、登记与失效判定。基线缺失或不可用时停在 `CREATED`/`BLOCKED`，不得自行取当前 HEAD 顶上。

调用方式：`Workflow({name: "awf", args: {usId: "US-2026-001", usRef: "<链接或路径>", mode: "final"}})`。

## 1. 状态与派发

状态定义、合法迁移、每状态必须存在的文件见 `state-machine.md`。下表与 `awf.js` 的 `ROUTE` 表一致。

| 当前状态 | A0 动作 | 派发对象（`agentType`） | 退出条件 |
| --- | --- | --- | --- |
| `CREATED` | 校验人工基线，初始化 manifest | 无（脚本停下，等人执行 `/etp-awf-start`） | 基线有效 → `BASELINE_CONFIRMED`；无效 → `BLOCKED` |
| `BASELINE_CONFIRMED` | 派发 A1 | `etp-requirement-collector` | 产物校验通过 → `A2_RUNNING` |
| `A1_RUNNING` | 派发 A1（重跑或补缺口） | `etp-requirement-collector` | C13/C14 通过 → `A2_RUNNING`；缺口未补 → `BLOCKED` |
| `A2_RUNNING` | 派发 A2 | `etp-requirement-analyst` | 产物校验通过 → `WAITING_G1`（final）或 `A3_RUNNING`（draft） |
| `WAITING_G1` | 生成 G1 摘要并**停下** | 无 | `/etp-awf-gate G1` 通过 → `A3_RUNNING`；范围错误 → `A1_RUNNING` |
| `A3_RUNNING` | 派发 A3 | `etp-impact-analyst` | 产物校验通过 → `WAITING_G2`（final）或 `A4_RUNNING`（draft） |
| `WAITING_G2` | 生成 G2 摘要并**停下** | 无 | `/etp-awf-gate G2` 通过 → `A4_RUNNING` |
| `A4_RUNNING` | 派发 A4 | `etp-technical-designer` | 产物校验通过 → `A5_RUNNING` |
| `A5_RUNNING` | 派发 A5 | `etp-design-reviewer` | PASS/CONDITIONAL → `WAITING_G3`；FAIL → `DESIGN_REVISION` |
| `DESIGN_REVISION` | 读修订指令，按 `target_agent` 重派 | A1/A2/A3/A4 | 重跑完成 → `A5_RUNNING`；round > 2 → `BLOCKED` |
| `WAITING_DEPENDENCY` | 多 US 批次等待上游，**停下** | 无 | 上游完成或人工解除 → 原阶段 |
| `WAITING_G3` | 生成 G3 摘要并**停下** | 无 | `/etp-awf-gate G3` 通过 → `COMPLETED` |
| `COMPLETED` | 冻结版本、输出交付摘要 | 无 | 结束 |
| `BLOCKED` | 输出阻断原因与建议动作 | 无 | 人工处理 + `/etp-awf-rerun` 或解除阻断 |

**脚本能做什么、必须停什么**：workflow 脚本无法阻塞等人，因此上表所有「无派发对象」的行都是脚本的 return 停点，返回里带 `gate` / `reason` / `next`，由主线程命令 `/etp-awf-gate`、`/etp-awf-status`、`/etp-awf-rerun` 接着做。脚本自身只会连续推进「有派发对象」的行。

**幂等**：同一状态重复执行必须先读 manifest 中的产物版本，再从该版本继续，不重复生成已通过校验的产物、不重复递增版本号。

**单轮上限**：脚本每次调用最多执行 `args.maxActions`（默认 8，上限 20）个阶段动作，达到上限返回 `status: "max_actions"`；`budget.remaining() < 50000` 时也会主动停下。再次执行 `/etp-awf-run` 从停下的状态继续。

## 2. 子代理派发协议

### 2.1 派发方式

A1–A5 与 A0 执行层都用 workflow 脚本的 `agent(prompt, opts)` 派发，`opts.agentType` 指定 `.claude/agents/` 下注册的代理：

| 阶段 | `agentType` | 阶段产物目录 |
| --- | --- | --- |
| A0 Preflight / 校验 / 读修订指令 | `etp-awf-controller` | 只写 `00-workflow/` |
| A1 需求获取 | `etp-requirement-collector` | `01-source/` |
| A2 需求澄清 | `etp-requirement-analyst` | `02-requirement/` |
| A3 代码影响分析 | `etp-impact-analyst` | `03-impact/` |
| A4 技术设计 | `etp-technical-designer` | `04-design/` |
| A5 独立评审 | `etp-design-reviewer` | `05-review/` |

约束：

- 子代理之间**不能互相派发**（子代理不调用 Task / Agent，workflow 内也不能再嵌套 workflow）。
- 派发时必须带 `schema`，返回值是结构化对象而不是散文；子代理的自报只作参考，A0 必须自己读文件复核。
- `opts.phase` 必须与 `awf.js` 的 `meta.phases` 标题完全一致，否则进度分组错乱。

### 2.2 prompt 装配清单（不得省略任一项）

```text
你是 A<stage> 执行代理（agentType: <agent-name>），由 .claude/workflows/awf.js 的 A0 编排脚本派发。

仓库根目录：<绝对路径>
本 US 工作目录：docs/awf/<US-ID>/
本阶段输出目录：docs/awf/<US-ID>/<本阶段目录>/

## 必读（全部用绝对路径）
- .claude/skills/etp-awf-workflow/SKILL.md
- .claude/skills/etp-awf-workflow/references/<artifact-protocol|context-assembly|gates-and-checks|state-machine|orchestration-rules>.md
- .claude/skills/<本阶段领域 skill>/SKILL.md

## 输入产物
版本以 00-workflow/workflow-manifest.yaml 与 artifact-manifest.yaml 为准；逐个列出本阶段允许读取的产物。
A1 额外：US 来源 <链接或路径>

## 分析基线
- repository: <name> / <branch> / <commit>
- knowledge_graph: <version 或 none，含 lag_policy>
- documentation: <version 或 none>
- skills: <skill 文件相对路径与版本>

## 本阶段任务
<该阶段 mission，逐条列出>

## 本阶段产出
<ART 编号 + 文件路径>

## 硬约束
- 只写本阶段目录；不改其他阶段产物、不改 00-workflow/ 的 manifest、不改仓库业务代码
- 双产物纪律：先 YAML 后按模板渲染 Markdown；同 bundle 版本一致；改 YAML 必须重渲染
- 证据格式：graph:<node-id> / file:line / git:<commit> / doc:<doc-id>#<clause> / runtime:<source> / human:<decision-id>；无证据写 evidence_gap
- 不扩大需求、不替其他阶段做结论、不编造缺失数据（缺数据写 null 并在 notes 说明）
- ID 与字段严格按 artifact-protocol.md；旧版本不覆盖，新版本 = 旧版本 + 1
- 检查项逐条给 pass / fail / not_applicable，not_applicable 需理由
- 不写业务代码

## 返回
只返回 schema 约束的结构化结果（stage / bundleId / version / status / files[] / counts / blocked[] / needHuman[] / gateSignals / conclusion / next），不要写散文。
```

修订回流时追加：

```text
## 本轮修订指令（必须逐条回应）
回流轮次：<round>；修订对象：<target_agent>
issues:
- <issue-1>
...
逐条在产物里给出回应（写入 modifications[] 或对应章节），未回应的不算完成。
```

### 2.3 返回契约

- A1–A5：`STAGE_SCHEMA`（`stage`、`bundleId`、`version`、`status`、`files[]`、`counts`、`blocked[]`、`needHuman[]`、`gateSignals`、`conclusion`、`next`）。
- A0 校验：`VERIFY_SCHEMA`（`passed`、`stateAfter`、`checks[]`、`failures[]`、`blockedReasons[]`、`manifestWrites[]`）。
- A0 Preflight：`PREFLIGHT_SCHEMA`（`repoRoot`、`state`、`mode`、`artifacts[]`、`baseline`、`stop`、`portfolio`）。
- A0 读修订指令：`REVISION_SCHEMA`（`targetAgent`、`round`、`issues[]`、`invalidated[]`、`stop`）。

`agent()` 可能返回 `null`（用户跳过、子代理终端错误）。脚本按「未产出」处理：重试一次，两次都空则停止，不得按成功推进。

### 2.4 产物校验六步（阶段推进前必做，由 `etp-awf-controller` 执行）

1. **文件齐全**：该阶段 `artifact-protocol.md` 规定的文件都存在（`ls` 实际目录，不看自报）。
2. **字段齐全**：必填字段非空；ID 前缀与版本号合法；bundle 内版本一致。
3. **引用闭合**：所有 `*_ref` / `rule_refs` / `impact_refs` / `references` 指向存在的 ID 与版本。
4. **职责边界**：A1 只做获取与过滤；A2 没有代码影响；A3 没有实现方案；A4 没有新增需求；A5 没有改设计内容。越界即 fail。
5. **一致性检查**：执行 `gates-and-checks.md` 中该阶段适用的 C 规则，逐条记录 `pass/fail/not_applicable + 证据`：
   - A1 → C13、C14
   - A2 → C01、C02
   - A3 → C03、C04
   - A4 → C05、C06、C07、C11、C15
   - A5 → C08、C09、C12、C15
6. **登记**：为每个文件算 sha256 并更新 `artifact-manifest.yaml`（bundle、version、files、sha256、dependencies、status）；更新 `workflow-manifest.yaml`（artifacts、status、current_stage、review_rounds）；把本次执行与校验结果追加到 `00-workflow/workflow-report.md`。

任一项失败：**不推进状态**，把失败原因写回 `workflow-manifest.yaml` 与 `workflow-report.md`；脚本重试一次，仍失败则置 `BLOCKED`。无法判定的规则转人工，不得默认 pass。

## 3. 门禁

- `/etp-awf-gate G1`：确认后端范围（ART-11）、范围、规则、存量行为变化、推断项、验收标准、获取缺口、阻断问题。
- `/etp-awf-gate G2`：确认高风险数据写路径、权限、多租户、对外契约、特殊租户、证据缺口。
- `/etp-awf-gate G3`：确认 A5 无阻断项、G1/G2 已完成、检查项结论完整、覆盖矩阵完整、发布回滚完整。

阻断项判定口径见 `gates-and-checks.md`。命令必须先展示阻断项与待决策项，然后等待用户明确选择；**禁止代替用户填写审批人与结论**。

审批通过后写 `workflow-manifest.yaml` 的 `approvals`，并记录：结论、审批人、时间、说明、决策项、接受的风险缺口。

脚本侧的配合：进入 `WAITING_G1/G2/G3` 时返回停点，`gate` 字段给出门禁名，`gatePreview` 给出该阶段子代理上报的待决策/阻断项摘要（只作展示，不构成通过与不通过）。门禁由 `/etp-awf-gate` 执行完毕后把状态改成下一阶段，脚本下次运行从新状态继续。

**draft 模式**：可跳过 G1/G2/G3，但这些产物必须带 `DRAFT` 标记，且不得作为开发交接依据（CLAUDE.md 硬性规则 10）。

## 4. 增量重跑

用户修改产物或基线变化时，先分类再决定重跑范围，禁止「从某阶段开始全量重跑并保留旧产物」。

| 变更 | 重跑 | 重验门禁 |
| --- | --- | --- |
| 原始需求快照（US 变更） | A1→A5 | G1/G2/G3 |
| 后端范围/剔除项 | A1→A5 | G1/G2/G3 |
| A2 业务规则/范围/AC | A2→A5 | G1/G2/G3 |
| A2 纯文字 | 仅记录，重渲染文档 | 无 |
| A3 触点/证据 | A3→A5 | G2/G3 |
| A4 设计/ADR/文件清单 | A4、A5 | G3 |
| A5 评审结论 | A5 | G3 |
| 检查项清单变化 | 按检查项适用阶段 | 相关门禁 |
| 上游 US 产物变化 | 下游 A4、A5 | G2/G3 |
| 代码基线变化（人工更新） | 按触点交集判断，命中则 A3→A5 | G2/G3 |

失效产物标 `STALE` 并记录原因；恢复前不得用于 G3。批量失效后用 `/etp-awf-rerun` 指定起点，脚本按 `forceStage` 校验起点与 manifest 状态是否一致，不一致直接报错（防止跳过上游）。

### 评审回流（DESIGN_REVISION 分支）

A5 结论为 `FAIL` 时：

1. 读 `05-review/revision-instructions.yaml`，取 `target_agent` 与 `issues[]`。
2. 状态置 `DESIGN_REVISION`，把 `invalidated_artifacts` 标记 `STALE`。
3. 只重派目标阶段，并把 `issues` 原文作为 `revision` 传入派发 prompt。
4. 目标阶段必须逐条回应修订指令，写入 `modifications[]` 或对应章节。
5. 重跑 A5。

轮次写在 `workflow-manifest.yaml.review_rounds`。超过 2 轮仍 FAIL：写 `05-review/DISPUTE.md`，状态置 `BLOCKED`，停止自动循环。

## 5. 多 US 批次

批次不是把多个 US 简单并行，必须先登记关系（ART-04）：

- `depends_on`：上游 US 的产物是下游输入。A1/A2/A3 可并行，**A4 必须串行**，下游读取上游已冻结的接口/表/契约产物。
- `conflicts_with`：互不依赖但改同一文件、表、接口、消息、配置或权限点。同方法/表/契约冲突强制串行设计并合并 G2。
- `none`：可完全并行，默认并行度 3。

规则：

1. 每个 US 目录独立，跨 US 只读上游已冻结产物；编号带 US 前缀。
2. 上游产物新版本 → 下游标 `STALE`，人工确认是否重跑。
3. A3 发现未登记的重叠 → 写 `CONFLICT` 并回写 portfolio，由人工确认关系，不自行改排程。
4. 上游未完成时下游停在 `WAITING_DEPENDENCY`，不占用并行槽位。
5. 批次完成条件：每个 US 达到单 US DoD，冲突全部关闭，依赖链完成或显式声明不在本期。

脚本侧：Preflight 读出 `depends_on` 上游状态；上游未完成时返回 `WAITING_DEPENDENCY` 停点，不会越序派发 A4。跨 US 的实际并行由人按批次调度多次调用 `/etp-awf-run`，脚本单次只处理一个 US。

## 6. 异常处理

| 情况 | 处理 |
| --- | --- |
| 获取平台不可达 / 鉴权失败 | 停在 `A1_RUNNING`，置 `BLOCKED`，不得空跑后续阶段 |
| 附件或图片无法解析 | 登记 gap 后继续；影响后端范围判断时不得进入 A2 |
| 外部链接失效或需登录 | 登记 gap，人工补充或明确忽略 |
| 图谱不可用 | 用 `etp-code-graph-query` 的静态检索降级，证据类型写 `static_analysis`，记录 `degraded` |
| 图谱与代码不一致 | 以基线 commit 代码为准，记录 drift，相关结论不得标 `final` |
| 检查项清单不可用 | 置 `BLOCKED`，不得跳过检查推进 |
| US 与规范冲突 | A2 输出 `conflicts[]`，G1 阻断 |
| 关键歧义 | A2 生成 blocking open question，G1 阻断 |
| 高风险缺证据 | A3 写 `evidence_gap`，G2 强制人工确认或补证 |
| 运行时数据不可用 | 标 `NEEDS_RUNTIME_CONFIRM`，禁止断言无影响 |
| 在途变更或跨 US 冲突 | A3 输出 `in_flight_conflicts[]` / `CONFLICT`，交人工裁决 |
| A4 无法复用现有封装 | 写 `compatibility.deviations[]` 并交 G3 人工确认 |
| 子代理失败 / 返回空 | 保留已写产物，记录 `00-workflow/workflow-report.md`；脚本重试一次，仍失败置 `BLOCKED` |
| 人工修改上游 | 按 §4 失效下游，禁止静默继续 |
| `forceStage` 与 manifest 状态不一致 | 脚本报错退出，不改任何产物；先 `/etp-awf-rerun` 让状态回到目标阶段 |
| token 预算不足 | 返回 `max_actions` 停点，不改状态；补充预算后重新 `/etp-awf-run` |

## 7. 完成条件

G3 通过时同时满足：

- `workflow-manifest.yaml.status = COMPLETED`
- 五个阶段产物状态均为 `final`，版本与依赖一致
- A5 无 open 阻断项，或条件已全部 closed
- 适用检查项全部有结论，无遗漏
- G1/G2/G3 审批记录完整
- `00-workflow/workflow-report.md` 含每阶段执行、校验、门禁与人工操作记录
- 交付包目录结构与 `artifact-protocol.md` 一致
- 批次模式：`portfolio.yaml` 冲突全部关闭

脚本在 `COMPLETED` 状态返回停点（不再自动推进），交付摘要由 `/etp-awf-status` 输出。
