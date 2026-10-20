import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HARD_SENSITIVE_TOPICS,
  redactSecrets,
} from '../lib/privacy.js'
import {
  normalizeSettings,
  normalizeState,
  resolveDshHome,
} from '../lib/state.js'
import { buildExtractionInput } from '../lib/transcript.js'
import { cleanup, makeHome, makeStore } from './helpers.js'

test('regression: resolveDshHome treats an empty explicit home as absent', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-regression-home'
    assert.equal(resolveDshHome(''), '/tmp/dsh-regression-home')
    assert.equal(resolveDshHome('   '), '/tmp/dsh-regression-home')
    assert.equal(resolveDshHome(undefined), '/tmp/dsh-regression-home')
    assert.equal(resolveDshHome('/tmp/explicit-home'), '/tmp/explicit-home')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('regression: non-number settings keep their defaults instead of being coerced', () => {
  const settings = normalizeSettings({
    quietSeconds: null,
    minNewChars: false,
    minIntervalSeconds: [],
    maxRunsPerHour: '5000',
    maxTopicsInPrompt: Number.NaN,
  })
  assert.equal(settings.quietSeconds, 30)
  assert.equal(settings.minNewChars, 120)
  assert.equal(settings.minIntervalSeconds, 60)
  assert.equal(settings.maxRunsPerHour, 12)
  assert.equal(settings.maxTopicsInPrompt, 30)
  // Real numbers are still accepted and clamped.
  const clamped = normalizeSettings({ quietSeconds: 5000, minNewChars: -1 })
  assert.equal(clamped.quietSeconds, 600)
  assert.equal(clamped.minNewChars, 0)
})

test('regression: dangerous map keys are dropped from restored state', () => {
  const state = normalizeState({
    watermarks: {
      __proto__: { seq: 7, at: '2026-01-01T00:00:00.000Z', chars: 1 },
      constructor: { seq: 3, at: '2026-01-01T00:00:00.000Z', chars: 0 },
      'sess-ok': { seq: 2, at: '2026-01-01T00:00:00.000Z', chars: 4 },
    },
    sessionOptOut: { __proto__: true, 'sess-ok': true },
  })
  assert.equal(Object.keys(state.watermarks).length, 1)
  assert.equal(state.watermarks['sess-ok'].seq, 2)
  assert.equal(Object.getPrototypeOf(state.watermarks), Object.prototype)
  assert.deepEqual(Object.keys(state.sessionOptOut), ['sess-ok'])
})

test('regression: URI passwords are redacted without mangling the URL', () => {
  const result = redactSecrets('clone https://user:hunter2@example.com/repo.git now')
  assert.match(result.text, /https:\/\/user:\[REDACTED\]@example\.com\/repo\.git/u)
  assert.doesNotMatch(result.text, /hunter2/u)
  assert.equal(result.hits.length > 0, true)
})

test('regression: the two latest compaction summaries provide background', () => {
  const events = [
    { type: 'compaction/summary', seq: 0, time: 1, data: { summary: [{ type: 'text', text: 'first summary' }] } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'human one' }], source: { kind: 'user' } } },
    { type: 'compaction/summary', seq: 2, time: 3, data: { summary: [{ type: 'text', text: 'second summary' }] } },
    { type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: 'human two' }], source: { kind: 'user' } } },
    { type: 'compaction/summary', seq: 4, time: 5, data: { summary: [{ type: 'text', text: 'third summary' }] } },
  ]
  const result = buildExtractionInput({ events }, { watermarkSeq: -1 })
  assert.match(result.compactionSummary, /second summary/u)
  assert.match(result.compactionSummary, /third summary/u)
  assert.doesNotMatch(result.compactionSummary, /first summary/u)
})

test('regression: an oversized newest message still reaches the judge truncated', () => {
  const events = [{
    type: 'user/message',
    seq: 0,
    time: 1,
    data: { content: [{ type: 'text', text: `head-${'x'.repeat(3000)}-tail` }], source: { kind: 'user' } },
  }]
  const result = buildExtractionInput({ events }, { maxInputChars: 1000 })
  assert.match(result.transcript, /\[user\] head-/u)
  assert.match(result.transcript, /…/u)
  assert.equal(result.humanMessages, 1)
  assert.ok(result.transcript.length <= 1200)
})

test('regression: sensitive-topic labels are exported for the judge prompt', () => {
  assert.ok(Array.isArray(HARD_SENSITIVE_TOPICS))
  assert.ok(HARD_SENSITIVE_TOPICS.some(label => /credential|identity|financial/u.test(label)))
})

test('regression: safe-key guards protect session watermarks through the store', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    assert.equal(store.isSessionOptOut('__proto__'), false)
    assert.equal(store.getWatermark('__proto__'), undefined)
    store.setWatermark('__proto__', { seq: 5 })
    assert.equal(store.getWatermark('__proto__'), undefined)
    assert.equal(Object.getPrototypeOf(store.state.watermarks), Object.prototype)
    assert.deepEqual(Object.keys(store.state.watermarks), [])
    assert.deepEqual(Object.keys(store.state.sessionOptOut), [])
    assert.throws(() => store.setSessionOptOut('__proto__', true), error => error.code === 'invalid-request')
  } finally {
    await cleanup(home)
  }
})
