/**
 * `/memory` slash command.
 *
 * Commands are deterministic user actions: they never call the judge except
 * for the explicit `extract` subcommand and never enter the model context as
 * user instructions. The handler returns a plain text result rendered by the
 * dispatching surface.
 *
 * @module dsh-memory/lib/commands
 */

import { memoryError } from './state.js'
import { scopeLabel } from './retrieval.js'

/** Slash command name. */
export const COMMAND_NAME = 'memory'

/** Command help text (English; the UI shell renders it verbatim). */
export const COMMAND_HELP = [
  'Usage: /memory <subcommand>',
  '',
  '  status              Show counts and current settings',
  '  list [query]        List active memory topics (optionally filtered)',
  '  search <query>      Search titles, summaries, tags and bodies',
  '  extract             Distill the current session into memory now',
  '  pause | resume      Pause or resume memory read/write/injection',
  '  forget <id>         Delete one memory topic',
  '  pin <id> | unpin <id>  Always inject (or stop injecting) one topic first',
  '  reset --yes         Delete every memory topic (settings are kept)',
  '  help                Show this help',
].join('\n')

/**
 * @param {string} text - success text.
 * @returns {{ kind: 'success', text: string }}
 */
function ok(text) {
  return { kind: 'success', text }
}

/**
 * @param {string} text - error text.
 * @returns {{ kind: 'error', text: string }}
 */
function fail(text) {
  return { kind: 'error', text }
}

/**
 * @param {Record<string, any>[]} records - records to render.
 * @returns {string}
 */
function formatList(records) {
  if (records.length === 0) return 'No memory topics matched.'
  return records.map((record) => {
    const pinned = record.pinned ? ' [pinned]' : ''
    return `${record.id}  ${record.kind}  ${scopeLabel(record)}  i${record.importance}${pinned}  ${record.title}\n    ${record.summary}`
  }).join('\n')
}

/**
 * @param {{ store: import('./store.js').MemoryStore, extractor: import('./extractor.js').Extractor }} dependencies
 * @returns {Record<string, any>[]} command definitions.
 */
export function createMemoryCommands(dependencies) {
  const { store, extractor } = dependencies
  return [{
    definitionId: '@local/dsh-memory#memory',
    name: COMMAND_NAME,
    description: 'Inspect or manage the persistent memory library',
    // Declaring free-form input lets the composer claim ``/memory <args>``
    // instead of only accepting the bare token.
    input: {
      hint: 'status | list [q] | search <q> | extract | pause | resume | forget <id> | pin <id> | reset --yes',
    },
    async handler(invocation) {
      return runMemoryCommand({
        store,
        extractor,
        agent: invocation?.agent,
        rawInput: invocation?.rawInput ?? '',
      })
    },
  }]
}

/**
 * Execute one command invocation; exported for unit tests and the client tool.
 * @param {{
 *   store: import('./store.js').MemoryStore,
 *   extractor: import('./extractor.js').Extractor,
 *   agent: any,
 *   rawInput: string,
 * }} input - invocation inputs.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
export async function runMemoryCommand(input) {
  const { store, extractor, agent, rawInput } = input
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/u)
  const subcommand = match?.[1]?.toLowerCase() ?? 'status'
  const rest = (match?.[2] ?? '').trim()
  try {
    switch (subcommand) {
      case 'help':
      case '?':
        return ok(COMMAND_HELP)
      case 'status':
        return ok(describeStatus(store))
      case 'list':
        return ok(formatList(store.list({ query: rest, limit: 20, status: 'active' }).items))
      case 'search': {
        if (rest === '') return fail('Usage: /memory search <query>')
        return ok(formatList(store.search(rest, { limit: 20 })))
      }
      case 'pause':
        store.setSettings({ enabled: false })
        return ok('Persistent memory paused. Existing topics are kept; read, write and injection are disabled.')
      case 'resume':
        store.setSettings({ enabled: true })
        return ok('Persistent memory resumed.')
      case 'extract': {
        if (agent === undefined) return fail('This command needs a live session.')
        const result = await extractor.extractNow(agent, { trigger: 'manual' })
        return ok(describeExtraction(result))
      }
      case 'forget': {
        if (rest === '') return fail('Usage: /memory forget <id>')
        const result = store.remove(rest, { origin: 'manual' })
        return ok(`Deleted ${result.record.id}: ${result.record.title}`)
      }
      case 'pin':
      case 'unpin': {
        if (rest === '') return fail(`Usage: /memory ${subcommand} <id>`)
        const record = store.setPinned(rest, subcommand === 'pin')
        return ok(`${subcommand === 'pin' ? 'Pinned' : 'Unpinned'} ${record.id}: ${record.title}`)
      }
      case 'reset': {
        if (rest !== '--yes') return fail('This deletes every memory topic. Re-run as `/memory reset --yes` to confirm.')
        const result = store.clear()
        return ok(`Deleted ${result.count} memory topic(s). Settings were kept.`)
      }
      default:
        return fail(`Unknown subcommand "${subcommand}".\n\n${COMMAND_HELP}`)
    }
  } catch (error) {
    if (error instanceof Error && /** @type {{code?: string}} */ (error).code !== undefined) {
      throw error
    }
    throw memoryError('internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * @param {import('./store.js').MemoryStore} store - library.
 * @returns {string}
 */
export function describeStatus(store) {
  const stats = store.stats()
  const settings = store.settings
  return [
    'Persistent memory status',
    `- state: ${settings.enabled ? 'enabled' : 'paused'}`,
    `- topics: ${stats.active} active, ${stats.archived} archived (${stats.global} global, ${stats.project} project, ${stats.pinned} pinned)`,
    `- projects: ${stats.projectCount}`,
    `- last update: ${stats.lastUpdatedAt ?? '(never)'}`,
    `- auto extraction: ${settings.autoExtract ? `on (idle ${settings.quietSeconds}s)` : 'off'}`,
    `- injection budget: ${settings.maxTopicsInPrompt} topics / ${settings.maxIndexChars} chars`,
    settings.enabled ? '' : '- resume with `/memory resume`',
  ].filter(line => line !== '').join('\n')
}

/**
 * @param {Record<string, any>} result - extractor result.
 * @returns {string}
 */
function describeExtraction(result) {
  if (result?.status === 'error') return `Memory extraction failed: ${String(result.reason ?? 'unknown error')}`
  if (result?.status === 'skipped') return `Memory extraction skipped: ${String(result.reason ?? 'nothing new')}`
  return `Memory extraction finished: ${Number(result?.created ?? 0)} created, ${Number(result?.updated ?? 0)} updated, ${Number(result?.skipped ?? 0)} skipped.`
}
