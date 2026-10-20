/**
 * Unit tests for lib/state.js (v2 operational state + legacy normalization).
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LEGACY_STATE_FILE,
  STATE_FILE,
  StateStore,
  defaultSettings,
  defaultState,
  normalizeLegacyState,
  normalizeProjectEntry,
  normalizeRecord,
  normalizeSettings,
  normalizeState,
  resolveDshHome,
} from '../lib/state.js'
import { expandHome } from '../lib/state.js'

describe('home resolution', () => {
  it('prefers an explicit home, then DSH_HOME, then ~/.dsh', () => {
    const previous = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/tmp/state-env-home'
      assert.equal(resolveDshHome('/tmp/state-explicit'), '/tmp/state-explicit')
      assert.equal(resolveDshHome(''), '/tmp/state-env-home')
      assert.equal(resolveDshHome('  '), '/tmp/state-env-home')
      delete process.env.DSH_HOME
      assert.match(resolveDshHome(), /\.dsh$/u)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    assert.equal(expandHome('~'), expandHome('~'))
  })
})

describe('settings and documents', () => {
  it('ships the v2 defaults with independent project budgets', () => {
    const settings = defaultSettings()
    assert.equal(settings.maxTopicsInPrompt, 30)
    assert.equal(settings.maxIndexChars, 4000)
    assert.equal(settings.projectMaxTopicsInPrompt, 30)
    assert.equal(settings.projectMaxIndexChars, 4000)
    assert.equal(settings.allowSensitive, false)
    const state = defaultState()
    assert.equal(state.version, 2)
    assert.equal('memories' in state, false)
    assert.deepEqual(state.projects, {})
    assert.equal(state.stats.migrated, 0)
  })

  it('normalizes settings without coercing wrong types', () => {
    const settings = normalizeSettings({
      enabled: false,
      quietSeconds: '5000',
      minNewChars: null,
      maxTopicsInPrompt: 42,
      projectMaxIndexChars: 9000,
      judgeProvider: '  fixed  ',
      judgeModel: 'model-x',
    })
    assert.equal(settings.enabled, false)
    assert.equal(settings.quietSeconds, 30)
    assert.equal(settings.minNewChars, 120)
    assert.equal(settings.maxTopicsInPrompt, 42)
    assert.equal(settings.projectMaxIndexChars, 9000)
    assert.equal(settings.judgeProvider, 'fixed')
    assert.equal(settings.judgeModel, 'model-x')
    assert.equal(normalizeSettings({ quietSeconds: 5000 }).quietSeconds, 600)
    assert.equal(normalizeSettings({ quietSeconds: -1 }).quietSeconds, 3)
  })

  it('normalizes the v2 state document and protects map keys', () => {
    const state = normalizeState(JSON.parse(JSON.stringify({
      version: 2,
      settings: { quietSeconds: 12 },
      watermarks: {
        'sess-1': { seq: 4, at: '2026-01-01T00:00:00.000Z', chars: 10 },
        ['__proto__']: { seq: 7, at: '2026-01-01T00:00:00.000Z', chars: 1 },
      },
      sessionOptOut: { 'sess-2': true, ['__proto__']: true },
      activity: [
        { at: '2026-01-01T00:00:00.000Z', trigger: 'quiet', status: 'ok', created: 1, projectKey: '/tmp/ws' },
        { at: 'bad' },
      ],
      stats: { created: 3, updated: -2, deleted: 1, runs: 2, errors: 1, migrated: 5 },
      projects: {
        '/tmp/ws': { name: 'ws', memoryDir: '/tmp/ws/.dsh/dsh-memory', lastSeenAt: '2026-01-01T00:00:00.000Z' },
        ['__proto__']: { memoryDir: '/tmp/bad' },
      },
    })))
    assert.equal(state.version, 2)
    assert.equal(state.watermarks['sess-1'].seq, 4)
    assert.equal(Object.getPrototypeOf(state.watermarks), Object.prototype)
    assert.equal(state.sessionOptOut['sess-2'], true)
    assert.equal(state.activity.length, 1)
    assert.equal(state.activity[0].projectKey, '/tmp/ws')
    assert.equal(state.stats.updated, 0)
    assert.equal(state.stats.migrated, 5)
    assert.equal(state.projects['/tmp/ws'].name, 'ws')
    assert.equal(normalizeProjectEntry({ memoryDir: '' }), undefined)
  })

  it('normalizes legacy records and legacy documents', () => {
    const record = normalizeRecord({
      id: 'm_12345678',
      title: 'Legacy',
      content: 'Body',
      kind: 'project',
      scope: 'project',
      project: { key: '/tmp/ws', name: 'ws' },
      tags: ['a', 'a'],
      importance: 9,
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(record.kind, 'project')
    assert.equal(record.project.key, '/tmp/ws')
    assert.deepEqual(record.tags, ['a'])
    assert.equal(record.importance, 5)
    assert.equal(record.revision, 1)
    assert.equal(normalizeRecord({ id: 'bad', title: 'x', content: 'y' }), undefined)
    assert.equal(normalizeRecord({ id: 'm_11111111', title: 'x', content: '' }), undefined)

    const legacy = normalizeLegacyState({
      settings: { quietSeconds: 15 },
      memories: [
        { id: 'm_11111111', title: 'A', content: 'a', scope: 'global' },
        { id: 'm_11111111', title: 'Dup', content: 'dup', scope: 'global' },
        { id: 'm_22222222', title: 'B', content: 'b', scope: 'project', project: { key: '/tmp/ws' } },
      ],
      watermarks: { 'sess-1': { seq: 2, at: '2026-01-01T00:00:00.000Z', chars: 1 } },
      sessionOptOut: { 'sess-1': true },
      activity: [{ at: '2026-01-01T00:00:00.000Z', trigger: 'quiet', status: 'ok' }],
      stats: { created: 2 },
    })
    assert.equal(legacy.version, 1)
    assert.equal(legacy.memories.length, 2)
    assert.equal(legacy.memories[1].project.key, '/tmp/ws')
    assert.equal(legacy.watermarks['sess-1'].seq, 2)
    assert.equal(legacy.sessionOptOut['sess-1'], true)
    assert.equal(legacy.activity.length, 1)
    assert.equal(legacy.stats.created, 2)
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

  it('reads defaults when neither state nor legacy file exists', async () => {
    const store = new StateStore({ home })
    const loaded = await store.read()
    assert.equal(loaded.legacy, undefined)
    assert.equal(loaded.state.version, 2)
    assert.equal(loaded.state.settings.quietSeconds, 30)
  })

  it('round-trips state.json and appends audit lines', async () => {
    const store = new StateStore({ home })
    await store.read()
    store.state.settings.quietSeconds = 45
    store.state.stats.created = 2
    await store.save()
    const file = JSON.parse(await readFile(join(home, 'dsh-memory', STATE_FILE), 'utf8'))
    assert.equal(file.version, 2)
    assert.equal(file.settings.quietSeconds, 45)
    assert.equal(file.stats.created, 2)
    await store.appendAudit({ op: 'test', id: 'm_11111111' })
    const audit = await readFile(join(home, 'dsh-memory', 'audit.jsonl'), 'utf8')
    assert.match(audit, /"op":"test"/u)
  })

  it('backs up a corrupt state.json and starts fresh', async () => {
    const root = join(home, 'dsh-memory')
    await (await import('node:fs/promises')).mkdir(root, { recursive: true })
    await writeFile(join(root, STATE_FILE), '{not json', 'utf8')
    const store = new StateStore({ home })
    const loaded = await store.read()
    assert.equal(loaded.state.version, 2)
    const names = await readdir(root)
    assert.ok(names.some(name => name.startsWith(`${STATE_FILE}.broken-`)))
    assert.ok(!names.includes(STATE_FILE))
  })

  it('reads a legacy memory.json for migration and renames it when asked', async () => {
    const root = join(home, 'dsh-memory')
    await rm(root, { recursive: true, force: true })
    const legacyBody = JSON.stringify({
      version: 1,
      settings: { quietSeconds: 20 },
      memories: [{ id: 'm_11111111', title: 'A', content: 'a', scope: 'global' }],
      watermarks: {},
      sessionOptOut: {},
      activity: [],
      stats: { created: 1 },
    })
    await (await import('node:fs/promises')).mkdir(root, { recursive: true })
    await writeFile(join(root, LEGACY_STATE_FILE), legacyBody, 'utf8')
    const store = new StateStore({ home })
    const loaded = await store.read()
    assert.equal(loaded.state, undefined)
    assert.equal(loaded.legacy.version, 1)
    assert.equal(loaded.legacy.memories.length, 1)
    const backup = await store.backupLegacy()
    assert.match(backup, /memory\.json\.migrated-/u)
    assert.equal((await readdir(root)).some(name => name === LEGACY_STATE_FILE), false)
  })
})
