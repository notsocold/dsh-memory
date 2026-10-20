/**
 * Memory hub: routes records between the global Markdown collection
 * (`$DSH_HOME/dsh-memory/`) and per-workspace project collections
 * (`{workspace}/.dsh/dsh-memory/`), keeps the operational state document
 * (`state.json`), performs the v1→v2 migration, and merges prompt indexes.
 *
 * Topic files are authoritative. `state.json` never stores memories. All
 * filesystem mutations are synchronous and atomic; the operational state file
 * is persisted asynchronously through a serialized chain.
 *
 * @module dsh-memory/lib/store
 */

import { existsSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  BOOLEAN_SETTING_KEYS,
  LIMITS,
  MEMORY_ID_PATTERN,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  NUMBER_SETTING_BOUNDS,
  STATE_VERSION,
  defaultState,
  isRecord,
  isSafeMapKey,
  memoryError,
  mintMemoryId,
  normalizeSettings,
} from './state.js'
import {
  contentHash,
  counts,
  normalizeTitle,
  renderJudgeIndex,
  renderIndex,
  scopeLabel,
  searchRecords,
  similarity,
} from './retrieval.js'
import { projectLabel, resolveWorkspace } from './project.js'
import { sanitizeText } from './privacy.js'
import { TopicCollection } from './topiccollection.js'

/** Similarity threshold above which a new topic is treated as a duplicate. */
export const MERGE_SIMILARITY = 0.85

/** Maximum number of active records per collection before lower-value records are archived. */
export const MAX_ACTIVE_RECORDS = 500

/** Project memory directory segments inside one workspace. */
export const PROJECT_MEMORY_DIR = join('.dsh', 'dsh-memory')

/**
 * @param {unknown} value - scope candidate.
 * @param {string} fallback - value used when absent.
 * @returns {string}
 */
function normalizeScope(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (!MEMORY_SCOPES.includes(value)) {
    throw memoryError('invalid-request', `scope must be one of ${MEMORY_SCOPES.join(', ')}`)
  }
  return value
}

/**
 * @param {unknown} value - kind candidate.
 * @param {string} fallback - value used when absent.
 * @returns {string}
 */
function normalizeKind(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (!MEMORY_KINDS.includes(value)) {
    throw memoryError('invalid-request', `kind must be one of ${MEMORY_KINDS.join(', ')}`)
  }
  return value
}

/**
 * @param {unknown} value - status candidate.
 * @returns {string}
 */
function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return 'active'
  if (!MEMORY_STATUSES.includes(value)) {
    throw memoryError('invalid-request', `status must be one of ${MEMORY_STATUSES.join(', ')}`)
  }
  return value
}

/**
 * @param {unknown} value - importance candidate.
 * @param {number} fallback - default importance.
 * @returns {number}
 */
function normalizeImportance(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw memoryError('invalid-request', 'importance must be a number')
  return Math.min(5, Math.max(1, Math.round(number)))
}

/**
 * @param {unknown} value - tags candidate.
 * @returns {string[]}
 */
function normalizeTags(value) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set()
  const tags = []
  for (const tag of raw) {
    const cleaned = sanitizeText(tag, LIMITS.tag, { redact: false }).text
    if (cleaned === '' || seen.has(cleaned)) continue
    seen.add(cleaned)
    tags.push(cleaned)
    if (tags.length >= LIMITS.tags) break
  }
  return tags
}

/**
 * Validate and canonicalize one project reference.
 * @param {unknown} value - raw project reference.
 * @returns {{ key: string, name: string } | null}
 */
function normalizeProjectRef(value) {
  if (!isRecord(value)) return null
  const keyText = typeof value.key === 'string' ? value.key.trim() : ''
  if (keyText === '') return null
  const key = resolve(keyText)
  const name = typeof value.name === 'string' && value.name.trim() !== ''
    ? value.name.trim().slice(0, LIMITS.projectName)
    : basename(key) || key
  return { key, name }
}

/**
 * Build one normalized memory record.
 * @param {Record<string, any>} input - create input.
 * @param {{
 *   id: string, createdAt: string, updatedAt: string, revision: number,
 *   origin: string, source: Record<string, any>,
 * }} meta - record identity and provenance.
 * @returns {Record<string, any>}
 */
function buildRecord(input, meta) {
  const title = sanitizeText(input.title, LIMITS.title, { redact: false }).text
  const content = sanitizeText(input.content, LIMITS.content, { redact: true }).text
  if (title === '') throw memoryError('invalid-request', 'title must be a non-empty string')
  if (content === '') throw memoryError('invalid-request', 'content must be a non-empty string')
  const summary = sanitizeText(
    typeof input.summary === 'string' && input.summary.trim() !== ''
      ? input.summary
      : content.slice(0, LIMITS.summary),
    LIMITS.summary,
    { redact: true },
  ).text
  const scope = normalizeScope(input.scope, 'global')
  const project = scope === 'project' ? normalizeProjectRef(input.project) : null
  if (scope === 'project' && project === null) {
    throw memoryError('invalid-request', 'a project-scoped memory requires a project reference')
  }
  return {
    id: meta.id,
    title,
    summary,
    content,
    kind: normalizeKind(input.kind, 'reference'),
    scope,
    project,
    tags: normalizeTags(input.tags),
    importance: normalizeImportance(input.importance, 3),
    pinned: input.pinned === true,
    status: normalizeStatus(input.status),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    revision: meta.revision,
    source: {
      origin: MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'manual',
      ...(meta.source?.sessionId === undefined ? {} : { sessionId: String(meta.source.sessionId) }),
      ...(meta.source?.sessionTitle === undefined ? {} : { sessionTitle: String(meta.source.sessionTitle) }),
      ...(meta.source?.model === undefined ? {} : { model: String(meta.source.model) }),
    },
  }
}

