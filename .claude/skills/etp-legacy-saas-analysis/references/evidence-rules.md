# 证据规则

## 1. 什么叫证据

证据必须能被人复核：给出位置，而不是给出结论。

合格：

- `module-order/src/main/java/com/acme/order/RefundService.java:118` 中金额比较逻辑
- `graph:graph-node-001` 关系 `CALLS -> RefundRepository.save`
- `docs/knowledge/refund-rules.md#金额规则` 第 2 条
- `git:8f3a9c2` 中该文件的上次变更
- `runtime:api-access#/api/order/refund` 近 30 天调用量

不合格：

- 「退款服务里应该会调用积分服务」
- 「参考原有逻辑即可」
- 「一般来说不会影响其他模块」

## 2. 类型选择

| 场景 | 首选类型 |
| --- | --- |
| 图谱能给出完整路径 | graph_proven |
| 代码里能直接看到定义/调用/SQL | static_analysis |
| 配置项决定行为 | configuration_proven |
| 历史变更导致当前形态 | git_history |
| 线上实际调用/执行 | runtime_proven |
| 只能靠命名与上下文推断 | heuristic（必须写推断链） |
| 动态/反射/租户差异无法确认 | needs_runtime_confirm |

## 3. 证据缺口

缺口必须写清：缺什么数据、为什么静态分析不够、缺少会导致什么误判、建议如何补。风险等级沿用所在触点的等级。

## 4. 冲突处理

1. 图谱与代码不一致 → 代码为准，记录 drift。
2. 文档与代码不一致 → 代码为准，标注规范可能过期，交 A2/G1 裁决。
3. 运行时与代码不一致 → 记录实际行为，标 `runtime_proven`，并说明代码路径为何不同。
4. 两个证据互相矛盾 → 不选边，列为 `conflict` 交人工。

## 5. 覆盖要求

- 每个 mandatory 触点 ≥1 条证据。
- 每个 HIGH/BLOCKER 触点 ≥2 条（其中至少 1 条静态或运行时）。
- 每个契约变更必须有生产方与消费方两侧证据，或明确标注消费方未知。
