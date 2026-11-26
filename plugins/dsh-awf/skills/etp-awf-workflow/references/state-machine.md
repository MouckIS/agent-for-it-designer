# 状态机

## 状态清单

| 状态 | 含义 | 必须存在的产物 | 允许的下一状态 |
| --- | --- | --- | --- |
| `CREATED` | 工作流已创建，等待人工基线 | `workflow-manifest.yaml` | `BASELINE_CONFIRMED`、`BLOCKED` |
| `BASELINE_CONFIRMED` | 基线校验通过，等待 A1 | ART-00、ART-01、ART-02 | `A1_RUNNING` |
| `A1_RUNNING` | A1 获取与后端范围过滤 | ART-00 | `A2_RUNNING`、`BLOCKED` |
| `A2_RUNNING` | A2 需求澄清 | ART-10、ART-11 | `WAITING_G1`、`A3_RUNNING`（draft）、`BLOCKED` |
| `WAITING_G1` | 等待需求确认 | ART-20、ART-21、ART-22 | `A3_RUNNING`、`A2_RUNNING`、`A1_RUNNING`、`BLOCKED` |
| `A3_RUNNING` | A3 影响分析 | ART-00、A2 产物 | `WAITING_G2`、`BLOCKED` |
| `WAITING_G2` | 等待高风险确认 | ART-30、ART-31、ART-32 | `A4_RUNNING`、`A3_RUNNING`、`BLOCKED` |
| `A4_RUNNING` | A4 技术设计 | ART-00、A2/A3 产物 | `A5_RUNNING`、`BLOCKED` |
| `A5_RUNNING` | A5 评审中 | ART-00、A2/A3/A4 产物 | `WAITING_G3`、`DESIGN_REVISION`、`BLOCKED` |
| `DESIGN_REVISION` | 按修订指令回流 | ART-50、ART-52 | `A1_RUNNING`、`A2_RUNNING`、`A3_RUNNING`、`A4_RUNNING`、`BLOCKED` |
| `WAITING_DEPENDENCY` | 多 US 批次等待上游 | ART-04、本 US 已有产物 | 原阶段、`BLOCKED` |
| `WAITING_G3` | 等待设计审批 | 全部阶段产物、ART-04（批次） | `COMPLETED`、`A4_RUNNING`、`A1_RUNNING`…`A3_RUNNING`、`BLOCKED` |
| `COMPLETED` | 已冻结并交付 | 全部 final 产物 | `A1_RUNNING`…`A5_RUNNING`（重新打开） |
| `BLOCKED` | 阻断，等待人工 | 阻断原因、必要的争议报告 | 人工指定阶段或 `BASELINE_CONFIRMED` |

## 迁移规则

1. 只有 A0 控制面可以改 `workflow-manifest.yaml.status`；子代理只写自己阶段目录。
2. 每次迁移写 `00-workflow/workflow-report.md`：时间、从状态、到状态、触发原因、操作者。
3. 迁移前必须满足前一状态的「退出条件」，否则保持原状态并记录失败原因。
4. 同一状态可重复进入（重跑、回流），但必须递增对应产物版本，不得复用旧版本号。
5. `COMPLETED` 后重新打开：先按 `orchestration-rules.md` §4 增量重跑判定失效范围，再迁移到最早受影响阶段，并清除 G3 记录。

## 退出条件

| 状态 | 退出条件 |
| --- | --- |
| `CREATED` | 人工基线四项（repo/graph/docs/skills）已提供且校验通过；ART-00/01/02 已写 |
| `BASELINE_CONFIRMED` | 进入 A1 派发 |
| `A1_RUNNING` | ART-10/11 存在；每个内容块有归属；快照元信息完整；C13/C14 通过 |
| `A2_RUNNING` | ART-20/21/22 存在；字段与引用自检通过；C01/C02 通过；final 模式进入 G1 |
| `WAITING_G1` | 用户 G1 结论已记录；若通过，决策项已应用并生成 A2 新版本 |
| `A3_RUNNING` | ART-30/31/32 存在；每个 mandatory 触点有规则或 AC 引用；C03 通过 |
| `WAITING_G2` | 用户 G2 结论已记录；高风险缺口已接受或补证 |
| `A4_RUNNING` | ART-40/41/42/43/44 存在；C05/C06/C07/C11/C15 通过；无 ADR 缺失 |
| `A5_RUNNING` | ART-50/51/52 存在；结论与问题状态自洽；轮次已写入 |
| `WAITING_G3` | 用户 G3 结论已记录；通过则五个阶段产物置 final |
| `DESIGN_REVISION` | 修订指令逐条回应；目标阶段新版本已生成；A5 已重跑 |
| `WAITING_DEPENDENCY` | 上游 US 产物已冻结，或用户明确解除依赖 |
| `BLOCKED` | 人工给出解除方案；记录在 `00-workflow/workflow-report.md` |

## 恢复与幂等

- 恢复时先读 manifest：若状态为 `*_RUNNING` 且对应产物已存在，先校验产物，再决定「复用/重做」，不得盲目重生成。
- 恢复时若发现 `stale[]` 非空，先处理最早失效阶段。
- 重复执行 `/etp-awf-run` 不得产生重复 bundle；只有内容变化才递增版本。
- 上游 US 未完成时，下游不得在 `WAITING_DEPENDENCY` 状态下自行继续。

## 状态与门禁的对应

| 门禁 | 等待状态 | 通过后 | 退回后 |
| --- | --- | --- | --- |
| G1 | `WAITING_G1` | `A3_RUNNING` | `A2_RUNNING`（范围错误回 `A1_RUNNING`） |
| G2 | `WAITING_G2` | `A4_RUNNING` | `A3_RUNNING` |
| G3 | `WAITING_G3` | `COMPLETED` | 按 `return_to` 到 A1/A2/A3/A4 |
