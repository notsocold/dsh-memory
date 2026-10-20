import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore, renderMirror, MAX_ACTIVE_RECORDS } from '../lib/store.js'
import { StateStore } from '../lib/state.js'
import { cleanup, makeHome, makeStore, silentLogger } from './helpers.js'

/**
 * @param {MemoryStore} store - store under test.
 * @param {Record<string, any>} [input] - create input overrides.
 * @returns {Record<string, any>} created record.
 */
function createRecord(store, input = {}) {
  const result = store.create({
    title: 'User prefers pnpm',
    content: 'The user always uses pnpm for Node.js projects.',
    kind: 'preference',
    scope: 'global',
    importance: 4,
    tags: ['pnpm', 'tooling'],
    ...input,
  }, { origin: 'manual', source: { sessionId: 'sess-1', sessionTitle: 'Setup chat' } })
  return result.record
}

test('store: create fills defaults and renders into the prompt index', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const record = createRecord(store)
    assert.match(record.id, /^m_[0-9a-f]{8}$/)
    assert.equal(record.kind, 'preference')
    assert.equal(record.scope, 'global')
    assert.equal(record.importance, 4)
    assert.deepEqual(record.tags, ['pnpm', 'tooling'])
    assert.equal(record.status, 'active')
    assert.equal(record.revision, 1)
    assert.equal(record.source.origin, 'manual')
    assert.equal(record.source.sessionId, 'sess-1')

    const index = store.indexForPrompt({})
    assert.equal(index.included, 1)
    assert.equal(index.omitted, 0)
    assert.match(index.text, new RegExp(record.id))
    assert.match(index.text, /preference/)
    assert.match(index.text, /The user always uses pnpm for Node\.js projects\./)
  } finally {
    await cleanup(home)
  }
})

test('store: create merges duplicate titles, duplicate bodies and near-identical topics', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const first = createRecord(store)

    const titleTwin = store.create({
      title: '  USER prefers   pnpm!! ',
      content: 'Different body text about the package manager choice.',
      kind: 'preference',
      scope: 'global',
    }, { origin: 'auto' })
    assert.equal(titleTwin.action, 'merged')
    assert.equal(titleTwin.record.id, first.id)
    assert.equal(titleTwin.record.revision, 2)
    assert.equal(store.memories.length, 1)

    const bodyTwin = store.create({
      title: 'Node package manager',
      content: 'Different body text about the package manager choice.',
      kind: 'preference',
      scope: 'global',
    }, { origin: 'auto' })
    assert.equal(bodyTwin.action, 'merged')
    assert.equal(store.memories.length, 1)

    // A genuinely different topic must not be swallowed by the similarity guard.
    const distinct = store.create({
      title: 'Sourdough feeding schedule',
      content: 'Feed the starter every morning with equal parts flour and water.',
      kind: 'reference',
      scope: 'global',
    }, { origin: 'auto' })
    assert.equal(distinct.action, 'created')
    assert.equal(store.memories.length, 2)
    assert.ok(bodyTwin.record.revision >= 3)
  } finally {
    await cleanup(home)
  }
})

test('store: the same title in a different scope or project is a separate topic', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    createRecord(store)
    const projectA = store.create({
      title: 'User prefers pnpm',
      content: 'Project A pins pnpm because of a workspace constraint.',
      kind: 'project',
      scope: 'project',
      project: { key: '/repos/a', name: 'a' },
    })
    assert.equal(projectA.action, 'created')
    const projectB = store.create({
      title: 'User prefers pnpm',
      content: 'Project B pins pnpm because of a workspace constraint.',
      kind: 'project',
      scope: 'project',
      project: { key: '/repos/b', name: 'b' },
    })
    assert.equal(projectB.action, 'created')
    assert.equal(store.memories.length, 3)
  } finally {
    await cleanup(home)
  }
})

test('store: update revises fields, validates input and redacts secrets', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const record = createRecord(store)
    const updated = store.update(record.id, {
      title: 'User prefers pnpm everywhere',
      content: 'Confirmed for all repos. token=sk-abcdefghijklmnopqrstuvwxyz012345',
      importance: 5,
      tags: ['pnpm', 'pnpm', 'node', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }, { origin: 'manual' })
    assert.equal(updated.record.revision, 2)
    assert.equal(updated.record.importance, 5)
    assert.match(updated.record.content, /\[REDACTED\]/)
    assert.doesNotMatch(updated.record.content, /sk-abcdefghijklmnopqrstuvwxyz/)
    assert.equal(updated.record.tags.length, 8)
    assert.equal(updated.record.tags[0], 'pnpm')

    assert.throws(() => store.update('m_00000000', { title: 'x' }), error => error.code === 'not-found')
    assert.throws(() => store.update(record.id, {}), error => error.code === 'invalid-request')
    assert.throws(() => store.update(record.id, { scope: 'project' }), error => error.code === 'invalid-request')
    assert.throws(() => store.update(record.id, { kind: 'nope' }), error => error.code === 'invalid-request')
  } finally {
    await cleanup(home)
  }
})

