/**
 * Artifact storage for one US: read/write the YAML and Markdown under
 * `docs/awf/<US-ID>/`, keep the hash ledger (ART-02) honest, and hand out the
 * workflow manifest (ART-00) as the single source of truth for state.
 *
 * The store never decides policy: it reads, writes, hashes and validates shape.
 * The C rules live in `checks.js`, the transitions in `constants.js`.
 */

import { createHash } from 'node:crypto'
import { dump, parse, YamlError } from './yaml.js'
import { ARTIFACTS, US_DIRECTORIES, STAGE_ORDER } from './constants.js'

/** A failure the caller should surface verbatim instead of crashing the session. */
export class StoreError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.detail = detail
  }
}

/** sha256 of a UTF-8 string, as the protocol records it. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Bytes of a UTF-8 string. */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Current time in the protocol's second-precision UTC form. */
export function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * An `Io` binds the store to a filesystem. Two implementations exist — the DSH
 * `fs` service (sandboxed, correct in a live session) and `node:fs` (tests and
 * headless use) — so the store never touches `node:fs` directly.
 *
 * @typedef {{ readText(p: string, optional?: boolean): Promise<string|undefined>,
 *             writeText(p: string, text: string): Promise<void>,
 *             stat(p: string): Promise<{type: 'file'|'directory'|'other'}|undefined>,
 *             listDir(p: string): Promise<{name: string, type: string}[]>,
 *             mkdirp(p: string): Promise<void> }} Io
 */

/** Resolve and normalize a path under a root without escaping it. */
function underRoot(root, relative) {
  const base = root.replace(/\/+$/, '')
  const rel = String(relative).replace(/^\/+/, '').replace(/\/+$/, '')
  return rel === '' ? base : `${base}/${rel}`
}

/**
 * Build an Io over the DSH `fs` service. Every path passed in is relative to the
 * workspace root handed to the plugin; the service keeps sandbox enforcement.
 */
export function createServiceIo(fsService, root) {
  const resolve = async (relative) => {
    const abs = underRoot(root, relative)
    return fsService.resolve(abs)
  }
  return {
    async readText(relative, optional = false) {
      const target = await resolve(relative)
      const info = await fsService.stat(target)
      if (info === undefined) {
        if (optional) return undefined
        throw new StoreError('ENOENT', `文件不存在：${relative}`)
      }
      if (info.type !== 'file') throw new StoreError('ENOTFILE', `不是普通文件：${relative}`)
      return fsService.readText(target)
    },
    async writeText(relative, text) {
      const target = await resolve(relative)
      await fsService.writeText(target, text)
    },
    async stat(relative) {
      const target = await resolve(relative)
      const info = await fsService.stat(target)
      if (info === undefined) return undefined
      return { type: info.type }
    },
    async listDir(relative) {
      const target = await resolve(relative)
      const info = await fsService.stat(target)
      if (info === undefined || info.type !== 'directory') return []
      const entries = await fsService.listDir(target)
      return entries.map(entry => ({ name: entry.name, type: entry.type }))
    },
    async mkdirp() {
      // The fs service creates parent directories on write; a directory with no
      // content yet is represented by writing a placeholder only in tests.
    },
  }
}

