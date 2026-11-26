/**
 * A small, dependency-free YAML subset used for AWF artifacts.
 *
 * Why not `js-yaml`: a bundle is installed from an on-disk directory and its
 * real path is inside the user's workspace, so `import 'js-yaml'` would have to
 * resolve through the workspace's node_modules, which may not exist. Writing
 * the subset here keeps the bundle self-contained and makes the accepted
 * surface explicit.
 *
 * Supported on dump:
 *   - mappings (2-space indent), sequences, empty `[]` / `{}`
 *   - null / booleans / numbers / strings
 *   - multi-line strings as literal blocks (`|` / `|-`)
 *   - nested sequences under a mapping key, sequences of mappings
 *
 * Supported on parse: everything above, plus block scalars (`|`, `|-`, `|+`,
 * `>`, `>-`), single- and double-quoted scalars, inline flow sequences of
 * scalars (`[a, b]`), and full-line comments.
 *
 * Anything outside that surface is a hard error rather than a silent guess:
 * AWF treats an unreadable artifact as a blocking condition, never as "no
 * findings".
 */

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/
/** Characters that mean "this scalar needs quoting" when they open the string. */
const INDICATORS = new Set(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`'])

/** Scalars that YAML 1.1 readers treat as non-strings. */
const RESERVED_WORDS = new Set([
  'null', 'Null', 'NULL', '~', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO', 'on', 'On', 'ON', 'off', 'Off', 'OFF', 'y', 'n',
])

export class YamlError extends Error {
  /** @param {string} message @param {number} [line] 1-based line number. */
  constructor(message, line) {
    super(line === undefined ? message : `${message} (line ${line})`)
    this.name = 'YamlError'
  }
}

/** Format a value as YAML text ending with a newline. */
export function dump(value) {
  const lines = []
  emitValue(lines, value, 0, false)
  return `${lines.join('\n')}\n`
}

/** @param {string[]} lines @param {unknown} value @param {number} indent */
function emitValue(lines, value, indent, inline) {
  const pad = ' '.repeat(indent)
  if (value === undefined || value === null) {
    lines.push(`${pad}null`)
    return
  }
  if (typeof value === 'boolean') {
    lines.push(`${pad}${value ? 'true' : 'false'}`)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new YamlError(`cannot serialize non-finite number ${String(value)}`)
    lines.push(`${pad}${String(value)}`)
    return
  }
  if (typeof value === 'string') {
    emitScalarLines(lines, value, indent)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`)
      return
    }
    for (const item of value) emitSequenceItem(lines, item, indent)
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    if (entries.length === 0) {
      lines.push(`${pad}{}`)
      return
    }
    for (const [key, v] of entries) emitEntry(lines, key, v, indent)
    return
  }
  throw new YamlError(`cannot serialize value of type ${typeof value}`)
}

