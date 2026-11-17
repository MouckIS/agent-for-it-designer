# 门禁与一致性检查

## 1. G1 需求确认

审批对象：ART-11（后端范围）、ART-21（需求澄清）、ART-22（决策记录）。审批人：研发/需求负责人；范围与验收标准需产品参与。

阻断项（任一存在则不能通过）：

1. 非 rejected 规则缺少 `source.type` 或 `source.reference`。
2. 非 rejected 规则没有对应 AC。
3. `source.type=inferred` 且 `confirmation_required=true` 的规则仍为 `confirmed`。
4. `open_questions` 中存在 `blocking=true` 且未裁决。
5. 针对需确认规则的 `DEC` 仍为 `pending`。
6. `in_scope` 为空，或 `out_of_scope` 未明确。
7. 存在未处理的 `conflicts[]`。
8. ART-10 中存在 `scope=unknown` 的内容块，或 `excluded[]` 无理由。
9. A2 输出的 `scope_error` 未关闭（后端范围判断与 ART-11 不一致）。
10. ART-10 的 `gaps[]` 未逐条处理，且缺口影响后端范围判断。

通过时必须提供决策：每条 pending DEC 选择 option，写入 `decision-log.yaml`，并把对应规则改为 `decision_status: confirmed`、`source.type: human`、`confirmation_required: false`，生成 A2 新版本。

`PARTIALLY_APPROVED`：仅允许非阻断项待定，必须列出待定清单与责任人；阻断项仍适用。

## 2. G2 高风险影响确认

审批对象：ART-31、ART-32。审批人：研发负责人。

阻断项：

1. 任意 `IMPACT.risk=BLOCKER` 未经人工确认。
2. `risk∈{BLOCKER,HIGH}` 且 `evidence_gap≠null`，既未补证也未在 `accepted_gaps` 中显式接受。
3. `impact_type=mandatory` 的触点没有 `evidence[]`。
4. `evidence_gaps[]` 中 `severity∈{BLOCKER,HIGH}` 的缺口未处理。

确认内容：数据写路径、权限、多租户、对外 API/MQ 契约、存量行为变化、特殊租户、无法静态确认的调用链。

同一表、同一契约被多个 US 修改时，G2 必须合并评审，避免分别确认后互相推翻。

## 3. G3 技术设计审批

审批对象：ART-41、ART-42、ART-51。审批人：技术负责人/架构师/相关研发。

前置条件（全部满足）：

- A5 结论为 `PASS`，或 `CONDITIONAL_PASS` 且所有 `conditions[].status=closed`。
- 不存在 `status=open` 的阻断问题。
- G1、G2 均为 `APPROVED` 或 `PARTIALLY_APPROVED`。
- C01、C02、C03、C05、C06、C07、C11、C15 通过。
- 发布顺序、灰度、应用回滚、数据回滚均有内容。
- 无 `STALE` 产物。
- 批次模式下，ART-04 中的冲突全部关闭。

通过后：五个 bundle 置 `final`，写 `frozen_at`，输出交付摘要。

## 4. 一致性规则 C01–C16

