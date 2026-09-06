/**
 * Client-half registration test.
 *
 * Loads lib/client.js the way dsh-web-app does — as a
 * `window.__ModuleLoader__.load({ id, factory })` registration — then runs the
 * plugin's apply() against a stub slot registry and asserts the three expected
 * contributions:
 *   1. `conversation.view` entry id `archon` (the M0 console tab), label Archon
 *   2. `sidebar.workspaces.tools` entry id `archon` (the sidebar tool)
 *   3. `settings.section` entry id `archon` (the Archon settings page in DSH's
 *      Settings shell), label Archon
 * and that each registered component factory exists.
 *
 * Run: node tests/client-register.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// The loader contract: window.__ModuleLoader__.load({ id, factory }).
let registration = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(reg) { registration = reg },
    },
  },
  CustomEvent: class CustomEvent {},
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
assert.ok(registration, 'bundle called window.__ModuleLoader__.load')
assert.equal(registration.id, 'dsh-archon', 'registration id = package name')

// Run the factory the way the client module system does: it receives `require`
// resolving only table words; this plugin requires just react. The factory and
// its exports live in the vm realm, so compare values structurally, not by
// identity (Array.isArray / deepStrictEqual cross-realm would fail).
const reactShim = { createElement: () => ({}) }
const exported = registration.factory((specifier) => {
  if (specifier === 'react') return reactShim
  throw new Error(`unexpected require: ${specifier}`)
})
assert.equal(typeof exported.apply, 'function', 'client apply exported')
const injectNames = Array.from(exported.inject ?? [])
assert.deepEqual(injectNames, ['slots', 'sessions'], 'client inject services')

// Stub slot registry: slots.inject(slotName, factory) records the factory;
// slots.register(opts, component) records the full registration.
const injects = []
const registered = []
const stubCtx = {
  slots: {
    inject(slotName, factory) {
      injects.push({ slot: slotName, factory })
      return () => {}
    },
    register(opts, component) {
      registered.push({ opts, component })
      return () => {}
    },
  },
}

// apply must not throw (document is undefined in node — the CSS guard skips).
assert.doesNotThrow(() => exported.apply(stubCtx))

const viewInject = injects.find((r) => r.slot === 'conversation.view')
assert.ok(viewInject, 'registered into conversation.view')
viewInject.factory() // the inject callback registers once the slot is declared
const viewReg = registered.find((r) => r.opts.id === 'archon')
assert.ok(viewReg, 'conversation.view archon registration present')
assert.equal(viewReg.opts.name, 'conversation.view')
assert.equal(viewReg.opts.id, 'archon')
assert.equal(viewReg.opts.label, 'Archon')
assert.equal(typeof viewReg.opts.order, 'number')
assert.equal(typeof viewReg.component, 'function', 'view component factory provided')

const toolInject = injects.find((r) => r.slot === 'sidebar.workspaces.tools')
assert.ok(toolInject, 'registered into sidebar.workspaces.tools')
toolInject.factory()
const toolReg = registered.find((r) => r.opts.name === 'sidebar.workspaces.tools')
assert.ok(toolReg, 'sidebar.workspaces.tools registration present')
assert.equal(toolReg.opts.id, 'archon')
assert.equal(toolReg.opts.label, 'Archon')
assert.equal(typeof toolReg.component, 'function', 'tool component factory provided')

const settingsInject = injects.find((r) => r.slot === 'settings.section')
assert.ok(settingsInject, 'registered into settings.section')
settingsInject.factory()
const settingsReg = registered.find((r) => r.opts.name === 'settings.section' && r.opts.id === 'archon')
assert.ok(settingsReg, 'settings.section archon registration present')
assert.equal(settingsReg.opts.label, 'Archon')
assert.equal(typeof settingsReg.opts.order, 'number')
assert.equal(typeof settingsReg.component, 'function', 'settings component factory provided')

console.log('client-register.mjs: OK — conversation.view + sidebar.workspaces.tools + settings.section registered (id archon)')
