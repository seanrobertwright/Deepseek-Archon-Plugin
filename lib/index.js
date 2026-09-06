/**
 * dsh-archon — host half.
 *
 * Wires the plugin for the Web profile:
 *  - a same-origin relay `ctx.webServer.register({kind:'prefix', path:'/archon'})`
 *    that reverse-proxies the Archon server's REST + SSE under the dsh origin,
 *    gated by the connection trust/auth fence (see lib/host/relay.js);
 *  - an authenticated `/api/dsh-archon/state` GET route (connection fetch-route
 *    surface) the browser uses for a quick reachability/config probe; it also
 *    reports whether the running Archon version is inside the range declared
 *    in package.json `archon` (lib/host/compat.js).
 *
 * The browser plugin therefore never talks cross-origin: it calls `/archon/*`
 * (REST and long-lived SSE) and `/api/dsh-archon/state`, both same-origin on
 * the dsh web server, with Archon kept as the outbound target of the host.
 *
 * @module dsh-archon
 */

import { registerRelay, archonBaseUrl } from './host/relay.js'
import { registerTools } from './host/tools.js'
import { ARCHON_PATHS, normalizeHealth } from './archon-surface.js'
import { checkCompatibility } from './host/compat.js'

const STATE_PATH = '/api/dsh-archon/state'

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export const name = 'archon'
/** Wait for the web surfaces that carry our HTTP routes before applying. */
export const inject = ['connection', 'webServer']

/**
 * Plugin entry.
 * @param ctx - loader context.
 */
export function apply(ctx) {
  const logger = (typeof ctx.logger !== 'undefined' && ctx.logger) || console
  const connection = ctx.get('connection')

  // Reachability/config probe for the browser console.
  if (connection && typeof connection.fetch === 'object' && typeof connection.fetch.register === 'function') {
    const routeDisposers = []
    const registerRoute = (route) => {
      const dispose = connection.fetch.register(route)
      routeDisposers.push(dispose)
    }
    ctx.effect(() => () => {
      for (const dispose of routeDisposers) {
        try {
          void Promise.resolve(dispose()).catch(() => {})
        } catch { /* already gone */ }
      }
    }, 'dsh-archon: fetch routes')

    registerRoute({
      path: STATE_PATH,
      methods: ['GET', 'HEAD'],
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 204 })
        const base = archonBaseUrl()
        let reachable = false
        let archon = null
        try {
          const probe = await fetch(`${base}/api${ARCHON_PATHS.health()}`, { signal: AbortSignal.timeout(3000) })
          reachable = probe.ok
          if (reachable) {
            try { archon = await probe.json() } catch { archon = null }
          } else {
            archon = `http ${probe.status}`
          }
        } catch (error) {
          archon = error && error.message ? String(error.message) : String(error)
        }
        const version = reachable && archon && typeof archon === 'object' ? normalizeHealth(archon).version : ''
        const compat = checkCompatibility(version)
        return json(200, { ok: true, archonBaseUrl: base, reachable, archon, compat })
      },
    })
  } else if (typeof logger.warn === 'function') {
    logger.warn('[dsh-archon] connection service absent; state probe disabled')
  }

  // The main surface: same-origin relay to Archon REST/SSE.
  try {
    const dispose = registerRelay(ctx)
    if (dispose === null) {
      logger.warn('[dsh-archon] webServer service absent; /archon relay disabled')
    } else {
      ctx.effect(() => dispose, 'dsh-archon: /archon relay route')
    }
  } catch (error) {
    logger.warn(`[dsh-archon] relay registration failed: ${error && error.message ? error.message : error}`)
  }

  // Agent tools: let the DSH model inspect/start Archon from normal chat.
  // These run inside the dsh process against Archon's REST API.
  try {
    registerTools(ctx)
  } catch (error) {
    logger.warn(`[dsh-archon] tools registration failed: ${error && error.message ? error.message : error}`)
  }
}
