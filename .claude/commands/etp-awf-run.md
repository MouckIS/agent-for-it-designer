---
description: 按 AWF 状态机推进工作流，派发 A1-A5 子代理，直到遇到人工门禁或阻断。
argument-hint: [US-ID]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Workflow
---

# /etp-awf-run

## 0. 定位工作流

若未给 US ID：扫描 `docs/awf/*/00-workflow/workflow-manifest.yaml`，只有一个则使用；多个则列出让用户选择；没有则提示先 `/etp-awf-start`。

## 1. 读取

1. `.claude/workflows/awf.js`（可执行 workflow 脚本，本命令通过 Workflow 工具执行它）
2. `.claude/skills/etp-awf-workflow/SKILL.md` 与 `.claude/skills/etp-awf-workflow/references/state-machine.md`、`.claude/skills/etp-awf-workflow/references/artifact-protocol.md`、`.claude/skills/etp-awf-workflow/references/gates-and-checks.md`、`.claude/skills/etp-awf-workflow/references/context-assembly.md`、`.claude/skills/etp-awf-workflow/references/orchestration-rules.md`
3. `docs/awf/<US-ID>/00-workflow/workflow-manifest.yaml`、`artifact-manifest.yaml`、`analysis-baseline.yaml`
4. 批次模式（`portfolio_id` 非空）：`docs/awf/portfolio.yaml`

## 2. 循环推进

循环在 `.claude/workflows/awf.js` 脚本内执行，本命令只负责读 manifest 定位阶段、调用 Workflow 工具、回收结果并更新状态。A1–A5 由脚本派发的子代理执行，A0（状态推进、产物校验、门禁停点）由脚本 + 主线程承担。

一次调用最多执行 8 个阶段动作，状态由 manifest 决定：

| status | 动作 |
| --- | --- |
| `BASELINE_CONFIRMED` / `A1_RUNNING` | 派发 `etp-requirement-collector` |
| `A2_RUNNING` | 派发 `etp-requirement-analyst` |
| `A3_RUNNING` | 派发 `etp-impact-analyst` |
| `A4_RUNNING` | 派发 `etp-technical-designer` |
| `A5_RUNNING` | 派发 `etp-design-reviewer` |
| `DESIGN_REVISION` | 按 `revision-instructions.yaml.target_agent` 派发 A1/A2/A3/A4（带 revision） |
| `WAITING_DEPENDENCY` | 检查上游 US 是否冻结；未完成则停下 |
| `WAITING_G*` | 停下，输出门禁摘要 |
| `COMPLETED` / `BLOCKED` | 停下，输出结果 |

派发对象与退出条件见 `orchestration-rules.md` §1 状态与派发；增量失效判定见 §4 增量重跑。批次模式规则见 §5 多 US 批次：

- `depends_on` 的上游 US 未冻结时，不派发 A4；停在 `WAITING_DEPENDENCY`。
- 无关 US 之间不读取对方产物。
- A4 完成后由 A0 执行一次跨 US 冲突扫描，命中则回写 `portfolio.yaml` 并转人工。

### 2.1 调用方式

调用 Workflow 工具执行脚本，参数只传事实，不传 prompt 正文：

```text
Workflow({
  name: "awf",
  args: {usId: "US-2026-001", usRef: "<链接或文件路径>", mode: "final", maxActions: 8}
})
```

| 参数 | 说明 |
| --- | --- |
| `usId` | 必填，US 标识 |
| `usRef` | 可选，US 平台链接或本地文件路径，透传给 A1 |
| `mode` | 可选，`final`（默认）/ `draft` |
| `maxActions` | 可选，本轮最多推进几个阶段动作，默认 8，上限 20 |
| `dryRun` | 可选，`true` 只做 Preflight 返回，不派发子代理 |
| `forceStage` | 可选，显式指定起始阶段；与 manifest 状态不一致时脚本拒绝 |

- 派发哪个 `agentType` 由脚本按 manifest 状态决定，子代理 prompt 由脚本按 `orchestration-rules.md` §2 子代理派发协议装配。
- 脚本不在 `name: "awf"` 的默认查找路径时，改用 `{scriptPath: ".claude/workflows/awf.js", args: {...}}`。
- 返回 `status` 为 `stopped` / `done` / `max_actions` / `blocked` / `error`；遇到门禁时带 `gate`，遇到阻断时带 `reason` 与 `next`。
- 本命令只消费返回摘要，仍要自己读文件复核。

### 2.2 返回后

1. 读取本阶段全部文件，核对字段、ID、版本、引用闭合（protocol 第 5 节）。
2. 更新 `artifact-manifest.yaml`：bundle、version、files、sha256、dependencies、status。
3. 更新 `workflow-manifest.yaml` 的 `artifacts`、`status`、`current_stage`。
4. 执行该阶段适用的 C 检查，结果写入 `00-workflow/workflow-report.md`：
   - A1 → C13、C14
   - A2 → C01、C02
   - A3 → C03、C04
   - A4 → C05、C06、C07、C11、C15
   - A5 → C08、C09、C12、C15、C16
5. 失败：不推进，记录原因，回到同一阶段重做一次；仍失败则 `BLOCKED` 并说明。

### 2.3 状态推进

- A1 完成：C13/C14 通过 → `A2_RUNNING`；存在影响后端范围的 gap → `BLOCKED`。
- A2 完成：final → `WAITING_G1`；draft → `A3_RUNNING`。存在未上报的 `scope_errors` → 回 `A1_RUNNING`。
- A3 完成：final → `WAITING_G2`；draft → `A4_RUNNING`（高风险证据缺口阻断时除外）。
- A4 完成：→ `A5_RUNNING`。
- A5 完成：
  - `PASS` / `CONDITIONAL_PASS` → `WAITING_G3`
  - `FAIL` → `DESIGN_REVISION`；读 ART-52，若 `round > 2` 则写 `05-review/DISPUTE.md` 并 `BLOCKED`，否则按 `target_agent` 派发重跑，随后再次 A5。
- 回流到 A1：重跑完成后直接进入 `A2_RUNNING`（A2 需基于新快照重做）。
- 回流到 A2：重跑完成后回到 `WAITING_G1`，必须重新取得人工确认。
- 回流到 A3：重跑完成后回到 `WAITING_G2`。
- 回流到 A4：重跑完成后直接进入 `A5_RUNNING`，由 A5 复核原问题是否关闭。

## 3. 门禁前输出

到达 `WAITING_G*` 时，输出：

```text
当前状态：WAITING_G1
产物：A2-001:v1（A1-001:v1 为输入）
阻断项：<逐条，无则写 无>
待决策项：DEC-001 ... DEC-00N
获取缺口：<G1 用>
高风险项：<G2 用>
检查项：executed=N/total=N, failed=N
建议：/etp-awf-gate G1
```

不要自行通过门禁，不要替用户选择决策项。门禁细则见 `gates-and-checks.md` 与 `orchestration-rules.md` §3 门禁。

## 4. 记录

每次派发与推进追加到 `00-workflow/workflow-report.md`：时间、阶段、产物版本、C 检查结果、状态变化、失败原因。

## 5. 结束条件

- 到达人工门禁
- 进入 `COMPLETED` 或 `BLOCKED`
- 停在 `WAITING_DEPENDENCY`
- 达到单次循环上限（输出当前进度，提示再次执行 `/etp-awf-run`）