/**
 * Validate one update patch and return the changed-field map.
 * @param {Record<string, any>} record - existing record.
 * @param {Record<string, any>} patch - requested changes.
 * @returns {{ changes: Record<string, any>, fields: string[] }}
 */
function buildPatch(record, patch) {
  if (!isRecord(patch)) throw memoryError('invalid-request', 'patch must be an object')
  /** @type {Record<string, any>} */
  const changes = {}
  const fields = []
  if (patch.title !== undefined) {
    const title = sanitizeText(patch.title, LIMITS.title, { redact: false }).text
    if (title === '') throw memoryError('invalid-request', 'title must be a non-empty string')
    changes.title = title
    fields.push('title')
  }
  if (patch.summary !== undefined) {
    changes.summary = sanitizeText(patch.summary, LIMITS.summary, { redact: true }).text
    fields.push('summary')
  }
  if (patch.content !== undefined) {
    const content = sanitizeText(patch.content, LIMITS.content, { redact: true }).text
    if (content === '') throw memoryError('invalid-request', 'content must be a non-empty string')
    changes.content = content
    fields.push('content')
  }
  if (patch.kind !== undefined) {
    changes.kind = normalizeKind(patch.kind, record.kind)
    fields.push('kind')
  }
  if (patch.scope !== undefined) {
    changes.scope = normalizeScope(patch.scope, record.scope)
    fields.push('scope')
  }
  if (patch.project !== undefined || changes.scope === 'project') {
    const project = normalizeProjectRef(patch.project ?? record.project)
    if (changes.scope === 'project' && project === null) {
      throw memoryError('invalid-request', 'a project-scoped memory requires a project reference')
    }
    changes.project = project
    fields.push('project')
  }
  // A project reference is only meaningful for project-scoped records.
  if ((changes.scope ?? record.scope) !== 'project') changes.project = null
  if (patch.tags !== undefined) {
    changes.tags = normalizeTags(patch.tags)
    fields.push('tags')
  }
  if (patch.importance !== undefined) {
    changes.importance = normalizeImportance(patch.importance, record.importance)
    fields.push('importance')
  }
  if (patch.pinned !== undefined) {
    changes.pinned = patch.pinned === true
    fields.push('pinned')
  }
  if (patch.status !== undefined) {
    changes.status = normalizeStatus(patch.status)
    fields.push('status')
  }
  if (fields.length === 0) throw memoryError('invalid-request', 'no updatable field was provided')
  return { changes, fields }
}

/**
 * Memory hub over one global collection plus lazily loaded project collections.
 */
export class MemoryStore {
  /**
   * @param {{
   *   stateStore: import('./state.js').StateStore,
   *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
   *   now?: () => number,
   *   mintId?: () => string,
   * }} options - injected dependencies.
   */
  constructor(options) {
    this.stateStore = options.stateStore
    this.logger = options.logger
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.mintId = typeof options.mintId === 'function' ? options.mintId : mintMemoryId
    /** @type {Set<() => void>} */
    this.listeners = new Set()
    /** @type {TopicCollection | null} */
    this.global = null
    /** @type {Map<string, { collection: TopicCollection, refs: number }>} */
    this.projects = new Map()
    this.dirty = false
    /** @type {Promise<void> | null} */
    this.writeChain = null
    /** @type {Promise<void> | null} */
    this.auditChain = null
    this.lastRefreshCheck = 0
    this.disposed = false
  }

  /** @returns {Record<string, any>} live state document. */
  get state() {
    return this.stateStore.state
  }

  /** @returns {Record<string, any>} live settings object. */
  get settings() {
    return this.state.settings
  }

  /** @returns {TopicCollection} the global collection (after load). */
  get globalCollection() {
    if (this.global === null) throw memoryError('internal', 'memory store is not loaded')
    return this.global
  }

  /** @returns {Record<string, any>[]} records loaded from all collections. */
  get memories() {
    const merged = []
    if (this.global !== null) merged.push(...this.global.records)
    for (const entry of this.projects.values()) merged.push(...entry.collection.records)
    return merged
  }

  /**
   * Load operational state, migrate a v1 document when needed, then load and
   * watch the global Markdown collection.
   * @returns {Promise<void>}
   */
  async load() {
    const loaded = await this.stateStore.read()
    if (loaded.legacy !== undefined) {
      this.stateStore.state = stateFromLegacy(loaded.legacy)
      await this.migrateLegacy(loaded.legacy)
    } else if (loaded.state !== undefined) {
      this.stateStore.state = loaded.state
    }
    this.global = new TopicCollection({
      dir: this.stateStore.root,
      scope: 'global',
      logger: this.logger,
      now: this.now,
    })
    this.global.onChange(() => { this.emitChange() })
    this.global.loadSync({ watch: true })
    this.global.regenerateIndex()
  }

