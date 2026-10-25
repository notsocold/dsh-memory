/**
 * Persistent state for the dsh-memory plugin.
 *
 * Storage is split by owner:
 *  - Markdown topic files plus a generated `MEMORY.md` index hold memories
 *    (global at `$DSH_HOME/dsh-memory/`, project at
 *    `{workspace}/.dsh/dsh-memory/`);
 *  - `state.json` under `$DSH_HOME/dsh-memory/` holds operational records only:
 *    settings, extraction watermarks, per-session opt-out, activity, stats and
 *    the known-project registry;
 *  - `audit.jsonl` is the append-only audit journal.
 *
 * Version 1 stored memories inside `memory.json`. A one-time migration moves
 * them into Markdown topic files and renames the legacy file to
 * `memory.json.migrated-<timestamp>`.
 *
 * @module dsh-memory/lib/state
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Current state document schema version. */
export const STATE_VERSION = 2

/** Directory name below `$DSH_HOME` owned by this plugin. */
export const MEMORY_DIR = 'dsh-memory'

/** Current operational state file name. */
export const STATE_FILE = 'state.json'

/** Version-1 state file name, retained only as a migration source/backup. */
export const LEGACY_STATE_FILE = 'memory.json'

/** Project-level memory directory segments inside a workspace. */
export const PROJECT_MEMORY_SEGMENTS = ['.dsh', 'dsh-memory']

/** Allowed memory kinds (ordered for UI display). */
export const MEMORY_KINDS = /** @type {const} */ ([
  'user',
  'preference',
  'project',
  'decision',
  'reference',
  'todo',
])

/** Allowed memory scopes. */
export const MEMORY_SCOPES = /** @type {const} */ (['global', 'project'])

/** Allowed record statuses. */
export const MEMORY_STATUSES = /** @type {const} */ (['active', 'archived'])

/** Allowed origins recorded in `source.origin`. */
export const MEMORY_ORIGINS = /** @type {const} */ (['auto', 'tool', 'manual', 'import'])

/** Allowed activity triggers. */
export const ACTIVITY_TRIGGERS = /** @type {const} */ ([
  'quiet',
  'boundary',
  'dispose',
  'manual',
  'tool-extract',
])

/** Allowed activity statuses. */
export const ACTIVITY_STATUSES = /** @type {const} */ (['ok', 'skipped', 'error'])

/** Bounded lengths enforced by normalization. */
export const LIMITS = {
  title: 120,
  summary: 240,
  content: 8000,
  tag: 40,
  tags: 8,
  projectName: 200,
  activity: 100,
  sessionTitle: 200,
}

/**
 * Fresh default settings.
 * @returns {Record<string, any>}
 */
export function defaultSettings() {
  return {
    enabled: true,
    autoExtract: true,
    autoExtractExistingSessions: false,
    quietSeconds: 30,
    minNewChars: 120,
    minIntervalSeconds: 60,
    maxRunsPerHour: 12,
    autoSaveMinImportance: 3,
    maxTopicsInPrompt: 30,
    maxIndexChars: 4000,
    projectMaxTopicsInPrompt: 30,
    projectMaxIndexChars: 4000,
    projectsEnabled: true,
    redactSecrets: true,
    toolEnabled: true,
    allowModelDelete: true,
    allowSensitive: false,
    judgeProvider: '',
    judgeModel: '',
  }
}

/** Numeric setting bounds: [min, max]. */
export const NUMBER_SETTING_BOUNDS = {
  quietSeconds: [3, 600],
  minNewChars: [0, 100000],
  minIntervalSeconds: [0, 86400],
  maxRunsPerHour: [1, 1000],
  autoSaveMinImportance: [1, 5],
  maxTopicsInPrompt: [1, 500],
  maxIndexChars: [500, 200000],
  projectMaxTopicsInPrompt: [1, 500],
  projectMaxIndexChars: [500, 200000],
}

/** Boolean settings. */
export const BOOLEAN_SETTING_KEYS = [
  'enabled',
  'autoExtract',
  'autoExtractExistingSessions',
  'projectsEnabled',
  'redactSecrets',
  'toolEnabled',
  'allowModelDelete',
  'allowSensitive',
]

