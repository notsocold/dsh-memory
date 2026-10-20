/**
 * Workspace identity for project-scoped memories.
 *
 * A project-level memory belongs to one session workspace: the session's
 * effective working directory (the latest `working-directory/change` event,
 * falling back to the session header cwd). Unlike the previous git-root
 * detection, this keeps project memory exactly inside the directory the user
 * is working in, so `{workspace}/.dsh/dsh-memory/` follows the workspace.
 *
 * @module dsh-memory/lib/project
 */

import { basename, resolve } from 'node:path'

/**
 * Normalize one working directory into a stable workspace identity.
 * @param {string | undefined} cwd - session working directory.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function resolveWorkspace(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const root = resolve(cwd)
  return {
    key: root,
    name: basename(root) || root,
    root,
  }
}

/** Backward-compatible alias for call sites that used `resolveProject`. */
export const resolveProject = resolveWorkspace

/**
 * Pick the effective working directory out of a session's durable events.
 * The latest `working-directory/change` wins; absent one, the creation header
 * cwd is used.
 * @param {ReadonlyArray<Record<string, any>>} events - session events.
 * @param {string | undefined} headerCwd - creation header cwd.
 * @returns {string | undefined}
 */
export function latestWorkingDirectory(events, headerCwd) {
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
        return event.data.cwd
      }
    }
  }
  return typeof headerCwd === 'string' ? headerCwd : undefined
}

/**
 * Resolve the workspace of one live session synchronously (events only).
 * @param {any} session - DSH Session.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function workspaceFromSession(session) {
  if (session === undefined || session === null) return undefined
  const headerCwd = session.header?.cwd
  let events = []
  try {
    events = session.snapshotEvents()
  } catch {
    events = []
  }
  return resolveWorkspace(latestWorkingDirectory(events, headerCwd))
}

/**
 * Resolve the workspace of one agent, preferring a mounted working-directory
 * service and falling back to durable event scanning.
 * @param {any} agent - DSH Agent.
 * @param {any} [ctx] - optional Cordis context with a workingDirectory service.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function workspaceFromAgent(agent, ctx) {
  const session = agent?.session
  if (session === undefined || session === null) return undefined
  try {
    const service = ctx?.get?.('workingDirectory')
    if (service !== undefined && typeof service.get === 'function') {
      const cwd = service.get(session)
      const workspace = resolveWorkspace(cwd)
      if (workspace !== undefined) return workspace
    }
  } catch {
    // Optional service; fall through to the durable scan.
  }
  return workspaceFromSession(session)
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
 * Render a workspace reference for prompts and API payloads.
 * @param {{ key: string, name: string } | null | undefined} project - workspace ref.
 * @returns {string} display label, or an empty string.
 */
export function projectLabel(project) {
  if (project === undefined || project === null) return ''
  return project.name || project.key
}

/** @type {Map<string, { key: string, name: string, root: string }>} */
const cache = new Map()

/**
 * Resolve one working directory with a small cache (the pure form above is
 * already cheap, and this keeps repeated prompt assembly allocation-free).
 * @param {string | undefined} cwd - working directory.
 * @returns {{ key: string, name: string, root: string } | undefined}
 */
export function resolveWorkspaceCached(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const cached = cache.get(cwd)
  if (cached !== undefined) return cached
  const workspace = resolveWorkspace(cwd)
  if (workspace !== undefined) cache.set(cwd, workspace)
  return workspace
}

/** Clear the resolved-workspace cache (tests). */
export function clearProjectCache() {
  cache.clear()
}
