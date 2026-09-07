/**
 * Render test for the Studio mode (Archon's own workflow builder in a frame).
 *
 * Loads lib/client.js the way dsh-web-app does (a `window.__ModuleLoader__.load`
 * registration inside a vm) against a hand-rolled React shim and a stub `fetch`
 * standing in for the /archon relay and the host state probe, then drives the
 * real console component:
 *
 *   1. no builder frame exists until Studio is first opened;
 *   2. opening Studio mounts a frame on Archon's BROWSER-facing origin (the
 *      host probe's `archonBrowserUrl`, not the relay base) at /console/builder,
 *      with no project or workflow in the deep link by default;
 *   3. picking a project adds `?project=<codebase id>`; picking a workflow puts
 *      its name in the path;
 *   4. leaving Studio hides the frame but keeps it mounted, so unsaved edits in
 *      the builder survive a look at the console;
 *   5. "Edit in Studio" on a console workflow card opens that workflow in the
 *      frame and picks the first project when none was chosen;
 *   6. Reload re-keys the frame so React remounts it;
 *   7. when the host probe fails the frame is replaced by an explanation, not a
 *      frame with an empty src.
 *
 * Run: node tests/builder-render.mjs   (no server, no dependencies)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---- minimal React shim (createElement + useState + useEffect) -------------

let currentInstance = null

const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    // Function components (Section) read `props.children` the way React hands
    // it over: one child bare, several as an array.
    const merged = Object.assign({}, props || {})
    if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids
    return { type, props: merged, children: kids }
  },
  useState(initial) {
    const inst = currentInstance
    const slot = hookSlot(inst, () => ({ value: typeof initial === 'function' ? initial() : initial }))
    const set = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
      inst.render()
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const inst = currentInstance
    const slot = hookSlot(inst, () => ({ deps: null, cleanup: null, fresh: true }))
    const changed = slot.fresh || !deps || !slot.deps
      || deps.length !== slot.deps.length
      || deps.some((d, i) => d !== slot.deps[i])
    if (!changed) return
    slot.fresh = false
    slot.deps = deps ? deps.slice() : null
    inst.pending.push([slot, fn])
  },
}

function hookSlot(inst, make) {
  const i = inst.cursor++
  if (inst.hooks.length <= i) inst.hooks.push(make())
  return inst.hooks[i]
}

function mount(component, props) {
  const inst = { hooks: [], cursor: 0, pending: [], tree: null, props, depth: 0 }
  inst.render = () => {
    assert.ok(inst.depth < 50, 'render loop')
    inst.depth += 1
    inst.cursor = 0
    inst.pending = []
    const previous = currentInstance
    currentInstance = inst
    try {
      inst.tree = component(inst.props)
    } finally {
      currentInstance = previous
    }
    const queue = inst.pending
    inst.pending = []
    for (const [slot, fn] of queue) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
    inst.depth -= 1
  }
  inst.render()
  return inst
}

/**
 * Render a nested function component (ArchonBuilder, Section) against a throwaway
 * hook instance so its output is visible to the tree helpers below. Hook state
 * created here is discarded: the helpers only read what the component renders.
 */
function expand(node) {
  const scratch = { hooks: [], cursor: 0, pending: [], render() {} }
  const previous = currentInstance
  currentInstance = scratch
  try {
    return node.type(node.props)
  } finally {
    currentInstance = previous
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  if (typeof node.type === 'function') {
    walk(expand(node), visit)
    return
  }
  for (const child of node.children || []) walk(child, visit)
}

function findAll(node, predicate) {
  const found = []
  walk(node, (n) => { if (predicate(n)) found.push(n) })
  return found
}

function textOf(node) {
  let text = ''
  const collect = (n) => {
    if (typeof n === 'string' || typeof n === 'number') { text += String(n); return }
    if (!n || typeof n !== 'object') return
    if (typeof n.type === 'function') { collect(expand(n)); return }
    for (const child of n.children || []) collect(child)
  }
  collect(node)
  return text
}

function buttonsLabelled(tree, label) {
  return findAll(tree, (n) => n.type === 'button' && textOf(n) === label)
}

function hasClass(node, name) {
  return typeof node.props.className === 'string' && node.props.className.split(' ').indexOf(name) !== -1
}

const frames = (tree) => findAll(tree, (n) => n.type === 'iframe')
const builderRoot = (tree) => findAll(tree, (n) => n.type === 'div' && hasClass(n, 'dsha-builder'))

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)) }

