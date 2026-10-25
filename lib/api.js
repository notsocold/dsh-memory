/**
 * Host HTTP API for the browser half.
 *
 * Routes are registered through `ctx.connection.fetch`, so they live inside
 * the authenticated `/api` fence: only the page's owner Peer reaches them and
 * the ordinary same-origin cookie applies. The browser needs no generated
 * Remote client for this plugin.
 *
 * @module dsh-memory/lib/api
 */

import { memoryError, isRecord } from './state.js'
import { scopeLabel } from './retrieval.js'

/** Shared path prefix of every dsh-memory route. */
export const API_PREFIX = '/api/dsh-memory'

/** Maximum records returned by the state endpoint. */
const MAX_STATE_RECORDS = 1000

/** Heartbeat interval that keeps an idle change stream open through proxies. */
const EVENTS_HEARTBEAT_MS = 15000

/**
 * Build the long-lived Server-Sent-Events response the browser half subscribes
 * to. One frame is emitted after every topic-record change (including external
 * topic file edits picked up by a collection watcher); the client then
 * refetches `state` instead of polling it on a timer. Operational state writes
 * such as watermarks or settings do not wake the stream.
 * @param {import('./store.js').MemoryStore} store - memory library.
 * @param {Request} request - incoming request; its signal aborts on disconnect.
 * @returns {Response}
 */
function eventsResponse(store, request) {
  const encoder = new TextEncoder()
  let closed = false
  let unsubscribe = () => {}
  let heartbeat = null
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
  let controller = null
  const cleanup = () => {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat !== null) clearInterval(heartbeat)
    try {
      controller?.close()
    } catch {
      // The stream may already be cancelled or errored.
    }
  }
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController
      /**
       * @param {string} frame - one complete SSE frame.
       * @returns {void}
       */
      const push = (frame) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          cleanup()
        }
      }
      push(': dsh-memory events\n\n')
      push('retry: 5000\n\n')
      unsubscribe = store.onTopicsChange(() => { push('data: {"type":"change"}\n\n') })
      heartbeat = setInterval(() => { push(': keep-alive\n\n') }, EVENTS_HEARTBEAT_MS)
      heartbeat.unref?.()
      if (request.signal.aborted) {
        cleanup()
        return
      }
      request.signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * @param {unknown} value - success payload.
 * @returns {Response}
 */
