/**
 * Shared test helpers. No Harness packages are involved: the host modules
 * accept injected fakes, which keeps every test hermetic and fast.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/state.js'
import { MemoryStore } from '../lib/store.js'

/** @returns {Promise<string>} fresh harness home. */
export async function makeHome() {
  return mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
}

/**
 * @param {string} home - harness home.
 * @returns {Promise<MemoryStore>} loaded store.
 */
export async function makeStore(home) {
  const store = new MemoryStore({ stateStore: new StateStore({ home }) })
  await store.load()
  return store
}

/** @returns {{ warn: () => void, info: () => void }} silent logger. */
export function silentLogger() {
  return { warn() {}, info() {} }
}

/**
 * @param {number} seq - event sequence number.
 * @param {string} text - human text.
 * @returns {Record<string, any>} user/message event.
 */
export function userEvent(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/**
 * @param {number} seq - event sequence number.
 * @param {string} text - human message text.
 * @returns {Record<string, any>} injected-context user/message event.
 */
export function contextEvent(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'test-context' } },
  }
}

/**
 * @param {number} seq - event sequence number.
 * @param {string} text - assistant text.
 * @returns {Record<string, any>} assistant/message event.
 */
export function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: 1000 + seq,
    data: { message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }] } },
  }
}

/**
 * @param {number} seq - event sequence number.
 * @param {string} name - tool name.
 * @returns {Record<string, any>} tool/call event.
 */
export function toolEvent(seq, name) {
  return { type: 'tool/call', seq, time: 1000 + seq, data: { name, arguments: '{}' } }
}

/**
 * @param {number} seq - event sequence number.
 * @param {string} text - summary text.
 * @returns {Record<string, any>} compaction/summary event.
 */
export function compactionEvent(seq, text) {
  return { type: 'compaction/summary', seq, time: 1000 + seq, data: { summary: [{ type: 'text', text }] } }
}

/**
 * Build a transcript snapshot directly (bypassing a live Session).
 * @param {ReadonlyArray<Record<string, any>>} events - session events.
 * @param {Record<string, any>} [overrides] - snapshot overrides.
 * @returns {Record<string, any>}
 */
export function makeSnapshot(events, overrides = {}) {
  return {
    sessionId: 'sess-test',
    title: 'Test session',
    cwd: '/tmp/project',
    projectKey: undefined,
    projectName: undefined,
    isSubagent: false,
    route: { provider: 'test-provider', model: 'test-model' },
    events,
    header: {},
    createdAt: 1,
    ...overrides,
  }
}

/**
 * @param {{
 *   sessionId?: string,
 *   events?: ReadonlyArray<Record<string, any>>,
 *   header?: Record<string, any>,
 *   route?: { provider: string, model: string } | undefined,
 *   status?: string,
 * }} [options] - agent shape.
 * @returns {{ agent: Record<string, any>, session: Record<string, any> }}
 */
export function makeAgent(options = {}) {
  const events = options.events ?? []
  const session = {
    id: options.sessionId ?? 'sess-test',
    header: options.header ?? { cwd: '/tmp/project', createdAt: Date.now() },
    seq: events.length,
    snapshotEvents: () => events,
    requestHeader: () => (options.route === undefined ? undefined : { config: options.route }),
  }
  const agent = { id: session.id, session, status: options.status ?? 'idle' }
  return { agent, session }
}

/**
 * @param {{
 *   agents?: Record<string, any>[],
 *   services?: Record<string, any>,
 * }} [options] - fake context inputs.
 * @returns {Record<string, any>} fake Cordis context.
 */
export function makeCtx(options = {}) {
  const agents = options.agents ?? []
  return {
    agents: {
      list: () => agents,
      get: id => agents.find(agent => agent.id === id),
    },
    get: name => options.services?.[name],
    logger: silentLogger(),
  }
}

/**
 * A deterministic setTimeout/clearTimeout pair for extractor tests.
 * @returns {{ setTimeout: Function, clearTimeout: Function, fire: () => void,
 *   pending: () => number, fireAndWait: (wait: () => Promise<void>) => Promise<void> }}
 */
export function makeTimers() {
  let nextId = 0
  const timers = new Map()
  const setTimeoutFn = (callback, delay) => {
    const handle = { id: ++nextId, callback, delay, unref() {} }
    timers.set(handle.id, handle)
    return handle
  }
  const clearTimeoutFn = (handle) => {
    if (handle !== undefined && handle !== null) timers.delete(handle.id)
  }
  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    pending: () => timers.size,
    fire() {
      const handles = [...timers.values()]
      timers.clear()
      for (const handle of handles) handle.callback()
    },
    async fireAndWait(wait) {
      this.fire()
      await wait()
    },
  }
}

/**
 * Wait until `predicate` holds, yielding to pending timers/promises.
 * @param {() => boolean} predicate - termination check.
 * @param {{ timeoutMs?: number }} [options] - bound.
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * @param {string} home - harness home to remove.
 * @returns {Promise<void>}
 */
export async function cleanup(home) {
  // Mutations persist asynchronously; let those best-effort writes settle
  // before the temporary tree disappears.
  await new Promise(resolve => setTimeout(resolve, 25))
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
