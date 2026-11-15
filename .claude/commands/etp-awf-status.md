---
description: 查看 AWF 工作流状态：阶段、产物版本、门禁、一致性检查 C01-C16、失效、检查项与下一步。
argument-hint: [US-ID]
allowed-tools: Read, Glob, Grep, Bash
---

# /etp-awf-status

只读命令，不修改任何文件。

## 1. 定位

未给 ID 时扫描 `docs/awf/*/00-workflow/workflow-manifest.yaml`；多个则全部列出。

## 2. 读取

- `workflow-manifest.yaml`
- `artifact-manifest.yaml`
- `analysis-baseline.yaml`
- `docs/awf/portfolio.yaml`（批次模式）
- 各阶段 YAML（用于计算覆盖与引用）

## 3. 输出

```text
US: US-2026-001 | 模式: final | 状态: WAITING_G2 | 当前阶段: G2
基线: repo 8f3a9c2 / graph graph-20261114-001@8f3a9c2 / docs v1 / skills v1（提供人：张工）

产物
A1  A1-001:v1  draft  blocks=24 backend=15 unknown=1 gaps=2
A2  A2-001:v2  draft  rules=15 ac=15 decisions=6 scope_errors=0
A3  A3-001:v1  draft  mandatory=4 potential=8 high=10 gaps=0 conflicts=0
A4  -           -
A5  -           -

门禁
G1 APPROVED  2026-11-15 22:00  张工
G2 not_started
G3 not_started

一致性
C01 pass  C02 pass  C03 pass  C04 fail（缺 G2）  ...  C13 pass  C14 pass  C15 pass  C16 N/A（单 US）
失败明细: ...

检查项
A3 executed=6/6 failed=0 | A4 executed=— | A5 executed=—

失效/人工修改
stale: []
human_edits: 1（A2 文本修改，无需重跑）

下一步：/etp-awf-gate G2
```

## 4. 计算规则

1. 状态与阶段来自 manifest，不得推断。
2. 产物版本与 `artifact-manifest.yaml` 对照；磁盘存在但未登记的文件标 `unregistered`。
3. 执行 C01–C16；不可计算的标 `N/A + 原因`，不要默认 pass。
4. 若 sha256 与登记不一致：标 `MODIFIED`，提示运行 `/etp-awf-rerun`。
5. 若 `status=COMPLETED`：额外显示 `frozen_at`、交付目录、DoD 结论。
6. 批次模式：显示 `portfolio.yaml` 中依赖与冲突状态，以及哪些 US 处于 `WAITING_DEPENDENCY`。

## 5. 禁止

- 不修改文件。
- 不自动修复失败项。
- 不把 `N/A` 当作 `pass`。
