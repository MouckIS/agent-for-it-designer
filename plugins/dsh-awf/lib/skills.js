/**
 * 把 AWF 技能注册进 DSH 的 `ctx.skills`。
 *
 * 为什么不直接把技能放成 `skills/` 目录交给 `dsh-skill-filesystem` 扫描：
 * 那个 provider 只扫 `.dsh/skills`、`.agents/skills`、用户目录与 bundled 根，
 * 不认仓库的 `.claude/skills`。本插件的定位是「把已有的 AWF 资产变成 DSH 能力」，
 * 所以显式注册，并把 `references/` 一并附到正文后面——DS-V5 K4 规定子代理没有
 * 持久记忆，技能正文必须自包含。
 *
 * 技能名必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`dsh-skill` 的 `isSkillName`）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录；`skills/` 是仓库 `.claude/skills/` 的副本。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 技能副本所在目录。 */
export const SKILLS_DIR = join(PACKAGE_ROOT, 'skills')

/** 本插件拥有的技能，按依赖顺序排列。 */
export const SKILL_NAMES = [
  'etp-awf-workflow',
  'etp-requirement-fetch',
  'etp-design-doc-writing',
  'etp-legacy-saas-analysis',
  'etp-code-graph-query',
  'etp-project-checklist',
  'etp-design-review',
]

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** 解析 `---\nname: x\ndescription: y\n---\n正文`。 */
export function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: normalized }
  const header = normalized.slice(4, end)
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1)
  const data = {}
  for (const line of header.split('\n')) {
    const match = /^([a-zA-Z_][\w-]*):\s*(.*)$/u.exec(line.trim())
    if (match === null) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

/**
 * 读一个技能目录：`SKILL.md` 给 name/description/正文，`references/*.md`
 * 作为附录接在正文后，让加载技能的子代理同时拿到协议正文。
 */
export function loadSkill(directory, fallbackName) {
  const skillFile = join(directory, 'SKILL.md')
  if (!existsSync(skillFile)) return undefined
  const raw = readFileSync(skillFile, 'utf8')
  const { data, body } = splitFrontmatter(raw)
  const referenceDir = join(directory, 'references')
  const references = []
  if (existsSync(referenceDir)) {
    for (const entry of readdirSync(referenceDir).sort()) {
      if (!entry.endsWith('.md')) continue
      references.push({ file: entry, text: readFileSync(join(referenceDir, entry), 'utf8') })
    }
  }
  const appendix = references.length === 0
    ? ''
    : ['', '## 本技能的参考文件（需要时用读取工具打开绝对路径）', '',
      ...references.map(reference => `- references/${reference.file} → ${join(referenceDir, reference.file)}`),
      ''].join('\n')
  return {
    name: data.name || fallbackName,
    description: data.description || fallbackName,
    whenToUse: data.when_to_use || data.whenToUse || undefined,
    content: `${body.trimEnd()}${appendix}`.trimStart(),
    references: references.map(reference => reference.file),
    directory,
  }
}

/**
 * 注册全部技能。返回 `{registered, skipped}`；跳过项必须能说出原因，
 * 不允许静默缺少一个技能。
 */
export function registerSkills(ctx) {
  const registered = []
  const skipped = []
  for (const name of SKILL_NAMES) {
    const directory = join(SKILLS_DIR, name)
    if (!SKILL_NAME_RE.test(name)) {
      skipped.push({ name, reason: '技能名不符合 kebab-case 规则' })
      continue
    }
    const loaded = loadSkill(directory, name)
    if (loaded === undefined) {
      skipped.push({ name, reason: `skills/${name}/SKILL.md 不存在` })
      continue
    }
    const dispose = ctx.skills.register({
      name: loaded.name,
      description: loaded.description,
      ...(loaded.whenToUse === undefined ? {} : { whenToUse: loaded.whenToUse }),
      content: loaded.content,
      source: 'custom',
      resourceBase: { kind: 'directory', path: loaded.directory },
    })
    ctx.effect(() => dispose, `dsh-awf: skill ${name}`)
    registered.push({ name: loaded.name, bytes: loaded.content.length, references: loaded.references.length })
  }
  return { registered, skipped }
}
