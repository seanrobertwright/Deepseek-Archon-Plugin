/**
 * Render test for the Workflow Studio mode.
 *
 * Loads lib/client.js the way dsh-web-app does (a `window.__ModuleLoader__.load`
 * registration inside a vm) against a hand-rolled React shim and a stub `fetch`
 * standing in for the /archon relay, then drives the real components:
 *
 *   1. the Archon header carries a Studio button that mounts the Studio, whose
 *      picker lists the registered projects and the workflows discovered for
 *      the selected one;
 *   2. opening a project workflow imports its NORMALIZED definition onto the
 *      canvas — one card per node, a dashed edge into the `when`-gated node —
 *      and starts clean;
 *   3. editing a field in the inspector marks the workflow dirty and reports
 *      that up to the console (which arms the mode switch);
 *   4. Save runs client validation, then POST /workflows/validate, and only
 *      PUTs when the server accepts: a rejected validation never reaches the
 *      PUT, and the accepted one sends AUTHORING nodes under the open name;
 *   5. a bundled workflow opens read-only — Save as, no Delete, no palette;
 *   6. New seeds a valid one-node workflow and the palette adds to it;
 *   7. the YAML preview renders the authoring form;
 *   8. clicking an edge selects it even though the click bubbles up to the
 *      svg's clear-selection handler, and Delete selected removes it;
 *   9. a network-level fetch rejection during Save clears the busy state and
 *      keeps the unsaved edits, so a retry can succeed;
 *  10. Rename writes the new name BEFORE deleting the old one, Delete arms on
 *      the first click and only deletes on the second, and Save as copies a
 *      bundled workflow into the project under the new name.
 *
 * The sandbox has no `document`, no `EventSource`, and a `window` without
 * `addEventListener`, so this also proves the Studio's browser-API guards.
 *
 * Run: node tests/studio-render.mjs   (no server, no dependencies)
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
    return {
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }
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

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
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

/** The node cards on the canvas (the card div, not its inner id/kind divs). */
function nodeCards(tree) {
  return findAll(tree, (n) => n.type === 'div' && hasClass(n, 'dsha-node'))
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)) }

// ---- stub relay ------------------------------------------------------------

const CWD = 'E:\\demo'
const LIST_URL = `/archon/api/workflows?cwd=${encodeURIComponent(CWD)}`

const PROJECT_ENTRY = { workflow: { name: 'wf-a', description: 'Demo workflow.' }, source: 'project' }
const BUNDLED_ENTRY = { workflow: { name: 'wf-bundled', description: 'Shipped with Archon.' }, source: 'bundled' }

/** As `GET /api/workflows/{name}` returns it: engine-NORMALIZED nodes. */
const NORMALIZED = {
  name: 'wf-a',
  description: 'Demo workflow.',
  nodes: [
    { id: 'plan', kind: 'agent', source: { kind: 'inline', prompt: 'Plan the work' } },
    { id: 'build', kind: 'exec', depends_on: ['plan'], runtime: 'sh', script: 'echo build' },
    {
      id: 'gate',
      kind: 'gate',
      depends_on: ['build'],
      when: 'build.ok',
      message: 'Approve?',
      decisions: [{ id: 'approve' }, { id: 'reject' }],
      decisionsAuthored: false,
      captureResponse: false,
    },
  ],
}

const BUNDLED_DEFINITION = {
  name: 'wf-bundled',
  description: 'Shipped with Archon.',
  nodes: [{ id: 'only', kind: 'agent', source: { kind: 'inline', prompt: 'Do it' } }],
}

