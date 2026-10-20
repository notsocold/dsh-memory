import test from 'node:test'
import assert from 'node:assert/strict'
import { apiRoutes, API_PREFIX } from '../lib/api.js'
import { cleanup, makeHome, makeStore } from './helpers.js'

/**
 * @param {{
 *   store: import('../lib/store.js').MemoryStore,
 *   extractor?: Record<string, any>,
 *   resolveSessionContext?: Function,
 *   listLiveSessions?: Function,
 * }} options - route dependencies.
 * @returns {Record<string, any>[]} routes.
 */
function buildRoutes(options) {
  return apiRoutes({
    store: options.store,
    extractor: options.extractor ?? { extractNow: async () => ({ status: 'ok', created: 1, updated: 0, skipped: 0 }) },
    resolveSessionContext: options.resolveSessionContext ?? (async id => (id === 'sess-1'
      ? { live: true, cwd: '/repos/a', project: { key: '/repos/a', name: 'a' } }
      : { live: false })),
    listLiveSessions: options.listLiveSessions ?? (async () => [{
      sessionId: 'sess-1', title: 'Live session', status: 'idle', optedOut: false,
    }]),
  })
}

/**
 * @param {Record<string, any>} route - route object.
 * @param {string} [url] - request URL.
 * @param {Record<string, any>} [init] - request init.
 * @returns {Promise<{ status: number, body: Record<string, any> }>}
 */
async function call(route, url = 'http://dsh.invalid/api/dsh-memory/state', init = {}) {
  const response = await route.fetch(new Request(url, init))
  return { status: response.status, body: await response.json() }
}

/**
 * @param {Record<string, any>} route - action route.
 * @param {Record<string, any>} body - JSON body.
 * @returns {Promise<{ status: number, body: Record<string, any> }>}
 */
function action(route, body) {
  return call(route, `http://dsh.invalid${API_PREFIX}/action`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

test('api: state returns settings, summaries, activity and live sessions', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.create({ title: 'Preference', content: 'The user prefers pnpm with a long body that must not be listed.', kind: 'preference' })
    const routes = buildRoutes({ store })
    const { status, body } = await call(routes[0], 'http://dsh.invalid/api/dsh-memory/state?sessionId=sess-1')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.memories.length, 1)
    assert.equal(body.value.memories[0].content, undefined)
    assert.equal(body.value.memories[0].title, 'Preference')
    assert.equal(body.value.session.id, 'sess-1')
    assert.equal(body.value.session.project.key, '/repos/a')
    assert.equal(body.value.liveSessions.length, 1)
    assert.deepEqual(body.value.settings.enabled, true)
    assert.equal(typeof body.value.stats.active, 'number')

    const anonymous = await call(routes[0])
    assert.equal(anonymous.body.value.session.optedOut, false)
    assert.equal(anonymous.body.value.session.project, undefined)
  } finally {
    await cleanup(home)
  }
})

test('api: memory detail serves the body and reports missing ids', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const record = store.create({ title: 'Detail', content: 'Full body text.', kind: 'reference' }).record
    const routes = buildRoutes({ store })
    const ok = await call(routes[1], `http://dsh.invalid${API_PREFIX}/memory?id=${record.id}`)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.value.content, 'Full body text.')

    const missingParam = await call(routes[1], `http://dsh.invalid${API_PREFIX}/memory`)
    assert.equal(missingParam.status, 400)
    const unknown = await call(routes[1], `http://dsh.invalid${API_PREFIX}/memory?id=m_00000000`)
    assert.equal(unknown.status, 200)
    assert.equal(unknown.body.ok, false)
    assert.equal(unknown.body.error.code, 'not-found')
  } finally {
    await cleanup(home)
  }
})

