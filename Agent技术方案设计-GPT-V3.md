# 基于多 Agent 的存量 Spring Boot SaaS 系统需求分析与技术设计工作流

**文档版本：** V3.0（基于 V2.0 评审结论修订）

**建设范围：** 基础设施与分析基线 → US 输入 → 需求澄清 → 代码影响分析 → 技术方案设计 → 设计评审 → 人工审批 → 技术方案正式交付

**与原版本关系：** 本文为独立可交付的新版本，原 `Agent技术方案设计-GPT-V2.md` 保持不变。V2 → V3 的修订对照见 §17.2。

---

## 修订说明

V2 的流程骨架（事实/推断分离、证据溯源、分析基线、人工门禁、增量重跑、独立评审、SaaS 专项、DoD）予以保留。V3 集中修复了评审中发现的四类问题：

| 类别 | V2 问题 | V3 处理 |
| --- | --- | --- |
| 落地性 | 知识图谱、规范库、Skill、运行时证据被写成"假设/建议/可选"，未进入建设范围与排期 | §1.3、§3.1、§15 明确列为建设项并指定 owner 与 SLA |
| 可信度 | 证据链是 LLM 自述、C 规则只有声明没有执行主体、A4 与 A2 查同一份图谱无法避免共同盲区 | 新增 Evidence Verifier（§3.6）、Gate Engine（§3.7）、A4 差异化验证工具（§8.1） |
| 一致性 | PARTIALLY_APPROVED / CONDITIONAL_PASS 未落地、状态机覆盖不了回流、依赖图漏边、双产物无单一事实源、示例与规范互相矛盾 | §0 统一词汇、§4.4 顶层状态机、§10.1 单一事实源、§10.3 修正依赖图、全文示例重制 |
| 完整性 | 缺评估体系、模型/成本/上下文预算、安全与数据治理、审批超时、并发控制、审计留痕、风险裁剪 | §1.5、§2.4、§3.9、§3.10、§3.12、§4.9、§9.5、§12.5 补齐 |

---

# 0. 阅读约定与全局词汇表

全文必须严格遵守本节定义。任何章节、示例、Schema 不得引入本表之外的同义枚举。

## 0.1 引用与版本格式

| 约定 | 格式 | 示例 |
| --- | --- | --- |
| 逻辑产物引用 | `ART-XX:vN` | `ART-10:v2` |
| 文件表示引用 | `ART-XX:vN#yaml` / `ART-XX:vN#markdown` | `ART-10:v2#yaml` |
| 规则引用 | `R-NNN` / `AC-NNN` | `R-001`、`AC-001` |
| 影响引用 | `IMPACT-NNN` / `EVIDENCE-NNN` | `IMPACT-001` |
| 设计引用 | `DESIGN-NNN` / `ADR-NNN` / `FILE-NNN` | `DESIGN-001` |
| 门禁规则引用 | `C-NN` | `C03`、`C13` |
| 基线引用 | `BASE-NNN` | `BASE-001` |
| 版本语义 | `vN`，N 从 1 递增；`v0` 仅用于"已创建但未完成"的占位 | `ART-20:v0` |

## 0.2 三层状态词汇（不得混用）

| 层 | 字段 | 枚举 | 归属 |
| --- | --- | --- | --- |
| 流程级 | `workflow_state` | 见 §4.4 状态机表 | ART-00 |
| 产物级 | `artifact_status` | `DRAFT` / `VALID` / `STALE` / `INVALIDATED` | ART-02、各产物 |
| 评审级 | `review_conclusion` | `PASS` / `CONDITIONAL_PASS` / `FAIL` | ART-40 |

`DRAFT` / `FINAL` 是**运行模式**（§12），不是产物状态，也不是流程状态；用 `run_mode` 表示。

## 0.3 其它统一枚举

| 枚举 | 取值 | 说明 |
| --- | --- | --- |
| `approval_status` | `PENDING` / `APPROVED` / `REJECTED` / `PARTIALLY_APPROVED` / `TIMED_OUT` / `WAIVED` | `WAIVED` 仅用于 T0 快速通道的 G2，须记录理由 |
| `risk_level` | `BLOCKER` / `HIGH` / `MEDIUM` / `LOW` / `INFO` | 全大写，由 §6.5 规则表确定性判定 |
| `verification_status` | `VERIFIED` / `FAILED` / `UNVERIFIED` / `NEEDS_RUNTIME_CONFIRM` / `PENDING` | 前四项由 Evidence Verifier 产出；`PENDING` 仅用于 `conditions[]` 的初始态，复核后改为 `VERIFIED` |
| `source_type` | `explicit` / `inferred` / `existing` / `historical` | 与 V2 一致，仅用于 A1 规则来源 |
| `decision_status` | `confirmed` / `pending` / `rejected` / `scope_excluded` | `scope_excluded` 用于 PARTIALLY_APPROVED 待定规则 |
| `impact_status` | `PENDING_G2` / `CONFIRMED` / `REJECTED` | ART-20 影响点处置状态 |
| `issue_status` | `OPEN` / `FIXED` / `ACCEPTED` | ART-40 阻断问题状态 |
| `question_status` | `RESOLVED` / `DEFERRED` / `REJECTED` | ART-12 中 Open Question 处置结果 |
| `change_tier` | `T0` / `T1` / `T2` | 由 A0 依据 §2.4 规则表确定性判定 |
| `evidence_type` | `graph_query` / `static_analysis` / `git_history` / `runtime_trace` / `documentation` / `manual_confirmation` | 去掉 V2 中把"缺少证据"当作证据类型的 `needs_runtime_confirm` |

字段名约定：上表字段在跨章节引用时一律使用其定义名，不得简写为 `status`。局部状态字段（如 `documents[].status`、`claim_status`、`include_runtime_evidence`）在各自定义章节声明；§0.2 的三层状态词汇为全局约束，任何章节不得另立同义字段。文档生命周期中的 `DRAFT` 特指文档未生效，与 `artifact_status: DRAFT` 无关。

## 0.4 术语

- **逻辑产物（Artifact）**：带唯一 `ART-XX` 编号、独立版本、可被引用和失效的最小单元。
- **文件表示（Representation）**：同一逻辑产物的 YAML 事实源与 Markdown 渲染件，共享 `artifact_id` 与 `version`（§10.1）。
- **事实源（Source of Truth）**：YAML 表示。Markdown 由 A0 确定性渲染，禁止人工直接编辑。
- **确定性组件**：不调用 LLM、输出可复现的组件（Evidence Verifier、Gate Engine、渲染器、覆盖矩阵计算器、风险分级器）。

---

# 1. 项目背景与建设目标

## 1.1 项目背景

当前系统是一个约 10 年历史的 Spring Boot SaaS 系统，长期迭代积累了大量历史业务逻辑、技术封装、模块依赖、兼容性处理和特殊租户逻辑。

现有研发流程：

1. 产品经理提交经过初步分析的 User Story（US）。
2. 研发人员理解需求，分析涉及的业务模块和代码。
3. 研发人员梳理代码影响范围、存量功能影响及潜在风险。
4. 输出详细技术设计方案。
5. 组织技术评审会议。
6. 评审通过后，将技术设计方案交接给其他开发人员实施。

上述工作高度依赖个人经验，需要投入大量时间理解历史代码、梳理调用关系和分析潜在影响。计划通过多 Agent 协作系统将其标准化、自动化。

## 1.2 建设目标

构建一套 AI Software Engineering Workflow，通过多个职责明确的 Agent 协同工作，实现：

- 自动理解产品 US。
- 结合业务规范和代码知识图谱补充需求上下文。
- 识别需求中的歧义、冲突和遗漏。
- 自动分析存量代码的修改范围及功能影响。
- 识别数据库、缓存、消息、API、权限及多租户风险。
- 自动生成符合项目技术规范的详细设计方案。
- 自动检查需求、影响分析和技术设计之间的一致性。
- 支持人工修改、确认、审批及断点重跑。
- 输出可直接用于开发交接的正式技术设计。

## 1.3 本期建设范围

V2 遗漏了编排层与全部基础设施，V3 将其纳入范围并明确 owner。

| 模块 | 内容 | Owner | 是否本期建设 |
| --- | --- | --- | --- |
| 基础设施 | 代码知识图谱、业务规范与领域知识库、框架 Skill 与仓库规范、运行时证据通道 | 平台/架构组 | 是（§3.1） |
| 确定性组件 | Evidence Verifier、Gate Engine、Markdown 渲染器、覆盖矩阵计算器、风险分级器 | 平台组 | 是（§3.6、§3.7） |
| A0 | 编排状态机、分析基线、产物清单、上下文装配、人工修改检测、增量重跑、审批审计 | 平台组 | 是 |
| US 输入 | US 解析与登记、全局 US 注册表 | A0 | 是 |
| A1 | 需求澄清 | 平台组 | 是 |
| G1 | 需求确认门禁 | 研发负责人 | 是 |
| A2 | 代码影响分析 | 平台组 | 是 |
| G2 | 高风险影响确认门禁 | 研发负责人 | 是 |
| A3 | 技术设计 | 平台组 | 是 |
| A4 | 独立设计评审 | 平台组 | 是 |
| G3 | 正式技术设计审批门禁 | 技术负责人 / 架构师 | 是 |
| A5–A8 | 编码、代码审查、测试、发布 Agent | — | 否，后续建设 |

## 1.4 非目标

- 不替代产品经理决定业务需求（§16 第 1 条）。
- 不自动合并代码、不自动发布。
- 不承诺覆盖运行时动态行为的全部场景；无法验证的部分必须显式标记（§3.5）。
- 不把知识图谱建设当作既定前提，它是本期建设项（§3.1）。

## 1.5 成功度量

V2 把质量评估放到最后阶段且无指标。V3 把度量前置：指标定义见 §12.5，**基线评测必须在第二阶段（A2 上线时）完成**，未达阈值不得进入第三阶段（A3/A4）。

| 指标 | 初始阈值 | 采集方式 |
| --- | --- | --- |
| 影响分析召回率（P0 历史 US 回归集） | ≥ 0.90 | 与人工历史影响清单比对 |
| 影响分析精确率 | ≥ 0.80 | 人工复核误报 |
| 证据幻觉率 | ≤ 0.02 | Evidence Verifier 的 `FAILED` 占比 |
| 门禁漏放率 | = 0 | Gate Engine 规则执行日志 |
| 设计覆盖完整率 | = 1.00 | 覆盖矩阵确定性计算 |
| 推断误确认率 | ≤ 0.05 | G1 人工裁决记录 |
| A4 回流到 A1/A2 的比例 | ≤ 0.15 | Workflow Report |

阈值为初始值，第二阶段基线评测后由技术负责人校准并记录为 ADR。

---

# 2. 总体工作流与核心原则

## 2.1 角色

| 角色 | 类型 | 职责 |
| --- | --- | --- |
| A0 Orchestrator | 编排 Agent | 状态机、基线、上下文装配、产物登记、确定性校验调度、门禁流转、审计 |
| A1 | 业务 Agent | 需求澄清 |
| A2 | 业务 Agent | 代码影响分析 |
| A3 | 业务 Agent | 技术设计 |
| A4 | 评审 Agent | 独立设计评审 |
| G1 / G2 / G3 | 人工门禁 | 需求确认 / 高风险影响确认 / 正式设计审批 |
| 确定性组件 | 非 LLM | Evidence Verifier、Gate Engine、渲染器、覆盖矩阵计算器、风险分级器 |

A0 不直接承担业务分析和技术设计，但负责所有机器可判定的校验。

## 2.2 工作流

