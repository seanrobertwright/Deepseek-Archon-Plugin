/**
 * dsh-archon — outbound Archon REST client (host side).
 *
 * Used by the agent tools (lib/host/tools.js) and a possible host controller;
 * performs real HTTP to the Archon server from inside the dsh process (no
 * browser CORS). Mirrors the endpoints the bundled Archon Web UI uses
 * (see docs/research/02 for the full surface).
 *
 * @module dsh-archon/host/archon-client
 */

/** Resolve the Archon base URL from env, with the documented default. */
export function archonBaseUrl(env = process.env) {
  return env.DSH_ARCHON_BASE_URL || env.ARCHON_BASE_URL || 'http://127.0.0.1:3090'
}

/** One Archon REST call; throws on transport failure, resolves parsed JSON. */
export async function archonFetch(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const base = archonBaseUrl()
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let parsed = null
  const text = await response.text()
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' && 'error' in parsed
      ? parsed.error
      : typeof parsed === 'string' ? parsed : `http ${response.status}`
    throw new Error(`${method} ${path} -> ${response.status}: ${detail}`)
  }
  return parsed
}

/** Server health + version + platforms. */
export async function health() {
  return archonFetch('/api/health')
}

/** Registered codebases (projects). */
export async function listCodebases() {
  return archonFetch('/api/codebases')
}

/** Discoverable workflows; cwd optional (falls back to first codebase / bundled). */
export async function listWorkflows(cwd) {
  const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
  return archonFetch('/api/workflows' + q)
}

/** Recent workflow runs with optional status/limit filters. */
export async function listRuns({ status, limit = 20 } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (status) params.set('status', status)
  return archonFetch('/api/workflows/runs?' + params.toString())
}

/** One run detail (with events when available). */
export async function getRun(runId) {
  return archonFetch('/api/workflows/runs/' + encodeURIComponent(runId))
}

/**
 * Create a web conversation. With `codebaseId` it is bound to a project.
 * Returns the platform conversation id (`web-…`).
 */
export async function createWebConversation(codebaseId) {
  const body = codebaseId ? { codebaseId } : {}
  const res = await archonFetch('/api/conversations', { method: 'POST', body })
  return res.conversationId
}

/**
 * Launch a workflow run into a web conversation. `conversationId` is the
 * platform id; when omitted one is created (optionally bound to codebaseId).
 * Returns the dispatch response ({ accepted, status }).
 */
export async function launchRun(workflowName, { conversationId, codebaseId, message, inputs } = {}) {
  let convId = conversationId
  if (!convId) convId = await createWebConversation(codebaseId)
  const body = { conversationId: convId, message: message || `Run ${workflowName}` }
  if (inputs !== undefined) body.inputs = inputs
  return archonFetch('/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
    method: 'POST',
    body,
  })
}

/** One run-control verb: approve | reject | resume | cancel | abandon | respond. */
export async function runControl(runId, verb, payload = {}) {
  return archonFetch('/api/workflows/runs/' + encodeURIComponent(runId) + '/' + verb, {
    method: 'POST',
    body: payload,
  })
}
