/**
 * The C rules (C01–C20) from DS-V5 §4.2.
 *
 * Each rule is a pure function of the artifacts on disk plus the workflow
 * manifest, so the same rule can gate a gate, gate a stage verification and be
 * replayed by a test. A rule that cannot decide returns `not_applicable` with a
 * reason — never a silent pass: DS-V5 K-rules and `gates-and-checks.md` both
 * forbid "cannot judge" from counting as green.
 */

import { createHash } from 'node:crypto'
import { dump } from './yaml.js'
import { CHECKS, CHECK_IDS, GATES } from './constants.js'

const PASS = 'pass'
const FAIL = 'fail'
const NA = 'not_applicable'

/** Result object shape every rule returns. */
function result(id, outcome, evidence, note) {
  const meta = CHECKS.find(check => check.id === id)
  return { id, title: meta ? meta.title : id, strength: meta ? meta.strength : 'C', result: outcome, evidence: evidence || '', note: note || '' }
}

/** Read a nested value without throwing on a missing parent. */
function at(value, ...path) {
  let cursor = value
  for (const step of path) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[step]
  }
  return cursor
}

/** An array, or an empty one. */
function list(value) {
  return Array.isArray(value) ? value : []
}

/** A stable hash for a YAML artifact body, ignoring the hash field itself. */
export function contentHashFor(value) {
  const clone = JSON.parse(JSON.stringify(value ?? {}))
  if (clone.artifact && typeof clone.artifact === 'object') clone.artifact.source_hash = ''
  return createHash('sha256').update(dump(clone) + '\n', 'utf8').digest('hex')
}

/** Parse `A2-001:v3` into its stage and version. */
export function parseRef(ref) {
  const match = /^([A-Z]\d)-(\d{3}):v(\d+)$/u.exec(String(ref ?? '').trim())
  if (match === null) return undefined
  return { stage: match[1], bundleId: `${match[1]}-${match[2]}`, version: Number(match[3]) }
}

/** Does any string in `values` look like a contract surface? */
const CONTRACT_HINT = /(controller|resource|endpoint|api|route|handler|listener|producer|consumer|mq|topic|kafka|rocketmq|dubbo|feign|rpc|grpc|webservice|servlet)/iu
function isContractSurface(impact) {
  const target = at(impact, 'target') || {}
  const haystack = [target.module, target.file, target.symbol, ...list(impact.affected_features)].filter(Boolean).join(' ')
  return CONTRACT_HINT.test(haystack)
}

/** Rule ids that reference a versioned upstream bundle, e.g. `A2-001:v2`. */
function collectRefs(value, found = []) {
  if (typeof value === 'string') {
    const parsed = parseRef(value)
    if (parsed !== undefined) found.push({ ref: value, ...parsed })
    return found
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectRefs(item, found)
  }
  return found
}

/**
 * Run a subset of the C rules.
 *
 * @param {object} input
 * @param {Record<string, any>} input.artifacts parsed YAML artifacts keyed by ART id
 * @param {object|undefined} input.manifest workflow manifest (ART-00)
 * @param {object|undefined} input.baseline analysis baseline (ART-01)
 * @param {Record<string, string>} [input.markdown] Markdown artifact text keyed by ART id
 * @param {Record<string, any>} [input.ledger] artifact hash ledger (ART-02)
 * @param {string[]} [input.notes] human notes keyed by check id (`not_applicable` reasons)
 * @param {(path: string) => Promise<boolean>} [input.existsFile]
 * @param {string[]} [input.modules] module names used by C19
 * @param {string} [input.mode] `draft` | `final` | `batch`
 * @param {string[]} [input.only] restrict to these ids
 */
