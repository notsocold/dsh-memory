/**
 * Unit tests for lib/retrieval.js — normalization, matching, ranking,
 * filtering, paging and prompt/index rendering.
 *
 * Run from the plugin root:
 *   node --test test/retrieval.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SEARCH_LIMIT,
  contentHash,
  counts,
  dateLabel,
  filterForProject,
  normalizeTitle,
  renderIndex,
  renderJudgeIndex,
  scopeLabel,
  scoreRecord,
  searchRecords,
  similarity,
  sortForPrompt,
  tokenSet,
} from '../lib/retrieval.js'

let nextId = 1

/** Build a complete record with predictable defaults. */
function makeRecord(overrides = {}) {
  const id = overrides.id ?? `m_${String(nextId++).padStart(8, '0')}`
  return {
    id,
    title: 'Untitled',
    summary: 'Summary',
    content: 'Content',
    kind: 'reference',
    scope: 'global',
    project: null,
    tags: [],
    importance: 3,
    pinned: false,
    status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    source: { origin: 'auto' },
    ...overrides,
  }
}

function sampleRecords() {
  return [
    makeRecord({
      id: 'm_00000001',
      title: 'Alpha tools',
      summary: 'uses pnpm',
      content: 'install with pnpm',
      kind: 'preference',
      importance: 5,
      updatedAt: '2024-01-01T00:00:00.000Z',
    }),
    makeRecord({
      id: 'm_00000002',
      title: 'Beta project',
      summary: 'alpha context',
      content: 'project facts',
      kind: 'project',
      scope: 'project',
      project: { key: '/repo/a', name: 'a' },
      updatedAt: '2024-01-03T00:00:00.000Z',
    }),
    makeRecord({
      id: 'm_00000003',
      title: 'Gamma todo',
      summary: 'later',
      content: 'alpha followup',
      kind: 'todo',
      scope: 'project',
      project: { key: '/repo/b', name: 'b' },
      updatedAt: '2024-01-02T00:00:00.000Z',
    }),
    makeRecord({
      id: 'm_00000004',
      title: 'Archived alpha',
      summary: 'old',
      content: 'old',
      status: 'archived',
      updatedAt: '2024-01-04T00:00:00.000Z',
    }),
    makeRecord({
      id: 'm_00000005',
      title: 'Delta',
      summary: 'misc',
      content: 'misc',
      updatedAt: '2024-01-05T00:00:00.000Z',
    }),
  ]
}

describe('normalizeTitle', () => {
  it('lowercases and collapses punctuation and whitespace', () => {
    assert.equal(normalizeTitle('  Hello,   World!  '), 'hello world')
    assert.equal(normalizeTitle('ABC_def-ghi'), 'abc def ghi')
  })

  it('applies NFKC normalization', () => {
    assert.equal(normalizeTitle('Ｃａｆｅ　１２３'), 'cafe 123')
  })

  it('collapses CJK punctuation but preserves CJK characters', () => {
    assert.equal(normalizeTitle('记忆，插件！'), '记忆 插件')
    assert.equal(normalizeTitle('ＡＢＣ记忆'), 'abc记忆')
  })

  it('returns an empty string for non-string values', () => {
    assert.equal(normalizeTitle(undefined), '')
    assert.equal(normalizeTitle(null), '')
    assert.equal(normalizeTitle(42), '')
    assert.equal(normalizeTitle('   '), '')
  })
})

describe('contentHash', () => {
  it('returns a stable 40-character sha1 hex digest', () => {
    const hash = contentHash('Alpha  Beta\n')
    assert.match(hash, /^[0-9a-f]{40}$/)
    assert.equal(contentHash('Alpha  Beta\n'), hash)
    assert.equal(contentHash(' alpha beta '), hash)
  })

  it('changes when the normalized content changes', () => {
    assert.notEqual(contentHash('alpha beta'), contentHash('alpha gamma'))
    assert.notEqual(contentHash('alpha beta'), contentHash('alpha beta more'))
  })

  it('normalizes empty and non-string input predictably', () => {
    assert.equal(contentHash(''), contentHash('   \n\t '))
    assert.equal(contentHash(null), contentHash(''))
    assert.equal(contentHash(42), contentHash(''))
  })
})

