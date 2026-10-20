/**
 * Unit tests for lib/state.js — path resolution, defaults, normalization and
 * the on-disk StateStore.
 *
 * Run from the plugin root:
 *   node --test test/state.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BOOLEAN_SETTING_KEYS,
  LIMITS,
  MEMORY_DIR,
  MEMORY_ID_PATTERN,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  NUMBER_SETTING_BOUNDS,
  STATE_VERSION,
  StateStore,
  defaultSettings,
  defaultState,
  expandHome,
  isNonEmptyString,
  isRecord,
  mintMemoryId,
  normalizeRecord,
  normalizeSettings,
  normalizeState,
  normalizeTimestamp,
  resolveDshHome,
} from '../lib/state.js'

const VALID_ID = 'm_1a2b3c4d'

/** A fully populated record that should survive normalization unchanged. */
function validRecord(overrides = {}) {
  return {
    id: VALID_ID,
    title: 'Use pnpm',
    summary: 'Prefer pnpm.',
    content: 'Always use pnpm.',
    kind: 'preference',
    scope: 'project',
    project: { key: '/repo', name: 'repo' },
    tags: ['pnpm', 'node'],
    importance: 4,
    pinned: true,
    status: 'archived',
    createdAt: '2024-01-02T03:04:05.000Z',
    updatedAt: '2024-02-03T04:05:06.000Z',
    revision: 3,
    source: {
      origin: 'tool',
      sessionId: 's1',
      sessionTitle: 'Session',
      model: 'p/m',
    },
    ...overrides,
  }
}

describe('resolveDshHome / expandHome', () => {
  let savedDshHome

  beforeEach(() => {
    savedDshHome = process.env.DSH_HOME
    delete process.env.DSH_HOME
  })

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
  })

  it('prefers the explicit argument over $DSH_HOME', () => {
    const explicit = join(tmpdir(), 'explicit-home')
    process.env.DSH_HOME = join(tmpdir(), 'env-home')
    assert.equal(resolveDshHome(explicit), resolve(explicit))
  })

  it('uses $DSH_HOME when no explicit argument is supplied', () => {
    process.env.DSH_HOME = join(tmpdir(), 'env-home')
    assert.equal(resolveDshHome(), resolve(join(tmpdir(), 'env-home')))
  })

  it('falls back to ~/.dsh when neither explicit nor $DSH_HOME is set', () => {
    assert.equal(resolveDshHome(), resolve(join(homedir(), '.dsh')))
  })

  it('expands ~ in the explicit argument and resolves relative paths', () => {
    assert.equal(resolveDshHome('~/dsh-memory-home'), resolve(join(homedir(), 'dsh-memory-home')))
    assert.equal(resolveDshHome('./relative-home'), resolve('./relative-home'))
  })

  it('expandHome handles ~, ~/ and ~\\', () => {
    assert.equal(expandHome('~'), homedir())
    assert.equal(expandHome('~/child'), join(homedir(), 'child'))
    assert.equal(expandHome('~\\child'), join(homedir(), 'child'))
  })

  it('expandHome leaves ordinary and non-string values alone', () => {
    assert.equal(expandHome('/already/absolute'), '/already/absolute')
    assert.equal(expandHome('relative/path'), 'relative/path')
    assert.equal(expandHome('~other'), '~other')
    assert.equal(expandHome(42), '')
    assert.equal(expandHome(undefined), '')
  })
})