export async function runChecks(input) {
  const ids = input.only && input.only.length > 0 ? input.only.filter(id => CHECK_IDS.includes(id)) : CHECK_IDS
  const ctx = {
    artifacts: input.artifacts || {},
    manifest: input.manifest,
    baseline: input.baseline,
    markdown: input.markdown || {},
    ledger: input.ledger || {},
    notes: input.notes || {},
    existsFile: input.existsFile || (async () => true),
    modules: input.modules || [],
    mode: input.mode || at(input.manifest, 'mode') || 'final',
  }
  const rules = {
    C01: checkC01,
    C02: checkC02,
    C03: checkC03,
    C04: checkC04,
    C05: checkC05,
    C06: checkC06,
    C07: checkC07,
    C08: checkC08,
    C09: checkC09,
    C10: checkC10,
    C11: checkC11,
    C12: checkC12,
    C13: checkC13,
    C14: checkC14,
    C15: checkC15,
    C16: checkC16,
    C17: checkC17,
    C18: checkC18,
    C19: checkC19,
    C20: checkC20,
  }
  const results = []
  for (const id of ids) results.push(await rules[id](ctx))
  const known = new Set(ids)
  for (const [id, note] of Object.entries(ctx.notes)) {
    if (!known.has(id)) continue
    const slot = results.find(entry => entry.id === id)
    if (slot !== undefined && slot.result === NA && String(note).trim() !== '') slot.note = String(note)
  }
  return results
}

/** Every rule that must hold before a gate may be recorded. */
export function gateChecks(gate, results) {
  const definition = GATES[gate]
  if (definition === undefined) return []
  const wanted = new Set(definition.checks)
  return results.filter(entry => wanted.has(entry.id))
}

/** True when nothing that gates `gate` failed. */
export function gatePassed(gate, results) {
  return gateChecks(gate, results).every(entry => entry.result !== FAIL)
}

function requirement(ctx) {
  return ctx.artifacts['ART-20']
}
function impacts(ctx) {
  return list(at(ctx.artifacts['ART-30'], 'impact_analysis', 'impacts'))
}
function designs(ctx) {
  return list(at(ctx.artifacts['ART-40'], 'technical_design', 'designs'))
}
function fileChanges(ctx) {
  return list(at(ctx.artifacts['ART-40'], 'technical_design', 'file_changes'))
}

// C01 — every rule has a real source and at least one AC points back at it.
function checkC01(ctx) {
  const pkg = requirement(ctx)
  const rules = list(at(pkg, 'requirement', 'rules'))
  if (rules.length === 0) return result('C01', NA, '', '尚未产出 ART-20，规则表为空')
  const acs = list(at(pkg, 'requirement', 'acceptance_criteria'))
  const covered = new Set()
  for (const ac of acs) for (const id of list(ac.rule_ids)) covered.add(id)
  const problems = []
  for (const rule of rules) {
    const sourceType = at(rule, 'source', 'type')
    if (sourceType === undefined || sourceType === 'unknown') problems.push(`${rule.id} 来源为 unknown`)
    if (rule.decision_status !== 'rejected' && !covered.has(rule.id)) problems.push(`${rule.id} 没有验收标准`)
  }
  if (problems.length > 0) return result('C01', FAIL, problems.join('；'), '补齐来源或在 ART-20 增加验收标准')
  return result('C01', PASS, `${rules.length} 条规则均有来源，${acs.length} 条验收标准覆盖全部规则`)
}

// C02 — an inferred rule may not be silently confirmed.
function checkC02(ctx) {
  const rules = list(at(requirement(ctx), 'requirement', 'rules'))
  if (rules.length === 0) return result('C02', NA, '', '尚未产出 ART-20')
  const bad = rules.filter(rule => at(rule, 'source', 'type') === 'inferred' && rule.confirmation_required === true && rule.decision_status === 'confirmed')
  if (bad.length > 0) return result('C02', FAIL, bad.map(rule => rule.id).join('、'), '推断来源的规则必须待人工确认')
  return result('C02', PASS, '无 inferred + confirmation_required + confirmed 的规则')
}

// C03 — every mandatory impact traces back to a requirement rule or AC.
function checkC03(ctx) {
  const entries = impacts(ctx)
  if (entries.length === 0) return result('C03', NA, '', '尚未产出 ART-30')
  const pkg = requirement(ctx)
  const ruleIds = new Set(list(at(pkg, 'requirement', 'rules')).map(rule => rule.id))
  const acIds = new Set(list(at(pkg, 'requirement', 'acceptance_criteria')).map(ac => ac.id))
  const problems = []
  for (const impact of entries) {
    if (impact.impact_type !== 'mandatory') continue
    const refs = [...list(impact.rule_refs), ...list(impact.acceptance_refs)]
    if (!refs.some(ref => ruleIds.has(ref) || acIds.has(ref))) problems.push(`${impact.id} 无可追溯需求条目`)
  }
  if (problems.length > 0) return result('C03', FAIL, problems.join('；'), '为每个 mandatory 触点补 rule_refs 或 acceptance_refs')
  return result('C03', PASS, '全部 mandatory 触点均可追溯到需求规则或验收标准')
}