```mermaid
flowchart TD
    START[US 输入] --> REG[A0 登记 US / 判定 change_tier]
    REG --> BASE[A0 建立 Analysis Baseline]
    BASE --> EVG{图谱与基线校验}
    EVG -->|落后超 SLA 且影响已分析触点| SYNC[图谱增量同步 / 重新基线化]
    SYNC --> BASE
    EVG -->|通过| A1[A1 需求澄清]
    A1 --> G1{G1 需求确认}
    G1 -->|REJECTED| A1
    G1 -->|PARTIALLY_APPROVED| SCOPE[A0 排除待定规则范围] --> A2
    G1 -->|APPROVED| A2[A2 代码影响分析]
    A2 --> RT{运行时证据}
    RT -->|数据源不可用| WAIT[WAITING_RUNTIME_EVIDENCE] --> A2
    RT -->|可用/已降级| VRF[Evidence Verifier 校验]
    VRF -->|存在 FAILED 且命中 BLOCKER| ESC[ESCALATED 人工处理]
    VRF -->|通过| G2{G2 高风险确认}
    G2 -->|REJECTED| A2
    G2 -->|APPROVED| A3[A3 技术设计]
    A3 --> A4[A4 独立评审]
    A4 -->|FAIL / 阻断项| ROUTE{问题归属}
    ROUTE -->|需求问题| REV1[REQUIREMENT_REVISION] --> A1
    ROUTE -->|影响遗漏| REV2[IMPACT_REVISION] --> A2
    ROUTE -->|设计问题| REV3[DESIGN_REVISION] --> A3
    A4 -->|CONDITIONAL_PASS| CRES[CONDITIONAL_RESOLUTION 条件落实与复核] --> A4
    A4 -->|PASS| G3{G3 正式审批}
    G3 -->|退回修改, 计数未超上限| A3
    G3 -->|超过退回上限| ESC
    G3 -->|正式通过| FINAL[冻结版本 / 正式交付]
    REV1 -.超上限.-> ESC
    REV2 -.超上限.-> ESC
    REV3 -.超上限.-> ESC
    ESC --> ART43[ART-43 争议报告]
    BASE -.-> ARTS[(全部产物 + 基线)]
    A1 -.-> ARTS
    A2 -.-> ARTS
    A3 -.-> ARTS
    A4 -.-> ARTS
```

流程级状态与转换的完整定义见 §4.4；本图仅表达主要流转。T0 快速通道的精简路径见 §12.3。

## 2.3 核心原则

1. **需求真实性优先**：Agent 可以发现遗漏，但不能擅自决定业务需求。
2. **代码证据优先于模型推断**：所有重要影响结论都必须具备**经 Evidence Verifier 校验通过**的证据；证据不足必须显式标记，不得依赖 LLM 自述。
3. **存量行为保护优先**：不能因为实现新需求而无意破坏已有业务行为。
4. **设计决策必须可解释**：重要技术方案必须有明确的选择依据、备选方案及影响。
5. **审查必须具备独立性**：A4 不得仅依赖 A1、A2、A3 已生成的结论，且必须使用与 A2 不同的验证工具（§8.1）。
6. **人工审批拥有最终决策权**：需求、重大影响和正式技术设计均由对应负责人确认，审批对象必须包含机器产物。
7. **全流程必须可追溯**：任何一项设计都能追溯到需求规则、代码证据和技术决策。
8. **自动化不等于无门禁**：Agent 可以自动完成分析和设计，但不能自行突破业务和技术审批边界。
9. **机器可判定的事不由 LLM 判定**：结构校验、引用验证、覆盖计算、风险分级、状态流转一律由确定性组件执行。

## 2.4 变更分级与快速通道

V2 对所有 US 不加区分地执行全量流程。V3 由 A0 依据下表**确定性判定** `change_tier`，Any `BLOCKER` 命中强制升为 T2。

| 判定条件（命中任一即升级） | 等级 |
| --- | --- |
| 涉及对外 API / MQ 契约、DB Schema 迁移、权限模型、多租户隔离、计费逻辑、数据批量读写 | T2 |
| 跨模块调用、涉及框架封装变更、存在 `HIGH` 风险触点 | T2 |
| 单模块内部逻辑、无契约与数据变更 | T1 |
| 仅配置值、文案、纯展示字段调整，且无契约/数据/权限变更 | T0 |

| 等级 | A1 | A2 | G2 | A3 | A4 | G3 |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | 精简（仅规则与 AC） | 跳过深度分析，仅生成最小触点清单 | `WAIVED`（记录理由） | 精简 | 仅执行第一层覆盖审查 | 单人审批 |
| T1 | 完整 | 完整 | 完整 | 完整 | 完整，独立检索配额减半 | 完整 |
| T2 | 完整 | 完整 | 完整 | 完整 | 完整 + 全量独立检索 | 完整 |

`change_tier` 记录在 ART-00，并由 Gate Engine 复核；等级只能升不能降。T0 仍须生成最小产物集并保留完整追溯链，不得跳过基线、Evidence Verifier 与 G3。

---

# 3. 基础设施与共享能力

V2 用"假设已建设完成 / 建议提供 / 可选"描述本章全部内容，导致核心依赖无范围、无排期、无 owner。V3 全部改为明确的本期建设项。

## 3.1 建设清单与 Owner

| 编号 | 能力 | 内容 | Owner | 完成节点 |
| --- | --- | --- | --- | --- |
| INF-01 | 代码知识图谱 | 静态调用图、数据读写、契约、配置、多租户路径 | 平台/架构组 | §15 第一阶段 |
| INF-02 | 业务规范与领域知识库 | 规范、领域词典、历史设计、特殊租户知识 | 架构组 + 产品 | §15 第一阶段（最小集）、第四阶段（增强） |
| INF-03 | 框架 Skill 与仓库规范 | 公共封装说明、AGENTS.md | 架构组 | §15 第一阶段 |
| INF-04 | 运行时证据通道 | Trace / SQL / 配置只读查询，含脱敏 | 平台组 | §15 第二阶段 |
| INF-05 | Evidence Verifier | 引用解析与校验 | 平台组 | §15 第一阶段 |
| INF-06 | Gate Engine | C 规则、覆盖矩阵、风险分级、一致性校验 | 平台组 | §15 第一阶段 |
| INF-07 | 渲染器 | YAML → Markdown 确定性渲染 | 平台组 | §15 第一阶段 |
| INF-08 | 全局 US 注册表 | 并发 US 与文件占用登记 | 平台组 | §15 第一阶段 |
| INF-09 | 评估回归集 | 历史 US + 人工影响清单 ground truth | 架构组 | §15 第二阶段 |

## 3.2 代码知识图谱

图谱必须绑定到具体 commit，并支持以下查询：`find_entry_points`、`blast_radius`、`data_read_write_paths`、`api_contracts`、`message_consumers`、`feature_flags`、`config_references`、`permission_checkpoints`、`tenant_context_paths`、`cross_module_calls`、`historical_changes`、`special_tenant_logic`。

查询返回必须包含证据元数据，禁止只返回自然语言描述：

```yaml
evidence:
  evidence_id: EVIDENCE-001
  type: graph_query
  query: blast_radius
  graph_version: graph-20261115-003
  commit: a1b2c3d
  nodes: [graph-node-001, graph-node-002]
  confidence: HIGH
  verification_status: VERIFIED   # 由 Evidence Verifier 填写，非图谱自述
```

**已知能力边界（必须在产物中披露）**：图谱主要反映静态代码关系，不能完整代表生产行为。以下场景必须标记 `NEEDS_RUNTIME_CONFIRM` 或 `UNVERIFIED`，不得给出 `VERIFIED`：反射/动态代理调用、按配置条件装配的 Bean、动态 SQL、MQ 订阅的运行时拓扑、多租户分支、定时任务、外部系统回调、历史兼容性开关。

## 3.3 业务规范与领域知识库

每份文档独立管理元数据，禁止用单一版本号代表整个知识库（V2 的 `documentation.version` 无法满足逐文档有效性判定）：

```yaml
documents:
  - doc_id: DOC-refund-policy
    version: v4.2
    status: ACTIVE            # ACTIVE / DEPRECATED / DRAFT
    effective_from: 2026-09-01
    deprecated: false
    applicable_modules: [order, refund]
    path: docs/refund-policy.md
    content_hash: sha256:...
  - doc_id: DOC-tenant-vip
    version: v1.0
    status: ACTIVE
    deprecated: false
    applicable_modules: [tenant]
    path: docs/tenant-vip.md
    content_hash: sha256:...
```

历史文档不得直接作为当前系统事实。A0 在建基线时按 `applicable_modules` 与 `status` 筛选，Gate Engine 按 C14 校验"无 DEPRECATED 文档被引用"。文档有效性由架构组维护，写入 ART-01。

## 3.4 框架 Skill 与仓库规范

- 每个 Skill 有独立 `skill_id`、`version`、`content_hash`、`applicable_modules`、`status`。
- `AGENTS.md` 作为仓库规范纳入分析基线（V2 未纳入，属于未钉住的隐式输入），字段同 §3.3。
- **A3 必须在 ART-30 中记录实际引用的 Skill 版本**（§7.6），由 Gate Engine 按 C14 校验与基线一致。

## 3.5 运行时证据

| 项目 | 规定 |
| --- | --- |
| 数据源 | 链路追踪、SQL 访问记录、配置中心快照、API 访问记录，均为只读 |
| 触发 | `include_runtime_evidence: required / auto / off`；`auto` 定义为"由 A0 依据 `change_tier` 与 §6.5 风险规则确定性判定"，不是模型判断 |
| 获取方式 | A2 通过只读工具直接查询；不采用"Agent 提出申请后等待"的模糊机制 |
| 不可用 | 进入 `WAITING_RUNTIME_EVIDENCE`（§4.4），SLA 1 个工作日；超时后仅当无 `BLOCKER` 命中时打 `NEEDS_RUNTIME_CONFIRM` 继续，否则转 `ESCALATED` |
| 数据治理 | 租户标识哈希化、不落地原始 PII、最小权限账号、查询全量审计 |

运行时证据是对静态图谱的补充，不是替代。V2 §3.4 的八类盲区场景清单保留作为触发条件。

## 3.6 Evidence Verifier（新增，确定性组件）

解决"证据链只是 LLM 自述"的核心组件。它**不调用 LLM**，在 pinned commit 上做确定性验证。

| 校验项 | 规则 |
| --- | --- |
| 引用存在性 | `file:line` 必须指向基线 commit 中真实存在的文件与行；`graph-node-*` 必须存在于该 commit 对应的 `graph_version` |
| 内容一致性 | 计算引用片段的 `content_hash`，与 Agent 断言的 `expected_hash` 比对 |
| 基线一致性 | 每条证据的 `commit` / `graph_version` 必须等于 ART-01 基线值 |
| 版本一致性 | `documentation` / `skill_refs` 必须为基线内的 ACTIVE 项 |
| 运行时证据 | `trace_id` / SQL 采样 ID 必须能在数据源中解析到，且脱敏标记完整 |

输出 `verification_status` 写入 ART-22 与各产物证据条目：

| 结果 | 后果 |
| --- | --- |
| `VERIFIED` | 可作为 C 规则通过依据 |
| `FAILED` | 证据无效；该影响点不得进入 A3；命中 `BLOCKER` 时转 `ESCALATED` |
| `UNVERIFIED` | 仅允许出现在 `run_mode: DRAFT`，且必须打 `NEEDS_REVIEW` |
| `NEEDS_RUNTIME_CONFIRM` | 允许进入 A3，但必须写入 ART-30 的 `open_confirmations[]`，G3 前由人工确认 |

`FAILED` 比例即"证据幻觉率"（§1.5），由 Workflow Report 统计。

## 3.7 Gate Engine（新增，确定性组件）

V2 的 C01–C12 只有声明没有执行主体。V3 明确：全部 C 规则、覆盖矩阵、风险分级、MD↔YAML 一致性、Skill/文档有效性校验均由 Gate Engine 执行；A4 只做语义层审查，不得替代或复算确定性规则。

执行时机：每次产物版本变更后、每次门禁进入前、每次状态转换守卫判定前。执行结果写入 ART-00 `gate_results[]`，任一 `FAIL` 即阻断状态转换。

## 3.8 图谱同步 SLA 与基线冻结窗口

V2 规定"图谱与代码基线不一致即禁止 final"，在活跃仓库中会导致 final 永远无法产出。V3 改为可运转的策略：

| 机制 | 规定 |
| --- | --- |
| 冻结窗口 | G1 通过后 A0 锁定 `baseline.commit`，默认冻结 3 个工作日；窗口内新合入的 commit 进入 `pending_changes[]` 队列，不自动失效当前基线 |
| 图谱增量同步 | 代码合入后 2 小时内完成增量重建（变更文件及其直接调用方）；全量重建每周一次 |
| 重新基线化判定 | 冻结窗口到期或图谱落后超过 SLA 时，A0 比对 `pending_changes` 与已分析触点：影响已分析触点 → 定向重跑（§10.4）；不影响 → 记录 `superseded_commits[]` 并继续 |
| 禁止 final 的条件（修订） | 仅当 ① Evidence Verifier 存在 `FAILED`，或 ② 图谱落后超 SLA **且**差异命中已分析触点，或 ③ C14 基线有效性校验失败。仅 `graph_version` 与 commit 版本号不同但引用校验全部通过时，允许 final 并记录差异 |

## 3.9 模型分层、上下文预算与检索配额

V2 未提模型、成本、上下文与"检索预算"（仅在 V2 §17 出现过一次且无定义）。V3 用能力档位而非具体产品型号描述，便于替换。