describe('tokenSet / similarity', () => {
  it('tokenizes lowercased Latin words of at least two characters', () => {
    const tokens = tokenSet('Alpha beta ALPHA x 1')
    assert.deepEqual([...tokens].sort(), ['alpha', 'beta'])
    assert.equal(tokens.has('x'), false)
    assert.equal(tokens.has('1'), false)
  })

  it('tokenizes CJK runs into character bigrams', () => {
    const tokens = tokenSet('记忆插件')
    assert.equal(tokens.size, 3)
    assert.ok(tokens.has('记忆'))
    assert.ok(tokens.has('忆插'))
    assert.ok(tokens.has('插件'))
    assert.equal(tokenSet('记').has('记'), true)
  })

  it('handles mixed Latin and CJK text', () => {
    const tokens = tokenSet('使用 pnpm 记忆')
    assert.deepEqual([...tokens].sort(), ['pnpm', '使用', '记忆'])
  })

  it('returns an empty set for empty and non-string values', () => {
    assert.equal(tokenSet('').size, 0)
    assert.equal(tokenSet(undefined).size, 0)
    assert.equal(tokenSet(42).size, 0)
  })

  it('computes Jaccard similarity for Latin text', () => {
    assert.equal(similarity('alpha beta', 'alpha beta'), 1)
    assert.equal(similarity('alpha beta', 'gamma delta'), 0)
    assert.equal(similarity('alpha beta gamma', 'alpha beta delta'), 0.5)
    assert.equal(similarity('Alpha  Beta', 'alpha beta'), 1)
    assert.equal(similarity('alpha beta', 'alpha beta gamma'), 2 / 3)
  })

  it('computes Jaccard similarity for CJK bigrams and is symmetric', () => {
    const left = '记忆插件'
    const right = '记忆工具'
    assert.ok(Math.abs(similarity(left, right) - 0.2) < 1e-12)
    assert.equal(similarity(left, right), similarity(right, left))
  })

  it('returns zero when either side has no tokens', () => {
    assert.equal(similarity('', 'alpha'), 0)
    assert.equal(similarity('alpha', ''), 0)
    assert.equal(similarity('', ''), 0)
    assert.equal(similarity(null, 42), 0)
  })
})

describe('scoreRecord', () => {
  it('ranks title matches above summary matches above content matches', () => {
    const titleHit = scoreRecord(makeRecord({ title: 'alpha', summary: 'none', content: 'none' }), 'alpha')
    const summaryHit = scoreRecord(makeRecord({ title: 'none', summary: 'alpha', content: 'none' }), 'alpha')
    const contentHit = scoreRecord(makeRecord({ title: 'none', summary: 'none', content: 'alpha' }), 'alpha')
    assert.equal(titleHit, 18)
    assert.equal(summaryHit, 11)
    assert.equal(contentHit, 4)
    assert.ok(titleHit > summaryHit)
    assert.ok(summaryHit > contentHit)
  })

  it('gives tag matches weight between summary and title', () => {
    const tagHit = scoreRecord(makeRecord({ title: 'none', summary: 'none', content: 'none', tags: ['alpha'] }), 'alpha')
    assert.equal(tagHit, 10)
    assert.ok(tagHit < 11)
    assert.ok(tagHit > 4)
  })

  it('returns zero for an empty query or a non-match', () => {
    const record = makeRecord({ title: 'alpha', summary: 'beta', content: 'gamma' })
    assert.equal(scoreRecord(record, ''), 0)
    assert.equal(scoreRecord(record, '   '), 0)
    assert.equal(scoreRecord(record, 'zeta'), 0)
  })

  it('normalizes case and whitespace in the query', () => {
    const record = makeRecord({ title: 'Alpha tools', summary: 'none', content: 'none' })
    assert.equal(scoreRecord(record, '  ALPHA  '), scoreRecord(record, 'alpha'))
  })

  it('matches CJK query substrings', () => {
    const record = makeRecord({ title: '记忆插件', summary: 'none', content: 'none' })
    assert.ok(scoreRecord(record, '记忆') > 0)
    assert.ok(scoreRecord(record, '插件') > 0)
    assert.equal(scoreRecord(record, '工具'), 0)
  })
})

