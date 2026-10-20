/**
 * Unit tests for the Markdown topic-file format.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFrontmatter,
  recordFromTopicFile,
  renderMemoryIndex,
  renderTopicFile,
  slugifyTitle,
  topicFilename,
} from '../lib/frontmatter.js'

/**
 * @param {Record<string, any>} [overrides] - record overrides.
 * @returns {Record<string, any>} a full record.
 */
function record(overrides = {}) {
  return {
    id: 'm_12345678',
    title: 'User prefers pnpm',
    summary: 'Use pnpm for Node.js projects.',
    content: 'The user always uses pnpm.\n\nSecond paragraph.',
    kind: 'preference',
    scope: 'global',
    project: null,
    tags: ['pnpm', 'node'],
    importance: 4,
    pinned: false,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    revision: 2,
    source: { origin: 'tool', sessionId: 'sess-1', sessionTitle: 'Setup', model: 'provider/model' },
    ...overrides,
  }
}

test('frontmatter: slugs and file names are readable and stable', () => {
  assert.equal(slugifyTitle('User prefers pnpm!'), 'user-prefers-pnpm')
  assert.equal(slugifyTitle('  用户偏好：pnpm & yarn  '), '用户偏好-pnpm-yarn')
  assert.equal(slugifyTitle('!!!'), 'topic')
  assert.equal(slugifyTitle(''), 'topic')
  assert.equal(topicFilename(record()), 'm_12345678-user-prefers-pnpm.md')
  assert.equal(topicFilename(record({ title: '中文标题' })), 'm_12345678-中文标题.md')
})

test('frontmatter: render + parse round-trips every field', () => {
  const file = renderTopicFile(record())
  assert.match(file, /^---\n/u)
  assert.match(file, /title: "User prefers pnpm"/u)
  assert.match(file, /tags: \["pnpm","node"\]/u)
  assert.match(file, /origin: "tool"/u)
  const parsed = parseFrontmatter(file)
  assert.equal(parsed.hadFrontmatter, true)
  assert.equal(parsed.meta.title, 'User prefers pnpm')
  assert.equal(parsed.meta.importance, 4)
  assert.deepEqual(parsed.meta.tags, ['pnpm', 'node'])
  assert.equal(parsed.meta.sessionTitle, 'Setup')
  assert.match(parsed.body, /Second paragraph/u)

  const converted = recordFromTopicFile({ text: file, filename: 'm_12345678-user-prefers-pnpm.md', scope: 'global' })
  assert.equal(converted.error, undefined)
  assert.equal(converted.record.id, 'm_12345678')
  assert.equal(converted.record.title, 'User prefers pnpm')
  assert.equal(converted.record.content, 'The user always uses pnpm.\n\nSecond paragraph.')
  assert.deepEqual(converted.record.tags, ['pnpm', 'node'])
  assert.equal(converted.record.revision, 2)
  assert.equal(converted.record.source.sessionId, 'sess-1')
})

test('frontmatter: tolerates plain scalars, block lists and unknown keys', () => {
  const text = [
    '---',
    'id: m_87654321',
    'title: Hand-written topic',
    'kind: decision',
    'importance: 9',
    'tags:',
    '  - alpha',
    '  - beta',
    'pinned: true',
    'unknownKey: ignored',
    'modified: 2026-02-03T04:05:06.000Z',
    '---',
    '',
    '# Hand-written topic',
    'Body line.',
  ].join('\n')
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.meta.title, 'Hand-written topic')
  assert.deepEqual(parsed.meta.tags, ['alpha', 'beta'])
  assert.equal(parsed.meta.pinned, true)
  assert.equal(parsed.meta.importance, 9)
  const converted = recordFromTopicFile({ text, filename: 'notes.md', scope: 'global' })
  assert.equal(converted.record.id, 'm_87654321')
  assert.equal(converted.record.importance, 5)
  assert.equal(converted.record.kind, 'decision')
  assert.equal(converted.record.updatedAt, '2026-02-03T04:05:06.000Z')
  assert.equal(converted.record.summary, 'Hand-written topic')
})

test('frontmatter: derives metadata for topic files without frontmatter', () => {
  const converted = recordFromTopicFile({
    text: '# Deploy notes\n\nStaging is tatooine.\n',
    filename: 'm_abcdef12-deploy-notes.md',
    scope: 'project',
    project: { key: '/tmp/ws', name: 'ws' },
    mtimeMs: Date.parse('2026-03-01T00:00:00.000Z'),
  })
  assert.equal(converted.record.id, 'm_abcdef12')
  assert.equal(converted.record.title, 'Deploy notes')
  assert.equal(converted.record.summary, 'Deploy notes')
  assert.equal(converted.record.kind, 'reference')
  assert.equal(converted.record.source.origin, 'import')
  assert.equal(converted.record.createdAt, '2026-03-01T00:00:00.000Z')
  assert.equal(converted.record.project.key, '/tmp/ws')
})

test('frontmatter: rejects empty bodies and handles unterminated blocks', () => {
  assert.equal(recordFromTopicFile({ text: '---\nid: m_12345678\n---\n', filename: 'x.md', scope: 'global' }).error, 'topic file has no body')
  const unterminated = parseFrontmatter('---\nid: m_12345678\ntitle: x\nbody')
  assert.equal(unterminated.hadFrontmatter, false)
  assert.equal(unterminated.error, 'frontmatter block is not terminated')
})

test('frontmatter: index is generated from records with stable ordering', () => {
  const records = [
    record({ id: 'm_00000001', title: 'Low', importance: 1, updatedAt: '2026-01-05T00:00:00.000Z' }),
    record({ id: 'm_00000002', title: 'Pinned low', pinned: true, importance: 1, updatedAt: '2026-01-01T00:00:00.000Z' }),
    record({ id: 'm_00000003', title: 'High', importance: 5, updatedAt: '2026-01-04T00:00:00.000Z' }),
    record({ id: 'm_00000004', title: 'Archived', status: 'archived', importance: 5 }),
    record({ id: 'm_00000005', title: 'Has [brackets]', importance: 3 }),
  ]
  const index = renderMemoryIndex(records, { scope: 'global' })
  const order = ['Pinned low', 'High', 'Has \\\\[brackets\\\\]'.replaceAll('\\\\', '\\'), 'Low'].map(name => index.indexOf(name))
  assert.ok(order[0] > -1 && order[0] < order[1])
  assert.ok(order[1] < order[2] && order[2] < order[3])
  assert.doesNotMatch(index, /Archived/u)
  assert.match(index, /Active topics: 4/u)
  assert.match(index, /Generated index/u)
  const projectIndex = renderMemoryIndex([record({ scope: 'project', project: { key: '/tmp/ws', name: 'ws' } })], {
    scope: 'project',
    project: { key: '/tmp/ws', name: 'ws' },
  })
  assert.match(projectIndex, /Project ws/u)
  assert.match(projectIndex, /\/tmp\/ws/u)
})