// C04 — a BLOCKER/HIGH risk set cannot be analysed away; G2 must have happened.
function checkC04(ctx) {
  const entries = impacts(ctx)
  if (entries.length === 0) return result('C04', NA, '', '尚未产出 ART-30')
  const risky = entries.filter(impact => impact.risk === 'BLOCKER' || impact.risk === 'HIGH')
  if (risky.length === 0) return result('C04', PASS, '无 BLOCKER/HIGH 风险触点')
  if (ctx.mode === 'draft') return result('C04', PASS, `${risky.length} 个高风险触点，draft 模式豁免`, 'draft 产物不得交付')
  const status = at(ctx.manifest, 'approvals', 'G2', 'status')
  if (status === 'APPROVED') return result('C04', PASS, `${risky.map(item => item.id).join('、')} 高风险，G2 已批准`)
  return result('C04', FAIL, `${risky.map(item => item.id).join('、')} 为 BLOCKER/HIGH，G2 状态为 ${status ?? '缺失'}`, '高风险需先经 G2 确认')
}

// C05 — every mandatory impact has a design that claims it.
function checkC05(ctx) {
  const entries = impacts(ctx)
  const defined = designs(ctx)
  if (entries.length === 0) return result('C05', NA, '', '尚未产出 ART-30')
  if (defined.length === 0) return result('C05', NA, '', '尚未产出 ART-40 designs')
  const covered = new Set()
  for (const design of defined) for (const ref of list(design.impact_refs)) covered.add(ref)
  const missing = entries.filter(impact => impact.impact_type === 'mandatory' && !covered.has(impact.id))
  if (missing.length > 0) return result('C05', FAIL, missing.map(item => item.id).join('、'), '在某个 designs[].impact_refs 中覆盖这些触点')
  return result('C05', PASS, `${entries.filter(item => item.impact_type === 'mandatory').length} 个 mandatory 触点均被设计覆盖`)
}

// C06 — every design is backed by an ADR; a migration always needs one.
function checkC06(ctx) {
  const defined = designs(ctx)
  const packageValue = ctx.artifacts['ART-40']
  if (defined.length === 0) return result('C06', NA, '', '尚未产出 ART-40 designs')
  const adrs = list(at(packageValue, 'technical_design', 'decisions'))
  const covered = new Set()
  for (const adr of adrs) for (const ref of list(adr.references || adr.design_refs)) covered.add(ref)
  const missing = defined.filter(design => !covered.has(design.id))
  if (missing.length > 0) return result('C06', FAIL, missing.map(item => item.id).join('、'), '为每个 DESIGN 补一个 ADR 并写进 references')
  const migrationRequired = at(packageValue, 'technical_design', 'migration', 'required') === true
  if (migrationRequired && adrs.length === 0) return result('C06', FAIL, 'migration.required=true 但没有 ADR', '迁移必须留 ADR')
  return result('C06', PASS, `${defined.length} 个 DESIGN 均有 ADR 覆盖${migrationRequired ? '，迁移有 ADR' : ''}`)
}

// C07 — a contract surface forces a compatibility statement.
function checkC07(ctx) {
  const entries = impacts(ctx)
  if (entries.length === 0) return result('C07', NA, '', '尚未产出 ART-30')
  if (ctx.artifacts['ART-40'] === undefined) return result('C07', NA, '', '尚未产出 ART-40，无兼容声明可查')
  const contracts = entries.filter(isContractSurface)
  if (contracts.length === 0) return result('C07', PASS, '无契约类触点')
  const compatibility = at(ctx.artifacts['ART-40'], 'technical_design', 'compatibility')
  const problems = []
  if (compatibility === undefined) problems.push('未声明 compatibility')
  else {
    if (compatibility.required !== true) problems.push('compatibility.required 不为 true')
    if (String(compatibility.strategy ?? '').trim() === '') problems.push('compatibility.strategy 为空')
    if (list(compatibility.contracts).length === 0) problems.push('compatibility.contracts 为空')
  }
  if (problems.length > 0) return result('C07', FAIL, `${contracts.map(item => item.id).join('、')} 为契约类触点：${problems.join('，')}`, '声明兼容策略并覆盖每个契约')
  return result('C07', PASS, `${contracts.length} 个契约类触点已有兼容策略`)
}

