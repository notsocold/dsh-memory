/**
 * Session-to-transcript projection for the memory judge.
 *
 * Snapshots are taken synchronously from a live Session (or during its
 * disposal), so a later async judge call never touches a disposed Session.
 * Only human messages and assistant text blocks enter the transcript; tool
 * calls contribute names only, and compaction summaries provide background for
 * spans that were already compacted away.
 *
 * @module dsh-memory/lib/transcript
 */

import { isSubagentSession, latestWorkingDirectory, resolveWorkspace } from './project.js'
import { memoryError } from './state.js'

/**
 * @param {unknown} content - message content blocks.
 * @returns {string} concatenated text blocks.
 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * @param {ReadonlyArray<Record<string, any>>} events - session events.
 * @returns {string} latest title, or an empty string.
 */
export function latestSessionTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
  }
  return ''
}

/**
 * @param {ReadonlyArray<Record<string, any>>} events - session events.
 * @returns {string} first human message snippet, used as a fallback title.
 */
export function firstHumanSnippet(events) {
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = blocksToText(event.data.content).replace(/\s+/gu, ' ').trim()
    if (text !== '') return text.length > 60 ? `${text.slice(0, 57)}…` : text
  }
  return ''
}

/**
 * Take a synchronous snapshot of one live Session for later extraction.
 * Everything the judge needs is copied, so Session disposal cannot race it.
 * @param {any} session - DSH Session.
 * @returns {{
 *   sessionId: string,
 *   title: string,
 *   cwd: string | undefined,
 *   projectKey: string | undefined,
 *   projectName: string | undefined,
 *   isSubagent: boolean,
 *   route: { provider: string, model: string } | undefined,
 *   events: ReadonlyArray<Record<string, any>>,
 *   header: Record<string, any>,
 *   createdAt: number | undefined,
 * }}
 */
export function snapshotSession(session) {
  const sessionId = String(session?.id ?? '')
  if (sessionId === '') throw memoryError('invalid-request', 'a live session is required')
  const header = session.header ?? {}
  /** @type {ReadonlyArray<Record<string, any>>} */
  let events = []
  try {
    events = session.snapshotEvents()
  } catch {
    // A session that cannot be read is treated as empty; the extractor skips it.
    events = []
  }
  let route
  try {
    const epoch = session.requestHeader()
    const provider = epoch?.config?.provider
    const model = epoch?.config?.model
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      route = { provider, model }
    }
  } catch {
    route = undefined
  }
  const cwd = latestWorkingDirectory(events, typeof header.cwd === 'string' ? header.cwd : undefined)
  const project = resolveWorkspace(cwd)
  return {
    sessionId,
    title: latestSessionTitle(events) || firstHumanSnippet(events),
    cwd,
    projectKey: project?.key,
    projectName: project?.name,
    isSubagent: isSubagentSession(session),
    route,
    events,
    header,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
  }
}

/**
 * @param {ReadonlyArray<Record<string, any>>} events - session events.
 * @returns {string} latest compaction summary text (bounded).
 */
export function latestCompactionSummary(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'compaction/summary') continue
    const text = blocksToText(event.data?.summary)
    if (text !== '') return text.length > 4000 ? `${text.slice(0, 3999)}…` : text
  }
  return ''
}

/**
 * Build the bounded transcript handed to the judge.
 * @param {ReturnType<typeof snapshotSession>} snapshot - captured session.
 * @param {{ watermarkSeq?: number, maxInputChars?: number }} [options] - extraction window and budget.
 * @returns {{
 *   transcript: string,
 *   compactionSummary: string,
 *   humanMessages: number,
 *   humanChars: number,
 *   nextSeq: number,
 *   totalEvents: number,
 *   toolNames: string[],
 *   omittedMessages: number,
 * }}
 */
export function buildExtractionInput(snapshot, options = {}) {
  // Session sequences start at 0; -1 means "nothing processed yet".
  const watermarkSeq = Number.isFinite(options.watermarkSeq) ? Number(options.watermarkSeq) : -1
  const maxInputChars = Number.isFinite(options.maxInputChars) ? Math.max(1000, Number(options.maxInputChars)) : 24000
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  /** @type {{ role: 'user' | 'assistant', text: string, seq: number }[]} */
  const messages = []
  const toolNames = new Set()
  let humanMessages = 0
  let humanChars = 0
  let nextSeq = watermarkSeq
  /** @type {string[]} */
  const compactionSummaries = []
  for (const event of events) {
    const seq = Number(event?.seq ?? 0)
    if (seq <= watermarkSeq) continue
    nextSeq = Math.max(nextSeq, seq)
    switch (event.type) {
      case 'user/message': {
        // Human prompts only: injected working-directory/instruction context is
        // role "user" too, but it carries a different source kind.
        if (event.data?.source?.kind !== 'user') break
        const text = blocksToText(event.data.content)
        if (text === '') break
        messages.push({ role: 'user', text, seq })
        humanMessages += 1
        humanChars += text.length
        break
      }
      case 'assistant/message': {
        const text = blocksToText(event.data?.message?.content)
        if (text !== '') messages.push({ role: 'assistant', text, seq })
        break
      }
      case 'tool/call': {
        if (typeof event.data?.name === 'string' && event.data.name !== '') toolNames.add(event.data.name)
        break
      }
      case 'compaction/summary': {
        const summary = blocksToText(event.data?.summary)
        if (summary !== '') compactionSummaries.push(summary.length > 4000 ? `${summary.slice(0, 3999)}…` : summary)
        break
      }
      default:
        break
    }
  }
  const lines = []
  let used = 0
  let included = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const text = message.text.length > 4000 ? `${message.text.slice(0, 3999)}…` : message.text
    const line = `[${message.role}] ${text}`
    const cost = line.length + 1
    if (used + cost > maxInputChars) {
      // Keep at least a truncated slice of the newest message instead of
      // dropping the only content the judge would see.
      if (lines.length === 0) {
        const allowance = maxInputChars - used - 1
        if (allowance > 20) {
          lines.push(`${line.slice(0, allowance)}…`)
          included = 1
        }
      }
      break
    }
    lines.push(line)
    used += cost
    included += 1
  }
  lines.reverse()
  const compactionSummary = compactionSummaries.slice(-2).join('\n\n')
  const omittedMessages = messages.length - included
  const prefix = []
  if (omittedMessages > 0) prefix.push(`[earlier conversation omitted: ${omittedMessages} messages]`)
  if (compactionSummary !== '') prefix.push(`[compacted earlier context]\n${compactionSummary}`)
  if (toolNames.size > 0) prefix.push(`[tools used: ${[...toolNames].slice(0, 40).join(', ')}]`)
  const transcript = [...prefix, ...lines].join('\n\n')
  return {
    transcript,
    compactionSummary,
    humanMessages,
    humanChars,
    nextSeq: Math.max(nextSeq, watermarkSeq),
    totalEvents: events.length,
    toolNames: [...toolNames],
    omittedMessages,
  }
}
