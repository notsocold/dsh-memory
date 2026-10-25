/**
 * Extraction scheduler.
 *
 * Trigger model (Claude-style continuous saving with session boundaries):
 *  - after each turn the agent becomes idle; a `quietSeconds` debounce batches
 *    short follow-ups and then extracts the new span;
 *  - a session that starts while other sessions sit idle triggers their
 *    boundary extraction (a fresh conversation usually means the previous one
 *    ended);
 *  - a disposed/deleted session is snapshotted synchronously and queued;
 *  - manual extraction (`memory` tool, `/memory extract`, settings page) runs
 *    immediately.
 *
 * Every automatic failure is journaled and never surfaces in the conversation.
 * A per-session FIFO dedupe and a global concurrency of one keep model spend
 * bounded; watermarks advance only after a successful judge round.
 *
 * @module dsh-memory/lib/extractor
 */

import { memoryError } from './state.js'
import { runJudge as defaultRunJudge } from './judge.js'
import { buildExtractionInput, snapshotSession } from './transcript.js'

/** Per-call judge timeout, in milliseconds. */
export const JUDGE_TIMEOUT_MS = 60_000

/** Hard cap on queued jobs; beyond it the oldest automatic job is dropped. */
export const MAX_QUEUED_JOBS = 8

/** Grace period for treating a session as newly created rather than historical. */
export const NEW_SESSION_GRACE_MS = 5_000

/**
 * @param {any} agent - live DSH agent.
 * @returns {string} session id.
 */
function sessionIdOf(agent) {
  return String(agent?.id ?? agent?.session?.id ?? '')
}

/**
 * @param {any} session - DSH session.
 * @returns {boolean} whether automatic extraction must skip this session.
 */
function isRootSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return true
  if (header.origin === 'subagent') return false
  const depth = Number(header.delegationDepth ?? 0)
  return !(Number.isFinite(depth) && depth > 0)
}

/**
 * @param {unknown} value - timestamp value.
 * @returns {number | undefined} epoch milliseconds.
 */
function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * @param {any} session - session or snapshot.
 * @returns {number | undefined} session creation time.
 */
function sessionCreatedAt(session) {
  return timestampOf(session?.header?.createdAt ?? session?.createdAt)
}