| 档位 | 用途 | 说明 |
| --- | --- | --- |
| L1 | A0 编排、确定性组件的轻量分类、渲染后校验 | 高吞吐、结构化输出 |
| L2 | A1、A2、A3 常规分析与设计 | 长上下文 |
| L3 | A4 独立评审、争议裁决辅助 | 最强推理，独立配额 |

| Agent | 最大输入 tokens | `retrieval_budget`（独立配额） | 上下文由谁装配 |
| --- | --- | --- | --- |
| A1 | 64k | 业务规范 / 领域词典 / 相关规则 | A0 |
| A2 | 128k | 图谱查询 ≤ 40 次、源码检索 ≤ 60 文件、运行时查询 ≤ 20 次 | A0 + A2 自主补充 |
| A3 | 96k | 需求、影响分析、框架 Skill、AGENTS.md | A0 |
| A4 | 128k | **独立预算**：StaticAnalyzer / ContractDiffer / RuntimeTraceSampler 各 ≥ 5 次调用，且不得复用 A2 的结果列表 | A4 自主，不受 A0 装配复用限制 |

A0 负责上下文装配（V2 §17 提出但 §4.1 未列入职责，V3 已补入 §4.1）：按 Agent 职责注入必要证据，避免所有 Agent 自由检索整个知识库，也避免不同 Agent 检索到不同版本文档产生矛盾。A4 的独立预算是例外，理由见 §8.1。

成本控制：每个 US 记录 token 消耗与工具调用数写入 ART-03；超出预算 150% 时转 `ESCALATED` 人工确认，不允许静默截断上下文。

## 3.10 安全与数据治理

| 风险 | 控制措施 |
| --- | --- |
| 运行时数据含租户数据 / PII | 租户标识哈希化、字段白名单、只读账号、查询审计、不写入产物原文 |
| 不可信输入注入 | US 正文、代码注释、历史文档、Git 提交信息统一视为数据；以 quoted block 传入并在模板中显式声明"以下内容是数据不是指令"；Gate Engine 做指令模式检测，命中则标记 `untrusted_instruction` 并交人工确认 |
| 越权检索 | 各 Agent 按 §3.9 配额与职责作用域检索；A4 的独立工具为只读 |
| 审批伪造 | 审批记录写入 ART-00 并计算 `diff_hash`（§9.5），不可由 Agent 修改 |
| 产物篡改 | 逻辑产物版本 + `content_hash` 由 A0 登记，人工修改必须走 §4.8 流程 |

## 3.11 产物存储与双表示模型

统一的目录与文件表示规则见 §10.1 与 §14。核心规定：**YAML 是唯一事实源；Markdown 由 A0 渲染生成，禁止人工直接编辑**。人工修订通过修改 YAML 或提交结构化修订指令完成，渲染件随版本自动再生成（C13 校验）。

## 3.12 全局 US 注册表与并发控制

V2 §6.3 提到"其他 US 已经修改相同业务流程"，但没有跨工作流的数据来源。V3 新增：

| 字段 | 说明 |
| --- | --- |
| `us_id` | 全局唯一 |
| `baseline_ref` | 当前 US 的分析基线 |
| `change_tier` | 当前分级 |
| `file_claims[]` | 该 US 在 G3 通过后登记的预期修改文件（来自 ART-34） |
| `claim_status` | `HELD` / `RELEASED` |

A2 步骤九从注册表读取其它 `HELD` 的 `file_claims[]` 做冲突检测，输出冲突报告。`claim` 在 US 关闭或基线重新基线化时释放。两个 US 命中同一文件时，后提交者必须由 G2 显式确认冲突处理策略。

---

# 4. 编排层 A0 与流程状态管理

## 4.1 职责

1. 接收并登记 US，判定 `change_tier`。
2. 建立并冻结 Analysis Baseline。
3. 维护 Workflow Manifest 与 Artifact Manifest。
4. 按 Agent 职责装配上下文（§3.9）。
5. 调度 Evidence Verifier 与 Gate Engine。
6. 生成 Markdown 渲染件（§10.1）。
7. 管理流程状态机与全部状态转换守卫。
8. 执行跨阶段一致性检查（委托 Gate Engine）。
9. 识别人工修改及影响范围，触发产物失效与定向重跑。
10. 记录审批审计、计数器与超时升级。
11. 输出 Workflow Report、Escalation Report。

A0 不直接承担业务分析和技术设计。

## 4.2 输入

```yaml
us_id: US-2026-001
run_mode: FINAL                       # DRAFT / FINAL
workflow_config:
  include_runtime_evidence: auto     # required / auto / off
  change_tier_override: null         # 仅允许升级，不允许降级
  rerun_from: null                   # 指定产物版本继续执行的断点
  existing_artifacts: []
```

## 4.3 Analysis Baseline

```yaml
baseline_id: BASE-001
created_at: 2026-11-15T09:00:00Z
frozen_until: 2026-11-18T18:00:00Z    # 冻结窗口，§3.8
repository:
  branch: release/10.x
  commit: a1b2c3d
  code_hash: sha256:...
knowledge_graph:
  graph_version: graph-20261115-003
  built_at_commit: a1b2c3d
  sync_sla_hours: 2
documents:                            # 逐文档，§3.3
  - doc_id: DOC-refund-policy
    version: v4.2
    status: ACTIVE
    deprecated: false
    applicable_modules: [order, refund]
    content_hash: sha256:...
skills:                               # 逐 Skill，§3.4
  - skill_id: SKILL-refund-engine
    version: v3.2
    status: ACTIVE
    content_hash: sha256:...
  - skill_id: SKILL-saas-checklist
    version: v2.1
    status: ACTIVE
    content_hash: sha256:...
repo_policy:                          # AGENTS.md 纳入基线
  path: AGENTS.md
  commit: a1b2c3d
  content_hash: sha256:...
pending_changes: []
superseded_commits: []
```

**"有效分析基线"定义（C12 修订）**：同时满足 ① `knowledge_graph.built_at_commit == repository.commit` 或落后未超 SLA 且未命中已分析触点；② 被引用的 `documents[]` 全部 `ACTIVE` 且 `deprecated: false`；③ 被引用的 `skills[]` 全部 `ACTIVE`；④ Evidence Verifier 无 `FAILED`。

## 4.4 顶层状态机与转换表

V2 的状态机是线性列表，覆盖不了 A4→A1/A2 回流、条件落实、运行时等待、争议升级。V3 给出完整状态集与转换守卫。

| 状态 | 含义 |
| --- | --- |
| `CREATED` | US 已登记 |
| `BASELINE_BUILDING` | 图谱/规范同步、基线建立中 |
| `BASELINE_READY` | 基线有效 |
| `A1_RUNNING` | A1 执行中 |
| `WAITING_G1` | 等待 G1 |
| `G1_PARTIALLY_APPROVED` | G1 部分批准，A0 排除待定规则范围 |
| `A2_RUNNING` | A2 执行中 |
| `WAITING_RUNTIME_EVIDENCE` | 运行时数据源不可用，SLA 等待中 |
| `WAITING_G2` | 等待 G2 |
| `A3_RUNNING` | A3 执行中 |
| `A4_RUNNING` | A4 执行中 |
| `CONDITIONAL_RESOLUTION` | CONDITIONAL_PASS 条件落实与复核 |
| `DESIGN_REVISION` | A4 → A3 设计修订 |
| `REQUIREMENT_REVISION` | A4 → A1 需求回流 |
| `IMPACT_REVISION` | A4 → A2 影响回流 |
| `WAITING_G3` | 等待 G3 |
| `ESCALATED` | 争议/超上限/超时，转人工 |
| `COMPLETED` | 正式交付 |
| `BLOCKED` | 阻断等待外部条件 |

转换表（守卫由 Gate Engine 判定）：

| # | From | 事件 / 守卫 | To | 计数器 |
| --- | --- | --- | --- | --- |
| 1 | `CREATED` | 基线校验通过 | `BASELINE_READY` | — |
| 2 | `CREATED` | 基线校验失败且超 SLA | `BASELINE_BUILDING` | — |
| 3 | `BASELINE_READY` | 启动 A1 | `A1_RUNNING` | — |
| 4 | `A1_RUNNING` | ART-10 生成且 C01/C02 通过 | `WAITING_G1` | — |
| 5 | `WAITING_G1` | G1 `APPROVED` | `A2_RUNNING` | — |
| 6 | `WAITING_G1` | G1 `PARTIALLY_APPROVED` | `G1_PARTIALLY_APPROVED` | — |
| 7 | `WAITING_G1` | G1 `REJECTED` | `A1_RUNNING` | `g1_rejection_count++` |
| 8 | `G1_PARTIALLY_APPROVED` | A0 写入 `scope_excluded` 并复核 | `A2_RUNNING` | — |
| 9 | `A2_RUNNING` | 运行时数据源不可用 | `WAITING_RUNTIME_EVIDENCE` | — |
| 10 | `WAITING_RUNTIME_EVIDENCE` | 恢复 / 超时且无 BLOCKER | `A2_RUNNING` | — |
| 11 | `A2_RUNNING` | Verifier 通过、C03–C07 通过、无未决 BLOCKER | `WAITING_G2` | — |
| 12 | `A2_RUNNING` | Verifier `FAILED` 且命中 BLOCKER | `ESCALATED` | — |
| 13 | `WAITING_G2` | G2 `APPROVED` | `A3_RUNNING` | — |
| 14 | `WAITING_G2` | G2 `REJECTED` | `A2_RUNNING` | `g2_rejection_count++` |
| 15 | `A3_RUNNING` | ART-30/31/32/33/34 生成且 C08 通过 | `A4_RUNNING` | — |
| 16 | `A4_RUNNING` | `PASS` | `WAITING_G3` | — |
| 17 | `A4_RUNNING` | `CONDITIONAL_PASS` | `CONDITIONAL_RESOLUTION` | `revision_round++` |
| 18 | `CONDITIONAL_RESOLUTION` | 全部 `conditions[].verification_status == VERIFIED` | `A4_RUNNING` | — |
| 19 | `A4_RUNNING` | `FAIL` 且归属设计 | `DESIGN_REVISION` | `revision_round++` |
| 20 | `A4_RUNNING` | `FAIL` 且归属需求 | `REQUIREMENT_REVISION` | `baseline_rerun_count++` |
| 21 | `A4_RUNNING` | `FAIL` 且归属影响 | `IMPACT_REVISION` | `baseline_rerun_count++` |
| 22 | `DESIGN_REVISION` / `REQUIREMENT_REVISION` / `IMPACT_REVISION` | 修订产物重生成 | `A4_RUNNING` | — |
| 23 | `WAITING_G3` | G3 `APPROVED` | `COMPLETED` | — |
| 24 | `WAITING_G3` | G3 退回且 `g3_rejection_count < 2` | `A3_RUNNING` | `g3_rejection_count++` |
| 25 | 任意 | 计数器超上限 / 审批 `TIMED_OUT` / 人工请求 | `ESCALATED` | — |
| 26 | `COMPLETED` | 基线重新基线化且命中已分析触点 | `A2_RUNNING` | — |

计数器上限见 §4.10。

## 4.5 状态词汇映射

| 概念 | 字段 | 取值来源 |
| --- | --- | --- |
| 流程状态 | `workflow_state` | §4.4 状态集 |
| 产物状态 | `artifact_status` | §0.2，`STALE` 由 §4.8 触发，`INVALIDATED` 由重跑触发 |
| 评审结论 | `review_conclusion` | §0.2 |
| 运行模式 | `run_mode` | §12 |
| 审批状态 | `approval_status` | §0.3 |

`STALE` 是产物级状态，表示"依赖已变更但未重新计算"；`INVALIDATED` 表示"已被新版本替代"。`WAITING_*` 与 `ESCALATED` 是流程级状态，不写入产物状态字段。V2 中 `invalidated_artifacts` / `preserved_artifacts` 改为 ART-02 的 `artifact_status` 表达。

## 4.6 Workflow Manifest（ART-00）

```yaml
manifest_id: ART-00:v1
workflow_id: WF-2026-001
us_id: US-2026-001
run_mode: FINAL
change_tier: T2
workflow_state: WAITING_G1
current_stage: A1
baseline_ref: BASE-001
artifacts:
  - ART-10:v1
approvals:
  - gate: G1
    approval_status: PENDING
    approver_role: 研发负责人
    decided_at: null
    artifact_refs: [ART-10:v1, ART-12:v1]
    diff_hash: null
    comment: null
  - gate: G2
    approval_status: PENDING
    approver_role: 研发负责人
    decided_at: null
    artifact_refs: []
    diff_hash: null
    comment: null
  - gate: G3
    approval_status: PENDING
    approver_role: 技术负责人
    decided_at: null
    artifact_refs: []
    diff_hash: null
    comment: null
counters:
  revision_round: 0
  baseline_rerun_count: 0
  g1_rejection_count: 0
  g2_rejection_count: 0
  g3_rejection_count: 0
gate_results: []
blocked_reasons: []
pending_changes: []
```

