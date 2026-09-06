/**
 * studio-core.mjs — the Workflow Studio's round-trip contract (offline).
 *
 * `GET /api/workflows/{name}` returns NORMALIZED nodes (the engine's transform
 * output) while validate/PUT require AUTHORING nodes (the YAML mode keys), so
 * every edit the Studio saves depends on `importDefinition` inverting that
 * transform exactly. This suite pins the inversion per variant against the wire
 * shapes the engine emits, then covers the rest of lib/studio-core.js: sparse
 * export and key order, client validation rules, the YAML preview, graph edges
 * and layout, the model edits, and the name/rename guards.
 *
 * Run: node tests/studio-core.mjs   (no server, no dependencies)
 */
import assert from 'node:assert/strict'
import * as core from '../lib/studio-core.js'

/** Import one wire node, export it again, and hand back both halves. */
function roundTrip(node, extra = {}) {
  const definition = { name: 'wf', description: 'd', nodes: [node], ...extra }
  const { model, issues } = core.importDefinition(definition)
  return { model, issues, node: core.exportDefinition(model).nodes[0] }
}

// ---- 1. normalized -> authoring, one case per variant ----------------------

const inline = roundTrip({
  id: 'plan',
  kind: 'agent',
  depends_on: ['start'],
  when: 'start.ok',
  trigger_rule: 'any_success',
  model: 'sonnet',
  allowed_tools: ['Read'],
  idle_timeout: 600,
  hooks: { pre: ['echo hi'] },
  source: { kind: 'inline', prompt: 'Do the thing' },
})
assert.equal(inline.model.nodes[0].variant, 'prompt', 'an inline agent node is a prompt node')
assert.deepEqual(inline.node, {
  id: 'plan',
  depends_on: ['start'],
  when: 'start.ok',
  trigger_rule: 'any_success',
  model: 'sonnet',
  allowed_tools: ['Read'],
  idle_timeout: 600,
  hooks: { pre: ['echo hi'] },
  prompt: 'Do the thing',
})
assert.equal(Object.keys(inline.node)[0], 'id', 'an exported node leads with its id')
assert.equal(Object.keys(inline.node).pop(), 'prompt', 'the mode key follows the base fields')
assert.deepEqual(inline.issues, [], 'a known variant imports without issues')

const command = roundTrip({
  id: 'run',
  kind: 'agent',
  source: { kind: 'command', name: 'archon:plan', with: { topic: 'studio' } },
})
assert.equal(command.model.nodes[0].variant, 'command')
assert.deepEqual(command.node, { id: 'run', command: 'archon:plan', with: { topic: 'studio' } })

const bash = roundTrip({
  id: 'build',
  kind: 'exec',
  depends_on: [],
  script: 'bun run build',
  runtime: 'sh',
  timeout: 120000,
})
assert.equal(bash.model.nodes[0].variant, 'bash', "runtime 'sh' is the bash variant")
assert.deepEqual(bash.node, { id: 'build', bash: 'bun run build', timeout: 120000 })
assert.ok(!('depends_on' in bash.node), 'an empty depends_on is never emitted')

const script = roundTrip({
  id: 'py',
  kind: 'exec',
  output_format: { type: 'object' },
  script: 'print(1)',
  runtime: 'uv',
  deps: ['requests'],
  timeout: 60000,
  with: { a: 1 },
})
assert.equal(script.model.nodes[0].variant, 'script')
assert.deepEqual(script.node, {
  id: 'py',
  output_format: { type: 'object' },
  script: 'print(1)',
  runtime: 'uv',
  deps: ['requests'],
  timeout: 60000,
  with: { a: 1 },
})

const scriptNoRuntime = roundTrip({ id: 'py2', kind: 'exec', script: 'print(2)' })
assert.equal(scriptNoRuntime.node.runtime, 'bun', 'a script node with no runtime stays editable as bun')
assert.equal(scriptNoRuntime.issues.length, 1, 'the missing runtime is reported, not silently defaulted')
assert.equal(scriptNoRuntime.issues[0].severity, 'error')

