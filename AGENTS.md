# Agent 入口

本仓库的工作流、子代理、技能与命令定义在 `.claude/` 下，入口约定见 `CLAUDE.md`。

- 工作流：`.claude/workflows/awf.js`（可执行编排脚本，`{name: "awf"}` 调用）；流程规则见 `.claude/skills/etp-awf-workflow/references/orchestration-rules.md`
- 子代理：`.claude/agents/`（etp-awf-controller / etp-requirement-collector / etp-requirement-analyst / etp-impact-analyst / etp-technical-designer / etp-design-reviewer）
- 技能：`.claude/skills/`（etp-awf-workflow / etp-requirement-fetch / etp-project-checklist / etp-legacy-saas-analysis / etp-design-doc-writing / etp-code-graph-query / etp-design-review）
- 命令：`.claude/commands/etp-awf-*.md`
- 使用说明：`USAGE.md`

开始：`/etp-awf-start <US-ID> [US 链接或文件路径]`（需先提供人工基线），然后 `/etp-awf-run`。
