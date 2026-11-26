---
name: etp-design-doc-writing
description: AWF 技术方案文档的写作规范与五类文档模板：后端范围说明、需求澄清、影响分析、技术设计、设计评审。A1/A2/A3/A4 落盘 Markdown 前必须读取，保证章节、状态标记、证据引用与双产物一致。
---

# 技术方案文档写作

## 1. 双产物

| 形式 | 用途 | 要求 |
| --- | --- | --- |
| YAML | 机器校验、追溯、门禁 | 必填字段齐全，ID 与版本合法 |
| Markdown | 人阅读、评审、交接 | 章节固定，由 YAML 渲染，不手工改结构 |

规则：

- 两者版本号必须相同，Artifact ID 必须相同。
- 先定 YAML，再渲染 Markdown；人工改 YAML 后必须重渲染。
- Markdown 中的计数、清单、矩阵必须与 YAML 一致，不允许各写一套。

## 2. 文档头

```markdown
> Artifact: A4-001:v2 | US: US-2026-001 | Baseline: BASE-001
> 状态: NEEDS_REVIEW | 代码基线: 8f3a9c2 | 图谱: graph-20261114-001@8f3a9c2
> Framework Skill: <version> | 项目检查项: <version> | SaaS 基线: <version>
```

状态标记只能是：`DRAFT`、`UNCONFIRMED`、`NEEDS_REVIEW`、`NEEDS_RUNTIME_CONFIRM`、`TRACEABLE`（可组合）。

## 3. 写作规则

1. 先结论后依据；每节开头一句话说明本节回答什么。
2. 用表格承载清单与矩阵；用短段落解释原因；禁止大段形容词。
3. 所有关键结论带证据：`（file:line）`、`（graph:node-id）`、`（doc:id#clause）`、`（DEC-001）`。
4. 不确定写「待确认 + 责任人 + 影响」，不写「应该没问题」。
5. 数字必须可核对：计数与 YAML 一致。
6. 不使用「全面」「彻底」「完美」这类不可验证表述。
7. 引用上游时写 ID 和版本：`R-003`、`IMPACT-002@A3-001:v2`。
8. 设计文档必须能让未参与讨论的研发独立实现。

## 4. 结构与模板

| 文档 | 模板 | 必要章节数 |
| --- | --- | --- |
| ART-11 后端范围说明 | `references/source-template.md` | 10 |
| ART-21 需求澄清 | `references/requirement-template.md` | 12 |
| ART-31 影响分析 | `references/impact-template.md` | 12 |
| ART-41 技术设计 | `references/design-template.md` | 13 |
| ART-51 评审报告 | `references/review-template.md` | 12 |

章节标题必须与模板完全一致（含编号），否则 A0 校验不通过。

## 5. 常见问题

- 后端范围说明里解释业务规则 → 越界，移到 A2。
- 需求文档里写实现方案 → 越界，移出。
- 影响分析写「建议使用策略模式」 → 越界，移到 A4。
- 设计文档重复 A3 的触点清单但不给方案 → 无效章节。
- 评审报告只写「整体合理」 → 不可校验，必须给检查项与证据。
- 覆盖率只写百分比不给明细 → 无效，必须逐条列出。
