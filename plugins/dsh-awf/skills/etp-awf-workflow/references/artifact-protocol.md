# 产物协议（Artifact Protocol）

## 1. 目录结构

```text
docs/awf/
├── portfolio.yaml                     ART-04 批次（多 US 时）
└── <US-ID>/
    ├── 00-workflow/
    │   ├── workflow-manifest.yaml      ART-00 状态、门禁、轮次、失效
    │   ├── analysis-baseline.yaml      ART-01 基线（人工提供）
    │   ├── artifact-manifest.yaml      ART-02 版本、sha256、依赖
    │   └── workflow-report.md          ART-03 执行与人工操作记录
    ├── 01-source/
    │   ├── source-package.yaml         ART-10 原始需求快照与归属
    │   ├── backend-scope.md            ART-11 后端范围说明
    │   ├── raw.md                      原始正文快照（只读）
    │   └── assets/                     图片与附件
    ├── 02-requirement/
    │   ├── requirement-package.yaml    ART-20 结构化需求
    │   ├── requirement-clarification.md ART-21 需求澄清文档
    │   └── decision-log.yaml           ART-22 需求决策
    ├── 03-impact/
    │   ├── impact-package.yaml         ART-30 结构化影响
    │   ├── impact-analysis.md          ART-31 影响分析报告
    │   └── evidence-manifest.yaml      ART-32 证据清单
    ├── 04-design/
    │   ├── technical-design-package.yaml ART-40 结构化设计
    │   ├── technical-design.md           ART-41 正式设计方案
    │   ├── adrs/ADR-<nnn>.md             ART-42 技术决策
    │   ├── design-coverage.yaml          ART-43 覆盖矩阵
    │   └── expected-file-changes.yaml    ART-44 预期文件清单
    └── 05-review/
        ├── review-report.yaml          ART-50 结构化评审
        ├── review-report.md            ART-51 评审报告
        ├── revision-instructions.yaml  ART-52 修订指令
        ├── revision-history/           每轮评审与修订留档
        └── DISPUTE.md                  超轮次争议报告（仅 BLOCKED 时）
```

## 2. Bundle、版本与 ID

- 每个阶段的产物组成一个 bundle，ID 固定为 `A1-001`、`A2-001`、`A3-001`、`A4-001`、`A5-001`。
- 引用一律写成 `A2-001:v2`；bundle 内所有文件的 `version` 必须相同。
- 新版本 = 旧版本 + 1。追加新版本前，`artifact-manifest.yaml` 必须已有旧版本的 sha256 记录。
- 实体 ID 在单个 US 内唯一，编号从 001 开始；批次级 ID 在批次内唯一：

| 前缀 | 含义 | 产生者 |
| --- | --- | --- |
| `US-YYYY-NNN` | 需求 | 输入 |
| `BATCH-NNN` | US 批次 | A0 |
| `BASE-NNN` | 分析基线 | 人工提供，A0 登记 |
| `SRC-NNN` / `BLK-NNN` / `ASSET-NNN` / `GAP-NNN` | 来源 / 内容块 / 附件 / 获取缺口 | A1 |
| `R-NNN` / `AC-NNN` / `OQ-NNN` | 规则 / 验收标准 / 待澄清问题 | A2 |
| `DEC-NNN` | 需求决策 | A2 + G1 |
| `IMPACT-NNN` / `EVIDENCE-NNN` / `CONFLICT-NNN` | 影响触点 / 证据 / 跨 US 冲突 | A3 |
| `ADR-NNN` / `DESIGN-NNN` / `CHK-NNN` | 技术决策 / 设计项 / 检查项结论 | A4 |
| `REVIEW-NNN` / `REV-NNN` / `COND-NNN` | 评审问题 / 修订指令 / 条件 | A5 |

## 3. 公共头字段

所有结构化 YAML 首层必须包含：

```yaml
artifact:
  id: A2-001          # bundle id
  type: requirement    # source | requirement | impact | design | review
  version: 1
  generated_by: A2
  generated_at: 2026-11-15T21:00:00+08:00
  baseline_id: BASE-001
  status: draft        # draft | final | STALE
  dependencies:
    - {artifact_id: A1-001, version: 1}
  skills:
    requirement_fetch: v0.1
    project_checklist: v1
```

## 4. ART-00 workflow-manifest.yaml

