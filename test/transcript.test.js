/**
 * Unit tests for lib/transcript.js — text block projection, session snapshots
 * and the bounded extraction transcript.
 *
 * Run from the plugin root:
 *   node --test test/transcript.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearProjectCache } from '../lib/project.js'
import {
  blocksToText,
  buildExtractionInput,
  firstHumanSnippet,
  latestCompactionSummary,
  latestSessionTitle,
  snapshotSession,
} from '../lib/transcript.js'

function userEvent(seq, text, source = 'user') {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { content: [{ type: 'text', text }], source: { kind: source } },
  }
}

function assistantEvent(seq, text, reasoning = 'hidden-reasoning') {
  const content = []
  if (text !== undefined) content.push({ type: 'text', text })
  if (reasoning !== undefined) content.push({ type: 'reasoning', text: reasoning })
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { message: { content } },
  }
}

function toolEvent(seq, name) {
  return { type: 'tool/call', seq, time: seq, data: { name } }
}

function compactionEvent(seq, text) {
  return {
    type: 'compaction/summary',
    seq,
    time: seq,
    data: { summary: [{ type: 'text', text }] },
  }
}

function titleEvent(seq, title) {
  return { type: 'session/title', seq, time: seq, data: { title } }
}

function makeSession(options = {}) {
  const {
    id = 'sess-1',
    cwd,
    createdAt = 1700000000000,
    origin,
    delegationDepth,
    events = [],
    requestHeader,
  } = options
  const header = { createdAt }
  if (cwd !== undefined) header.cwd = cwd
  if (origin !== undefined) header.origin = origin
  if (delegationDepth !== undefined) header.delegationDepth = delegationDepth
  return {
    id,
    header,
    snapshotEvents: () => events,
    requestHeader: requestHeader ?? (() => ({ config: { provider: 'provider-a', model: 'model-b' } })),
  }
}

describe('blocksToText', () => {
  it('concatenates text blocks and ignores reasoning/tool blocks', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'tool-call', text: 'tool payload' },
      { type: 'tool/result', text: 'tool result' },
      { type: 'text', text: '' },
      { type: 'text', text: 42 },
      null,
      { type: 'text', text: 'second' },
    ]
    assert.equal(blocksToText(content), 'first\nsecond')
  })

  it('trims the joined text', () => {
    assert.equal(blocksToText([{ type: 'text', text: '  hello  ' }]), 'hello')
    assert.equal(blocksToText([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]), 'hello\nworld')
  })

  it('returns an empty string for non-array and empty content', () => {
    assert.equal(blocksToText(undefined), '')
    assert.equal(blocksToText(null), '')
    assert.equal(blocksToText('text'), '')
    assert.equal(blocksToText({ type: 'text', text: 'nope' }), '')
    assert.equal(blocksToText([]), '')
  })

  it('ignores blocks with missing or non-string text', () => {
    assert.equal(blocksToText([{ type: 'text' }, { type: 'text', text: null }, { type: 'text', text: 'ok' }]), 'ok')
  })
})

describe('latestSessionTitle / firstHumanSnippet / latestCompactionSummary', () => {
  it('latestSessionTitle returns the last string title', () => {
    const events = [titleEvent(1, 'First'), userEvent(2, 'hi'), titleEvent(3, 'Latest')]
    assert.equal(latestSessionTitle(events), 'Latest')
    assert.equal(latestSessionTitle([]), '')
    assert.equal(latestSessionTitle([userEvent(1, 'hi')]), '')
    assert.equal(latestSessionTitle([{ type: 'session/title', data: { title: 42 } }]), '')
  })

  it('latestSessionTitle lets a later empty title win', () => {
    assert.equal(latestSessionTitle([titleEvent(1, 'First'), titleEvent(2, '')]), '')
  })

  it('firstHumanSnippet skips context and assistant messages', () => {
    const events = [
      assistantEvent(1, 'assistant first'),
      userEvent(2, 'injected workspace context', 'some-context'),
      userEvent(3, '  Hello\n\n   world  '),
      userEvent(4, 'later human message'),
    ]
    assert.equal(firstHumanSnippet(events), 'Hello world')
  })

  it('firstHumanSnippet returns an empty string when there is no human text', () => {
    assert.equal(firstHumanSnippet([]), '')
    assert.equal(firstHumanSnippet([assistantEvent(1, 'answer'), userEvent(2, '', 'user')]), '')
    assert.equal(firstHumanSnippet([userEvent(1, 'context only', 'some-context')]), '')
  })

  it('firstHumanSnippet truncates long snippets with an ellipsis', () => {
    const snippet = firstHumanSnippet([userEvent(1, 'a'.repeat(80))])
    assert.equal(snippet.length, 58)
    assert.ok(snippet.endsWith('…'))
    assert.equal(snippet, `${'a'.repeat(57)}…`)
  })

  it('firstHumanSnippet leaves a 60-character snippet intact', () => {
    const text = 'b'.repeat(60)
    assert.equal(firstHumanSnippet([userEvent(1, text)]), text)
  })

  it('latestCompactionSummary includes the most recent summary', () => {
    const events = [compactionEvent(1, 'first summary'), compactionEvent(2, 'second summary')]
    const latest = latestCompactionSummary(events)
    assert.ok(latest.includes('second summary'))
    assert.equal(latestCompactionSummary([compactionEvent(1, 'first summary'), compactionEvent(2, '')]), 'first summary')
    assert.equal(latestCompactionSummary([]), '')
    assert.equal(latestCompactionSummary([userEvent(1, 'hi')]), '')
  })

  it('latestCompactionSummary bounds very long summaries', () => {
    const summary = latestCompactionSummary([compactionEvent(1, 's'.repeat(5000))])
    assert.equal(summary.length, 4000)
    assert.ok(summary.endsWith('…'))
  })
})

describe('snapshotSession', () => {
  let base

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-memory-transcript-'))
    clearProjectCache()
  })

  afterEach(async () => {
    clearProjectCache()
    await rm(base, { recursive: true, force: true })
  })

  it('captures session id, title, route, project, header and events', async () => {
    const repo = join(base, 'snapshot-repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    const cwd = join(repo, 'src', 'nested')
    await mkdir(cwd, { recursive: true })
    const events = [userEvent(1, 'hello'), titleEvent(2, 'First'), titleEvent(3, 'Latest'), assistantEvent(4, 'reply')]
    const session = makeSession({
      id: 'sess-42',
      cwd,
      createdAt: 1700000000000,
      events,
    })

    const snapshot = snapshotSession(session)
    assert.equal(snapshot.sessionId, 'sess-42')
    assert.equal(snapshot.title, 'Latest')
    assert.deepEqual(snapshot.route, { provider: 'provider-a', model: 'model-b' })
    assert.equal(snapshot.cwd, cwd)
    assert.equal(snapshot.projectKey, await realpath(repo))
    assert.equal(snapshot.projectName, 'snapshot-repo')
    assert.equal(snapshot.isSubagent, false)
    assert.equal(snapshot.createdAt, 1700000000000)
    assert.deepEqual(snapshot.header, session.header)
    assert.deepEqual(snapshot.events, events)
    assert.equal(snapshot.events.length, 4)
  })

  it('falls back to the first human snippet when no title exists', () => {
    const session = makeSession({ events: [userEvent(1, '  Hello\n world '), assistantEvent(2, 'answer')] })
    const snapshot = snapshotSession(session)
    assert.equal(snapshot.title, 'Hello world')
  })

  it('flags subagent sessions from origin and delegation depth', () => {
    assert.equal(snapshotSession(makeSession({ origin: 'subagent' })).isSubagent, true)
    assert.equal(snapshotSession(makeSession({ delegationDepth: 1 })).isSubagent, true)
    assert.equal(snapshotSession(makeSession({ delegationDepth: 2 })).isSubagent, true)
    assert.equal(snapshotSession(makeSession()).isSubagent, false)
    assert.equal(snapshotSession(makeSession({ origin: 'user', delegationDepth: 0 })).isSubagent, false)
  })

  it('throws invalid-request when the session id is missing', () => {
    const invalidRequest = (error) => error?.code === 'invalid-request'
    assert.throws(() => snapshotSession({ header: {} }), invalidRequest)
    assert.throws(() => snapshotSession({ id: '' }), invalidRequest)
    assert.throws(() => snapshotSession(undefined), invalidRequest)
  })

  it('treats a failing snapshotEvents() as an empty event list', () => {
    const session = makeSession({ events: [userEvent(1, 'hello'), titleEvent(2, 'Title')] })
    session.snapshotEvents = () => {
      throw new Error('session disposed')
    }
    const snapshot = snapshotSession(session)
    assert.deepEqual(snapshot.events, [])
    assert.equal(snapshot.title, '')
    assert.equal(snapshot.cwd, undefined)
    assert.equal(snapshot.projectKey, undefined)
  })

  it('tolerates failing or incomplete requestHeader() values', () => {
    const throwing = makeSession({
      requestHeader: () => {
        throw new Error('no request header')
      },
    })
    assert.equal(snapshotSession(throwing).route, undefined)

    const providerOnly = makeSession({ requestHeader: () => ({ config: { provider: 'p' } }) })
    assert.equal(snapshotSession(providerOnly).route, undefined)

    const modelOnly = makeSession({ requestHeader: () => ({ config: { model: 'm' } }) })
    assert.equal(snapshotSession(modelOnly).route, undefined)

    const emptyProvider = makeSession({ requestHeader: () => ({ config: { provider: '', model: 'm' } }) })
    assert.equal(snapshotSession(emptyProvider).route, undefined)

    const noConfig = makeSession({ requestHeader: () => ({}) })
    assert.equal(snapshotSession(noConfig).route, undefined)
  })

  it('leaves cwd and createdAt undefined when they have the wrong type', () => {
    const session = makeSession({})
    session.header.cwd = 42
    session.header.createdAt = 'yesterday'
    const snapshot = snapshotSession(session)
    assert.equal(snapshot.cwd, undefined)
    assert.equal(snapshot.projectKey, undefined)
    assert.equal(snapshot.createdAt, undefined)
  })
})

describe('buildExtractionInput', () => {
  it('keeps human user messages and assistant text only', () => {
    const events = [
      userEvent(1, 'hello'),
      userEvent(2, 'injected working directory context', 'some-context'),
      assistantEvent(3, 'answer'),
      toolEvent(4, 'bash'),
      toolEvent(5, 'read'),
      toolEvent(6, 'bash'),
      compactionEvent(7, 'summary text'),
      titleEvent(8, 'Session title'),
      assistantEvent(9, undefined, 'reasoning-only'),
    ]
    const result = buildExtractionInput({ events })

    assert.equal(result.humanMessages, 1)
    assert.equal(result.humanChars, 5)
    assert.equal(result.compactionSummary, 'summary text')
    assert.deepEqual(result.toolNames, ['bash', 'read'])
    assert.equal(result.nextSeq, 9)
    assert.equal(result.totalEvents, 9)
    assert.equal(result.omittedMessages, 0)
    assert.ok(result.transcript.includes('[user] hello'))
    assert.ok(result.transcript.includes('[assistant] answer'))
    assert.equal(result.transcript.includes('injected working directory context'), false)
    assert.equal(result.transcript.includes('hidden-reasoning'), false)
    assert.equal(result.transcript.includes('reasoning-only'), false)
    assert.equal(result.transcript.includes('Session title'), false)
    assert.ok(result.transcript.includes('[compacted earlier context]\nsummary text'))
    assert.ok(result.transcript.includes('[tools used: bash, read]'))
    assert.equal((result.transcript.match(/\[assistant\]/g) ?? []).length, 1)
  })

  it('returns an empty transcript for no events', () => {
    const result = buildExtractionInput({ events: [] })
    assert.deepEqual(result, {
      transcript: '',
      compactionSummary: '',
      humanMessages: 0,
      humanChars: 0,
      // The current contract uses -1 as "nothing processed yet" (sequences start at 0).
      nextSeq: -1,
      totalEvents: 0,
      toolNames: [],
      omittedMessages: 0,
    })
  })

  it('handles a missing events array', () => {
    const result = buildExtractionInput({})
    assert.equal(result.transcript, '')
    assert.equal(result.nextSeq, -1)
    assert.equal(result.totalEvents, 0)
    assert.deepEqual(result.toolNames, [])
  })

  it('includes a sequence-zero event when no watermark has been stored', () => {
    const result = buildExtractionInput({ events: [userEvent(0, 'first event')] })
    assert.equal(result.humanMessages, 1)
    assert.equal(result.humanChars, 11)
    assert.equal(result.nextSeq, 0)
    assert.ok(result.transcript.includes('first event'))
  })

  it('excludes events at or below the watermark and cannot move nextSeq backwards', () => {
    const events = [
      userEvent(1, 'old one'),
      userEvent(2, 'old two'),
      assistantEvent(3, 'old answer'),
      userEvent(4, 'newer'),
      assistantEvent(5, 'reply'),
      titleEvent(6, 'Title'),
    ]
    const window = buildExtractionInput({ events }, { watermarkSeq: 3 })
    assert.equal(window.humanMessages, 1)
    assert.equal(window.humanChars, 5)
    assert.equal(window.nextSeq, 6)
    assert.equal(window.totalEvents, 6)
    assert.ok(window.transcript.includes('newer'))
    assert.ok(window.transcript.includes('reply'))
    assert.equal(window.transcript.includes('old one'), false)
    assert.equal(window.transcript.includes('old answer'), false)

    const fullyConsumed = buildExtractionInput({ events }, { watermarkSeq: 99 })
    assert.equal(fullyConsumed.transcript, '')
    assert.equal(fullyConsumed.humanMessages, 0)
    assert.equal(fullyConsumed.humanChars, 0)
    assert.equal(fullyConsumed.nextSeq, 99)
    assert.equal(fullyConsumed.totalEvents, 6)
  })

  it('uses the latest compaction summary in the window', () => {
    const events = [compactionEvent(1, 'first summary'), compactionEvent(2, 'second summary')]
    const result = buildExtractionInput({ events })
    assert.ok(result.compactionSummary.includes('second summary'))
    assert.ok(result.transcript.includes('second summary'))
  })

  it('truncates to maxInputChars by keeping the newest messages', () => {
    const events = Array.from({ length: 20 }, (_, index) => userEvent(
      index + 1,
      `msg${index}-${'x'.repeat(90)}`,
    ))
    const result = buildExtractionInput({ events }, { maxInputChars: 1000 })

    assert.equal(result.humanMessages, 20)
    assert.ok(result.omittedMessages > 0)
    assert.ok(result.transcript.startsWith(`[earlier conversation omitted: ${result.omittedMessages} messages]`))
    assert.ok(result.transcript.includes('msg19-'))
    assert.equal(result.transcript.includes('msg0-'), false)
    assert.equal(result.nextSeq, 20)

    const messageNumbers = [...result.transcript.matchAll(/\[user\] msg(\d+)-/g)].map((match) => Number(match[1]))
    assert.ok(messageNumbers.length > 0)
    assert.deepEqual(messageNumbers, [...messageNumbers].sort((left, right) => left - right))
    assert.equal(messageNumbers.at(-1), 19)
    assert.equal(messageNumbers.length + result.omittedMessages, 20)
    assert.ok(result.transcript.trimEnd().endsWith('x'.repeat(90)))
  })

  it('bounds an individual over-long message before budgeting', () => {
    const longText = 'y'.repeat(5000)
    const result = buildExtractionInput({ events: [userEvent(1, longText)] })
    assert.equal(result.humanChars, 5000)
    assert.ok(result.transcript.includes('…'))
    assert.ok(result.transcript.length < 5000)
    assert.ok(result.transcript.endsWith('…'))
  })

  it('counts human messages and chars before truncation', () => {
    const events = Array.from({ length: 30 }, (_, index) => userEvent(index + 1, `m${index}-${'z'.repeat(100)}`))
    const result = buildExtractionInput({ events }, { maxInputChars: 1000 })
    assert.equal(result.humanMessages, 30)
    const expectedChars = events.reduce((total, event) => total + event.data.content[0].text.length, 0)
    assert.equal(result.humanChars, expectedChars)
    assert.ok(result.omittedMessages > 0)
    assert.equal(messageCount(result.transcript) + result.omittedMessages, 30)
  })

  it('ignores empty human content blocks', () => {
    const events = [
      userEvent(1, ''),
      { type: 'user/message', seq: 2, data: { content: [{ type: 'reasoning', text: 'not human text' }], source: { kind: 'user' } } },
      userEvent(3, 'real message'),
    ]
    const result = buildExtractionInput({ events })
    assert.equal(result.humanMessages, 1)
    assert.equal(result.humanChars, 12)
    assert.ok(result.transcript.includes('real message'))
  })
})

function messageCount(transcript) {
  return (transcript.match(/\[user\]/g) ?? []).length
}