// C08 — the review must be non-FAIL with no open blocking issue.
function checkC08(ctx) {
  const review = at(ctx.artifacts['ART-50'], 'review')
  if (review === undefined) return result('C08', NA, '', '尚未产出 ART-50')
  const conclusion = review.conclusion
  if (conclusion === 'FAIL') return result('C08', FAIL, '评审结论为 FAIL', '按 ART-52 回流后重新评审')
  const open = list(review.blocking_issues).filter(issue => issue.status === 'open' || issue.status === undefined)
  if (open.length > 0) return result('C08', FAIL, open.map(issue => issue.id).join('、'), '阻断问题必须关闭或标注为已修复')
  const conditions = list(review.conditions).filter(condition => condition.status !== 'closed')
  if (conclusion === 'CONDITIONAL_PASS' && conditions.length > 0) {
    return result('C08', FAIL, conditions.map(condition => condition.id).join('、'), 'CONDITIONAL_PASS 的条件未全部关闭，不得进入 G3')
  }
  return result('C08', PASS, `结论 ${conclusion}，无 open 阻断问题，条件已关闭`)
}

// C09 — every versioned reference points at the current upstream bundle.
function checkC09(ctx) {
  const manifest = ctx.manifest
  if (manifest === undefined) return result('C09', NA, '', '尚无 workflow-manifest.yaml')
  const refs = collectRefs({
    'ART-20': ctx.artifacts['ART-20'],
    'ART-30': ctx.artifacts['ART-30'],
    'ART-40': ctx.artifacts['ART-40'],
    'ART-50': ctx.artifacts['ART-50'],
  })
  if (refs.length === 0) return result('C09', NA, '', '产物中尚无跨 bundle 版本引用')
  const waived = new Set(list(at(manifest, 'human_edits')).filter(edit => edit.kind === 'text_only').map(edit => edit.stage))
  const problems = []
  for (const ref of refs) {
    const current = at(manifest, 'artifacts', ref.stage, 'version')
    if (current === undefined) continue
    if (ref.version === Number(current)) continue
    if (waived.has(ref.stage)) continue
    problems.push(`${ref.ref} 指向 v${ref.version}，当前为 v${current}`)
  }
  if (problems.length > 0) return result('C09', FAIL, problems.join('；'), '更新引用版本，或经 /etp-awf-rerun 以纯文字变更豁免')
  return result('C09', PASS, `${refs.length} 处版本引用与上游一致`)
}

// C10 — a human edit invalidates the approval that preceded it.
function checkC10(ctx) {
  const edits = list(at(ctx.manifest, 'human_edits'))
  if (edits.length === 0) return result('C10', NA, '', '未检测到人工修改')
  const problems = []
  for (const edit of edits) {
    const gate = edit.gate
    if (gate === undefined) continue
    const decided = at(ctx.manifest, 'approvals', gate, 'decided_at')
    if (decided === undefined) problems.push(`${edit.artifact} 被人工修改但 ${gate} 未重新确认`)
    else if (String(decided) < String(edit.at)) problems.push(`${edit.artifact} 在 ${gate} 批准后才被修改`)
  }
  if (problems.length > 0) return result('C10', FAIL, problems.join('；'), '人工修改后需重新走对应门禁')
  return result('C10', PASS, `${edits.length} 处人工修改均已被后续门禁覆盖`)
}