```yaml
id: WF-001
us_id: US-2026-001
mode: final                  # draft | final
portfolio_id: null           # 批次模式必填 BATCH-001
status: WAITING_G1
current_stage: A2
baseline_id: BASE-001
review_rounds: 0
frozen_at: null
artifacts:
  A1: {bundle_id: A1-001, version: 1, status: draft}
  A2: {bundle_id: A2-001, version: 1, status: draft}
approvals:
  G1: {status: not_started}
  G2: {status: not_started}
  G3: {status: not_started}
stale: []                    # [{stage, ref, reason, at}]
human_edits: []              # [{stage, file, type, at, recheck_gate}]
blocked_reasons: []
```

审批记录字段：`status` ∈ `APPROVED` / `PARTIALLY_APPROVED` / `REJECTED` / `not_started`，另含 `approver`、`decided_at`、`notes`、`decisions`、`accepted_gaps`、`rejected_to`。

## 5. ART-01 analysis-baseline.yaml

```yaml
baseline:
  id: BASE-001
  us_id: US-2026-001
  provided_by: human
  provided_at: 2026-11-15T20:00:00+08:00
  repository: {name: legacy-saas, branch: release/10.x, commit: 8f3a9c2}
  knowledge_graph:
    provider: mcp
    version: graph-20261114-001
    commit: 8f3a9c2
    lag_policy: 允许落后一个发布窗口
  documentation: {version: docs-20261114-001, sources: [docs/knowledge/...]}
  skills:
    requirement_fetch: v0.1
    project_checklist: v1
    etp-awf-workflow: 1
    etp-legacy-saas-analysis: 1
    etp-design-doc-writing: 1
  capabilities: {runtime_evidence: false, git_history: true}
```

规则：

- 基线由人工提供，A0 只校验与登记，不得自行取当前 HEAD 或切换图谱版本。
- `knowledge_graph.commit` 与 `repository.commit` 不一致时，须在 `lag_policy` 声明范围内；超出范围时相关结论只能作为线索，必须静态复核，否则标 `evidence_gap`。
- Skill 版本（含检查项清单）变化与代码 commit 变化同等处理。

## 6. ART-02 artifact-manifest.yaml

```yaml
artifacts:
  - bundle_id: A2-001
    stage: A2
    version: 1
    status: draft              # draft | final | STALE
    files:
      - {path: 02-requirement/requirement-package.yaml, sha256: "..."}
      - {path: 02-requirement/requirement-clarification.md, sha256: "..."}
    dependencies: [{artifact_id: A1-001, version: 1}]
    review_status: pending
```

## 6.1 ART-04 portfolio.yaml（多 US 批次）

```yaml
portfolio:
  id: BATCH-001
  baseline_id: BASE-001
  parallel_limit: 3
  us_nodes:
    - us_id: US-2026-001
      mode: final
      status: WAITING_G1
      depends_on: []
      conflicts_with: []
    - us_id: US-2026-002
      mode: final
      status: CREATED
      depends_on: [{us_id: US-2026-001, reason: 复用同一退款表结构}]
      conflicts_with: [{us_id: US-2026-003, scope: module-order/RefundService.java}]
```

关系只能是 `depends_on`、`conflicts_with`、`none`；未登记的重叠由 A3 输出 `CONFLICT` 回写。

## 7. ART-10 source-package.yaml

必备字段：

| 字段 | 约束 |
| --- | --- |
| `source` | `platform`、`url`、`fetched_at`、`platform_updated_at`、`content_hash` 均非空 |
| `snapshot.ref` | 指向 `01-source/raw.md`，文件存在 |
| `snapshot.assets[]` | 每个附件/图片含 `id/path/type/parse_status`；图片（`type=image`）为多模态识读卡，另需 `original_name/kind/text/description/backend_signals[]/related_blocks[]/confidence`，非 `parsed` 时 `missing_parts` 非空；非图片附件（`pdf`/`doc`/`sheet`/`zip`）只需 `id/path/original_name/type/parse_status` 与 `text` 或失败原因 |
| `blocks[]` | 每块含 `id/title/location/scope/reason`；`scope ∈ backend/shared/frontend/out_of_scope/unknown` |
| `excluded[]` | `frontend` 与 `out_of_scope` 块必须在此给出理由 |
| `links[]` | `url/status/summary`；不可访问时 `status=failed` |
| `gaps[]` | `id/block_id/type/impact/action`，`impact` 说明是否影响后端范围判断 |
| `backend_scope` | `block_ids[]` 与计数 |

