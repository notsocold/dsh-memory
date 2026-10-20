/**
 * dsh-memory Host plugin.
 *
 * Responsibilities:
 * 1. Own the persistent memory library (`$DSH_HOME/dsh-memory/`).
 * 2. Inject a memory policy section and a per-session memory index into every
 *    root agent's prompt.
 * 3. Continuously distill finished conversation spans with the current
 *    session's model route, on idle and session boundaries.
 * 4. Expose the `memory` tool and the `/memory` command.
 * 5. Serve the authenticated `/api/dsh-memory/*` routes used by the browser
 *    half (`client.js`: Settings → Memory).
 *
 * No Harness package is imported: the plugin talks to the host only through
 * the Cordis context, and the client half only through same-origin HTTP.
 *
 * @module @local/dsh-memory
 */

import { StateStore, errorMessage, memoryError } from './lib/state.js'
import { MemoryStore } from './lib/store.js'
import { Extractor } from './lib/extractor.js'
import { installInjection } from './lib/inject.js'
import { createMemoryTool } from './lib/tools.js'
import { createMemoryCommands } from './lib/commands.js'
import { apiRoutes } from './lib/api.js'
import { snapshotSession } from './lib/transcript.js'

/** Cordis plugin name. */
export const name = 'dsh-memory'

/** Services required before activation. */
export const inject = ['agents', 'systemPrompt', 'tools', 'llm']

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  const logger = ctx.logger
  const stateStore = new StateStore({ logger })
  const store = new MemoryStore({ stateStore, logger })
  await store.load()

  const extractor = new Extractor({ ctx, store, logger })

  // Prompt integration: the policy text and index re-evaluate on each assembly
  // so newly saved topics (and pause/resume) are visible on the next step.
  const injection = installInjection(ctx, { store, logger })
  ctx.effect(() => () => injection.dispose(), 'dsh-memory: prompt integration')

  // The tool is registered only while the setting is on; toggling from the
  // settings page adds or removes it without a reload.
  const tool = createMemoryTool({ store, extractor, logger })
  /** @type {null | (() => void)} */
  let toolDispose = null
  const syncTool = () => {
    const enabled = store.settings.toolEnabled === true
    if (enabled && toolDispose === null) {
      try {
        toolDispose = ctx.tools.register(tool)
      } catch (error) {
        logger?.warn?.(`dsh-memory: cannot register memory tool: ${errorMessage(error)}`)
        toolDispose = null
      }
    } else if (!enabled && toolDispose !== null) {
      try {
        toolDispose()
      } catch {
        // Unregistration during teardown is best-effort.
      }
      toolDispose = null
    }
  }
  ctx.effect(() => {
    syncTool()
    const off = store.onChange(syncTool)
    return () => {
      off()
      if (toolDispose !== null) {
        try {
          toolDispose()
        } catch {
          // Host teardown may have disposed the tool registry already.
        }
        toolDispose = null
      }
    }
  }, 'dsh-memory: memory tool')

  // `/memory` command is optional: registries can be absent in minimal profiles.
  ctx.inject(['commands'], (scoped) => {
    const commands = createMemoryCommands({ store, extractor })
    for (const definition of commands) {
      scoped.effect(() => scoped.commands.register(definition), `dsh-memory: /${definition.name} command`)
    }
  })

  /**
   * Resolve one live session's workspace facts for the HTTP API.
   * @param {string | undefined} sessionId - browser-supplied session id.
   * @returns {Promise<{ cwd?: string, project?: { key: string, name: string }, live: boolean }>}
   */
  const resolveSessionContext = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { live: false }
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return { live: false }
      const cwd = agent.session?.header?.cwd
      const project = typeof cwd === 'string' ? store.projectFor(cwd) : undefined
      return {
        live: true,
        ...(typeof cwd === 'string' ? { cwd } : {}),
        ...(project === undefined ? {} : { project }),
      }
    } catch {
      return { live: false }
    }
  }

  /**
   * List root sessions that are live in this host, for the settings page's
   * "extract now" and per-session opt-out controls.
   * @returns {Promise<Record<string, any>[]>}
   */
  const listLiveSessions = async () => {
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      return []
    }
    const sessions = []
    for (const agent of agents) {
      const session = agent?.session
      if (session === undefined || session === null) continue
      const header = session.header ?? {}
      if (header.origin === 'subagent') continue
      const depth = Number(header.delegationDepth ?? 0)
      if (Number.isFinite(depth) && depth > 0) continue
      const sessionId = String(agent.id ?? session.id ?? '')
      if (sessionId === '') continue
      let title = ''
      try {
        title = snapshotSession(session).title
      } catch {
        title = ''
      }
      sessions.push({
        sessionId,
        title,
        status: typeof agent.status === 'string' ? agent.status : 'idle',
        optedOut: store.isSessionOptOut(sessionId),
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      })
    }
    return sessions
  }

  // Web routes are optional: headless/CLI profiles have no connection service.
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(async () => {
      const routes = apiRoutes({ store, extractor, resolveSessionContext, listLiveSessions })
      const disposers = []
      try {
        for (const route of routes) disposers.push(await scoped.connection.fetch.register(route))
      } catch (error) {
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch {
            // Route registry rollback only.
          }
        }
        throw error
      }
      return async () => {
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch {
            // Host teardown is best-effort.
          }
        }
      }
    }, 'dsh-memory: http routes')
  })

  // Continuous extraction triggers. Every listener is a Cordis effect.
  ctx.on('agent/status', (payload) => { extractor.onStatus(payload) })
  ctx.on('agent/disposed', (payload) => { extractor.onAgentDisposed(payload) })
  ctx.on('session/created', (session) => { extractor.onSessionCreated(session) })
  ctx.on('session/disposed', (session) => { extractor.onSessionDisposed(session) })
  ctx.effect(() => () => {
    void extractor.dispose()
    void store.flush()
  }, 'dsh-memory: extractor teardown')

  // Pick up sessions that were already live when the plugin mounted.
  await extractor.start()
  logger?.info?.(`dsh-memory: ${store.stats().active} active topic(s) at ${stateStore.root}`)
}

/**
 * Resolve the plugin-owned storage root for diagnostics.
 * @param {string} [home] - optional explicit harness home.
 * @returns {string} absolute memory directory.
 */
export function memoryRoot(home) {
  return new StateStore({ home }).root
}

/** Re-exported for tests that assert the disabled behavior. */
export { memoryError }