const calls = []
/** Scripted `POST /workflows/validate` replies, consumed in order. */
const validateReplies = [{ valid: false, errors: ['boom'] }, { valid: true }, { valid: true }, { valid: true }]
/** When set, every PUT/DELETE rejects the way fetch does when the relay is down. */
let rejectWrites = false

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function fetchStub(url, init) {
  const method = (init && init.method) || 'GET'
  const body = init && init.body ? JSON.parse(init.body) : null
  calls.push({ method, url, body })

  if (rejectWrites && (method === 'PUT' || method === 'DELETE')) {
    return Promise.reject(new TypeError('fetch failed'))
  }

  if (url === '/archon/api/health') return Promise.resolve(jsonResponse({ status: 'ok', version: '0.10.1' }))
  if (url === '/archon/api/codebases') {
    return Promise.resolve(jsonResponse([{ id: 'cb1', name: 'demo', default_cwd: CWD, kind: 'repo' }]))
  }
  if (url.startsWith('/archon/api/workflows/runs')) return Promise.resolve(jsonResponse({ runs: [] }))
  if (url === '/archon/api/workflows') return Promise.resolve(jsonResponse({ workflows: [BUNDLED_ENTRY] }))
  if (url === LIST_URL) return Promise.resolve(jsonResponse({ workflows: [PROJECT_ENTRY, BUNDLED_ENTRY] }))
  if (url === '/archon/api/workflows/validate' && method === 'POST') {
    return Promise.resolve(jsonResponse(validateReplies.shift() || { valid: true }))
  }
  if (url === `/archon/api/workflows/wf-a?cwd=${encodeURIComponent(CWD)}&source=project`) {
    if (method === 'PUT') {
      return Promise.resolve(jsonResponse({ workflow: body.definition, filename: 'wf-a.yaml', source: 'project' }))
    }
    return Promise.resolve(jsonResponse({ workflow: NORMALIZED, filename: 'wf-a.yaml', source: 'project' }))
  }
  if (url === '/archon/api/workflows/wf-bundled?source=bundled') {
    return Promise.resolve(jsonResponse({ workflow: BUNDLED_DEFINITION, filename: 'wf-bundled.yaml', source: 'bundled' }))
  }
  if (url === `/archon/api/workflows/fresh-flow?cwd=${encodeURIComponent(CWD)}&source=project` && method === 'PUT') {
    return Promise.resolve(jsonResponse({ workflow: body.definition, filename: 'fresh-flow.yaml', source: 'project' }))
  }
  const projectWrite = url.match(/^\/archon\/api\/workflows\/([^/?]+)\?cwd=[^&]*&source=project$/)
  if (projectWrite && method === 'PUT') {
    const name = decodeURIComponent(projectWrite[1])
    return Promise.resolve(jsonResponse({ workflow: body.definition, filename: `${name}.yaml`, source: 'project' }))
  }
  if (projectWrite && method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true }))
  return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
}

// ---- load the bundle -------------------------------------------------------

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

// ---- 1. the Studio mode button mounts the Studio ---------------------------

const consoleInst = mount(ArchonConsole, {})
await flush()
consoleInst.render()

const studioButtons = buttonsLabelled(consoleInst.tree, 'Studio')
assert.equal(studioButtons.length, 1, 'the Archon header offers a Studio mode')
studioButtons[0].props.onClick()

const mounted = findAll(consoleInst.tree, (n) => typeof n.type === 'function' && typeof n.props.onDirtyChange === 'function')
assert.equal(mounted.length, 1, 'Studio mode renders the Studio with a dirty-state callback')
const ArchonStudio = mounted[0].type
const onDirtyChange = mounted[0].props.onDirtyChange
console.log('  ok: the Archon header mounts the Studio as a third mode')

// ---- 2. picker lists projects and workflows --------------------------------

const dirtyReports = []
const studio = mount(ArchonStudio, { onDirtyChange: (dirty) => { dirtyReports.push(dirty); onDirtyChange(dirty) } })
await flush()
studio.render()

const projectSelect = findAll(studio.tree, (n) => n.type === 'select')[0]
assert.ok(projectSelect, 'the picker offers a project select')
assert.equal(projectSelect.props.value, 'cb1', 'the first registered project is selected')
assert.ok(calls.some((c) => c.url === LIST_URL), 'workflows are listed for the selected project checkout')
assert.ok(textOf(studio.tree).includes('wf-a'), 'the project workflow is listed')
assert.ok(textOf(studio.tree).includes('wf-bundled'), 'bundled workflows are listed too')
console.log('  ok: the picker lists projects and the workflows discovered for one')

