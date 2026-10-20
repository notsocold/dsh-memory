/**
 * Unit tests for one Markdown topic collection.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TopicCollection } from '../lib/topiccollection.js'
import { renderTopicFile } from '../lib/frontmatter.js'

/**
 * @param {Record<string, any>} [overrides] - record overrides.
 * @returns {Record<string, any>} full record.
 */
function record(overrides = {}) {
  return {
    id: 'm_11111111',
    title: 'First topic',
    summary: 'First summary',
    content: 'First body.',
    kind: 'reference',
    scope: 'global',
    project: null,
    tags: [],
    importance: 3,
    pinned: false,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    source: { origin: 'manual' },
    ...overrides,
  }
}

/**
 * @returns {Promise<{ dir: string, collection: TopicCollection }>} temp collection.
 */
async function makeCollection() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-topics-'))
  const collection = new TopicCollection({ dir: join(dir, 'memory'), scope: 'global' })
  return { dir: join(dir, 'memory'), collection }
}

test('topiccollection: loading a missing directory stays empty and read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-topics-'))
  try {
    const dir = join(root, 'missing')
    const collection = new TopicCollection({ dir, scope: 'global' })
    collection.loadSync()
    assert.equal(collection.records.length, 0)
    assert.equal(collection.exists, false)
    assert.equal(collection.activeRecords.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('topiccollection: writing creates the directory, topic file and generated index', async () => {
  const { dir, collection } = await makeCollection()
  try {
    assert.equal(collection.exists, false)
    const filename = collection.writeRecord(record())
    assert.equal(collection.exists, true)
    assert.equal(filename, 'm_11111111-first-topic.md')
    const files = await readdir(dir)
    assert.deepEqual(files.sort(), [filename, 'MEMORY.md'].sort())
    const body = await readFile(join(dir, filename), 'utf8')
    assert.match(body, /title: "First topic"/u)
    const index = await readFile(join(dir, 'MEMORY.md'), 'utf8')
    assert.match(index, /\[First topic\]\(m_11111111-first-topic\.md\)/u)
    assert.equal(collection.activeRecords.length, 1)

    // Updating a title keeps the stable file name.
    const updated = record({ title: 'Retitled topic', revision: 2 })
    collection.writeRecord(updated)
    assert.equal(collection.files.get(updated.id), filename)
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /\[Retitled topic\]/u)
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

test('topiccollection: loads existing files, skips duplicates and offers diagnostics', async () => {
  const { dir, collection } = await makeCollection()
  try {
    await collection.ensureDir()
    await writeFile(join(dir, 'm_11111111-one.md'), renderTopicFile(record()), 'utf8')
    await writeFile(join(dir, 'm_22222222-two.md'), renderTopicFile(record({
      id: 'm_22222222', title: 'Archived topic', status: 'archived',
    })), 'utf8')
    await writeFile(join(dir, 'm_11111111-duplicate.md'), renderTopicFile(record({ title: 'Duplicate id' })), 'utf8')
    await writeFile(join(dir, 'MEMORY.md'), 'stale index', 'utf8')
    collection.loadSync()
    assert.equal(collection.records.length, 2)
    assert.equal(collection.activeRecords.length, 1)
    assert.ok(collection.diagnostics.some(message => /duplicate memory id/u.test(message)))
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

test('topiccollection: external edits/additions/removals are folded in on reload', async () => {
  const { dir, collection } = await makeCollection()
  try {
    collection.writeRecord(record())
    const name = collection.files.get('m_11111111')
    const path = join(dir, name)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.split('First body.').join('Edited body.'), 'utf8')
    collection.refreshSync({ regenerateIndex: true, forceReload: true })
    assert.equal(collection.records[0].content, 'Edited body.')

    await writeFile(join(dir, 'freeform.md'), '# Freeform\n\nHand-written memory.\n', 'utf8')
    collection.refreshSync({ regenerateIndex: true, forceReload: true })
    const freeform = collection.records.find(entry => entry.title === 'Freeform')
    assert.ok(freeform !== undefined)
    assert.match(freeform.id, /^m_[0-9a-f]{8}$/u)
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /Freeform/u)

    await unlink(join(dir, 'freeform.md'))
    collection.refreshSync({ regenerateIndex: true, forceReload: true })
    assert.equal(collection.records.some(entry => entry.title === 'Freeform'), false)
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

test('topiccollection: the generated index is repaired without touching topics', async () => {
  const { dir, collection } = await makeCollection()
  try {
    collection.writeRecord(record())
    const before = await readFile(join(dir, 'MEMORY.md'), 'utf8')
    await writeFile(join(dir, 'MEMORY.md'), 'tampered\n', 'utf8')
    collection.refreshSync({ regenerateIndex: true, forceReload: true })
    const after = await readFile(join(dir, 'MEMORY.md'), 'utf8')
    assert.equal(after, before)
    assert.equal(collection.records.length, 1)
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

test('topiccollection: clear removes managed topics and leaves an empty index', async () => {
  const { dir, collection } = await makeCollection()
  try {
    collection.writeRecord(record())
    collection.writeRecord(record({ id: 'm_22222222', title: 'Second' }))
    const removed = collection.clearRecords()
    assert.equal(removed, 2)
    assert.equal(collection.records.length, 0)
    const files = await readdir(dir)
    assert.deepEqual(files, ['MEMORY.md'])
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /no active topics/u)
    assert.equal(files.some(name => name.includes('.tmp')), false)
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})
