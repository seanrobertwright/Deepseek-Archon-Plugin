/**
 * Embed the plugin's shared modules into `lib/client.js`.
 *
 * The browser bundle cannot import host modules, so each shared module is
 * copied verbatim between a `// >>> <block>` / `// <<< <block>` marker pair with
 * each leading `export ` stripped and the body indented to the factory. One
 * block is synced today — `archon-surface` (lib/archon-surface.js); `BLOCKS`
 * takes more. Run after editing the module; `tests/surface-mirror.mjs` fails
 * until the copy is refreshed.
 *
 *   node scripts/sync-client-surface.mjs          # rewrite lib/client.js
 *   node scripts/sync-client-surface.mjs --check  # exit 1 when out of date
 *
 * Line endings: every file is read with CRLF folded to LF before the markers are
 * matched, and `lib/client.js` is written back with LF. The fold is defensive —
 * regardless of whether the checkout produced LF or CRLF files (on Windows, git
 * may check out either depending on the user's `core.autocrlf` setting, which
 * this repo does not force), sync and check behave the same instead of failing
 * to find the markers at all.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SURFACE_PATH = join(root, 'lib', 'archon-surface.js')
export const CLIENT_PATH = join(root, 'lib', 'client.js')
export const START = '    // >>> archon-surface (generated from lib/archon-surface.js; run scripts/sync-client-surface.mjs)\n'
export const END = '    // <<< archon-surface\n'

/** Every embedded block, in the order they appear in the bundle. */
export const BLOCKS = [
  { name: 'archon-surface', path: SURFACE_PATH, start: START, end: END },
]

/** Read a source file with its line endings folded to LF. */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** One module as it must appear inside the browser factory. */
export function embeddedBlock(path) {
  const body = readText(path)
    .replace(/^\/\*\*[\s\S]*?\*\/\n\n/, '') // drop the module doc comment
    .replace(/^export /gm, '')
  return body
    .split('\n')
    .map((line) => (line.length ? '    ' + line : line))
    .join('\n')
}

/** The surface module as it must appear inside the browser factory. */
export function embeddedSurface() {
  return embeddedBlock(SURFACE_PATH)
}


/**
 * The client bundle split around one block's markers. Defaults to the
 * archon-surface block so existing callers keep working. The text is folded to
 * LF here as well as in `readText`, so a caller handing in CRLF text (a test
 * probe, or a bundle read some other way) splits identically.
 */
export function splitClient(start = START, end = END, text = readText(CLIENT_PATH)) {
  const client = text.replace(/\r\n/g, '\n')
  const startAt = client.indexOf(start)
  const endAt = client.indexOf(end)
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`lib/client.js lacks the ${start.trim()} markers`)
  }
  return {
    head: client.slice(0, startAt + start.length),
    block: client.slice(startAt + start.length, endAt),
    tail: client.slice(endAt),
  }
}

/** Every block's embedded copy paired with the module's current text. */
export function blockStates(client = readText(CLIENT_PATH)) {
  return BLOCKS.map((block) => ({
    name: block.name,
    current: splitClient(block.start, block.end, client).block,
    fresh: embeddedBlock(block.path),
  }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = blockStates().filter((state) => state.current !== state.fresh)
    if (stale.length === 0) {
      console.log('sync-client-surface: lib/client.js mirrors are up to date')
    } else {
      const names = stale.map((state) => state.name).join(', ')
      console.error(`sync-client-surface: lib/client.js is stale (${names}); run node scripts/sync-client-surface.mjs`)
      process.exit(1)
    }
  } else {
    let client = readText(CLIENT_PATH)
    for (const block of BLOCKS) {
      const { head, tail } = splitClient(block.start, block.end, client)
      client = head + embeddedBlock(block.path) + tail
    }
    writeFileSync(CLIENT_PATH, client)
    console.log(`sync-client-surface: embedded ${BLOCKS.map((b) => b.name).join(' + ')} into lib/client.js`)
  }
}
