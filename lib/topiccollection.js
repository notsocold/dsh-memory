/**
 * One directory of Markdown memory topics, with a generated `MEMORY.md`
 * index and optional filesystem monitoring.
 *
 * A collection is the unit of storage:
 *  - the global collection lives at `$DSH_HOME/dsh-memory/`;
 *  - a project collection lives at `{workspace}/.dsh/dsh-memory/`.
 *
 * Topic files are authoritative; the index is regenerated from them. External
 * edits are detected by a directory watcher (debounced) and by an mtime/size
 * signature fallback, then folded into memory on the next refresh.
 *
 * @module dsh-memory/lib/topiccollection
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, watch, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  renderMemoryIndex,
  renderTopicFile,
  recordFromTopicFile,
  topicFilename,
} from './frontmatter.js'

/** Generated index file name. */
export const INDEX_FILE = 'MEMORY.md'

/** Maximum number of topic files scanned in one directory. */
export const MAX_TOPIC_FILES = 1000

/** Maximum size of one topic file read from disk. */
export const MAX_TOPIC_FILE_BYTES = 262144

/** Debounce window for filesystem notifications. */
export const WATCH_DEBOUNCE_MS = 300

/** Monotonic temp-file counter (same process, separate collections). */
let tempCounter = 0

/**
 * Write one file atomically inside its directory.
 * @param {string} path - target path.
 * @param {string} body - UTF-8 content.
 */
export function writeFileAtomicSync(path, body) {
  tempCounter += 1
  const temp = `${path}.${process.pid}.${tempCounter}.tmp`
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, body)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Best-effort temp cleanup.
    }
    throw error
  }
}

/**
 * One directory-backed memory collection.
 */