// C11 — designs trace to impacts, file changes trace to both.
function checkC11(ctx) {
  const defined = designs(ctx)
  const changes = fileChanges(ctx)
  if (defined.length === 0 && changes.length === 0) return result('C11', NA, '', '尚未产出 ART-40')
  const impactIds = new Set(impacts(ctx).map(impact => impact.id))
  const designIds = new Set(defined.map(design => design.id))
  const problems = []
  for (const design of defined) {
    const refs = list(design.impact_refs)
    if (refs.length === 0) problems.push(`${design.id} 未引用任何 IMPACT`)
    for (const ref of refs) if (!impactIds.has(ref)) problems.push(`${design.id} 引用了不存在的 ${ref}`)
  }
  for (const change of changes) {
    const changeRefs = list(change.impact_refs)
    const designRefs = list(change.design_refs)
    if (changeRefs.length === 0) problems.push(`${change.path} 未挂 impact_refs`)
    if (designRefs.length === 0) problems.push(`${change.path} 未挂 design_refs`)
    for (const ref of changeRefs) if (!impactIds.has(ref)) problems.push(`${change.path} 引用了不存在的 ${ref}`)
    for (const ref of designRefs) if (!designIds.has(ref)) problems.push(`${change.path} 引用了不存在的 ${ref}`)
  }
  if (problems.length > 0) return result('C11', FAIL, problems.join('；'), '补齐双向引用')
  return result('C11', PASS, `${defined.length} 个 DESIGN、${changes.length} 个文件变更双向可追溯`)
}

// C12 — one baseline everywhere, and nothing STALE at freeze time.
function checkC12(ctx) {
  const manifest = ctx.manifest
  if (manifest === undefined) return result('C12', NA, '', '尚无 workflow-manifest.yaml')
  const baselineId = manifest.baseline_id
  const problems = []
  const artifacts = ctx.artifacts
  for (const [artifactId, value] of Object.entries(artifacts)) {
    // 00-workflow bookkeeping carries the baseline in its own shape; only the
    // stage artifacts follow the public header with `artifact.baseline_id`.
    if (/^ART-0[0-4]$/u.test(artifactId)) continue
    const declared = at(value, 'artifact', 'baseline_id') ?? at(value, 'baseline_id')
    if (declared === undefined) problems.push(`${artifactId} 缺 baseline_id`)
    else if (baselineId !== undefined && declared !== baselineId) problems.push(`${artifactId} baseline_id=${declared}，manifest 为 ${baselineId}`)
  }
  const staleStages = list(manifest.stale).filter(entry => entry.resolved !== true)
  const liveStale = staleStages.filter(entry => at(manifest, 'artifacts', entry.stage, 'status') === 'STALE')
  if (ctx.mode === 'final' && liveStale.length > 0) problems.push(`STALE 产物：${liveStale.map(entry => entry.stage).join('、')}`)
  if (ctx.mode === 'final') {
    const baseline = ctx.baseline
    const confirmed = at(baseline, 'baseline', 'confirmed') ?? at(baseline, 'confirmed')
    if (baseline === undefined) problems.push('final 模式缺 analysis-baseline.yaml')
    else if (confirmed !== true) problems.push('final 模式下基线未确认')
  }
  if (problems.length > 0) return result('C12', FAIL, problems.join('；'), '统一 baseline_id 并重新生成 STALE 产物')
  return result('C12', PASS, `全部产物 baseline_id=${baselineId ?? '未登记'}`)
}

// C13 — no content block disappears without a stated scope.
function checkC13(ctx) {
  const pkg = at(ctx.artifacts['ART-10'], 'requirement_source')
  if (pkg === undefined) return result('C13', NA, '', '尚未产出 ART-10')
  const blocks = list(pkg.blocks)
  if (blocks.length === 0) return result('C13', FAIL, 'blocks[] 为空', '至少登记一个内容块')
  const scopes = new Set(['backend', 'frontend', 'out_of_scope', 'infrastructure'])
  const problems = []
  for (const block of blocks) {
    if (!scopes.has(block.scope)) problems.push(`${block.id} scope=${block.scope ?? '缺失'}`)
  }
  const blockIds = new Set(blocks.map(block => block.id))
  for (const excluded of list(pkg.excluded)) {
    if (String(excluded.reason ?? '').trim() === '') problems.push(`${excluded.id ?? excluded.block_id} 被排除但没有理由`)
    const id = excluded.block_id ?? excluded.id
    if (id !== undefined && !blockIds.has(id) && !String(id).startsWith('EXC-')) problems.push(`${id} 不在 blocks[] 中`)
  }
  for (const block of blocks) {
    if (block.scope === 'frontend' || block.scope === 'out_of_scope') {
      const declared = list(pkg.excluded).some(excluded => (excluded.block_id ?? excluded.id) === block.id)
      if (!declared) problems.push(`${block.id} 属 ${block.scope} 但未登记到 excluded[]`)
    }
  }
  if (problems.length > 0) return result('C13', FAIL, problems.join('；'), '为每个块标注 scope，排除项写明理由')
  return result('C13', PASS, `${blocks.length} 个内容块均有 scope，排除项均有理由`)
}