/** @param {string[]} lines @param {string} key @param {unknown} value @param {number} indent */
function emitEntry(lines, key, value, indent) {
  const pad = ' '.repeat(indent)
  const name = BARE_KEY.test(key) ? key : JSON.stringify(key)
  const head = `${pad}${name}:`
  if (value === undefined || value === null) {
    lines.push(`${head} null`)
    return
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    lines.push(`${head} ${typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)}`)
    return
  }
  if (typeof value === 'string') {
    if (needsBlockScalar(value)) {
      lines.push(`${head} |`)
      const body = value.replace(/\n+$/, '').split('\n')
      const inner = ' '.repeat(indent + 2)
      for (const line of body) lines.push(line === '' ? '' : `${inner}${line}`)
      return
    }
    lines.push(`${head} ${formatScalar(value)}`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${head} []`)
      return
    }
    lines.push(head)
    for (const item of value) emitSequenceItem(lines, item, indent + 2)
    return
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    lines.push(`${head} {}`)
    return
  }
  lines.push(head)
  for (const [k, v] of entries) emitEntry(lines, k, v, indent + 2)
}

/** @param {string[]} lines @param {unknown} item @param {number} indent */
function emitSequenceItem(lines, item, indent) {
  const pad = ' '.repeat(indent)
  if (item === null || item === undefined) {
    lines.push(`${pad}- null`)
    return
  }
  if (typeof item === 'string') {
    if (needsBlockScalar(item)) {
      lines.push(`${pad}- |`)
      const inner = ' '.repeat(indent + 2)
      for (const line of item.replace(/\n+$/, '').split('\n')) lines.push(line === '' ? '' : `${inner}${line}`)
      return
    }
    lines.push(`${pad}- ${formatScalar(item)}`)
    return
  }
  if (typeof item === 'boolean' || typeof item === 'number') {
    lines.push(`${pad}- ${typeof item === 'boolean' ? (item ? 'true' : 'false') : String(item)}`)
    return
  }
  if (Array.isArray(item)) {
    if (item.length === 0) {
      lines.push(`${pad}- []`)
      return
    }
    lines.push(`${pad}-`)
    for (const child of item) emitSequenceItem(lines, child, indent + 2)
    return
  }
  const entries = Object.entries(item).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    lines.push(`${pad}- {}`)
    return
  }
  // First entry shares the `- ` line so an array of mappings stays readable.
  const [firstKey, firstValue] = entries[0]
  const rest = entries.slice(1)
  const keyName = BARE_KEY.test(firstKey) ? firstKey : JSON.stringify(firstKey)
  const continuation = indent + 2
  if (firstValue !== null && typeof firstValue === 'object') {
    lines.push(`${pad}- ${keyName}:`)
    if (Array.isArray(firstValue)) {
      if (firstValue.length === 0) lines.splice(lines.length - 1, 1, `${pad}- ${keyName}: []`)
      else for (const child of firstValue) emitSequenceItem(lines, child, continuation + 2)
    } else {
      for (const [k, v] of Object.entries(firstValue).filter(([, v]) => v !== undefined)) {
        emitEntry(lines, k, v, continuation + 2)
      }
    }
  } else if (typeof firstValue === 'string' && needsBlockScalar(firstValue)) {
    lines.push(`${pad}- ${keyName}: |`)
    const inner = ' '.repeat(continuation + 2)
    for (const line of firstValue.replace(/\n+$/, '').split('\n')) lines.push(line === '' ? '' : `${inner}${line}`)
  } else if (firstValue === null || firstValue === undefined) {
    lines.push(`${pad}- ${keyName}: null`)
  } else if (typeof firstValue === 'boolean' || typeof firstValue === 'number') {
    lines.push(`${pad}- ${keyName}: ${typeof firstValue === 'boolean' ? (firstValue ? 'true' : 'false') : String(firstValue)}`)
  } else if (Array.isArray(firstValue)) {
    lines.push(`${pad}- ${keyName}: []`)
  } else {
    lines.push(`${pad}- ${keyName}: ${formatScalar(firstValue)}`)
  }
  for (const [k, v] of rest) emitEntry(lines, k, v, continuation)
}

/** @param {string} value */
function needsBlockScalar(value) {
  return value.includes('\n')
}

/**
 * Decide whether a scalar can stay unquoted. CJK text, spaces and most
 * punctuation are fine; only YAML-significant leading characters, reserved
 * words, numbers and control characters force quoting.
 * @param {string} value
 */
function formatScalar(value) {
  if (value === '') return '""'
  if (RESERVED_WORDS.has(value)) return JSON.stringify(value)
  if (NUMBER.test(value)) return JSON.stringify(value)
  if (value.trim() !== value) return JSON.stringify(value)
  if (INDICATORS.has(value[0])) return JSON.stringify(value)
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) return JSON.stringify(value)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return JSON.stringify(value)
  return value
}

/** @param {string[]} lines @param {string} value @param {number} indent */
function emitScalarLines(lines, value, indent) {
  const pad = ' '.repeat(indent)
  if (needsBlockScalar(value)) {
    lines.push(`${pad}|`)
    const inner = ' '.repeat(indent + 2)
    for (const line of value.replace(/\n+$/, '').split('\n')) lines.push(line === '' ? '' : `${inner}${line}`)
    return
  }
  lines.push(`${pad}${formatScalar(value)}`)
}

/** Parse YAML text produced by this module (or hand-edited in the same subset). */
export function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = text.replace(/\r\n?/g, '\n').split('\n')
  /** @type {{indent: number, content: string, raw: string, line: number}[]} */
  const lines = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    if (raw.trim() === '') continue
    const match = /^([ \t]*)(.*)$/.exec(raw)
    const indent = match[1].replace(/\t/g, '  ').length
    const content = match[2]
    if (content.startsWith('#')) continue
    if (content === '---' || content === '...') continue
    lines.push({ indent, content, raw, line: i + 1 })
  }
  if (lines.length === 0) return null
  const [value, next] = parseBlock(lines, 0, lines[0].indent)
  if (next !== lines.length) throw new YamlError('unexpected trailing content', lines[next].line)
  return value
}

/** @param {{indent:number,content:string,raw:string,line:number}[]} lines @param {number} index @param {number} indent */
function parseBlock(lines, index, indent) {
  const first = lines[index]
  if (first === undefined) return [null, index]
  if (first.content.startsWith('- ') || first.content === '-') return parseSequence(lines, index, indent)
  return parseMapping(lines, index, indent)
}

/** @param {any[]} lines @param {number} index @param {number} indent */
function parseSequence(lines, index, indent) {
  /** @type {unknown[]} */
  const out = []
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent !== indent) {
      if (line.indent < indent) break
      throw new YamlError('unexpected indentation in sequence', line.line)
    }
    if (!line.content.startsWith('-')) break
    const body = line.content === '-' ? '' : line.content.slice(2)
    if (body === '') {
      const next = lines[cursor + 1]
      if (next === undefined || next.indent <= indent) {
        out.push(null)
        cursor += 1
        continue
      }
      const [value, after] = parseBlock(lines, cursor + 1, next.indent)
      out.push(value)
      cursor = after
      continue
    }
    // `- key: value` starts an inline mapping item.
    if (looksLikeMapping(body)) {
      const syntheticIndent = indent + 2
      const itemLines = [{ indent: syntheticIndent, content: body, raw: line.raw, line: line.line }]
      let scan = cursor + 1
      while (scan < lines.length && lines[scan].indent > indent) {
        itemLines.push(lines[scan])
        scan += 1
      }
      const [value, consumed] = parseMapping(itemLines, 0, syntheticIndent)
      if (consumed !== itemLines.length) throw new YamlError('could not consume mapping item', line.line)
      out.push(value)
      cursor = scan
      continue
    }
    if (body === '|' || body === '|-' || body === '|+' || body === '>' || body === '>-' || body === '>+') {
      const [value, after] = parseBlockScalar(lines, cursor + 1, indent, body)
      out.push(value)
      cursor = after
      continue
    }
    if (body === '[]') {
      out.push([])
      cursor += 1
      continue
    }
    if (body === '{}') {
      out.push({})
      cursor += 1
      continue
    }
    out.push(formatScalarValue(body, line.line))
    cursor += 1
  }
  return [out, cursor]
}

/** @param {any[]} lines @param {number} index @param {number} indent */
function parseMapping(lines, index, indent) {
  /** @type {Record<string, unknown>} */
  const out = {}
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent !== indent) {
      if (line.indent < indent) break
      throw new YamlError('unexpected indentation in mapping', line.line)
    }
    if (line.content.startsWith('- ')) break
    const split = splitKey(line.content)
    if (split === null) throw new YamlError(`expected "key: value" but found "${line.content}"`, line.line)
    const { key, rest } = split
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`duplicate key "${key}"`, line.line)
    }
    if (rest === '') {
      const next = lines[cursor + 1]
      if (next === undefined || next.indent <= indent) {
        out[key] = null
        cursor += 1
        continue
      }
      const [value, after] = parseBlock(lines, cursor + 1, next.indent)
      out[key] = value
      cursor = after
      continue
    }
    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
      const [value, after] = parseBlockScalar(lines, cursor + 1, indent, rest)
      out[key] = value
      cursor = after
      continue
    }
    out[key] = formatScalarValue(rest, line.line)
    cursor += 1
  }
  return [out, cursor]
}

/** @param {any[]} lines @param {number} index @param {number} parentIndent @param {string} marker */
function parseBlockScalar(lines, index, parentIndent, marker) {
  /** @type {string[]} */
  const collected = []
  let cursor = index
  let blockIndent
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent <= parentIndent) break
    if (blockIndent === undefined) blockIndent = line.indent
    const extra = Math.max(0, line.indent - blockIndent)
    collected.push(' '.repeat(extra) + line.content)
    cursor += 1
  }
  const joined = marker.startsWith('>') ? collected.join(' ') : collected.join('\n')
  const chomp = marker.length > 1 ? marker[1] : ''
  if (chomp === '-') return [joined, cursor]
  if (chomp === '+') return [`${joined}\n`, cursor]
  return [joined, cursor]
}

/** @param {string} content */
function looksLikeMapping(content) {
  return splitKey(content) !== null
}

/** @param {string} content */
function splitKey(content) {
  let quote = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      const rawKey = content.slice(0, i).trim()
      if (rawKey === '') return null
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? String(formatScalarValue(rawKey, 0)) : rawKey
      return { key, rest: content.slice(i + 1).trim() }
    }
  }
  return null
}

/** @param {string} text @param {number} line */
function formatScalarValue(text, line) {
  const value = text.trim()
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (value === '[]') return []
  if (value === '{}') return {}
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new YamlError('unterminated double-quoted scalar', line)
    try {
      return JSON.parse(value)
    } catch {
      throw new YamlError(`invalid double-quoted scalar ${value}`, line)
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new YamlError('unterminated single-quoted scalar', line)
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return splitFlow(inner).map(part => formatScalarValue(part, line))
  }
  if (NUMBER.test(value)) return Number(value)
  return value
}

/** @param {string} inner */
function splitFlow(inner) {
  /** @type {string[]} */
  const parts = []
  let current = ''
  let quote = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote !== null) {
      current += ch
      if (ch === '\\' && quote === '"') { current += inner[i + 1] ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === ',') { parts.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}