const loop = roundTrip({
  id: 'impl',
  kind: 'loop',
  output_format: { type: 'object' },
  pi: { posture: 'off' },
  loop: { prompt: 'Iterate', until: 'DONE', max_iterations: 5, fresh_context: false },
})
assert.equal(loop.model.nodes[0].variant, 'loop')
assert.deepEqual(loop.node, {
  id: 'impl',
  output_format: { type: 'object' },
  pi: { posture: 'off' },
  loop: { prompt: 'Iterate', until: 'DONE', max_iterations: 5, fresh_context: false },
})

// A gate the author never gave decisions to: the engine synthesized the default
// approve/reject pair, so the authoring form has neither `decisions` nor `on_reject`.
const gateDefault = roundTrip({
  id: 'ok',
  kind: 'gate',
  message: 'Approve?',
  decisions: [{ id: 'approve' }, { id: 'reject' }],
  decisionsAuthored: false,
  captureResponse: false,
})
assert.deepEqual(gateDefault.node, { id: 'ok', approval: { message: 'Approve?' } })

const gateAuthored = roundTrip({
  id: 'pick',
  kind: 'gate',
  message: 'Pick one',
  decisions: [{ id: 'ship' }, { id: 'hold' }],
  decisionsAuthored: true,
  captureResponse: true,
})
assert.deepEqual(gateAuthored.node, {
  id: 'pick',
  approval: { message: 'Pick one', capture_response: true, decisions: [{ id: 'ship' }, { id: 'hold' }] },
})

// A legacy `on_reject:` gate: the engine turned it into a reject decision
// carrying a rework block, and the importer turns it back.
const gateRework = roundTrip({
  id: 'review',
  kind: 'gate',
  message: 'Review the diff',
  decisions: [{ id: 'approve' }, { id: 'reject', rework: { prompt: 'Fix the findings', maxAttempts: 3 } }],
  decisionsAuthored: false,
  captureResponse: false,
})
assert.deepEqual(gateRework.node, {
  id: 'review',
  approval: { message: 'Review the diff', on_reject: { prompt: 'Fix the findings', max_attempts: 3 } },
})

// The engine injects a fixed output_format on every wait node; re-sending it
// would put a field in the file the author never wrote.
const wait = roundTrip({
  id: 'hold',
  kind: 'wait',
  wait: { duration_ms: 1000 },
  output_format: { type: 'object', properties: { reason: { type: 'string' } } },
})
assert.deepEqual(wait.node, { id: 'hold', wait: { duration_ms: 1000 } })

const halt = roundTrip({ id: 'stop', kind: 'halt', reason: 'Nothing to do' })
assert.deepEqual(halt.node, { id: 'stop', cancel: 'Nothing to do' })
console.log('  ok: every authored variant survives normalized -> model -> authoring')

// ---- 2. opaque nodes ride through verbatim ---------------------------------

const include = roundTrip({
  id: 'inc',
  kind: 'include',
  depends_on: ['stop'],
  include: 'shared/setup',
  with: { x: 1 },
})
assert.equal(include.model.nodes[0].variant, 'opaque', 'an include node has no authoring inversion')
assert.deepEqual(include.node, { id: 'inc', depends_on: ['stop'], include: 'shared/setup', with: { x: 1 } })
assert.ok(!('kind' in include.node), 'the engine-only kind key is stripped on the way out')
assert.equal(include.issues.length, 1, 'an opaque node is reported')
assert.equal(include.issues[0].severity, 'warning', 'an opaque node is a warning, not a blocker')
assert.equal(include.issues[0].nodeId, 'inc')

// Its graph fields are still editable, and editing them does not disturb the body.
const rewired = core.setBaseField(include.model, 'inc', 'when', 'stop.ok')
assert.deepEqual(core.exportDefinition(rewired).nodes[0], {
  id: 'inc',
  depends_on: ['stop'],
  when: 'stop.ok',
  include: 'shared/setup',
  with: { x: 1 },
})
console.log('  ok: unauthored node kinds stay openable and round-trip verbatim')

