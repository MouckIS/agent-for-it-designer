---
name: etp-awf-workflow
description: AWF 多 Agent 技术方案设计工作流的状态机、产物协议、门禁与一致性校验规则。执行 /etp-awf-* 命令或 A1-A5 子代理任务前必须先读取，用于判断当前状态、允许的下一步、产物字段与校验规则。
---

# AWF Workflow

## 这个 Skill 解决什么

把「需求获取 → 澄清 → 影响 → 设计 → 评审」变成可校验的工程流程，而不是一次性长文生成。核心是三件事：

1. **状态明确**：任何时刻只有一个合法状态，下一步由状态决定，不由模型自由发挥。
2. **产物结构化**：YAML 负责机器校验与追溯，Markdown 负责阅读，两者同 ID 同版本。
3. **证据可追溯**：每条内容归属、规则、影响、设计都能指回来源，缺证据必须显式标注。

## 角色边界

| 角色 | 可以做 | 不可以做 |
| --- | --- | --- |
| A0 控制面 | 校验人工基线、派发、脚本校验、状态流转、门禁、失效重跑 | 写需求/影响/设计结论；自行建立或切换基线 |
| A1 获取 | 调 Skill 取 US、固化快照、拆块、判前后端归属、登记缺口 | 解释业务规则、写 AC、评估技术可行性 |
| A2 澄清 | 规则、范围、AC、决策、冲突 | 分析代码影响、给实现方案 |
| A3 影响 | 触点、影响、风险、证据、冲突登记 | 给实现方案、改需求 |
| A4 设计 | 设计、ADR、迁移兼容、文件清单、检查项回应 | 扩大影响范围、改需求 |
| A5 评审 | 审查、问题、修订指令、检查项复核 | 直接修改设计产物 |

A0 由三部分组成：**决策层**是可执行脚本 `.claude/workflows/awf.js`（状态路由、派发顺序、停点返回），**执行层**是 `etp-awf-controller` 子代理（Preflight、产物六步校验与 C 检查、sha256 与 manifest 登记、读修订指令），**门禁**由人工通过 `/etp-awf-gate` 执行。A0 不做业务结论；A1～A5 是子代理，不能互相派发，workflow 内也不能再嵌套 workflow。

## 六个不可协商的点

1. 人工门禁必须等待用户明确决定；不得自动填充「通过」。
2. 代码现状不等于产品需求；推断项必须标 `pending` 并进入决策清单。
3. 无证据不得断言「无影响」；写 `evidence_gap` 并标风险。
4. 原始需求快照只读；内容块不得静默丢弃，剔除必须有理由。
5. 不允许无需求依据的设计变更；每个设计必须能回到 IMPACT 与 R/AC。
6. 旧版本不覆盖：新版本递增，历史靠 git 与 `revision-history` 保留。

## 快速索引

| 需要什么 | 读哪里 |
| --- | --- |
| 状态与派发、派发协议、门禁、回流、增量重跑、多 US 批次、异常处理、完成条件 | `references/orchestration-rules.md`（全文规则；可执行编排见 `.claude/workflows/awf.js`） |
| 目录、字段、ID、版本、失效规则 | `references/artifact-protocol.md` |
| 14 个状态与合法迁移、恢复方式 | `references/state-machine.md` |
| G1/G2/G3 阻断项、C01–C16、DoD | `references/gates-and-checks.md` |
| 各阶段读什么、上下文预算、交接格式 | `references/context-assembly.md` |
| 需求获取的最小输出 | `../etp-requirement-fetch/SKILL.md` |
| 项目检查项 | `../etp-project-checklist/SKILL.md` |
| 存量 SaaS 专项基线 | `../etp-legacy-saas-analysis/SKILL.md` |
| 图谱与代码检索、证据引用 | `../etp-code-graph-query/SKILL.md` |
| 五类文档结构与写作要求 | `../etp-design-doc-writing/SKILL.md` |
| 八层评审与问题格式 | `../etp-design-review/SKILL.md` |

## 执行顺序（任何阶段通用）

1. 读 `docs/awf/<US-ID>/00-workflow/workflow-manifest.yaml`，确认状态与当前产物版本。
2. 读 `artifact-manifest.yaml`，确认依赖版本与 sha256。
3. 只读本阶段白名单内的输入（见 `context-assembly.md`）。
4. 产出结构化 YAML → 渲染 Markdown → 自检字段与引用闭合。
5. 返回摘要，由 A0 校验并推进，不自行改状态。

## 输出纪律

- YAML 必填字段一个不能少；缺数据写 `null` 并在 `notes` 说明，不得编造。
- 文档首行信息块固定：`Artifact / Version / US / Baseline / Status`，状态标记只能是 `DRAFT`、`UNCONFIRMED`、`NEEDS_REVIEW`、`NEEDS_RUNTIME_CONFIRM`、`TRACEABLE` 的组合。
- 证据格式统一：`graph:<node-id>`、`file:line`、`git:<commit>`、`doc:<doc-id>#<clause>`、`runtime:<source>`、`human:<decision-id>`。
- 检查项结论统一写 `pass` / `fail` / `not_applicable`，`not_applicable` 必须给理由。
- 不确定的结论写「待确认」，不要写「应该」「可能没问题」这类无法校验的表述。

## 失败与降级

| 情况 | 动作 |
| --- | --- |
| 输入缺失或版本不一致 | 停止，返回缺失项，不猜 |
| 校验不通过 | 返回具体字段与原因，等待重做 |
| 获取平台不可达 | 停在 A1，置 BLOCKED，不得空跑后续阶段 |
| 获取内容不完整 | 登记 gap，影响后端范围时不得进入 A2 |
| 图谱不可用 | 降级静态检索，标 `degraded` 与证据类型 |
| 检查项清单不可用 | 置 BLOCKED，不得跳过检查 |
| 连续两轮评审 FAIL | 写争议报告，停止自动循环 |