// C14 — the source is reproducible and the asset cards are complete.
async function checkC14(ctx) {
  const pkg = at(ctx.artifacts['ART-10'], 'requirement_source')
  if (pkg === undefined) return result('C14', NA, '', '尚未产出 ART-10')
  const source = pkg.source || {}
  const problems = []
  const url = source.url ?? source.source_url
  if (String(url ?? '').trim() === '') problems.push('缺 source.url')
  if (String(source.fetched_at ?? '').trim() === '') problems.push('缺 source.fetched_at')
  if (String(source.content_hash ?? '').trim() === '') problems.push('缺 source.content_hash')
  const snapshotRef = at(pkg, 'snapshot', 'ref')
  if (String(snapshotRef ?? '').trim() === '') problems.push('缺 snapshot.ref')
  else if (!(await ctx.existsFile(snapshotRef))) problems.push(`快照不存在：${snapshotRef}`)
  const parseStatuses = new Set(['parsed', 'partial', 'unreadable', 'unsupported'])
  const gaps = list(pkg.gaps)
  for (const asset of list(at(pkg, 'snapshot', 'assets'))) {
    if (String(asset.path ?? '').trim() === '') problems.push(`${asset.id} 缺 path`)
    else if (!(await ctx.existsFile(asset.path))) problems.push(`${asset.id} 文件不存在：${asset.path}`)
    if (asset.kind === 'image') {
      if (!parseStatuses.has(asset.parse_status)) problems.push(`${asset.id} parse_status=${asset.parse_status ?? '缺失'}`)
      if (String(asset.text ?? '').trim() === '' && String(asset.description ?? '').trim() === '') problems.push(`${asset.id} 既无 text 也无 description`)
      if (asset.confidence === undefined) problems.push(`${asset.id} 缺 confidence`)
      if (asset.parse_status !== 'parsed' && list(asset.missing_parts).length === 0) problems.push(`${asset.id} 非 parsed 但 missing_parts 为空`)
      if (asset.parse_status !== 'parsed' && gaps.length === 0) problems.push(`${asset.id} 非 parsed 但 gaps[] 未登记`)
    }
  }
  if (problems.length > 0) return result('C14', FAIL, problems.join('；'), '补齐来源五项、快照与识读卡')
  return result('C14', PASS, `来源可复现，${list(at(pkg, 'snapshot', 'assets')).length} 个附件识读卡完整`)
}

// C15 — every applicable check of the current stage reached a conclusion.
function checkC15(ctx) {
  const declared = list(at(ctx.manifest, 'last_conclusions'))
  const required = list(at(ctx.manifest, 'last_required_checks'))
  if (required.length === 0) return result('C15', NA, '', '尚未记录本阶段适用检查项')
  const byId = new Map()
  for (const entry of declared) byId.set(entry.id, entry)
  const problems = []
  for (const id of required) {
    const entry = byId.get(id)
    if (entry === undefined) problems.push(`${id} 无结论`)
    else if (![PASS, FAIL, NA].includes(entry.result)) problems.push(`${id} 结论非法：${entry.result}`)
    else if (entry.result === NA && String(entry.note ?? '').trim() === '') problems.push(`${id} 为 not_applicable 但没有理由`)
    else if (String(entry.evidence ?? '').trim() === '') problems.push(`${id} 缺证据`)
  }
  if (problems.length > 0) return result('C15', FAIL, problems.join('；'), '逐条给 pass/fail/not_applicable + 证据')
  return result('C15', PASS, `${required.length} 项适用检查均有结论与证据`)
}

