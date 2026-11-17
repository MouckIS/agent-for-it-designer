---
description: 强制重新执行 A5 独立设计评审。适用于人工修改设计后、或需要独立复核时。
argument-hint: [US-ID]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Workflow
---

# /etp-awf-review

## 1. 前置检查

- 必须存在 A1～A4 产物，且 A4 不是 `STALE`。
- 若 `review-report.yaml` 已存在：把当前 `05-review/*` 复制到 `05-review/revision-history/round-<n>/` 留档，再生成新版本。
- 更新 `workflow-manifest.yaml`：状态 → `A5_RUNNING`，`review_rounds` 保持不变（由 A5 返回后递增）。

## 2. 执行 A5

调用 Workflow 工具执行 `.claude/workflows/awf.js`，用 `forceStage` 把本轮限定到 A5（前置检查已把状态置为 `A5_RUNNING`，脚本会校验二者一致）：

```text
Workflow({
  name: "awf",
  args: {usId: "US-2026-001", forceStage: "A5", maxActions: 1}
})
```

`agentType` 由脚本内部按阶段指定为 `etp-design-reviewer`，prompt 由脚本按 `orchestration-rules.md` §2 子代理派发协议装配，额外要求：

- 必须做独立检索，记录检索次数与范围
- 逐条复查上一轮未关闭问题
- 复核适用检查项是否执行完整，有无虚假 `not_applicable`
- 批次模式下检查跨 US 冲突
- 输出结论、问题、条件、修订指令

## 3. 校验与记录

1. 读 ART-50/51/52，校验字段、`return_to`、轮次、引用闭合、检查项统计。
2. 更新 `artifact-manifest.yaml` 与 `workflow-manifest.yaml`。
3. 追加 `00-workflow/workflow-report.md`：评审轮次、结论、阻断数、独立检索次数、回流目标。
4. 状态推进：
   - `PASS` / `CONDITIONAL_PASS` → `WAITING_G3`
   - `FAIL` 且轮次 ≤2 → `DESIGN_REVISION`
   - `FAIL` 且轮次 >2 → 写 `05-review/DISPUTE.md`，`BLOCKED`

## 4. 输出

```text
评审轮次: 2
结论: CONDITIONAL_PASS
阻断: 0 | 条件: 1（COND-001 证据缺口待确认）
独立检索: 14 次 / 23 节点
检查项: 18/18 执行，0 失败
下一步: /etp-awf-gate G3（条件关闭后）
```

## 5. 禁止

- 不修改 A4 设计内容来「帮助通过」。
- 不跳过独立检索直接复用旧结论。
- 不在轮次超限后继续自动循环。
