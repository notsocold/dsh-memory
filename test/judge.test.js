import test from 'node:test'
import assert from 'node:assert/strict'
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_MAX_TOKENS,
  buildJudgePayload,
  buildJudgePrompt,
  parseJudgeOutput,
  readJudgeStream,
  resolveJudgeRoute,
  runJudge,
  validateOperations,
} from '../lib/judge.js'
import { cleanup, makeHome, makeSnapshot, makeStore, silentLogger } from './helpers.js'

/**
 * @param {Record<string, any>[]} chunks - stream chunks to emit.
 * @returns {AsyncGenerator<Record<string, any>>}
 */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * @param {string} text - text deltas.
 * @returns {Record<string, any>[]} a successful text stream.
 */
function textChunks(text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * @param {any} ctx - context under test.
 * @returns {string} system prompt seen by buildJudgePrompt.
 */
function judgePromptOf(ctx) {
  return JUDGE_SYSTEM_PROMPT
}

test('judge: readJudgeStream concatenates text deltas and requires a stop finish', async () => {
  const text = await readJudgeStream(streamOf(textChunks('hello ')), undefined)
  assert.equal(text, 'hello ')
  await assert.rejects(
    readJudgeStream(streamOf([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'max-tokens' } }]), undefined),
    error => error.code === 'judge-failed',
  )
  await assert.rejects(
    readJudgeStream(streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }]), undefined),
    error => error.code === 'judge-failed' && /RATE_LIMIT/u.test(error.message),
  )
  await assert.rejects(readJudgeStream(streamOf([]), undefined), error => error.code === 'judge-failed')
  await assert.rejects(
    readJudgeStream(streamOf([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }]), AbortSignal.abort()),
    error => error.code === 'judge-failed' && /aborted/u.test(error.message),
  )
})

test('judge: resolveJudgeRoute prefers settings, then the session route, then the default model', () => {
  const settings = { judgeProvider: '', judgeModel: '' }
  const snapshot = makeSnapshot([], { route: { provider: 'session-provider', model: 'session-model' } })
  assert.deepEqual(resolveJudgeRoute({ get: () => undefined }, snapshot, settings), {
    provider: 'session-provider',
    model: 'session-model',
  })
  assert.deepEqual(
    resolveJudgeRoute({ get: () => undefined }, snapshot, { judgeProvider: 'fixed', judgeModel: 'm1' }),
    { provider: 'fixed', model: 'm1' },
  )
  const ctx = {
    get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default', model: 'dm' }) } : undefined),
  }
  assert.deepEqual(resolveJudgeRoute(ctx, makeSnapshot([], { route: undefined }), settings), {
    provider: 'default',
    model: 'dm',
  })
  assert.equal(resolveJudgeRoute({ get: () => undefined }, makeSnapshot([], { route: undefined }), settings), undefined)
})

test('judge: parseJudgeOutput accepts plain and fenced JSON and rejects garbage', () => {
  const operations = [{ op: 'create', title: 'T', content: 'C', kind: 'reference' }]
  assert.deepEqual(parseJudgeOutput(JSON.stringify({ operations })), { operations })
  assert.deepEqual(parseJudgeOutput(`Here you go:\n\`\`\`json\n${JSON.stringify({ operations, skipped: [] })}\n\`\`\`\nDone.`), {
    operations,
    skipped: [],
  })
  assert.throws(() => parseJudgeOutput(''), error => error.code === 'judge-failed')
  assert.throws(() => parseJudgeOutput('no json here'), error => error.code === 'judge-failed')
  assert.throws(() => parseJudgeOutput('{"operations":"nope"}'), error => error.code === 'judge-failed')
  assert.throws(() => parseJudgeOutput('{bad json}'), error => error.code === 'judge-failed')
})

