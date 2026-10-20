import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createMemoryTool, agentContext, formatRecordDetail } from '../lib/tools.js'
import { cleanup, makeHome, makeStore } from './helpers.js'

/**
 * @param {string} root - temporary root.
 * @returns {Promise<string>} a directory that looks like a git project checkout.
 */
async function makeProject(root) {
  const project = join(root, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  return project
}

/**
 * @param {string} cwd - session working directory.
 * @param {string} [sessionId] - session id.
 * @returns {{ exec: Record<string, any> }}
 */
function makeExec(cwd, sessionId = 'sess-1') {
  return {
    exec: {
      agent: {
        id: sessionId,
        session: { header: { cwd } },
        status: 'idle',
      },
    },
  }
}

/**
 * @param {{
 *   store: import('../lib/store.js').MemoryStore,
 *   extractor?: Record<string, any>,
 * }} options - tool dependencies.
 * @returns {Record<string, any>} tool definition.
 */
function makeTool(options) {
  return createMemoryTool({
    store: options.store,
    extractor: options.extractor ?? { extractNow: async () => ({ status: 'ok', created: 1, updated: 0, skipped: 0 }) },
  })
}

test('tools: schema and render expose the memory operations', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const tool = makeTool({ store })
    assert.equal(tool.name, 'memory')
    assert.deepEqual(tool.parameters.properties.action.enum, ['search', 'get', 'list', 'save', 'update', 'forget', 'extract'])
    const rendered = tool.output.render({ action: 'list' }, { ok: true, message: 'Done', details: 'Detail line' })
    assert.deepEqual(rendered, [{ type: 'text', text: 'Done\n\nDetail line' }])
  } finally {
    await cleanup(home)
  }
})

