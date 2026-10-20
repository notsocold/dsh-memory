/**
 * In-memory memory library backed by {@link StateStore}.
 *
 * The store owns memory CRUD, deterministic de-duplication, quota/archival
 * behavior, memory-index rendering, extraction watermarks, per-session
 * opt-out, activity journaling and the read-only Markdown mirror.
 *
 * Writes update the in-memory document synchronously, then persist
 * asynchronously in a serialized chain; a failed write keeps the document
 * dirty so the next mutation (or {@link MemoryStore.flush}) retries it.
 *
 * @module dsh-memory/lib/store
 */

import {
  BOOLEAN_SETTING_KEYS,
  LIMITS,
  MEMORY_ID_PATTERN,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  NUMBER_SETTING_BOUNDS,
  isRecord,
  isSafeMapKey,
  memoryError,
  mintMemoryId,
  normalizeSettings,
} from './state.js'
import {
  contentHash,
  counts,
  filterForProject,
  normalizeTitle,
  renderIndex,
  renderJudgeIndex,
  scopeLabel,
  searchRecords,
  similarity,
  sortForPrompt,
} from './retrieval.js'
import { projectLabel, resolveProject } from './project.js'
import { sanitizeText } from './privacy.js'

/** Similarity threshold above which a new topic is treated as a duplicate. */
export const MERGE_SIMILARITY = 0.85

/** Maximum number of active records before low-value records are archived. */
export const MAX_ACTIVE_RECORDS = 500

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
 * @param {unknown} value - raw project reference.
 * @returns {{ key: string, name: string } | null}
 */
function normalizeProjectRef(value) {
  if (!isRecord(value)) return null
  const key = typeof value.key === 'string' ? value.key.trim() : ''
  if (key === '') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : key
  return { key, name }
}

/**
 * Build one normalized memory record.
 * @param {Record<string, any>} input - create/update input.
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
 * Render the read-only Markdown mirror for one state document.
 * @param {Record<string, any>} state - state document.
 * @returns {string}
 */