```yaml
requirement_source:
  id: A1-001
  version: 1
  us_id: US-2026-001
  baseline_id: BASE-001
  source: {platform: internal-requirement-platform, url: "https://...", fetched_at: 2026-11-15T20:10:00+08:00, platform_updated_at: 2026-11-12T09:30:00+08:00, content_hash: "sha256:9f2c..."}
  snapshot:
    ref: 01-source/raw.md
    assets:
      - id: ASSET-001
        path: 01-source/assets/image-01-refund-dialog.png
        original_name: 退款弹窗.png
        type: image
        kind: prototype
        parse_status: parsed
        confidence: high
        text: |-
          退款金额：￥1,280.00
          退款方式：原路退回
          [确认退款] [取消]
        description: 退款确认弹窗原型，金额与方式只读展示，两个操作按钮；无状态分支标注。
        backend_signals: [POST /api/refund/apply, 字段 refundAmount, 枚举 refundChannel=ORIGINAL]
        related_blocks: [BLK-001]
      - {id: ASSET-002, path: 01-source/assets/image-02-flow.png, type: image, kind: flowchart, parse_status: partial, confidence: medium, text: "提交 → 审核中 → …（右侧分支被裁剪）", description: 退款状态流转图，右侧「驳回」分支不可见。", backend_signals: [状态枚举 REFUNDING/SUCCESS/REJECTED], related_blocks: [BLK-003], missing_parts: 右侧驳回分支及后续状态}
  blocks:
    - {id: BLK-001, title: 退款金额校验, location: "2.3", scope: backend, reason: 描述接口校验逻辑}
    - {id: BLK-002, title: 退款页交互, location: "3.1", scope: frontend, reason: 页面组件与交互态}
  excluded:
    - {block_id: BLK-002, scope: frontend, reason: 前端负责，仅作背景}
  links:
    - {url: "https://.../refund-spec", status: reachable, summary: 财务退款口径说明}
  gaps:
    - {id: GAP-001, block_id: BLK-008, type: image_partial, impact: 影响：驳回状态是否落库无法确认，影响后端范围判断, action: 人工补充完整截图或状态机文档}
    - {id: GAP-002, block_id: BLK-009, type: image_unsupported, impact: 不影响（该文件为视觉稿） , action: 人工转 png 后重取}
  backend_scope: {block_ids: [BLK-001], total_blocks: 24, backend_blocks: 15}
```

## 8. ART-11 backend-scope.md

由 ART-10 渲染，章节固定：

1. 需求来源
2. 快照信息（来源、时间、哈希）
3. 内容结构与归属总览
4. 后端范围清单
5. 共用约定（接口/字段/错误码）
6. 前端范围（仅背景）
7. 剔除项与理由
8. 外部参考资料摘要
9. 附件与图片解析结果
10. 获取缺口与处理建议

## 9. ART-20 requirement-package.yaml

必备字段：

| 字段 | 约束 |
| --- | --- |
| `requirement.id/version/us_id/baseline_id` | 与 bundle 一致 |
| `requirement.source_ref` | 指向 `A1-001:vN` |
| `summary` | 非空，来自后端范围内的原文，不得加入推断 |
| `scope.in_scope[] / out_of_scope[]` | 至少各 1 条，out 可为「无」并说明 |
| `roles[]` | 非空 |
| `rules[]` | ≥1，字段见下 |
| `acceptance_criteria[]` | 每条非 rejected 规则至少 1 条 AC |
| `open_questions[]` | 含 `blocking` 布尔 |
| `risks[]` | 含 `severity` |
| `baseline_behavior[]` | 现存行为，不得混入 `rules[]` |
| `conflicts[]` | US 与规范/历史决策冲突 |
| `scope_errors[]` | 与 ART-11 归属不一致的块，需退回 A1 |
| `input_gaps_handled[]` | ART-10 每个 gap 的处理结论 |

规则字段：

```yaml
- id: R-001
  description: 部分退款金额不能超过剩余可退款金额
  source: {type: explicit, reference: US-2026-001#2.3}
  confidence: high            # high | medium | low
  behavior_change: true       # true | false | unknown
  confirmation_required: false
  decision_status: confirmed  # confirmed | pending | rejected | assumption
  category: functional        # functional|data|api|permission|tenant|billing|non_functional|compatibility
  risk: MEDIUM
  source_block: BLK-001
```

