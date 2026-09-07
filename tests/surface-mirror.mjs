/**
 * surface-mirror.mjs — the browser bundle's embedded copy of
 * lib/archon-surface.js matches the module (offline).
 *
 * Also loads the surface module and exercises every normalizer against the
 * raw row shapes recorded in tests/contract/archon-openapi.subset.json's
 * examples, so a field rename shows up here before it reaches the UI.
 *
 * The bundle embeds two modules — lib/archon-surface.js and lib/studio-core.js
 * — and both copies are checked here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  embeddedSurface, embeddedStudioCore, splitClient, CLIENT_PATH, START, END, STUDIO_START, STUDIO_END,
} from '../scripts/sync-client-surface.mjs'
import * as surface from '../lib/archon-surface.js'

const { block } = splitClient()
assert.equal(block, embeddedSurface(), 'lib/client.js embedded surface is stale (run node scripts/sync-client-surface.mjs)')
console.log('  ok: lib/client.js mirrors lib/archon-surface.js')

const studioBlock = splitClient(STUDIO_START, STUDIO_END).block
assert.equal(studioBlock, embeddedStudioCore(), 'lib/client.js embedded studio-core is stale (run node scripts/sync-client-surface.mjs)')
console.log('  ok: lib/client.js mirrors lib/studio-core.js')

// The CRLF fold is exercised here regardless of how this checkout's line
// endings came out: the bundle is re-terminated with CRLF in memory and must
// still split into the same blocks, so a `core.autocrlf=true` checkout cannot
// fail the mirror check on an untouched tree.
const crlfClient = readFileSync(CLIENT_PATH, 'utf8').replace(/\r?\n/g, '\r\n')
assert.ok(crlfClient.includes('\r\n'), 'the probe text really is CRLF-terminated')
assert.equal(splitClient(START, END, crlfClient).block, embeddedSurface(), 'a CRLF bundle splits to the same surface block')
assert.equal(splitClient(STUDIO_START, STUDIO_END, crlfClient).block, embeddedStudioCore(), 'a CRLF bundle splits to the same studio-core block')
console.log('  ok: CRLF-terminated bundle text splits identically')

// Normalizers accept the documented row shapes and reject garbage quietly.
const run = surface.normalizeRun({
  id: 'r1', workflow_name: 'archon-assist', status: 'paused', outcome: null, user_message: 'hi',
  started_at: '2026-09-06T10:00:00.000Z', completed_at: null, last_activity_at: '2026-09-06T10:05:00.000Z',
  codebase_id: 'cb1', conversation_id: 'c1',
})
assert.deepEqual(run, {
  id: 'r1', workflow: 'archon-assist', status: 'paused', outcome: null, message: 'hi', codebaseId: 'cb1',
  conversationId: 'c1', startedAt: '2026-09-06T10:00:00.000Z', completedAt: null, lastActivityAt: '2026-09-06T10:05:00.000Z',
})
assert.equal(surface.normalizeRun(null).workflow, '', 'null run row normalizes to empty fields')

assert.deepEqual(surface.normalizeWorkflowList({
  workflows: [{ workflow: { name: 'a', description: 'first\nsecond' }, source: 'bundled' }, { name: 'flat' }],
  errors: [{ filename: 'x.yaml' }],
}), { entries: [{ name: 'a', source: 'bundled', description: 'first' }, { name: 'flat', source: '?', description: '' }], errorCount: 1 })

assert.deepEqual(surface.normalizeProviders({ providers: [{ id: 'codex', displayName: 'Codex', effortLevels: ['low'] }] }),
  [{ id: 'codex', displayName: 'Codex', effortLevels: ['low'] }], 'wrapped provider list')
assert.deepEqual(surface.normalizeProviders([{ id: 'claude' }]),
  [{ id: 'claude', displayName: 'claude', effortLevels: null }], 'bare provider list')

assert.equal(surface.normalizeArtifactList({ nope: true }), null, 'malformed artifact listing is null')
assert.deepEqual(surface.normalizeArtifactList({ files: [{ path: 'a.md', size: 3, modifiedAt: 't' }] }),
  [{ path: 'a.md', size: 3, modifiedAt: 't' }])

assert.deepEqual(surface.normalizeRunDetail({ run: { id: 'r' }, events: [{ id: 'e', event_type: 'log', step_name: 's', event_order: 2, created_at: 't', data: { a: 1 } }] }).events,
  [{ id: 'e', order: 2, type: 'log', step: 's', data: { a: 1 }, at: 't' }])

assert.deepEqual(surface.normalizeConversation({ id: 'row', platform_conversation_id: 'web-1', title: 'T', codebase_id: null }),
  { id: 'row', platformId: 'web-1', title: 'T', codebaseId: null })
assert.deepEqual(surface.normalizeConfig({ config: { assistant: 'claude', assistants: { claude: {} } }, database: 'sqlite' }),
  { assistant: 'claude', assistants: { claude: {} }, database: 'sqlite' })
assert.deepEqual(surface.registerCodebasePayload('https://github.com/a/b'), { url: 'https://github.com/a/b' })
assert.deepEqual(surface.registerCodebasePayload('E:/repo'), { path: 'E:/repo' })
assert.equal(surface.ARCHON_PATHS.artifact('r 1', 'notes/plan summary.md'), '/artifacts/r%201/notes/plan%20summary.md')
assert.equal(surface.ARCHON_PATHS.runs({ status: 'paused', limit: 5 }), '/workflows/runs?status=paused&limit=5')

// Workflow-definition routes: one path builder, three verbs; the query carries
// only the arguments that were given.
assert.equal(surface.ARCHON_PATHS.workflow('a b'), '/workflows/a%20b')
assert.equal(surface.ARCHON_PATHS.workflow('a b', 'C:\\x', 'project'), '/workflows/a%20b?cwd=C%3A%5Cx&source=project')
assert.equal(surface.ARCHON_PATHS.workflow('wf', '', 'bundled'), '/workflows/wf?source=bundled')
assert.equal(surface.ARCHON_PATHS.workflowValidate(), '/workflows/validate')
assert.equal(surface.ARCHON_PATHS.commands('E:/repo'), '/commands?cwd=E%3A%2Frepo')
assert.equal(surface.ARCHON_PATHS.commands(''), '/commands')
assert.deepEqual(surface.definitionPayload({ name: 'wf' }), { definition: { name: 'wf' } })
assert.deepEqual(surface.normalizeWorkflowDefinition({ workflow: { name: 'wf' }, filename: 'wf.yaml', source: 'project' }),
  { workflow: { name: 'wf' }, filename: 'wf.yaml', source: 'project' })
assert.equal(surface.normalizeWorkflowDefinition({ error: 'not found' }), null, 'a body without a workflow is not a definition')
assert.equal(surface.normalizeWorkflowDefinition(null), null, 'a missing body is not a definition')

// Every catalog endpoint has a path builder that produces its template's prefix.
for (const endpoint of surface.ENDPOINTS) {
  assert.match(endpoint.path, /^\/api\//, `endpoint ${endpoint.path} is under /api`)
}
console.log('  ok: normalizers and path builders')
console.log('surface-mirror.mjs: OK')