// ---- 3. opening imports the normalized definition onto the canvas ----------

buttonsLabelled(studio.tree, 'Open')[0].props.onClick()
await flush()
studio.render()

assert.equal(nodeCards(studio.tree).length, 3, 'one canvas card per node')
const drawnEdges = findAll(studio.tree, (n) => n.type === 'path' && hasClass(n, 'dsha-edge'))
assert.equal(drawnEdges.length, 2, 'one edge per depends_on entry')
assert.equal(drawnEdges.filter((p) => p.props.strokeDasharray === '6 4').length, 1, 'the edge into the when-gated node is dashed')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 0, 'a freshly opened workflow is clean')
assert.equal(dirtyReports[dirtyReports.length - 1], false, 'the console is told the Studio is clean')
console.log('  ok: opening imports normalized nodes onto the canvas')

// ---- 4. selecting and editing marks the workflow dirty ---------------------

nodeCards(studio.tree).find((card) => textOf(card).includes('plan')).props.onClick()
studio.render()
const promptBox = findAll(studio.tree, (n) => n.type === 'textarea')[0]
assert.ok(promptBox, 'the inspector edits the selected prompt node in a textarea')
assert.equal(promptBox.props.value, 'Plan the work', 'the inspector shows the imported prompt')

promptBox.props.onChange({ target: { value: 'Plan the work carefully' } })
studio.render()
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 1, 'an edit raises the dirty marker')
assert.equal(dirtyReports[dirtyReports.length - 1], true, 'the console is told about the unsaved edits')

consoleInst.render()
buttonsLabelled(consoleInst.tree, 'Console')[0].props.onClick()
consoleInst.render()
assert.ok(buttonsLabelled(consoleInst.tree, 'Discard edits?').length === 1, 'leaving a dirty Studio arms before it discards')
buttonsLabelled(consoleInst.tree, 'Studio')[0].props.onClick()
consoleInst.render()
console.log('  ok: an inspector edit marks the workflow dirty and guards the mode switch')

// ---- 5. save: client validation, then the server, then the write ----------

const beforeReject = calls.length
buttonsLabelled(studio.tree, 'Save')[0].props.onClick()
await flush()
studio.render()

const rejected = calls.slice(beforeReject)
assert.ok(rejected.some((c) => c.url === '/archon/api/workflows/validate'), 'Save asks the server to validate')
assert.equal(rejected.filter((c) => c.method === 'PUT').length, 0, 'a rejected definition is never written')
assert.ok(textOf(studio.tree).includes('boom'), "the server's own error text is shown verbatim")
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 1, 'a refused save leaves the edits pending')

const beforeSave = calls.length
buttonsLabelled(studio.tree, 'Save')[0].props.onClick()
await flush()
studio.render()

const saved = calls.slice(beforeSave)
const validateAt = saved.findIndex((c) => c.url === '/archon/api/workflows/validate')
const putAt = saved.findIndex((c) => c.method === 'PUT')
assert.ok(validateAt !== -1 && putAt !== -1, 'an accepted definition is validated and then written')
assert.ok(validateAt < putAt, 'validation always runs before the write')
const put = saved[putAt]
assert.equal(put.url, `/archon/api/workflows/wf-a?cwd=${encodeURIComponent(CWD)}&source=project`, 'the write is scoped to the project checkout')
assert.equal(put.body.definition.name, 'wf-a', 'the definition name is forced to the filename')
assert.deepEqual(put.body.definition.nodes[0], { id: 'plan', prompt: 'Plan the work carefully' }, 'nodes are written in authoring shape')
assert.deepEqual(put.body.definition.nodes[1], { id: 'build', depends_on: ['plan'], bash: 'echo build' }, 'the exec node inverts back to bash')
assert.deepEqual(put.body.definition.nodes[2], {
  id: 'gate', depends_on: ['build'], when: 'build.ok', approval: { message: 'Approve?' },
}, 'the gate node inverts back to approval')
assert.ok(!saved.some((c) => c.body && c.body.definition && JSON.stringify(c.body.definition).includes('"kind"')), 'no engine-only kind key is sent')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 0, 'a saved workflow is clean again')
assert.equal(dirtyReports[dirtyReports.length - 1], false)
assert.ok(saved.some((c) => c.url === LIST_URL), 'the workflow list is refreshed after a write')
console.log('  ok: Save validates client-side, then server-side, then writes authoring nodes')