export class TopicCollection {
  /**
   * @param {{
   *   dir: string,
   *   scope: 'global' | 'project',
   *   project?: { key: string, name: string } | null,
   *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
   *   now?: () => number,
   *   watchDebounceMs?: number,
   * }} options - collection identity and dependencies.
   */
  constructor(options) {
    this.dir = options.dir
    this.scope = options.scope
    this.project = options.project ?? null
    this.logger = options.logger
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.watchDebounceMs = Number.isFinite(options.watchDebounceMs)
      ? Math.max(50, Number(options.watchDebounceMs))
      : WATCH_DEBOUNCE_MS
    /** @type {Record<string, any>[]} */
    this.records = []
    /** @type {Map<string, string>} */
    this.files = new Map()
    /** @type {Map<string, string>} */
    this.signatures = new Map()
    /** @type {string[]} */
    this.diagnostics = []
    this.loaded = false
    this.signatureKey = ''
    /** @type {import('node:fs').FSWatcher | null} */
    this.watcher = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.refreshTimer = null
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** @returns {boolean} whether the collection directory exists. */
  get exists() {
    return existsSync(this.dir)
  }

  /** @returns {Record<string, any>[]} records with status active. */
  get activeRecords() {
    return this.records.filter(record => record.status === 'active')
  }

  /**
   * Register a change listener.
   * @param {() => void} listener - called after records changed.
   * @returns {() => void} disposer.
   */
  onChange(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify listeners without failing the refresh that triggered them. */
  emitChange() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: collection listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Create the directory when a write needs it. */
  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Load the directory synchronously.
   * @param {{ watch?: boolean }} [options] - start monitoring when true.
   * @returns {TopicCollection}
   */
  loadSync(options = {}) {
    if (options.watch === true) this.startWatch()
    this.refreshSync({ regenerateIndex: false, forceLoad: true })
    this.loaded = true
    return this
  }

  /**
   * Rescan the directory and merge changed/removed topic files.
   * @param {{
   *   regenerateIndex?: boolean,
   *   forceLoad?: boolean,
   *   forceReload?: boolean,
   *   notify?: boolean,
   * }} [options] - refresh behavior.
   * @returns {boolean} whether records changed.
   */
  refreshSync(options = {}) {
    if (!this.loaded && options.forceLoad !== true) this.loaded = true
    const regenerateIndex = options.regenerateIndex !== false
    const before = this.signatureKey
    /** @type {Record<string, any>[]} */
    const records = []
    const files = new Map()
    const signatures = new Map()
    const diagnostics = []
    if (!existsSync(this.dir)) {
      this.records = []
      this.files = files
      this.signatures = signatures
      this.diagnostics = diagnostics
      this.signatureKey = ''
      if (before !== '') {
        if (regenerateIndex) this.regenerateIndex()
        if (options.notify !== false) this.emitChange()
        return true
      }
      return false
    }
    let entries = []
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
    } catch (error) {
      diagnostics.push(`cannot read ${this.dir}: ${error instanceof Error ? error.message : String(error)}`)
      this.diagnostics = diagnostics
      return false
    }
    const candidates = entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink()
        && entry.name.endsWith('.md')
        && entry.name !== INDEX_FILE
        && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
    const capped = candidates.slice(0, MAX_TOPIC_FILES)
    if (candidates.length > capped.length) {
      diagnostics.push(`${candidates.length - capped.length} topic file(s) beyond the ${MAX_TOPIC_FILES}-file cap were ignored`)
    }
    for (const filename of capped) {
      const path = join(this.dir, filename)
      let stat
      try {
        stat = statSync(path, { bigint: true })
      } catch (error) {
        diagnostics.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const size = Number(stat.size)
      if (size > MAX_TOPIC_FILE_BYTES) {
        diagnostics.push(`${filename}: larger than ${MAX_TOPIC_FILE_BYTES} bytes; skipped`)
        continue
      }
      const signature = `${stat.mtimeNs}:${stat.size}`
      const cachedRecord = this.records.find(record => this.files.get(record.id) === filename)
      const cachedSignature = this.signatures.get(filename)
      if (options.forceReload !== true && cachedRecord !== undefined && cachedSignature === signature) {
        if (!files.has(cachedRecord.id)) {
          files.set(cachedRecord.id, filename)
          signatures.set(filename, signature)
          records.push(cachedRecord)
        }
        continue
      }
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        diagnostics.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const parsed = recordFromTopicFile({
        text,
        filename,
        scope: this.scope,
        project: this.project,
        mtimeMs: Number(stat.mtimeNs / 1000000n),
        now: this.now(),
      })
      if (parsed.record === undefined) {
        diagnostics.push(`${filename}: ${parsed.error ?? 'invalid topic'}`)
        continue
      }
      if (files.has(parsed.record.id)) {
        diagnostics.push(`${filename}: duplicate memory id ${parsed.record.id}; skipped`)
        continue
      }
      files.set(parsed.record.id, filename)
      signatures.set(filename, signature)
      records.push(parsed.record)
    }
    this.records = records
    this.files = files
    this.signatures = signatures
    this.diagnostics = diagnostics
    this.signatureKey = signatureKeyOf(signatures)
    const changed = before !== this.signatureKey
    // The index is generated: repair manual edits or stale summaries even when
    // the topic files themselves did not change.
    if (regenerateIndex) this.regenerateIndex()
    if (changed && options.notify !== false) this.emitChange()
    return changed
  }

  /**
   * Write (or replace) one record's topic file.
   * @param {Record<string, any>} record - normalized memory record.
   * @param {{ notify?: boolean }} [options] - change notification switch.
   * @returns {string} the written file name.
   */
  writeRecord(record, options = {}) {
    this.ensureDir()
    const filename = this.files.get(record.id) ?? topicFilename(record)
    const path = join(this.dir, filename)
    writeFileAtomicSync(path, renderTopicFile(record, record.updatedAt))
    let stat
    try {
      stat = statSync(path, { bigint: true })
    } catch {
      stat = undefined
    }
    const signature = stat === undefined ? `${this.now()}:${record.content.length}` : `${stat.mtimeNs}:${stat.size}`
    this.signatures.set(filename, signature)
    const existingIndex = this.records.findIndex(item => item.id === record.id)
    if (existingIndex >= 0) this.records[existingIndex] = record
    else this.records.push(record)
    this.files.set(record.id, filename)
    this.signatureKey = signatureKeyOf(this.signatures)
    this.regenerateIndex()
    if (options.notify !== false) this.emitChange()
    return filename
  }

  /**
   * Delete one topic file and drop the record.
   * @param {string} id - memory id.
   * @returns {boolean} whether a file was removed.
   */
  removeRecord(id) {
    const filename = this.files.get(id)
    this.files.delete(id)
    this.records = this.records.filter(record => record.id !== id)
    let removed = false
    if (filename !== undefined) {
      this.signatures.delete(filename)
      try {
        unlinkSync(join(this.dir, filename))
        removed = true
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger?.warn?.(`dsh-memory: cannot delete ${filename}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.signatureKey = signatureKeyOf(this.signatures)
    this.regenerateIndex()
    this.emitChange()
    return removed
  }

  /**
   * Delete every managed topic file in this collection.
   * @returns {number} number of removed files.
   */
  clearRecords() {
    let removed = 0
    for (const filename of this.files.values()) {
      try {
        unlinkSync(join(this.dir, filename))
        removed += 1
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger?.warn?.(`dsh-memory: cannot delete ${filename}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.records = []
    this.files.clear()
    this.signatures.clear()
    this.signatureKey = ''
    this.regenerateIndex()
    this.emitChange()
    return removed
  }

  /**
   * Regenerate `MEMORY.md` from the current records.
   * @param {{ force?: boolean }} [options] - write even when content is unchanged.
   * @returns {boolean} whether the index was rewritten.
   */
  regenerateIndex(options = {}) {
    if (!existsSync(this.dir)) return false
    const body = renderMemoryIndex(this.records, {
      scope: this.scope,
      project: this.project,
      now: this.now(),
    })
    const path = join(this.dir, INDEX_FILE)
    if (options.force !== true && existsSync(path)) {
      try {
        if (readFileSync(path, 'utf8') === body) return false
      } catch {
        // Fall through to rewrite.
      }
    }
    writeFileAtomicSync(path, body)
    return true
  }

  /** Start the debounced directory watcher when possible. */
  startWatch() {
    if (this.watcher !== null) return
    if (!existsSync(this.dir)) return
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => {
        this.scheduleRefresh()
      })
      this.watcher.on?.('error', (error) => {
        this.logger?.warn?.(`dsh-memory: watcher failed for ${this.dir}: ${error instanceof Error ? error.message : String(error)}`)
        this.stopWatch()
      })
    } catch (error) {
      this.logger?.warn?.(`dsh-memory: cannot watch ${this.dir}: ${error instanceof Error ? error.message : String(error)}`)
      this.watcher = null
    }
  }

  /** Stop the directory watcher. */
  stopWatch() {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close()
      } catch {
        // Already closed.
      }
      this.watcher = null
    }
  }

  /** @returns {boolean} whether the collection is currently watched. */
  get watching() {
    return this.watcher !== null
  }

  /** Schedule one debounced refresh. */
  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      try {
        this.refreshSync({ regenerateIndex: true, forceReload: true })
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: refresh failed for ${this.dir}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, this.watchDebounceMs)
    if (typeof this.refreshTimer?.unref === 'function') this.refreshTimer.unref()
  }

  /** Stop monitoring and drop listeners. */
  dispose() {
    this.stopWatch()
    this.listeners.clear()
  }
}

/**
 * @param {Map<string, string>} signatures - file signatures.
 * @returns {string} stable signature key.
 */
function signatureKeyOf(signatures) {
  return [...signatures.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, signature]) => `${name}=${signature}`)
    .join('|')
}