describe('searchRecords', () => {
  it('filters by query and ranks by score', () => {
    const result = searchRecords(sampleRecords(), { query: 'alpha' })
    assert.equal(result.total, 3)
    assert.deepEqual(result.items.map((record) => record.id), ['m_00000001', 'm_00000002', 'm_00000003'])
  })

  it('excludes archived records by default and includes them for status=all', () => {
    const active = searchRecords(sampleRecords(), { query: 'alpha' })
    assert.equal(active.items.some((record) => record.id === 'm_00000004'), false)

    const all = searchRecords(sampleRecords(), { query: 'alpha', status: 'all' })
    assert.equal(all.total, 4)
    assert.ok(all.items.some((record) => record.id === 'm_00000004'))

    const archived = searchRecords(sampleRecords(), { status: 'archived' })
    assert.deepEqual(archived.items.map((record) => record.id), ['m_00000004'])
    assert.equal(archived.total, 1)
  })

  it('filters by scope and kind', () => {
    const global = searchRecords(sampleRecords(), { scope: 'global' })
    assert.deepEqual(global.items.map((record) => record.id), ['m_00000001', 'm_00000005'])

    const projects = searchRecords(sampleRecords(), { scope: 'project', status: 'all' })
    assert.deepEqual(projects.items.map((record) => record.id), ['m_00000002', 'm_00000003'])

    const todo = searchRecords(sampleRecords(), { kind: 'todo' })
    assert.deepEqual(todo.items.map((record) => record.id), ['m_00000003'])
    assert.equal(todo.total, 1)
  })

  it('filters project records by projectKey while keeping global records', () => {
    const result = searchRecords(sampleRecords(), { projectKey: '/repo/a' })
    const ids = result.items.map((record) => record.id)
    assert.ok(ids.includes('m_00000002'))
    assert.ok(ids.includes('m_00000001'))
    assert.ok(ids.includes('m_00000005'))
    assert.equal(ids.includes('m_00000003'), false)
    assert.equal(ids.includes('m_00000004'), false)
    assert.equal(result.total, 3)
  })

  it('combines query and structured filters', () => {
    const project = searchRecords(sampleRecords(), { query: 'alpha', kind: 'project' })
    assert.deepEqual(project.items.map((record) => record.id), ['m_00000002'])
    assert.equal(project.total, 1)

    const scoped = searchRecords(sampleRecords(), { query: 'alpha', scope: 'project' })
    assert.deepEqual(scoped.items.map((record) => record.id), ['m_00000002', 'm_00000003'])
  })

  it('returns no matches for an unknown query', () => {
    const result = searchRecords(sampleRecords(), { query: 'no-such-token-xyz' })
    assert.deepEqual(result.items, [])
    assert.equal(result.total, 0)
  })

  it('pages with limit and offset while preserving the total', () => {
    const all = searchRecords(sampleRecords(), {})
    assert.deepEqual(all.items.map((record) => record.id), ['m_00000001', 'm_00000005', 'm_00000002', 'm_00000003'])
    assert.equal(all.total, 4)

    const page = searchRecords(sampleRecords(), { offset: 1, limit: 2 })
    assert.deepEqual(page.items.map((record) => record.id), ['m_00000005', 'm_00000002'])
    assert.equal(page.total, 4)

    const beyond = searchRecords(sampleRecords(), { offset: 10, limit: 2 })
    assert.deepEqual(beyond.items, [])
    assert.equal(beyond.total, 4)
  })

  it('applies the default limit of 10', () => {
    const records = Array.from({ length: 12 }, (_, index) => makeRecord({
      id: `m_${String(index + 100).padStart(8, '0')}`,
      updatedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    }))
    const result = searchRecords(records, {})
    assert.equal(result.items.length, DEFAULT_SEARCH_LIMIT)
    assert.equal(result.total, 12)
  })

  it('applies query and paging together', () => {
    const result = searchRecords(sampleRecords(), { query: 'alpha', limit: 1, offset: 0 })
    assert.equal(result.total, 3)
    assert.deepEqual(result.items.map((record) => record.id), ['m_00000001'])
  })
})

describe('sortForPrompt', () => {
  it('sorts pinned first, then by importance, then by newest update', () => {
    const input = [
      makeRecord({ id: 'm_00000001', title: 'old-high', importance: 5, updatedAt: '2024-01-01T00:00:00.000Z' }),
      makeRecord({ id: 'm_00000002', title: 'pinned-low', importance: 1, pinned: true, updatedAt: '2023-01-01T00:00:00.000Z' }),
      makeRecord({ id: 'm_00000003', title: 'new-mid', importance: 3, updatedAt: '2024-06-01T00:00:00.000Z' }),
      makeRecord({ id: 'm_00000004', title: 'mid-old', importance: 3, updatedAt: '2024-02-01T00:00:00.000Z' }),
    ]
    const sorted = sortForPrompt(input)
    assert.deepEqual(sorted.map((record) => record.id), [
      'm_00000002',
      'm_00000001',
      'm_00000003',
      'm_00000004',
    ])
  })

  it('does not mutate the input array', () => {
    const input = [
      makeRecord({ id: 'm_00000001', importance: 1 }),
      makeRecord({ id: 'm_00000002', importance: 5 }),
    ]
    const before = input.map((record) => record.id)
    sortForPrompt(input)
    assert.deepEqual(input.map((record) => record.id), before)
  })

  it('returns an empty array for no records', () => {
    assert.deepEqual(sortForPrompt([]), [])
  })
})