// ---- 6. bundled workflows open read-only -----------------------------------

buttonsLabelled(studio.tree, '‹ Back')[0].props.onClick()
studio.render()
buttonsLabelled(studio.tree, 'View')[0].props.onClick()
await flush()
studio.render()

assert.equal(buttonsLabelled(studio.tree, 'Save as').length, 1, 'a bundled workflow offers Save as')
assert.equal(buttonsLabelled(studio.tree, 'Save').length, 0, 'a bundled workflow cannot be saved in place')
assert.equal(buttonsLabelled(studio.tree, 'Delete').length, 0, 'a bundled workflow cannot be deleted')
assert.equal(buttonsLabelled(studio.tree, 'Rename').length, 0, 'a bundled workflow cannot be renamed')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-palette')).length, 0, 'the palette is hidden while read-only')
assert.ok(textOf(studio.tree).includes('opens read-only'), 'the read-only state is explained')
nodeCards(studio.tree)[0].props.onClick()
studio.render()
assert.equal(findAll(studio.tree, (n) => n.type === 'textarea')[0].props.disabled, true, 'read-only fields are disabled')
console.log('  ok: a bundled workflow opens read-only with Save as')

// ---- 7. New seeds a workflow and the palette adds to it -------------------

buttonsLabelled(studio.tree, '‹ Back')[0].props.onClick()
studio.render()
buttonsLabelled(studio.tree, 'New workflow')[0].props.onClick()
studio.render()

const nameInput = findAll(studio.tree, (n) => n.type === 'input' && n.props.placeholder === 'my-workflow')[0]
assert.ok(nameInput, 'New opens an inline name row rather than a modal')
nameInput.props.onChange({ target: { value: 'fresh-flow' } })
studio.render()
buttonsLabelled(studio.tree, 'Create')[0].props.onClick()
studio.render()

assert.equal(nodeCards(studio.tree).length, 1, 'the New seed is a single-node workflow')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 1, 'a new workflow starts unsaved')

buttonsLabelled(studio.tree, 'Bash')[0].props.onClick()
studio.render()
assert.equal(nodeCards(studio.tree).length, 2, 'the palette adds a node to the canvas')
assert.ok(textOf(studio.tree).includes('bash-1'), 'the added node gets a free id')

// A blank bash body is a client-side blocker: Save must stop before the network.
const beforeBlocked = calls.length
buttonsLabelled(studio.tree, 'Save')[0].props.onClick()
await flush()
studio.render()
assert.equal(calls.length, beforeBlocked, 'client validation blocks the save before any request')
assert.ok(textOf(studio.tree).includes('Cannot save'), 'the blocked save says so')
assert.ok(textOf(studio.tree).includes('bash script must not be empty'), 'the blocking issue is listed')
console.log('  ok: New seeds a workflow, the palette extends it, client errors block the save')

// ---- 8. the YAML preview renders the authoring form ------------------------

buttonsLabelled(studio.tree, 'YAML')[0].props.onClick()
studio.render()
const preview = findAll(studio.tree, (n) => n.type === 'pre' && hasClass(n, 'dsha-studio-yaml'))[0]
assert.ok(preview, 'the YAML toggle shows a preview')
assert.ok(textOf(preview).startsWith('name: fresh-flow'), 'the preview leads with the workflow name')
assert.ok(textOf(preview).includes('  - id: step-1'), 'nodes render id-first, matching what the server writes')
console.log('  ok: the YAML preview renders the authoring form')