// A loop_group body nests a whole sub-DAG, and the server normalizes those
// children too — leaving them normalized makes the save fail validation.
const loopGroup = roundTrip({
  id: 'corrections',
  kind: 'loop_group',
  depends_on: ['inc'],
  loop_group: {
    until: 'CLEAN',
    max_iterations: 3,
    nodes: [
      { id: 'check', kind: 'exec', runtime: 'sh', script: 'run checks' },
      { id: 'settle', kind: 'wait', depends_on: ['check'], wait: { duration_ms: 5000 }, output_format: { type: 'object' } },
      { id: 'fix', kind: 'agent', depends_on: ['settle'], source: { kind: 'inline', prompt: 'Fix what failed' } },
    ],
  },
})
assert.equal(loopGroup.model.nodes[0].variant, 'opaque')
assert.deepEqual(loopGroup.node, {
  id: 'corrections',
  depends_on: ['inc'],
  loop_group: {
    until: 'CLEAN',
    max_iterations: 3,
    nodes: [
      { id: 'check', bash: 'run checks' },
      { id: 'settle', depends_on: ['check'], wait: { duration_ms: 5000 } },
      { id: 'fix', depends_on: ['settle'], prompt: 'Fix what failed' },
    ],
  },
}, 'nested sub-DAG children are converted back to authoring shape as well')

// A JSON schema that happens to describe a 'nodes' property is not a node list.
const schemaNode = roundTrip({ id: 'shape', kind: 'agent', output_format: { type: 'object', required: ['nodes'], properties: { nodes: { type: 'array' } } }, source: { kind: 'inline', prompt: 'p' } })
assert.deepEqual(schemaNode.node.output_format, { type: 'object', required: ['nodes'], properties: { nodes: { type: 'array' } } })
console.log('  ok: nested sub-DAGs inside opaque nodes are converted too')

// ---- 3. authoring-shaped input imports through the same path ---------------

const authoring = {
  name: 'wf',
  description: 'd',
  version: 2,
  nodes: [
    { id: 'a', prompt: 'hi' },
    { id: 'b', depends_on: ['a'], loop: { prompt: 'go', until: 'DONE', max_iterations: 3 } },
  ],
}
const once = core.exportDefinition(core.importDefinition(authoring).model)
const twice = core.exportDefinition(core.importDefinition(once).model)
assert.deepEqual(twice, once, 'importing an exported definition is idempotent')
assert.deepEqual(once, authoring, 'an authoring definition round-trips unchanged')
assert.deepEqual(Object.keys(once), ['name', 'description', 'version', 'nodes'], 'meta keys keep their place and order')
console.log('  ok: authoring-shaped definitions import idempotently')

// ---- 4. client validation --------------------------------------------------

/** Validate an authoring definition and return its issue messages. */
function issuesFor(definition) {
  return core.validateModel(core.importDefinition(definition).model).map((i) => `${i.severity}: ${i.message}`)
}
const ok = { name: 'wf', description: 'd', nodes: [{ id: 'a', prompt: 'hi' }] }
assert.deepEqual(issuesFor(ok), [], 'a minimal valid workflow reports nothing')

assert.ok(issuesFor({ ...ok, name: '' }).some((m) => m.includes('needs a name')))
assert.ok(issuesFor({ ...ok, description: '' }).some((m) => m.includes('needs a description')))
assert.ok(issuesFor({ ...ok, nodes: [] }).some((m) => m.includes('at least one node')))
assert.ok(issuesFor({ ...ok, nodes: [{ id: '', prompt: 'x' }] }).some((m) => m.includes('empty id')))
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }] }).some((m) => m.includes("Duplicate node id 'a'")),
)
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: '2bad', prompt: 'x' }] }).some((m) => m.startsWith('warning:') && m.includes('identifier-shaped')),
  'an odd id shape is advisory — the engine accepts any non-empty id',
)
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', prompt: 'x', depends_on: ['ghost'] }] }).some((m) => m.includes("unknown node 'ghost'")),
)
assert.ok(
  issuesFor({
    ...ok,
    nodes: [{ id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'y', depends_on: ['a'] }],
  }).some((m) => m.includes('cycle')),
)
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', prompt: '  ' }] }).some((m) => m.includes('prompt must not be empty')))
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', command: '' }] }).some((m) => m.includes('command must not be empty')))
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', bash: '' }] }).some((m) => m.includes('bash script must not be empty')))
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', script: 'x', runtime: 'node' }] }).some((m) => m.includes("runtime 'bun' or 'uv'")))
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', approval: { message: '' } }] }).some((m) => m.includes('approval requires a message')))
assert.ok(issuesFor({ ...ok, nodes: [{ id: 'a', cancel: '' }] }).some((m) => m.includes('cancel requires a reason')))