// C16 — a batch US with overlapping surfaces must be registered in ART-04.
function checkC16(ctx) {
  if (ctx.mode !== 'batch') return result('C16', NA, '', '非批次模式')
  const conflicts = list(at(ctx.artifacts['ART-30'], 'impact_analysis', 'cross_us_conflicts'))
  const registered = list(at(ctx.artifacts['ART-04'], 'portfolio', 'us'))
  if (conflicts.length === 0) return result('C16', PASS, '未发现跨 US 触点重叠')
  const known = new Set(registered.map(entry => entry.id ?? entry.us_id))
  const problems = conflicts.filter(conflict => !known.has(conflict.other_us)).map(conflict => conflict.other_us)
  if (problems.length > 0) return result('C16', FAIL, problems.join('、'), '在 portfolio.yaml 登记 depends_on 或 conflicts_with')
  return result('C16', PASS, `${conflicts.length} 处跨 US 重叠已登记`)
}

// C17 — the coverage matrix must be recomputable from upstream artifacts.
function checkC17(ctx) {
  const coverage = ctx.artifacts['ART-43']
  if (coverage === undefined) return result('C17', NA, '', '尚未产出 ART-43')
  const rows = list(at(coverage, 'design_coverage', 'rows') ?? at(coverage, 'rows'))
  if (rows.length === 0) return result('C17', FAIL, 'rows[] 为空', '覆盖矩阵至少要有一行')
  const impactIds = new Set(impacts(ctx).map(impact => impact.id))
  const ruleIds = new Set(list(at(requirement(ctx), 'requirement', 'rules')).map(rule => rule.id))
  const acIds = new Set(list(at(requirement(ctx), 'requirement', 'acceptance_criteria')).map(ac => ac.id))
  const designIds = new Set(designs(ctx).map(design => design.id))
  const documentText = String(ctx.markdown['ART-41'] ?? '')
  const problems = []
  for (const row of rows) {
    const refId = row.ref_id ?? row.ref
    if (refId === undefined) problems.push('存在无 ref_id 的行')
    else if (!impactIds.has(refId) && !ruleIds.has(refId) && !acIds.has(refId)) problems.push(`${refId} 在上游不存在`)
    if (!designIds.has(row.design_id)) problems.push(`${refId} 的 design_id=${row.design_id} 不存在`)
    if (row.status === 'Missing' && String(row.note ?? '').trim() === '') problems.push(`${refId} 为 Missing 但无 note`)
    if (String(row.section ?? '').trim() === '') problems.push(`${refId} 缺 section`)
    else if (documentText !== '' && !documentText.includes(String(row.section))) problems.push(`${refId} 的 section「${row.section}」在 ART-41 中定位不到`)
  }
  if (problems.length > 0) return result('C17', FAIL, problems.slice(0, 8).join('；'), '修正覆盖矩阵或补 ART-41 章节')
  return result('C17', PASS, `${rows.length} 行均可复算`)
}

// C18 — the Markdown twin agrees with its YAML original.
function checkC18(ctx) {
  const problems = []
  let compared = 0
  const pairs = [
    ['ART-10', 'ART-11'],
    ['ART-20', 'ART-21'],
    ['ART-30', 'ART-31'],
    ['ART-40', 'ART-41'],
    ['ART-50', 'ART-51'],
  ]
  for (const [yamlId, mdId] of pairs) {
    const yamlValue = ctx.artifacts[yamlId]
    const markdown = ctx.markdown[mdId]
    if (yamlValue === undefined || markdown === undefined) continue
    compared += 1
    const header = at(yamlValue, 'artifact') || {}
    const mdArtifact = /^>\s*Artifact:\s*([A-Z]\d-\d{3}):v(\d+)/mu.exec(markdown)
    const mdHash = /^>\s*Source-Hash:\s*([0-9a-f]{64})/mu.exec(markdown)
    if (header.id === undefined) problems.push(`${yamlId} 缺 artifact.id`)
    if (header.version === undefined) problems.push(`${yamlId} 缺 artifact.version`)
    if (mdArtifact === null) problems.push(`${mdId} 缺 Artifact 头`)
    else {
      if (mdArtifact[1] !== String(header.id)) problems.push(`${mdId} 头 id=${mdArtifact[1]}，YAML 为 ${header.id}`)
      if (Number(mdArtifact[2]) !== Number(header.version)) problems.push(`${mdId} 头版本 v${mdArtifact[2]}，YAML 为 v${header.version}`)
    }
    if (header.source_hash !== undefined) {
      const computed = contentHashFor(yamlValue)
      if (String(header.source_hash) !== computed) problems.push(`${yamlId} source_hash 与内容哈希不符`)
      if (mdHash === null) problems.push(`${mdId} 缺 Source-Hash 行`)
      else if (mdHash[1] !== computed) problems.push(`${mdId} Source-Hash 与 ${yamlId} 内容哈希不符`)
    }
  }
  if (compared === 0) return result('C18', NA, '', '尚无成对的 YAML/Markdown 产物')
  if (problems.length > 0) return result('C18', FAIL, problems.join('；'), '以 YAML 为准重新渲染 Markdown 并更新哈希')
  return result('C18', PASS, `${compared} 对产物版本、id、内容哈希一致`)
}

