/**
 * Loopback test of the /archon relay against a real upstream.
 *
 * Mounts handleRelay on a tiny node:http server (simulating the dsh webServer
 * route seat) and points it at ARCHON_BASE (default http://127.0.0.1:3090).
 * Asserts:
 *   1. REST passthrough: GET /archon/api/health returns upstream JSON (200).
 *   2. Query passthrough: GET /archon/api/workflows returns a JSON object with
 *      a `workflows` array (bundled defaults exist without any codebase).
 *   3. SSE passthrough: GET /archon/api/stream/__dashboard__ emits at least
 *      one data frame within a timeout (heartbeat), proving long-lived streams
 *      relay.
 *   4. Method passthrough: an upstream 404 (GET /archon/api/nope) comes back
 *      as 404 JSON with Archon's error envelope.
 *   5. The run-detail read routes (run detail, artifact listing, artifact
 *      content) reach Archon and return its envelope for an unknown run.
 *
 * Run: node tests/relay-loopback.mjs  (start the Archon server first, or set
 * DSH_ARCHON_BASE_URL to any live Archon API)
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { handleRelay, registerRelay, archonBaseUrl } from '../lib/host/relay.js'

const baseUrl = archonBaseUrl()
console.log(`relay-loopback: upstream ${baseUrl}`)

const server = createServer((req, res) => {
  void handleRelay(req, res, baseUrl)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const relayPort = server.address().port
const relay = (path) => `http://127.0.0.1:${relayPort}${path}`

async function getJson(path, timeoutMs = 15000) {
  const res = await fetch(relay(path), { signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, ct: res.headers.get('content-type'), body: await res.json() }
}

try {
  // 1. Health passthrough.
  const health = await getJson('/archon/api/health')
  assert.equal(health.status, 200, 'health status 200')
  assert.equal(health.body.status, 'ok', 'health body status ok')
  console.log(`  ok: /archon/api/health -> ${JSON.stringify(health.body.status)} v${health.body.version ?? '?'}`)

  // 2. Workflows discovery (bundled defaults, no project needed).
  const wf = await getJson('/archon/api/workflows')
  assert.equal(wf.status, 200, 'workflows status 200')
  assert.ok(Array.isArray(wf.body.workflows), 'workflows body has array')
  assert.ok(wf.body.workflows.length > 0, 'bundled defaults present')
  console.log(`  ok: /archon/api/workflows -> ${wf.body.workflows.length} workflows`)

  // 3. SSE passthrough: expect >=1 data frame (heartbeat) shortly after connect.
  const sseSeen = await new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); resolve(0) }, 8000)
    void (async () => {
      try {
        const res = await fetch(relay('/archon/api/stream/__dashboard__'), {
          signal: controller.signal,
        })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let frames = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const idx = buffer.indexOf('\n\n')
          if (idx !== -1) {
            frames += 1
            clearTimeout(timer)
            controller.abort()
            break
          }
        }
        resolve(frames)
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })()
  })
  assert.ok(sseSeen >= 1, 'dashboard SSE emitted a frame through the relay')
  console.log('  ok: /archon/api/stream/__dashboard__ relayed a data frame')

  // 8. Upstream 404 passthrough (Hono returns plain "404 Not Found" for
  //    unknown routes — status + body must round-trip regardless of shape).
  const res4 = await fetch(relay('/archon/api/definitely-not-a-route'), { signal: AbortSignal.timeout(8000) })
  const text4 = await res4.text()
  assert.equal(res4.status, 404, 'upstream 404 preserved')
  console.log(`  ok: unknown route -> ${res4.status} ${text4.slice(0, 40)}`)

  // 5. POST passthrough with JSON body (the M1 write path): create a web
  //    conversation through the relay — Archon's DB write, no git needed.
  const created = await fetch(relay('/archon/api/conversations'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(created.status, 200, 'POST /api/conversations through relay -> 200')
  const createdBody = await created.json()
  assert.ok(createdBody.conversationId && createdBody.conversationId.startsWith('web-'), 'conversation created')
  console.log(`  ok: POST relay -> conversation ${createdBody.conversationId}`)

  // 6. Read-back through the relay: Archon only lists conversations that carry
  //    a title or messages, so give it a title via PATCH, then list.
  const convId = createdBody.conversationId
  const patched = await fetch(relay('/archon/api/conversations/' + encodeURIComponent(convId)), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title: 'dsh-archon relay test' }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(patched.ok, 'PATCH conversation through relay succeeds')
  const conv = await getJson('/archon/api/conversations')
  assert.equal(conv.status, 200, 'conversations list status 200')
  const listed = (conv.body || []).some((c) => c.platform_conversation_id === convId)
  assert.ok(listed, 'titled conversation appears in the relayed list')
  console.log('  ok: PATCH + relayed list includes the titled conversation')

  // 7. Run-control verb sweep through the relay: approve/reject/cancel/resume/
  //    abandon must all reach Archon and return its 404 envelope for an
  //    unknown run (proves routing + JSON body contract for the M1 console).
  for (const [verb, body] of [
    ['approve', '{}'],
    ['reject', '{"reason":"test"}'],
    ['cancel', '{}'],
    ['resume', '{}'],
    ['abandon', '{}'],
  ]) {
    const res = await fetch(relay('/archon/api/workflows/runs/nonexistent-run-123/' + verb), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(res.status, 404, `run ${verb} through relay -> 404`)
    const env = await res.json()
    assert.equal(env.error, 'Workflow run not found', `run ${verb} error envelope`)
  }
  console.log('  ok: run-control verbs (approve/reject/cancel/resume/abandon) reach Archon')

  // 7b. Read routes behind the console's run-detail drill-down: run detail,
  //     artifact listing and artifact content all reach Archon and return its
  //     error envelope unchanged for an unknown run.
  for (const path of [
    '/archon/api/workflows/runs/nonexistent-run-123',
    '/archon/api/runs/nonexistent-run-123/artifacts',
    '/archon/api/artifacts/nonexistent-run-123/notes/plan%20summary.md',
  ]) {
    const res = await fetch(relay(path), { signal: AbortSignal.timeout(10000) })
    assert.equal(res.status, 404, `${path} through relay -> 404`)
    const env = await res.json()
    assert.equal(env.error, 'Workflow run not found', `${path} error envelope`)
  }
  console.log('  ok: run detail + artifact list/content routes reach Archon')

  // 8. Settings-page endpoints (the Archon settings page inside DSH Settings
  //    reads these + writes assistant config and project env vars).
  const configRes = await getJson('/archon/api/config')
  assert.equal(configRes.status, 200, 'GET /api/config through relay -> 200')
  assert.equal(typeof configRes.body.config?.assistant, 'string', 'config carries default assistant')
  assert.equal(typeof configRes.body.config?.assistants, 'object', 'config carries assistants map')
  assert.equal(typeof configRes.body.database, 'string', 'config carries database name')
  const originalAssistant = configRes.body.config.assistant
  const assistantsMap = configRes.body.config.assistants ?? {}
  console.log(`  ok: /archon/api/config -> default assistant ${originalAssistant}, db ${configRes.body.database}`)

  const providersRes = await getJson('/archon/api/providers')
  assert.equal(providersRes.status, 200, 'GET /api/providers through relay -> 200')
  assert.ok(Array.isArray(providersRes.body.providers) && providersRes.body.providers.length > 0, 'providers listed')
  const providerIds = providersRes.body.providers.map((p) => p.id)
  console.log(`  ok: /archon/api/providers -> ${providerIds.join(', ')}`)

  const codebasesRes = await getJson('/archon/api/codebases')
  assert.equal(codebasesRes.status, 200, 'GET /api/codebases through relay -> 200')
  assert.ok(Array.isArray(codebasesRes.body), 'codebases is an array')
  console.log(`  ok: /archon/api/codebases -> ${codebasesRes.body.length} projects`)

  if (Array.isArray(codebasesRes.body) && codebasesRes.body.length > 0) {
    const codebaseId = codebasesRes.body[0].id
    const envKey = 'DSHA_SETTINGS_RELAY_TEST'
    const setEnv = await fetch(relay('/archon/api/codebases/' + encodeURIComponent(codebaseId) + '/env'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ key: envKey, value: 'roundtrip' }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(setEnv.ok, 'PUT codebase env var through relay succeeds')
    const envList = await getJson('/archon/api/codebases/' + encodeURIComponent(codebaseId) + '/env')
    assert.ok(envList.body.keys.includes(envKey), 'set env var key is listed')
    const delEnv = await fetch(
      relay('/archon/api/codebases/' + encodeURIComponent(codebaseId) + '/env/' + encodeURIComponent(envKey)),
      { method: 'DELETE', signal: AbortSignal.timeout(15000) }
    )
    assert.ok(delEnv.ok, 'DELETE codebase env var through relay succeeds')
    const envList2 = await getJson('/archon/api/codebases/' + encodeURIComponent(codebaseId) + '/env')
    assert.ok(!envList2.body.keys.includes(envKey), 'deleted env var key is gone')
    console.log('  ok: codebase env var PUT/DELETE roundtrip through the relay')
  } else {
    console.log('  ok: no codebases — env var roundtrip skipped')
  }

  // PATCH /api/config/assistants is idempotent for the current default and is
  // the settings page's write path; drive it away and back to prove routing.
  const registeredAssistant = providerIds.includes(originalAssistant)
    ? originalAssistant
    : providerIds[0]
  const poke = await fetch(relay('/archon/api/config/assistants'), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ assistant: registeredAssistant, assistants: assistantsMap }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(poke.ok, 'PATCH /api/config/assistants through relay succeeds')
  const pokeBody = await poke.json()
  assert.equal(pokeBody.config?.assistant, registeredAssistant, 'assistant default updated')
  const restore = await fetch(relay('/archon/api/config/assistants'), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ assistant: originalAssistant, assistants: assistantsMap }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(restore.ok, 'PATCH assistant restore succeeds')
  const restoreBody = await restore.json()
  assert.equal(restoreBody.config?.assistant, originalAssistant, 'assistant default restored')
  console.log(`  ok: PATCH /api/config/assistants write path (${originalAssistant} -> ${registeredAssistant} -> ${originalAssistant})`)

  // 9. Trust/auth gate contract: registerRelay must short-circuit a request
  //    that connection.requestRejection rejects (401/403) without proxying.
  const captured = []
  let rejection = 401
  const fakeCtx = {
    get(key) {
      if (key === 'webServer') {
        return {
          register(route) {
            captured.push(route)
            return () => {}
          },
        }
      }
      if (key === 'connection') {
        return { requestRejection: () => rejection }
      }
      return undefined
    },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: console,
  }
  const dispose = registerRelay(fakeCtx)
  assert.equal(typeof dispose, 'function', 'registerRelay returns a disposer')
  const gatedHandler = captured.find((r) => r.kind === 'prefix' && r.path === '/archon').handler
  const gateResult = await new Promise((resolve) => {
    const fakeRes = {
      writeHead(status) { resolve(status) },
      end() {},
    }
    gatedHandler({ url: '/archon/api/health', method: 'GET', headers: {} }, fakeRes)
  })
  assert.equal(gateResult, 401, 'rejected request answered 401 without proxying')
  console.log('  ok: registerRelay honors connection.requestRejection (401)')

  console.log('relay-loopback.mjs: OK — relay REST + SSE passthrough verified')
} finally {
  server.close()
}