test('store: remove, clear and counters', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const first = createRecord(store)
    const second = store.create({ title: 'Deploy target', content: 'Staging host is tatooine.', kind: 'project' })
    assert.equal(store.memories.length, 2)
    assert.throws(() => store.remove('m_ffffffff'), error => error.code === 'not-found')
    const removed = store.remove(first.id)
    assert.equal(removed.action, 'deleted')
    assert.equal(store.memories.length, 1)
    assert.equal(store.state.stats.deleted, 1)
    assert.deepEqual(store.clear(), { count: 1 })
    assert.equal(store.memories.length, 0)
    assert.equal(store.state.stats.deleted, 2)
    const stats = store.stats()
    assert.equal(stats.total, 0)
    assert.equal(stats.paused, false)
    assert.equal(stats.stateStats.deleted, 2)
    void second
  } finally {
    await cleanup(home)
  }
})

test('store: pinned topics sort first and project filtering keeps scopes apart', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const global = createRecord(store)
    const projectA = store.create({
      title: 'Repo A uses vitest',
      content: 'Repository A runs its suite with vitest.',
      kind: 'project',
      scope: 'project',
      project: { key: '/repos/a', name: 'a' },
    }).record
    store.create({
      title: 'Repo B uses jest',
      content: 'Repository B runs its suite with jest.',
      kind: 'project',
      scope: 'project',
      project: { key: '/repos/b', name: 'b' },
    })
    store.setPinned(global.id, true)
    const index = store.indexForPrompt({ projectKey: '/repos/a' })
    assert.equal(index.included, 2)
    assert.ok(index.text.indexOf(global.id) < index.text.indexOf(projectA.id))
    assert.doesNotMatch(index.text, /Repo B/)
    const globalOnly = store.indexForPrompt({})
    assert.equal(globalOnly.included, 1)
    assert.match(globalOnly.text, new RegExp(global.id))

    store.setSettings({ projectsEnabled: false })
    const withoutProjects = store.indexForPrompt({ projectKey: '/repos/a' })
    assert.equal(withoutProjects.included, 1)
    assert.match(withoutProjects.text, new RegExp(global.id))
  } finally {
    await cleanup(home)
  }
})

test('store: index budgets truncate and report omissions', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const subjects = ['banana peel', 'quartz ledger', 'violet antenna', 'marble kettle', 'zephyr harbor']
    for (let index = 0; index < 5; index += 1) {
      store.create({
        title: subjects[index],
        content: `Fact: the ${subjects[index]} card belongs to ${subjects[(index + 2) % 5]}.`,
        kind: 'reference',
        importance: index + 1,
      })
    }
    const one = store.indexForPrompt({ maxTopics: 1 })
    assert.equal(one.included, 1)
    assert.equal(one.omitted, 4)
    const tiny = store.indexForPrompt({ maxChars: 60 })
    assert.ok(tiny.text.length <= 60)
    assert.ok(tiny.omitted >= 4)
  } finally {
    await cleanup(home)
  }
})

test('store: settings validation and pause/resume', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.setSettings({ quietSeconds: 45, autoExtract: false })
    assert.equal(store.settings.quietSeconds, 45)
    assert.equal(store.settings.autoExtract, false)
    assert.throws(() => store.setSettings({ nope: true }), error => error.code === 'invalid-request')
    assert.throws(() => store.setSettings({ quietSeconds: 1 }), error => error.code === 'invalid-request')
    assert.throws(() => store.setSettings({ autoExtract: 'yes' }), error => error.code === 'invalid-request')
    assert.throws(() => store.setSettings({ judgeProvider: 5 }), error => error.code === 'invalid-request')
    store.setSettings({ enabled: false })
    assert.equal(store.stats().paused, true)
    store.setSettings({ enabled: true })
    assert.equal(store.stats().paused, false)
  } finally {
    await cleanup(home)
  }
})

test('store: session opt-out, watermarks and hourly run counting', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    assert.equal(store.isSessionOptOut('sess-1'), false)
    store.setSessionOptOut('sess-1', true)
    assert.equal(store.isSessionOptOut('sess-1'), true)
    store.setSessionOptOut('sess-1', false)
    assert.equal(store.isSessionOptOut('sess-1'), false)

    assert.equal(store.getWatermark('sess-1'), undefined)
    store.setWatermark('sess-1', { seq: 7, chars: 120 })
    const watermark = store.getWatermark('sess-1')
    assert.equal(watermark.seq, 7)
    assert.equal(watermark.chars, 120)

    store.recordActivity({ sessionId: 'sess-1', trigger: 'quiet', status: 'ok', created: 1 })
    store.recordActivity({ sessionId: 'sess-1', trigger: 'manual', status: 'error', reason: 'boom' })
    assert.equal(store.runsInLastHour('sess-1'), 2)
    assert.equal(store.state.stats.runs, 2)
    assert.equal(store.state.stats.errors, 1)
    const activity = store.listActivity(1)
    assert.equal(activity.length, 1)
    assert.equal(activity[0].status, 'error')
  } finally {
    await cleanup(home)
  }
})