function ok(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * @param {unknown} error - thrown value.
 * @returns {Response}
 */
function failure(error) {
  const code = typeof (/** @type {{code?: unknown}} */ (error)?.code) === 'string'
    ? String(/** @type {{code?: string}} */ (error).code)
    : 'internal'
  const known = ['invalid-request', 'not-found', 'io-error', 'disabled', 'judge-failed', 'session-not-live'].includes(code)
  const message = error instanceof Error ? error.message : String(error)
  return Response.json(
    { ok: false, error: { code: known ? code : 'internal', message } },
    { status: code === 'internal' ? 500 : 200, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * @param {string} code - stable error code.
 * @param {string} message - reason.
 * @param {number} status - HTTP status.
 * @returns {Response}
 */
function fatal(code, message, status) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * @param {string} text - text to validate.
 * @param {string} field - field name for the message.
 * @returns {string}
 */
function requireString(text, field) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw memoryError('invalid-request', `"${field}" must be a non-empty string`)
  }
  return text.trim()
}

/**
 * @param {unknown} value - optional string.
 * @param {string} field - field name.
 * @returns {string | undefined}
 */
function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw memoryError('invalid-request', `"${field}" must be a string`)
  return value
}

/**
 * @param {import('./store.js').MemoryStore} store - memory library.
 * @param {{ id?: string, optedOut: boolean, project?: { key: string, name: string } }} session - resolved session.
 * @returns {Record<string, any>}
 */
function statePayload(store, session, liveSessions) {
  const records = store.list({ status: 'all', limit: MAX_STATE_RECORDS, offset: 0 }).items
  return {
    layout: 'markdown-topic-files',
    memoryRoot: store.stateStore.root,
    settings: { ...store.settings },
    stats: store.stats(),
    memories: records.map(record => ({
      ...store.toListItem(record),
      scopeLabel: scopeLabel(record),
    })),
    projects: store.describeProjects(),
    activity: store.listActivity(20),
    liveSessions: Array.isArray(liveSessions) ? liveSessions : [],
    session,
  }
}

/**
 * Build the memory HTTP routes.
 * @param {{
 *   store: import('./store.js').MemoryStore,
 *   extractor: import('./extractor.js').Extractor,
 *   resolveSessionContext: (sessionId: string | undefined) => Promise<{
 *     cwd?: string,
 *     project?: { key: string, name: string },
 *     live: boolean,
 *   }>,
 *   listLiveSessions: () => Promise<{
 *     sessionId: string, title: string, project?: { key: string, name: string },
 *     status: string, optedOut: boolean,
 *   }[]>,
 * }} options - host services.
 * @returns {Record<string, any>[]} ConnectionFetchRoute values.
 */
export function apiRoutes(options) {
  const { store, extractor, resolveSessionContext, listLiveSessions } = options

  /**
   * @param {Request} request - incoming request.
   * @returns {Promise<string | undefined>}
   */
  const querySessionId = request => {
    const url = new URL(request.url, 'http://dsh.invalid')
    const value = url.searchParams.get('sessionId')
    return value === null || value === '' ? undefined : value
  }

  return [
    {
      path: `${API_PREFIX}/state`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const sessionId = querySessionId(request)
          const resolved = await resolveSessionContext(sessionId)
          if (resolved.project !== undefined) {
            store.ensureProjectCollection(resolved.project.key, resolved.project.name)
          }
          store.loadKnownProjects()
          const liveSessions = typeof listLiveSessions === 'function' ? await listLiveSessions() : []
          const sessionProject = resolved.project === undefined
            ? undefined
            : { ...resolved.project, memoryDir: store.projectMemoryDir(resolved.project.key) }
          return ok(statePayload(store, {
            ...(sessionId === undefined ? {} : { id: sessionId }),
            optedOut: sessionId === undefined ? false : store.isSessionOptOut(sessionId),
            ...(sessionProject === undefined ? {} : { project: sessionProject }),
          }, liveSessions))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/memory`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const url = new URL(request.url, 'http://dsh.invalid')
          const id = url.searchParams.get('id') ?? ''
          const projectKey = url.searchParams.get('projectKey') ?? undefined
          if (id === '') return fatal('invalid-request', 'an id query parameter is required', 400)
          const record = store.get(id, { projectKey })
          if (record === undefined) throw memoryError('not-found', `unknown memory "${id}"`)
          return ok(record)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/action`,
      methods: /** @type {const} */ (['POST']),
      requestBody: 'buffered',
      async fetch(request) {
        let body
        try {
          body = await request.json()
        } catch {
          return fatal('invalid-request', 'request body must be a JSON object', 400)
        }
        if (!isRecord(body)) return fatal('invalid-request', 'request body must be a JSON object', 400)
        try {
          const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
          const session = await resolveSessionContext(sessionId)
          const value = await dispatchAction({
            store,
            extractor,
            session,
            sessionId,
            body,
            action: typeof body.action === 'string' ? body.action : '',
          })
          return ok(value)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/events`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch(request) {
        try {
          return eventsResponse(store, request)
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}

/**
 * @param {{
 *   store: import('./store.js').MemoryStore,
 *   extractor: import('./extractor.js').Extractor,
 *   session: { cwd?: string, project?: { key: string, name: string }, live: boolean },
 *   sessionId: string | undefined,
 *   body: Record<string, any>,
 *   action: string,
 * }} input - dispatch inputs.
 * @returns {Promise<Record<string, any>>}
 */
async function dispatchAction(input) {
  const { store, extractor, session, sessionId, body, action } = input
  switch (action) {
    case 'create': {
      const scope = body.scope === 'project' ? 'project' : 'global'
      const project = scope === 'project'
        ? (isRecord(body.project) ? body.project : session.project)
        : undefined
      if (scope === 'project' && project === undefined) {
        throw memoryError('invalid-request', 'project-scoped memory requires a current project')
      }
      const result = store.create({
        title: requireString(body.title, 'title'),
        summary: optionalString(body.summary, 'summary'),
        content: requireString(body.content, 'content'),
        kind: body.kind,
        scope,
        ...(scope === 'project' ? { project } : {}),
        ...(body.importance === undefined ? {} : { importance: body.importance }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      }, {
        origin: 'manual',
        source: { sessionId },
      })
      return { action: result.action, record: store.toListItem(result.record) }
    }
    case 'update': {
      const id = requireString(body.id, 'id')
      const recordProjectKey = typeof body.projectKey === 'string' && body.projectKey !== ''
        ? body.projectKey
        : session.project?.key
      /** @type {Record<string, any>} */
      const patch = {}
      for (const field of ['title', 'summary', 'content', 'kind', 'importance', 'tags', 'pinned', 'status']) {
        if (body[field] !== undefined) patch[field] = body[field]
      }
      if (body.scope !== undefined) {
        patch.scope = body.scope
        if (body.scope === 'project') {
          const project = isRecord(body.project) ? body.project : session.project
          if (project === undefined) throw memoryError('invalid-request', 'project-scoped memory requires a current project')
          patch.project = project
        }
      }
      const result = store.update(id, patch, { origin: 'manual', source: { sessionId }, projectKey: recordProjectKey })
      return { action: result.action, record: store.toListItem(result.record) }
    }
    case 'delete': {
      const recordProjectKey = typeof body.projectKey === 'string' && body.projectKey !== ''
        ? body.projectKey
        : session.project?.key
      const result = store.remove(requireString(body.id, 'id'), { origin: 'manual', projectKey: recordProjectKey })
      return { action: result.action, record: store.toListItem(result.record) }
    }
    case 'pin':
    case 'unpin': {
      const recordProjectKey = typeof body.projectKey === 'string' && body.projectKey !== ''
        ? body.projectKey
        : session.project?.key
      const record = store.setPinned(requireString(body.id, 'id'), action === 'pin', { projectKey: recordProjectKey })
      return { action, record: store.toListItem(record) }
    }
    case 'clear': {
      if (body.confirm !== true) throw memoryError('invalid-request', 'clearing memories requires "confirm": true')
      const projectKey = typeof body.projectKey === 'string' && body.projectKey !== '' ? body.projectKey : undefined
      return store.clear(projectKey === undefined ? {} : { projectKey })
    }
    case 'pause':
      store.setSettings({ enabled: false })
      return { action: 'pause', settings: { ...store.settings } }
    case 'resume':
      store.setSettings({ enabled: true })
      return { action: 'resume', settings: { ...store.settings } }
    case 'setSessionOptOut': {
      if (sessionId === undefined) throw memoryError('invalid-request', 'a sessionId is required')
      if (typeof body.value !== 'boolean') throw memoryError('invalid-request', '"value" must be a boolean')
      store.setSessionOptOut(sessionId, body.value)
      return { action: 'setSessionOptOut', sessionId, value: body.value }
    }
    case 'extractNow': {
      if (sessionId === undefined) throw memoryError('invalid-request', 'a sessionId is required')
      if (!session.live) throw memoryError('session-not-live', 'open the session before extracting its memory')
      const result = await extractor.extractNow(sessionId, {
        trigger: 'manual',
        ...(body.fromStart === true ? { fromStart: true } : {}),
      })
      return { action: 'extractNow', result }
    }
    case 'export': {
      store.loadKnownProjects()
      const globalMemories = store.memories.filter(record => record.scope !== 'project')
      const projects = store.describeProjects().map((entry) => {
        const records = store.memories.filter(record => record.scope === 'project' && record.project?.key === entry.key)
        return { key: entry.key, name: entry.name, memoryDir: entry.memoryDir, memories: records }
      })
      return {
        exportedAt: new Date().toISOString(),
        version: store.state.version,
        layout: 'markdown-topic-files',
        settings: { ...store.settings },
        globalMemories,
        projects,
      }
    }
    case 'setSettings': {
      if (!isRecord(body.settings)) throw memoryError('invalid-request', '"settings" must be an object')
      const settings = store.setSettings(body.settings)
      return { action: 'setSettings', settings: { ...settings } }
    }
    default:
      throw memoryError('invalid-request', `unknown action "${action}"`)
  }
}