/** @returns {Record<string, any>} fresh default state (no memories: those live in files). */
export function defaultState() {
  return {
    version: STATE_VERSION,
    settings: defaultSettings(),
    watermarks: {},
    sessionOptOut: {},
    activity: [],
    stats: { created: 0, updated: 0, deleted: 0, runs: 0, errors: 0, migrated: 0 },
    projects: {},
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one JSON object key is safe to copy into a plain state map.
 * Guards `__proto__`, `constructor` and `prototype` against prototype
 * pollution / silent data loss from hand-edited or hostile state files.
 * @param {unknown} key - candidate key.
 * @returns {boolean}
 */
export function isSafeMapKey(key) {
  return typeof key === 'string' && key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/**
 * Resolve the Harness home directory (explicit, `$DSH_HOME`, or `~/.dsh`).
 * @param {string} [explicit] - explicit override.
 * @returns {string} absolute path.
 */
export function resolveDshHome(explicit) {
  const explicitHome = typeof explicit === 'string' ? explicit.trim() : ''
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const raw = explicitHome !== '' ? explicitHome : envHome !== '' ? envHome : join(homedir(), '.dsh')
  return resolve(expandHome(raw))
}

/**
 * Expand a leading `~` or `~/` against the current user's home directory.
 * @param {string} value - path text.
 * @returns {string} expanded path.
 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Create a plugin error carrying a stable machine code for the HTTP API.
 * @param {string} code - one of the API error codes.
 * @param {string} message - human-readable reason.
 * @returns {Error & { code: string }}
 */
export function memoryError(code, message) {
  const error = new Error(message)
  const coded = /** @type {Error & { code: string }} */ (error)
  coded.code = code
  return coded
}

/** Known error codes mapped to HTTP-ish semantics by the API layer. */
export const ERROR_CODES = /** @type {const} */ ([
  'invalid-request',
  'not-found',
  'io-error',
  'disabled',
  'judge-failed',
  'session-not-live',
  'internal',
])

/**
 * Reduce an arbitrary thrown value to the API failure envelope.
 * @param {unknown} error - thrown value.
 * @returns {{ code: string, message: string }}
 */
export function apiErrorOf(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code
  const known = typeof code === 'string' && ERROR_CODES.includes(code)
  return { code: known ? code : 'internal', message: errorMessage(error) }
}

/**
 * Render an arbitrary thrown value for logs and API messages.
 * @param {unknown} error - thrown value.
 * @returns {string} bounded text.
 */
export function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

/**
 * Whether an fs error means "the path does not exist".
 * @param {unknown} error - caught fs error.
 * @returns {boolean}
 */
export function isMissing(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * @param {number} [now] - epoch milliseconds.
 * @returns {string} ISO timestamp.
 */
export function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

/**
 * Mint one memory id (`m_` + 8 lowercase hex characters).
 * @returns {string}
 */
export function mintMemoryId() {
  return `m_${randomBytes(4).toString('hex')}`
}

/** Memory id grammar shared with normalization and the API. */
export const MEMORY_ID_PATTERN = /^m_[0-9a-f]{8}$/u

/**
 * @param {unknown} value - timestamp candidate.
 * @returns {string | undefined} ISO timestamp when parseable.
 */
export function normalizeTimestamp(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * Normalize one settings document, filling defaults; invalid types keep the
 * default and out-of-range numbers are clamped.
 * @param {unknown} raw - parsed settings.
 * @returns {Record<string, any>}
 */
export function normalizeSettings(raw) {
  const settings = defaultSettings()
  if (!isRecord(raw)) return settings
  for (const key of BOOLEAN_SETTING_KEYS) {
    if (typeof raw[key] === 'boolean') settings[key] = raw[key]
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_SETTING_BOUNDS)) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue
    settings[key] = Math.min(max, Math.max(min, value))
  }
  if (typeof raw.judgeProvider === 'string') settings.judgeProvider = raw.judgeProvider.trim().slice(0, 120)
  if (typeof raw.judgeModel === 'string') settings.judgeModel = raw.judgeModel.trim().slice(0, 120)
  return settings
}

/**
 * @param {unknown} value - string candidate.
 * @param {number} max - bound.
 * @returns {string}
 */
function boundedText(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim().slice(0, max)
}

/**
 * @param {unknown} value - numeric candidate.
 * @param {number} fallback - default.
 * @returns {number}
 */
function toInteger(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

/**
 * Normalize one project reference used by legacy records.
 * @param {unknown} raw - parsed value.
 * @returns {{ key: string, name: string } | null}
 */
export function normalizeProjectRef(raw) {
  if (!isRecord(raw)) return null
  const key = boundedText(raw.key, 4096)
  if (key === '') return null
  const name = boundedText(raw.name, LIMITS.projectName) || basename(key) || key
  return { key, name }
}

/**
 * @param {unknown} raw - raw source stamp.
 * @returns {Record<string, any>}
 */
function normalizeSource(raw) {
  if (!isRecord(raw)) return { origin: 'import' }
  const source = { origin: MEMORY_ORIGINS.includes(raw.origin) ? raw.origin : 'import' }
  if (typeof raw.sessionId === 'string' && raw.sessionId !== '') source.sessionId = raw.sessionId.slice(0, 200)
  if (typeof raw.sessionTitle === 'string' && raw.sessionTitle !== '') {
    source.sessionTitle = boundedText(raw.sessionTitle, LIMITS.sessionTitle)
  }
  if (typeof raw.model === 'string' && raw.model !== '') source.model = raw.model.slice(0, 200)
  return source
}

/**
 * Normalize one legacy (v1) memory record.
 * @param {unknown} raw - parsed record.
 * @returns {Record<string, any> | undefined}
 */
export function normalizeRecord(raw) {
  if (!isRecord(raw)) return undefined
  const id = typeof raw.id === 'string' && MEMORY_ID_PATTERN.test(raw.id) ? raw.id : ''
  const title = boundedText(raw.title, LIMITS.title)
  const content = boundedText(raw.content, LIMITS.content)
  if (id === '' || title === '' || content === '') return undefined
  const summary = boundedText(raw.summary, LIMITS.summary) || boundedText(content, LIMITS.summary)
  const kind = MEMORY_KINDS.includes(raw.kind) ? raw.kind : 'reference'
  const scope = MEMORY_SCOPES.includes(raw.scope) ? raw.scope : 'global'
  const project = scope === 'project' ? normalizeProjectRef(raw.project) : null
  if (scope === 'project' && project === null) return undefined
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags
      .filter(tag => typeof tag === 'string')
      .map(tag => boundedText(tag, LIMITS.tag))
      .filter(tag => tag !== ''))].slice(0, LIMITS.tags)
    : []
  const importance = Math.min(5, Math.max(1, toInteger(raw.importance, 3)))
  const createdAt = normalizeTimestamp(raw.createdAt) ?? isoNow()
  const updatedAt = normalizeTimestamp(raw.updatedAt) ?? createdAt
  return {
    id,
    title,
    summary,
    content,
    kind,
    scope,
    project,
    tags,
    importance,
    pinned: raw.pinned === true,
    status: MEMORY_STATUSES.includes(raw.status) ? raw.status : 'active',
    createdAt,
    updatedAt,
    revision: Math.max(1, toInteger(raw.revision, 1)),
    source: normalizeSource(raw.source),
  }
}

/**
 * @param {unknown} raw - parsed activity entry.
 * @returns {Record<string, any> | undefined}
 */
function normalizeActivity(raw) {
  if (!isRecord(raw)) return undefined
  const at = normalizeTimestamp(raw.at)
  if (at === undefined) return undefined
  const trigger = ACTIVITY_TRIGGERS.includes(raw.trigger) ? raw.trigger : 'manual'
  const status = ACTIVITY_STATUSES.includes(raw.status) ? raw.status : 'ok'
  const entry = {
    at,
    trigger,
    status,
    created: Math.max(0, toInteger(raw.created, 0)),
    updated: Math.max(0, toInteger(raw.updated, 0)),
    skipped: Math.max(0, toInteger(raw.skipped, 0)),
  }
  if (typeof raw.sessionId === 'string' && raw.sessionId !== '') entry.sessionId = raw.sessionId.slice(0, 200)
  if (typeof raw.sessionTitle === 'string' && raw.sessionTitle !== '') {
    entry.sessionTitle = boundedText(raw.sessionTitle, LIMITS.sessionTitle)
  }
  if (typeof raw.projectKey === 'string' && raw.projectKey !== '') entry.projectKey = raw.projectKey.slice(0, 4096)
  if (typeof raw.reason === 'string' && raw.reason !== '') entry.reason = boundedText(raw.reason, 200)
  if (Number.isFinite(raw.durationMs)) entry.durationMs = Math.max(0, Math.round(raw.durationMs))
  return entry
}

/**
 * @param {unknown} raw - parsed activity array.
 * @returns {Record<string, any>[]}
 */
function normalizeActivityList(raw) {
  const activity = []
  if (!Array.isArray(raw)) return activity
  for (const candidate of raw) {
    const entry = normalizeActivity(candidate)
    if (entry === undefined) continue
    activity.push(entry)
    if (activity.length >= LIMITS.activity) break
  }
  return activity
}

/**
 * Normalize one known-project registry entry.
 * @param {unknown} raw - parsed entry.
 * @returns {Record<string, any> | undefined}
 */
export function normalizeProjectEntry(raw) {
  if (!isRecord(raw)) return undefined
  const memoryDir = boundedText(raw.memoryDir, 8192)
  if (memoryDir === '') return undefined
  const name = boundedText(raw.name, LIMITS.projectName) || basename(memoryDir) || memoryDir
  return {
    name,
    memoryDir,
    lastSeenAt: normalizeTimestamp(raw.lastSeenAt) ?? isoNow(),
    ...(normalizeTimestamp(raw.lastReadAt) === undefined ? {} : { lastReadAt: normalizeTimestamp(raw.lastReadAt) }),
    ...(normalizeTimestamp(raw.lastWriteAt) === undefined ? {} : { lastWriteAt: normalizeTimestamp(raw.lastWriteAt) }),
    ...(typeof raw.error === 'string' && raw.error !== '' ? { error: boundedText(raw.error, 300) } : {}),
  }
}

/**
 * Normalize an arbitrary parsed v2 state document.
 * @param {unknown} raw - parsed JSON document.
 * @returns {Record<string, any>}
 */
export function normalizeState(raw) {
  const state = defaultState()
  if (!isRecord(raw)) return state
  state.settings = normalizeSettings(raw.settings)
  if (isRecord(raw.watermarks)) {
    for (const [sessionId, value] of Object.entries(raw.watermarks)) {
      if (!isSafeMapKey(sessionId) || !isRecord(value)) continue
      state.watermarks[sessionId] = {
        seq: value.baseline === true
          ? Math.max(-1, toInteger(value.seq, -1))
          : Math.max(0, toInteger(value.seq, 0)),
        at: normalizeTimestamp(value.at) ?? isoNow(),
        chars: Math.max(0, toInteger(value.chars, 0)),
        ...(value.baseline === true ? { baseline: true } : {}),
      }
    }
  }
  if (isRecord(raw.sessionOptOut)) {
    for (const [sessionId, value] of Object.entries(raw.sessionOptOut)) {
      if (isSafeMapKey(sessionId) && value === true) state.sessionOptOut[sessionId] = true
    }
  }
  state.activity = normalizeActivityList(raw.activity)
  if (isRecord(raw.stats)) {
    for (const key of Object.keys(state.stats)) {
      state.stats[key] = Math.max(0, toInteger(raw.stats[key], 0))
    }
  }
  if (isRecord(raw.projects)) {
    for (const [key, value] of Object.entries(raw.projects)) {
      if (!isSafeMapKey(key)) continue
      const entry = normalizeProjectEntry(value)
      if (entry !== undefined) state.projects[key] = entry
    }
  }
  return state
}

/**
 * Normalize one legacy (v1) state document for migration.
 * @param {unknown} raw - parsed `memory.json`.
 * @returns {{
 *   version: 1,
 *   settings: Record<string, any>,
 *   memories: Record<string, any>[],
 *   watermarks: Record<string, any>,
 *   sessionOptOut: Record<string, boolean>,
 *   activity: Record<string, any>[],
 *   stats: Record<string, number>,
 * }}
 */
export function normalizeLegacyState(raw) {
  const source = isRecord(raw) ? raw : {}
  const memories = []
  const seen = new Set()
  if (Array.isArray(source.memories)) {
    for (const candidate of source.memories) {
      const record = normalizeRecord(candidate)
      if (record === undefined || seen.has(record.id)) continue
      seen.add(record.id)
      memories.push(record)
    }
  }
  const watermarks = {}
  if (isRecord(source.watermarks)) {
    for (const [sessionId, value] of Object.entries(source.watermarks)) {
      if (!isSafeMapKey(sessionId) || !isRecord(value)) continue
      watermarks[sessionId] = {
        seq: Math.max(0, toInteger(value.seq, 0)),
        at: normalizeTimestamp(value.at) ?? isoNow(),
        chars: Math.max(0, toInteger(value.chars, 0)),
      }
    }
  }
  const sessionOptOut = {}
  if (isRecord(source.sessionOptOut)) {
    for (const [sessionId, value] of Object.entries(source.sessionOptOut)) {
      if (isSafeMapKey(sessionId) && value === true) sessionOptOut[sessionId] = true
    }
  }
  const statsSource = isRecord(source.stats) ? source.stats : {}
  return {
    version: 1,
    settings: normalizeSettings(source.settings),
    memories,
    watermarks,
    sessionOptOut,
    activity: normalizeActivityList(source.activity),
    stats: {
      created: Math.max(0, toInteger(statsSource.created, 0)),
      updated: Math.max(0, toInteger(statsSource.updated, 0)),
      deleted: Math.max(0, toInteger(statsSource.deleted, 0)),
      runs: Math.max(0, toInteger(statsSource.runs, 0)),
      errors: Math.max(0, toInteger(statsSource.errors, 0)),
      migrated: 0,
    },
  }
}

/**
 * Owns the on-disk operational state document and the plugin directory.
 */
export class StateStore {
  /**
   * @param {{ home?: string, logger?: { warn?: (message: string) => void } }} [options]
   */
  constructor(options = {}) {
    /** @type {string} */
    this.home = resolveDshHome(options.home)
    /** @type {string} */
    this.root = join(this.home, MEMORY_DIR)
    /** @type {string} */
    this.statePath = join(this.root, STATE_FILE)
    /** @type {string} */
    this.legacyPath = join(this.root, LEGACY_STATE_FILE)
    /** @type {string} */
    this.auditPath = join(this.root, 'audit.jsonl')
    /** @type {{ warn?: (message: string) => void } | undefined} */
    this.logger = options.logger
    /** @type {Record<string, any>} */
    this.state = defaultState()
    this.loaded = false
    /** @type {Promise<void> | null} */
    this.saveChain = null
    this.saveCounter = 0
  }

  /**
   * Read the current state document, or the legacy v1 document when only
   * `memory.json` exists.
   * @returns {Promise<{ state?: Record<string, any>, legacy?: Record<string, any> }>}
   */
  async read() {
    await mkdir(this.root, { recursive: true })
    let raw
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        throw memoryError('io-error', `cannot read ${this.statePath}: ${errorMessage(error)}`)
      }
      raw = undefined
    }
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw)
        this.state = normalizeState(parsed)
        this.loaded = true
        return { state: this.state }
      } catch {
        const broken = `${this.statePath}.broken-${Date.now()}`
        await rename(this.statePath, broken).catch(() => {})
        this.logger?.warn?.(`dsh-memory: preserved corrupt state at ${broken}`)
      }
    }
    let legacyRaw
    try {
      legacyRaw = await readFile(this.legacyPath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        throw memoryError('io-error', `cannot read ${this.legacyPath}: ${errorMessage(error)}`)
      }
      legacyRaw = undefined
    }
    if (legacyRaw !== undefined) {
      try {
        const legacy = normalizeLegacyState(JSON.parse(legacyRaw))
        this.loaded = true
        return { legacy }
      } catch {
        const broken = `${this.legacyPath}.broken-${Date.now()}`
        await rename(this.legacyPath, broken).catch(() => {})
        this.logger?.warn?.(`dsh-memory: preserved corrupt legacy state at ${broken}`)
      }
    }
    this.state = defaultState()
    this.loaded = true
    return { state: this.state }
  }

  /**
   * Atomically persist the operational state document.
   * @returns {Promise<void>}
   */
  async save() {
    const run = async () => {
      await mkdir(dirname(this.statePath), { recursive: true })
      this.saveCounter += 1
      const tmp = join(dirname(this.statePath), `.state.json.${process.pid}.${this.saveCounter}.tmp`)
      const body = `${JSON.stringify(this.state, null, 2)}\n`
      try {
        await writeFile(tmp, body, 'utf8')
        await rename(tmp, this.statePath)
      } catch (error) {
        throw memoryError('io-error', `cannot write ${this.statePath}: ${errorMessage(error)}`)
      }
    }
    const queued = (this.saveChain ?? Promise.resolve()).then(run, run)
    this.saveChain = queued.catch(() => {})
    return queued
  }

  /**
   * Append one JSON line to the audit journal. Audit failures never fail the
   * operation that produced them.
   * @param {Record<string, any>} entry - audit entry.
   * @returns {Promise<void>}
   */
  async appendAudit(entry) {
    try {
      await mkdir(this.root, { recursive: true })
      await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      this.logger?.warn?.(`dsh-memory: cannot append audit: ${errorMessage(error)}`)
    }
  }

  /**
   * Rename the legacy state file after a successful migration.
   * @returns {Promise<string | undefined>} backup path when renamed.
   */
  async backupLegacy() {
    const backup = `${this.legacyPath}.migrated-${Date.now()}`
    try {
      await rename(this.legacyPath, backup)
      return backup
    } catch (error) {
      if (isMissing(error)) return undefined
      this.logger?.warn?.(`dsh-memory: cannot back up legacy state: ${errorMessage(error)}`)
      return undefined
    }
  }
}