// C19 — only ACTIVE, module-applicable documents may be cited.
function checkC19(ctx) {
  const citations = []
  for (const artifactId of ['ART-20', 'ART-30', 'ART-40']) {
    const value = ctx.artifacts[artifactId]
    const declared = list(at(value, 'cited_documents'))
    for (const citation of declared) citations.push({ artifactId, ...citation })
  }
  if (citations.length === 0) return result('C19', NA, '', '产物未引用外部文档')
  const modules = new Set(ctx.modules)
  const problems = []
  for (const citation of citations) {
    if (citation.status !== 'ACTIVE') problems.push(`${citation.id ?? citation.doc_id} 状态为 ${citation.status}`)
    const applicable = list(citation.applicable_modules)
    if (applicable.length === 0) problems.push(`${citation.id ?? citation.doc_id} 未声明 applicable_modules`)
    else if (modules.size > 0 && !applicable.some(module => modules.has(module))) problems.push(`${citation.id ?? citation.doc_id} 与本次模块无交集`)
  }
  if (problems.length > 0) return result('C19', FAIL, problems.join('；'), '只引用 ACTIVE 且覆盖本次模块的文档')
  return result('C19', PASS, `${citations.length} 处文档引用均有效`)
}

// C20 — a migration without its rollback (or an irreversible DDL without a signature) blocks.
function checkC20(ctx) {
  const design = at(ctx.artifacts['ART-40'], 'technical_design')
  if (design === undefined) return result('C20', NA, '', '尚未产出 ART-40')
  const migration = design.migration
  if (migration === undefined) return result('C20', FAIL, '缺 migration 段', '即使不需要迁移也要写明 required=false 与理由')
  if (migration.required !== true) {
    if (String(migration.reason ?? '').trim() === '') return result('C20', FAIL, 'migration.required=false 但无理由', '写明不做迁移的原因')
    return result('C20', PASS, '无迁移需求，理由已记录')
  }
  const problems = []
  if (list(migration.steps).length === 0) problems.push('migration.steps 为空')
  if (String(migration.order ?? '').trim() === '') problems.push('migration.order 为空')
  if (String(migration.rollback ?? '').trim() === '') problems.push('migration.rollback 为空')
  const dataRollback = at(design, 'rollback', 'data_rollback')
  if (String(dataRollback ?? '').trim() === '') problems.push('rollback.data_rollback 为空')
  const irreversible = list(migration.steps).some(step => /(drop\s+table|drop\s+column|truncate|alter\s+column.*type|modify\s+column)/iu.test(JSON.stringify(step)))
  if (irreversible) {
    const acceptance = at(design, 'compatibility', 'risk_acceptance') ?? at(migration, 'risk_acceptance')
    if (acceptance === undefined || String(at(acceptance, 'signed_by') ?? acceptance ?? '').trim() === '') {
      problems.push('含不可逆 DDL 但无人工 risk_acceptance')
    }
  }
  if (problems.length > 0) return result('C20', FAIL, problems.join('；'), '补齐回滚；不可逆操作需人工签署风险接受')
  return result('C20', PASS, '迁移有顺序与回滚' + (irreversible ? '，不可逆操作已签署' : ''))
}
