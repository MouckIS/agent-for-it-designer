---
name: etp-project-checklist
description: 从在线文档加载项目特有检查项，供 A3-A5 逐条执行并留痕。当前为占位实现，文档来源与解析待补充。
---

# 项目检查项（etp-project-checklist）

状态：**占位，待实现**。本文件只固定消费方式，文档来源与解析逻辑后续补充。

## 何时使用

A3、A4、A5 开始前读取；由各阶段按"适用于本阶段"的检查项执行。

## 消费契约

- 每条检查项有唯一 ID 与适用阶段。
- 每阶段只执行适用于本阶段的检查项，逐条给出 `pass` / `fail` / `not_applicable`。
- `not_applicable` 必须写明理由。
- 结论写入对应产物：A3 → `ART-30.checklist`，A4 → `ART-40.checklist`，A5 → `ART-50.checklist`。
- 清单不可用时置 `BLOCKED`，不得跳过检查。

## 待实现

- [ ] 在线文档位置与读取方式
- [ ] 检查项字段（ID、分类、适用模块、检查方式、严重级别、适用阶段、判定标准）
- [ ] 版本标识与缓存策略
- [ ] 解析与结构化输出格式

## 与基线清单的关系

`.claude/skills/etp-legacy-saas-analysis/references/saas-checklist.md` 是 SaaS 领域基线；本 Skill 提供项目特有检查项，两者叠加执行，冲突时以项目检查项为准。