/** Build an Io over `node:fs` — used by the grader and by unit tests. */
export async function createNodeIo(root) {
  const fsp = await import('node:fs/promises')
  return {
    async readText(relative, optional = false) {
      try {
        return await fsp.readFile(underRoot(root, relative), 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT' && optional) return undefined
        throw new StoreError(error.code || 'EIO', `读取失败：${relative}`, String(error.message))
      }
    },
    async writeText(relative, text) {
      const abs = underRoot(root, relative)
      const directory = abs.slice(0, abs.lastIndexOf('/'))
      if (directory !== '') await fsp.mkdir(directory, { recursive: true })
      await fsp.writeFile(abs, text, 'utf8')
    },
    async stat(relative) {
      try {
        const info = await fsp.stat(underRoot(root, relative))
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async listDir(relative) {
      try {
        const entries = await fsp.readdir(underRoot(root, relative), { withFileTypes: true })
        return entries.map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
        throw error
      }
    },
    async mkdirp(relative) {
      await fsp.mkdir(underRoot(root, relative), { recursive: true })
    },
  }
}

/** Parse YAML and wrap the failure with the file it came from. */
export function parseYaml(text, label) {
  try {
    return parse(text)
  } catch (error) {
    if (error instanceof YamlError) {
      throw new StoreError('EYAML', `${label} 不是合法 YAML：${error.message}`, error.detail)
    }
    throw error
  }
}

/** Dump YAML with a trailing newline, as the protocol's files all carry one. */
export function dumpYaml(value) {
  return `${dump(value)}\n`
}

/** The empty workflow manifest a new US starts from (ART-00). */
export function emptyManifest(usId, mode, baselineId) {
  const artifacts = {}
  for (const stage of STAGE_ORDER) artifacts[stage] = { bundle_id: `${stage}-001`, version: 0, status: 'not_started' }
  return {
    id: `${usId}-WF`,
    us_id: usId,
    mode,
    portfolio_id: null,
    status: 'CREATED',
    current_stage: null,
    baseline_id: baselineId,
    review_rounds: [],
    frozen_at: null,
    artifacts,
    approvals: {
      G1: { status: 'not_started' },
      G2: { status: 'not_started' },
      G3: { status: 'not_started' },
    },
    stale: [],
    human_edits: [],
    blocked_reasons: [],
    transitions: [],
  }
}

/** Field defaults so a hand-written manifest never crashes a reader. */
export function normalizeManifest(raw, usId, mode, baselineId) {
  const base = emptyManifest(usId, mode, baselineId)
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...base, ...value }
  merged.artifacts = { ...base.artifacts, ...(value.artifacts || {}) }
  for (const stage of STAGE_ORDER) {
    merged.artifacts[stage] = { bundle_id: `${stage}-001`, version: 0, status: 'not_started', ...(merged.artifacts[stage] || {}) }
  }
  merged.approvals = { ...base.approvals, ...(value.approvals || {}) }
  for (const gate of ['G1', 'G2', 'G3']) {
    merged.approvals[gate] = { status: 'not_started', ...(merged.approvals[gate] || {}) }
  }
  for (const key of ['review_rounds', 'stale', 'human_edits', 'blocked_reasons', 'transitions']) {
    if (!Array.isArray(merged[key])) merged[key] = []
  }
  return merged
}

/**
 * A Store is bound to one workspace root. Every method takes a US id so a
 * session can inspect several US without rebuilding the store.
 */
export class Store {
  /** @param {Io} io @param {{root?: string}} [options] */
  constructor(io, options = {}) {
    this.io = io
    this.root = options.root || '.'
    this.cache = new Map()
  }

  /** `docs/awf/<US-ID>` */
  usDir(usId) {
    return `docs/awf/${usId}`
  }

  /** Workspace-relative path of an artifact for one US. */
  pathOf(usId, artifactId) {
    const entry = ARTIFACTS[artifactId]
    if (entry === undefined) throw new StoreError('EARTIFACT', `未知产物编号：${artifactId}`)
    const dir = this.usDir(usId)
    return entry.dir === '..' ? `${dir}/${entry.file}` : `${dir}/${entry.dir}/${entry.file}`
  }

  /** List the US ids that have a workflow manifest. */
  async listUs() {
    const base = 'docs/awf'
    const entries = await this.io.listDir(base)
    const result = []
    for (const entry of entries) {
      if (entry.type !== 'directory') continue
      const info = await this.io.stat(`${base}/${entry.name}/00-workflow/workflow-manifest.yaml`)
      if (info !== undefined && info.type === 'file') result.push(entry.name)
    }
    return result.sort()
  }

  /** True when the US directory carries a manifest (i.e. `/etp-awf-start` ran). */
  async isInitialized(usId) {
    const info = await this.io.stat(`${this.usDir(usId)}/00-workflow/workflow-manifest.yaml`)
    return info !== undefined && info.type === 'file'
  }

  /** Create the six directories plus a placeholder so empty dirs survive. */
  async ensureLayout(usId) {
    const dir = this.usDir(usId)
    for (const name of US_DIRECTORIES) await this.io.mkdirp(`${dir}/${name}`)
    for (const name of US_DIRECTORIES) {
      const keep = `${dir}/${name}/.keep`
      const info = await this.io.stat(keep)
      if (info === undefined) await this.io.writeText(keep, '')
    }
  }

  /** Read the workflow manifest; `undefined` when the US was never initialized. */
  async readManifest(usId) {
    const text = await this.io.readText(`${this.usDir(usId)}/00-workflow/workflow-manifest.yaml`, true)
    if (text === undefined) return undefined
    const raw = parseYaml(text, 'workflow-manifest.yaml')
    return { manifest: normalizeManifest(raw, usId), text }
  }

  /** Persist the workflow manifest and return its hash. */
  async saveManifest(usId, manifest) {
    const text = dumpYaml(manifest)
    await this.io.writeText(`${this.usDir(usId)}/00-workflow/workflow-manifest.yaml`, text)
    return sha256(text)
  }

  /** Read the analysis baseline (ART-01). */
  async readBaseline(usId) {
    const text = await this.io.readText(`${this.usDir(usId)}/00-workflow/analysis-baseline.yaml`, true)
    if (text === undefined) return undefined
    return parseYaml(text, 'analysis-baseline.yaml')
  }

  /** Read the artifact hash ledger (ART-02). */
  async readLedger(usId) {
    const text = await this.io.readText(`${this.usDir(usId)}/00-workflow/artifact-manifest.yaml`, true)
    if (text === undefined) return { id: `${usId}-AM`, us_id: usId, entries: {} }
    const raw = parseYaml(text, 'artifact-manifest.yaml')
    if (raw === null || typeof raw !== 'object') return { id: `${usId}-AM`, us_id: usId, entries: {} }
    return { entries: {}, ...raw }
  }

  /** Persist the artifact hash ledger. */
  async saveLedger(usId, ledger) {
    await this.io.writeText(`${this.usDir(usId)}/00-workflow/artifact-manifest.yaml`, dumpYaml(ledger))
  }

  /** Load one YAML artifact, or `undefined` when the file is absent. */
  async readYaml(usId, artifactId) {
    const key = `${usId}:${artifactId}`
    if (this.cache.has(key)) return this.cache.get(key)
    const text = await this.io.readText(this.pathOf(usId, artifactId), true)
    if (text === undefined) {
      this.cache.set(key, undefined)
      return undefined
    }
    const value = parseYaml(text, ARTIFACTS[artifactId].file)
    this.cache.set(key, value)
    return value
  }

  /** Load one Markdown artifact. */
  async readMarkdown(usId, artifactId) {
    return this.io.readText(this.pathOf(usId, artifactId), true)
  }

  /** Write a YAML artifact and record its hash in the ledger. */
  async writeYaml(usId, artifactId, value) {
    const text = dumpYaml(value)
    await this.io.writeText(this.pathOf(usId, artifactId), text)
    this.cache.set(`${usId}:${artifactId}`, value)
    await this.register(usId, artifactId, text, value)
    return { path: this.pathOf(usId, artifactId), hash: sha256(text), bytes: byteLength(text) }
  }

  /** Write a Markdown artifact and record its hash. */
  async writeMarkdown(usId, artifactId, text) {
    const body = text.endsWith('\n') ? text : `${text}\n`
    await this.io.writeText(this.pathOf(usId, artifactId), body)
    await this.register(usId, artifactId, body, undefined)
    return { path: this.pathOf(usId, artifactId), hash: sha256(body), bytes: byteLength(body) }
  }

  /**
   * Register a written file in ART-02. The ledger is the only place a hash lives,
   * so a later pass can tell a human edit from a renderer output.
   */
  async register(usId, artifactId, text, value) {
    const ledger = await this.readLedger(usId)
    const entry = ARTIFACTS[artifactId]
    const previous = ledger.entries[artifactId] || {}
    const artifactHeader = value !== undefined && value !== null && typeof value === 'object' ? value.artifact : undefined
    ledger.entries[artifactId] = {
      id: artifactId,
      dir: entry.dir,
      file: entry.file,
      kind: entry.kind,
      sha256: sha256(text),
      bytes: byteLength(text),
      version: artifactHeader?.version ?? previous.version ?? null,
      status: artifactHeader?.status ?? previous.status ?? null,
      generated_by: artifactHeader?.generated_by ?? previous.generated_by ?? null,
      generated_at: artifactHeader?.generated_at ?? nowIso(),
      source_hash: artifactHeader?.source_hash ?? null,
    }
    ledger.us_id = usId
    ledger.updated_at = nowIso()
    await this.saveLedger(usId, ledger)
    return ledger.entries[artifactId]
  }

  /** True when the artifact file exists on disk. */
  async exists(usId, artifactId) {
    const info = await this.io.stat(this.pathOf(usId, artifactId))
    return info !== undefined
  }

  /** Directory listing of one artifact directory, filtered to real files. */
  async listArtifactDir(usId, artifactId) {
    const entries = await this.io.listDir(this.pathOf(usId, artifactId))
    return entries.filter(entry => entry.name !== '.keep')
  }

  /**
   * Compare the ledger hash of an artifact with its current bytes. A mismatch is
   * a human edit; the protocol requires those to be re-approved (C10).
   */
  async detectHumanEdits(usId) {
    const ledger = await this.readLedger(usId)
    const edits = []
    for (const [artifactId, entry] of Object.entries(ledger.entries || {})) {
      const artifact = ARTIFACTS[artifactId]
      if (artifact === undefined || artifact.kind === 'directory') continue
      const text = await this.io.readText(this.pathOf(usId, artifactId), true)
      if (text === undefined) continue
      const actual = sha256(text)
      if (entry.sha256 !== actual) {
        edits.push({ artifact: artifactId, file: artifact.file, recorded: entry.sha256, actual, at: nowIso() })
      }
    }
    return edits
  }

  /** The next version for a stage bundle (protocol: previous + 1). */
  nextVersion(manifest, stage) {
    const current = manifest.artifacts?.[stage]?.version ?? 0
    return Number(current) + 1
  }

  /** Mark every artifact of the given stages STALE in the manifest. */
  markStale(manifest, stages, reason) {
    for (const stage of stages) {
      const slot = manifest.artifacts?.[stage]
      if (slot === undefined) continue
      slot.status = 'STALE'
      manifest.stale.push({ stage, bundle_id: slot.bundle_id, version: slot.version, reason, at: nowIso() })
    }
    return manifest
  }

  /** Append a transition record and move the state. */
  transition(manifest, to, detail) {
    const from = manifest.status
    manifest.status = to
    manifest.transitions.push({ from, to, detail, at: nowIso() })
    return manifest
  }

  /** Append a line to the execution report (ART-03). */
  async appendReport(usId, lines) {
    const text = (await this.io.readText(`${this.usDir(usId)}/00-workflow/workflow-report.md`, true)) || ''
    const body = Array.isArray(lines) ? lines.join('\n') : String(lines)
    const next = `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${body}\n`
    await this.io.writeText(`${this.usDir(usId)}/00-workflow/workflow-report.md`, next)
  }
}

/** Build a store over the DSH fs service for a workspace root. */
export function serviceStore(fsService, root) {
  return new Store(createServiceIo(fsService, root), { root })
}

/** Build a store over `node:fs` — tests, graders and CLI use. */
export async function nodeStore(root) {
  return new Store(await createNodeIo(root), { root })
}
