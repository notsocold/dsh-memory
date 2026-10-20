import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND_HELP, COMMAND_NAME, describeStatus, runMemoryCommand } from '../lib/commands.js'
import { cleanup, makeHome, makeStore } from './helpers.js'

/**
 * @param {import('../lib/store.js').MemoryStore} store - library.
 * @param {{ result?: Record<string, any>, calls?: Record<string, any>[] }} [options] - extractor behavior.
 * @returns {{ extractor: Record<string, any>, calls: Record<string, any>[] }}
 */
function makeExtractor(options = {}) {
  const calls = options.calls ?? []
  return {
    calls,
    extractor: {
      async extractNow(agent, opts) {
        calls.push({ agentId: agent?.id, options: opts })
        return options.result ?? { status: 'ok', created: 2, updated: 1, skipped: 0 }
      },
    },
  }
}

test('commands: schema exposes one /memory command', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const { extractor } = makeExtractor()
    const { createMemoryCommands } = await import('../lib/commands.js')
    const [definition] = createMemoryCommands({ store, extractor })
    assert.equal(definition.name, COMMAND_NAME)
    assert.match(definition.description, /persistent memory/u)
    assert.equal(typeof definition.handler, 'function')
  } finally {
    await cleanup(home)
  }
})

test('commands: status, help and default subcommand', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.create({ title: 'Preference', content: 'Prefers pnpm.', kind: 'preference', importance: 4 })
    const { extractor } = makeExtractor()
    const status = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: '' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /Persistent memory status/u)
    assert.match(status.text, /1 active/u)
    const help = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'help' })
    assert.equal(help.kind, 'success')
    assert.match(help.text, /Usage: \/memory/u)
    const described = describeStatus(store)
    assert.match(described, /auto extraction/u)
    assert.equal(COMMAND_HELP.includes('extract'), true)
    const unknown = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'wat' })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /Unknown subcommand/u)
  } finally {
    await cleanup(home)
  }
})

test('commands: list and search render topics and reject missing queries', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.create({ title: 'pnpm preference', content: 'The user always uses pnpm.', kind: 'preference' })
    store.create({ title: 'deploy target', content: 'Staging host is tatooine.', kind: 'project' })
    const { extractor } = makeExtractor()
    const list = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'list' })
    assert.equal(list.kind, 'success')
    assert.match(list.text, /pnpm preference/u)
    assert.match(list.text, /deploy target/u)
    const filtered = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'list deploy' })
    assert.match(filtered.text, /deploy target/u)
    assert.doesNotMatch(filtered.text, /pnpm preference/u)
    const search = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'search pnpm' })
    assert.match(search.text, /pnpm preference/u)
    const missing = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'search' })
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /Usage: \/memory search/u)
  } finally {
    await cleanup(home)
  }
})

test('commands: pause and resume toggle the persisted setting', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const { extractor } = makeExtractor()
    const paused = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'pause' })
    assert.equal(paused.kind, 'success')
    assert.equal(store.settings.enabled, false)
    const resumed = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'resume' })
    assert.equal(resumed.kind, 'success')
    assert.equal(store.settings.enabled, true)
  } finally {
    await cleanup(home)
  }
})

test('commands: extract requires a live agent and reports the extractor result', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const agent = { id: 'sess-1' }
    const { extractor, calls } = makeExtractor()
    const missingAgent = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'extract' })
    assert.equal(missingAgent.kind, 'error')
    const result = await runMemoryCommand({ store, extractor, agent, rawInput: 'extract' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /2 created, 1 updated/u)
    assert.deepEqual(calls, [{ agentId: 'sess-1', options: { trigger: 'manual' } }])

    const failing = makeExtractor({ result: { status: 'error', reason: 'provider down' } })
    const failed = await runMemoryCommand({ store, extractor: failing.extractor, agent, rawInput: 'extract' })
    assert.match(failed.text, /failed: provider down/u)
    const skipping = makeExtractor({ result: { status: 'skipped', reason: 'nothing new' } })
    const skipped = await runMemoryCommand({ store, extractor: skipping.extractor, agent, rawInput: 'extract' })
    assert.match(skipped.text, /skipped: nothing new/u)
  } finally {
    await cleanup(home)
  }
})

test('commands: forget, pin and unpin mutate records and surface errors', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const record = store.create({ title: 'Topic', content: 'Body.' }).record
    const { extractor } = makeExtractor()
    const pinned = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: `pin ${record.id}` })
    assert.equal(pinned.kind, 'success')
    assert.equal(store.get(record.id).pinned, true)
    const unpinned = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: `unpin ${record.id}` })
    assert.match(unpinned.text, /Unpinned/u)
    assert.equal(store.get(record.id).pinned, false)
    const missingId = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'forget' })
    assert.equal(missingId.kind, 'error')
    const forgotten = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: `forget ${record.id}` })
    assert.equal(forgotten.kind, 'success')
    assert.equal(store.memories.length, 0)
    await assert.rejects(
      runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'forget m_00000000' }),
      error => error.code === 'not-found',
    )
  } finally {
    await cleanup(home)
  }
})

test('commands: reset requires explicit confirmation', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.create({ title: 'Topic', content: 'Body.' })
    const { extractor } = makeExtractor()
    const guard = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'reset' })
    assert.equal(guard.kind, 'error')
    assert.match(guard.text, /reset --yes/u)
    assert.equal(store.memories.length, 1)
    const confirmed = await runMemoryCommand({ store, extractor, agent: undefined, rawInput: 'reset --yes' })
    assert.equal(confirmed.kind, 'success')
    assert.equal(store.memories.length, 0)
    assert.equal(store.settings.enabled, true)
  } finally {
    await cleanup(home)
  }
})
