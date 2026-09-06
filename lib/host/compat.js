/**
 * dsh-archon — Archon version compatibility (host).
 *
 * The plugin declares the Archon server versions it was written against in
 * `package.json` under `archon`: `tested` (the exact version the suites ran
 * against), `min` (inclusive), and `below` (exclusive). Archon's `/api/health`
 * reports the running version; `checkCompatibility` compares the two so the
 * state route, the `archon_status` tool, and the browser can warn about an
 * untested server instead of failing on a renamed field later.
 *
 * Archon follows semantic versioning but is still 0.x, and its 0.10.1 patch
 * release carried a breaking change, so the range is deliberately narrow.
 *
 * @module dsh-archon/host/compat
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/** Declared compatibility: `{ tested, min, below }`, all `major.minor.patch`. */
export const COMPAT = Object.freeze({
  tested: String(manifest.archon?.tested ?? ''),
  min: String(manifest.archon?.min ?? ''),
  below: String(manifest.archon?.below ?? ''),
})

/** Path of the manifest the range was read from (for diagnostics). */
export const MANIFEST_PATH = fileURLToPath(new URL('../../package.json', import.meta.url))

/**
 * Parse `major.minor.patch` with an optional pre-release suffix.
 * @param {string} version
 * @returns {number[] | null} the three numeric parts, or null when malformed.
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two versions numerically.
 * @returns {number} negative when a < b, zero when equal, positive when a > b.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`compareVersions: malformed version (${a}, ${b})`)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * Decide whether a running Archon version is inside the declared range.
 * @param {string} version - the `version` field of Archon's `/api/health`.
 * @param {{ tested: string, min: string, below: string }} [range] - defaults to the manifest.
 * @returns {{ compatible: boolean | null, reason: string, tested: string, min: string, below: string, version: string }}
 *   `compatible` is null when the version is unknown or malformed.
 */
export function checkCompatibility(version, range = COMPAT) {
  const base = { tested: range.tested, min: range.min, below: range.below, version: String(version ?? '') }
  if (!parseVersion(version)) {
    return { ...base, compatible: null, reason: 'Archon did not report a parseable version' }
  }
  if (!parseVersion(range.min) || !parseVersion(range.below)) {
    return { ...base, compatible: null, reason: 'plugin manifest declares no valid archon.min/archon.below range' }
  }
  if (compareVersions(version, range.min) < 0) {
    return { ...base, compatible: false, reason: `Archon ${version} is older than the plugin's minimum ${range.min}` }
  }
  if (compareVersions(version, range.below) >= 0) {
    return { ...base, compatible: false, reason: `Archon ${version} is newer than the range the plugin was tested against (< ${range.below}; tested ${range.tested})` }
  }
  return { ...base, compatible: true, reason: version === range.tested ? `tested against ${range.tested}` : `within the tested range ${range.min} to < ${range.below}` }
}