// ---- 9. edge clicks survive the bubble to the svg and delete an edge -------

/**
 * The shim invokes handlers directly, so DOM bubbling is simulated by hand:
 * the target's onClick runs first, then — unless it stopped propagation — the
 * ancestor's. This is exactly the path that once cleared an edge selection in
 * the same click that set it.
 */
function bubbleClick(target, ancestor) {
  let stopped = false
  target.props.onClick({ stopPropagation: () => { stopped = true } })
  if (!stopped && ancestor.props.onClick) ancestor.props.onClick()
}

buttonsLabelled(studio.tree, '‹ Back')[0].props.onClick() // arms: fresh-flow is dirty
studio.render()
buttonsLabelled(studio.tree, 'Discard edits?')[0].props.onClick()
studio.render()
buttonsLabelled(studio.tree, 'Open')[0].props.onClick()
await flush()
studio.render()

const svg = findAll(studio.tree, (n) => n.type === 'svg')[0]
const visibleEdges = findAll(studio.tree, (n) => n.type === 'path' && hasClass(n, 'dsha-edge'))
const hitEdges = findAll(studio.tree, (n) => n.type === 'path' && hasClass(n, 'dsha-edge-hit'))
assert.equal(hitEdges.length, 2, 'every edge carries an invisible hit path')
const plainAt = visibleEdges.findIndex((p) => p.props.strokeDasharray === undefined) // plan -> build
bubbleClick(hitEdges[plainAt], svg)
studio.render()
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-edge-selected')).length, 1,
  'the edge stays selected after the click bubbles to the svg')

const deleteSelected = buttonsLabelled(studio.tree, 'Delete selected')[0]
assert.equal(deleteSelected.props.disabled, false, 'Delete selected is live for an edge selection')
deleteSelected.props.onClick()
studio.render()
const edgesLeft = findAll(studio.tree, (n) => n.type === 'path' && hasClass(n, 'dsha-edge'))
assert.equal(edgesLeft.length, 1, 'Delete selected removes the depends_on edge')
assert.equal(edgesLeft[0].props.strokeDasharray, '6 4', 'the surviving edge is the when-gated one')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 1, 'removing an edge is an unsaved edit')
console.log('  ok: an edge click survives bubbling and Delete selected removes the dependency')

// ---- 10. a rejected fetch during Save clears busy and keeps the edits ------

rejectWrites = true
buttonsLabelled(studio.tree, 'Save')[0].props.onClick()
await flush()
studio.render()

assert.ok(textOf(studio.tree).includes('Save failed: fetch failed'), 'a network failure is reported, not swallowed')
const saveAfterFail = buttonsLabelled(studio.tree, 'Save')[0]
assert.ok(saveAfterFail, 'the Save button does not stay stuck on "Saving…"')
assert.equal(saveAfterFail.props.disabled, false, 'busy clears so the save can be retried')
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 1, 'the unsaved edits survive the failure')

rejectWrites = false
buttonsLabelled(studio.tree, 'Save')[0].props.onClick()
await flush()
studio.render()
assert.equal(findAll(studio.tree, (n) => hasClass(n, 'dsha-dirty-dot')).length, 0, 'the retry saves cleanly')
console.log('  ok: a network failure during Save surfaces a notice and the retry works')

// ---- 11. Rename writes the new name before deleting the old one ------------

buttonsLabelled(studio.tree, 'Rename')[0].props.onClick()
studio.render()
findAll(studio.tree, (n) => n.type === 'input' && n.props.placeholder === 'my-workflow')[0]
  .props.onChange({ target: { value: 'wf-b' } })
studio.render()
const beforeRename = calls.length
findAll(studio.tree, (n) => n.type === 'button' && textOf(n) === 'Rename' && hasClass(n, 'dsha-btn-primary'))[0]
  .props.onClick()
