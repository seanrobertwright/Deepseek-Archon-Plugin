/**
 * dsh-archon — same-origin relay to the Archon server.
 *
 * Registers one `webServer` prefix route `/archon` that behaves as a thin
 * reverse proxy to the configured Archon base URL (default
 * `http://127.0.0.1:3090`, the v0.10 source `@archon/server` API port). The
 * browser plugin never talks cross-origin: it fetches `/archon/...` and this
 * host half forwards to Archon, then streams the answer back — including
 * long-lived SSE (`/archon/api/stream/...`), which the handler keeps open.
 *
 * Requests are gated by the same trust fence as the DSH `/api` channel:
 * `connection.requestRejection(req)` applies Host/Origin checks + browser
 * session authentication, so an unauthenticated local page cannot drive
 * Archon through this route.
 *
 * @module dsh-archon/host/relay
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

/** Prefix this relay owns on the dsh web server. */
export const RELAY_PREFIX = '/archon'

/** Hop-by-hop headers that must never be forwarded to Archon. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** Request headers that are meaningful to Archon's Hono API. */
const FORWARD_HEADERS = new Set([
  'accept',
  'content-type',
  'authorization',
  'x-archon-user',
  'user-agent',
  'if-none-match',
  'if-modified-since',
])

/** Resolve the Archon base URL from env, with the documented default. */
export function archonBaseUrl(env = process.env) {
  return env.DSH_ARCHON_BASE_URL || env.ARCHON_BASE_URL || 'http://127.0.0.1:3090'
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/**
 * One relay handler for a raw `(IncomingMessage, ServerResponse)` pair.
 * The caller is responsible for the trust/auth gate (see registerRelay).
 * @param req - the browser's request (pathname begins with RELAY_PREFIX).
 * @param res - the response to stream the Archon answer into.
 */
export async function handleRelay(req, res, baseUrl) {
  const requestUrl = new URL(req.url ?? '/', 'http://relay.invalid')
  if (!requestUrl.pathname.startsWith(RELAY_PREFIX)) {
    sendError(res, 400, 'bad relay path')
    return
  }
  const upstreamPath = requestUrl.pathname.slice(RELAY_PREFIX.length) || '/'
  const target = new URL(upstreamPath + requestUrl.search, baseUrl)

  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || !FORWARD_HEADERS.has(name)) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }

  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = transport(
    target,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      // Copy status + headers (drop hop-by-hop from the upstream too).
      const outHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue
        outHeaders[name] = Array.isArray(value) ? value.join(', ') : value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
      upstreamRes.pipe(res)
    },
  )

  // If the browser goes away (tab close, SSE abort), stop talking to Archon.
  res.on('close', () => {
    upstream.destroy()
  })

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    sendError(res, 502, `archon relay error: ${error && error.message ? error.message : String(error)}`)
  })

  // Forward the request body (works for GET without body and POST with one).
  req.pipe(upstream)
}

/**
 * Register the `/archon` prefix route on the dsh web server behind the
 * connection trust/auth gate. Degrades gracefully when services are absent.
 * @param ctx - cordis loader context.
 * @returns a disposer, or null when the relay could not be registered.
 */
export function registerRelay(ctx) {
  const webServer = ctx.get ? ctx.get('webServer') : undefined
  const connection = ctx.get ? ctx.get('connection') : undefined
  if (!webServer || typeof webServer.register !== 'function') return null
  const baseUrl = archonBaseUrl()

  const dispose = webServer.register({
    kind: 'prefix',
    path: RELAY_PREFIX,
    handler: (req, res) => {
      if (connection && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
      }
      void handleRelay(req, res, baseUrl)
    },
  })
  return dispose
}
