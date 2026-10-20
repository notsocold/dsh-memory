/**
 * Markdown topic-file format.
 *
 * Topic files are the single source of truth for memories. Each file starts
 * with a small YAML-like frontmatter block (our writes use JSON-compatible
 * scalars, which are valid YAML) and carries the memory body after it.
 * `MEMORY.md` is a generated index, never authoritative.
 *
 * External files are tolerated: missing frontmatter, unknown keys, plain
 * Markdown headings and unquoted scalars all fall back to sensible metadata so
 * a hand-written topic file still loads.
 *
 * @module dsh-memory/lib/frontmatter
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  LIMITS,
  MEMORY_ID_PATTERN,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_STATUSES,
  isRecord,
  normalizeTimestamp,
} from './state.js'

/** Marker line that delimits the frontmatter block. */
const FENCE = '---'

/** Maximum body length accepted from an external file before truncation. */
const MAX_BODY_CHARS = 32000

/**
 * Slugify a title for a stable, readable file name (Unicode letters kept).
 * @param {string} title - topic title.
 * @returns {string}
 */
export function slugifyTitle(title) {
  if (typeof title !== 'string') return 'topic'
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return slug === '' ? 'topic' : slug
}

/**
 * File name for one record. Existing files keep their name; new files get a
 * readable `m_<id>-<slug>.md` form.
 * @param {Record<string, any>} record - memory record.
 * @returns {string}
 */
export function topicFilename(record) {
  return `${record.id}-${slugifyTitle(record.title)}.md`
}

/**
 * @param {unknown} value - string candidate.
 * @returns {string}
 */
function stripControlCharacters(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\r\n?/gu, '\n')
}

/**
 * @param {unknown} value - scalar candidate.
 * @returns {any}
 */
function parseScalar(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text.startsWith('"') || text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1)
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)) return Number(text)
  return text
}

/**
 * Parse the leading frontmatter block.
 * @param {string} source - full file text.
 * @returns {{ meta: Record<string, any>, body: string, hadFrontmatter: boolean, error?: string }}
 */
export function parseFrontmatter(source) {
  const text = typeof source === 'string' ? source.replace(/^\uFEFF/u, '') : ''
  if (text !== '' && text.startsWith(FENCE)) {
    const firstBreak = text.indexOf('\n')
    const blockStart = firstBreak === -1 ? -1 : firstBreak + 1
    if (blockStart >= 0) {
      const close = text.indexOf(`\n${FENCE}`, blockStart)
      if (close >= 0) {
        const block = text.slice(blockStart, close)
        const after = text.slice(close + FENCE.length + 1).replace(/^\n+/u, '')
        return { meta: parseFrontmatterBlock(block), body: after, hadFrontmatter: true }
      }
      return {
        meta: {},
        body: stripControlCharacters(text),
        hadFrontmatter: false,
        error: 'frontmatter block is not terminated',
      }
    }
  }
  return { meta: {}, body: stripControlCharacters(text), hadFrontmatter: false }
}

/**
 * Parse the inside of one frontmatter block into a shallow object.
 * @param {string} block - lines between the fences.
 * @returns {Record<string, any>}
 */
export function parseFrontmatterBlock(block) {
  /** @type {Record<string, any>} */
  const meta = {}
  const lines = block.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    const raw = match[2]
    if (raw.trim() === '') {
      // Block list or nested mapping: collect indented lines.
      const items = []
      let nested = false
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]
        if (next.trim() === '') continue
        if (!/^\s+/u.test(next)) break
        const item = /^\s+-\s+(.*)$/u.exec(next)
        if (item !== null) {
          items.push(parseScalar(item[1]))
        } else {
          nested = true
          const pair = /^\s+([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/u.exec(next)
          if (pair !== null) {
            if (!isRecord(meta[key])) meta[key] = {}
            meta[key][pair[1]] = parseScalar(pair[2])
          }
        }
      }
      index = cursor - 1
      if (items.length > 0) meta[key] = items
      else if (!nested && !(isRecord(meta[key]))) meta[key] = []
    } else {
      meta[key] = parseScalar(raw)
    }
  }
  return meta
}

