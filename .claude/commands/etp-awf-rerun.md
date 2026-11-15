---
description: 检测产物、需求快照或基线变化，按依赖关系标记失效、重置门禁，并把工作流移到最早受影响阶段。
argument-hint: <A1|A2|A3|A4|A5> [US-ID]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /etp-awf-rerun

## 1. 检测变化

对 `artifact-manifest.yaml` 中每个文件计算 `sha256sum`，与登记值比较。同时：

```bash
git status --short
git diff --name-only <baseline.commit>
```

判定变化类型：

| 变化 | 类型 | 重跑范围 |
| --- | --- | --- |
| 01-source 正文/附件（US 变更） | source | A1→A5 |
| 内容块归属/剔除项 | a1_scope | A1→A5 |
| requirement 规则/范围/AC | a2_rules | A2→A5 |
| decision-log | a2_decision | A2→A5 |
| requirement 仅措辞 | a2_text | 不重跑，重渲染文档 |
| impact 触点/证据 | a3_impacts | A3→A5 |
| impact 仅措辞 | a3_text | 不重跑 |
| design/ADR/文件清单 | a4_design | A4、A5 |
| review 结论/问题 | a5_review | A5 |
| 检查项清单版本变化 | checklist | 按检查项适用阶段 |
| 代码基线变化且命中触点 | code | A3→A5 |
| 代码基线变化但未命中 | none | 记录后继续 |

无法判断时：读 `git diff` 的具体文件，按修改字段分类，不要一律全量重跑。

## 2. 失效处理

1. 上游变更产生新版本（版本 +1），旧版本保留在 git 历史。
2. 下游 bundle `status: STALE`，文件内 `artifact.status: STALE`。
3. `workflow-manifest.yaml.stale[]` 追加 `{stage, ref, reason, at}`。
4. 仅文本修改（`*_text`）：
   - 生成新版本号，按 YAML 重渲染对应 Markdown，更新 sha256 与 manifest；
   - 写入 `human_edits[]`（type=text，recheck_gate=null）；
   - 不重跑，不重置门禁。
5. 重置受影响门禁为 `not_started`：
   - source / a1_* → G1、G2、G3
   - a2_* → G1、G2、G3
   - a3_* → G2、G3
   - a4_* → G3
   - a5_* → G3
6. 人工修改写入 `human_edits[]`，含类型、时间、需要重验的门禁。
7. 状态迁到最早受影响阶段（`A1_RUNNING` / `A2_RUNNING` / `A3_RUNNING` / `A4_RUNNING` / `A5_RUNNING`）。
8. 批次模式下，若本 US 变化影响下游 US，在 `portfolio.yaml` 标记下游 `needs_review`。

## 3. 参数指定

用户显式给阶段时，以参数为准并说明与自动判定的差异：

- 若参数早于自动判定：允许（更保守）。
- 若参数晚于自动判定：拒绝并解释（会留下失效上游）。

## 4. 输出

```text
检测到变化: A2 业务规则（requirement-package.yaml）
失效: A3-001:v1, A4-001:v1, A5-001:v1
重置门禁: G1, G2, G3
当前状态: A2_RUNNING
下一步: /etp-awf-run
```

## 5. 禁止

- 不删除旧版本文件。
- 不在未记录失效的情况下继续使用下游产物。
- 不把代码基线变化一律当作「无影响」，必须先求触点交集。
- 不直接改写 `01-source/raw.md`；需求变化必须走重新获取并生成新版本。
