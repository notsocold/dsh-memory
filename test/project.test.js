/**
 * Unit tests for lib/project.js — workspace identity = session working
 * directory (no git-root walking).
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  clearProjectCache,
  isSubagentSession,
  latestWorkingDirectory,
  projectLabel,
  resolveWorkspace,
  resolveWorkspaceCached,
  workspaceFromAgent,
  workspaceFromSession,
} from '../lib/project.js'

describe('workspace resolution', () => {
  let base

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-memory-project-'))
    clearProjectCache()
  })

  afterEach(async () => {
    clearProjectCache()
    await rm(base, { recursive: true, force: true })
  })

  it('uses the exact working directory as the project key', async () => {
    const nested = join(base, 'repo', 'src', 'nested')
    await mkdir(join(base, 'repo', '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    const workspace = resolveWorkspace(nested)
    assert.equal(workspace.key, resolve(nested))
    assert.equal(workspace.name, 'nested')
    assert.equal(workspace.root, resolve(nested))
    // A git ancestor does not collapse the scope.
    assert.notEqual(workspace.key, resolve(join(base, 'repo')))
  })

  it('rejects empty or missing directories and resolves relative ones', () => {
    assert.equal(resolveWorkspace(undefined), undefined)
    assert.equal(resolveWorkspace(''), undefined)
    assert.equal(resolveWorkspace('  '), undefined)
    const relative = resolveWorkspace('relative/path')
    assert.equal(relative.key, resolve('relative/path'))
    assert.equal(relative.name, 'path')
  })

  it('caches resolved workspaces until the cache is cleared', () => {
    const first = resolveWorkspaceCached(base)
    const second = resolveWorkspaceCached(base)
    assert.equal(first, second)
    clearProjectCache()
    const third = resolveWorkspaceCached(base)
    assert.notEqual(first, third)
    assert.deepEqual(first, third)
  })

  it('picks the latest working-directory event and falls back to the header cwd', () => {
    const events = [
      { type: 'user/message', seq: 0, data: {} },
      { type: 'working-directory/change', seq: 1, data: { cwd: '/tmp/first' } },
      { type: 'working-directory/change', seq: 2, data: { cwd: '/tmp/second' } },
    ]
    assert.equal(latestWorkingDirectory(events, '/tmp/header'), '/tmp/second')
    assert.equal(latestWorkingDirectory([], '/tmp/header'), '/tmp/header')
    assert.equal(latestWorkingDirectory(undefined, undefined), undefined)
  })

  it('resolves workspaces from sessions through durable events', async () => {
    const cwd = join(base, 'repo')
    await mkdir(cwd, { recursive: true })
    const session = {
      id: 'sess-1',
      header: { cwd: join(base, 'original') },
      snapshotEvents: () => [{ type: 'working-directory/change', seq: 0, data: { cwd } }],
    }
    const workspace = workspaceFromSession(session)
    assert.equal(workspace.key, resolve(cwd))
    assert.equal(workspace.name, basename(cwd))
  })

  it('prefers a mounted workingDirectory service for agents', async () => {
    const served = join(base, 'served')
    const session = {
      id: 'sess-2',
      header: { cwd: join(base, 'header') },
      snapshotEvents: () => [],
    }
    const agent = { id: 'sess-2', session }
    const ctx = { get: name => (name === 'workingDirectory' ? { get: () => served } : undefined) }
    assert.equal(workspaceFromAgent(agent, ctx).key, resolve(served))
    assert.equal(workspaceFromAgent(agent, undefined).key, resolve(join(base, 'header')))
    const brokenCtx = { get: () => { throw new Error('boom') } }
    assert.equal(workspaceFromAgent(agent, brokenCtx).key, resolve(join(base, 'header')))
  })

  it('detects subagent sessions and renders project labels', () => {
    assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
    assert.equal(isSubagentSession({ header: { delegationDepth: 2 } }), true)
    assert.equal(isSubagentSession({ header: {} }), false)
    assert.equal(isSubagentSession(undefined), false)
    assert.equal(projectLabel({ name: 'repo' }), 'repo')
    assert.equal(projectLabel(null), '')
  })
})