/**
 * Convert one topic file into a normalized memory record.
 * @param {{
 *   text: string,
 *   filename: string,
 *   scope: 'global' | 'project',
 *   project?: { key: string, name: string } | null,
 *   mtimeMs?: number,
 *   now?: number,
 * }} options - file contents and location facts.
 * @returns {{ record?: Record<string, any>, error?: string }}
 */
export function recordFromTopicFile(options) {
  const { text, filename, scope, project = null } = options
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const parsed = parseFrontmatter(text)
  const meta = parsed.meta
  const body = parsed.body.trim()
  if (body === '') return { error: 'topic file has no body' }
  const stem = basename(filename, '.md')
  const idFromName = /^(m_[0-9a-f]{8})(?:-|$)/u.exec(stem)?.[1]
  const id = typeof meta.id === 'string' && MEMORY_ID_PATTERN.test(meta.id)
    ? meta.id
    : idFromName !== undefined
      ? idFromName
      : `m_${createHash('sha1').update(`${scope}:${filename}`).digest('hex').slice(0, 8)}`
  const heading = body.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim()
  const title = normalizeText(meta.title, LIMITS.title)
    || normalizeText(heading, LIMITS.title)
    || normalizeText(stem.replace(/^m_[0-9a-f]{8}-?/u, '').replace(/-/gu, ' '), LIMITS.title)
    || 'Untitled memory'
  const summary = normalizeText(meta.summary, LIMITS.summary)
    || normalizeText(firstLine(body), LIMITS.summary)
  const kind = MEMORY_KINDS.includes(meta.kind) ? meta.kind : 'reference'
  const status = MEMORY_STATUSES.includes(meta.status) ? meta.status : 'active'
  const origin = MEMORY_ORIGINS.includes(meta.origin) ? meta.origin : 'import'
  const importance = clampImportance(meta.importance)
  const createdAt = normalizeTimestamp(meta.created)
    ?? new Date(Number.isFinite(options.mtimeMs) ? options.mtimeMs : now).toISOString()
  const updatedAt = normalizeTimestamp(meta.modified)
    ?? new Date(Number.isFinite(options.mtimeMs) ? options.mtimeMs : now).toISOString()
  const tags = normalizeTags(meta.tags)
  const record = {
    id,
    title,
    summary,
    content: body.slice(0, MAX_BODY_CHARS),
    kind,
    scope,
    project: scope === 'project' && project !== null ? { key: project.key, name: project.name } : null,
    tags,
    importance,
    pinned: meta.pinned === true,
    status,
    createdAt,
    updatedAt,
    revision: Math.max(1, toInteger(meta.revision, 1)),
    source: {
      origin,
      ...(typeof meta.sessionId === 'string' && meta.sessionId !== '' ? { sessionId: meta.sessionId.slice(0, 200) } : {}),
      ...(typeof meta.sessionTitle === 'string' && meta.sessionTitle !== '' ? { sessionTitle: limitText(meta.sessionTitle, LIMITS.sessionTitle) } : {}),
      ...(typeof meta.model === 'string' && meta.model !== '' ? { model: meta.model.slice(0, 200) } : {}),
    },
  }
  if (scope === 'project' && record.project === null) return { error: 'project topic lost its project reference' }
  return { record }
}

/**
 * Render one record as a topic file.
 * @param {Record<string, any>} record - memory record.
 * @param {string} [modified] - explicit modified timestamp.
 * @returns {string}
 */
export function renderTopicFile(record, modified) {
  const lines = [
    FENCE,
    `id: ${yamlString(record.id)}`,
    `title: ${yamlString(record.title)}`,
    `summary: ${yamlString(record.summary)}`,
    `kind: ${yamlString(record.kind)}`,
    `importance: ${Number(record.importance)}`,
    `tags: ${JSON.stringify(Array.isArray(record.tags) ? record.tags : [])}`,
    `pinned: ${record.pinned === true}`,
    `status: ${yamlString(record.status)}`,
    `created: ${yamlString(record.createdAt)}`,
    `modified: ${yamlString(modified ?? record.updatedAt)}`,
    `revision: ${Number(record.revision)}`,
    `origin: ${yamlString(record.source?.origin ?? 'import')}`,
    ...(record.source?.sessionId === undefined ? [] : [`sessionId: ${yamlString(record.source.sessionId)}`]),
    ...(record.source?.sessionTitle === undefined ? [] : [`sessionTitle: ${yamlString(record.source.sessionTitle)}`]),
    ...(record.source?.model === undefined ? [] : [`model: ${yamlString(record.source.model)}`]),
    FENCE,
    '',
    `${record.content.trim()}\n`,
  ]
  return lines.join('\n')
}