  /**
   * Migrate a normalized v1 state document into Markdown topic files.
   * @param {Record<string, any>} legacy - normalized v1 state.
   * @returns {Promise<void>}
   */
  async migrateLegacy(legacy) {
    const state = stateFromLegacy(legacy)
    this.stateStore.state = state
    this.global = new TopicCollection({
      dir: this.stateStore.root,
      scope: 'global',
      logger: this.logger,
      now: this.now,
    })
    this.global.loadSync({ watch: false })
    const failed = []
    let migrated = 0
    for (const record of legacy.memories) {
      try {
        if (record.scope === 'global') {
          this.global.writeRecord(record, { notify: false })
        } else {
          const collection = this.ensureProjectCollection(record.project.key, record.project.name, { write: true })
          collection.writeRecord(record, { notify: false })
          this.registerProject(record.project, { write: true })
        }
        migrated += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ id: record.id, title: record.title, project: record.project, error: message })
        this.logger?.warn?.(`dsh-memory: cannot migrate ${record.id}: ${message}`)
      }
    }
    this.global.regenerateIndex()
    for (const entry of this.projects.values()) entry.collection.regenerateIndex()
    state.stats.migrated = migrated
    await this.stateStore.save()
    const backup = await this.stateStore.backupLegacy()
    if (failed.length > 0) {
      const pendingPath = join(this.stateStore.root, 'pending-migration.json')
      try {
        writeFileSync(pendingPath, `${JSON.stringify({ at: new Date(this.now()).toISOString(), failed }, null, 2)}\n`, 'utf8')
      } catch {
        // The legacy backup still preserves the records.
      }
    }
    await this.stateStore.appendAudit({
      at: new Date(this.now()).toISOString(),
      op: 'migrate',
      from: 1,
      to: STATE_VERSION,
      records: migrated,
      failed: failed.length,
      backup,
    })
    this.logger?.info?.(`dsh-memory: migrated ${migrated} legacy topic(s) to Markdown${failed.length === 0 ? '' : ` (${failed.length} pending)`}`)
    await this.stateStore.save()
  }

  /**
   * Register one change listener.
   * @param {() => void} listener - called after every in-memory mutation.
   * @returns {() => void} disposer.
   */
  onChange(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify listeners without failing the operation that triggered them. */
  emitChange() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: change listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Mark operational state dirty and start the serialized persistence chain. */
  touchState() {
    this.dirty = true
    if (this.writeChain === null) this.writeChain = this.drainWrites()
    this.emitChange()
  }

  /** @returns {Promise<void>} resolves when the current state write chain settles. */
  async drainWrites() {
    try {
      while (this.dirty) {
        this.dirty = false
        try {
          await this.stateStore.save()
        } catch (error) {
          this.dirty = true
          this.logger?.warn?.(`dsh-memory: cannot persist state: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.writeChain = null
    }
  }

  /** @returns {Promise<void>} wait for pending state and audit writes. */
  async flush() {
    if (this.writeChain !== null) await this.writeChain
    if (this.dirty && this.writeChain === null) {
      this.writeChain = this.drainWrites()
      await this.writeChain
    }
    if (this.auditChain !== null) await this.auditChain
  }

  /**
   * Append one audit line (best effort, serialized).
   * @param {Record<string, any>} entry - audit entry.
   */
  audit(entry) {
    const line = { at: new Date(this.now()).toISOString(), ...entry }
    this.auditChain = (this.auditChain ?? Promise.resolve())
      .then(() => this.stateStore.appendAudit(line))
      .catch(() => {})
  }

  /**
   * Path of one project's memory directory.
   * @param {string} projectKey - absolute workspace path.
   * @returns {string}
   */
  projectMemoryDir(projectKey) {
    if (typeof projectKey !== 'string' || projectKey.trim() === '') {
      throw memoryError('invalid-request', 'a projectKey is required')
    }
    return join(resolve(projectKey), PROJECT_MEMORY_DIR)
  }

  /**
   * Ensure one project collection is loaded (and optionally watched).
   * @param {string} projectKey - absolute workspace path.
   * @param {string} [name] - display name.
   * @param {{ write?: boolean, watch?: boolean }} [options] - directory creation and monitoring.
   * @returns {TopicCollection}
   */
  ensureProjectCollection(projectKey, name, options = {}) {
    const key = resolve(projectKey)
    const existing = this.projects.get(key)
    if (existing !== undefined) {
      if (options.write === true) existing.collection.ensureDir()
      if (options.watch === true) existing.collection.startWatch()
      return existing.collection
    }
    const project = {
      key,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : basename(key) || key,
    }
    const collection = new TopicCollection({
      dir: join(key, PROJECT_MEMORY_DIR),
      scope: 'project',
      project,
      logger: this.logger,
      now: this.now,
    })
    collection.onChange(() => { this.emitChange() })
    collection.loadSync({ watch: options.watch === true })
    if (options.write === true) collection.ensureDir()
    if (collection.exists) collection.regenerateIndex()
    this.projects.set(key, { collection, refs: 0 })
    this.registerProject(project, options)
    return collection
  }

  /**
   * Start watching one project collection when a live session already holds it.
   * @param {string} projectKey - absolute workspace path.
   */
  watchIfActive(projectKey) {
    const entry = this.projects.get(resolve(projectKey))
    if (entry !== undefined && entry.refs > 0) entry.collection.startWatch()
  }

  /**
   * Persist a project in the operational registry.
   * @param {{ key: string, name: string }} project - project reference.
   * @param {{ write?: boolean }} [options] - write timestamp switch.
   */
  registerProject(project, options = {}) {
    const key = resolve(project.key)
    const memoryDir = join(key, PROJECT_MEMORY_DIR)
    const now = new Date(this.now()).toISOString()
    const existing = this.state.projects[key]
    this.state.projects[key] = {
      name: project.name || existing?.name || basename(key) || key,
      memoryDir,
      lastSeenAt: now,
      ...(options.write === true ? { lastWriteAt: now } : {}),
      ...(existing?.lastReadAt === undefined ? {} : { lastReadAt: existing.lastReadAt }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    }
    this.touchState()
  }

  /**
   * Load every known project read-only so the settings page can list and edit
   * project memories without an open session.
   * @returns {{ key: string, name: string, memoryDir: string, records: number, error?: string }[]}
   */
  loadKnownProjects() {
    const result = []
    let registryChanged = false
    for (const [key, entry] of Object.entries(this.state.projects)) {
      const active = this.projects.get(key)
      const memoryDir = join(key, PROJECT_MEMORY_DIR)
      // Drop stale registry entries for directories that no longer exist, unless
      // a live session still holds the project (it may create the directory on
      // its next save).
      if (!existsSync(memoryDir) && (active?.refs ?? 0) === 0) {
        delete this.state.projects[key]
        if (active !== undefined && active.collection.records.length === 0) this.projects.delete(key)
        registryChanged = true
        continue
      }
      try {
        const collection = this.ensureProjectCollection(key, entry.name)
        collection.refreshSync({ regenerateIndex: true, forceReload: true })
        const now = new Date(this.now()).toISOString()
        this.state.projects[key] = { ...entry, memoryDir, lastReadAt: now }
        result.push({ key, name: entry.name, memoryDir, records: collection.records.length })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.state.projects[key] = { ...entry, memoryDir, error: message }
        result.push({ key, name: entry.name, memoryDir, records: 0, error: message })
      }
    }
    if (result.length > 0 || registryChanged) this.touchState()
    return result
  }

  /**
   * Acquire one project for a live session (loads and watches it).
   * @param {{ key: string, name: string }} project - project reference.
   * @returns {() => void} release function.
   */
  acquireProject(project) {
    this.ensureProjectCollection(project.key, project.name, { watch: true })
    const entry = this.projects.get(resolve(project.key))
    if (entry === undefined) return () => {}
    entry.refs += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0) entry.collection.stopWatch()
    }
  }

  /**
   * Refresh every loaded collection when the watcher may be unavailable.
   * Throttled so prompt assembly never pays a directory scan every step.
   * @returns {void}
   */
  refreshIfStale() {
    const now = this.now()
    // Filesystem timestamps can be coarser than rapid edits (especially in
    // VMs), so the fallback refresh re-reads topic files instead of trusting
    // mtime alone. The live watcher is still the fast path.
    if (now - this.lastRefreshCheck < 10000) return
    this.lastRefreshCheck = now
    if (this.global !== null) {
      try {
        this.global.refreshSync({ regenerateIndex: true, forceReload: true })
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: global refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const entry of this.projects.values()) {
      try {
        entry.collection.refreshSync({ regenerateIndex: true, forceReload: true })
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: project refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Mint a record id that is not loaded anywhere.
   * @returns {string}
   */
  nextId() {
    const used = new Set(this.memories.map(record => record.id))
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.mintId()
      if (MEMORY_ID_PATTERN.test(id) && !used.has(id)) return id
    }
    throw memoryError('internal', 'cannot mint a unique memory id')
  }

  /**
   * Find an existing record that a new topic should merge into inside one
   * collection.
   * @param {Record<string, any>[]} records - target collection records.
   * @param {{ title: string, content: string, summary?: string, kind: string }} input - candidate.
   * @returns {Record<string, any> | undefined}
   */
  findDuplicate(records, input) {
    const normalizedTitle = normalizeTitle(input.title)
    const hash = contentHash(input.content)
    for (const record of records) {
      if (record.status !== 'active') continue
      if (normalizeTitle(record.title) === normalizedTitle) return record
      if (contentHash(record.content) === hash) return record
    }
    const probe = `${input.title} ${input.summary ?? ''}`
    let best
    let bestScore = MERGE_SIMILARITY
    for (const record of records) {
      if (record.status !== 'active' || record.kind !== input.kind) continue
      const score = similarity(probe, `${record.title} ${record.summary}`)
      if (score >= bestScore) {
        best = record
        bestScore = score
      }
    }
    return best
  }

  /**
   * Locate the collection that owns one record.
   * @param {Record<string, any>} record - memory record.
   * @returns {TopicCollection | undefined}
   */
  collectionOf(record) {
    if (record.scope !== 'project') return this.global ?? undefined
    const entry = this.projects.get(resolve(record.project?.key ?? ''))
    return entry?.collection
  }

  /**
   * Resolve the collection for one create/update target.
   * @param {string} scope - global or project.
   * @param {{ key: string, name: string } | null} project - project reference.
   * @param {{ write?: boolean }} [options] - create the directory when needed.
   * @returns {TopicCollection}
   */
  collectionFor(scope, project, options = {}) {
    if (scope !== 'project') return this.globalCollection
    if (project === null) throw memoryError('invalid-request', 'a project-scoped memory requires a project reference')
    return this.ensureProjectCollection(project.key, project.name, { write: options.write !== false })
  }

  /**
   * Create a memory topic, merging into an equivalent topic in the same
   * collection.
   * @param {Record<string, any>} input - create input.
   * @param {{ origin?: string, source?: Record<string, any> }} [meta] - provenance.
   * @returns {{ action: 'created' | 'merged', record: Record<string, any> }}
   */
  create(input, meta = {}) {
    if (!isRecord(input)) throw memoryError('invalid-request', 'memory input must be an object')
    const origin = MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'manual'
    const nowIso = new Date(this.now()).toISOString()
    const candidate = buildRecord(input, {
      id: this.nextId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1,
      origin,
      source: meta.source ?? {},
    })
    const collection = this.collectionFor(candidate.scope, candidate.project, { write: true })
    const duplicate = this.findDuplicate(collection.records, candidate)
    if (duplicate !== undefined) {
      const updated = this.update(duplicate.id, {
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        kind: candidate.kind,
        scope: candidate.scope,
        project: candidate.project,
        tags: candidate.tags.length === 0 ? duplicate.tags : candidate.tags,
        importance: Math.max(duplicate.importance, candidate.importance),
      }, { ...meta, origin })
      return { action: 'merged', record: updated.record }
    }
    collection.writeRecord(candidate)
    if (candidate.scope === 'project') {
      this.registerProject(candidate.project, { write: true })
      this.watchIfActive(candidate.project.key)
    }
    this.state.stats.created += 1
    this.audit({
      op: 'create',
      scope: candidate.scope,
      project: candidate.project?.key,
      id: candidate.id,
      title: candidate.title,
      origin,
      sessionId: meta.source?.sessionId,
    })
    this.enforceQuota(collection)
    this.touchState()
    return { action: 'created', record: candidate }
  }

  /**
   * Update one record. Unknown ids throw `not-found`.
   * @param {string} id - record id.
   * @param {Record<string, any>} patch - field changes.
   * @param {{ origin?: string, source?: Record<string, any>, projectKey?: string }} [meta] - provenance.
   * @returns {{ action: 'updated', record: Record<string, any> }}
   */
  update(id, patch, meta = {}) {
    const record = this.findRecord(id, meta.projectKey)
    if (record === undefined) throw memoryError('not-found', `unknown memory "${id}"`)
    const previousScope = record.scope
    const previousProject = record.project
    const { changes, fields } = buildPatch(record, patch)
    for (const field of fields) record[field] = changes[field]
    if (changes.scope === 'global') record.project = null
    record.updatedAt = new Date(this.now()).toISOString()
    record.revision += 1
    if (MEMORY_ORIGINS.includes(meta.origin)) record.source = { ...record.source, origin: meta.origin }
    if (meta.source?.sessionId !== undefined) record.source.sessionId = String(meta.source.sessionId)
    if (meta.source?.sessionTitle !== undefined) record.source.sessionTitle = String(meta.source.sessionTitle)
    const moved = previousScope !== record.scope
      || (record.scope === 'project' && previousProject?.key !== record.project?.key)
    if (moved) {
      const oldCollection = this.collectionOf({ ...record, scope: previousScope, project: previousProject })
      oldCollection?.removeRecord(record.id)
      const target = this.collectionFor(record.scope, record.project, { write: true })
      target.writeRecord(record)
    } else {
      const collection = this.collectionOf(record)
      if (collection === undefined) throw memoryError('internal', `no collection for ${record.id}`)
      collection.writeRecord(record)
    }
    if (record.scope === 'project') {
      this.registerProject(record.project, { write: true })
      this.watchIfActive(record.project.key)
    }
    this.state.stats.updated += 1
    this.audit({
      op: 'update',
      scope: record.scope,
      project: record.project?.key,
      id: record.id,
      title: record.title,
      origin: record.source.origin,
      fields,
      revision: record.revision,
      sessionId: meta.source?.sessionId ?? record.source.sessionId,
    })
    this.touchState()
    return { action: 'updated', record }
  }

  /**
   * Delete one record.
   * @param {string} id - record id.
   * @param {{ origin?: string, projectKey?: string }} [meta] - provenance.
   * @returns {{ action: 'deleted', record: Record<string, any> }}
   */
  remove(id, meta = {}) {
    const record = this.findRecord(id, meta.projectKey)
    if (record === undefined) throw memoryError('not-found', `unknown memory "${id}"`)
    const collection = this.collectionOf(record)
    collection?.removeRecord(record.id)
    this.state.stats.deleted += 1
    this.audit({
      op: 'delete',
      scope: record.scope,
      project: record.project?.key,
      id: record.id,
      title: record.title,
      origin: MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'manual',
      sessionId: record.source?.sessionId,
    })
    this.touchState()
    return { action: 'deleted', record }
  }

  /**
   * Delete records in the global collection, one project, or every collection.
   * @param {{ projectKey?: string }} [options] - target selection.
   * @returns {{ count: number }}
   */
  clear(options = {}) {
    let count = 0
    if (typeof options.projectKey === 'string' && options.projectKey !== '') {
      const entry = this.projects.get(resolve(options.projectKey))
      const collection = entry?.collection ?? this.ensureProjectCollection(options.projectKey, undefined, { watch: false })
      count += collection.clearRecords()
    } else {
      count += this.globalCollection.clearRecords()
      const keys = new Set([...Object.keys(this.state.projects), ...this.projects.keys()])
      for (const key of keys) {
        try {
          const collection = this.ensureProjectCollection(key, this.state.projects[key]?.name)
          count += collection.clearRecords()
        } catch (error) {
          this.logger?.warn?.(`dsh-memory: cannot clear project ${key}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.state.stats.deleted += count
    this.audit({ op: 'clear', count })
    this.touchState()
    return { count }
  }

  /**
   * Find one record by id, optionally scoped to a project.
   * @param {string} id - record id.
   * @param {string | undefined} projectKey - optional project hint.
   * @returns {Record<string, any> | undefined}
   */
  findRecord(id, projectKey) {
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof projectKey === 'string' && projectKey !== '') {
      const entry = this.projects.get(resolve(projectKey))
      const collection = entry?.collection ?? this.ensureProjectCollection(projectKey, undefined)
      const found = collection.records.find(record => record.id === id)
      if (found !== undefined) return found
      // Project-scoped callers (the model tool) see global memory plus their own
      // project only; never leak another loaded project's records by id.
      return this.global?.records.find(record => record.id === id)
    }
    const globalRecord = this.global?.records.find(record => record.id === id)
    if (globalRecord !== undefined) return globalRecord
    for (const entry of this.projects.values()) {
      const found = entry.collection.records.find(record => record.id === id)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * @param {string} id - record id.
   * @param {{ projectKey?: string }} [options] - lookup hint.
   * @returns {Record<string, any> | undefined}
   */
  get(id, options = {}) {
    return this.findRecord(id, options.projectKey)
  }

  /**
   * Set the pinned flag on one record.
   * @param {string} id - record id.
   * @param {boolean} pinned - desired state.
   * @param {{ projectKey?: string }} [options] - lookup hint.
   * @returns {Record<string, any>}
   */
  setPinned(id, pinned, options = {}) {
    return this.update(id, { pinned: pinned === true }, { origin: 'manual', projectKey: options.projectKey }).record
  }

  /**
   * Structured list/search over loaded records.
   * @param {Record<string, any>} [options] - filters, see retrieval.searchRecords.
   * @returns {{ items: Record<string, any>[], total: number }}
   */
  list(options = {}) {
    return searchRecords(this.memories, options)
  }

  /**
   * Search loaded records.
   * @param {string} query - query text.
   * @param {Record<string, any>} [options] - additional filters.
   * @returns {Record<string, any>[]}
   */
  search(query, options = {}) {
    return this.list({ ...options, query }).items
  }

  /**
   * Render the prompt index from global plus one project collection.
   * @param {{ projectKey?: string }} [options] - current workspace key.
   * @returns {{ text: string, included: number, omitted: number }}
   */
  indexForPrompt(options = {}) {
    this.refreshIfStale()
    const settings = this.settings
    if (settings.enabled !== true) return { text: '', included: 0, omitted: 0 }
    const globalIndex = renderIndex(this.global?.activeRecords ?? [], {
      maxTopics: settings.maxTopicsInPrompt,
      maxChars: settings.maxIndexChars,
    })
    let projectIndex = { text: '', included: 0, omitted: 0 }
    let projectName = ''
    if (settings.projectsEnabled !== false && typeof options.projectKey === 'string' && options.projectKey !== '') {
      try {
        const collection = this.ensureProjectCollection(options.projectKey, undefined)
        projectName = collection.project?.name ?? basename(options.projectKey)
        projectIndex = renderIndex(collection.activeRecords, {
          maxTopics: settings.projectMaxTopicsInPrompt,
          maxChars: settings.projectMaxIndexChars,
        })
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: cannot load project memory: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const sections = []
    if (globalIndex.included > 0) {
      sections.push(['### Global memory', globalIndex.text].join('\n'))
      if (globalIndex.omitted > 0) sections.push(`(${globalIndex.omitted} more global topics — use memory search)`)
    }
    if (projectIndex.included > 0) {
      sections.push([`### Project memory — ${projectName}`, projectIndex.text].join('\n'))
      if (projectIndex.omitted > 0) sections.push(`(${projectIndex.omitted} more project topics — use memory search)`)
    }
    return {
      text: sections.join('\n\n'),
      included: globalIndex.included + projectIndex.included,
      omitted: globalIndex.omitted + projectIndex.omitted,
    }
  }

  /**
   * Compact index handed to the judge: global plus the current project.
   * @param {string | undefined} projectKey - current workspace key.
   * @param {number} [maxChars] - character budget.
   * @returns {string}
   */
  indexForJudge(projectKey, maxChars = 12000) {
    const lines = []
    const globalIndex = renderJudgeIndex(this.global?.records ?? [], Math.floor(maxChars / 2))
    if (globalIndex !== '') lines.push('Global topics:', globalIndex)
    if (typeof projectKey === 'string' && projectKey !== '') {
      try {
        const collection = this.ensureProjectCollection(projectKey, undefined)
        const projectIndex = renderJudgeIndex(collection.records, Math.floor(maxChars / 2))
        if (projectIndex !== '') lines.push(`Project topics (${collection.project?.name ?? basename(projectKey)}):`, projectIndex)
      } catch {
        // Missing project memory simply narrows the judge context.
      }
    }
    return lines.join('\n')
  }

  /**
   * Apply one judge result.
   * @param {Record<string, any>[]} operations - validated create/update operations.
   * @param {{ origin?: string, source?: Record<string, any> }} [meta] - provenance.
   * @returns {{
   *   created: Record<string, any>[], updated: Record<string, any>[],
   *   skipped: number, rejected: { op: string, id?: string, reason: string }[],
   * }}
   */
  applyOperations(operations, meta = {}) {
    const result = { created: [], updated: [], skipped: 0, rejected: [] }
    for (const operation of Array.isArray(operations) ? operations : []) {
      if (!isRecord(operation)) {
        result.rejected.push({ op: 'unknown', reason: 'operation must be an object' })
        continue
      }
      try {
        if (operation.op === 'create') {
          const created = this.create(operation, meta)
          if (created.action === 'created') result.created.push(created.record)
          else result.updated.push(created.record)
        } else if (operation.op === 'update') {
          const updated = this.update(String(operation.id ?? ''), operation.patch ?? operation, meta)
          result.updated.push(updated.record)
        } else if (operation.op === 'delete') {
          result.rejected.push({
            op: 'delete',
            id: operation.id,
            reason: 'automatic extraction never deletes memories',
          })
        } else if (operation.op === 'skip') {
          result.skipped += 1
        } else {
          result.rejected.push({ op: String(operation.op ?? ''), reason: 'unsupported operation' })
        }
      } catch (error) {
        result.rejected.push({
          op: String(operation.op ?? ''),
          id: typeof operation.id === 'string' ? operation.id : undefined,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return result
  }

  /**
   * Merge and validate a settings patch.
   * @param {Record<string, any>} patch - requested settings.
   * @returns {Record<string, any>} the live settings object.
   */
  setSettings(patch) {
    if (!isRecord(patch)) throw memoryError('invalid-request', 'settings patch must be an object')
    const known = new Set([...BOOLEAN_SETTING_KEYS, ...Object.keys(NUMBER_SETTING_BOUNDS), 'judgeProvider', 'judgeModel'])
    for (const key of Object.keys(patch)) {
      if (!known.has(key)) throw memoryError('invalid-request', `unknown setting "${key}"`)
      if (BOOLEAN_SETTING_KEYS.includes(key) && typeof patch[key] !== 'boolean') {
        throw memoryError('invalid-request', `setting "${key}" must be a boolean`)
      }
      if (Object.hasOwn(NUMBER_SETTING_BOUNDS, key)) {
        const [min, max] = NUMBER_SETTING_BOUNDS[key]
        const value = patch[key]
        if (!Number.isSafeInteger(value) || value < min || value > max) {
          throw memoryError('invalid-request', `setting "${key}" must be an integer between ${min} and ${max}`)
        }
      }
      if ((key === 'judgeProvider' || key === 'judgeModel') && typeof patch[key] !== 'string') {
        throw memoryError('invalid-request', `setting "${key}" must be a string`)
      }
    }
    this.state.settings = normalizeSettings({ ...this.settings, ...patch })
    this.audit({ op: 'settings', fields: Object.keys(patch) })
    this.touchState()
    return this.settings
  }

  /**
   * @param {string} sessionId - session identity.
   * @param {boolean} value - opt out of memory for this session.
   * @returns {void}
   */
  setSessionOptOut(sessionId, value) {
    if (!isSafeMapKey(sessionId)) throw memoryError('invalid-request', 'a sessionId is required')
    if (value === true) this.state.sessionOptOut[sessionId] = true
    else delete this.state.sessionOptOut[sessionId]
    this.touchState()
  }

  /**
   * @param {string} sessionId - session identity.
   * @returns {boolean}
   */
  isSessionOptOut(sessionId) {
    return isSafeMapKey(sessionId) && this.state.sessionOptOut[sessionId] === true
  }

  /**
   * @param {string} sessionId - session identity.
   * @returns {{ seq: number, at: string, chars: number } | undefined}
   */
  getWatermark(sessionId) {
    return isSafeMapKey(sessionId) ? this.state.watermarks[sessionId] : undefined
  }

  /**
   * Persist a new extraction watermark.
   * @param {string} sessionId - session identity.
   * @param {{ seq: number, chars?: number }} value - processed position.
   */
  setWatermark(sessionId, value) {
    if (!isSafeMapKey(sessionId)) return
    this.state.watermarks[sessionId] = {
      seq: Math.max(0, Number.isFinite(value.seq) ? Math.round(value.seq) : 0),
      at: new Date(this.now()).toISOString(),
      chars: Math.max(0, Number.isFinite(value.chars) ? Math.round(value.chars) : 0),
    }
    this.touchState()
  }

  /**
   * How many automatic judge runs this session had in the last hour.
   * @param {string} sessionId - session identity.
   * @returns {number}
   */
  runsInLastHour(sessionId) {
    const cutoff = this.now() - 60 * 60 * 1000
    return this.state.activity.filter(entry => entry.sessionId === sessionId
      && (entry.status === 'ok' || entry.status === 'error')
      && Date.parse(entry.at) >= cutoff).length
  }

  /**
   * Append one activity entry (most recent first, bounded).
   * @param {Record<string, any>} entry - activity record.
   */
  recordActivity(entry) {
    const at = new Date(this.now()).toISOString()
    const normalized = {
      at,
      trigger: entry.trigger ?? 'manual',
      status: entry.status ?? 'ok',
      created: Math.max(0, Number(entry.created ?? 0)),
      updated: Math.max(0, Number(entry.updated ?? 0)),
      skipped: Math.max(0, Number(entry.skipped ?? 0)),
      ...(entry.sessionId === undefined ? {} : { sessionId: String(entry.sessionId) }),
      ...(entry.sessionTitle === undefined ? {} : { sessionTitle: String(entry.sessionTitle).slice(0, LIMITS.sessionTitle) }),
      ...(entry.projectKey === undefined ? {} : { projectKey: String(entry.projectKey) }),
      ...(entry.reason === undefined ? {} : { reason: String(entry.reason).slice(0, 200) }),
      ...(entry.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(entry.durationMs)) }),
    }
    this.state.activity.unshift(normalized)
    if (this.state.activity.length > LIMITS.activity) this.state.activity.length = LIMITS.activity
    this.state.stats.runs += 1
    if (normalized.status === 'error') this.state.stats.errors += 1
    this.touchState()
  }

  /**
   * @param {number} [limit] - maximum entries.
   * @returns {Record<string, any>[]}
   */
  listActivity(limit = 20) {
    return this.state.activity.slice(0, Math.max(0, limit))
  }

  /**
   * Aggregate view for the settings page and `/memory status`.
   * @returns {Record<string, any>}
   */
  stats() {
    const aggregate = counts(this.memories)
    const lastUpdatedAt = this.memories.reduce(
      (latest, record) => (String(record.updatedAt) > latest ? String(record.updatedAt) : latest),
      '',
    )
    return {
      ...aggregate,
      lastUpdatedAt: lastUpdatedAt === '' ? null : lastUpdatedAt,
      paused: this.settings.enabled !== true,
      activity: this.listActivity(20),
      stateStats: { ...this.state.stats },
      projectCount: Object.keys(this.state.projects).length,
      loadedProjects: this.projects.size,
      watchingProjects: [...this.projects.values()].filter(entry => entry.collection.watching).length,
    }
  }

  /**
   * Present one record without its body (settings-page list payload).
   * @param {Record<string, any>} record - full record.
   * @returns {Record<string, any>}
   */
  toListItem(record) {
    const collection = this.collectionOf(record)
    const filename = collection?.files.get(record.id)
    return {
      id: record.id,
      title: record.title,
      summary: record.summary,
      kind: record.kind,
      scope: record.scope,
      project: record.project,
      projectKey: record.project?.key ?? null,
      memoryDir: record.scope === 'project'
        ? join(resolve(record.project?.key ?? ''), PROJECT_MEMORY_DIR)
        : this.stateStore.root,
      file: filename ?? null,
      tags: record.tags,
      importance: record.importance,
      pinned: record.pinned,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
      source: record.source,
      projectLabel: projectLabel(record.project),
      scopeLabel: scopeLabel(record),
    }
  }

  /**
   * Resolve a workspace reference for callers that only have a cwd.
   * @param {string | undefined} cwd - session working directory.
   * @returns {{ key: string, name: string } | undefined}
   */
  projectFor(cwd) {
    const workspace = resolveWorkspace(cwd)
    return workspace === undefined ? undefined : { key: workspace.key, name: workspace.name }
  }

  /**
   * Describe known projects for the settings page.
   * @returns {Record<string, any>[]}
   */
  describeProjects() {
    const keys = new Set([...Object.keys(this.state.projects), ...this.projects.keys()])
    const result = []
    for (const key of keys) {
      const entry = this.projects.get(key)
      const registry = this.state.projects[key]
      const collection = entry?.collection
      const aggregate = collection === undefined ? undefined : counts(collection.records)
      result.push({
        key,
        name: registry?.name ?? collection?.project?.name ?? basename(key),
        memoryDir: registry?.memoryDir ?? join(key, PROJECT_MEMORY_DIR),
        loaded: collection !== undefined,
        watching: collection?.watching === true,
        counts: aggregate ?? { total: 0, active: 0, archived: 0, global: 0, project: 0, pinned: 0 },
        error: registry?.error,
      })
    }
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Archive the lowest-value active records in one collection when it exceeds
   * its cap.
   * @param {TopicCollection} collection - target collection.
   * @returns {number} number archived.
   */
  enforceQuota(collection) {
    const active = collection.records.filter(record => record.status === 'active')
    if (active.length <= MAX_ACTIVE_RECORDS) return 0
    const candidates = active
      .filter(record => !record.pinned)
      .sort((left, right) => left.importance - right.importance
        || String(left.updatedAt).localeCompare(String(right.updatedAt)))
    let archived = 0
    for (const record of candidates) {
      if (active.length - archived <= MAX_ACTIVE_RECORDS) break
      record.status = 'archived'
      record.updatedAt = new Date(this.now()).toISOString()
      collection.writeRecord(record, { notify: false })
      archived += 1
      this.audit({ op: 'archive', scope: record.scope, project: record.project?.key, id: record.id, title: record.title })
    }
    if (archived > 0) this.touchState()
    return archived
  }

  /**
   * Stop watchers and release collections.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    this.global?.dispose()
    for (const entry of this.projects.values()) entry.collection.dispose()
    this.projects.clear()
    this.listeners.clear()
  }

}

/**
 * Build the v2 operational state from a normalized v1 document.
 * @param {Record<string, any>} legacy - normalized legacy state.
 * @returns {Record<string, any>}
 */
function stateFromLegacy(legacy) {
  return {
    ...defaultState(),
    settings: legacy.settings,
    watermarks: legacy.watermarks,
    sessionOptOut: legacy.sessionOptOut,
    activity: legacy.activity,
    stats: { ...defaultState().stats, ...legacy.stats, migrated: 0 },
    projects: {},
  }
}
