/**
 * Render test for the run-detail drill-down + artifacts panel.
 *
 * The bundle exports only apply()/inject, so this loads lib/client.js the way
 * dsh-web-app does (a `window.__ModuleLoader__.load({ id, factory })`
 * registration inside a vm) against a hand-rolled React shim that implements
 * createElement/useState/useEffect, plus a stub `fetch` standing in for the
 * /archon relay. It then drives the real components:
 *
 *   1. the Runs table renders a "Details" button per row, and clicking it
 *      mounts the detail panel for that run id;
 *   2. the panel fetches GET /archon/api/workflows/runs/{id} and
 *      GET /archon/api/runs/{id}/artifacts and renders the run header, the
 *      event timeline (zone-less event timestamps read as UTC) and the
 *      artifact list;
 *   3. clicking a text artifact fetches the wildcard content route with each
 *      path segment escaped and previews the body in a <pre>;
 *   4. a binary body and an over-cap file fall back to a note + raw link
 *      instead of an inline preview;
 *   5. Close hands control back to the console.
 *
 * Run: node tests/run-detail-render.mjs   (no server, no dependencies)
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

/** Mount one function component and keep re-rendering it as its state changes. */
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

/** Concatenated string content of an element subtree. */
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

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

// ---- stub relay ------------------------------------------------------------

const RUN_ID = '5be27afb-9fd0-4360-ba49-300ccf39066b'
const EVENT_AT = '2026-09-06 14:55:23' // SQLite shape: zone-less, written in UTC

const RUN_ROW = {
  id: RUN_ID,
  workflow_name: 'archon-deliver',
  status: 'running',
  outcome: null,
  started_at: '2026-09-06T14:55:23.000Z',
  completed_at: null,
  last_activity_at: '2026-09-06T14:55:23.000Z',
  user_message: 'Deliver the run-detail drill-down',
}

const EVENTS = [
  { id: 'ev-1', event_order: 896, event_type: 'workflow_started', step_name: null, created_at: EVENT_AT, data: { workflowName: 'archon-deliver' } },
  { id: 'ev-2', event_order: 897, event_type: 'node_started', step_name: 'impl__implement', created_at: EVENT_AT, data: { type: 'loop' } },
]

const TEXT_FILE = { path: 'notes/plan summary.md', size: 26, modifiedAt: '2026-09-06T14:57:40.966Z' }
const BINARY_FILE = { path: 'out/blob.bin', size: 300, modifiedAt: '2026-09-06T14:57:55.552Z' }
const HUGE_FILE = { path: 'out/transcript.jsonl', size: 200 * 1024, modifiedAt: '2026-09-06T14:58:00.000Z' }

const TEXT_BODY = '# Summary\n\nAll six green.\n'
const BINARY_BODY = 'PK' + '\u0003' + '\u0004' + '\uFFFD' + '\uFFFD' + '\uFFFD' + '\uFFFD'

const fetchCalls = []

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

function fetchStub(url) {
  fetchCalls.push(url)
  if (url === '/archon/api/health') return Promise.resolve(jsonResponse({ status: 'ok', version: '0.10.1' }))
  if (url === '/archon/api/codebases') return Promise.resolve(jsonResponse([]))
  if (url === '/archon/api/workflows') return Promise.resolve(jsonResponse({ workflows: [] }))
  if (url.startsWith('/archon/api/workflows/runs?')) return Promise.resolve(jsonResponse({ runs: [RUN_ROW] }))
  if (url === `/archon/api/workflows/runs/${RUN_ID}`) return Promise.resolve(jsonResponse({ run: RUN_ROW, events: EVENTS }))
  if (url === `/archon/api/runs/${RUN_ID}/artifacts`) {
    return Promise.resolve(jsonResponse({ files: [TEXT_FILE, BINARY_FILE, HUGE_FILE] }))
  }
  if (url === `/archon/api/artifacts/${RUN_ID}/notes/plan%20summary.md`) {
    return Promise.resolve({ ok: true, status: 200, text: async () => TEXT_BODY })
  }
  if (url === `/archon/api/artifacts/${RUN_ID}/out/blob.bin`) {
    return Promise.resolve({ ok: true, status: 200, text: async () => BINARY_BODY })
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'not found' })
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
const viewFactory = registered.find((r) => r.opts.name === 'conversation.view').component
// The slot component is a thin wrapper: unwrap it to the console itself.
const ArchonConsole = viewFactory({}).type
assert.equal(typeof ArchonConsole, 'function', 'conversation.view renders a component')

// ---- 1. Details button per run row ----------------------------------------

const console_ = mount(ArchonConsole, {})
await flush()
console_.render()

const detailButtons = buttonsLabelled(console_.tree, 'Details')
assert.equal(detailButtons.length, 1, 'one Details button per run row')
assert.equal(detailButtons[0].props['aria-expanded'], false, 'Details starts collapsed')
console.log('  ok: Runs table renders a Details button per row')

detailButtons[0].props.onClick()
const panelElements = findAll(console_.tree, (n) => typeof n.type === 'function' && n.props.runId === RUN_ID)
assert.equal(panelElements.length, 1, 'clicking Details mounts the run detail panel')
const panelProps = panelElements[0].props
assert.equal(typeof panelProps.refreshTick, 'number', 'panel receives the SSE refresh counter')
assert.equal(typeof panelProps.onClose, 'function', 'panel receives a close handler')
assert.equal(buttonsLabelled(console_.tree, 'Details')[0].props['aria-expanded'], true, 'Details reports expanded')