`source.type` 只能是：`explicit`（US 原文）、`specification`（现行规范）、`existing`（代码现状，仅用于 `baseline_behavior`）、`inferred`（推断）、`unknown`（无法确认）、`human`（人工确认后）。

AC 字段：`id, rule_ids[], preconditions, steps, expected, role_scope?, tenant_scope?`。

## 10. ART-22 decision-log.yaml

```yaml
decisions:
  - id: DEC-001
    question: 部分退款是否需要按比例扣减会员积分
    source: R-002
    options: [保持现有逻辑, 按退款比例扣减, 部分退款不处理积分]
    recommended_option: 保持现有逻辑
    status: pending            # pending | decided | deferred | rejected
    decided_by: null
    decision: null
    decided_at: null
```

## 11. ART-30 impact-package.yaml

```yaml
impact_analysis:
  id: A3-001
  version: 1
  baseline_id: BASE-001
  requirement_ref: A2-001:v2
  summary: {mandatory_changes: 3, potential_changes: 2, high_risks: 1}
  impacts:
    - id: IMPACT-001
      rule_refs: [R-001]
      acceptance_refs: [AC-001]
      target: {module: module-order, file: module-order/.../RefundService.java, symbol: RefundService.refund, line: 120}
      impact_type: mandatory   # mandatory | potential | read_only
      evidence:
        - {type: static_analysis, reference: "module-order/.../RefundService.java:120", confidence: high}
      affected_features: [订单退款]
      risk: HIGH               # BLOCKER|HIGH|MEDIUM|LOW|INFO
      reason: 需要调整退款金额计算逻辑
      constraints: [保持原有全额退款行为]
      status: confirmed        # confirmed | pending | unconfirmed
      evidence_gap: null
  in_flight_conflicts: []      # 批次外分支冲突
  cross_us_conflicts: []       # [{other_us, scope, type, handled}]
  runtime_evidence_requests: []
  evidence_gaps: []
  checklist: {skill_version: v1, results: []}
```

证据类型固定为：`graph_proven`、`static_analysis`、`runtime_proven`、`configuration_proven`、`git_history`、`heuristic`、`needs_runtime_confirm`。

## 12. ART-32 evidence-manifest.yaml

```yaml
evidence_manifest:
  id: A3-001
  baseline_id: BASE-001
  items:
    - id: EVIDENCE-001
      type: graph_proven
      source: graph-node-001
      description: RefundService 调用 RefundRepository
      impact_refs: [IMPACT-001]
      confidence: high
```

## 13. ART-40 technical-design-package.yaml

```yaml
technical_design:
  id: A4-001
  version: 1
  baseline_id: BASE-001
  requirement_ref: A2-001:v2
  impact_ref: A3-001:v2
  decisions: [ADR-001]
  designs:
    - id: DESIGN-001
      impact_refs: [IMPACT-001]
      description: 扩展退款金额计算逻辑
      status: proposed
      rules: [R-001]
      approach: 扩展现有实现
  file_changes:
    - {path: module-order/.../RefundService.java, operation: modify, impact_refs: [IMPACT-001], design_refs: [DESIGN-001], reason: 修改退款计算}
  migration: {required: false, reason: 现有结构可支持, steps: [], order: [], rollback: not_required}
  compatibility:
    required: true
    strategy: 保持原有全额退款行为
    contracts: []
    legacy_behavior: []
    deviations: []
  observability: {logging: required, metrics: optional, tracing: existing, audit: required}
  rollback: {strategy: 回退应用版本, data_rollback: not_required, release_order: [], gray_strategy: 按现有流程}
  checklist:
    skill_version: v1
    results:
      - {id: CHK-TENANT-01, result: pass}
      - {id: CHK-BILL-03, result: not_applicable, reason: 不涉及计费规则}
  cross_us:
    depends_on: []
    conflicts_with: []
  skill_versions: {etp-awf-workflow: 1, etp-legacy-saas-analysis: 1}
  test_plan: []
```

`operation` ∈ `add|modify|delete`；`migration.required=false` 时 `reason` 必填；`checklist.results` 必须覆盖适用于 A4 的全部检查项。

## 14. ART-42 / ART-43 / ART-44

