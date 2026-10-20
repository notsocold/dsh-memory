/**
 * Unit tests for lib/project.js — git-root discovery and session project
 * identity.
 *
 * Run from the plugin root:
 *   node --test test/project.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearProjectCache,
  isSubagentSession,
  projectFromSession,
  projectLabel,
  resolveProject,
} from '../lib/project.js'

describe('project resolution', () => {
  let base

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-memory-project-'))
    clearProjectCache()
  })

  afterEach(async () => {
    clearProjectCache()
    await rm(base, { recursive: true, force: true })
  })

  async function makeDir(...segments) {
    const path = join(base, ...segments)
    await mkdir(path, { recursive: true })
    return path
  }

  it('resolves a nested subdirectory to its nearest .git directory root', async () => {
    const repo = await makeDir('myrepo')
    await makeDir('myrepo', '.git')
    const nested = await makeDir('myrepo', 'src', 'deep')

    const project = resolveProject(nested)
    assert.equal(project.root, repo)
    assert.equal(project.name, 'myrepo')
    assert.equal(project.key, await realpath(repo))
  })

  it('prefers the nearest nested repository over an outer one', async () => {
    const outer = await makeDir('outer')
    await makeDir('outer', '.git')
    const inner = await makeDir('outer', 'packages', 'inner')
    await makeDir('outer', 'packages', 'inner', '.git')
    const nested = await makeDir('outer', 'packages', 'inner', 'src')

    const project = resolveProject(nested)
    assert.equal(project.root, inner)
    assert.equal(project.name, 'inner')
    assert.equal(project.key, await realpath(inner))
  })

  it('recognizes a .git worktree file as a project marker', async () => {
    const worktree = await makeDir('linked-worktree')
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n', 'utf8')
    const nested = await makeDir('linked-worktree', 'src')

    const project = resolveProject(nested)
    assert.equal(project.root, worktree)
    assert.equal(project.name, 'linked-worktree')
    assert.equal(project.key, await realpath(worktree))
  })

  it('treats a directory outside any repository as its own project', async () => {
    const outside = await makeDir('plain', 'sub')
    const project = resolveProject(outside)
    assert.equal(project.root, outside)
    assert.equal(project.name, 'sub')
    assert.equal(project.key, await realpath(outside))
  })

  it('keeps the resolved path as the key when the directory does not exist', () => {
    const missing = join(base, 'missing', 'child')
    const project = resolveProject(missing)
    assert.equal(project.root, missing)
    assert.equal(project.name, 'child')
    assert.equal(project.key, missing)
  })

  it('returns undefined for blank and non-string cwd values', () => {
    assert.equal(resolveProject(''), undefined)
    assert.equal(resolveProject('   '), undefined)
    assert.equal(resolveProject(undefined), undefined)
    assert.equal(resolveProject(null), undefined)
    assert.equal(resolveProject(42), undefined)
  })

  it('uses the cache until it is explicitly cleared', async () => {
    const plain = await makeDir('project')
    const nested = await makeDir('project', 'src')
    assert.equal(resolveProject(nested).root, nested)

    // A newly-created .git marker is invisible while the cached entry stands.
    await makeDir('project', '.git')
    assert.equal(resolveProject(nested).root, nested)

    clearProjectCache()
    const refreshed = resolveProject(nested)
    assert.equal(refreshed.root, plain)
    assert.equal(refreshed.name, 'project')
  })
})

describe('session helpers', () => {
  let base

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-memory-project-session-'))
    clearProjectCache()
  })

  afterEach(async () => {
    clearProjectCache()
    await rm(base, { recursive: true, force: true })
  })

  async function makeDir(...segments) {
    const path = join(base, ...segments)
    await mkdir(path, { recursive: true })
    return path
  }

  it('projectFromSession resolves session.header.cwd', async () => {
    const repo = await makeDir('session-repo')
    await makeDir('session-repo', '.git')
    const nested = await makeDir('session-repo', 'lib')

    const project = projectFromSession({ header: { cwd: nested } })
    assert.equal(project.root, repo)
    assert.equal(project.name, 'session-repo')
    assert.equal(project.key, await realpath(repo))
  })

  it('projectFromSession returns undefined when cwd is unavailable', () => {
    assert.equal(projectFromSession({}), undefined)
    assert.equal(projectFromSession({ header: {} }), undefined)
    assert.equal(projectFromSession({ header: { cwd: null } }), undefined)
    assert.equal(projectFromSession(null), undefined)
    assert.equal(projectFromSession(undefined), undefined)
  })

  it('isSubagentSession detects subagent origin and delegation depth', () => {
    assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
    assert.equal(isSubagentSession({ header: { delegationDepth: 1 } }), true)
    assert.equal(isSubagentSession({ header: { delegationDepth: 2 } }), true)
    assert.equal(isSubagentSession({ header: { delegationDepth: '3' } }), true)
  })

  it('isSubagentSession is false for root and malformed sessions', () => {
    assert.equal(isSubagentSession({ header: { origin: 'user' } }), false)
    assert.equal(isSubagentSession({ header: {} }), false)
    assert.equal(isSubagentSession({ header: { delegationDepth: 0 } }), false)
    assert.equal(isSubagentSession({ header: { delegationDepth: -1 } }), false)
    assert.equal(isSubagentSession({ header: { delegationDepth: 'not-a-number' } }), false)
    assert.equal(isSubagentSession({ header: null }), false)
    assert.equal(isSubagentSession({}), false)
    assert.equal(isSubagentSession(null), false)
  })

  it('projectLabel prefers name, then key, and is empty for absent projects', () => {
    assert.equal(projectLabel({ name: 'repo', key: '/repo' }), 'repo')
    assert.equal(projectLabel({ name: '', key: '/repo' }), '/repo')
    assert.equal(projectLabel(null), '')
    assert.equal(projectLabel(undefined), '')
  })
})
