import test from 'node:test'
import assert from 'node:assert/strict'
import { Extractor } from '../lib/extractor.js'
import {
  assistantEvent,
  cleanup,
  contextEvent,
  makeAgent,
  makeCtx,
  makeHome,
  makeStore,
  makeTimers,
  userEvent,
  waitFor,
} from './helpers.js'

/** Long enough to pass the default `minNewChars` gate. */
const LONG_TEXT = 'Please remember that this project always uses pnpm for every package installation, and that the staging deployment target is a host named tatooine which is only reachable from the office network.'

/**
 * @param {{
 *   store: import('../lib/store.js').MemoryStore,
 *   result?: Record<string, any>,
 *   onCreate?: (input: Record<string, any>) => void,
 *   delay?: Promise<void>,
 * }} options - fake judge behavior.
 * @returns {{ judge: Function, calls: Record<string, any>[] }}
 */
function makeJudge(options) {
  const calls = []
  const judge = async (input) => {
    calls.push(input)
    if (options.delay !== undefined) await options.delay
    if (options.onCreate !== undefined) options.onCreate(input)
    return options.result ?? { status: 'ok', created: 1, updated: 0, skipped: 0 }
  }
  return { judge, calls }
}

/**
 * @param {ReturnType<typeof makeAgent>} pair - agent/session pair.
 * @param {Record<string, any>} [options] - wait options.
 */
async function waitForActivity(store, count = 1, options = {}) {
  await waitFor(() => store.state.activity.length >= count, options)
}

test('extractor: idle schedules one debounced extraction that records activity and advances the watermark', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.setSettings({ quietSeconds: 30 })
    const events = [userEvent(0, LONG_TEXT), assistantEvent(1, 'Noted.')]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })

    assert.equal(extractor.hasPending(agent), true)
    extractor.onStatus({ agent, status: 'idle' })
    assert.equal(timers.pending(), 1)
    assert.equal(store.state.activity.length, 0)

    timers.fire()
    await waitForActivity(store)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].extraction.humanMessages, 1)
    assert.equal(store.state.activity[0].trigger, 'quiet')
    assert.equal(store.state.activity[0].status, 'ok')
    assert.equal(store.getWatermark('sess-test').seq, 1)
    assert.equal(extractor.hasPending(agent), false)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: running cancels the pending debounce and a later idle reschedules it', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    extractor.onStatus({ agent, status: 'idle' })
    assert.equal(timers.pending(), 1)
    extractor.onStatus({ agent, status: 'running' })
    assert.equal(timers.pending(), 0)
    extractor.onStatus({ agent, status: 'idle' })
    assert.equal(timers.pending(), 1)
    timers.fire()
    await waitForActivity(store)
    assert.equal(calls.length, 1)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: quiet extraction gates skip tiny spans and respect per-session intervals', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, 'hi')]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    extractor.onStatus({ agent, status: 'idle' })
    timers.fire()
    await waitForActivity(store)
    assert.equal(calls.length, 0)
    assert.match(store.state.activity[0].reason, /not enough new content/u)

    // Within the minimum interval, a long-enough span is still deferred.
    const longAgent = makeAgent({ sessionId: 'sess-long', events: [userEvent(0, LONG_TEXT)] }).agent
    // A recent run with nothing processed yet: seq -1 keeps event 0 in the window.
    store.state.watermarks['sess-long'] = { seq: -1, at: new Date().toISOString(), chars: 0 }
    extractor.onStatus({ agent: longAgent, status: 'idle' })
    assert.equal(timers.pending(), 1)
    timers.fire()
    await waitForActivity(store, 2)
    assert.equal(calls.length, 0)
    // Activity is newest-first: the interval skip is the most recent entry.
    assert.match(store.state.activity[0].reason, /minimum interval/u)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: manual extraction bypasses content and interval gates', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, 'ok'), assistantEvent(1, 'ok')]
    const { agent } = makeAgent({ events })
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({ ctx: makeCtx({ agents: [agent] }), store, judge })
    const result = await extractor.extractNow(agent)
    assert.equal(result.status, 'ok')
    assert.equal(calls.length, 1)
    assert.equal(store.state.activity[0].trigger, 'manual')
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: disabled memory, opted-out sessions and subagents never call the judge', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({ ctx: makeCtx({ agents: [agent] }), store, judge })

    store.setSettings({ enabled: false })
    const disabled = await extractor.extractNow(agent)
    assert.equal(disabled.status, 'skipped')

    store.setSettings({ enabled: true })
    store.setSessionOptOut('sess-test', true)
    const optedOut = await extractor.extractNow(agent)
    assert.equal(optedOut.status, 'skipped')

    const subagent = makeAgent({
      sessionId: 'sess-sub',
      events: [userEvent(0, LONG_TEXT)],
      header: { cwd: '/tmp', createdAt: 1, origin: 'subagent' },
    }).agent
    const subResult = await extractor.extractNow(subagent)
    assert.equal(subResult.status, 'skipped')
    assert.equal(extractor.onStatus({ agent: subagent, status: 'idle' }) === undefined, true)
    assert.equal(calls.length, 0)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: hourly run limit stops automatic extraction but not manual extraction', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.setSettings({ maxRunsPerHour: 2 })
    for (let index = 0; index < 2; index += 1) {
      store.recordActivity({ sessionId: 'sess-test', trigger: 'quiet', status: 'ok' })
    }
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    extractor.onStatus({ agent, status: 'idle' })
    timers.fire()
    await waitForActivity(store, 3)
    assert.equal(calls.length, 0)
    assert.match(store.state.activity[0].reason, /hourly run limit/u)
    const manual = await extractor.extractNow(agent)
    assert.equal(manual.status, 'ok')
    assert.equal(calls.length, 1)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: concurrent jobs for one session merge into one judge call', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { judge, calls } = makeJudge({ store, delay: gate })
    const extractor = new Extractor({ ctx: makeCtx({ agents: [agent] }), store, judge })
    const first = extractor.extractNow(agent)
    // Let the first job enter the judge before queueing the second.
    await waitFor(() => calls.length === 1)
    const second = extractor.extractNow(agent)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(calls.length, 1)
    assert.equal(firstResult.status, 'ok')
    // The queued follow-up re-checks the watermark and spends no second call.
    assert.equal(secondResult.status, 'skipped')
    assert.match(secondResult.reason, /no new human messages/u)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: a new session triggers boundary extraction of other idle sessions', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const idlePair = makeAgent({ sessionId: 'sess-old', events: [userEvent(0, LONG_TEXT)] })
    const timers = makeTimers()
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [idlePair.agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    extractor.onSessionCreated({ id: 'sess-new' })
    assert.equal(timers.pending(), 1)
    timers.fire()
    await waitForActivity(store)
    assert.equal(calls.length, 1)
    assert.equal(store.state.activity[0].trigger, 'boundary')
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: a disposed session is snapshotted and queued immediately', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT), assistantEvent(1, 'Noted.')]
    const { session } = makeAgent({ events })
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({ ctx: makeCtx({ agents: [] }), store, judge })
    extractor.onSessionDisposed(session)
    await waitForActivity(store)
    assert.equal(calls.length, 1)
    assert.equal(store.state.activity[0].trigger, 'dispose')
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: failed judge calls are journaled without advancing the watermark', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    const { judge } = makeJudge({ store, result: { status: 'error', created: 0, updated: 0, skipped: 0, reason: 'provider down' } })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    extractor.onStatus({ agent, status: 'idle' })
    timers.fire()
    await waitForActivity(store)
    assert.equal(store.state.activity[0].status, 'error')
    assert.match(store.state.activity[0].reason, /provider down/u)
    assert.equal(store.getWatermark('sess-test'), undefined)
    assert.equal(extractor.hasPending(agent), true)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})

