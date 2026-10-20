/**
 * Pure retrieval helpers over memory records: normalization, similarity,
 * search scoring, ordering and prompt/index rendering.
 *
 * No filesystem or Cordis access lives here so the behavior is unit-testable
 * in isolation.
 *
 * @module dsh-memory/lib/retrieval
 */

import { createHash } from 'node:crypto'

/** Default number of records returned by a search. */
export const DEFAULT_SEARCH_LIMIT = 10

/**
 * Normalize a title for deterministic duplicate detection.
 * @param {unknown} value - title candidate.
 * @returns {string} lowercase alphanumeric/CJK text with single spaces.
 */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
}

/**
 * Normalize record content for hashing and similarity.
 * @param {unknown} value - content candidate.
 * @returns {string}
 */
export function normalizeContent(value) {
  if (typeof value !== 'string') return ''
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/**
 * @param {unknown} value - content candidate.
 * @returns {string} stable content hash.
 */
export function contentHash(value) {
  return createHash('sha1').update(normalizeContent(value)).digest('hex')
}

/**
 * Tokenize text into Latin words plus CJK character bigrams. The mixed
 * representation makes the Jaccard similarity meaningful for both English and
 * Chinese entries without an embedding provider.
 * @param {unknown} value - text candidate.
 * @returns {Set<string>}
 */
export function tokenSet(value) {
  const text = normalizeContent(value)
  const tokens = new Set()
  if (text === '') return tokens
  for (const word of text.match(/[a-z0-9_]+/gu) ?? []) {
    if (word.length >= 2) tokens.add(word)
  }
  const cjkRuns = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * Jaccard similarity between the token sets of two texts.
 * @param {unknown} a - first text.
 * @param {unknown} b - second text.
 * @returns {number} 0..1
 */
export function similarity(a, b) {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/**
 * @param {Record<string, any>} record - memory record.
 * @param {string} query - normalized query.
 * @returns {boolean} whether the record matches one of its fields.
 */
export function matchesQuery(record, query) {
  if (query === '') return true
  const haystack = [
    record.title,
    record.summary,
    record.content,
    Array.isArray(record.tags) ? record.tags.join(' ') : '',
  ].join('\n').toLowerCase()
  if (haystack.includes(query.toLowerCase())) return true
  const queryTokens = [...tokenSet(query)]
  if (queryTokens.length === 0) return false
  const recordTokens = tokenSet(haystack)
  return queryTokens.some(token => recordTokens.has(token))
}

/**
 * Weighted relevance score for one record against a query.
 * @param {Record<string, any>} record - memory record.
 * @param {string} query - raw query text.
 * @returns {number} score (0 when not matching).
 */
export function scoreRecord(record, query) {
  const normalized = normalizeContent(query)
  if (normalized === '') return 0
  const tokens = [...tokenSet(query)]
  const title = normalizeContent(record.title)
  const summary = normalizeContent(record.summary)
  const content = normalizeContent(record.content)
  const tags = normalizeContent(Array.isArray(record.tags) ? record.tags.join(' ') : '')
  let score = 0
  if (title.includes(normalized)) score += 12
  if (summary.includes(normalized)) score += 8
  if (tags.includes(normalized)) score += 6
  if (content.includes(normalized)) score += 3
  for (const token of tokens) {
    if (title.includes(token)) score += 6
    if (tags.includes(token)) score += 4
    if (summary.includes(token)) score += 3
    if (content.includes(token)) score += 1
  }
  return score
}

/**
 * Sort records for prompt injection: pinned first, then importance, then the
 * most recently updated.
 * @param {Record<string, any>[]} records - records to sort (not mutated).
 * @returns {Record<string, any>[]} sorted copy.
 */
export function sortForPrompt(records) {
  return [...records].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.importance !== right.importance) return right.importance - left.importance
    return String(right.updatedAt).localeCompare(String(left.updatedAt))
  })
}

/**
 * Filter records for one prompt scope.
 * @param {Record<string, any>[]} records - all records.
 * @param {string | undefined} projectKey - current project scope key.
 * @param {{ projectsEnabled?: boolean }} [options] - deployment switches.
 * @returns {Record<string, any>[]}
 */
export function filterForProject(records, projectKey, options = {}) {
  const projectsEnabled = options.projectsEnabled !== false
  return records.filter((record) => {
    if (record.status !== 'active') return false
    if (record.scope === 'global') return true
    if (!projectsEnabled) return false
    return projectKey !== undefined && record.project?.key === projectKey
  })
}

