/**
 * Browser-half smoke tests that do not require a DOM: the lazy-CJS factory must
 * register, `apply()` must mount the settings section, and wiring that is easy
 * to break silently (filter keys, project-aware payloads) is asserted from the
 * source.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/**
 * Evaluate client.js in a tiny stub environment and return its plugin module.
 * @returns {{ id: string, module: Record<string, any> }}
 */
function loadClientModule() {
  let definition
  const window = { __ModuleLoader__: { load: candidate => { definition = candidate } } }
  const react = {
    createElement: () => ({}),
    Fragment: 'Fragment',
    useCallback: fn => fn,
    useEffect: () => {},
    useId: () => 'id',
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
  }
  const sandbox = {
    window,
    console,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }),
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    URL,
    Request,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(definition?.id, '@local/dsh-memory')
  return { id: definition.id, module: definition.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected client require: ${name}`)
  }) }
}

test('client: lazy factory registers and apply mounts the settings section', () => {
  const { module } = loadClientModule()
  assert.equal(module.inject.length, 2)
  assert.equal(module.inject[0], 'slots')
  assert.equal(module.inject[1], 'locale')
  assert.equal(typeof module.apply, 'function')
  const registrations = []
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect: fn => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (seat, component) => {
        registrations.push({ id: seat.id, component })
        return () => {}
      },
    },
    logger: { warn: () => {} },
  }
  module.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'memory')
  assert.equal(typeof registrations[0].component, 'function')
})

test('client: project filter and project-aware actions use projectKey', () => {
  assert.match(SOURCE, /filter\('projectKey', t\('toolbar\.project'\), projectOptions\)/u)
  assert.match(SOURCE, /filters\.projectKey/u)
  assert.match(SOURCE, /fetchMemory\(item\.id, item\.projectKey\)/u)
  assert.match(SOURCE, /projectKey: item\.projectKey/u)
  assert.match(SOURCE, /projectMaxTopicsInPrompt/u)
  assert.match(SOURCE, /autoSaveMinImportance/u)
  assert.match(SOURCE, /page\.storage/u)
})

test('client: stock commandUi without the local decorateFace extension is tolerated', () => {
  const { module } = loadClientModule()
  const registrations = []
  let effectCalls = 0
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect: (fn) => { effectCalls += 1; const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (deps, callback) => {
      if (deps.includes('commandUi')) {
        callback({
          commandUi: {},
          effect: (fn) => { effectCalls += 1; fn(); return () => {} },
        })
      }
    },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (seat, component) => { registrations.push({ seat, component }); return () => {} },
    },
    logger: { warn: () => {} },
  }
  assert.doesNotThrow(() => module.apply(ctx))
  assert.equal(registrations.length, 1)
  assert.ok(effectCalls >= 1)
})
