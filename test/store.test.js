/**
 * Unit tests for lib/store.js — Markdown topic collections, global/project
 * routing, migration, monitoring and merged prompt indexes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, MAX_ACTIVE_RECORDS, PROJECT_MEMORY_DIR } from '../lib/store.js'
import { StateStore } from '../lib/state.js'
import { cleanup, makeHome, makeStore, silentLogger, waitFor } from './helpers.js'

/**
 * @returns {Promise<string>} a temporary workspace directory.
 */
async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
}

/**
 * @param {MemoryStore} store - hub.
 * @param {string} workspace - project key.
 * @param {Record<string, any>} [overrides] - create input.
 * @returns {Record<string, any>} created record.
 */
function createProjectRecord(store, workspace, overrides = {}) {
  return store.create({
    title: 'Project fact',
    content: 'The staging deployment target is tatooine.',
    kind: 'project',
    scope: 'project',
    project: { key: workspace, name: 'ws' },
    ...overrides,
  }, { origin: 'manual', source: { sessionId: 'sess-1' } }).record
}

test('store: global records live in the harness directory as Markdown topics', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const record = store.create({
      title: 'User prefers pnpm',
      content: 'The user always uses pnpm for Node.js projects.',
      kind: 'preference',
      scope: 'global',
      importance: 4,
      tags: ['pnpm'],
    }, { origin: 'manual', source: { sessionId: 's-1' } }).record
    await store.flush()

    const root = join(home, 'dsh-memory')
    const files = await readdir(root)
    const topicFile = files.find(name => name.startsWith(record.id))
    assert.ok(topicFile !== undefined && topicFile.endsWith('.md'))
    const body = await readFile(join(root, topicFile), 'utf8')
    assert.match(body, /^---\n/u)
    assert.match(body, /title: "User prefers pnpm"/u)
    assert.match(body, /kind: "preference"/u)
    assert.match(body, /modified: "/u)
    assert.match(body, /The user always uses pnpm/u)
    assert.ok(files.includes('MEMORY.md'))
    assert.ok(files.includes('state.json'))
    assert.ok(files.includes('audit.jsonl'))
    const index = await readFile(join(root, 'MEMORY.md'), 'utf8')
    assert.match(index, /\[User prefers pnpm\]/u)
    assert.match(index, /m_/u)

    assert.equal(store.memories.length, 1)
    assert.equal(store.state.memories, undefined)
    assert.equal(store.list({ status: 'all' }).total, 1)
  } finally {
    await cleanup(home)
  }
})