// ---- stub relay + host probe -------------------------------------------------

const BROWSER_ORIGIN = 'http://archon.test:3090'
let hostProbeDown = false

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function fetchStub(url) {
  if (url === '/api/dsh-archon/state') {
    if (hostProbeDown) return Promise.reject(new TypeError('probe down'))
    return Promise.resolve(jsonResponse({
      ok: true,
      archonBaseUrl: 'http://127.0.0.1:3090',
      archonBrowserUrl: BROWSER_ORIGIN,
      reachable: true,
      compat: { compatible: true },
    }))
  }
  if (url === '/archon/api/health') return Promise.resolve(jsonResponse({ status: 'ok', version: '0.10.1' }))
  if (url === '/archon/api/codebases') {
    return Promise.resolve(jsonResponse([
      { id: 'cb1', name: 'demo', default_cwd: 'E:\\demo', kind: 'repo' },
      { id: 'cb2', name: 'other', default_cwd: 'E:\\other', kind: 'repo' },
    ]))
  }
  if (url.startsWith('/archon/api/workflows/runs')) return Promise.resolve(jsonResponse({ runs: [] }))
  if (url === '/archon/api/workflows') {
    return Promise.resolve(jsonResponse({ workflows: [
      { workflow: { name: 'wf a', description: 'Has a space.' }, source: 'project' },
      { workflow: { name: 'wf-bundled', description: 'Shipped with Archon.' }, source: 'bundled' },
    ] }))
  }
  return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
}

// ---- load the bundle -----------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let registration = null
const sandbox = {
  window: { __ModuleLoader__: { load(reg) { registration = reg } } },
  CustomEvent: class CustomEvent {},
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

const exported = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})

const registered = []
exported.apply({
  slots: {
    inject(name, factory) { if (name === 'conversation.view') factory(); return () => {} },
    register(opts, component) { registered.push({ opts, component }); return () => {} },
  },
})
const ArchonConsole = registered.find((r) => r.opts.name === 'conversation.view').component({}).type

// ---- 1. no frame until Studio is opened ---------------------------------------

const consoleInst = mount(ArchonConsole, {})
await flush()
consoleInst.render()

assert.equal(frames(consoleInst.tree).length, 0, 'the console does not mount the builder frame up front')
const studioButtons = buttonsLabelled(consoleInst.tree, 'Studio')
assert.equal(studioButtons.length, 1, 'the Archon header offers a Studio mode')
console.log('  ok: no builder frame before Studio is opened')

// ---- 2. Studio mounts the frame on the browser-facing origin -------------------

studioButtons[0].props.onClick()
let frame = frames(consoleInst.tree)
assert.equal(frame.length, 1, 'Studio mounts exactly one frame')
assert.equal(frame[0].props.src, `${BROWSER_ORIGIN}/console/builder`, 'the frame opens the builder picker on the browser-facing origin')
assert.equal(frame[0].props.title, 'Archon workflow builder', 'the frame is labelled for assistive tech')
assert.equal(builderRoot(consoleInst.tree)[0].props.hidden, undefined, 'the builder is visible in Studio mode')
const openLink = findAll(consoleInst.tree, (n) => n.type === 'a' && textOf(n).startsWith('Open in Archon'))
assert.equal(openLink.length, 1, 'an Open in Archon link mirrors the frame URL')
assert.equal(openLink[0].props.href, frame[0].props.src)
assert.equal(openLink[0].props.rel, 'noopener noreferrer')
console.log('  ok: Studio frames Archon\'s builder on the browser-facing origin')

// ---- 3. project + workflow pickers shape the deep link --------------------------

