/**
 * Live-GUI end-to-end checks for dsh-archon (round 7).
 *
 * Authenticates to the RUNNING dsh web GUI at 127.0.0.1:3080 by reconstructing
 * a valid browser-session cookie (HMAC over {version,authority,issuedAt,
 * expiresAt} with the persisted secret from ~/.dsh/.credentials.yaml — the same
 * construction BrowserAuth mints in its token exchange), then verifies:
 *   1. GET / serves the index with the dsh-archon client row in the boot graph.
 *   2. The composed combo bundle's dsh-archon segment carries the current code
 *      (M2 chat toggle, M1 run controls, launch panel).
 *   3. GET /archon/api/health through the plugin's relay returns live Archon
 *      JSON (proves trust fence + host proxy end-to-end).
 *
 * Run: node tests/gui-e2e.mjs   (requires the live dsh web GUI + a reachable
 * Archon server; the scratch one on :3090 is the default target)
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

function secretFromCredentialsYaml(text) {
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/.exec(text)
  if (!m) throw new Error('browser-session secret not found in .credentials.yaml')
  return m[1]
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
function b64urlDecode(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64')
}

const HOME = homedir()
const yaml = readFileSync(join(HOME, '.dsh', '.credentials.yaml'), 'utf8')
const SECRET = b64urlDecode(secretFromCredentialsYaml(yaml))
assert.equal(SECRET.length, 32, 'secret must decode to 32 bytes')

const AUTHORITY = process.env.DSH_GUI_AUTHORITY || '127.0.0.1:3080'
const BASE = 'http://' + AUTHORITY
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({
  version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 24 * 3600 * 1000,
}), 'utf8'))
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac('sha256', SECRET).update(body).digest())}`

const authedFetch = (path) => fetch(BASE + path, { headers: { cookie, accept: '*/*' } })

console.log(`gui-e2e: authenticating to ${AUTHORITY}`)

// 1. Served index carries the dsh-archon client row in its boot graph.
const indexRes = await authedFetch('/')
assert.equal(indexRes.status, 200, 'index serves after auth')
const html = (await indexRes.text()).replaceAll('&amp;', '&')
assert.ok(html.includes('dsh-archon/client.js'), 'index boot graph includes dsh-archon client row')
console.log('  ok: index boot graph includes dsh-archon/client.js')

// 2. Composed combo bundle's dsh-archon segment carries the current code.
const idx = html.indexOf('dsh-archon/client.js')
const urlStart = html.lastIndexOf('/plugins/??', idx)
const urlEnd = html.indexOf('"', idx)
assert.ok(urlStart !== -1 && urlEnd !== -1 && urlStart < urlEnd, 'combo URL found')
const comboUrl = html.slice(urlStart, urlEnd)
const bundleRes = await authedFetch(comboUrl)
assert.equal(bundleRes.status, 200, 'combo bundle serves')
const bundle = await bundleRes.text()
for (const [label, needle] of [
  ['M2 chat toggle', '"Chat"'],
  ['M1 run control', 'Approve'],
  ['launch panel', 'launchWorkflow'],
  ['chat css', 'dsha-chat'],
  ['registration id', '"dsh-archon"'],
  ['null-safe health (round-8 fix)', 'loading server state'],
]) {
  assert.ok(bundle.includes(needle), `served dsh-archon bundle has ${label}`)
  console.log(`  ok: served bundle has ${label}`)
}

// 3. Live relay through the real trust fence.
const healthRes = await authedFetch('/archon/api/health')
assert.equal(healthRes.status, 200, '/archon/api/health status 200')
const health = await healthRes.json()
assert.equal(health.status, 'ok', 'Archon health ok through the relay')
console.log(`  ok: /archon/api/health -> ${health.status} v${health.version} (relay live)`)

console.log('gui-e2e.mjs: OK — dsh-archon live in the GUI end-to-end')