describe('filterForProject', () => {
  function projectRecords() {
    return [
      makeRecord({ id: 'g', title: 'global', scope: 'global' }),
      makeRecord({ id: 'a', title: 'project a', scope: 'project', project: { key: '/repo/a', name: 'a' } }),
      makeRecord({ id: 'b', title: 'project b', scope: 'project', project: { key: '/repo/b', name: 'b' } }),
      makeRecord({ id: 'archived-project', title: 'archived a', scope: 'project', project: { key: '/repo/a', name: 'a' }, status: 'archived' }),
      makeRecord({ id: 'archived-global', title: 'archived global', scope: 'global', status: 'archived' }),
    ]
  }

  it('keeps global records and matching project records only', () => {
    const result = filterForProject(projectRecords(), '/repo/a')
    assert.deepEqual(result.map((record) => record.id), ['g', 'a'])
  })

  it('excludes project records for other project keys', () => {
    const result = filterForProject(projectRecords(), '/repo/b')
    assert.deepEqual(result.map((record) => record.id), ['g', 'b'])
  })

  it('excludes all project records when no project key is supplied', () => {
    const result = filterForProject(projectRecords(), undefined)
    assert.deepEqual(result.map((record) => record.id), ['g'])
  })

  it('excludes project records when projects are disabled', () => {
    const result = filterForProject(projectRecords(), '/repo/a', { projectsEnabled: false })
    assert.deepEqual(result.map((record) => record.id), ['g'])
  })

  it('excludes archived records in every mode', () => {
    const result = filterForProject(projectRecords(), '/repo/a', { projectsEnabled: true })
    assert.equal(result.some((record) => record.id === 'archived-project'), false)
    assert.equal(result.some((record) => record.id === 'archived-global'), false)
  })
})

describe('renderIndex', () => {
  it('renders id, kind, scope, date and summary lines', () => {
    const record = makeRecord({
      id: 'm_0000000a',
      kind: 'preference',
      scope: 'project',
      project: { key: '/repo/a', name: 'alpha' },
      updatedAt: '2024-05-06T07:08:09.000Z',
      summary: 'Use pnpm.',
      content: 'Body must not appear.',
    })
    const result = renderIndex([record])
    assert.equal(result.text, '- m_0000000a · preference · project:alpha · 2024-05-06 · Use pnpm.')
    assert.equal(result.text.includes('Body must not appear.'), false)
    assert.equal(result.included, 1)
    assert.equal(result.omitted, 0)
  })

  it('uses the global scope label for global records', () => {
    const result = renderIndex([makeRecord({ summary: 'hello' })])
    assert.match(result.text, / · global · \d{4}-\d{2}-\d{2} · hello$/)
  })

  it('honors the maxTopics budget and reports omitted records', () => {
    const records = [
      makeRecord({ id: 'm_00000001', summary: 'one', importance: 5 }),
      makeRecord({ id: 'm_00000002', summary: 'two', importance: 4 }),
      makeRecord({ id: 'm_00000003', summary: 'three', importance: 3 }),
      makeRecord({ id: 'm_00000004', summary: 'four', importance: 2 }),
    ]
    const result = renderIndex(records, { maxTopics: 2 })
    assert.equal(result.included, 2)
    assert.equal(result.omitted, 2)
    assert.ok(result.text.includes('one'))
    assert.ok(result.text.includes('two'))
    assert.equal(result.text.includes('three'), false)
    assert.equal(result.text.includes('four'), false)
  })

  it('honors the maxChars budget at exact line cost', () => {
    const records = [
      makeRecord({ id: 'm_00000001', summary: 'one' }),
      makeRecord({ id: 'm_00000002', summary: 'two' }),
    ]
    const full = renderIndex(records, { maxChars: 4000 })
    const firstLine = full.text.split('\n')[0]
    const result = renderIndex(records, { maxChars: firstLine.length + 1 })
    assert.equal(result.text, firstLine)
    assert.equal(result.included, 1)
    assert.equal(result.omitted, 1)
  })

  it('includes nothing when the budget cannot fit one line', () => {
    const records = [
      makeRecord({ id: 'm_00000001', summary: 'one' }),
      makeRecord({ id: 'm_00000002', summary: 'two' }),
      makeRecord({ id: 'm_00000003', summary: 'three' }),
    ]
    const result = renderIndex(records, { maxChars: 1 })
    assert.equal(result.text, '')
    assert.equal(result.included, 0)
    assert.equal(result.omitted, 3)
  })

  it('returns an empty result for no records', () => {
    assert.deepEqual(renderIndex([]), { text: '', included: 0, omitted: 0 })
  })
})

