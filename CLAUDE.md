# 技术方案设计工作流（AWF）

本仓库用 Claude Code 的多 Agent 能力，把「US 获取 → 需求澄清 → 代码影响分析 → 技术设计 → 设计评审 → 正式交付」标准化为一条可追溯、可中断、可回流的流程。

本文件是入口约定。可执行的 workflow 脚本见 `.claude/workflows/awf.js`，流程规则（状态机、派发协议、门禁细则、增量重跑、异常处理）见 `.claude/skills/etp-awf-workflow/references/orchestration-rules.md`，执行前必须读取这两份。

## 何时启用

出现以下意图时启用本工作流：

- 输入产品 US / 需求，要求做需求澄清、影响分析或技术方案设计
- 需要从内部平台取回 US（含附件、图片、外部参考）并过滤出后端范围
- 要求评估某个改动的代码影响范围、兼容性、多租户风险
- 要求对已有技术方案做评审或评审整改
- 用户输入 `/etp-awf-start`、`/etp-awf-run`、`/etp-awf-gate`、`/etp-awf-status`、`/etp-awf-rerun`、`/etp-awf-review`

普通编码、修 bug、写单测不触发本工作流。

## 角色

| 角色 | 载体 | 职责 |
| --- | --- | --- |
| A0 控制面 | `.claude/workflows/awf.js` 编排脚本 + `etp-awf-controller` 子代理（执行层）+ 主线程的 `/etp-awf-*` 命令 | 基线校验、状态机、产物版本、门禁停点、一致性校验、多 US 调度 |
| A1 | `etp-requirement-collector` 子代理 | 调 `etp-requirement-fetch` 取 US、固化快照、过滤后端范围、登记缺口 |
| A2 | `etp-requirement-analyst` 子代理 | 需求澄清、规则来源、验收标准、待确认决策 |
| A3 | `etp-impact-analyst` 子代理 | 代码触点、功能影响、数据/契约/租户风险、证据、跨 US 冲突 |
| A4 | `etp-technical-designer` 子代理 | 详细设计、ADR、兼容迁移、发布回滚、检查项回应、文件清单 |
| A5 | `etp-design-reviewer` 子代理 | 独立复核需求/影响/设计/检查项/跨 US 一致性、修订指令 |

A0 控制面不是子代理：编排逻辑在 `.claude/workflows/awf.js` 脚本里，门禁停点与状态写入由主线程的 `/etp-awf-gate`、`/etp-awf-run` 命令承担。A0 执行层（Preflight、产物校验、登记）由 `etp-awf-controller` 子代理承担，只写 `00-workflow/`。A1–A5 是子代理，由脚本的 `agent(prompt, opts)` 以 `opts.agentType` 指定；子代理不能嵌套派发，workflow 内的 agent 也不能再嵌套 workflow。

## 硬性规则

1. **人工门禁不可自动通过**：G1/G2/G3 必须拿到用户在对话中的明确决定，才能写入审批记录。
2. **基线由人工提供**：分支、commit、图谱版本、docs 与 skills 版本由用户给出；A0 只校验、登记、判定失效，不得自行取当前 HEAD 或切换版本。
3. **原始需求快照只读**：`01-source/` 下的正文与附件不得改写；内容块不得静默丢弃，剔除必须有理由。
4. **不写业务代码**：本工作流只产出文档与结构化产物；除修正产物文件外不改仓库代码。
5. **证据优先**：影响点、技术决策必须能指向代码位置、图谱节点、文档条款或人工确认；无证据写 `evidence_gap`，不得推断为「无影响」。
6. **不扩大需求**：发现遗漏只能提问题，不能把推断写成已确认需求。
7. **职责分离**：A1 不解释需求，A2 不评估代码，A3 不设计实现，A4 不改影响范围，A5 不替 A4 改设计。
8. **检查项逐条留痕**：A3–A5 适用检查项必须给 `pass/fail/not_applicable`，`not_applicable` 需理由。
9. **版本不覆盖**：每次产出或人工修改都递增版本；旧版本依赖 git 历史保留，禁止原地覆盖后不留痕。
10. **draft 不得交付**：draft 产物必须带 `DRAFT` 标记，不得作为开发交接依据。

## 必读 Skill 与规则

| Skill | 何时读 |
| --- | --- |
| `.claude/skills/etp-awf-workflow/SKILL.md` | 每次 `/etp-awf-*` 与每个子代理启动时 |
| `.claude/skills/etp-awf-workflow/references/orchestration-rules.md` | 每次 `/etp-awf-run`、每个子代理派发前（状态与派发协议、门禁、增量重跑、异常处理、完成条件） |
| `.claude/skills/etp-requirement-fetch/SKILL.md` | A1 获取 US 前（当前为占位实现） |
| `.claude/skills/etp-project-checklist/SKILL.md` | A3/A4/A5 执行项目检查项前（当前为占位实现） |
| `.claude/skills/etp-code-graph-query/SKILL.md` | A3/A5 查询代码与图谱前 |
| `.claude/skills/etp-legacy-saas-analysis/SKILL.md` | A2–A5 做 SaaS 专项判断时 |
| `.claude/skills/etp-design-doc-writing/SKILL.md` | A1/A2/A3/A4 写文档前 |
| `.claude/skills/etp-design-review/SKILL.md` | A5 评审、G3 前自查 |

## 产物位置

`docs/awf/<US-ID>/` 下按 `00-workflow` … `05-review` 分目录，结构见 `.claude/skills/etp-awf-workflow/references/artifact-protocol.md`。多 US 批次另有 `docs/awf/portfolio.yaml`（ART-04）。

状态以 `00-workflow/workflow-manifest.yaml` 为唯一事实来源，任何阶段推进前先读它。