- ADR 每个文件一条：`id, title, status, context[], options[]（≥2，含 selected 与 reason）、consequences[], references[]（必须含 IMPACT/DESIGN/R）。`
- 覆盖矩阵每行：`{ref_id, ref_type: R|AC|IMPACT, design_id, section, status: Covered|Partial|Missing, note}`。
- 文件清单每行：`{path, operation, impact_refs[], design_refs[], reason, verified}`，`verified` 表示该路径在基线仓库中是否存在。

## 15. ART-50 / ART-52

评审结论只能取 `PASS`、`CONDITIONAL_PASS`、`FAIL`。每个问题：

```yaml
- id: REVIEW-001
  category: compatibility      # requirement|impact|design|data|contract|compatibility|saas|release|complexity|observability|checklist|cross_us
  description: 未说明原有全额退款逻辑如何保持兼容
  references: [R-001, IMPACT-001, DESIGN-001]
  evidence: ["module-order/.../RefundService.java:118"]
  recommendation: 补充新旧退款逻辑兼容设计
  return_to: A4
  status: open                 # open | closed | accepted
  blocking: true
  check: C07
```

修订指令：`{id: REV-001, review_id: A5-001, target_agent: A4, round: 1, issues[{review_id, target_section, instruction, required_evidence[], expected_output[]}], invalidated_artifacts[], preserved_artifacts[]}`。

### 15.1 ART-50 review-report.yaml（根结构）

```yaml
review:
  id: A5-001
  version: 1
  requirement_ref: A2-001:v2
  impact_ref: A3-001:v2
  design_ref: A4-001:v1
  conclusion: PASS            # PASS | CONDITIONAL_PASS | FAIL
  blocking_issues: []
  suggestions: []
  conditions: [{id: COND-001, description: 高风险证据缺口需确认, status: open}]
  coverage: {requirement_coverage: complete, impact_coverage: complete, design_coverage: complete}
  checklist: {skill_version: v1, total: 18, executed: 18, failed_items: []}
  independent_verification: {queries: 0, nodes: 0, missed_impacts: [], saas: {passed: true, items: []}}
  cross_us: {checked: false, conflicts: []}
  round: 1
```

## 16. 双产物与人工修改

- Markdown 只能由 YAML 渲染，标题层级与章节名必须与模板一致。
- 修改 YAML 后必须同步重渲染 Markdown，并更新 sha256；两者版本号必须相同。
- 人工修改检测：比对 `artifact-manifest.yaml` 的 sha256 与当前文件；不一致即视为人工修改。
- 原始需求快照（`01-source/raw.md` 与 assets）只读，人工不得直接改写；需要修正必须重新获取或补充材料并生成新版本。
- 人工修改分类与处理：

| 修改位置 | 类型 | 处理 |
| --- | --- | --- |
| 内容块归属/剔除项 | 获取语义 | 新版本 + 重跑 A1→A5 + 重验 G1/G2/G3 |
| 规则/范围/AC | 需求语义 | 新版本 + 重跑 A2→A5 + 重验 G1/G2/G3 |
| 影响触点/证据 | 影响语义 | 新版本 + 重跑 A3→A5 + 重验 G2/G3 |
| 设计/ADR/文件清单 | 设计语义 | 新版本 + 重跑 A4/A5 + 重验 G3 |
| 评审结论/问题 | 评审语义 | 新版本 + 重跑 A5 + 重验 G3 |
| 仅措辞 | 文本 | 记录并重渲染，不重跑 |

- 人工修改必须在 `workflow-manifest.yaml.human_edits` 留痕；关键修改后未重新确认的，C10 判 FAIL。

## 17. STALE 与冻结

- 上游产物新版本导致下游依赖失效时，下游 `status` 置 `STALE`，`stale[]` 记录原因与时间。
- STALE 产物不得用于 G3，不得标记 `final`。
- G3 通过后，五个 bundle 全部置 `final`，记录 `frozen_at`；之后任何修改都必须产生新版本并重新走门禁。

## 18. 交付判定

交付包合格需同时满足：目录与文件名齐全、必填字段非空、引用闭合、版本与 sha256 一致、无 STALE、A5 无 open 阻断项、检查项全部有结论、G1/G2/G3 记录完整、文档无 `DRAFT` 标记；批次模式下 ART-04 冲突全部关闭。