注意：`WAITING_G1` 时只应存在 A1 阶段产物（V2 示例中该状态却列出了 `A2-001:v0`，已修正）。

## 4.7 门禁规则（由 Gate Engine 执行）

| 编号 | 规则 | 执行者 | FINAL 强制 | DRAFT 强制 |
| --- | --- | --- | --- | --- |
| C01 | A1 每条必须需求均有对应验收标准 | Gate Engine | 是 | 是 |
| C02 | 推断规则不得未经确认进入 A2 输入范围或最终需求；`scope_excluded` 规则不得被 A2/A3 引用 | Gate Engine | 是 | 是 |
| C03 | A2 每个必改触点必须关联至少一条 A1 规则或 AC | Gate Engine | 是 | 是 |
| C04 | A2 每个 `BLOCKER` / `HIGH` 触点必须有 G2 处置记录 | Gate Engine | 是 | 否（须打 `NEEDS_REVIEW`） |
| C05 | A3 每个必改触点必须有对应 DESIGN 与 FILE 条目 | Gate Engine | 是 | 是 |
| C06 | A3 每个对外契约变更必须有兼容策略 | Gate Engine | 是 | 是 |
| C07 | A3 数据设计必须包含迁移与回滚方案 | Gate Engine | 是 | 是 |
| C08 | ADR 必须包含候选方案、选择依据、影响、代价、风险及引用来源 | Gate Engine | 是 | 是 |
| C09 | 每个产物的 `dependencies[]` 必须指向本次基线内当前有效版本；被替代的历史版本记入 `superseded_refs[]`，不参与本规则判定 | Gate Engine | 是 | 是 |
| C10 | 人工修改的关键内容必须重新经过对应阶段确认 | Gate Engine | 是 | 否 |
| C11 | 所有产物输入版本与基线一致 | Gate Engine | 是 | 是 |
| C12 | FINAL 产物必须使用 §4.3 定义的有效分析基线 | Gate Engine | 是 | 否 |
| C13 | Markdown 渲染件必须与其 YAML 事实源的 `artifact_id`、`version`、`content_hash` 一致；禁止人工编辑渲染件 | Gate Engine | 是 | 是 |
| C14 | 产物引用的 `documents` / `skills` / `repo_policy` 必须为基线内 ACTIVE 项，且与 ART-30 `skill_refs[]` 一致 | Gate Engine | 是 | 是 |

DRAFT 模式可以跳过人工审批，但不能跳过产物结构校验；C04、C10、C12 在 DRAFT 下不强制，但必须打 `NEEDS_REVIEW` / `UNCONFIRMED` 标记（§12.1）。

## 4.8 人工修改检测与产物失效

V2 §4.7 与 §10.4 对"文字修改"的处理互相矛盾。V3 统一为按**变更类别**分级：

| 变更类别 | 判定 | 处理 |
| --- | --- | --- |
| 文字性 | 仅措辞、排版、拼写，不改变任何结构化字段的语义值 | bump 渲染版本，`artifact_status` 保持 `VALID`，下游不失效，C13 重新渲染即可 |
| 语义性 | 修改规则、AC、影响触点、设计说明、ADR 结论、风险等级 | 该产物 `INVALIDATED`，直接下游 `STALE`，按 §10.4 定向重跑 |
| 结构性 | 新增/删除规则、触点、DESIGN、文件清单、基线变更 | 全链路按 §10.4 重跑 |

A0 不能只依赖文件 Hash，必须比较结构化字段差异（含 `content_hash` 与逐字段 diff）。人工修改只能作用于 YAML 事实源或提交结构化修订指令；对渲染件的直接编辑由 C13 判为 `FAILED` 并自动回滚为重新渲染件。

## 4.9 审批超时与升级

| 门禁 | SLA | 超时处理 |
| --- | --- | --- |
| G1 | 2 个工作日 | 提醒 → `TIMED_OUT` → `ESCALATED` |
| G2 | 1 个工作日 | 同上 |
| G3 | 3 个工作日 | 同上 |
| `WAITING_RUNTIME_EVIDENCE` | 1 个工作日 | 按 §3.5 降级或 `ESCALATED` |

超时**不得自动批准**。每次提醒与超时写入 ART-00 审计记录。`ESCALATED` 时生成 ART-43。

## 4.10 计数器与上限（明确"两轮"口径）

V2 的"自动修订最多两轮"未定义计数对象，且 G3 退回无上限。V3 明确：

| 计数器 | 计入事件 | 上限 | 超限 |
| --- | --- | --- | --- |
| `revision_round` | `DESIGN_REVISION` 与 `CONDITIONAL_RESOLUTION` 各计 1 | 2 | `ESCALATED` |
| `baseline_rerun_count` | `REQUIREMENT_REVISION` 与 `IMPACT_REVISION` 各计 1 | 1 | `ESCALATED` |
| `g3_rejection_count` | G3 退回修改 | 2 | `ESCALATED` |
| `g1_rejection_count` / `g2_rejection_count` | 对应门禁 REJECTED | 3 | `ESCALATED` |

即"两轮"仅指 A4 触发的设计修订与条件复核；回流到 A1/A2 属于基线级回流，单独计数且上限更严；G3 人工退回另计。全部计数器记录在 ART-00，进入 `ESCALATED` 时写入 ART-43 争议报告（V2 中"争议报告"不是登记产物，已补）。

---

# 5. A1 需求澄清

## 5.1 目标与边界

- 只负责理解和澄清需求，不做技术设计。
- 不得将代码现状自动转化为产品需求；发现现状与目标不一致时，记录为 `existing` 事实并生成待确认问题。
- Agent 可以推断遗漏，但推断必须标记 `inferred` 且 `decision_status: pending`，由 G1 裁决。

## 5.2 输入

| 输入 | 说明 | 装配方 |
| --- | --- | --- |
| US 原文 | 产品提交 | A0 |
| 业务规范 / 领域词典 | §3.3 中 `applicable_modules` 命中的 ACTIVE 文档 | A0 |
| 代码知识图谱 | 仅用于发现潜在遗漏，不用于确认需求 | A0 |
| 历史设计文档 | 标记 `historical`，不得作为当前事实 | A0 |
| Analysis Baseline | ART-01 | A0 |

## 5.3 步骤

1. US 结构化拆解：目标、角色、触发条件、主流程、异常流程、约束。
2. 规则抽取：每条规则标注 `source_type`（`explicit` / `inferred` / `existing` / `historical`）与 US 原文引用。
3. 验收标准（AC）生成：每条必须需求至少一条可验证 AC。
4. 图谱辅助补漏：只发现潜在遗漏并生成 Open Question，不自动确认业务需求。
5. 歧义/冲突/遗漏识别：冲突必须指向具体 US 段落或规范 `doc_id`。
6. 现状与目标对比：差异记为 `existing` 事实 + 待确认项。
7. 输出 ART-10（YAML 事实源）与 ART-12 草案（Decision Log 草案，由 G1 定稿）。

每条规则必须包含：规则 ID、来源类型、来源引用、置信度、是否改变存量行为、是否需要人工确认、不处理可能造成的风险、`decision_status`。

## 5.4 ART-10 示例

```yaml
artifact_id: ART-10
version: 1
artifact_status: VALID
baseline_ref: BASE-001
representations:
  - format: yaml
    path: 01-requirement/requirement-package.yaml
    content_hash: sha256:...
  - format: markdown
    path: 01-requirement/requirement-clarification.md
    rendered_from: ART-10:v1#yaml
    content_hash: sha256:...
requirement_id: R-PKG-001
rules:
  - id: R-001
    description: 支持对已支付订单进行部分退款
    source:
      type: explicit
      reference: US-2026-001 §2.1
    confidence: HIGH
    behavior_change: true
    confirmation_required: false
    risk_if_ignored: 无法实现部分退款诉求
    decision_status: confirmed
  - id: R-002
    description: 部分退款后原优惠券是否返还（推断）
    source:
      type: inferred
      reference: graph-node-123
    confidence: LOW
    behavior_change: unknown
    confirmation_required: true
    risk_if_ignored: 优惠券重复发放或资损
    decision_status: pending
acceptance_criteria:
  - id: AC-001
    rule_refs: [R-001]
    description: 对已支付订单按指定金额部分退款成功，订单状态与金额正确
    verification: 接口返回成功且订单金额一致
    source: US-2026-001 §2.1
open_questions:
  - id: OQ-001
    rule_refs: [R-002]
    question: 部分退款时优惠券是否按比例返还？
    blocking: true
    target_gate: G1
scope_excluded_rules: []
```

说明：`decision_status: confirmed` 对 `explicit` 规则表示"来源明确、无需推断裁决"，最终确认仍以 G1 对 ART-12 的签署为准；`inferred` 规则一律 `pending`。`R-002` 未确认前由 C02 排除在 A2 输入范围之外（§5.5）。

## 5.5 G1 结果与 PARTIALLY_APPROVED

V2 定义了 `PARTIALLY_APPROVED` 却未落地到状态机、流程图、Manifest 与 C 规则。V3 完整落地：

| 结果 | 处理 |
| --- | --- |
| `APPROVED` | 全部规则进入 A2 范围 |
| `PARTIALLY_APPROVED` | 已确认规则进入 A2；待定规则写入 ART-10 `scope_excluded_rules[]` 并置 `decision_status: scope_excluded`，由 C02 禁止 A2/A3 引用；流程进入 `G1_PARTIALLY_APPROVED`，A0 复核排除后转 `A2_RUNNING`；待定规则可在后续 G1 复批解禁并触发定向重跑 |
| `REJECTED` | 返回 A1，`g1_rejection_count++` |
| `TIMED_OUT` | `ESCALATED`（§4.9） |

对于阻断核心流程、影响计费、权限或数据安全的问题，不允许以"保留假设"方式进入 FINAL 模式的 A2（V2 §5.5 允许"在最终方案中保留明确假设"，与 §5.6"不存在未经确认的推断需求"及 C02 冲突，V3 改为：假设只能存在于 `scope_excluded_rules[]`，且不得进入 A2 范围与最终设计）。

## 5.6 ART-12 Requirement Decision Log

**产生者统一为 G1**（V2 在 §10.1、§10.3、§14 中分别写成 G1、A1、A1/G1，已修正）。A1 仅输出 `draft` 草案，G1 签署后成为正式产物。

```yaml
artifact_id: ART-12
version: 1
gate: G1
decisions:
  - rule_id: R-001
    decision: confirmed
    decided_by_role: 研发负责人
    decided_at: 2026-11-15T11:20:00Z
    diff_hash: sha256:...
    comment: 与产品确认，按 US §2.1 实现
  - rule_id: R-002
    decision: scope_excluded
    decided_by_role: 研发负责人
    decided_at: 2026-11-15T11:20:00Z
    comment: 优惠券返还规则待产品确认，本期不纳入范围
open_questions_resolved:
  - question_id: OQ-001
    question_status: DEFERRED
```

ART-12 变更必须触发 §10.4 的定向重跑（V2 依赖图与重跑表均遗漏此项）。

## 5.7 完成条件

- ART-10 与 ART-12 已生成，C01/C02 通过。
- 所有**进入 A2 范围**的规则均已确认；推断规则均已裁决或 `scope_excluded`。
- 关键 Open Questions 已处理或显式 `DEFERRED` 并记录。
- G1 已完成（`APPROVED` 或 `PARTIALLY_APPROVED`）。

---

# 6. A2 代码影响分析

## 6.1 目标

基于已确认需求，分析存量代码的修改范围、功能影响与风险，输出可被 Evidence Verifier 校验的证据链。

## 6.2 输入

| 输入 | 说明 |
| --- | --- |
| ART-10 | 结构化需求（已按 §5.5 排除 `scope_excluded_rules`） |
| **ART-12** | 已确认的需求决策（V2 依赖图漏此边，已补） |
| 代码知识图谱 | 绑定到 BASE-001 的 commit |
| 仓库代码 | 同一 commit |
| Git 历史 | 兼容性处理、历史缺陷 |
| 运行时证据 | §3.5 |
| 项目规范 / 文档 | §3.3 ACTIVE 项 |
| 在途变更 | §3.12 全局 US 注册表中其它 `HELD` 的 `file_claims[]` 与未合并分支 |

## 6.3 步骤