export function renderMirror(state) {
  const records = Array.isArray(state.memories) ? state.memories : []
  const active = records.filter(record => record.status === 'active')
  const archived = records.length - active.length
  const aggregate = counts(records)
  const groups = new Map()
  for (const record of sortForPrompt(active)) {
    const key = record.scope === 'project'
      ? `project:${record.project?.key ?? ''}`
      : 'global'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  const lines = [
    '# dsh-memory',
    '',
    '> Auto-generated mirror of `$DSH_HOME/dsh-memory/memory.json`.',
    '> Edit memories in **Settings → Memory**; manual edits here are overwritten.',
    '',
    `- Updated: ${new Date().toISOString()}`,
    `- Active topics: ${aggregate.active} (${aggregate.global} global, ${aggregate.project} project)`,
    `- Archived topics: ${archived}`,
  ]
  for (const [key, group] of groups) {
    const heading = key === 'global'
      ? '## Global'
      : `## Project: ${group[0]?.project?.name ?? key.slice('project:'.length)}`
    lines.push('', heading, '')
    for (const record of group) {
      lines.push(
        `### ${record.title}`,
        '',
        `- id: \`${record.id}\` · kind: \`${record.kind}\` · scope: \`${scopeLabel(record)}\` · importance: ${record.importance}${record.pinned ? ' · pinned' : ''}`,
        `- updated: ${record.updatedAt} · revision: ${record.revision} · tags: ${record.tags.length === 0 ? '(none)' : record.tags.join(', ')}`,
        '',
        record.summary,
        '',
        record.content,
        '',
      )
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Owns the memory library and its persistence.
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
    this.dirty = false
    /** @type {Promise<void> | null} */
    this.writeChain = null
    /** @type {Promise<void> | null} */
    this.mirrorChain = null
  }

  /** @returns {Record<string, any>} live state document. */
  get state() {
    return this.stateStore.state
  }

  /** @returns {Record<string, any>} live settings object. */
  get settings() {
    return this.state.settings
  }

  /** @returns {Record<string, any>[]} live memory records. */
  get memories() {
    return this.state.memories
  }

  /**
   * Load persisted state and normalize it.
   * @returns {Promise<void>}
   */
  async load() {
    await this.stateStore.load()
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

  /** Notify listeners without failing the mutation that triggered them. */
  emitChange() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: change listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Mark the document dirty and start the serialized persistence chain.
   * @param {{ mirror?: boolean }} [options] - also refresh the Markdown mirror.
   */
  touch(options = {}) {
    this.dirty = true
    if (options.mirror !== false) this.scheduleMirror()
    if (this.writeChain === null) {
      this.writeChain = this.drainWrites()
    }
    this.emitChange()
  }

  /** @returns {Promise<void>} resolves when the current write chain settles. */
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

  /** @returns {Promise<void>} wait for pending writes (state, mirror, audit). */
  async flush() {
    if (this.writeChain !== null) await this.writeChain
    if (this.dirty && this.writeChain === null) {
      this.writeChain = this.drainWrites()
      await this.writeChain
    }
    if (this.mirrorChain !== null) await this.mirrorChain
  }

  /** Schedule one Markdown mirror rewrite, serialized after previous writes. */
  scheduleMirror() {
    const body = renderMirror(this.state)
    this.mirrorChain = (this.mirrorChain ?? Promise.resolve())
      .then(() => this.stateStore.writeMirror(body))
      .catch(() => {})
  }

  /**
   * Append one audit line (best effort, ordered after previous mirror work is
   * irrelevant because the journal is append-only).
   * @param {Record<string, any>} entry - audit entry.
   */
  audit(entry) {
    void this.stateStore.appendAudit({ at: new Date(this.now()).toISOString(), ...entry })
  }

  /**
   * Mint a record id that is not in use.
   * @returns {string}
   */
  nextId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.mintId()
      if (MEMORY_ID_PATTERN.test(id) && !this.memories.some(record => record.id === id)) return id
    }
    throw memoryError('internal', 'cannot mint a unique memory id')
  }

  /**
   * Find an existing record that a new topic should merge into.
   * @param {{ title: string, content: string, summary?: string, scope: string,
   *   project: { key: string } | null, kind: string }} input - candidate topic.
   * @returns {Record<string, any> | undefined}
   */
  findDuplicate(input) {
    const normalizedTitle = normalizeTitle(input.title)
    const hash = contentHash(input.content)
    const sameScope = record => record.scope === input.scope
      && (input.scope !== 'project' || record.project?.key === input.project?.key)
    for (const record of this.memories) {
      if (record.status !== 'active' || !sameScope(record)) continue
      if (normalizeTitle(record.title) === normalizedTitle) return record
      if (contentHash(record.content) === hash) return record
    }
    const probe = `${input.title} ${input.summary ?? ''}`
    let best
    let bestScore = MERGE_SIMILARITY
    for (const record of this.memories) {
      if (record.status !== 'active' || !sameScope(record) || record.kind !== input.kind) continue
      const score = similarity(probe, `${record.title} ${record.summary}`)
      if (score >= bestScore) {
        best = record
        bestScore = score
      }
    }
    return best
  }

  /**
   * Create a memory topic, merging into an equivalent existing topic.
   * @param {Record<string, any>} input - create input.
   * @param {{ origin?: string, source?: Record<string, any> }} [meta] - provenance.
   * @returns {{ action: 'created' | 'merged', record: Record<string, any> }}
   */
  create(input, meta = {}) {
    if (!isRecord(input)) throw memoryError('invalid-request', 'memory input must be an object')
    const origin = MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'manual'
    const id = this.nextId()
    const nowIso = new Date(this.now()).toISOString()
    const candidate = buildRecord(input, {
      id,
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1,
      origin,
      source: meta.source ?? {},
    })
    const duplicate = this.findDuplicate(candidate)
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
      }, { origin })
      return { action: 'merged', record: updated.record }
    }
    this.memories.push(candidate)
    this.state.stats.created += 1
    this.audit({ op: 'create', id: candidate.id, title: candidate.title, origin, sessionId: meta.source?.sessionId })
    this.enforceQuota()
    this.touch()
    return { action: 'created', record: candidate }
  }

  /**
   * Update one record. Unknown ids throw `not-found`.
   * @param {string} id - record id.
   * @param {Record<string, any>} patch - field changes.
   * @param {{ origin?: string, source?: Record<string, any> }} [meta] - provenance.
   * @returns {{ action: 'updated', record: Record<string, any> }}
   */
  update(id, patch, meta = {}) {
    const record = this.get(id)
    if (record === undefined) throw memoryError('not-found', `unknown memory "${id}"`)
    const { changes, fields } = buildPatch(record, patch)
    for (const field of fields) record[field] = changes[field]
    if (changes.scope === 'global') record.project = null
    record.updatedAt = new Date(this.now()).toISOString()
    record.revision += 1
    if (MEMORY_ORIGINS.includes(meta.origin)) record.source = { ...record.source, origin: meta.origin }
    if (meta.source?.sessionId !== undefined) record.source.sessionId = String(meta.source.sessionId)
    if (meta.source?.sessionTitle !== undefined) record.source.sessionTitle = String(meta.source.sessionTitle)
    this.state.stats.updated += 1
    this.audit({
      op: 'update',
      id: record.id,
      title: record.title,
      origin: record.source.origin,
      fields,
      revision: record.revision,
      sessionId: meta.source?.sessionId ?? record.source.sessionId,
    })
    this.touch()
    return { action: 'updated', record }
  }

  /**
   * Delete one record. The only deletion path besides user clear/reset.
   * @param {string} id - record id.
   * @param {{ origin?: string }} [meta] - provenance.
   * @returns {{ action: 'deleted', record: Record<string, any> }}
   */
  remove(id, meta = {}) {
    const index = this.memories.findIndex(record => record.id === id)
    if (index < 0) throw memoryError('not-found', `unknown memory "${id}"`)
    const [record] = this.memories.splice(index, 1)
    this.state.stats.deleted += 1
    this.audit({
      op: 'delete',
      id: record.id,
      title: record.title,
      origin: MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'manual',
      sessionId: record.source?.sessionId,
    })
    this.touch()
    return { action: 'deleted', record }
  }

  /**
   * Delete every memory record, keeping settings, watermarks and activity.
   * @returns {{ count: number }}
   */
  clear() {
    const count = this.memories.length
    this.state.memories = []
    this.state.stats.deleted += count
    this.audit({ op: 'clear', count })
    this.touch()
    return { count }
  }

  /**
   * @param {string} id - record id.
   * @returns {Record<string, any> | undefined}
   */
  get(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return this.memories.find(record => record.id === id)
  }

  /**
   * Set the pinned flag on one record.
   * @param {string} id - record id.
   * @param {boolean} pinned - desired state.
   * @returns {Record<string, any>}
   */
  setPinned(id, pinned) {
    return this.update(id, { pinned: pinned === true }, { origin: 'manual' }).record
  }

  /**
   * Structured list/search over records.
   * @param {Record<string, any>} [options] - filters, see retrieval.searchRecords.
   * @returns {{ items: Record<string, any>[], total: number }}
   */
  list(options = {}) {
    return searchRecords(this.memories, options)
  }

  /**
   * Search records and return full records.
   * @param {string} query - query text.
   * @param {Record<string, any>} [options] - additional filters.
   * @returns {Record<string, any>[]}
   */
  search(query, options = {}) {
    return this.list({ ...options, query }).items
  }

  /**
   * Index injected into the model prompt for one project scope.
   * @param {{ projectKey?: string, maxTopics?: number, maxChars?: number }} [options] - scope and budget.
   * @returns {{ text: string, included: number, omitted: number }}
   */
  indexForPrompt(options = {}) {
    const settings = this.settings
    const visible = filterForProject(this.memories, options.projectKey, {
      projectsEnabled: settings.projectsEnabled,
    })
    return renderIndex(visible, {
      maxTopics: options.maxTopics ?? settings.maxTopicsInPrompt,
      maxChars: options.maxChars ?? settings.maxIndexChars,
    })
  }

  /**
   * Compact index handed to the judge, including archived exclusions.
   * @param {number} [maxChars] - character budget.
   * @returns {string}
   */
  indexForJudge(maxChars = 8000) {
    return renderJudgeIndex(this.memories, maxChars)
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
    this.touch({ mirror: false })
    return this.settings
  }

  /**
   * @param {string} sessionId - session identity.
   * @param {boolean} value - opt out of memory for this session.
   * @returns {void}
   */
  setSessionOptOut(sessionId, value) {
    if (!isSafeMapKey(sessionId)) {
      throw memoryError('invalid-request', 'a sessionId is required')
    }
    if (value === true) this.state.sessionOptOut[sessionId] = true
    else delete this.state.sessionOptOut[sessionId]
    this.touch({ mirror: false })
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
    this.touch({ mirror: false })
  }

  /**
   * How many automatic runs this session had in the last hour.
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
      ...(entry.reason === undefined ? {} : { reason: String(entry.reason).slice(0, 200) }),
      ...(entry.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(entry.durationMs)) }),
    }
    this.state.activity.unshift(normalized)
    if (this.state.activity.length > LIMITS.activity) this.state.activity.length = LIMITS.activity
    this.state.stats.runs += 1
    if (normalized.status === 'error') this.state.stats.errors += 1
    this.touch({ mirror: false })
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
      projectCount: new Set(this.memories
        .filter(record => record.scope === 'project')
        .map(record => record.project?.key)
        .filter(key => typeof key === 'string')).size,
    }
  }

  /**
   * Archive the lowest-value active records when the library exceeds its cap.
   * @returns {number} number of archived records.
   */
  enforceQuota() {
    const active = this.memories.filter(record => record.status === 'active')
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
      archived += 1
      this.audit({ op: 'archive', id: record.id, title: record.title })
    }
    return archived
  }

  /**
   * Present one record without its body (settings-page list payload).
   * @param {Record<string, any>} record - full record.
   * @returns {Record<string, any>}
   */
  toListItem(record) {
    return {
      id: record.id,
      title: record.title,
      summary: record.summary,
      kind: record.kind,
      scope: record.scope,
      project: record.project,
      tags: record.tags,
      importance: record.importance,
      pinned: record.pinned,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
      source: record.source,
      projectLabel: projectLabel(record.project),
    }
  }

  /**
   * Resolve a project reference for callers that only have a cwd.
   * @param {string | undefined} cwd - session working directory.
   * @returns {{ key: string, name: string } | undefined}
   */
  projectFor(cwd) {
    const project = resolveProject(cwd)
    return project === undefined ? undefined : { key: project.key, name: project.name }
  }

}
