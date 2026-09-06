/**
 * dsh-archon — outbound Archon REST client (host side).
 *
 * Used by the agent tools (lib/host/tools.js), the state route, and the
 * contract test; performs real HTTP to the Archon server from inside the dsh
 * process (no browser CORS). Every path comes from lib/archon-surface.js, so
 * this module never spells an Archon route itself.
 *
 * @module dsh-archon/host/archon-client
 */

import { ARCHON_PATHS, createConversationPayload, createdConversationId, launchPayload } from '../archon-surface.js'

/** Resolve the Archon base URL from env, with the documented default. */
export function archonBaseUrl(env = process.env) {
  return env.DSH_ARCHON_BASE_URL || env.ARCHON_BASE_URL || 'http://127.0.0.1:3090'
}

/**
 * One Archon REST call; throws on transport failure or a non-2xx status,
 * resolves the parsed JSON body.
 * @param {string} path - a path from ARCHON_PATHS (relative to `/api`).
 */
export async function archonFetch(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const base = archonBaseUrl()
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}/api${path}`, {
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
    throw new Error(`${method} /api${path} -> ${response.status}: ${detail}`)
  }
  return parsed
}

/** Raw `GET /health` body. */
export async function health() {
  return archonFetch(ARCHON_PATHS.health())
}

/** Raw registered codebases (projects). */
export async function listCodebases() {
  return archonFetch(ARCHON_PATHS.codebases())
}

/** Raw discoverable workflows; cwd optional (falls back to first codebase / bundled). */
export async function listWorkflows(cwd) {
  return archonFetch(ARCHON_PATHS.workflows(cwd))
}

/** Raw recent workflow runs with optional status/limit filters. */
export async function listRuns({ status, limit } = {}) {
  return archonFetch(ARCHON_PATHS.runs({ status, limit }))
}

/** Raw run detail: `{ run, events }`. */
export async function getRun(runId) {
  return archonFetch(ARCHON_PATHS.run(runId))
}

/**
 * Create a web conversation. With `codebaseId` it is bound to a project.
 * Returns the platform conversation id (`web-…`).
 */
export async function createWebConversation(codebaseId) {
  const res = await archonFetch(ARCHON_PATHS.conversations(), { method: 'POST', body: createConversationPayload(codebaseId) })
  const id = createdConversationId(res)
  if (!id) throw new Error('POST /api/conversations returned no conversationId')
  return id
}

/**
 * Launch a workflow run into a web conversation. `conversationId` is the
 * platform id; when omitted one is created (optionally bound to codebaseId).
 * Returns the dispatch response ({ accepted, status }).
 */
export async function launchRun(workflowName, { conversationId, codebaseId, message, inputs } = {}) {
  let convId = conversationId
  if (!convId) convId = await createWebConversation(codebaseId)
  const body = launchPayload(convId, message || `Run ${workflowName}`)
  if (inputs !== undefined) body.inputs = inputs
  return archonFetch(ARCHON_PATHS.workflowRun(workflowName), { method: 'POST', body })
}

/** One run-control verb: approve | reject | resume | cancel | abandon. */
export async function runControl(runId, verb, payload = {}) {
  return archonFetch(ARCHON_PATHS.runControl(runId, verb), { method: 'POST', body: payload })
}