/**
 * Search records with structured filters.
 * @param {Record<string, any>[]} records - all records.
 * @param {{
 *   query?: string,
 *   scope?: string,
 *   kind?: string,
 *   status?: string,
 *   projectKey?: string,
 *   limit?: number,
 *   offset?: number,
 * }} [options] - filters and paging.
 * @returns {{ items: Record<string, any>[], total: number }}
 */
export function searchRecords(records, options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const status = options.status ?? 'active'
  let filtered = records.filter(record => {
    if (status !== 'all' && record.status !== status) return false
    if (options.scope !== undefined && options.scope !== '' && record.scope !== options.scope) return false
    if (options.kind !== undefined && options.kind !== '' && record.kind !== options.kind) return false
    if (options.projectKey !== undefined && options.projectKey !== '') {
      if (record.scope === 'project' && record.project?.key !== options.projectKey) return false
    }
    return true
  })
  let scored = filtered
  if (query !== '') {
    scored = filtered
      .map(record => ({ record, score: scoreRecord(record, query) }))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score
        || String(right.record.updatedAt).localeCompare(String(left.record.updatedAt)))
      .map(entry => entry.record)
  } else {
    scored = sortForPrompt(filtered)
  }
  const offset = Math.max(0, Number.isFinite(options.offset) ? Number(options.offset) : 0)
  const limit = Math.max(1, Number.isFinite(options.limit) ? Number(options.limit) : DEFAULT_SEARCH_LIMIT)
  return { items: scored.slice(offset, offset + limit), total: scored.length }
}

/**
 * @param {string} iso - ISO timestamp.
 * @returns {string} `YYYY-MM-DD` date label.
 */
export function dateLabel(iso) {
  const text = typeof iso === 'string' ? iso : ''
  return text.length >= 10 ? text.slice(0, 10) : text
}

/**
 * @param {Record<string, any>} record - memory record.
 * @returns {string} compact scope label (`global` or `project:<name>`).
 */
export function scopeLabel(record) {
  if (record.scope !== 'project') return 'global'
  const name = record.project?.name || record.project?.key || ''
  return name === '' ? 'project' : `project:${name}`
}

/**
 * Render the memory index injected into the model prompt. Only summaries are
 * included; the body must be fetched through the memory tool.
 * @param {Record<string, any>[]} records - active records already filtered for scope.
 * @param {{ maxTopics?: number, maxChars?: number }} [options] - budget.
 * @returns {{ text: string, included: number, omitted: number }}
 */
export function renderIndex(records, options = {}) {
  const maxTopics = Math.max(1, Number.isFinite(options.maxTopics) ? Number(options.maxTopics) : 30)
  const maxChars = Math.max(1, Number.isFinite(options.maxChars) ? Number(options.maxChars) : 4000)
  const ordered = sortForPrompt(records).slice(0, maxTopics)
  const lines = []
  let used = 0
  let included = 0
  for (const record of ordered) {
    const line = `- ${record.id} · ${record.kind} · ${scopeLabel(record)} · ${dateLabel(record.updatedAt)} · ${record.summary}`
    const cost = line.length + 1
    if (used + cost > maxChars) break
    lines.push(line)
    used += cost
    included += 1
  }
  return { text: lines.join('\n'), included, omitted: Math.max(0, records.length - included) }
}

/**
 * Render the compact index handed to the judge so it can update an existing
 * topic instead of creating a duplicate.
 * @param {Record<string, any>[]} records - records to include.
 * @param {number} [maxChars] - character budget.
 * @returns {string}
 */
export function renderJudgeIndex(records, maxChars = 8000) {
  const ordered = sortForPrompt(records).filter(record => record.status === 'active')
  const lines = []
  let used = 0
  for (const record of ordered) {
    const line = `- ${record.id} | ${record.kind} | ${scopeLabel(record)} | ${record.title} | ${record.summary}`
    const cost = line.length + 1
    if (used + cost > maxChars) break
    lines.push(line)
    used += cost
  }
  return lines.join('\n')
}

/**
 * Aggregate counts used by the settings page and `/memory status`.
 * @param {Record<string, any>[]} records - all records.
 * @returns {{ total: number, active: number, archived: number, global: number, project: number, pinned: number }}
 */
export function counts(records) {
  const result = { total: records.length, active: 0, archived: 0, global: 0, project: 0, pinned: 0 }
  for (const record of records) {
    if (record.status === 'active') result.active += 1
    else result.archived += 1
    if (record.scope === 'global') result.global += 1
    else result.project += 1
    if (record.pinned) result.pinned += 1
  }
  return result
}