test('store: applyOperations applies creates/updates and rejects deletes', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const created = store.applyOperations([
      { op: 'create', title: 'Topic one', content: 'The first durable fact.', kind: 'reference' },
      { op: 'create', title: 'Topic two', content: 'The second durable fact.', kind: 'decision' },
      { op: 'delete', id: 'm_00000000' },
      { op: 'create', title: '', content: 'bad' },
      { op: 'nope' },
    ], { origin: 'auto', source: { sessionId: 's' } })
    assert.equal(created.created.length, 2)
    assert.equal(created.rejected.length, 3)
    assert.equal(created.rejected[0].op, 'delete')
    const update = store.applyOperations([
      { op: 'update', id: created.created[0].id, patch: { summary: 'Updated summary.', importance: 5 } },
    ], { origin: 'auto' })
    assert.equal(update.updated.length, 1)
    assert.equal(update.updated[0].summary, 'Updated summary.')
    assert.equal(update.updated[0].importance, 5)
  } finally {
    await cleanup(home)
  }
})

test('store: change listeners observe mutations and can be disposed', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    let events = 0
    const dispose = store.onChange(() => { events += 1 })
    createRecord(store)
    assert.ok(events >= 1)
    const before = events
    dispose()
    store.create({ title: 'Another topic', content: 'Another durable fact.' })
    assert.equal(events, before)
  } finally {
    await cleanup(home)
  }
})

test('store: quota archives low-value records without deleting pinned ones', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const now = new Date().toISOString()
    for (let index = 0; index < MAX_ACTIVE_RECORDS + 5; index += 1) {
      store.memories.push({
        id: `m_${index.toString(16).padStart(8, '0')}`,
        title: `Bulk topic ${index}`,
        summary: 'bulk',
        content: `Bulk content ${index}`,
        kind: 'reference',
        scope: 'global',
        project: null,
        tags: [],
        importance: 1,
        pinned: index === 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        revision: 1,
        source: { origin: 'manual' },
      })
    }
    const archived = store.enforceQuota()
    assert.equal(archived, 5)
    assert.equal(store.memories.filter(record => record.status === 'active').length, MAX_ACTIVE_RECORDS)
    assert.equal(store.memories[0].status, 'active')
  } finally {
    await cleanup(home)
  }
})

test('store: persists records, settings, watermarks and the markdown mirror', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    createRecord(store)
    store.setSettings({ autoExtract: false })
    store.setSessionOptOut('sess-2', true)
    store.setWatermark('sess-1', { seq: 3, chars: 42 })
    await store.flush()

    const reloaded = new MemoryStore({ stateStore: new StateStore({ home }), logger: silentLogger() })
    await reloaded.load()
    assert.equal(reloaded.memories.length, 1)
    assert.equal(reloaded.memories[0].title, 'User prefers pnpm')
    assert.equal(reloaded.settings.autoExtract, false)
    assert.equal(reloaded.isSessionOptOut('sess-2'), true)
    assert.equal(reloaded.getWatermark('sess-1').seq, 3)

    const root = join(home, 'dsh-memory')
    const mirror = await readFile(join(root, 'MEMORY.md'), 'utf8')
    assert.match(mirror, /# dsh-memory/)
    assert.match(mirror, /User prefers pnpm/)
    const audit = await readFile(join(root, 'audit.jsonl'), 'utf8')
    assert.ok(audit.trim().split('\n').length >= 1)
    const raw = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.memories.length, 1)
  } finally {
    await cleanup(home)
  }
})

test('store: renderMirror groups global and project topics', () => {
  const state = {
    memories: [
      {
        id: 'm_11111111',
        title: 'Global preference',
        summary: 'summary',
        content: 'body',
        kind: 'preference',
        scope: 'global',
        project: null,
        tags: [],
        importance: 3,
        pinned: false,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        source: { origin: 'manual' },
      },
      {
        id: 'm_22222222',
        title: 'Project fact',
        summary: 'summary',
        content: 'body',
        kind: 'project',
        scope: 'project',
        project: { key: '/repos/a', name: 'alpha' },
        tags: ['vitest'],
        importance: 2,
        pinned: true,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        revision: 2,
        source: { origin: 'auto' },
      },
    ],
  }
  const mirror = renderMirror(state)
  assert.match(mirror, /## Global/)
  assert.match(mirror, /## Project: alpha/)
  assert.match(mirror, /Project fact/)
})