1. 需求到代码入口映射。
2. 调用链与数据读写路径分析（`blast_radius`、`data_read_write_paths`）。
3. 静态代码验证：源码检索确认关键实现，不能仅凭图谱结论。
4. 运行时证据查询：按 §3.5 触发；不可用时进入 `WAITING_RUNTIME_EVIDENCE`。
5. 数据库 / 缓存 / 消息 / API / 权限 / 多租户逐项检查（§11）。
6. 存量行为对比：记录将被改变的行为及兼容性策略。
7. 预期影响清单：区分 `MUST_CHANGE` / `SHOULD_CHANGE` / `NO_CHANGE_BUT_AFFECTED`。
8. **风险分级：由 §6.5 规则表确定性判定，不得由 LLM 主观判断。**
9. 在途变更冲突检测：读取 §3.12 注册表，输出冲突报告。
10. 证据整理：每条影响点填入 §6.4 全部字段，提交 Evidence Verifier。

## 6.4 证据规范

每个影响点必须记录：证据类型、来源引用、对应文件/图谱节点、对应代码基线、结论置信度、是否需要人工确认、`verification_status`、风险等级。

`verification_status` 只能由 Evidence Verifier 写入；`NEEDS_RUNTIME_CONFIRM` 是**证据状态**，不是证据类型（V2 把它列为 `evidence_type`，已修正）。

## 6.5 风险等级确定性规则表（新增）

V2 承诺"风险等级不能仅由 LLM 主观判断"，却没给规则。V3 定义如下，由 Gate Engine 判定，命中多条取最高级：

| 等级 | 命中条件（任一） |
| --- | --- |
| `BLOCKER` | 涉及资金/计费计算；权限模型或鉴权绕过；多租户隔离边界；批量数据读写或数据迁移且无回滚方案；对外契约不兼容变更且无兼容策略；Evidence Verifier 对该触点返回 `FAILED` |
| `HIGH` | 跨模块调用链；对外 API / MQ 契约变更；缓存键或失效策略变更；共享表结构变更；框架公共封装被绕过；存在 `NEEDS_RUNTIME_CONFIRM` 且影响核心链路 |
| `MEDIUM` | 单模块内部逻辑变更；新增配置项；非核心链路的读写路径 |
| `LOW` | 文案、日志、纯展示字段 |
| `INFO` | 仅观察项，无需改动 |

## 6.6 BLOCKER 阻断规则

V2 允许 G2"标记为暂时无法确认"后继续，且 BLOCKER 不阻断 A3。V3 规定：

- `BLOCKER` 命中 → 不得进入 `WAITING_G2` 之前的 `A3_RUNNING`；必须先由 G2 裁决修复方案或转 `ESCALATED`。
- FINAL 模式下 `BLOCKER` **不允许被"明确接受"**，只能修复或升级；DRAFT 模式下可带 `NEEDS_REVIEW` 标记保留。
- "明确接受"仅适用于 `HIGH`，且必须由 G2 在 ART-00 写入 `risk_acceptance`（含 `approver_role`、`decided_at`、`diff_hash`、`理由`），并作为 ART-12 附件。

## 6.7 ART-20 / ART-22 示例

```yaml
# ART-20
artifact_id: ART-20
version: 1
artifact_status: VALID
baseline_ref: BASE-001
requirement_ref: ART-10:v1
decision_ref: ART-12:v1          # V2 缺失，依赖图亦漏边
impacts:
  - id: IMPACT-001
    rule_refs: [R-001]
    acceptance_refs: [AC-001]
    target: RefundService#partialRefund
    impact_type: MUST_CHANGE
    evidence:
      - evidence_id: EVIDENCE-001
        type: graph_query
        reference: graph-node-001
        commit: a1b2c3d
        graph_version: graph-20261115-003
        confidence: HIGH
        needs_human_confirmation: false
        verification_status: VERIFIED
        verifier_result_hash: sha256:...
      - evidence_id: EVIDENCE-002
        type: static_analysis
        reference: RefundService.java:120
        commit: a1b2c3d
        confidence: HIGH
        needs_human_confirmation: false
        verification_status: VERIFIED
        verifier_result_hash: sha256:...
    affected_features: [订单退款, 订单金额计算]
    risk: HIGH                    # 统一大写
    risk_rule_hits: [跨模块调用链, 共享表结构变更]
    confidence: HIGH
    needs_human_confirmation: false
    reason: 部分退款需新增金额拆分逻辑，影响订单金额计算链路
    constraints: 必须复用 SKILL-refund-engine v3.2
    impact_status: PENDING_G2
  - id: IMPACT-002
    rule_refs: [R-001]
    acceptance_refs: [AC-001]
    target: MQ 订单状态变更事件
    impact_type: NO_CHANGE_BUT_AFFECTED
    evidence:
      - evidence_id: EVIDENCE-003
        type: runtime_trace
        reference: trace-20261115-8891
        confidence: MEDIUM
        needs_human_confirmation: true
        verification_status: NEEDS_RUNTIME_CONFIRM
    risk: MEDIUM
    confidence: MEDIUM
    needs_human_confirmation: true
    reason: 退款金额变化可能影响下游对账，需运行时确认
    impact_status: PENDING_G2
risk_summary:
  BLOCKER: 0
  HIGH: 1
  MEDIUM: 1
open_confirmations: [IMPACT-002]
conflict_report:
  conflicting_us: []
```

```yaml
# ART-22
artifact_id: ART-22
version: 1
baseline_ref: BASE-001
verifier_run_id: VERIFY-20261115-001
results:
  - evidence_id: EVIDENCE-001
    status: VERIFIED
    checked_at: 2026-11-15T13:05:00Z
    resolved_reference: graph-node-001@graph-20261115-003
  - evidence_id: EVIDENCE-002
    status: VERIFIED
    checked_at: 2026-11-15T13:05:00Z
    resolved_reference: RefundService.java:120@a1b2c3d
    content_hash: sha256:...
  - evidence_id: EVIDENCE-003
    status: NEEDS_RUNTIME_CONFIRM
    checked_at: 2026-11-15T13:05:00Z
failed_count: 0
hallucination_rate: 0.0
```

## 6.8 G2 高风险确认

审批对象：`ART-20`、`ART-21`（渲染件）、`ART-22` 证据清单、`risk_summary` 与 `open_confirmations`。

| 结果 | 处理 |
| --- | --- |
| `APPROVED` | 进入 A3 |
| `REJECTED` | 返回 A2，`g2_rejection_count++` |
| `TIMED_OUT` | `ESCALATED` |

G2 必须对每条 `HIGH` 与 `BLOCKER` 给出处置：修复、或（仅 `HIGH`）写入 `risk_acceptance`。

---

# 7. A3 技术设计

## 7.1 目标

基于 ART-10/12/20/22 输出符合项目规范的详细技术设计，并覆盖全部必改触点。

## 7.2 输入

| 输入 | 说明 |
| --- | --- |
| ART-10 / ART-12 | 已确认需求与决策 |
| ART-20 / ART-22 | 影响分析与证据 |
| Analysis Baseline | ART-01（含 `documents` / `skills` / `repo_policy`） |
| 框架 Skill | §3.4，版本由基线钉住 |
| AGENTS.md | 仓库开发规范（已纳入基线） |
| SaaS 专项检查清单 | §11 |

## 7.3 步骤

1. 建立需求/影响 → 设计映射，每个必改触点生成 DESIGN 条目。
2. 复用现有框架封装与公共能力，检索 Skill 并记录实际引用版本。
3. 识别需要新增 ADR 的重要决策，按 §7.4 完整字段记录。
4. 数据库设计：DDL、索引、迁移、回滚、数据兼容。
5. 接口设计：入参/出参、错误码、幂等、兼容策略。
6. 缓存、消息、定时任务、配置、开关设计。
7. 权限与多租户隔离设计。
8. 存量行为兼容策略：逐条对应 ART-20 的 `affected_features`。
9. 可观测性、灰度、回滚方案。
10. 预期修改文件清单（ART-34），每个文件必须关联 DESIGN 与 IMPACT。
11. 输出 ART-30（YAML 事实源）与渲染件。

## 7.4 ADR 必需字段

V2 §7.3 要求"影响/代价/风险"，但示例缺失。V3 由 C08 强制校验以下字段：

`adr_id`、`context`、`options[]`（每个含 `pros` / `cons`）、`recommendation`、`rationale`、`impacts[]`、`costs[]`、`risks[]`、`references[]`（必须指向 R / IMPACT / DOC / SKILL）、`skill_refs[]`、`baseline_ref`。

```yaml
adr_id: ADR-001
title: 部分退款金额拆分实现方式
context: 需在不破坏全额退款链路的前提下支持按行拆分退款金额
options:
  - name: 在 RefundService 内扩展拆分逻辑
    pros: [改动集中, 复用现有事务边界]
    cons: [RefundService 复杂度上升]
  - name: 新增独立 PartialRefundService
    pros: [隔离存量逻辑]
    cons: [需新增事务与幂等处理, 调用链变长]
recommendation: 在 RefundService 内扩展拆分逻辑
rationale: 存量全额退款链路稳定，复用现有事务与幂等封装代价最低
impacts: [IMPACT-001]
costs: [新增 2 个单元测试用例, RefundService 圈复杂度 +3]
risks:
  - 金额精度处理需与财务口径核对（对应 OQ-002）
  - 下游对账依赖 MQ 事件金额字段，需运行时确认（IMPACT-002）
references: [R-001, AC-001, IMPACT-001, DOC-refund-policy:v4.2]
skill_refs: [SKILL-refund-engine:v3.2]
baseline_ref: BASE-001
```

## 7.5 硬约束与公共封装豁免

V2 §7.5 把"不允许绕过公共封装"写成硬约束，§13 却又允许"A3 输出设计偏差交人工确认"，两者冲突。V3 统一为：

- 必须复用框架公共封装、事务边界、权限校验、多租户上下文传递等既有能力。
- 确无法复用时，A3 **必须新增一条 ADR** 记录偏差原因、替代方案、影响、代价与风险，并在 ART-30 `framework_deviations[]` 登记。
- 该偏差必须由 G3 的架构师显式批准，批准记录 `waiver_ref` 写入 ART-00；未批准不得进入 FINAL。
- DRAFT 模式可带 `NEEDS_REVIEW` 标记保留偏差，但不得作为交接依据。

## 7.6 ART-30 示例

```yaml
artifact_id: ART-30
version: 1
artifact_status: VALID
baseline_ref: BASE-001
requirement_ref: ART-10:v1
decision_ref: ART-12:v1
impact_ref: ART-20:v1
skill_refs:                        # V2 要求记录实际引用版本但无落字段，已补
  - skill_id: SKILL-refund-engine
    version: v3.2
    content_hash: sha256:...
  - skill_id: SKILL-saas-checklist
    version: v2.1
    content_hash: sha256:...
repo_policy_ref: AGENTS.md@a1b2c3d
framework_deviations: []
open_confirmations:
  - id: OC-001
    impact_ref: IMPACT-002
    description: 退款金额变化对下游对账的影响
    verification_status: NEEDS_RUNTIME_CONFIRM
    owner: 研发负责人
    due_before: G3
designs:
  - id: DESIGN-001
    rule_refs: [R-001]
    acceptance_refs: [AC-001]
    impact_refs: [IMPACT-001]
    file_refs: [FILE-001]
    description: 在 RefundService#partialRefund 中按行拆分退款金额，复用现有事务与幂等封装
    alternatives: [ADR-001]
  - id: DESIGN-002
    rule_refs: [R-001]
    acceptance_refs: [AC-001]
    impact_refs: [IMPACT-002]
    file_refs: [FILE-002]
    description: MQ 事件新增 refundAmount 字段，保持旧字段兼容
file_changes:
  - id: FILE-001
    path: src/main/java/.../RefundService.java
    change_type: MODIFY
    design_refs: [DESIGN-001]
    impact_refs: [IMPACT-001]
  - id: FILE-002
    path: src/main/java/.../OrderRefundEvent.java
    change_type: MODIFY
    design_refs: [DESIGN-002]
    impact_refs: [IMPACT-002]
migration:
  ddl: []
  data_migration: 无
  rollback: 通过开关 refund.partial.enabled 回退至全额退款路径
compatibility:
  required: true
  strategy: 保留全额退款入口与旧 MQ 字段；新增字段默认向下兼容
observability: [退款金额拆分日志, 对账金额差异告警]
rollback: 关闭 refund.partial.enabled 开关
```

## 7.7 预期文件变更覆盖校验

V2 只要求"每个必改触点有对应设计说明"（C05），但不要求 DESIGN → FILE 映射，导致覆盖矩阵可以全绿却没有预期修改文件。V3 的 C05 同时校验 `impact → design → file` 三段映射，由 Gate Engine 生成 ART-33 覆盖矩阵（**ART-33 产生者改为 A0 确定性计算**，不由 A3 自述，避免与 A4 重复且不可信）：

