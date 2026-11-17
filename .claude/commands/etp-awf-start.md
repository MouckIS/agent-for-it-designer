---
description: 启动 AWF 工作流：登记并校验用户提供的人工基线，初始化产物目录与 manifest。不建立基线，不做需求分析。
argument-hint: <US-ID> [US 链接或文件路径]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /etp-awf-start

参数：`$ARGUMENTS`（第一个是 US ID，第二个可选：平台链接或本地文件路径；都缺时询问）。

## 1. 读取协议

1. `.claude/workflows/awf.js`（可执行编排脚本，本命令不执行它，只对齐其产物约定）
2. `.claude/skills/etp-awf-workflow/SKILL.md` 与 `.claude/skills/etp-awf-workflow/references/artifact-protocol.md`、`.claude/skills/etp-awf-workflow/references/state-machine.md`、`.claude/skills/etp-awf-workflow/references/orchestration-rules.md`

## 2. 建目录

```bash
mkdir -p docs/awf/<US-ID>/{00-workflow,01-source/assets,02-requirement,03-impact,04-design/adrs,05-review/revision-history}
```

用户给了本地 US 文件时，复制为 `docs/awf/<US-ID>/01-source/raw.md`；给了平台链接时留空，由 A1 获取。

若目标目录已有 `workflow-manifest.yaml`，停止并提示使用 `/etp-awf-status`，不要覆盖。

批次模式：`docs/awf/portfolio.yaml`（ART-04）由人工登记，包含批次内所有 US、依赖与冲突。文件不存在时按单 US 处理，`portfolio_id` 写 `null`。

## 3. 登记人工基线

基线由用户提供，A0 不自行建立。可先用只读命令给出建议值，但必须经用户确认后才写入：

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
git remote get-url origin
```

必须向用户确认四项：

| 项 | 取值 |
| --- | --- |
| repository | 仓库名 + branch + commit（用户指定） |
| knowledge_graph | MCP provider + graph version + graph commit + 允许的 lag_policy |
| documentation | docs version 或 none |
| skills | etp-requirement-fetch、etp-project-checklist、etp-awf-workflow、etp-legacy-saas-analysis、etp-design-doc-writing 的版本 |

用户未明确给出的项写 `null` 并停下，不得用当前 HEAD 或猜测值替代。

## 4. 写产物

### analysis-baseline.yaml

按 `artifact-protocol.md` 第 5 节，含 `baseline.id: BASE-001`、`provided_by: human`、`provided_at`、`lag_policy`。

### artifact-manifest.yaml

初始写 `artifacts: []`；后续每次产出由 A0 追加文件、sha256 与依赖。

### workflow-manifest.yaml

```yaml
id: WF-001
us_id: <US-ID>
mode: final
portfolio_id: null
status: BASELINE_CONFIRMED
current_stage: A1
baseline_id: BASE-001
review_rounds: 0
frozen_at: null
artifacts: {}
approvals: {G1: {status: not_started}, G2: {status: not_started}, G3: {status: not_started}}
stale: []
human_edits: []
blocked_reasons: []
```

### 00-workflow/workflow-report.md

记录：创建时间、基线四项与提供人、模式、US 来源、执行人。

## 5. 校验

- [ ] 五个目录存在
- [ ] US 来源已登记（链接或文件路径），或明确由 A1 获取
- [ ] baseline 四项齐全且由用户确认（允许 `null`，但必须显式）
- [ ] status = `BASELINE_CONFIRMED`
- [ ] graph.commit 与 repo.commit 的偏差在 `lag_policy` 内；超出时不阻断启动，但写入 `baseline_drift` 并要求用户确认

## 6. 输出

一行摘要 + 下一步：

```text
已创建 docs/awf/US-2026-001，基线 BASE-001（repo 8f3a9c2 / graph graph-20261114-001@8f3a9c2 / docs v1 / skills v1）
下一步：/etp-awf-run
```