test('extractor: start() and dispose() manage timers and in-flight work', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [userEvent(0, LONG_TEXT)]
    const { agent } = makeAgent({ events })
    const timers = makeTimers()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { judge, calls } = makeJudge({ store, delay: gate })
    const extractor = new Extractor({
      ctx: makeCtx({ agents: [agent] }),
      store,
      judge,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await extractor.start()
    assert.equal(timers.pending(), 1)
    await extractor.dispose()
    assert.equal(timers.pending(), 0)
    assert.equal(calls.length, 0)

    // In-flight work is aborted and resolves its waiters during disposal.
    const second = new Extractor({ ctx: makeCtx({ agents: [agent] }), store, judge })
    const pending = second.extractNow(agent).catch(error => error)
    await waitFor(() => calls.length === 1)
    const disposing = second.dispose()
    release()
    await disposing
    const settled = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 500)),
    ])
    assert.notEqual(settled, 'timeout')
  } finally {
    await cleanup(home)
  }
})

test('extractor: extraction input excludes injected context messages', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const events = [
      contextEvent(0, 'workspace instructions injected by another plugin'),
      userEvent(1, LONG_TEXT),
      assistantEvent(2, 'Noted.'),
    ]
    const { agent } = makeAgent({ events })
    const { judge, calls } = makeJudge({ store })
    const extractor = new Extractor({ ctx: makeCtx({ agents: [agent] }), store, judge })
    await extractor.extractNow(agent)
    assert.equal(calls[0].extraction.humanMessages, 1)
    assert.equal(calls[0].extraction.humanChars, LONG_TEXT.length)
    assert.doesNotMatch(calls[0].extraction.transcript, /workspace instructions/u)
    assert.match(calls[0].extraction.transcript, /tatooine/u)
    await extractor.dispose()
  } finally {
    await cleanup(home)
  }
})