```yaml
artifact_id: ART-33
version: 1
matrix:
  - rule_id: R-001
    acceptance_id: AC-001
    impact_id: IMPACT-001
    design_id: DESIGN-001
    file_id: FILE-001
    covered: true
  - rule_id: R-001
    acceptance_id: AC-001
    impact_id: IMPACT-002
    design_id: DESIGN-002
    file_id: FILE-002
    covered: true
uncovered: []
coverage_completeness: 1.00
computed_by: GateEngine
```

---

# 8. A4 独立设计评审

## 8.1 独立性定义与差异化验证工具

V2 要求 A4 "独立检索"，但 §8.3 让它查的是**与 A2 相同的知识图谱**；§3.2 已承认图谱覆盖不了反射/动态配置/MQ 订阅，再查一次只会得到同一批盲区。V3 规定 A4 必须调用**与 A2 不同实现或不同数据来源**的工具：

| 工具 | 与 A2 的差异 | 最少调用 |
| --- | --- | --- |
| `StaticAnalyzer` | 独立 AST/字节码调用图，不使用知识图谱的 `blast_radius` 结果 | ≥ 5 |
| `ContractDiffer` | 对外 API / MQ / DB Schema 的契约 diff | ≥ 5 |
| `RuntimeTraceSampler` | 生产/预发 trace 抽样，独立于 A2 的运行时查询会话 | ≥ 5 |
| `GateEngine` 复算 | 独立执行 C01–C14 与覆盖矩阵 | 1 |

A4 不得把 A1/A2/A3 的结论列表作为唯一输入；必须至少独立验证：A2 的关键调用链、高风险数据读写路径、对外 API / MQ 契约、A3 的关键代码修改依据、是否存在无需求依据的额外改动。`retrieval_budget` 为 A4 独立配额（§3.9），不受 A0 上下文装配复用限制，这是避免共同盲区的关键，也是 V3 的强制要求（对应 V2 §17 第三点，已正式落地）。

## 8.2 输入与独立检索预算

| 输入 | 说明 |
| --- | --- |
| 全部正式产物 | ART-10/12/20/22/30/31/32/33/34/40 |
| 项目规范 / 检查清单 | §11、§3.3 |
| Analysis Baseline | ART-01 |
| 独立工具 | §8.1 四类 |

```yaml
retrieval_budget:
  agent: A4
  max_input_tokens: 128k
  static_analyzer_calls: 5
  contract_differ_calls: 5
  runtime_trace_samples: 5
  independent: true        # 不得复用 A2 查询结果缓存
```

## 8.3 七层审查

1. 需求覆盖：每条规则与 AC 是否有对应设计（复算 ART-33，有差异即报）。
2. 影响覆盖：每个必改触点是否有设计与文件。
3. 证据复核：抽查 Evidence Verifier 结果与独立工具的差异。
4. 架构一致性：是否符合现有分层与框架封装。
5. 兼容性：存量行为、对外契约、数据迁移与回滚。
6. SaaS 专项：多租户隔离、权限、特殊租户、配置开关（§11）。
7. 过度设计与范围蔓延：是否存在无需求依据的额外改动。

## 8.4 三种结论与 conditions

| 结论 | 条件 | 流转 |
| --- | --- | --- |
| `PASS` | 无阻断项 | `WAITING_G3` |
| `CONDITIONAL_PASS` | 存在非阻断条件，**必须在正式通过前完成** | `CONDITIONAL_RESOLUTION`（§4.4 #17），不得直接进 G3 |
| `FAIL` | 存在阻断项 | 按归属回流（§8.7） |

V2 流程图让 CONDITIONAL_PASS 直接进 G3，与 §9"条件已落实并复核"冲突，且 ART-40 没有 conditions 字段。V3 补齐：

```yaml
conditions:
  - condition_id: COND-001
    description: 补充 RefundService 金额精度单元测试用例
    owner: A3
    due_before: WAITING_G3
    evidence_required: 测试用例文件路径
    verification_status: PENDING    # 由 Gate Engine / A4 复核后改为 VERIFIED
```

全部 `conditions[].verification_status == VERIFIED` 后方可进入 `A4_RUNNING` 复核并转 `WAITING_G3`。

## 8.5 阻断问题必需字段

V2 §8.4 要求"违反的检查规则"，但 ART-40 示例没有该字段，导致 A0 无法按规则 ID 校验关闭。V3 由 C 规则强制：

`issue_id`、`category`、`description`、**`violated_rule`**（C-NN 或 §11 检查项 ID）、`references`（R / IMPACT / DESIGN / FILE）、`evidence`、`recommendation`、`return_to`（A1/A2/A3）、`status`。

## 8.6 ART-40 / ART-42 示例

```yaml
# ART-40
artifact_id: ART-40
version: 1
review_conclusion: FAIL
reviewed_artifacts:
  - ART-10:v1
  - ART-12:v1
  - ART-20:v1
  - ART-22:v1
  - ART-30:v1
  - ART-32:v1
  - ART-33:v1
  - ART-34:v1
independent_verification:
  static_analyzer_calls: 6
  contract_differ_calls: 5
  runtime_trace_samples: 5
  gate_engine_recomputed: true
  findings:
    - 独立调用图发现 CouponService#recalculate 未在 A2 调用链中
blocking_issues:
  - issue_id: ISSUE-001
    category: compatibility
    description: 部分退款后优惠券返还逻辑未纳入设计，可能破坏存量优惠券结算
    violated_rule: C03
    references: [R-001, IMPACT-001, DESIGN-001]
    evidence: CouponService.java:88@a1b2c3d
    recommendation: 补充优惠券结算影响分析与对应设计
    return_to: A2
    issue_status: OPEN
conditions: []
suggestions:
  - 建议在 ART-30 中补充金额精度说明
coverage:
  requirement_to_design: 1.00
  impact_to_design: 0.50
```

```yaml
# ART-42
artifact_id: ART-42
version: 1
based_on: ART-40:v1
target_artifacts: [ART-20, ART-30]
invalidated_artifacts: [ART-20:v1, ART-30:v1]
preserved_artifacts: [ART-10:v1, ART-12:v1]
issues:
  - issue_id: ISSUE-001
    target_section: 影响分析 / 调用链
    required_evidence: CouponService 调用链与静态分析结果
    expected_output: 新增 IMPACT 条目及对应 EVIDENCE
    return_to: A2
```

## 8.7 修订回流与计数口径

| 归属 | 状态 | 计数器 |
| --- | --- | --- |
| 需求问题 | `REQUIREMENT_REVISION` → A1 → 重新 G1/G2 | `baseline_rerun_count++`（上限 1） |
| 影响分析遗漏 | `IMPACT_REVISION` → A2 → 重新 G2 | `baseline_rerun_count++`（上限 1） |
| 设计问题 | `DESIGN_REVISION` → A3 | `revision_round++`（上限 2，与 CONDITIONAL_RESOLUTION 共用） |

V2 的"自动修订最多两轮"口径不明、G3 退回无上限、A4→A1/A2 回流无对应状态，均已在 §4.4、§4.10 修正。超过任一上限转 `ESCALATED` 并生成 ART-43。

---

# 9. 人工审批门禁

## 9.1 通则

- **审批对象必须包含机器产物**：V2 中 G1 批 ART-11/12、G2 批 ART-21/22、G3 批 ART-31/32/41，而下游真正消费的是 ART-10/20/30/33/34，导致"人批的"与"机器执行的"不是同一份。V3 全部改为审批 YAML 事实源及其渲染件。
- 审批记录写入 ART-00，含 `approver_role`（角色，不记录个人姓名）、`decided_at`、`artifact_refs`、`diff_hash`、`comment`，不可由 Agent 修改。
- 超时按 §4.9 处理，不得自动批准。
- 门禁进入前由 Gate Engine 执行对应 C 规则，任一 `FAIL` 不得进入审批。

| 门禁 | 审批对象 | 审批角色 | SLA |
| --- | --- | --- | --- |
| G1 | ART-10（含渲染件 ART-11）、ART-12 | 研发负责人 | 2 工作日 |
| G2 | ART-20（含 ART-21）、ART-22、`risk_summary`、`open_confirmations` | 研发负责人 | 1 工作日 |
| G3 | ART-30（含 ART-31）、ART-32 ADR、ART-33 覆盖矩阵、ART-34 文件清单、ART-40/41 评审报告、`open_confirmations` 关闭情况 | 技术负责人、架构师、相关研发 | 3 工作日 |

## 9.2 G1

见 §5.5。结果：`APPROVED` / `PARTIALLY_APPROVED` / `REJECTED` / `TIMED_OUT`。

## 9.3 G2

见 §6.8。必须逐条处置 `HIGH` 与 `BLOCKER`；`HIGH` 的"明确接受"须写入 `risk_acceptance`。`change_tier: T0` 时 G2 记为 `WAIVED` 并在 ART-00 写明理由，此时 `risk_summary` 中不得存在 `BLOCKER` / `HIGH`，否则必须按 §2.4 升级为 T2。

## 9.4 G3

前置条件：

1. A4 结论为 `PASS`，或 `CONDITIONAL_PASS` 的全部条件已落实并复核为 `VERIFIED`。
2. `open_confirmations[]` 中 `NEEDS_RUNTIME_CONFIRM` 项已由人工确认或显式接受（仅 `HIGH` 及以下）。
3. C01–C14 全部通过，C13 渲染件一致。
4. `framework_deviations[]` 均有 `waiver_ref`。
5. 基线有效（C12/C14）。

通过后冻结 ART-30/31 版本，登记 §3.12 `file_claims[]`，作为正式交付。**G3 退回计入 `g3_rejection_count`，上限 2 次**（§4.10）。

## 9.5 审批记录 Schema

```yaml
- gate: G3
  approval_status: APPROVED
  approver_role: 架构师
  decided_at: 2026-11-18T10:30:00Z
  artifact_refs:
    - ART-30:v3
    - ART-32:v2
    - ART-33:v3
    - ART-34:v3
    - ART-40:v3
  diff_hash: sha256:...        # 本次审批相对上一版本的字段级 diff
  comment: 同意按修订后设计实施
  waivers: [ADR-004]
```

---

# 10. 产物版本、依赖与增量重跑

## 10.1 逻辑产物与文件表示（单一事实源）

V2 把 YAML 与 Markdown 当成两个独立产物（ART-10 vs ART-11），V2 §17 又要求"两个产物必须具有相同的 Artifact ID 和版本"，自相矛盾；且没有定义同步方向，人工改 Markdown 会让下游消费的 YAML 变旧。V3 统一为：

| 规定 | 内容 |
| --- | --- |
| 逻辑产物 | 唯一 `ART-XX` + `version`，是引用、失效、审批、追溯的最小单元 |
| 文件表示 | 同一逻辑产物可有 `#yaml`（事实源）与 `#markdown`（渲染件），两者共享 `artifact_id` 与 `version` |
| 事实源 | YAML。所有 Agent 读写、Gate Engine 校验、依赖计算、审批 `artifact_refs` 一律指向 YAML |
| 渲染件 | 由 A0 确定性渲染生成，携带 `rendered_from` 与 `content_hash`；**禁止人工直接编辑** |
| 同步 | 单向：YAML → Markdown。人工修订只能改 YAML 或提交结构化修订指令，A0 重新渲染 |
| 一致性 | C13 校验两者 `artifact_id` / `version` / `content_hash` 一致，不一致即 `FAILED` 并自动重新渲染 |

```yaml
artifact_id: ART-10
version: 2
artifact_status: VALID
representations:
  - format: yaml
    path: 01-requirement/requirement-package.yaml
    role: source_of_truth
    content_hash: sha256:...
  - format: markdown
    path: 01-requirement/requirement-clarification.md
    role: rendered
    rendered_from: ART-10:v2#yaml
    content_hash: sha256:...
```

## 10.2 Artifact 通用结构

```yaml
artifact_id: ART-20
version: 2
artifact_status: VALID       # DRAFT / VALID / STALE / INVALIDATED（§0.2）
baseline_ref: BASE-001
produced_by: A2
produced_at: 2026-11-15T13:10:00Z
dependencies:
  - artifact_id: ART-10
    version: 1
  - artifact_id: ART-12
    version: 1
superseded_refs:
  - ART-20:v1
review_status: null          # 仅 ART-40 使用
content_hash: sha256:...
modifications: []
```

V2 中并存 `status: draft`、`STALE`、`review_status`、`invalidated/preserved_artifacts` 四套词汇，V3 统一为 `artifact_status` 单一字段，映射见 §4.5。

## 10.3 依赖关系图

V2 的依赖图漏了 `ART-12 → A2`、`ART-22/33/34 → A4` 以及基线/规范/图谱输入，而 §10.4 又依赖该图计算失效，导致决策变更不会触发重跑。V3 修正：

