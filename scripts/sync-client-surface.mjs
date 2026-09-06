/**
 * Embed `lib/archon-surface.js` into `lib/client.js`.
 *
 * The browser bundle cannot import host modules, so the surface module is
 * copied verbatim between the `// >>> archon-surface` and `// <<< archon-surface`
 * markers with each leading `export ` stripped and the block indented to the
 * factory body. Run after editing the surface module; `tests/surface-mirror.mjs`
 * fails until the copy is refreshed.
 *
 *   node scripts/sync-client-surface.mjs          # rewrite lib/client.js
 *   node scripts/sync-client-surface.mjs --check  # exit 1 when out of date
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SURFACE_PATH = join(root, 'lib', 'archon-surface.js')
export const CLIENT_PATH = join(root, 'lib', 'client.js')
export const START = '    // >>> archon-surface (generated from lib/archon-surface.js; run scripts/sync-client-surface.mjs)\n'
export const END = '    // <<< archon-surface\n'

/** The surface module as it must appear inside the browser factory. */
export function embeddedSurface() {
  const source = readFileSync(SURFACE_PATH, 'utf8')
  const body = source
    .replace(/^\/\*\*[\s\S]*?\*\/\n\n/, '') // drop the module doc comment
    .replace(/^export /gm, '')
  return body
    .split('\n')
    .map((line) => (line.length ? '    ' + line : line))
    .join('\n')
}

/** The current client bundle split around the markers. */
export function splitClient() {
  const client = readFileSync(CLIENT_PATH, 'utf8')
  const start = client.indexOf(START)
  const end = client.indexOf(END)
  if (start < 0 || end < 0 || end < start) throw new Error('lib/client.js lacks the archon-surface markers')
  return {
    head: client.slice(0, start + START.length),
    block: client.slice(start + START.length, end),
    tail: client.slice(end),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { head, block, tail } = splitClient()
  const fresh = embeddedSurface()
  if (process.argv.includes('--check')) {
    if (block === fresh) {
      console.log('sync-client-surface: lib/client.js mirror is up to date')
    } else {
      console.error('sync-client-surface: lib/client.js mirror is stale; run node scripts/sync-client-surface.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(CLIENT_PATH, head + fresh + tail)
    console.log('sync-client-surface: embedded lib/archon-surface.js into lib/client.js')
  }
}