describe('defaults and enums', () => {
  it('defaultSettings returns the complete documented shape', () => {
    assert.deepEqual(defaultSettings(), {
      enabled: true,
      autoExtract: true,
      quietSeconds: 30,
      minNewChars: 120,
      minIntervalSeconds: 60,
      maxRunsPerHour: 12,
      maxTopicsInPrompt: 30,
      maxIndexChars: 4000,
      projectsEnabled: true,
      redactSecrets: true,
      toolEnabled: true,
      allowModelDelete: true,
      allowSensitive: false,
      judgeProvider: '',
      judgeModel: '',
    })
  })

  it('defaultState is the versioned document with empty collections', () => {
    assert.deepEqual(defaultState(), {
      version: STATE_VERSION,
      settings: defaultSettings(),
      memories: [],
      watermarks: {},
      sessionOptOut: {},
      activity: [],
      stats: { created: 0, updated: 0, deleted: 0, runs: 0, errors: 0 },
    })
  })

  it('defaultState and defaultSettings return fresh mutable objects', () => {
    const first = defaultState()
    const second = defaultState()
    first.settings.enabled = false
    first.memories.push({ id: VALID_ID })
    first.watermarks.s1 = { seq: 1, at: 'now', chars: 1 }
    assert.deepEqual(second, defaultState())
    assert.notEqual(first.settings, second.settings)
    assert.notEqual(first.memories, second.memories)
  })

  it('exports the documented enum lists and numeric bounds', () => {
    assert.deepEqual(MEMORY_KINDS, ['user', 'preference', 'project', 'decision', 'reference', 'todo'])
    assert.deepEqual(MEMORY_SCOPES, ['global', 'project'])
    assert.deepEqual(MEMORY_STATUSES, ['active', 'archived'])
    assert.deepEqual(BOOLEAN_SETTING_KEYS.sort(), [
      'allowModelDelete',
      'allowSensitive',
      'autoExtract',
      'enabled',
      'projectsEnabled',
      'redactSecrets',
      'toolEnabled',
    ])
    assert.deepEqual(NUMBER_SETTING_BOUNDS.quietSeconds, [3, 600])
    assert.deepEqual(NUMBER_SETTING_BOUNDS.maxIndexChars, [500, 200000])
  })

  it('isRecord / isNonEmptyString / MEMORY_ID_PATTERN behave as documented', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord([]), false)
    assert.equal(isRecord(null), false)
    assert.equal(isNonEmptyString(' x '), true)
    assert.equal(isNonEmptyString('   '), false)
    assert.equal(isNonEmptyString(1), false)
    assert.match(VALID_ID, MEMORY_ID_PATTERN)
    assert.doesNotMatch('m_XYZ', MEMORY_ID_PATTERN)
    const id = mintMemoryId()
    assert.match(id, /^m_[0-9a-f]{8}$/)
    assert.match(id, MEMORY_ID_PATTERN)
    assert.notEqual(mintMemoryId(), mintMemoryId())
  })

  it('normalizeTimestamp accepts parseable values only', () => {
    assert.equal(normalizeTimestamp('2024-01-02T03:04:05+00:00'), '2024-01-02T03:04:05.000Z')
    assert.equal(normalizeTimestamp('nonsense'), undefined)
    assert.equal(normalizeTimestamp(''), undefined)
    assert.equal(normalizeTimestamp(1234), undefined)
    assert.equal(normalizeTimestamp(null), undefined)
  })
})