```mermaid
flowchart TD
    BASE[ART-01 Analysis Baseline] --> A1
    BASE --> A2
    BASE --> A3
    BASE --> A4
    DOCS[documents / skills / repo_policy] --> A1
    DOCS --> A3
    GRAPH[知识图谱 / 源码 / Git] --> A2
    GRAPH --> A4
    A1[A1] --> R[ART-10 规则与 AC]
    A1 --> DECDRAFT[ART-12 草案]
    G1[G1] --> DEC[ART-12 决策日志]
    R --> A2
    DEC --> A2
    A2[A2] --> IMP[ART-20 影响]
    A2 --> EVI[ART-22 证据]
    EVI --> VERIFY[Evidence Verifier]
    VERIFY --> A4
    R --> A3
    IMP --> A3
    DEC --> A3
    A3[A3] --> DES[ART-30 设计]
    A3 --> ADR[ART-32 ADR]
    A3 --> FILES[ART-34 文件清单]
    DES --> COV[ART-33 覆盖矩阵 / Gate Engine]
    IMP --> COV
    FILES --> COV
    R --> A4
    DEC --> A4
    IMP --> A4
    EVI --> A4
    DES --> A4
    ADR --> A4
    COV --> A4
    FILES --> A4
    A4[A4] --> REV[ART-40 评审]
    REV --> INSTR[ART-42 修订指令]
    INSTR --> A1
    INSTR --> A2
    INSTR --> A3
    REV --> G3[G3]
    G3 --> FINAL[冻结交付]
```

## 10.4 变更分级 → 重跑矩阵

合并 V2 §4.7 与 §10.4 的冲突规则，按 §4.8 的变更类别统一处理。V2 规定"US 内容任意改动即全量重跑 A1–A4 + G1/G2/G3"，连错别字也如此；V3 按类别分级：

| 变更来源 | 类别 | 失效产物 | 重跑阶段 | 重新门禁 |
| --- | --- | --- | --- | --- |
| US 文字性修改 | 文字性 | 仅 ART-10 渲染件 | 重新渲染（C13） | 无 |
| US 语义/结构性修改 | 结构性 | ART-10 起全链路 | A1、A2、A3、A4 | G1、G2、G3 |
| ART-10 规则 / AC 变更 | 语义性 | ART-20 起 | A2、A3、A4 | G2、G3 |
| **ART-12 决策变更**（含 `scope_excluded` 解禁） | 语义性 | ART-20 起 | A2、A3、A4 | G2、G3 |
| ART-20 影响触点变更 | 语义性 | ART-30 起 | A3、A4 | G3 |
| ART-22 证据补充 / `FAILED` 修复 | 语义性 | ART-30 起 | A3、A4 | G3 |
| ART-30 技术设计 / ADR 变更 | 语义性 | ART-40 起 | A4 | G3 |
| ART-32 ADR 修改 | 语义性 | ART-30 版本 + ART-40 | A4 | G3 |
| ART-40 审查结论变更 | 语义性 | 相关阶段 | 按 `return_to` | G3 |
| **documents / skills / repo_policy 版本或状态变更** | 结构性 | 引用该文档/Skill 的产物 | 相关阶段 | 对应门禁 |
| **在途变更合并进基线** | 结构性 | 命中触点相关产物 | A2、A3、A4 | G2、G3 |
| **运行时证据状态变更** | 语义性 | ART-20 `open_confirmations`、ART-30 | A3、A4 | G3 |
| 代码基线变化（命中已分析触点） | 结构性 | 命中触点相关产物 | 定向重跑 A2→A4 | G2、G3 |
| 代码基线变化（未命中） | — | 无 | 记录 `superseded_commits[]` | 无 |
| Agent 执行失败 | — | 保留已有 `VALID` 产物 | 断点恢复 | 无 |

C09 澄清：判定的是 `dependencies[]` 是否指向**当前有效版本**；被替代的历史版本记入 `superseded_refs[]`，不参与 C09 判定（V2 的 C09"所有产物的输入版本必须一致"与此冲突，已修订）。

## 10.5 V2 → V3 产物编号对照

| V2 编号 | V3 | 变化 |
| --- | --- | --- |
| ART-00 / 01 / 02 / 03 | 不变 | ART-03 补进交付目录树 |
| ART-10 / 11 | ART-10（YAML 事实源）+ 渲染件 | 合并为单一逻辑产物，共享 ID 与版本 |
| ART-12 | ART-12 | 产生者统一为 G1 |
| ART-20 / 21 / 22 | ART-20（+渲染件）/ ART-22 | ART-21 并入 ART-20 渲染件 |
| ART-30 / 31 / 32 / 33 / 34 | 编号不变 | ART-33 产生者改为 A0（Gate Engine 确定性计算）；ART-30 增加 `skill_refs` / `framework_deviations` / `open_confirmations` |
| ART-40 / 41 / 42 | ART-40（+渲染件）/ ART-42 | ART-41 并入 ART-40 渲染件；ART-40 增加 `conditions` / `violated_rule` / `independent_verification` |
| 无 | **ART-43 Escalation Report** | 新增，承载争议/超时/超上限的人工处理记录 |

---

# 11. SaaS 存量系统专项检查清单

以下检查贯穿 A1～A4，由 Gate Engine 按 `change_tier` 决定深度（T0 仅执行标 ★ 项）。检查项 ID 用于 ART-40 `violated_rule` 引用。

| ID | 检查项 | 适用阶段 | 风险等级命中 |
| --- | --- | --- | --- |
| S01 ★ | 需求是否涉及多租户数据隔离边界 | A1/A2/A3 | `BLOCKER` |
| S02 ★ | 是否涉及权限模型或鉴权点变更 | A1/A2/A3 | `BLOCKER` |
| S03 ★ | 是否涉及资金/计费计算 | A1/A2/A3 | `BLOCKER` |
| S04 | 是否涉及对外 API 契约（入参/出参/错误码） | A2/A3/A4 | `HIGH` |
| S05 | 是否涉及 MQ 生产/消费契约与顺序性 | A2/A3/A4 | `HIGH` |
| S06 | 是否涉及 DB Schema / 索引 / 批量数据变更 | A2/A3 | `BLOCKER`（无回滚）/ `HIGH` |
| S07 | 是否涉及缓存键、失效策略、序列化格式 | A2/A3 | `HIGH` |
| S08 | 是否涉及特殊租户逻辑或历史兼容开关 | A2/A3 | `HIGH` |
| S09 | 是否涉及配置中心、Feature Flag、条件装配 | A2/A3 | `MEDIUM` |
| S10 | 是否涉及定时任务、异步补偿、幂等 | A2/A3 | `MEDIUM` |
| S11 | 是否存在反射/动态代理/动态 SQL 等图谱盲区 | A2/A4 | `NEEDS_RUNTIME_CONFIRM` |
| S12 | 是否复用框架公共封装与事务边界 | A3/A4 | `HIGH`（绕过） |
| S13 | 存量行为与兼容性策略是否逐条覆盖 | A3/A4 | `HIGH` |
| S14 | 迁移与回滚方案是否可执行 | A3/A4 | `BLOCKER`（缺失） |
| S15 ★ | 可观测性、灰度与开关是否具备 | A3/A4 | `MEDIUM` |

---

# 12. 运行模式与质量标准

## 12.1 DRAFT 模式

用途：快速分析、内部讨论、设计探索。

允许：未确认业务假设、未验证的运行时影响、部分技术方案待定、A4 发现的问题暂未修复、C04/C10/C12 不强制。

必须标记：`DRAFT`、`UNCONFIRMED`、`NEEDS_REVIEW`、`NEEDS_RUNTIME_CONFIRM`。DRAFT 产物禁止作为正式开发交接依据，且 `verification_status: FAILED` / `UNVERIFIED` 的证据只允许出现在此模式。

## 12.2 FINAL 模式

必须依次完成：基线建立（C12/C14 通过）→ A1 → G1 → A2（Evidence Verifier 无 FAILED）→ G2 → A3 → A4 → 条件落地 → G3 → 冻结版本。

## 12.3 T0 快速通道

仅适用于 `change_tier: T0` 且 `run_mode: FINAL`：

- 仍须建立基线、登记 US、执行 Evidence Verifier、生成最小产物集（ART-00/01/02/03/10/12/20/22/30/33/34/40 的精简版）。其中 ART-20 仅含最小触点清单、ART-22 仅含静态证据且全部 `VERIFIED`，以保证 C03/C05 与 ART-33 可计算。
- G2 记 `WAIVED`（§9.3）并写明理由；A4 仅执行第一层覆盖审查；G3 单人审批。
- 不得跳过 C01/C02/C03/C05/C13/C14；C04 因 T0 下 `risk_summary` 中 `BLOCKER` / `HIGH` 必须为 0 而空集通过。任何 `BLOCKER` 或 `HIGH` 命中立即按 §2.4 升级为 T2 全量流程。
- 追溯链要求与 T2 相同。

## 12.4 最终质量标准（DoD）

| 检查项 | 通过条件 | 判定者 |
| --- | --- | --- |
| 需求完整性 | 所有必须需求均有 AC（C01） | Gate Engine |
| 需求准确性 | 进入 A2 范围的推断内容均已确认（C02） | Gate Engine |
| 需求追溯 | 规则和 AC 均有来源引用 | Gate Engine |
| 影响完整性 | 所有必改触点均有 `VERIFIED` 证据 | Evidence Verifier |
| 风险管理 | `BLOCKER` 已修复；`HIGH` 已处理或有 G2 `risk_acceptance` | Gate Engine + G2 |
| 设计完整性 | 每个必改触点均有 DESIGN 与 FILE（C05） | Gate Engine |
| 技术决策 | 重要 ADR 已记录且 C08 通过 | Gate Engine |
| 兼容性 | 存量行为及契约兼容策略完整（C06） | Gate Engine |
| 数据设计 | 迁移与回滚方案明确（C07） | Gate Engine |
| SaaS 安全 | §11 适用项检查完成 | Gate Engine |
| 双产物一致 | C13 通过 | Gate Engine |
| 基线有效性 | C12 / C14 通过 | Gate Engine |
| 评审 | A4 无 OPEN 阻断项、无未 VERIFIED 条件 | Gate Engine |
| 人工审批 | G1、G2（或 WAIVED）、G3 完成且有审计记录 | A0 |
| 版本一致性 | 所有产物基于有效基线（C09/C11） | Gate Engine |
| 可追溯性 | US → 规则 → 影响 → 证据 → 设计 → 文件全链路可追溯（ART-33） | Gate Engine |

## 12.5 质量评估指标与阈值

指标定义与初始阈值见 §1.5。采集规则：

| 指标 | 采集点 | 责任 |
| --- | --- | --- |
| 影响召回率 / 精确率 | 第二阶段基线评测 + 每季度历史 US 回归 | 架构组 |
| 证据幻觉率 | 每次 Evidence Verifier 运行写入 ART-22 / ART-03 | 平台组 |
| 门禁漏放率 | Gate Engine 执行日志 | 平台组 |
| 覆盖完整率 | 每次 ART-33 计算 | Gate Engine |
| 推断误确认率 | G1 裁决记录 ART-12 | A0 |
| A4 回流比例 | ART-00 `baseline_rerun_count` 汇总 | A0 |

未达阈值时：停止进入下一建设阶段，产出 ART-43 由技术负责人决定是否调整阈值（须记 ADR）或返工。

---

# 13. 失败与降级处理

