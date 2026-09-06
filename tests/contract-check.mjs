/**
 * contract-check.mjs — consumer contract test against a live Archon server.
 *
 * Archon serves its OpenAPI document at `/api/openapi.json`. This test reduces
 * that document to the operations the plugin calls (lib/archon-surface.js
 * `ENDPOINTS`): for each, the response status codes, the request body
 * property names, and the response body shape (property names and types, two
 * levels deep, array items included). The reduction is committed as
 * `tests/contract/archon-openapi.subset.json`.
 *
 *   node tests/contract-check.mjs            # diff live subset against the snapshot
 *   node tests/contract-check.mjs --update   # re-record the snapshot
 *
 * On a new Archon release, run the check first: every added, removed, or
 * retyped field the plugin depends on is printed before any code changes.
 * Reads DSH_ARCHON_BASE_URL (default http://127.0.0.1:3090).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ENDPOINTS } from '../lib/archon-surface.js'
import { archonBaseUrl } from '../lib/host/archon-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = join(here, 'contract', 'archon-openapi.subset.json')
const MAX_DEPTH = 2

function deref(spec, schema, depth = 0) {
  if (!schema || depth > 8) return schema
  if (schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, '').split('/')
    let target = spec
    for (const part of parts) target = target?.[part]
    return deref(spec, target, depth + 1)
  }
  return schema
}

/** Property names and types, `MAX_DEPTH` levels deep. */
function shape(spec, schema, depth = 0) {
  const s = deref(spec, schema)
  if (!s) return '?'
  if (s.oneOf || s.anyOf) return { oneOf: (s.oneOf || s.anyOf).map((x) => shape(spec, x, depth + 1)) }
  if (s.type === 'array') return depth < MAX_DEPTH ? [shape(spec, s.items, depth + 1)] : 'array'
  if (s.type === 'object' || s.properties) {
    if (depth >= MAX_DEPTH) return 'object'
    const out = {}
    for (const [key, value] of Object.entries(s.properties || {}).sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = shape(spec, value, depth + 1)
    }
    if (Array.isArray(s.required) && s.required.length) out.__required = [...s.required].sort()
    return out
  }
  return s.type || '?'
}

/** The plugin's subset of a full OpenAPI document. */
export function reduce(spec) {
  const operations = {}
  const missing = []
  for (const endpoint of ENDPOINTS) {
    const op = spec.paths?.[endpoint.path]?.[endpoint.method]
    const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`
    if (!op) { missing.push(key); continue }
    const responses = {}
    for (const [status, response] of Object.entries(op.responses || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const json = response?.content?.['application/json']
      responses[status] = json ? shape(spec, json.schema) : 'no-json'
    }
    const body = op.requestBody?.content?.['application/json']
    operations[key] = {
      use: endpoint.use,
      request: body ? shape(spec, body.schema) : null,
      responses,
    }
  }
  return { openapi: spec.openapi, title: spec.info?.title, operations, missing }
}

/** Flat `path -> value` map for a readable diff. */
function flatten(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value
  }
  return out
}

export function diff(expected, actual) {
  const a = flatten(expected)
  const b = flatten(actual)
  const lines = []
  for (const key of Object.keys(a)) {
    if (!(key in b)) lines.push(`- ${key}: ${JSON.stringify(a[key])}`)
    else if (a[key] !== b[key]) lines.push(`~ ${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`)
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) lines.push(`+ ${key}: ${JSON.stringify(b[key])}`)
  }
  return lines
}

async function main() {
  const base = archonBaseUrl()
  const [specResponse, healthResponse] = await Promise.all([
    fetch(`${base}/api/openapi.json`, { signal: AbortSignal.timeout(8000) }),
    fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) }),
  ])
  if (!specResponse.ok) throw new Error(`GET ${base}/api/openapi.json -> ${specResponse.status}`)
  const spec = await specResponse.json()
  const health = healthResponse.ok ? await healthResponse.json() : {}
  const live = { archonVersion: health.version ?? 'unknown', ...reduce(spec) }

  if (live.missing.length) {
    console.error('contract-check: operations the plugin calls are absent from the live spec:')
    for (const key of live.missing) console.error(`  ${key}`)
  }

  if (process.argv.includes('--update')) {
    mkdirSync(dirname(SNAPSHOT), { recursive: true })
    writeFileSync(SNAPSHOT, JSON.stringify(live, null, 2) + '\n')
    console.log(`contract-check: recorded ${Object.keys(live.operations).length} operations from Archon ${live.archonVersion} into ${SNAPSHOT}`)
    process.exit(live.missing.length ? 1 : 0)
  }

  let expected
  try {
    expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  } catch {
    console.error(`contract-check: no snapshot at ${SNAPSHOT}; run with --update against a known-good Archon`)
    process.exit(1)
  }
  const { archonVersion: recordedVersion, ...expectedRest } = expected
  const { archonVersion: liveVersion, ...liveRest } = live
  const changes = diff(expectedRest, liveRest)
  if (changes.length === 0 && live.missing.length === 0) {
    console.log(`contract-check.mjs: OK — ${Object.keys(live.operations).length} operations unchanged (snapshot from Archon ${recordedVersion}, live ${liveVersion})`)
    return
  }
  console.error(`contract-check.mjs: FAIL — Archon ${liveVersion} differs from the snapshot recorded against ${recordedVersion}:`)
  for (const line of changes) console.error(`  ${line}`)
  console.error('Update lib/archon-surface.js for the change, then re-record with --update.')
  process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`contract-check.mjs: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
}