describe('normalizeSettings', () => {
  it('respects every boolean setting', () => {
    const settings = normalizeSettings({
      enabled: false,
      autoExtract: false,
      projectsEnabled: false,
      redactSecrets: false,
      toolEnabled: false,
      allowModelDelete: false,
      allowSensitive: true,
    })
    assert.equal(settings.enabled, false)
    assert.equal(settings.autoExtract, false)
    assert.equal(settings.projectsEnabled, false)
    assert.equal(settings.redactSecrets, false)
    assert.equal(settings.toolEnabled, false)
    assert.equal(settings.allowModelDelete, false)
    assert.equal(settings.allowSensitive, true)
  })

  it('ignores non-boolean boolean settings and keeps the default', () => {
    const settings = normalizeSettings({
      enabled: 'false',
      autoExtract: 0,
      projectsEnabled: null,
      redactSecrets: 1,
      toolEnabled: 'yes',
      allowModelDelete: {},
      allowSensitive: [],
    })
    assert.equal(settings.enabled, true)
    assert.equal(settings.autoExtract, true)
    assert.equal(settings.projectsEnabled, true)
    assert.equal(settings.redactSecrets, true)
    assert.equal(settings.toolEnabled, true)
    assert.equal(settings.allowModelDelete, true)
    assert.equal(settings.allowSensitive, false)
  })

  it('clamps numeric settings to their documented bounds', () => {
    const settings = normalizeSettings({
      quietSeconds: 1,
      minNewChars: -50,
      minIntervalSeconds: 999999,
      maxRunsPerHour: 0,
      maxTopicsInPrompt: 9999,
      maxIndexChars: 1,
    })
    assert.equal(settings.quietSeconds, 3)
    assert.equal(settings.minNewChars, 0)
    assert.equal(settings.minIntervalSeconds, 86400)
    assert.equal(settings.maxRunsPerHour, 1)
    assert.equal(settings.maxTopicsInPrompt, 500)
    assert.equal(settings.maxIndexChars, 500)
  })

  it('keeps in-range numeric settings unchanged', () => {
    const settings = normalizeSettings({
      quietSeconds: 45,
      minNewChars: 300,
      minIntervalSeconds: 120,
      maxRunsPerHour: 20,
      maxTopicsInPrompt: 40,
      maxIndexChars: 5000,
    })
    assert.equal(settings.quietSeconds, 45)
    assert.equal(settings.minNewChars, 300)
    assert.equal(settings.minIntervalSeconds, 120)
    assert.equal(settings.maxRunsPerHour, 20)
    assert.equal(settings.maxTopicsInPrompt, 40)
    assert.equal(settings.maxIndexChars, 5000)
  })

  it('falls back to defaults for non-coercible invalid numeric types', () => {
    const settings = normalizeSettings({
      quietSeconds: 'not-a-number',
      minNewChars: {},
      minIntervalSeconds: undefined,
      maxRunsPerHour: NaN,
      maxTopicsInPrompt: 'many',
      maxIndexChars: {},
    })
    assert.equal(settings.quietSeconds, defaultSettings().quietSeconds)
    assert.equal(settings.minNewChars, defaultSettings().minNewChars)
    assert.equal(settings.minIntervalSeconds, defaultSettings().minIntervalSeconds)
    assert.equal(settings.maxRunsPerHour, defaultSettings().maxRunsPerHour)
    assert.equal(settings.maxTopicsInPrompt, defaultSettings().maxTopicsInPrompt)
    assert.equal(settings.maxIndexChars, defaultSettings().maxIndexChars)
  })

  it('trims and caps judgeProvider / judgeModel at 120 characters', () => {
    const longModel = `  ${'x'.repeat(200)}  `
    const settings = normalizeSettings({
      judgeProvider: '  provider-a  ',
      judgeModel: longModel,
    })
    assert.equal(settings.judgeProvider, 'provider-a')
    assert.equal(settings.judgeModel, 'x'.repeat(120))
    assert.equal(settings.judgeModel.length, 120)
  })

  it('keeps empty judge route fields when non-string', () => {
    const settings = normalizeSettings({ judgeProvider: 42, judgeModel: null })
    assert.equal(settings.judgeProvider, '')
    assert.equal(settings.judgeModel, '')
  })

  it('returns defaults for non-record input and drops unknown keys', () => {
    assert.deepEqual(normalizeSettings(null), defaultSettings())
    assert.deepEqual(normalizeSettings('settings'), defaultSettings())
    assert.deepEqual(normalizeSettings([]), defaultSettings())
    const settings = normalizeSettings({ quietSeconds: 45, madeUp: 1 })
    assert.equal(settings.quietSeconds, 45)
    assert.equal('madeUp' in settings, false)
    assert.deepEqual(Object.keys(settings).sort(), Object.keys(defaultSettings()).sort())
  })
})