const selects = () => findAll(consoleInst.tree, (n) => n.type === 'select')
const projectSelect = () => selects().find((n) => (n.props.title || '').startsWith('Project the builder'))
const workflowSelect = () => selects().find((n) => (n.props.title || '').startsWith('Workflow to open'))
assert.deepEqual(projectSelect().children.map((o) => o.props.value), ['', 'cb1', 'cb2'], 'the project picker lists every codebase')
assert.deepEqual(workflowSelect().children.map((o) => o.props.value), ['', 'wf a', 'wf-bundled'], 'the workflow picker lists every discovered workflow')

projectSelect().props.onChange({ target: { value: 'cb2' } })
assert.equal(frames(consoleInst.tree)[0].props.src, `${BROWSER_ORIGIN}/console/builder?project=cb2`, 'a project choice becomes the ?project= deep link')
workflowSelect().props.onChange({ target: { value: 'wf a' } })
assert.equal(frames(consoleInst.tree)[0].props.src, `${BROWSER_ORIGIN}/console/builder/wf%20a?project=cb2`, 'a workflow choice goes into the path, encoded')
console.log('  ok: pickers shape the builder deep link')

// ---- 4. leaving Studio hides the frame, keeps it mounted ------------------------

buttonsLabelled(consoleInst.tree, 'Console')[0].props.onClick()
assert.equal(frames(consoleInst.tree).length, 1, 'the frame stays mounted outside Studio')
assert.equal(builderRoot(consoleInst.tree)[0].props.hidden, true, 'the builder is hidden outside Studio')
assert.equal(frames(consoleInst.tree)[0].props.src, `${BROWSER_ORIGIN}/console/builder/wf%20a?project=cb2`, 'the hidden frame keeps its page')
console.log('  ok: leaving Studio hides the frame without unmounting it')

// ---- 5. "Edit in Studio" on a workflow card ------------------------------------

// reset the plugin-side project choice to prove the card falls back to the first project
projectSelect().props.onChange({ target: { value: '' } })
workflowSelect().props.onChange({ target: { value: '' } })
const editButtons = buttonsLabelled(consoleInst.tree, 'Edit in Studio')
assert.equal(editButtons.length, 2, 'every workflow card offers Edit in Studio')
editButtons[1].props.onClick()
assert.equal(builderRoot(consoleInst.tree)[0].props.hidden, undefined, 'Edit in Studio switches to Studio')
assert.equal(frames(consoleInst.tree)[0].props.src, `${BROWSER_ORIGIN}/console/builder/wf-bundled?project=cb1`, 'the card opens its workflow under the first project')
console.log('  ok: Edit in Studio deep-links the card\'s workflow')

// ---- 6. Reload re-keys the frame -----------------------------------------------

const keyBefore = frames(consoleInst.tree)[0].props.key
buttonsLabelled(consoleInst.tree, 'Reload')[0].props.onClick()
assert.notEqual(frames(consoleInst.tree)[0].props.key, keyBefore, 'Reload changes the frame key so React remounts it')
assert.equal(frames(consoleInst.tree)[0].props.src, `${BROWSER_ORIGIN}/console/builder/wf-bundled?project=cb1`, 'Reload keeps the page')
console.log('  ok: Reload remounts the frame')

// ---- 7. a failed host probe yields an explanation, not an empty frame ------------

hostProbeDown = true
const darkInst = mount(ArchonConsole, {})
await flush()
darkInst.render()
buttonsLabelled(darkInst.tree, 'Studio')[0].props.onClick()
assert.equal(frames(darkInst.tree).length, 0, 'no frame without a browser-facing URL')
const empty = findAll(darkInst.tree, (n) => n.type === 'div' && hasClass(n, 'dsha-builder-empty'))
assert.equal(empty.length, 1, 'the empty state explains the missing URL')
assert.match(textOf(empty[0]), /DSH_ARCHON_BROWSER_URL/, 'the empty state names the override')
const reload = buttonsLabelled(darkInst.tree, 'Reload')
assert.equal(reload[0].props.disabled, true, 'Reload is disabled without a URL')
console.log('  ok: a failed host probe explains itself')

console.log('builder-render.mjs: OK')