test('judge: validateOperations sanitizes fields, binds project scope and caps counts', () => {
  const project = { key: '/repos/a', name: 'a' }
  const parsed = {
    operations: [
      { op: 'create', title: 'T1', content: 'C1', kind: 'decision', scope: 'project', importance: 9, tags: ['x', 'x'] },
      { op: 'create', title: 'T2', content: 'C2', kind: 'bad-kind', scope: 'project' },
      { op: 'create', title: '', content: 'C3', kind: 'reference', scope: 'project' },
      { op: 'update', id: 'm_12345678', patch: { content: 'new', scope: 'global' } },
      { op: 'update', id: 'nope', patch: { content: 'x' } },
      { op: 'delete', id: 'm_12345678' },
      { op: 'create', title: 'T3', content: 'C3', kind: 'reference', scope: 'project' },
      { op: 'create', title: 'T4', content: 'C4', kind: 'reference', scope: 'project' },
      { op: 'create', title: 'T5', content: 'C5', kind: 'reference', scope: 'project' },
      { op: 'create', title: 'T6', content: 'C6', kind: 'reference', scope: 'project' },
      { op: 'create', title: 'T7', content: 'C7', kind: 'reference', scope: 'project' },
    ],
    skipped: [{ topic: 'x', reason: 'ephemeral' }, 'bad'],
  }
  const result = validateOperations(parsed, { project })
  // Five accepted creates (the sixth hits the cap) plus one accepted update.
  assert.equal(result.accepted.length, 6)
  assert.equal(result.accepted[0].scope, 'project')
  assert.deepEqual(result.accepted[0].project, project)
  assert.equal(result.accepted[0].importance, 5)
  assert.deepEqual(result.accepted[0].tags, ['x'])
  assert.ok(result.rejected.some(item => item.op === 'create' && /kind/u.test(item.reason)))
  assert.ok(result.rejected.some(item => item.op === 'update' && item.id === 'nope'))
  assert.ok(result.rejected.some(item => item.op === 'delete'))
  assert.ok(result.rejected.some(item => item.op === 'create' && /more than 5 creates/u.test(item.reason)))
  assert.equal(result.skipped.length, 1)

  const withoutProject = validateOperations({
    operations: [{ op: 'create', title: 'T', content: 'C', kind: 'project', scope: 'project' }],
  })
  assert.equal(withoutProject.accepted.length, 0)
  assert.match(withoutProject.rejected[0].reason, /requires a current project/u)
})

test('judge: scope is required and project facts cannot silently become global', () => {
  const project = { key: '/repos/a', name: 'a' }
  const result = validateOperations({
    operations: [
      { op: 'create', title: 'Missing scope', content: 'Body.', kind: 'reference' },
      { op: 'create', title: 'Project fact', content: 'Body.', kind: 'project', scope: 'global' },
      { op: 'create', title: 'Cross-project fact', content: 'Body.', kind: 'reference', scope: 'global', scopeReason: 'Applies to every project.' },
      { op: 'create', title: 'User preference', content: 'Body.', kind: 'preference', scope: 'global' },
    ],
  }, { project })
  assert.equal(result.accepted.length, 3)
  assert.ok(result.rejected.some(item => /scope is required/u.test(item.reason)))
  assert.equal(result.accepted[0].scope, 'project')
  assert.deepEqual(result.accepted[0].project, project)
  assert.equal(result.accepted[1].scope, 'global')
  assert.equal(result.accepted[2].scope, 'global')
})

test('judge: automatic extraction rejects creates below the importance floor', () => {
  const low = validateOperations({
    operations: [{
      op: 'create', title: 'Low value', content: 'Body.', kind: 'reference', scope: 'global', importance: 2,
    }],
  }, { minImportance: 3 })
  assert.equal(low.accepted.length, 0)
  assert.match(low.rejected[0].reason, /importance .* below the automatic save floor/u)

  const high = validateOperations({
    operations: [{
      op: 'create', title: 'Useful', content: 'Body.', kind: 'reference', scope: 'global', importance: 3,
    }],
  }, { minImportance: 3 })
  assert.equal(high.accepted.length, 1)

  const missing = validateOperations({
    operations: [{
      op: 'create', title: 'No importance', content: 'Body.', kind: 'reference', scope: 'global',
    }],
  }, { minImportance: 3 })
  assert.equal(missing.accepted.length, 0)
  assert.match(missing.rejected[0].reason, /importance is required/u)
})

