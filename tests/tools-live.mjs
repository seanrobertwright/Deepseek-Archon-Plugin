/**
 * M3 tool tests: register the Archon agent tools against a fake ctx and run
 * their execute() against the live Archon server (start it first, or point
 * DSH_ARCHON_BASE_URL elsewhere).
 *
 * Run: node tests/tools-live.mjs
 */
import assert from 'node:assert/strict'
import { registerTools } from '../lib/host/tools.js'
import { archonBaseUrl } from '../lib/host/archon-client.js'

const registered = []
const fakeCtx = {
  get(key) { if (key === 'tools') return { register: (d) => registered.push(d) }; return undefined },
  logger: console,
}

console.log(`tools-live: upstream ${archonBaseUrl()}`)
const ok = registerTools(fakeCtx)
assert.equal(ok, true, 'tools registered')
const byName = Object.fromEntries(registered.map((d) => [d.name, d]))
for (const name of ['archon_status', 'archon_workflows', 'archon_runs', 'archon_run', 'archon_control']) {
  assert.ok(byName[name], `tool ${name} registered`)
  assert.equal(typeof byName[name].execute, 'function')
}
console.log('  ok: 5 tools registered with execute()')

try {
  // archon_status → reachable health envelope.
  const status = JSON.parse(await byName.archon_status.execute({}))
  assert.equal(status.reachable, true)
  assert.equal(status.status, 'ok')
  assert.ok(status.version)
  console.log(`  ok: archon_status -> ${status.status} v${status.version}`)

  // archon_workflows → bundled defaults present without project.
  const wf = JSON.parse(await byName.archon_workflows.execute({}))
  assert.ok(wf.count > 0)
  assert.ok(Array.isArray(wf.workflows))
  console.log(`  ok: archon_workflows -> ${wf.count} workflows`)

  // archon_runs → array (may be empty on a fresh server).
  const runs = JSON.parse(await byName.archon_runs.execute({ limit: 5 }))
  assert.ok(Array.isArray(runs.runs))
  console.log(`  ok: archon_runs -> ${runs.count} runs`)

  // archon_control on a nonexistent run → clean structured error (route reachable).
  await assert.rejects(
    () => byName.archon_control.execute({ runId: 'nonexistent-run-999', action: 'approve' }),
    /404/,
    'archon_control surfaces upstream 404',
  )
  console.log('  ok: archon_control surfaces upstream 404 for unknown run')

  // archon_run with an unknown project path → clean usage error.
  await assert.rejects(
    () => byName.archon_run.execute({ name: 'archon-assist', message: 'hi', codebase: 'Z:/not-a-registered-project' }),
    /not a registered project/,
    'archon_run rejects unknown project path',
  )
  console.log('  ok: archon_run rejects unknown project path')

  console.log('tools-live.mjs: OK — M3 tools verified against live Archon')
} finally {
  // no cleanup needed
}