/** Extraction scheduler. */
export class Extractor {
  /**
   * @param {{
   *   ctx: any,
   *   store: import('./store.js').MemoryStore,
   *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
   *   judge?: (input: Record<string, any>) => Promise<Record<string, any>>,
   *   now?: () => number,
   *   setTimeout?: typeof setTimeout,
   *   clearTimeout?: typeof clearTimeout,
   *   judgeTimeoutMs?: number,
   * }} options - injected dependencies.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.store = options.store
    this.logger = options.logger
    this.judge = typeof options.judge === 'function' ? options.judge : defaultRunJudge
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.setTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
    this.clearTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
    this.judgeTimeoutMs = Number.isFinite(options.judgeTimeoutMs) ? Number(options.judgeTimeoutMs) : JUDGE_TIMEOUT_MS
    this.startedAt = this.now()
    /** @type {Map<string, any>} */
    this.timers = new Map()
    /** @type {Record<string, any>[]} */
    this.queue = []
    /** @type {Record<string, any> | null} */
    this.active = null
    /** @type {Promise<void> | null} */
    this.pumpPromise = null
    /** @type {AbortController | null} */
    this.activeController = null
    this.disposed = false
  }

  /**
   * Schedule the initial sweep for sessions that predate the plugin load.
   * @returns {Promise<void>}
   */
  async start() {
    let agents = []
    try {
      agents = this.ctx?.agents?.list?.() ?? []
    } catch (error) {
      this.logger?.warn?.(`dsh-memory: cannot enumerate live agents: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const agent of agents) {
      this.observeAgent(agent)
      if (this.hasPending(agent)) this.schedule(agent, 2, 'boundary')
    }
  }

  /**
   * Whether a session predates this plugin process. Such sessions may have
   * been imported from another machine; their event history must not be judged
   * automatically by default.
   * @param {any} session - session or snapshot.
   * @returns {boolean}
   */
  isHistoricalSession(session) {
    if (this.store.settings.autoExtractExistingSessions === true) return false
    const created = sessionCreatedAt(session)
    // A missing creation time is treated conservatively as historical.
    if (created === undefined) return true
    return created < this.startedAt - NEW_SESSION_GRACE_MS
  }

  /**
   * Latest event sequence of a historical session. The baseline skips the
   * entire pre-existing span; only events appended after discovery are judged
   * automatically.
   * @param {any} session - session or snapshot.
   * @returns {number} latest seq (`-1` for an empty session).
   */
  baselineSeqOf(session) {
    const events = Array.isArray(session?.events)
      ? session.events
      : (() => {
          try {
            return session?.snapshotEvents?.() ?? []
          } catch {
            return []
          }
        })()
    if (events.length === 0) return -1
    let seq = -1
    for (const event of events) {
      const eventSeq = Number(event?.seq)
      if (Number.isFinite(eventSeq)) seq = Math.max(seq, eventSeq)
    }
    return seq >= 0 ? seq : events.length - 1
  }

  /**
   * Seed a baseline watermark for a historical session, so only events after
   * this plugin process started can be auto-judged. The watermark is marked so
   * manual Extract now can deliberately process from the beginning.
   * @param {any} session - session or snapshot.
   * @param {string} sessionId - session id.
   * @returns {Record<string, any> | undefined} existing/seeded watermark.
   */
  ensureBaseline(session, sessionId) {
    const existing = this.store.getWatermark(sessionId)
    if (existing !== undefined) return existing
    if (!this.isHistoricalSession(session)) return undefined
    const seq = this.baselineSeqOf(session)
    this.store.setWatermark(sessionId, { seq, chars: 0, baseline: true })
    return this.store.getWatermark(sessionId)
  }

  /**
   * Record a session as observed. Historical/imported sessions are baselined at
   * discovery time (before any later user messages), so only events appended
   * after discovery can be auto-judged.
   * @param {any} agent - live agent (or minimal `{ session }` object).
   */
  observeAgent(agent) {
    if (this.disposed) return
    try {
      const session = agent?.session
      if (session === undefined || !isRootSession(session)) return
      const sessionId = String(agent?.id ?? session?.id ?? '')
      if (sessionId === '' || this.store.isSessionOptOut(sessionId)) return
      if (this.store.getWatermark(sessionId) !== undefined) return
      if (this.isHistoricalSession(session)) this.ensureBaseline(session, sessionId)
    } catch {
      // Observation is best effort; hasPending will retry.
    }
  }

  /**
   * @param {any} agent - live agent.
   * @returns {boolean} whether the session has events after the last watermark.
   */
  hasPending(agent) {
    try {
      const session = agent?.session
      if (session === undefined || !isRootSession(session)) return false
      const sessionId = sessionIdOf(agent)
      if (sessionId === '') return false
      if (this.store.isSessionOptOut(sessionId)) return false
      let watermark = this.store.getWatermark(sessionId)
      if (watermark === undefined) watermark = this.ensureBaseline(session, sessionId)
      // `session.seq` is the next event position, so the last stored event is seq - 1.
      const watermarkSeq = watermark === undefined ? -1 : watermark.seq
      return Number(session.seq ?? 0) - 1 > watermarkSeq
    } catch {
      return false
    }
  }

  /**
   * Debounce one automatic extraction for an idle agent.
   * @param {any} agent - live agent.
   * @param {number} delaySeconds - debounce delay.
   * @param {string} trigger - activity trigger label.
   */
  schedule(agent, delaySeconds, trigger) {
    if (this.disposed) return
    const sessionId = sessionIdOf(agent)
    if (sessionId === '') return
    if (!this.hasPending(agent)) return
    if (!this.store.settings.autoExtract && trigger !== 'manual') return
    const existing = this.timers.get(sessionId)
    if (existing !== undefined) this.clearTimeout(existing)
    const delay = Math.max(0.05, Number(delaySeconds) || 0) * 1000
    const timer = this.setTimeout(() => {
      this.timers.delete(sessionId)
      void this.enqueueAgent(agent, trigger).catch((error) => {
        this.logger?.warn?.(`dsh-memory: scheduled extraction failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    // Node timers keep a test/plugin host alive if they are the only handle.
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    this.timers.set(sessionId, timer)
  }

  /**
   * Cancel one pending debounce timer.
   * @param {string} sessionId - session id.
   */
  cancel(sessionId) {
    const timer = this.timers.get(sessionId)
    if (timer === undefined) return
    this.clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  /**
   * Handle one `agent/status` transition.
   * @param {{ agent: any, status: string }} payload - status event payload.
   */
  onStatus(payload) {
    if (this.disposed) return
    const agent = payload?.agent
    const sessionId = sessionIdOf(agent)
    if (sessionId === '') return
    this.observeAgent(agent)
    if (payload.status === 'idle') {
      const quietSeconds = Number(this.store.settings.quietSeconds) || 30
      this.schedule(agent, quietSeconds, 'quiet')
    } else {
      this.cancel(sessionId)
    }
  }

  /**
   * Handle one agent disposal.
   * @param {{ agent: any }} payload - disposal payload.
   */
  onAgentDisposed(payload) {
    const sessionId = sessionIdOf(payload?.agent)
    if (sessionId !== '') this.cancel(sessionId)
  }

  /**
   * A new conversation usually means the previous one ended: extract other
   * idle sessions that still carry unprocessed content.
   * @param {any} session - newly created session (may be undefined).
   */
  onSessionCreated(session) {
    if (this.disposed) return
    if (!this.store.settings.autoExtract) return
    this.observeAgent({ session })
    const created = String(session?.id ?? '')
    let agents = []
    try {
      agents = this.ctx?.agents?.list?.() ?? []
    } catch {
      return
    }
    for (const agent of agents) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === '' || sessionId === created) continue
      if (agent?.status !== 'idle') continue
      if (!this.hasPending(agent)) continue
      this.schedule(agent, 1, 'boundary')
    }
  }

  /**
   * Snapshot and queue one disposed session (fire-and-forget).
   * @param {any} session - session being disposed.
   */
  onSessionDisposed(session) {
    if (this.disposed || !this.store.settings.autoExtract) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    this.cancel(sessionId)
    let snapshot
    try {
      snapshot = snapshotSession(session)
    } catch {
      return
    }
    if (snapshot.isSubagent) return
    if (this.store.isSessionOptOut(sessionId)) return
    void this.enqueueSnapshot(snapshot, 'dispose', { manual: false }).catch(() => {})
  }

  /**
   * Queue one live agent for extraction.
   * @param {any} agent - live agent.
   * @param {string} trigger - activity trigger.
   * @returns {Promise<Record<string, any>>}
   */
  async enqueueAgent(agent, trigger, options = {}) {
    const session = agent?.session
    if (session === undefined) throw memoryError('session-not-live', 'the session is no longer live')
    const snapshot = snapshotSession(session)
    if (snapshot.isSubagent) {
      return { status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'subagent session' }
    }
    return this.enqueueSnapshot(snapshot, trigger, {
      manual: trigger === 'manual' || trigger === 'tool-extract',
      ...(options.fromStart === true ? { fromStart: true } : {}),
    })
  }

  /**
   * Gate and queue one snapshot; resolves with the judge result (manual) or the
   * queued job result (automatic callers ignore the promise).
   * @param {Record<string, any>} snapshot - session snapshot.
   * @param {string} trigger - activity trigger.
   * @param {{
   *   manual: boolean,
   *   fromStart?: boolean,
   * }} options - manual triggers bypass debounce limits; `fromStart` reprocesses
   *   the whole session (used for imported sessions after baselining).
   * @returns {Promise<Record<string, any>>}
   */
  async enqueueSnapshot(snapshot, trigger, options) {
    if (this.disposed) return { status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'plugin disposed' }
    const settings = this.store.settings
    if (settings.enabled !== true) {
      return { status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'memory disabled' }
    }
    const sessionId = snapshot.sessionId
    if (this.store.isSessionOptOut(sessionId)) {
      return { status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'session opted out' }
    }
    let watermark = this.store.getWatermark(sessionId)
    if (!options.manual && watermark === undefined) {
      const syntheticSession = {
        header: snapshot.header,
        events: snapshot.events,
        seq: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
      }
      watermark = this.ensureBaseline(syntheticSession, sessionId)
    }
    const fromStart = options.fromStart === true
      || (options.manual && watermark?.baseline === true)
    const extraction = buildExtractionInput(snapshot, {
      watermarkSeq: fromStart ? -1 : (watermark === undefined ? -1 : watermark.seq),
    })
    const skip = (reason) => {
      if (!options.manual) this.journalSkip(snapshot, trigger, reason)
      return { status: 'skipped', created: 0, updated: 0, skipped: 0, reason }
    }
    if (extraction.humanMessages === 0) return skip('no new human messages')
    if (!options.manual) {
      // Valuable memories often come from a short question plus a long research
      // answer, so the gate counts the whole new conversation, not only human text.
      if (extraction.totalChars < (Number(settings.minNewChars) || 0)) return skip('not enough new content')
      if (watermark !== undefined) {
        const interval = Math.max(0, Number(settings.minIntervalSeconds) || 0) * 1000
        if (this.now() - Date.parse(watermark.at) < interval) return skip('minimum interval not reached')
      }
      if (this.store.runsInLastHour(sessionId) >= (Number(settings.maxRunsPerHour) || 12)) {
        return skip('hourly run limit reached')
      }
    }
    return this.enqueueJob({ snapshot, extraction, trigger, manual: options.manual, fromStart })
  }

  /**
   * Journal one automatic gate rejection without spending a model call.
   * @param {Record<string, any>} snapshot - session snapshot.
   * @param {string} trigger - activity trigger.
   * @param {string} reason - gate reason.
   */
  journalSkip(snapshot, trigger, reason) {
    try {
      this.store.recordActivity({
        trigger,
        status: 'skipped',
        created: 0,
        updated: 0,
        skipped: 0,
        sessionId: snapshot.sessionId,
        sessionTitle: snapshot.title,
        projectKey: snapshot.projectKey,
        reason,
      })
    } catch {
      // Journaling is best effort.
    }
  }

  /**
   * Queue one prepared job. The same session is never queued twice; a newer
   * snapshot replaces the queued one so the latest span is processed.
   * @param {{
   *   snapshot: Record<string, any>, extraction: Record<string, any>,
   *   trigger: string, manual: boolean,
   * }} job - prepared job.
   * @returns {Promise<Record<string, any>>}
   */
  enqueueJob(job) {
    return new Promise((resolve, reject) => {
      const existingIndex = this.queue.findIndex(entry => entry.snapshot.sessionId === job.snapshot.sessionId)
      if (existingIndex >= 0) {
        const existing = this.queue[existingIndex]
        const merged = {
          ...job,
          manual: existing.manual || job.manual,
          waiters: [...existing.waiters, { resolve, reject }],
        }
        this.queue[existingIndex] = merged
      } else {
        if (this.queue.length >= MAX_QUEUED_JOBS) {
          const dropped = this.queue.shift()
          dropped?.waiters.forEach(waiter => waiter.resolve({
            status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'extraction queue full',
          }))
        }
        this.queue.push({
          ...job,
          waiters: [{ resolve, reject }],
        })
      }
      this.pump()
    })
  }

  /** Drain the queue one job at a time. */
  pump() {
    if (this.pumpPromise !== null || this.disposed) return
    this.pumpPromise = this.drain().finally(() => {
      this.pumpPromise = null
      if (this.queue.length > 0 && !this.disposed) this.pump()
    })
  }

  /** @returns {Promise<void>} resolves when the queue is empty. */
  async drain() {
    while (this.queue.length > 0 && !this.disposed) {
      const job = this.queue.shift()
      if (job === undefined) break
      this.active = job
      const controller = new AbortController()
      this.activeController = controller
      const startedAt = this.now()
      // Another job for this session may have advanced the watermark while this
      // job waited in the queue; never judge the same span twice.
      const currentWatermark = this.store.getWatermark(job.snapshot.sessionId)
      job.extraction = buildExtractionInput(job.snapshot, {
        watermarkSeq: job.fromStart === true ? -1 : (currentWatermark === undefined ? -1 : currentWatermark.seq),
      })
      if (job.extraction.humanMessages === 0) {
        const skipped = { status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'no new human messages' }
        try {
          this.store.recordActivity({
            trigger: job.trigger,
            status: 'skipped',
            created: 0,
            updated: 0,
            skipped: 0,
            sessionId: job.snapshot.sessionId,
            sessionTitle: job.snapshot.title,
            projectKey: job.snapshot.projectKey,
            reason: skipped.reason,
          })
        } catch {
          // Journaling is best effort.
        }
        for (const waiter of job.waiters) waiter.resolve(skipped)
        continue
      }
      let timer
      if (this.judgeTimeoutMs > 0) {
        timer = this.setTimeout(() => controller.abort(memoryError('judge-failed', 'judge timed out')), this.judgeTimeoutMs)
        if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
      }
      let result
      const settings = this.store.settings
      const minimumImportance = job.manual
        ? 1
        : Math.min(5, Math.max(1, Math.round(Number(settings.autoSaveMinImportance) || 3)))
      try {
        result = await this.judge({
          ctx: this.ctx,
          store: this.store,
          snapshot: job.snapshot,
          extraction: job.extraction,
          signal: controller.signal,
          settings,
          minimumImportance,
        })
      } catch (error) {
        result = {
          status: 'error',
          created: 0,
          updated: 0,
          skipped: 0,
          reason: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (timer !== undefined) this.clearTimeout(timer)
        this.active = null
        this.activeController = null
      }
      if (result?.status === 'ok') {
        this.store.setWatermark(job.snapshot.sessionId, {
          seq: job.extraction.nextSeq,
          chars: job.extraction.totalChars,
        })
      }
      const entry = {
        trigger: job.trigger,
        status: result?.status ?? 'error',
        created: Number(result?.created ?? 0),
        updated: Number(result?.updated ?? 0),
        skipped: Number(result?.skipped ?? 0),
        sessionId: job.snapshot.sessionId,
        sessionTitle: job.snapshot.title,
        projectKey: job.snapshot.projectKey,
        durationMs: this.now() - startedAt,
        ...(result?.reason === undefined ? {} : { reason: String(result.reason) }),
      }
      try {
        this.store.recordActivity(entry)
      } catch (error) {
        this.logger?.warn?.(`dsh-memory: activity journal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (result?.status === 'error') {
        this.logger?.warn?.(`dsh-memory: extraction failed for session ${job.snapshot.sessionId}: ${String(result.reason ?? 'unknown error')}`)
      }
      for (const waiter of job.waiters) waiter.resolve(result)
    }
  }

  /**
   * Run one extraction now (manual trigger). Sessions that were baselined as
   * historical are processed from the start automatically; an explicit
   * `fromStart` also reprocesses an already-processed session.
   * @param {any} agentOrSessionId - live agent or session id.
   * @param {{ trigger?: string, fromStart?: boolean }} [options] - trigger label/flags.
   * @returns {Promise<Record<string, any>>}
   */
  async extractNow(agentOrSessionId, options = {}) {
    const trigger = options.trigger ?? 'manual'
    /** @type {any} */
    let agent = undefined
    if (typeof agentOrSessionId === 'string') {
      agent = this.ctx?.agents?.get?.(agentOrSessionId)
    } else {
      agent = agentOrSessionId
    }
    if (agent === undefined || agent === null) {
      throw memoryError('session-not-live', 'the session is no longer live; wait for it to be open')
    }
    return this.enqueueAgent(agent, trigger, { fromStart: options.fromStart === true })
  }

  /**
   * Abort timers and in-flight work; resolves when the active judge settles.
   * @returns {Promise<void>}
   */
  async dispose() {
    this.disposed = true
    for (const timer of this.timers.values()) this.clearTimeout(timer)
    this.timers.clear()
    const queued = this.queue.splice(0, this.queue.length)
    for (const job of queued) {
      for (const waiter of job.waiters) {
        waiter.resolve({ status: 'skipped', created: 0, updated: 0, skipped: 0, reason: 'plugin disposed' })
      }
    }
    try {
      this.activeController?.abort(memoryError('judge-failed', 'plugin disposed'))
    } catch {
      // Abort is best effort during teardown.
    }
    if (this.pumpPromise !== null) await this.pumpPromise.catch(() => {})
  }
}