| ID | 判定 | 失败含义 |
| --- | --- | --- |
| C01 | 每条非 rejected 规则都被某个 `acceptance_criteria[].rule_ids` 覆盖 | 需求无法验收 |
| C02 | 不存在「inferred + confirmation_required=true + confirmed」；推断转 confirmed 必须有 DEC 或 human 来源 | 推断被当成需求 |
| C03 | 每个 `impact_type=mandatory` 的 `rule_refs` 或 `acceptance_refs` 至少一个指向存在的 A2 条目 | 触点无需求依据 |
| C04 | 存在 BLOCKER/HIGH 时，G2 已完成；draft 除外 | 高风险未确认 |
| C05 | 每个 mandatory 触点都出现在某个 `designs[].impact_refs` | 必改项无设计 |
| C06 | 每个 `DESIGN` 至少被一个 ADR 的 `references[]` 覆盖；迁移时必须存在 ADR | 决策不可解释 |
| C07 | 存在契约类触点（Controller/API/Listener/Producer/Consumer/MQ）时，`compatibility.required=true`、`strategy` 非空、`contracts[]` 覆盖这些触点 | 契约无兼容策略 |
| C08 | A5 结论非 FAIL，且无 `open` 阻断问题 | 评审未通过 |
| C09 | A2/A3/A4/A5 的 `*_ref` 与当前上游版本一致；纯文字修改可豁免 | 版本串味 |
| C10 | 关键人工修改后，对应门禁已重新确认（时间晚于修改） | 人工改动未复核 |
| C11 | 每个 DESIGN 的 impact 引用有效且能回溯到规则；每个文件变更都挂 DESIGN 与 IMPACT | 无依据设计 |
| C12 | 所有产物 `baseline_id` 一致；final 模式下基线有效（graph.commit 在声明的 lag_policy 内） | 基线失效 |
| C13 | ART-10 中每个内容块都有 `scope`，`frontend`/`out_of_scope` 均在 `excluded[]` 中给出理由；图片独有信息（接口/字段/枚举/错误码）已单独成块，不得仅因整图判为前端原型而整体归入 `frontend` | 内容被静默丢弃 |
| C14 | ART-10 的 `source` 含 `source_url`、`fetched_at`、`content_hash`，且快照文件存在；每个 `snapshot.assets[]` 的 `path` 真实存在且非空，`type=image` 的 `parse_status` ∈ `parsed/partial/unreadable/unsupported` 并带 `text`、`description`、`confidence`，非 `parsed` 时 `missing_parts` 非空并已登记对应 `gap` | 来源不可追溯 |
| C15 | 适用于当前阶段的检查项全部有结论；`not_applicable` 均有理由 | 检查项漏执行 |
| C16 | 批次模式下，触点重叠的 US 均已在 ART-04 登记并以 `depends_on` 或 `conflicts_with` 处理 | 跨 US 冲突未登记 |

检查执行者：A0 的校验脚本。每次推进前执行适用子集，并把 `{id, passed, evidence, note}` 写入 `00-workflow/workflow-report.md`；子代理可自查，但不能替代 A0 结论。脚本无法判定的规则转人工确认，不得默认通过。

## 5. DoD（final 交付）

| 项 | 通过条件 |
| --- | --- |
| 需求获取 | C13、C14 通过，缺口已处理 |
| 需求完整性 | C01 通过 |
| 需求准确性 | C02 通过，推断项均有确认状态 |
| 需求追溯 | 规则与 AC 均有来源 |
| 影响完整性 | C03 通过，mandatory 均有证据 |
| 风险管理 | 高风险已处理或显式接受 |
| 设计完整性 | C05 通过 |
| 技术决策 | C06 通过 |
| 兼容性 | C07 通过 |
| 数据设计 | 迁移有顺序与回滚；无迁移有原因 |
| 检查项覆盖 | C15 通过 |
| 跨 US 一致 | C16 通过，批次冲突全部关闭 |
| 评审 | C08 通过 |
| 人工审批 | G1/G2/G3 完整 |
| 版本一致性 | C09/C12 通过，无 STALE |
| 可追溯性 | C11 通过 |

## 6. 审批记录格式

```yaml
approvals:
  G2:
    status: APPROVED
    approver: 张工
    decided_at: 2026-11-15T22:10:00+08:00
    notes: 高风险数据写路径已确认，迁移方案补充后通过
    decisions: {}
    accepted_gaps: [IMPACT-003]
    rejected_to: null
```

禁止事项：替用户填写 approver、把「未回复」记为通过、用「默认同意」推进。

## 7. 条件关闭

`CONDITIONAL_PASS` 的条件写入 `review.conditions[]`，状态 `open`。关闭条件必须：由用户确认 → 更新 `conditions[].status=closed` 与 `closed_at`、`note` → 生成 A5 新版本 → 重跑 C08。未关闭条件阻塞 G3。