buttonsLabelled(console_.tree, 'Details')[0].props.onClick()
assert.equal(
  findAll(console_.tree, (n) => typeof n.type === 'function' && n.props.runId === RUN_ID).length,
  0,
  'Details toggles the panel closed again',
)
console.log('  ok: Details opens and closes the panel for its run')

// ---- 2. panel header, timeline, artifact list ------------------------------

const RunDetailPanel = panelElements[0].type
let closed = 0
const panel = mount(RunDetailPanel, { runId: RUN_ID, refreshTick: 0, onClose: () => { closed += 1 } })
await flush()
panel.render()

assert.ok(fetchCalls.includes(`/archon/api/workflows/runs/${RUN_ID}`), 'panel fetched the run detail route')
assert.ok(fetchCalls.includes(`/archon/api/runs/${RUN_ID}/artifacts`), 'panel fetched the artifact listing route')

const panelText = textOf(panel.tree)
assert.ok(panelText.includes('archon-deliver'), 'header names the workflow')
assert.ok(panelText.includes('running'), 'header shows the run status')
assert.ok(panelText.includes(RUN_ID), 'header shows the run id')
assert.ok(panelText.includes('Deliver the run-detail drill-down'), 'header shows the run message')

const timelineItems = findAll(panel.tree, (n) => n.type === 'ol').flatMap((ol) => ol.children)
assert.equal(timelineItems.length, EVENTS.length, 'one timeline row per event')
assert.ok(textOf(timelineItems[0]).includes('workflow_started'), 'timeline shows the event type')
assert.ok(textOf(timelineItems[1]).includes('impl__implement'), 'timeline shows the step name')
assert.ok(textOf(timelineItems[1]).includes('"type":"loop"'), 'timeline shows the event payload')

// Zone-less event timestamps are UTC, not process-local.
const expectedClock = new Date('2026-09-06T14:55:23Z').toLocaleTimeString()
assert.ok(textOf(timelineItems[0]).includes(expectedClock), 'event timestamp read as UTC')
console.log('  ok: panel renders the run header and the event timeline')

const artifactButtons = findAll(panel.tree, (n) => n.type === 'button' && typeof n.props['aria-expanded'] === 'boolean')
assert.equal(artifactButtons.length, 3, 'one row per artifact file')
assert.ok(textOf(artifactButtons[0]).includes(TEXT_FILE.path), 'artifact row shows its path')
assert.ok(textOf(artifactButtons[0]).includes('26 B'), 'artifact row shows its size')
assert.ok(textOf(artifactButtons[2]).includes('200.0 KiB'), 'large artifact size formatted')
console.log('  ok: panel lists the run artifacts with size and mtime')

// ---- 3. text artifact previews inline --------------------------------------

artifactButtons[0].props.onClick()
await flush()
panel.render()

assert.ok(
  fetchCalls.includes(`/archon/api/artifacts/${RUN_ID}/notes/plan%20summary.md`),
  'content route escapes path segments but not the separators',
)
const pre = findAll(panel.tree, (n) => n.type === 'pre')
assert.equal(pre.length, 1, 'text artifact previews in a <pre>')
assert.equal(textOf(pre[0]), TEXT_BODY, 'preview shows the artifact body')
console.log('  ok: text artifact previews inline through the content route')

// ---- 4. binary and over-cap files fall back to a link ----------------------

findAll(panel.tree, (n) => n.type === 'button' && typeof n.props['aria-expanded'] === 'boolean')[1].props.onClick()
await flush()
panel.render()

assert.equal(findAll(panel.tree, (n) => n.type === 'pre').length, 0, 'binary artifact is not previewed')
assert.ok(textOf(panel.tree).includes('Not a text file.'), 'binary artifact explains itself')
const links = findAll(panel.tree, (n) => n.type === 'a')
assert.equal(links.length, 1, 'binary artifact offers a raw link')
assert.equal(links[0].props.href, `/archon/api/artifacts/${RUN_ID}/out/blob.bin`, 'raw link points at the content route')
assert.equal(links[0].props.rel, 'noopener noreferrer', 'raw link opens safely')

const beforeHuge = fetchCalls.length
findAll(panel.tree, (n) => n.type === 'button' && typeof n.props['aria-expanded'] === 'boolean')[2].props.onClick()
await flush()
panel.render()
assert.equal(fetchCalls.length, beforeHuge, 'over-cap artifact is never fetched')
assert.ok(textOf(panel.tree).includes('Too large to preview inline'), 'over-cap artifact explains itself')
console.log('  ok: binary and over-cap artifacts degrade to a note plus raw link')

// ---- 5. live refresh + close ----------------------------------------------

const beforeRefresh = fetchCalls.length
panel.props = { runId: RUN_ID, refreshTick: 1, onClose: panel.props.onClose }
panel.render()
await flush()
assert.ok(fetchCalls.length > beforeRefresh, 'a refresh tick re-fetches the open run')

buttonsLabelled(panel.tree, 'Close')[0].props.onClick()
assert.equal(closed, 1, 'Close asks the console to drop the panel')
console.log('  ok: SSE refresh tick re-fetches, Close dismisses the panel')

console.log('run-detail-render.mjs: OK — run detail drill-down + artifacts panel')