test('api: create/update/delete/pin actions mutate the store', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const route = buildRoutes({ store })[2]
    const created = await action(route, {
      action: 'create', sessionId: 'sess-1', title: 'Topic', content: 'Body', kind: 'preference', importance: 4,
    })
    assert.equal(created.body.ok, true)
    const id = created.body.value.record.id
    assert.equal(store.memories.length, 1)
    assert.equal(created.body.value.record.content, undefined)

    const updated = await action(route, { action: 'update', id, content: 'Updated body' })
    assert.equal(updated.body.ok, true)
    assert.equal(store.get(id).content, 'Updated body')

    const pinned = await action(route, { action: 'pin', id })
    assert.equal(pinned.body.ok, true)
    assert.equal(store.get(id).pinned, true)
    const unpinned = await action(route, { action: 'unpin', id })
    assert.equal(unpinned.body.ok, true)
    assert.equal(store.get(id).pinned, false)

    const deleted = await action(route, { action: 'delete', id })
    assert.equal(deleted.body.ok, true)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('api: project-scoped create requires a project and accepts an explicit one', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const route = buildRoutes({ store, resolveSessionContext: async () => ({ live: false }) })[2]
    const missing = await action(route, {
      action: 'create', title: 'Project topic', content: 'Body', kind: 'project', scope: 'project',
    })
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.error.code, 'invalid-request')

    const explicit = await action(route, {
      action: 'create',
      title: 'Project topic',
      content: 'Body',
      kind: 'project',
      scope: 'project',
      project: { key: '/repos/explicit', name: 'explicit' },
    })
    assert.equal(explicit.body.ok, true)
    assert.equal(store.memories[0].project.key, '/repos/explicit')
  } finally {
    await cleanup(home)
  }
})

test('api: malformed requests are rejected with 400', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const route = buildRoutes({ store })[2]
    const badJson = await call(route, `http://dsh.invalid${API_PREFIX}/action`, { method: 'POST', body: '{nope' })
    assert.equal(badJson.status, 400)
    const notObject = await call(route, `http://dsh.invalid${API_PREFIX}/action`, { method: 'POST', body: '[]' })
    assert.equal(notObject.status, 400)
    const unknown = await action(route, { action: 'explode' })
    assert.equal(unknown.status, 200)
    assert.equal(unknown.body.error.code, 'invalid-request')
  } finally {
    await cleanup(home)
  }
})

test('api: pause/resume, settings, opt-out, clear and export', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.create({ title: 'Keeper', content: 'Body kept until clear.' })
    const route = buildRoutes({ store })[2]

    const paused = await action(route, { action: 'pause' })
    assert.equal(paused.body.ok, true)
    assert.equal(store.settings.enabled, false)
    const resumed = await action(route, { action: 'resume' })
    assert.equal(resumed.body.ok, true)
    assert.equal(store.settings.enabled, true)

    const settings = await action(route, { action: 'setSettings', settings: { quietSeconds: 12 } })
    assert.equal(settings.body.ok, true)
    assert.equal(store.settings.quietSeconds, 12)
    const badSettings = await action(route, { action: 'setSettings', settings: { quietSeconds: 1 } })
    assert.equal(badSettings.body.error.code, 'invalid-request')

    const optOut = await action(route, { action: 'setSessionOptOut', sessionId: 'sess-1', value: true })
    assert.equal(optOut.body.ok, true)
    assert.equal(store.isSessionOptOut('sess-1'), true)
    const missingSession = await action(route, { action: 'setSessionOptOut', value: true })
    assert.equal(missingSession.body.error.code, 'invalid-request')

    const exported = await action(route, { action: 'export' })
    assert.equal(exported.body.ok, true)
    assert.equal(exported.body.value.memories.length, 1)
    assert.equal(exported.body.value.memories[0].content, 'Body kept until clear.')

    const refused = await action(route, { action: 'clear' })
    assert.equal(refused.body.error.code, 'invalid-request')
    const cleared = await action(route, { action: 'clear', confirm: true })
    assert.equal(cleared.body.ok, true)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('api: extractNow requires a live session and forwards the trigger', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const calls = []
    const extractor = {
      async extractNow(sessionId, options) {
        calls.push({ sessionId, options })
        return { status: 'ok', created: 2, updated: 1, skipped: 0 }
      },
    }
    const dead = buildRoutes({ store, extractor, resolveSessionContext: async () => ({ live: false }) })[2]
    const deadResult = await action(dead, { action: 'extractNow', sessionId: 'sess-x' })
    assert.equal(deadResult.body.error.code, 'session-not-live')

    const live = buildRoutes({ store, extractor })[2]
    const liveResult = await action(live, { action: 'extractNow', sessionId: 'sess-1' })
    assert.equal(liveResult.body.ok, true)
    assert.equal(liveResult.body.value.result.created, 2)
    assert.deepEqual(calls, [{ sessionId: 'sess-1', options: { trigger: 'manual' } }])
  } finally {
    await cleanup(home)
  }
})

test('api: unexpected route failures report an internal error', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const routes = buildRoutes({
      store,
      resolveSessionContext: async () => { throw new Error('boom') },
    })
    const response = await call(routes[0], 'http://dsh.invalid/api/dsh-memory/state')
    assert.equal(response.status, 500)
    assert.equal(response.body.error.code, 'internal')
    assert.match(response.body.error.message, /boom/u)
  } finally {
    await cleanup(home)
  }
})