describe('normalizeRecord', () => {
  it('accepts and preserves a valid fully-populated record', () => {
    assert.deepEqual(normalizeRecord(validRecord()), validRecord())
  })

  it('rejects unusable records', () => {
    const invalid = [
      null,
      undefined,
      'record',
      [],
      {},
      { title: 't', content: 'c' },
      { id: 'bad', title: 't', content: 'c' },
      { id: 'm_1234567', title: 't', content: 'c' },
      { id: 'm_ABCDEF12', title: 't', content: 'c' },
      { id: VALID_ID, title: '   ', content: 'c' },
      { id: VALID_ID, title: 't', content: '   ' },
      { id: VALID_ID, title: 't', content: 'c', scope: 'project' },
      { id: VALID_ID, title: 't', content: 'c', scope: 'project', project: { key: '  ' } },
    ]
    for (const candidate of invalid) {
      assert.equal(normalizeRecord(candidate), undefined, JSON.stringify(candidate))
    }
  })

  it('normalizes unknown kind, scope and status', () => {
    const record = normalizeRecord({
      id: VALID_ID,
      title: 'Title',
      content: 'Body',
      kind: 'nonsense',
      scope: 'team',
      status: 'deleted',
    })
    assert.equal(record.kind, 'reference')
    assert.equal(record.scope, 'global')
    assert.equal(record.status, 'active')
    assert.equal(record.project, null)
  })

  it('derives a project name from the key basename when missing', () => {
    const record = normalizeRecord({
      id: VALID_ID,
      title: 'Project fact',
      content: 'Body',
      scope: 'project',
      project: { key: '/home/user/acme' },
    })
    assert.deepEqual(record.project, { key: '/home/user/acme', name: 'acme' })
  })

  it('trims a supplied project name and keeps the key', () => {
    const record = normalizeRecord({
      id: VALID_ID,
      title: 'Project fact',
      content: 'Body',
      scope: 'project',
      project: { key: '/repo', name: '  my repo  ' },
    })
    assert.deepEqual(record.project, { key: '/repo', name: 'my repo' })
  })

  it('drops project references on global records', () => {
    const record = normalizeRecord(validRecord({ scope: 'global', project: { key: '/repo', name: 'repo' } }))
    assert.equal(record.scope, 'global')
    assert.equal(record.project, null)
  })

  it('dedupes, trims, bounds and caps tags', () => {
    const record = normalizeRecord({
      id: VALID_ID,
      title: 'Tags',
      content: 'Body',
      tags: [' pnpm ', 'pnpm', 'PNPM', '', 42, 'x'.repeat(80), ...Array.from({ length: 12 }, (_, i) => `tag${i}`)],
    })
    assert.deepEqual(record.tags, ['pnpm', 'PNPM', 'x'.repeat(40), 'tag0', 'tag1', 'tag2', 'tag3', 'tag4'])
    assert.equal(record.tags.length, LIMITS.tags)
  })

  it('ignores non-array tags', () => {
    const record = normalizeRecord({ id: VALID_ID, title: 'Tags', content: 'Body', tags: 'pnpm' })
    assert.deepEqual(record.tags, [])
  })

  it('clamps importance to 1..5 and handles non-integers', () => {
    const importance = (value) => normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', importance: value }).importance
    assert.equal(importance(9), 5)
    assert.equal(importance(0), 1)
    assert.equal(importance(-3), 1)
    assert.equal(importance(3.7), 3)
    assert.equal(importance('4'), 4)
    assert.equal(importance('nope'), 3)
    assert.equal(importance(undefined), 3)
  })

  it('normalizes revision to a positive integer', () => {
    const revision = (value) => normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', revision: value }).revision
    assert.equal(revision(0), 1)
    assert.equal(revision(-2), 1)
    assert.equal(revision(2.5), 1)
    assert.equal(revision('4'), 4)
    assert.equal(revision(undefined), 1)
  })

  it('normalizes timestamps and falls back from updatedAt to createdAt', () => {
    const untouched = normalizeRecord({
      id: VALID_ID,
      title: 'T',
      content: 'C',
      createdAt: '2024-01-02T03:04:05+00:00',
      updatedAt: '2024-02-03T04:05:06.000Z',
    })
    assert.equal(untouched.createdAt, '2024-01-02T03:04:05.000Z')
    assert.equal(untouched.updatedAt, '2024-02-03T04:05:06.000Z')

    const missingUpdated = normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', createdAt: '2024-01-02T03:04:05.000Z' })
    assert.equal(missingUpdated.updatedAt, missingUpdated.createdAt)

    const invalidCreated = normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', createdAt: 'not-a-date' })
    assert.match(invalidCreated.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(invalidCreated.updatedAt, invalidCreated.createdAt)

    const invalidUpdated = normalizeRecord({
      id: VALID_ID,
      title: 'T',
      content: 'C',
      createdAt: '2024-01-02T03:04:05.000Z',
      updatedAt: 'also-bad',
    })
    assert.equal(invalidUpdated.updatedAt, invalidUpdated.createdAt)
  })

  it('trims title/content, strips control characters and enforces length caps', () => {
    const record = normalizeRecord({
      id: VALID_ID,
      title: `  ${'t'.repeat(150)}\u0000  `,
      content: `  ${'c'.repeat(9000)}\u0007  `,
    })
    assert.equal(record.title.length, LIMITS.title)
    assert.equal(record.content.length, LIMITS.content)
    assert.equal(record.title, 't'.repeat(LIMITS.title))
    assert.equal(record.content, 'c'.repeat(LIMITS.content))

    const cleaned = normalizeRecord({ id: VALID_ID, title: 'Hi\u0000 there', content: 'A\u0007B' })
    assert.equal(cleaned.title, 'Hi there')
    assert.equal(cleaned.content, 'AB')
  })

  it('derives a bounded summary from content when summary is missing', () => {
    const record = normalizeRecord({ id: VALID_ID, title: 'T', content: 'c'.repeat(500), summary: '   ' })
    assert.equal(record.summary, 'c'.repeat(LIMITS.summary))
    assert.equal(record.summary.length, LIMITS.summary)
  })

  it('only treats strict true as pinned', () => {
    assert.equal(normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', pinned: 'true' }).pinned, false)
    assert.equal(normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', pinned: 1 }).pinned, false)
    assert.equal(normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', pinned: true }).pinned, true)
  })

  it('normalizes the source stamp', () => {
    const unknown = normalizeRecord({ id: VALID_ID, title: 'T', content: 'C', source: { origin: 'unknown', sessionId: 9 } })
    assert.deepEqual(unknown.source, { origin: 'auto' })

    const supplied = normalizeRecord({
      id: VALID_ID,
      title: 'T',
      content: 'C',
      source: {
        origin: 'import',
        sessionId: 's'.repeat(250),
        sessionTitle: 'st'.repeat(150),
        model: 'm'.repeat(250),
      },
    })
    assert.equal(supplied.source.origin, 'import')
    assert.equal(supplied.source.sessionId.length, 200)
    assert.equal(supplied.source.sessionTitle.length, LIMITS.sessionTitle)
    assert.equal(supplied.source.model.length, 200)
  })
})

describe('normalizeState', () => {
  it('returns defaults for non-record input', () => {
    assert.deepEqual(normalizeState(null), defaultState())
    assert.deepEqual(normalizeState('state'), defaultState())
    assert.deepEqual(normalizeState([]), defaultState())
    assert.deepEqual(normalizeState(undefined), defaultState())
  })

  it('drops malformed records and keeps the first of duplicate ids', () => {
    const first = normalizeRecord({ id: 'm_00000001', title: 'first', content: 'one' })
    const second = normalizeRecord({ id: 'm_00000002', title: 'second', content: 'two' })
    const duplicate = normalizeRecord({ id: 'm_00000001', title: 'duplicate', content: 'dupe' })
    const state = normalizeState({
      memories: [first, null, { id: 'bad' }, duplicate, second, { id: 'm_00000003', title: '', content: 'x' }],
    })
    assert.equal(state.memories.length, 2)
    assert.equal(state.memories[0].id, 'm_00000001')
    assert.equal(state.memories[0].title, 'first')
    assert.equal(state.memories[1].id, 'm_00000002')
  })

  it('normalizes settings and ignores unknown top-level fields', () => {
    const state = normalizeState({ version: 99, settings: { quietSeconds: 9999 }, memories: [], junk: true })
    assert.equal(state.version, STATE_VERSION)
    assert.equal(state.settings.quietSeconds, 600)
    assert.equal('junk' in state, false)
    assert.deepEqual(Object.keys(state).sort(), [
      'activity',
      'memories',
      'sessionOptOut',
      'settings',
      'stats',
      'version',
      'watermarks',
    ])
  })

  it('normalizes watermarks, drops malformed entries and defaults bad fields', () => {
    const state = normalizeState({
      watermarks: {
        s1: { seq: -5, at: '2024-01-01T00:00:00.000Z', chars: -2 },
        s2: { seq: '7', chars: '3' },
        s3: null,
        s4: 'not-an-object',
        '': { seq: 1 },
      },
    })
    assert.deepEqual(Object.keys(state.watermarks).sort(), ['s1', 's2'])
    assert.deepEqual(state.watermarks.s1, {
      seq: 0,
      at: '2024-01-01T00:00:00.000Z',
      chars: 0,
    })
    assert.equal(state.watermarks.s2.seq, 7)
    assert.equal(state.watermarks.s2.chars, 3)
    assert.match(state.watermarks.s2.at, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps only strict true session opt-outs with non-empty ids', () => {
    const state = normalizeState({
      sessionOptOut: { a: true, b: false, c: 'true', d: 1, e: true, '': true },
    })
    assert.deepEqual(state.sessionOptOut, { a: true, e: true })
  })

  it('normalizes activity entries and defaults invalid enums and counters', () => {
    const state = normalizeState({
      activity: [
        {
          at: '2024-01-01T00:00:00.000Z',
          trigger: 'weird',
          status: 'weird',
          created: -1,
          updated: 2.7,
          skipped: '4',
          reason: 'r'.repeat(250),
          durationMs: 12.7,
          sessionId: 's',
          sessionTitle: 'st'.repeat(150),
          extra: 'dropped',
        },
        { at: 'not-a-date' },
        null,
        'nope',
      ],
    })
    assert.equal(state.activity.length, 1)
    const entry = state.activity[0]
    assert.equal(entry.trigger, 'manual')
    assert.equal(entry.status, 'ok')
    assert.equal(entry.created, 0)
    assert.equal(entry.updated, 0)
    assert.equal(entry.skipped, 4)
    assert.equal(entry.reason.length, 200)
    assert.equal(entry.durationMs, 13)
    assert.equal(entry.sessionId, 's')
    assert.equal(entry.sessionTitle.length, LIMITS.sessionTitle)
    assert.equal('extra' in entry, false)
  })

  it('caps the activity journal at 100 entries', () => {
    const activity = Array.from({ length: 105 }, (_, index) => ({
      at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
      trigger: 'quiet',
      status: 'ok',
    }))
    const state = normalizeState({ activity })
    assert.equal(state.activity.length, LIMITS.activity)
    assert.equal(state.activity[0].at, '2024-01-01T00:00:00.000Z')
    assert.equal(state.activity[99].at, '2024-01-01T00:01:39.000Z')
  })

  it('clamps stats to non-negative integers and ignores extra counters', () => {
    const state = normalizeState({
      stats: { created: -3, updated: 2.9, deleted: '4', runs: -0.5, errors: 100, extra: 9 },
    })
    assert.deepEqual(state.stats, { created: 0, updated: 0, deleted: 4, runs: 0, errors: 100 })
    assert.deepEqual(normalizeState({ stats: {} }).stats, {
      created: 0,
      updated: 0,
      deleted: 0,
      runs: 0,
      errors: 0,
    })
  })
})

describe('StateStore', () => {
  let home

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-memory-state-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('derives all plugin paths from the supplied home', () => {
    const store = new StateStore({ home })
    assert.equal(store.home, resolve(home))
    assert.equal(store.root, join(home, MEMORY_DIR))
    assert.equal(store.statePath, join(home, MEMORY_DIR, 'memory.json'))
    assert.equal(store.auditPath, join(home, MEMORY_DIR, 'audit.jsonl'))
    assert.equal(store.mirrorPath, join(home, MEMORY_DIR, 'MEMORY.md'))
    assert.equal(store.loaded, false)
    assert.deepEqual(store.state, defaultState())
  })

  it('loads defaults when memory.json is missing and creates the directory', async () => {
    const store = new StateStore({ home })
    const state = await store.load()
    assert.equal(store.loaded, true)
    assert.deepEqual(state, defaultState())
    assert.deepEqual(store.state, defaultState())
    assert.deepEqual(await readdir(store.root), [])
  })

  it('round-trips a saved state document', async () => {
    const store = new StateStore({ home })
    await store.load()
    store.state.settings.quietSeconds = 45
    store.state.memories.push(normalizeRecord(validRecord()))
    store.state.watermarks.s1 = { seq: 9, at: '2024-01-01T00:00:00.000Z', chars: 42 }
    store.state.sessionOptOut.s1 = true
    store.state.activity.push({
      at: '2024-01-01T00:00:00.000Z',
      trigger: 'manual',
      status: 'ok',
      created: 1,
      updated: 0,
      skipped: 0,
    })
    store.state.stats.created = 1
    await store.save()

    const onDisk = JSON.parse(await readFile(store.statePath, 'utf8'))
    assert.deepEqual(onDisk, store.state)
    assert.deepEqual(await readdir(store.root), ['memory.json'])

    const reloaded = new StateStore({ home })
    const state = await reloaded.load()
    assert.deepEqual(state, store.state)
    assert.equal(state.memories[0].title, 'Use pnpm')
    assert.equal(state.settings.quietSeconds, 45)
    assert.equal(state.watermarks.s1.seq, 9)
    assert.equal(state.sessionOptOut.s1, true)
    assert.equal(state.stats.created, 1)
  })

  it('preserves corrupt JSON as memory.json.broken-* and falls back to defaults', async () => {
    const warnings = []
    const store = new StateStore({ home, logger: { warn: (message) => warnings.push(message) } })
    await mkdir(store.root, { recursive: true })
    await writeFile(store.statePath, '{ definitely not json', 'utf8')

    const state = await store.load()
    assert.equal(store.loaded, true)
    assert.deepEqual(state, defaultState())

    const names = await readdir(store.root)
    const broken = names.filter((name) => name.startsWith('memory.json.broken-'))
    assert.equal(broken.length, 1)
    assert.equal(await readFile(join(store.root, broken[0]), 'utf8'), '{ definitely not json')
    assert.equal(names.includes('memory.json'), false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /preserved corrupt state/)
  })

  it('appendAudit writes one JSON line per entry', async () => {
    const store = new StateStore({ home })
    await store.load()
    const first = { action: 'create', id: VALID_ID, at: '2024-01-01T00:00:00.000Z' }
    const second = { action: 'delete', id: VALID_ID, at: '2024-01-02T00:00:00.000Z' }
    await store.appendAudit(first)
    await store.appendAudit(second)

    const lines = (await readFile(store.auditPath, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), first)
    assert.deepEqual(JSON.parse(lines[1]), second)
  })

  it('appendAudit failure only warns and never throws', async () => {
    const warnings = []
    const store = new StateStore({ home, logger: { warn: (message) => warnings.push(message) } })
    // Occupy the plugin directory path with a plain file so mkdir fails.
    await writeFile(store.root, 'not a directory', 'utf8')
    await store.appendAudit({ action: 'create' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot append audit/)
  })

  it('writeMirror atomically replaces MEMORY.md', async () => {
    const store = new StateStore({ home })
    await store.writeMirror('# Memory\n\nfirst body\n')
    assert.equal(await readFile(store.mirrorPath, 'utf8'), '# Memory\n\nfirst body\n')

    await store.writeMirror('# Memory\n\nsecond body\n')
    assert.equal(await readFile(store.mirrorPath, 'utf8'), '# Memory\n\nsecond body\n')
    assert.deepEqual(await readdir(store.root), ['MEMORY.md'])
  })

  it('writeMirror failure only warns and never throws', async () => {
    const warnings = []
    const store = new StateStore({ home, logger: { warn: (message) => warnings.push(message) } })
    await writeFile(store.root, 'not a directory', 'utf8')
    await store.writeMirror('# Memory')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot write mirror/)
  })
})