const loopBoth = { id: 'a', loop: { prompt: 'p', command: 'c', until: 'X', max_iterations: 2 } }
assert.ok(issuesFor({ ...ok, nodes: [loopBoth] }).some((m) => m.includes("exactly one of 'prompt' or 'command'")))
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', loop: { prompt: 'p', max_iterations: 2 } }] }).some((m) => m.includes('completion channel')),
)
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', loop: { prompt: 'p', until: 'X', max_iterations: 0 } }] })
    .some((m) => m.includes("positive integer 'max_iterations'")),
)
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', wait: { duration_ms: 1000, until: '2026-01-01T00:00:00Z' } }] })
    .some((m) => m.includes('exactly one of')),
)
assert.ok(
  issuesFor({ ...ok, nodes: [{ id: 'a', wait: { event: 'deploy' } }] }).some((m) => m.includes("positive integer 'deadline_ms'")),
)
assert.deepEqual(issuesFor({ ...ok, nodes: [{ id: 'a', wait: { event: 'deploy', deadline_ms: 1000 } }] }), [])
assert.equal(core.blockingIssues(core.validateModel(core.importDefinition({ ...ok, nodes: [{ id: '2bad', prompt: 'x' }] }).model)).length, 0,
  'a warning alone never blocks a save')
console.log('  ok: client validation covers name, ids, graph, and every variant rule')

// ---- 5. YAML preview -------------------------------------------------------

const previewDefinition = core.exportDefinition(core.importDefinition({
  name: 'demo',
  description: 'A demo workflow.',
  version: 1,
  nodes: [
    { id: 'a', prompt: 'Say hi' },
    { id: 'b', depends_on: ['a'], when: 'a.ok', bash: 'echo one\necho two', timeout: 1000 },
  ],
}).model)
assert.equal(core.serializeYamlPreview(previewDefinition), [
  'name: demo',
  'description: A demo workflow.',
  'version: 1',
  '',
  'nodes:',
  '  - id: a',
  '    prompt: Say hi',
  '  - id: b',
  '    depends_on:',
  '      - a',
  '    when: a.ok',
  '    bash: |',
  '      echo one',
  '      echo two',
  '    timeout: 1000',
  '',
].join('\n'))

// Scalars a YAML parser would re-type come back quoted; the rest stay plain.
const quoted = core.serializeYamlPreview({ name: 'q', nodes: [{ id: 'a', prompt: 'yes', command: '1.5', when: 'a: b', model: 'x' }] })
assert.ok(quoted.includes('prompt: "yes"'), 'an ambiguous word is quoted')
assert.ok(quoted.includes('command: "1.5"'), 'a numeric-looking string is quoted')
assert.ok(quoted.includes('when: "a: b"'), 'a colon forces quoting')
assert.ok(quoted.includes('model: x'), 'a plain scalar stays plain')
assert.ok(!/[ \t]+$/m.test(core.serializeYamlPreview(previewDefinition)), 'no line carries trailing whitespace')
assert.ok(core.serializeYamlPreview({ name: 'e', nodes: [{ id: 'a', deps: [], with: {} }] }).includes('deps: []'), 'an empty array is inline')
console.log('  ok: the YAML preview matches the golden and quotes ambiguous scalars')

// ---- 6. edges and layout ---------------------------------------------------