/**
 * Render the generated `MEMORY.md` index for one collection.
 * @param {Record<string, any>[]} records - collection records.
 * @param {{ scope: 'global' | 'project', project?: { key: string, name: string } | null, now?: number }} options
 * @returns {string}
 */
export function renderMemoryIndex(records, options) {
  const active = records.filter(record => record.status === 'active')
  active.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.importance !== right.importance) return right.importance - left.importance
    return String(right.updatedAt).localeCompare(String(left.updatedAt))
  })
  const title = options.scope === 'global'
    ? 'dsh-memory · Global'
    : `dsh-memory · Project ${options.project?.name ?? ''}`.trim()
  const lines = [
    `# ${title}`,
    '',
    '> Generated index. Topic files in this directory are the source of truth;',
    '> edits here are overwritten. Edit a topic file or use Settings → Memory.',
    '',
  ]
  if (options.scope === 'project' && options.project !== undefined && options.project !== null) {
    lines.push(`Project: \`${options.project.key}\``, '')
  }
  lines.push(`Active topics: ${active.length}`, '')
  if (active.length === 0) {
    lines.push('(no active topics)')
  } else {
    for (const record of active) {
      const link = escapeLinkText(record.title)
      const summary = String(record.summary ?? '').replace(/\s+/gu, ' ').trim()
      lines.push(`- [${link}](${topicFilename(record)}) — ${summary} · \`${record.kind}\` · importance ${record.importance} · ${String(record.updatedAt).slice(0, 10)}${record.pinned ? ' · pinned' : ''}`)
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * @param {unknown} value - string candidate.
 * @returns {string} JSON-quoted YAML scalar.
 */
export function yamlString(value) {
  return JSON.stringify(typeof value === 'string' ? value : String(value ?? ''))
}

/**
 * @param {unknown} value - raw text.
 * @param {number} max - bound.
 * @returns {string}
 */
function normalizeText(value, max) {
  return stripControlCharacters(value).replace(/\s+/gu, ' ').trim().slice(0, max)
}

/**
 * @param {unknown} value - raw text.
 * @param {number} max - bound.
 * @returns {string}
 */
function limitText(value, max) {
  return stripControlCharacters(value).trim().slice(0, max)
}

/**
 * @param {string} body - markdown body.
 * @returns {string} first non-empty line with Markdown markers removed.
 */
function firstLine(body) {
  const line = body.split('\n').map(item => item.trim()).find(item => item !== '') ?? ''
  return line.replace(/^#{1,6}\s+/u, '').replace(/^[-*+]\s+/u, '')
}

/**
 * @param {unknown} value - markdown text.
 * @returns {string}
 */
function escapeLinkText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').replace(/[[\]]/gu, match => `\\${match}`)
}

/**
 * @param {unknown} value - importance candidate.
 * @returns {number}
 */
function clampImportance(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(5, Math.max(1, Math.round(number))) : 3
}

/**
 * @param {unknown} value - numeric candidate.
 * @param {number} fallback - default.
 * @returns {number}
 */
function toInteger(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

/**
 * @param {unknown} value - tags candidate.
 * @returns {string[]}
 */
function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const tags = []
  for (const item of raw) {
    const tag = normalizeText(item, LIMITS.tag)
    if (tag === '' || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= LIMITS.tags) break
  }
  return tags
}

/** @type {ReadonlySet<string>} */
export const KNOWN_FRONTMATTER_KEYS = new Set([
  'id', 'title', 'summary', 'kind', 'importance', 'tags', 'pinned', 'status',
  'created', 'modified', 'revision', 'origin', 'sessionId', 'sessionTitle', 'model',
])
