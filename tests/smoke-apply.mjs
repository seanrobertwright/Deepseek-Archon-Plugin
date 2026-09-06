/**
 * Smoke test for the dsh-archon host half: assert apply() registers
 *  - the authenticated /api/dsh-archon/state fetch route, and
 *  - the /archon prefix relay route on the webServer when present.
 * Graceful degradation: a context without webServer must not throw.
 *
 * Run: node tests/smoke-apply.mjs
 */
import assert from 'node:assert/strict'

function makeFakeWebServer(capturedRoutes) {
  return {
    register(route) {
      capturedRoutes.push(route)
      return () => {}
    },
    registerUpgrade() { return () => {} },
  }
}

function makeFakeConnection(capturedRoutes) {
  return {
    fetch: {
      register(route) {
        capturedRoutes.push(route)
        return async () => {}
      },
    },
    requestRejection() { return undefined },
  }
}

function makeFakeCtx({ connection, webServer, tools }) {
  const services = { connection, webServer, tools }
  return {
    get(key) { return services[key] },
    effect(fn) { return fn() },
    logger: console,
  }
}

const mod = await import('../lib/index.js')
assert.equal(typeof mod.apply, 'function', 'host apply must be a function')

// --- Case 1: full services present ---
{
  const routes = []
  const registeredTools = []
  const ctx = makeFakeCtx({
    connection: makeFakeConnection(routes),
    webServer: makeFakeWebServer(routes),
    tools: { register: (d) => { registeredTools.push(d); return () => {} } },
  })
  mod.apply(ctx)

  const state = routes.find((r) => r.path === '/api/dsh-archon/state')
  assert.ok(state, 'expected /api/dsh-archon/state registration')
  assert.deepEqual(state.methods, ['GET', 'HEAD'])

  const relay = routes.find((r) => r.kind === 'prefix' && r.path === '/archon')
  assert.ok(relay, 'expected /archon prefix relay registration')
  assert.equal(typeof relay.handler, 'function')

  // M3: the five agent tools registered when the tools service is present.
  const toolNames = registeredTools.map((t) => t.name).sort()
  assert.deepEqual(toolNames, ['archon_control', 'archon_run', 'archon_runs', 'archon_status', 'archon_workflows'],
    'expected the five archon_* agent tools')

  // Route handler applies trust gate then relays (gate passes → handler proceeds).
  const stateRes = await state.fetch(new Request('http://127.0.0.1:3080/api/dsh-archon/state'))
  assert.equal(stateRes.status, 200)
  const body = await stateRes.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.reachable, 'boolean')
  console.log('smoke-apply.mjs: case 1 OK — state route + /archon relay + 5 tools registered')
}

// --- Case 2: no webServer (pure GUI-less host) degrades gracefully ---
{
  const routes = []
  const ctx = makeFakeCtx({
    connection: makeFakeConnection(routes),
    webServer: undefined,
  })
  assert.doesNotThrow(() => mod.apply(ctx))
  const relay = routes.find((r) => r.kind === 'prefix' && r.path === '/archon')
  assert.equal(relay, undefined, 'no relay registered without webServer')
  console.log('smoke-apply.mjs: case 2 OK — graceful degradation without webServer')
}

console.log('smoke-apply.mjs: OK')
