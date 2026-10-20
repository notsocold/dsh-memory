/**
 * Project identity for project-scoped memories.
 *
 * A session's working directory identifies a project by its nearest ancestor
 * containing a `.git` entry (directory or worktree file); a directory outside
 * any repository is its own project. The resolved root path is the stable
 * scope key so memories follow the checkout even when a deeper directory is
 * used as the session working directory.
 *
 * @module dsh-memory/lib/project
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Maximum ancestor depth probed for a project root marker. */
const MAX_DEPTH = 64

/** @type {Map<string, { key: string, name: string, root: string } | undefined>} */
const cache = new Map()

/**
 * @param {string} path - candidate directory.
 * @returns {boolean} whether the path contains a `.git` entry.
 */
function hasGitMarker(path) {
  try {
    const marker = join(path, '.git')
    if (!existsSync(marker)) return false
    const stat = statSync(marker)
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/**
 * Resolve one absolute path to its project scope.
 * @param {string | undefined} cwd - session working directory.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function resolveProject(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const start = resolve(cwd)
  if (cache.has(start)) return cache.get(start)
  let root = start
  let current = start
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (hasGitMarker(current)) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  let key = root
  try {
    key = realpathSync.native(root)
  } catch {
    // A missing directory keeps its resolved path as the scope key.
  }
  const project = {
    key,
    name: basename(root) || root,
    root,
  }
  cache.set(start, project)
  return project
}

/**
 * Resolve the project of one live session without filesystem I/O beyond the
 * cached marker probe.
 * @param {any} session - DSH Session.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function projectFromSession(session) {
  const cwd = session?.header?.cwd
  return resolveProject(cwd)
}

/**
 * Whether the session belongs to a delegated subagent rather than a user
 * conversation. Automatic extraction and prompt injection skip these.
 * @param {any} session - DSH Session.
 * @returns {boolean}
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  const depth = Number(header.delegationDepth ?? 0)
  return Number.isFinite(depth) && depth > 0
}

/**
 * Render a project reference for prompts and API payloads.
 * @param {{ key: string, name: string } | null | undefined} project - project ref.
 * @returns {string} display label, or an empty string.
 */
export function projectLabel(project) {
  if (project === undefined || project === null) return ''
  return project.name || project.key
}

/** Clear the resolved-project cache (tests and long-running hosts). */
export function clearProjectCache() {
  cache.clear()
}