| 异常情况 | 处理策略 |
| --- | --- |
| 知识图谱无结果 | 扩大静态检索，标记 `UNVERIFIED`；仅 DRAFT 可用 |
| 图谱落后 baseline 但未超 SLA 且未命中已分析触点 | 记录差异，允许继续（§3.8） |
| 图谱落后超 SLA 且命中已分析触点 | 增量同步 / 重新基线化 → 定向重跑；禁止 FINAL |
| US 与规范冲突 | A1 输出待裁决事项，交 G1 |
| US 存在关键歧义 | G1 阻断（`REJECTED` 或 `PARTIALLY_APPROVED` 排除范围） |
| 证据引用校验 `FAILED` | 该证据无效；命中 BLOCKER 转 `ESCALATED` |
| 高风险触点缺少证据 | G2 强制人工确认；FINAL 下不允许以 `NEEDS_RUNTIME_CONFIRM` 放过 BLOCKER |
| 运行时数据不可用 | `WAITING_RUNTIME_EVIDENCE`，SLA 1 工作日；超时按 §3.5 降级或 `ESCALATED` |
| 在途变更冲突 | A2 输出冲突报告，G2 裁决（§3.12） |
| A3 无法复用现有封装 | 必须新增 ADR + `framework_deviations`，G3 架构师 `waiver_ref` 批准；未批准禁止 FINAL（§7.5） |
| A4 发现影响分析遗漏 | `IMPACT_REVISION` → A2 → G2，`baseline_rerun_count++` |
| A4 发现需求问题 | `REQUIREMENT_REVISION` → A1 → G1/G2，`baseline_rerun_count++` |
| `revision_round` / `baseline_rerun_count` / `g3_rejection_count` 超上限 | 停止自动循环，生成 ART-43，转人工 |
| 审批 `TIMED_OUT` | `ESCALATED` + ART-43，不得自动批准 |
| 人工修改上游产物 | 按 §4.8 类别使下游 `STALE` / `INVALIDATED` 并定向重跑 |
| 渲染件被人工直接编辑 | C13 `FAILED`，A0 自动重新渲染并记入审计 |
| 代码基线变化 | 命中触点 → 定向重跑；未命中 → 记录 `superseded_commits[]` |
| Agent 执行失败 | 保留 `VALID` 产物，支持断点恢复 |
| 上下文/检索预算超 150% | `ESCALATED` 人工确认，不允许静默截断 |
| 检测到 `untrusted_instruction` | 标记并交人工确认，不作为指令执行 |

---

# 14. 本期最终交付物清单

工作流结束后形成完整交付包；其中 **ART-30 / ART-31（技术设计）及其覆盖矩阵 ART-33、文件清单 ART-34 为开发交接主件**，其余为追溯与审计依据。V2 在 §1.3/§9 与 §14 之间对"最终交付物"范围表述不一致，V3 统一为"完整交付包 + 明确主件"。

| 编号 | 产物 | 产生者 | 格式 | 用途 |
| --- | --- | --- | --- | --- |
| ART-00 | Workflow Manifest | A0 | YAML | 流程状态、计数器、审批审计 |
| ART-01 | Analysis Baseline | A0 | YAML | 分析版本基线 |
| ART-02 | Artifact Manifest | A0 | YAML | 产物版本、依赖、状态 |
| ART-03 | Workflow Report | A0 | Markdown | 执行记录、指标、成本 |
| ART-10 | Requirement Clarification Package | A1 | YAML（事实源） | 结构化需求 |
| ART-11 | Requirement Clarification Document | A0 渲染 | Markdown | 需求澄清阅读件（ART-10 表示） |
| ART-12 | Requirement Decision Log | G1 | YAML | 需求决策 |
| ART-20 | Impact Analysis Package | A2 | YAML | 结构化影响分析 |
| ART-21 | Impact Analysis Document | A0 渲染 | Markdown | 影响分析阅读件（ART-20 表示） |
| ART-22 | Impact Evidence Manifest | A2 + Verifier | YAML | 影响证据与校验结果 |
| ART-30 | Technical Design Package | A3 | YAML | 结构化技术设计 |
| ART-31 | Technical Design Document | A0 渲染 | Markdown | 正式技术设计（交接主件） |
| ART-32 | Architecture Decision Records | A3 | YAML | 技术决策 |
| ART-33 | Design Coverage Matrix | A0（Gate Engine） | YAML | 需求/影响/设计/文件覆盖 |
| ART-34 | Expected File Change Manifest | A3 | YAML | 预期修改文件 |
| ART-40 | Design Review Report | A4 | YAML | 结构化审查结果 |
| ART-41 | Design Review Document | A0 渲染 | Markdown | 评审阅读件（ART-40 表示） |
| ART-42 | Review Revision Instructions | A4 | YAML | 设计修订指令 |
| ART-43 | Escalation Report | A0 | YAML + Markdown | 争议/超时/超上限人工处理记录（新增） |

最终正式交付包目录：

```text
US-2026-001/
├── 00-workflow/
│   ├── workflow-manifest.yaml          # ART-00
│   ├── analysis-baseline.yaml          # ART-01
│   ├── artifact-manifest.yaml          # ART-02
│   ├── workflow-report.md              # ART-03（V2 目录树遗漏，已补）
│   └── escalation-report.yaml          # ART-43，仅在 ESCALATED 时生成
├── 01-requirement/
│   ├── requirement-package.yaml        # ART-10 事实源
│   ├── requirement-clarification.md    # ART-10 渲染件
│   └── decision-log.yaml               # ART-12
├── 02-impact/
│   ├── impact-package.yaml             # ART-20 事实源
│   ├── impact-analysis.md              # ART-20 渲染件
│   └── evidence-manifest.yaml          # ART-22
├── 03-design/
│   ├── technical-design-package.yaml   # ART-30 事实源
│   ├── technical-design.md             # ART-30 渲染件（交接主件）
│   ├── adrs/                           # ART-32
│   ├── design-coverage.yaml            # ART-33
│   └── expected-file-changes.yaml      # ART-34
└── 04-review/
    ├── review-report.yaml              # ART-40 事实源
    ├── review-report.md                # ART-40 渲染件
    ├── revision-instructions.yaml      # ART-42
    └── revision-history/               # 历史版本归档
```

---

# 15. 建设优先级

V2 把基础设施当作前提、把质量评估放到最后。V3 把基础设施与确定性组件前置，把评估基线提到第二阶段。

## 第一阶段：基础设施 + 工作流底座

- INF-01 代码知识图谱（最小可用集）+ §3.8 同步 SLA 机制。
- INF-02 业务规范最小集、INF-03 Skill 与 AGENTS.md 纳入基线。
- INF-05 Evidence Verifier、INF-06 Gate Engine、INF-07 渲染器。
- INF-08 全局 US 注册表。
- A0 状态机、Analysis Baseline、Artifact Manifest、产物 ID 与版本协议。
- §10.1 双表示单一事实源、C01–C14、人工修改检测、增量重跑、审批审计。

## 第二阶段：需求到影响分析 + 评估基线

- A1 需求澄清、G1。
- A2 图谱影响分析、静态代码证据、INF-04 运行时证据通道。
- Evidence Verifier 接入 ART-22、§6.5 风险分级规则。
- G2。
- **INF-09 历史 US 回归集与 §1.5 指标基线评测，未达阈值不得进入第三阶段。**

## 第三阶段：技术设计与评审

- A3 技术设计、ADR 生成、ART-33 覆盖矩阵（Gate Engine 计算）。
- A4 独立评审 + §8.1 四类差异化验证工具接入。
- CONDITIONAL_RESOLUTION、评审回流、G3。

## 第四阶段：质量优化

- 历史设计知识库、特殊租户知识库、历史兼容性规则增强。
- 运行时证据增强、Agent 质量评估常态化、阈值校准。
- 上下文/成本优化、T0/T1 分级策略调优。

---

# 16. 最终设计原则

1. **需求真实性优先**：Agent 可以发现遗漏，但不能擅自决定业务需求。
2. **代码证据优先于模型推断**：所有重要影响结论都必须具备经 Evidence Verifier 校验通过的证据，证据不足必须明确标记。
3. **存量行为保护优先**：不能因为实现新需求而无意破坏已有业务行为。
4. **设计决策必须可解释**：重要技术方案必须有明确的选择依据、备选方案及影响。
5. **审查必须具备独立性**：A4 不能仅依赖 A1、A2、A3 已生成的结论，且必须使用不同实现或不同数据源的验证工具。
6. **人工审批拥有最终决策权**：需求、重大影响和正式技术设计均由对应负责人确认，审批对象包含机器产物。
7. **全流程必须可追溯**：任何一项设计都应能追溯到需求规则、代码证据和技术决策。
8. **自动化不等于无门禁**：Agent 可以自动完成分析和设计，但不能自行突破业务和技术审批边界。
9. **机器可判定的事不由 LLM 判定**：结构校验、引用验证、覆盖计算、风险分级、状态流转由确定性组件执行。
10. **单一事实源**：YAML 是唯一事实源，Markdown 是确定性渲染件，禁止人工编辑渲染件。

---

# 17. 关键设计决策记录

V2 第 17 章标题为"后续优化点"，内容却写着"这三个问题建议在真正开始开发之前确定，否则后续容易返工"，定位自相矛盾；内容又与正文重复/冲突、表格损坏。V3 将其整合为**已定决策**，并把三个点分别落到 §3.9、§10.1、§8.1。

## 17.1 决策摘要

| 决策 | 结论 | 落地章节 |
| --- | --- | --- |
| D-01 双产物模式 | YAML 为唯一事实源，Markdown 为确定性渲染件；两者共享 `artifact_id` 与 `version`，由 C13 校验。禁止用正则解析 Markdown 做机器校验 | §10.1、§3.7、§4.7 C13 |
| D-02 上下文装配 | A0 按职责装配上下文，Agent 只获取职责内的补充证据；A4 例外，保留独立检索预算 | §3.9、§4.1 |
| D-03 A4 独立检索 | A4 必须调用与 A2 不同实现/数据源的工具（StaticAnalyzer / ContractDiffer / RuntimeTraceSampler / Gate Engine 复算），独立配额，避免共同盲区 | §8.1、§8.2 |
| D-04 证据可验证 | 引入 Evidence Verifier，所有引用在 pinned commit 上确定性校验 | §3.6 |
| D-05 规则可执行 | 引入 Gate Engine 执行 C01–C14、覆盖矩阵、风险分级 | §3.7、§4.7、§6.5 |
| D-06 基线可运转 | 冻结窗口 + 图谱增量同步 SLA，修订"禁止 FINAL"的触发条件 | §3.8 |
| D-07 单一状态机 | 顶层状态机覆盖全部回流路径，三层状态词汇分离，计数器口径明确 | §4.4、§4.5、§4.10 |
| D-08 审批覆盖机器产物 | G1/G2/G3 审批 YAML 事实源及其渲染件，含审计留痕与超时升级 | §9 |
| D-09 风险裁剪 | `change_tier` T0/T1/T2 + DRAFT/FINAL 正交，避免小需求全量流程 | §2.4、§12.3 |
| D-10 度量前置 | 评估指标与回归集在第二阶段完成基线评测 | §1.5、§12.5、§15 |

## 17.2 V2 → V3 问题修订对照

| V2 问题 | V3 落地位置 |
| --- | --- |
| 核心基础设施"假设/建议/可选"，无范围无排期 | §1.3、§3.1、§15 |
| 证据链 LLM 自述，无引用校验 | §3.6、§6.4、§6.7、§12.5 证据幻觉率 |
| A4 与 A2 查同一图谱，共同盲区未解 | §8.1、§8.2 |
| 双产物无单一事实源；门禁审批对象与下游消费对象错配 | §10.1、§9.1、C13 |
| C 规则/风险分级/Skill 版本只有声明无执行主体 | §3.7、§4.7、§6.5、§7.6、C14 |
| 基线刚性导致 final 不可达 | §3.8、§4.3、C12 |
| PARTIALLY_APPROVED 未落地 | §5.5、§4.4、§4.6、C02 |
| CONDITIONAL_PASS 直接进 G3、无 conditions 字段 | §8.4、§4.4 `CONDITIONAL_RESOLUTION` |
| 状态机覆盖不了回流；"两轮"口径不明；G3 退回无上限；争议报告非产物 | §4.4、§4.10、§13、ART-43 |
| 依赖图漏 DEC→A2 与 A4 输入；重跑表缺 DEC/规范/在途变更行 | §10.3、§10.4 |
| 运行时证据机制三处矛盾 | §3.5、§4.2、§4.4 `WAITING_RUNTIME_EVIDENCE` |
| 公共封装硬约束与降级表冲突 | §7.5、§13 |
| 高风险无确定性定义、BLOCKER 不阻断 A3、"明确接受"无主体 | §6.5、§6.6、§9.3、§12.4 |
| 状态词汇四套并存 | §0.2、§4.5、§10.2 |
| 文字修改处理前后矛盾、US 改动全量重跑、C09 歧义 | §4.8、§10.4、C09 |
| 缺模型/成本/上下文/评估/安全/超时/并发/审计 | §1.5、§3.9、§3.10、§3.12、§4.9、§9.5、§12.5 |
| 无风险裁剪，小需求 ROI 为负 | §2.4、§12.3 |
| 示例缺字段、枚举大小写不一、ART-00 状态与产物矛盾 | §5.4、§6.7、§7.4、§7.6、§8.6、§4.6、§0.3 |
| `documentation` 单一版本、Skill 版本无落字段、AGENTS.md 未入基线 | §3.3、§3.4、§4.3、§7.6、C14 |
| §17 定位矛盾、表格损坏、与正文冲突 | §17.1 |
| A0 未列建设范围；DEC 产生者三种说法；目录树缺 ART-03；交付物范围不一 | §1.3、§5.6、§14 |
