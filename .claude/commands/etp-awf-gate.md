---
description: 执行 AWF 人工门禁 G1/G2/G3：展示阻断项与待决策项，记录用户决定并推进状态。绝不自动通过。
argument-hint: <G1|G2|G3> [US-ID]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /etp-awf-gate

参数：`$ARGUMENTS`（第一个是门禁，第二个可选 US ID）。

## 1. 读取

1. `.claude/skills/etp-awf-workflow/references/gates-and-checks.md`
2. `00-workflow/workflow-manifest.yaml`、`artifact-manifest.yaml`、`analysis-baseline.yaml`
3. 对应阶段产物；批次模式加读 `docs/awf/portfolio.yaml`

## 2. 计算阻断项

按 `gates-and-checks.md` 逐条判定，每条输出 `通过/未通过 + 依据（文件与字段）`。

- G1：规则来源、AC 覆盖、推断项状态、blocking 问题、pending 决策、范围、冲突、后端范围划分、获取缺口。
- G2：BLOCKER 风险、高风险证据缺口、mandatory 无证据、证据缺口清单、跨 US 同表/同契约冲突是否合并评审。
- G3：A5 结论与问题状态、条件关闭、G1/G2 记录、C01/C02/C03/C05/C06/C07/C11/C15、发布回滚完整性、STALE、批次冲突是否关闭。

状态不匹配（例如在 `A3_RUNNING` 调 G1）时直接拒绝，不做任何修改。

## 3. 展示

输出表格：

```text
门禁：G1
结论候选：APPROVED / PARTIALLY_APPROVED / REJECTED
阻断项：
1. ...
待决策：
DEC-001 部分退款是否需要按比例扣减会员积分
  选项：保持现有逻辑（推荐）/ 按比例扣减 / 不处理积分
后端范围：
BLK-002 退款页交互 → frontend，理由：页面组件与交互态
获取缺口：
GAP-001 图片无法识别，影响金额展示口径
```

然后**提问并等待用户回答**：结论、审批人、说明、逐条决策选择、接受的风险缺口。

## 4. 记录与执行

用户明确回答后：

### G1 通过

1. 把用户选择写入 `decision-log.yaml`（`status: decided`、`decision`、`decided_by`、`decided_at`）。
2. 对应规则改为 `decision_status: confirmed`、`source.type: human`、`confirmation_required: false`。
3. 关闭相关 blocking 问题。
4. 生成 A2 新版本（递增 version，重渲染 ART-21，更新 sha256）。
5. 重新执行 C01、C02，确认决策回写后仍通过。
6. 写 `approvals.G1`，状态 → `A3_RUNNING`。

### G1 退回

- 业务规则/范围问题：写 `REJECTED`，状态 → `A2_RUNNING`，记录退回原因。
- 后端范围判断错误：写 `REJECTED` + `rejected_to: A1`，状态 → `A1_RUNNING`，要求 A1 重新过滤。

### G2 通过

记录 `accepted_gaps`（用户逐项接受的 IMPACT），写 `approvals.G2`，状态 → `A4_RUNNING`。
用户不接受且要求补证：状态保持 `A3_RUNNING`，列出需补证据项。

### G3 条件关闭

若 A5 结论为 `CONDITIONAL_PASS` 且存在 `conditions[].status=open`：

1. 逐条向用户确认是否完成，记录 `closed_at` 与 `note`。
2. 更新 `review-report.yaml` 的 `conditions[]`，生成 A5 新版本并重渲染 ART-51。
3. 重新执行 C08；仍有 open 条件时不得进入 G3 通过流程。

### G3 通过

写 `approvals.G3`；五个 bundle 的 `status` 与文件内 `artifact.status` 改为 `final`；写 `frozen_at`；状态 → `COMPLETED`；输出交付摘要（产物清单、版本、覆盖情况、检查项统计、未关闭条件为零、批次冲突为零）。

### G3 退回

按用户指定的 `return_to` 迁移（默认 `A4_RUNNING`），列出需修改项；A1/A2/A3/A4 均可指定。

## 5. 禁止

- 用户未明确回答时不得写入审批记录。
- 不得用「默认同意」「视为通过」推进。
- 不得修改审批人姓名。
- 不得在存在阻断项时给 `APPROVED`；只能 `REJECTED` 或让用户先补证。