test('tools: save/search/get/list round-trip and redact credentials', async () => {
  const home = await makeHome()
  try {
    const cwd = await makeProject(home)
    const store = await makeStore(home)
    const tool = makeTool({ store })
    const { exec } = makeExec(cwd)

    const saved = await tool.execute({
      action: 'save',
      title: 'Deploy token',
      content: 'Staging deploy uses token=sk-abcdefghijklmnopqrstuvwxyz012345 and host tatooine.',
      kind: 'project',
      scope: 'project',
      importance: 4,
      tags: ['deploy'],
    }, exec)
    assert.equal(saved.ok, true)
    assert.equal(store.memories.length, 1)
    assert.equal(store.memories[0].project.key, cwd)
    assert.match(store.memories[0].content, /\[REDACTED\]/u)
    assert.doesNotMatch(store.memories[0].content, /sk-abcdefghijklmnopqrstuvwxyz/u)

    const duplicate = await tool.execute({
      action: 'save',
      title: 'Deploy token',
      content: 'Staging deploy uses token=sk-abcdefghijklmnopqrstuvwxyz012345 and host tatooine.',
      kind: 'project',
      scope: 'project',
    }, exec)
    assert.match(duplicate.message, /Merged into existing memory/u)
    assert.equal(store.memories.length, 1)

    const search = await tool.execute({ action: 'search', query: 'tatooine' }, exec)
    assert.equal(search.ok, true)
    assert.equal(search.ids.length, 1)
    const emptySearch = await tool.execute({ action: 'search', query: 'nothing-matches-this' }, exec)
    assert.equal(emptySearch.ids.length, 0)

    const id = store.memories[0].id
    const got = await tool.execute({ action: 'get', id }, exec)
    assert.match(got.details, /# Deploy token/u)
    assert.match(got.details, /Staging deploy/u)
    await assert.rejects(tool.execute({ action: 'get', id: 'm_00000000' }, exec), error => error.code === 'not-found')

    const listed = await tool.execute({ action: 'list' }, exec)
    assert.equal(listed.ids.length, 1)
    store.update(id, { status: 'archived' })
    assert.equal((await tool.execute({ action: 'list' }, exec)).ids.length, 0)
    assert.equal((await tool.execute({ action: 'list', status: 'all' }, exec)).ids.length, 1)
  } finally {
    await cleanup(home)
  }
})

test('tools: update and forget follow the settings switches', async () => {
  const home = await makeHome()
  try {
    const cwd = await makeProject(home)
    const store = await makeStore(home)
    const tool = makeTool({ store })
    const { exec } = makeExec(cwd)
    const saved = await tool.execute({ action: 'save', title: 'Topic', content: 'Body text.' }, exec)
    const id = saved.ids[0]
    const updated = await tool.execute({ action: 'update', id, content: 'New body text.', importance: 5 }, exec)
    assert.equal(updated.ok, true)
    assert.equal(store.get(id).content, 'New body text.')
    assert.equal(store.get(id).importance, 5)

    store.setSettings({ allowModelDelete: false })
    await assert.rejects(tool.execute({ action: 'forget', id }, exec), error => error.code === 'disabled')
    store.setSettings({ allowModelDelete: true })
    const forgotten = await tool.execute({ action: 'forget', id }, exec)
    assert.equal(forgotten.ok, true)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('tools: disabled memory and opted-out sessions reject reads and writes', async () => {
  const home = await makeHome()
  try {
    const cwd = await makeProject(home)
    const store = await makeStore(home)
    const tool = makeTool({ store })
    const { exec } = makeExec(cwd)
    store.setSessionOptOut('sess-1', true)
    await assert.rejects(tool.execute({ action: 'save', title: 'T', content: 'C' }, exec), error => error.code === 'disabled')
    store.setSessionOptOut('sess-1', false)
    store.setSettings({ enabled: false })
    await assert.rejects(tool.execute({ action: 'search', query: 'x' }, exec), error => error.code === 'disabled')
    await assert.rejects(tool.execute({ action: 'list' }, exec), error => error.code === 'disabled')
  } finally {
    await cleanup(home)
  }
})

test('tools: extract runs even while memory is paused and reports the result', async () => {
  const home = await makeHome()
  try {
    const cwd = await makeProject(home)
    const store = await makeStore(home)
    store.setSettings({ enabled: false })
    const triggers = []
    const tool = makeTool({
      store,
      extractor: {
        async extractNow(agent, options) {
          triggers.push({ agentId: agent.id, options })
          return { status: 'ok', created: 2, updated: 1, skipped: 0 }
        },
      },
    })
    const result = await tool.execute({ action: 'extract' }, makeExec(cwd).exec)
    assert.equal(result.ok, true)
    assert.match(result.message, /2 created, 1 updated/u)
    assert.deepEqual(triggers, [{ agentId: 'sess-1', options: { trigger: 'tool-extract' } }])
  } finally {
    await cleanup(home)
  }
})

test('tools: missing action or agent is rejected', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const tool = makeTool({ store })
    await assert.rejects(tool.execute({}, { agent: { id: 's' } }), error => error.code === 'invalid-request')
    await assert.rejects(
      tool.execute({ action: 'list' }, {}),
      error => error.code === 'invalid-request' && /live agent/u.test(error.message),
    )
  } finally {
    await cleanup(home)
  }
})

test('tools: agentContext resolves the project and detail rendering includes metadata', async () => {
  const home = await makeHome()
  try {
    const cwd = await makeProject(home)
    const agent = { id: 'sess-9', session: { header: { cwd } } }
    const context = agentContext(agent)
    assert.equal(context.sessionId, 'sess-9')
    assert.equal(context.cwd, cwd)
    assert.equal(context.project.key, cwd)
    const record = {
      id: 'm_11111111',
      title: 'Title',
      summary: 'Summary',
      content: 'Body',
      kind: 'preference',
      scope: 'global',
      project: null,
      tags: ['tag'],
      importance: 3,
      pinned: true,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      revision: 2,
      source: { origin: 'auto', sessionTitle: 'Chat' },
    }
    const detail = formatRecordDetail(record)
    assert.match(detail, /# Title/u)
    assert.match(detail, /pinned/u)
    assert.match(detail, /tags: tag/u)
    assert.match(detail, /session "Chat"/u)
    assert.match(detail, /^Body$/mu)
  } finally {
    await cleanup(home)
  }
})
