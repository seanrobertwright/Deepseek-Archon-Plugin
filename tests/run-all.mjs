/**
 * Run every dsh-archon test in sequence.
 *
 *   node tests/run-all.mjs
 *
 * Tests:
 *   1. smoke-apply.mjs        — host apply registers state route + /archon relay
 *                               + 5 tools (and degrades gracefully)
 *   2. client-register.mjs    — browser bundle registers conversation.view +
 *                               sidebar.workspaces.tools + settings.section
 *                               under __ModuleLoader__
 *   3. run-detail-render.mjs  — run detail drill-down + artifacts panel driven
 *                               against a React shim and a stub relay (offline)
 *   4. tools-live.mjs         — M3 archon_* tools against a live Archon server
 *   5. chat-sse-live.mjs      — M2 per-conversation SSE stream via the relay
 *                               (needs a live server + AI provider)
 *   6. relay-loopback.mjs     — /archon relay REST + SSE passthrough against a
 *                               live Archon server (start it first, or point
 *                               DSH_ARCHON_BASE_URL elsewhere)
 *   7. gui-e2e.mjs            — dsh-archon LIVE in the running dsh web GUI:
 *                               boot graph carries the client row, served
 *                               bundle has M2/M1 code, /archon relay returns
 *                               real Archon JSON (needs the running GUI + a
 *                               reachable Archon server)
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const tests = [
  'smoke-apply.mjs',
  'client-register.mjs',
  'run-detail-render.mjs',
  'tools-live.mjs',
  'chat-sse-live.mjs',
  'relay-loopback.mjs',
  'gui-e2e.mjs',
]
let failed = 0

for (const name of tests) {
  const result = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' })
  const ok = result.status === 0
  console.log(`\n=== ${name}: ${ok ? 'PASS' : 'FAIL (exit ' + result.status + ')'} ===`)
  if (!ok) failed += 1
}

console.log(`\nrun-all.mjs: ${failed === 0 ? 'ALL TESTS PASSED' : failed + ' test(s) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