test('store: project records live inside the workspace and are injected only there', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  const other = await makeWorkspace()
  try {
    const store = await makeStore(home)
    const record = createProjectRecord(store, workspace)
    await store.flush()

    const projectDir = join(workspace, '.dsh', 'dsh-memory')
    const files = await readdir(projectDir)
    assert.ok(files.some(name => name.startsWith(record.id)))
    assert.ok(files.includes('MEMORY.md'))
    assert.equal(store.state.projects[workspace].name, 'ws')
    assert.equal(store.state.projects[workspace].memoryDir, projectDir)

    const thisProject = store.indexForPrompt({ projectKey: workspace })
    assert.match(thisProject.text, /Project memory/u)
    assert.match(thisProject.text, /staging deployment target/u)
    const otherProject = store.indexForPrompt({ projectKey: other })
    assert.doesNotMatch(otherProject.text, /staging deployment target/u)
    assert.equal(otherProject.included, 0)

    // Global memory appears in both.
    store.create({ title: 'Global', content: 'Global preference.', kind: 'preference' })
    assert.match(store.indexForPrompt({ projectKey: workspace }).text, /Global memory/u)
    assert.match(store.indexForPrompt({ projectKey: other }).text, /Global memory/u)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('store: duplicate detection is scoped per collection', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  const other = await makeWorkspace()
  try {
    const store = await makeStore(home)
    const first = store.create({
      title: 'Deploy target',
      content: 'Staging is tatooine.',
      kind: 'project',
      scope: 'global',
    }).record
    const merged = store.create({
      title: 'Deploy target',
      content: 'Staging is tatooine (confirmed).',
      kind: 'project',
      scope: 'global',
    })
    assert.equal(merged.action, 'merged')
    assert.equal(merged.record.id, first.id)
    assert.equal(merged.record.revision, 2)

    const projectA = createProjectRecord(store, workspace, { title: 'Deploy target' })
    const projectB = createProjectRecord(store, other, { title: 'Deploy target' })
    assert.notEqual(projectA.id, projectB.id)
    assert.equal(store.memories.length, 3)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('store: update, pin, remove and clear route through the owning collection', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const store = await makeStore(home)
    const global = store.create({ title: 'Global', content: 'Global body.' }).record
    const project = createProjectRecord(store, workspace)

    store.update(project.id, { content: 'Updated project body.' }, { projectKey: workspace })
    assert.equal(store.get(project.id, { projectKey: workspace }).content, 'Updated project body.')
    store.setPinned(project.id, true, { projectKey: workspace })
    assert.equal(store.get(project.id, { projectKey: workspace }).pinned, true)

    const pinFile = await readFile(join(workspace, '.dsh', 'dsh-memory', store.toListItem(store.get(project.id)).file), 'utf8')
    assert.match(pinFile, /pinned: true/u)

    store.remove(global.id)
    assert.equal(store.get(global.id), undefined)
    assert.equal(store.memories.length, 1)

    store.clear()
    assert.equal(store.memories.length, 0)
    const projectFiles = (await readdir(join(workspace, '.dsh', 'dsh-memory')))
      .filter(name => name.endsWith('.md') && name !== 'MEMORY.md')
    assert.equal(projectFiles.length, 0)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: topic files are authoritative; generated index edits are ignored', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const store = await makeStore(home)
    const record = createProjectRecord(store, workspace)
    const dir = join(workspace, '.dsh', 'dsh-memory')
    const filename = store.toListItem(record).file
    const topicPath = join(dir, filename)

    // Edit the topic file externally.
    const original = await readFile(topicPath, 'utf8')
    await writeFile(topicPath, original.split('tatooine').join('coruscant'), 'utf8')
    store.lastRefreshCheck = 0
    store.refreshIfStale()
    assert.match(store.get(record.id, { projectKey: workspace }).content, /coruscant/u)

    // Replacing MEMORY.md with junk does not delete the record.
    await writeFile(join(dir, 'MEMORY.md'), 'garbage\n', 'utf8')
    store.lastRefreshCheck = 0
    store.refreshIfStale()
    assert.equal(store.get(record.id, { projectKey: workspace }).title, 'Project fact')
    const regenerated = await readFile(join(dir, 'MEMORY.md'), 'utf8')
    assert.match(regenerated, /Project fact/u)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: a watched project reloads on external file changes', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const store = await makeStore(home)
    store.acquireProject({ key: workspace, name: 'ws' })
    const record = createProjectRecord(store, workspace)
    const dir = join(workspace, '.dsh', 'dsh-memory')
    const topicPath = join(dir, store.toListItem(record).file)
    const original = await readFile(topicPath, 'utf8')
    await writeFile(topicPath, original.split('tatooine').join('mustafar'), 'utf8')
    await waitFor(() => store.get(record.id, { projectKey: workspace })?.content.includes('mustafar'), { timeoutMs: 5000 })
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: v1 memory.json migrates into global and project Markdown files', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const root = join(home, 'dsh-memory')
    await mkdir(root, { recursive: true })
    const legacy = {
      version: 1,
      settings: { quietSeconds: 45, enabled: true },
      memories: [
        {
          id: 'm_11111111', title: 'Global legacy', summary: 'g', content: 'Global body.',
          kind: 'preference', scope: 'global', project: null, tags: [], importance: 3,
          pinned: false, status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z', revision: 1, source: { origin: 'tool' },
        },
        {
          id: 'm_22222222', title: 'Project legacy', summary: 'p', content: 'Project body.',
          kind: 'project', scope: 'project', project: { key: workspace, name: 'ws' }, tags: [],
          importance: 4, pinned: false, status: 'active', createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z', revision: 2, source: { origin: 'auto' },
        },
      ],
      watermarks: { 'sess-1': { seq: 5, at: '2026-01-01T00:00:00.000Z', chars: 20 } },
      sessionOptOut: {},
      activity: [],
      stats: { created: 2, updated: 1, deleted: 0, runs: 1, errors: 0 },
    }
    await writeFile(join(root, 'memory.json'), JSON.stringify(legacy), 'utf8')

    const store = new MemoryStore({ stateStore: new StateStore({ home }), logger: silentLogger() })
    await store.load()
    await store.flush()

    const rootFiles = await readdir(root)
    assert.ok(rootFiles.some(name => name.startsWith('memory.json.migrated-')))
    assert.ok(rootFiles.includes('state.json'))
    assert.ok(rootFiles.some(name => name.startsWith('m_11111111')))
    const projectFiles = await readdir(join(workspace, '.dsh', 'dsh-memory'))
    assert.ok(projectFiles.some(name => name.startsWith('m_22222222')))
    assert.equal(store.state.version, 2)
    assert.equal(store.state.stats.migrated, 2)
    assert.equal(store.state.watermarks['sess-1'].seq, 5)
    assert.equal(store.state.settings.quietSeconds, 45)
    assert.equal(store.state.projects[workspace].name, 'ws')
    assert.equal(store.indexForPrompt({ projectKey: workspace }).included, 2)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: known projects load read-only and clearing removes both scopes', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const store = await makeStore(home)
    store.create({ title: 'Global', content: 'Global body.' })
    createProjectRecord(store, workspace)
    await store.flush()

    const reloaded = new MemoryStore({ stateStore: new StateStore({ home }), logger: silentLogger() })
    await reloaded.load()
    assert.equal(reloaded.memories.length, 1)
    const known = reloaded.loadKnownProjects()
    assert.equal(known.length, 1)
    assert.equal(known[0].key, workspace)
    assert.equal(reloaded.memories.length, 2)
    const listed = reloaded.list({ status: 'all' }).items
    assert.ok(listed.some(record => record.scope === 'project'))
    const projectItem = listed.find(record => record.scope === 'project')
    assert.equal(reloaded.toListItem(projectItem).memoryDir, join(workspace, PROJECT_MEMORY_DIR))

    assert.equal(reloaded.clear().count, 2)
    assert.equal(reloaded.memories.length, 0)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: independent global and project prompt budgets', async () => {
  const home = await makeHome()
  const workspace = await makeWorkspace()
  try {
    const store = await makeStore(home)
    const globalTopics = [
      'The office espresso machine is cleaned every Friday afternoon by the facilities team.',
      'Quarterly budget reviews happen on the second Tuesday of each month at ten in the morning.',
      'The backup generator in building seven is tested during the first week of every quarter.',
      'Customer interviews are transcribed with the vendor approved by the legal department.',
    ]
    for (const topic of globalTopics) {
      store.create({ title: topic.slice(0, 40), content: topic, kind: 'reference' })
    }
    const projectTopics = [
      'Saffron routers route analytics traffic through the dedicated staging gateway.',
      'Tundra proxies terminate TLS certificates before requests reach application pods.',
      'Cobalt ledgers retain seven years of audit entries in cold object storage.',
      'Willow beacons synchronize deployment clocks across the multi-region cluster.',
    ]
    for (const topic of projectTopics) {
      createProjectRecord(store, workspace, { title: topic.slice(0, 40), content: topic })
    }
    store.setSettings({ maxTopicsInPrompt: 2, projectMaxTopicsInPrompt: 3 })
    const index = store.indexForPrompt({ projectKey: workspace })
    assert.equal(index.included, 5)
    assert.match(index.text, /2 more global topics/u)
    assert.match(index.text, /1 more project topics/u)
  } finally {
    await cleanup(home)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('store: quota archives low-value records inside one collection', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const collection = store.globalCollection
    const now = new Date().toISOString()
    for (let index = 0; index < MAX_ACTIVE_RECORDS + 3; index += 1) {
      collection.records.push({
        id: `m_${index.toString(16).padStart(8, '0')}`,
        title: `Bulk ${index}`,
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
    const archived = store.enforceQuota(collection)
    assert.equal(archived, 3)
    assert.equal(collection.records.filter(record => record.status === 'active').length, MAX_ACTIVE_RECORDS)
    assert.equal(collection.records[0].status, 'active')
  } finally {
    await cleanup(home)
  }
})

test('store: change listeners and activity/watermark state', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    let events = 0
    const dispose = store.onChange(() => { events += 1 })
    store.create({ title: 'Observed', content: 'Observed body.' })
    assert.ok(events >= 1)
    store.recordActivity({ trigger: 'manual', status: 'ok', created: 1, projectKey: '/tmp/ws' })
    assert.equal(store.state.activity[0].projectKey, '/tmp/ws')
    store.setWatermark('sess-1', { seq: 4, chars: 12 })
    assert.equal(store.getWatermark('sess-1').seq, 4)
    store.setSessionOptOut('sess-1', true)
    assert.equal(store.isSessionOptOut('sess-1'), true)
    const before = events
    dispose()
    store.create({ title: 'After dispose', content: 'No listener.' })
    assert.equal(events, before)
  } finally {
    await cleanup(home)
  }
})

test('store: loaded projects never leak into another project index', async () => {
  const home = await makeHome()
  const workspaceA = await makeWorkspace()
  const workspaceB = await makeWorkspace()
  try {
    const store = await makeStore(home)
    createProjectRecord(store, workspaceA, {
      title: 'Alpha rollout',
      content: 'Saffron routers terminate analytics traffic in the alpha cluster.',
    })
    createProjectRecord(store, workspaceB, {
      title: 'Beta rollout',
      content: 'Tundra proxies terminate analytics traffic in the beta cluster.',
    })
    // Both collections are loaded (as the settings page does for known projects).
    store.loadKnownProjects()
    assert.ok(store.projects.size >= 2)
    const alpha = store.indexForPrompt({ projectKey: workspaceA })
    const beta = store.indexForPrompt({ projectKey: workspaceB })
    assert.match(alpha.text, /Saffron routers/u)
    assert.doesNotMatch(alpha.text, /Tundra proxies/u)
    assert.match(beta.text, /Tundra proxies/u)
    assert.doesNotMatch(beta.text, /Saffron routers/u)
    const betaRecord = store.list({ projectKey: workspaceB, status: 'all' }).items
      .find(record => record.scope === 'project')
    assert.ok(betaRecord !== undefined)
    assert.equal(store.get(betaRecord.id, { projectKey: workspaceA }), undefined)
  } finally {
    await cleanup(home)
    await rm(workspaceA, { recursive: true, force: true })
    await rm(workspaceB, { recursive: true, force: true })
  }
})