describe('renderJudgeIndex', () => {
  it('renders the compact id | kind | scope | title | summary format', () => {
    const record = makeRecord({
      id: 'm_0000000a',
      kind: 'preference',
      scope: 'project',
      project: { key: '/repo/a', name: 'alpha' },
      title: 'Use pnpm',
      summary: 'Prefer pnpm.',
    })
    assert.equal(renderJudgeIndex([record]), '- m_0000000a | preference | project:alpha | Use pnpm | Prefer pnpm.')
  })

  it('filters out archived records', () => {
    const records = [
      makeRecord({ id: 'm_00000001', title: 'active', status: 'active' }),
      makeRecord({ id: 'm_00000002', title: 'archived', status: 'archived' }),
    ]
    const text = renderJudgeIndex(records)
    assert.ok(text.includes('active'))
    assert.equal(text.includes('archived'), false)
    assert.equal(text.split('\n').length, 1)
  })

  it('sorts pinned records first', () => {
    const records = [
      makeRecord({ id: 'm_00000001', title: 'normal', importance: 5 }),
      makeRecord({ id: 'm_00000002', title: 'pinned', importance: 1, pinned: true }),
    ]
    assert.equal(renderJudgeIndex(records).split('\n')[0].includes('pinned'), true)
  })

  it('honors the character budget', () => {
    const records = [
      makeRecord({ id: 'm_00000001', title: 'one', summary: 'first' }),
      makeRecord({ id: 'm_00000002', title: 'two', summary: 'second' }),
    ]
    const full = renderJudgeIndex(records, 8000)
    const firstLine = full.split('\n')[0]
    assert.equal(renderJudgeIndex(records, firstLine.length + 1), firstLine)
    assert.equal(renderJudgeIndex(records, 1), '')
  })

  it('returns an empty string for no records', () => {
    assert.equal(renderJudgeIndex([]), '')
  })
})

describe('counts', () => {
  it('aggregates total, status, scope and pinned counts', () => {
    const records = [
      makeRecord({ id: 'm_00000001', scope: 'global', status: 'active', pinned: true }),
      makeRecord({ id: 'm_00000002', scope: 'global', status: 'active' }),
      makeRecord({ id: 'm_00000003', scope: 'project', project: { key: '/repo', name: 'repo' }, status: 'active' }),
      makeRecord({ id: 'm_00000004', scope: 'project', project: { key: '/repo', name: 'repo' }, status: 'archived', pinned: true }),
    ]
    assert.deepEqual(counts(records), {
      total: 4,
      active: 3,
      archived: 1,
      global: 2,
      project: 2,
      pinned: 2,
    })
  })

  it('returns zero counts for no records', () => {
    assert.deepEqual(counts([]), {
      total: 0,
      active: 0,
      archived: 0,
      global: 0,
      project: 0,
      pinned: 0,
    })
  })
})

describe('dateLabel / scopeLabel', () => {
  it('dateLabel extracts the YYYY-MM-DD prefix', () => {
    assert.equal(dateLabel('2024-05-06T07:08:09.000Z'), '2024-05-06')
    assert.equal(dateLabel('2024-05-06'), '2024-05-06')
    assert.equal(dateLabel('short'), 'short')
    assert.equal(dateLabel(''), '')
    assert.equal(dateLabel(null), '')
    assert.equal(dateLabel(42), '')
  })

  it('scopeLabel renders global and project labels', () => {
    assert.equal(scopeLabel({ scope: 'global' }), 'global')
    assert.equal(scopeLabel({ scope: 'project', project: { key: '/repo', name: 'repo' } }), 'project:repo')
    assert.equal(scopeLabel({ scope: 'project', project: { key: '/repo' } }), 'project:/repo')
    assert.equal(scopeLabel({ scope: 'project' }), 'project')
    assert.equal(scopeLabel({ scope: 'project', project: { name: '', key: '' } }), 'project')
    assert.equal(scopeLabel({}), 'global')
  })
})