const diamond = core.importDefinition({
  name: 'd',
  description: 'd',
  nodes: [
    { id: 'a', prompt: 'a' },
    { id: 'b', depends_on: ['a'], prompt: 'b' },
    { id: 'c', depends_on: ['a'], when: 'a.ok', prompt: 'c' },
    { id: 'd', depends_on: ['b', 'c'], prompt: 'd' },
  ],
}).model
const edges = core.edgesFromModel(diamond)
assert.deepEqual(edges.map((e) => e.id), ['a->b', 'a->c', 'b->d', 'c->d'])
assert.equal(core.edgeIdFor('a', 'b'), 'a->b')
assert.deepEqual(edges.filter((e) => e.dashed).map((e) => e.id), ['a->c'], 'only edges into a when-gated node are dashed')

const positions = core.layoutGraph(diamond.nodes, edges)
assert.deepEqual(positions, {
  a: { x: 0, y: 0 },
  b: { x: 0, y: core.NODE_H + 80 },
  c: { x: core.NODE_W + 40, y: core.NODE_H + 80 },
  d: { x: 0, y: (core.NODE_H + 80) * 2 },
}, 'rank = one past the deepest dependency, column = index within the rank')

const dangling = core.importDefinition({ name: 'x', description: 'x', nodes: [{ id: 'a', depends_on: ['ghost'], prompt: 'a' }] }).model
assert.deepEqual(core.edgesFromModel(dangling), [], 'an unknown dependency draws no edge')
assert.deepEqual(core.exportDefinition(dangling).nodes[0].depends_on, ['ghost'], 'but it stays in the model for validation to report')

const cyclic = core.importDefinition({
  name: 'c',
  description: 'c',
  nodes: [{ id: 'a', depends_on: ['b'], prompt: 'a' }, { id: 'b', depends_on: ['a'], prompt: 'b' }],
}).model
assert.equal(Object.keys(core.layoutGraph(cyclic.nodes, core.edgesFromModel(cyclic))).length, 2, 'a cycle still lays out')
console.log('  ok: edges follow depends_on and the layout ranks a diamond')

// ---- 7. model edits --------------------------------------------------------

const added = core.addNode(diamond, 'bash')
assert.equal(added.node.id, 'bash-1', 'a new node gets a free <variant>-<n> id')
assert.deepEqual(added.node.data, { bash: '' }, 'a new node starts from the variant defaults')
assert.equal(added.model.nodes.length, 5)
assert.equal(diamond.nodes.length, 4, 'the edit never mutates the model it was given')
assert.equal(core.addNode(added.model, 'bash').node.id, 'bash-2', 'ids keep counting past the ones in use')

const connected = core.connectNodes(diamond, 'a', 'd')
assert.deepEqual(connected.nodes[3].base.depends_on, ['b', 'c', 'a'])
assert.equal(core.connectNodes(diamond, 'a', 'a'), diamond, 'a node cannot depend on itself')
assert.equal(core.connectNodes(diamond, 'a', 'b'), diamond, 'a duplicate edge changes nothing')
assert.equal(core.connectNodes(diamond, 'ghost', 'b'), diamond, 'an unknown endpoint changes nothing')

const disconnected = core.disconnectNodes(diamond, 'b', 'd')
assert.deepEqual(disconnected.nodes[3].base.depends_on, ['c'])
assert.ok(!('depends_on' in core.disconnectNodes(diamond, 'a', 'b').nodes[1].base), 'the key is dropped once it empties')

const removed = core.removeNode(diamond, 'b')
assert.deepEqual(removed.nodes.map((n) => n.id), ['a', 'c', 'd'])
assert.deepEqual(removed.nodes[2].base.depends_on, ['c'], 'removing a node strips it from every depends_on')

const renamed = core.renameNode(diamond, 'a', 'start')
assert.deepEqual(renamed.nodes.map((n) => n.id), ['start', 'b', 'c', 'd'])
assert.deepEqual(renamed.nodes[1].base.depends_on, ['start'], 'renaming rewrites the references to it')
assert.deepEqual(diamond.nodes[1].base.depends_on, ['a'], 'the original model is untouched')