await flush()
studio.render()

const renamed = calls.slice(beforeRename)
const renamePut = renamed.findIndex((c) => c.method === 'PUT' && c.url.startsWith('/archon/api/workflows/wf-b?'))
const renameDelete = renamed.findIndex((c) => c.method === 'DELETE' && c.url.startsWith('/archon/api/workflows/wf-a?'))
assert.ok(renamePut !== -1 && renameDelete !== -1, 'Rename writes the new name and deletes the old one')
assert.ok(renamePut < renameDelete, 'the new name is written BEFORE the old one is deleted (fail toward duplication, never loss)')
assert.equal(renamed[renamePut].body.definition.name, 'wf-b', 'the written definition carries the new name')
assert.ok(textOf(studio.tree).includes('Renamed to wf-b'), 'the rename is confirmed')
console.log('  ok: Rename never deletes the old workflow before the new name is written')

// ---- 12. Delete arms on the first click and deletes on the second ----------

const beforeDelete = calls.length
buttonsLabelled(studio.tree, 'Delete')[0].props.onClick()
await flush()
studio.render()
assert.equal(calls.slice(beforeDelete).filter((c) => c.method === 'DELETE').length, 0, 'one click never deletes')
const confirm = buttonsLabelled(studio.tree, 'Confirm delete?')[0]
assert.ok(confirm, 'the first click arms the delete instead')
confirm.props.onClick()
await flush()
studio.render()
const deletes = calls.slice(beforeDelete).filter((c) => c.method === 'DELETE')
assert.equal(deletes.length, 1, 'the second click issues exactly one DELETE')
assert.ok(deletes[0].url.startsWith('/archon/api/workflows/wf-b?'), 'the DELETE targets the open workflow')
assert.ok(textOf(studio.tree).includes('Deleted wf-b'), 'the delete lands back on the picker with a notice')
console.log('  ok: Delete requires a second, arming click')

// ---- 13. Save as copies a bundled workflow into the project ----------------

buttonsLabelled(studio.tree, 'View')[0].props.onClick()
await flush()
studio.render()
buttonsLabelled(studio.tree, 'Save as')[0].props.onClick()
studio.render()
const saveAsInput = findAll(studio.tree, (n) => n.type === 'input' && n.props.placeholder === 'my-workflow')[0]
assert.equal(saveAsInput.props.value, 'wf-bundled', 'Save as pre-fills the bundled name')
saveAsInput.props.onChange({ target: { value: 'wf-copy' } })
studio.render()
const beforeSaveAs = calls.length
findAll(studio.tree, (n) => n.type === 'button' && textOf(n) === 'Save as' && !hasClass(n, 'dsha-btn-small'))[0]
  .props.onClick()
await flush()
studio.render()

const savedAs = calls.slice(beforeSaveAs)
const saveAsValidate = savedAs.findIndex((c) => c.url === '/archon/api/workflows/validate')
const saveAsPut = savedAs.findIndex((c) => c.method === 'PUT')
assert.ok(saveAsValidate !== -1 && saveAsPut !== -1, 'Save as validates and then writes')
assert.ok(saveAsValidate < saveAsPut, 'Save as validates before the write')
assert.equal(savedAs[saveAsPut].url,
  `/archon/api/workflows/wf-copy?cwd=${encodeURIComponent(CWD)}&source=project`,
  'the copy is written under the new name into the selected project, source=project')
assert.equal(savedAs[saveAsPut].body.definition.name, 'wf-copy', 'the definition name is forced to the new filename')
assert.ok(textOf(studio.tree).includes('Saved wf-copy'), 'the copy is confirmed')
assert.equal(buttonsLabelled(studio.tree, 'Save').length, 1, 'the saved copy is editable in place')
console.log('  ok: Save as copies a bundled workflow into the project under the new name')

console.log('studio-render.mjs: OK — Studio picker, canvas, inspector, save flow, and lifecycle (rename/delete/save-as)')