test('judge: validateOperations redacts credentials in accepted content', () => {
  const result = validateOperations({
    operations: [{ op: 'create', title: 'Token', content: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345', kind: 'reference', scope: 'global' }],
  })
  assert.equal(result.accepted.length, 1)
  assert.match(result.accepted[0].content, /\[REDACTED\]/u)
  assert.doesNotMatch(result.accepted[0].content, /sk-abcdefghijklmnopqrstuvwxyz/u)
})

test('judge: prompt payload carries the index, session facts and privacy policy', () => {
  const settings = { allowSensitive: false }
  const snapshot = makeSnapshot([], { title: 'Repo setup', cwd: '/repos/a', projectKey: '/repos/a', projectName: 'a' })
  const payload = buildJudgePayload({
    settings,
    snapshot,
    indexText: '- m_1a2b3c4d | preference | global | Title | Summary',
    extraction: { transcript: '[user] hello', humanMessages: 1, humanChars: 5, toolNames: [] },
  })
  assert.match(payload, /Existing memory topics/u)
  assert.match(payload, /m_1a2b3c4d/u)
  assert.match(payload, /Repo setup/u)
  assert.match(payload, /project: a \(\/repos\/a\)/u)
  assert.match(payload, /Never store: government identity/u)
  assert.match(payload, /health or medical conditions/u)
  const prompt = buildJudgePrompt({
    settings,
    snapshot,
    indexText: '',
    extraction: { transcript: '[user] hello', humanMessages: 1, humanChars: 5, toolNames: [] },
  })
  assert.equal(prompt.system, JUDGE_SYSTEM_PROMPT)
  assert.match(prompt.user, /Conversation span to distill/u)
  assert.match(prompt.user, /Return JSON only/u)
  assert.match(prompt.system, /Every create MUST include scope/u)
  assert.match(prompt.system, /VALUE BAR/u)
  assert.match(prompt.system, /scopeReason/u)
  assert.equal(judgePromptOf({}), JUDGE_SYSTEM_PROMPT)
})

test('judge: runJudge applies accepted operations on the session route', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const calls = []
    const ctx = {
      llm: {
        stream(options) {
          calls.push(options)
          return streamOf(textChunks(JSON.stringify({
            operations: [
              { op: 'create', title: 'User prefers pnpm', content: 'The user always uses pnpm.', kind: 'preference', scope: 'global', importance: 4 },
            ],
            skipped: [{ topic: 'greeting', reason: 'ephemeral' }],
          })))
        },
      },
      get: () => undefined,
    }
    const snapshot = makeSnapshot([], { sessionId: 's-1', title: 'Setup' })
    const extraction = { transcript: '[user] use pnpm please', humanMessages: 1, humanChars: 18, toolNames: [] }
    const result = await runJudge({
      ctx,
      store,
      snapshot,
      extraction,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.created, 1)
    assert.equal(result.updated, 0)
    assert.equal(result.skipped, 1)
    assert.equal(store.memories.length, 1)
    assert.equal(store.memories[0].source.origin, 'auto')
    assert.equal(store.memories[0].source.sessionId, 's-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'test-provider')
    assert.equal(calls[0].model, 'test-model')
    assert.equal(calls[0].temperature, 0)
    assert.equal(calls[0].maxTokens, JUDGE_MAX_TOKENS)
    assert.match(calls[0].system, /long-term memory curator/u)
  } finally {
    await cleanup(home)
  }
})

test('judge: runJudge rejects creates below the configured importance floor', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const ctx = {
      llm: {
        stream: () => streamOf(textChunks(JSON.stringify({
          operations: [{
            op: 'create', title: 'Low value', content: 'Body.', kind: 'reference', scope: 'global', importance: 2,
          }],
        }))),
      },
      get: () => undefined,
    }
    const result = await runJudge({
      ctx,
      store,
      snapshot: makeSnapshot([], { sessionId: 's-floor' }),
      extraction: { transcript: '[user] something', humanMessages: 1, humanChars: 9, toolNames: [] },
      signal: new AbortController().signal,
      minimumImportance: 3,
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.created, 0)
    assert.match(result.rejected[0].reason, /below the automatic save floor/u)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('judge: runJudge updates an existing topic instead of duplicating it', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const existing = store.create({ title: 'Deploy target', content: 'Staging is tatooine.', kind: 'project' }).record
    const ctx = {
      llm: {
        stream: () => streamOf(textChunks(JSON.stringify({
          operations: [{
            op: 'update',
            id: existing.id,
            patch: { content: 'Staging is tatooine; production is coruscant.', importance: 5 },
          }],
        }))),
      },
      get: () => undefined,
    }
    const result = await runJudge({
      ctx,
      store,
      snapshot: makeSnapshot([], { sessionId: 's-2' }),
      extraction: { transcript: '[user] deploy', humanMessages: 1, humanChars: 9, toolNames: [] },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.updated, 1)
    assert.equal(store.memories.length, 1)
    assert.match(store.memories[0].content, /coruscant/u)
    assert.equal(store.memories[0].revision, 2)
  } finally {
    await cleanup(home)
  }
})

test('judge: runJudge skips when disabled, empty or unroutable and reports failures', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const extraction = { transcript: '', humanMessages: 1, humanChars: 5, toolNames: [] }
    const snapshot = makeSnapshot([], { route: undefined })
    const noRoute = await runJudge({
      ctx: { get: () => undefined },
      store,
      snapshot,
      extraction,
      signal: new AbortController().signal,
    })
    assert.equal(noRoute.status, 'skipped')
    assert.match(noRoute.reason, /route/u)

    store.setSettings({ enabled: false })
    const disabled = await runJudge({
      ctx: { get: () => undefined },
      store,
      snapshot,
      extraction,
      signal: new AbortController().signal,
    })
    assert.equal(disabled.status, 'skipped')
    assert.match(disabled.reason, /disabled/u)
    store.setSettings({ enabled: true })

    const empty = await runJudge({
      ctx: { get: () => undefined },
      store,
      snapshot,
      extraction: { ...extraction, humanMessages: 0 },
      signal: new AbortController().signal,
    })
    assert.equal(empty.status, 'skipped')
    assert.match(empty.reason, /human messages/u)

    const failing = await runJudge({
      ctx: {
        llm: { stream: () => streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }]) },
        get: () => undefined,
      },
      store,
      snapshot: makeSnapshot([], { route: { provider: 'p', model: 'm' } }),
      extraction,
      signal: new AbortController().signal,
    })
    assert.equal(failing.status, 'error')
    assert.match(failing.reason, /AUTH/u)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('judge: malformed model JSON is reported as an error and writes nothing', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    const result = await runJudge({
      ctx: {
        llm: { stream: () => streamOf(textChunks('not json at all')) },
        get: () => undefined,
      },
      store,
      snapshot: makeSnapshot([], { route: { provider: 'p', model: 'm' } }),
      extraction: { transcript: '[user] x', humanMessages: 1, humanChars: 1, toolNames: [] },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'error')
    assert.match(result.reason, /JSON/u)
    assert.equal(store.memories.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('judge: runJudge honors the configured judge model override', async () => {
  const home = await makeHome()
  try {
    const store = await makeStore(home)
    store.setSettings({ judgeProvider: 'fixed-provider', judgeModel: 'fixed-model' })
    let seen
    const result = await runJudge({
      ctx: {
        llm: {
          stream(options) {
            seen = options
            return streamOf(textChunks(JSON.stringify({ operations: [] })))
          },
        },
        get: () => undefined,
      },
      store,
      snapshot: makeSnapshot([], { route: { provider: 'session-p', model: 'session-m' } }),
      extraction: { transcript: '[user] hello', humanMessages: 1, humanChars: 5, toolNames: [] },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    assert.equal(seen.provider, 'fixed-provider')
    assert.equal(seen.model, 'fixed-model')
    assert.equal(result.reason, undefined)
    void silentLogger
  } finally {
    await cleanup(home)
  }
})