const edited = core.setDataField(core.setDataField(diamond, 'a', 'prompt', 'new text'), 'b', ['loop', 'until'], 'DONE')
assert.equal(core.exportDefinition(edited).nodes[0].prompt, 'new text')
assert.equal(core.exportDefinition(core.setDataField(edited, 'a', 'prompt', undefined)).nodes[0].prompt, undefined,
  'setting a field to undefined deletes the key')
assert.equal(core.findNodeIndex(diamond, 'c'), 2)
assert.equal(core.findNodeIndex(diamond, 'ghost'), -1)
console.log('  ok: every model edit is pure and keeps depends_on consistent')

// ---- 8. names, rename planning, seeds, sources -----------------------------

for (const name of ['my-flow_2', 'a.b', 'archon-assist']) {
  assert.equal(core.isValidWorkflowName(name), true, `${name} is a writable name`)
}
for (const name of ['', '.hidden', 'a/b', 'a\\b', 'a..b']) {
  assert.equal(core.isValidWorkflowName(name), false, `${name} is refused`)
}
assert.deepEqual(core.planRename('a', 'b', ['a', 'c']), { ok: true })
assert.deepEqual(core.planRename('a', 'a', ['a']), { ok: false, reason: 'noop' })
assert.deepEqual(core.planRename('a', 'c', ['a', 'c']), { ok: false, reason: 'collision' })
assert.deepEqual(core.planRename('a', 'x/y', ['a']), { ok: false, reason: 'invalid-name' })
assert.ok(core.renameReasonMessage('collision', 'c').includes('already exists'))
assert.ok(core.renameReasonMessage('invalid-name', 'x/y').includes('not a valid workflow name'))

const seed = core.newWorkflowSeed('fresh')
assert.deepEqual(seed, { name: 'fresh', description: 'New workflow.', nodes: [{ id: 'step-1', prompt: 'Describe what this step should do.' }] })
assert.deepEqual(core.validateModel(core.importDefinition(seed).model), [], 'the New seed is valid on arrival')

assert.equal(core.isReadOnlySource('bundled'), true)
assert.equal(core.isReadOnlySource('project'), false)
assert.equal(core.saveTargetFor('global'), 'global', 'a global workflow saves back to global')
assert.equal(core.saveTargetFor('bundled'), 'project', 'a bundled workflow saves as a project override')
assert.equal(core.saveTargetFor('project'), 'project')

assert.deepEqual(core.serverIssues(['boom']), [{ severity: 'error', message: 'boom', nodeId: '' }])
assert.equal(core.serverIssues([]).length, 1, 'a rejection with no details still shows one issue')
assert.equal(core.serverIssues(undefined)[0].message.includes('no error details'), true)
console.log('  ok: name guards, rename planning, the New seed, and save targets')

// ---- 9. presentation helpers the canvas and inspector lean on --------------

assert.equal(core.nodeSummary(diamond.nodes[0]), 'a')
assert.equal(core.nodeSummary(core.importDefinition({ nodes: [{ id: 'x', prompt: 'line one\nline two' }] }).model.nodes[0]), 'line one')
assert.equal(core.nodeSummary(core.importDefinition({ nodes: [{ id: 'x', prompt: 'y'.repeat(80) }] }).model.nodes[0]).length, 46,
  'a long summary is capped with an ellipsis')
assert.equal(core.VARIANT_INFO.prompt.label, 'Prompt')
assert.notEqual(core.VARIANT_INFO.loop.defaults(), core.VARIANT_INFO.loop.defaults(), 'defaults() hands back a fresh object each call')
assert.deepEqual(core.STUDIO_VARIANTS, ['prompt', 'command', 'bash', 'script', 'loop', 'approval', 'wait', 'cancel'])
assert.deepEqual(
  core.preservedBaseKeys(inline.model.nodes[0]),
  ['trigger_rule', 'allowed_tools', 'idle_timeout', 'hooks'].filter((k) => !core.EDITABLE_BASE_KEYS.includes(k)),
  'the inspector reports exactly the base fields it preserves without editing',
)
console.log('  ok: canvas and inspector helpers')

console.log('studio-core.mjs: OK — Studio round trip, validation, YAML, graph, guards')
