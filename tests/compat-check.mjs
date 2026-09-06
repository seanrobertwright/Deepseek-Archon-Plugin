/**
 * compat-check.mjs — the declared Archon version range and its check (offline).
 */
import assert from 'node:assert/strict'
import { COMPAT, checkCompatibility, compareVersions, parseVersion } from '../lib/host/compat.js'

assert.ok(parseVersion(COMPAT.tested), 'package.json archon.tested is a version')
assert.ok(parseVersion(COMPAT.min), 'package.json archon.min is a version')
assert.ok(parseVersion(COMPAT.below), 'package.json archon.below is a version')
assert.ok(compareVersions(COMPAT.min, COMPAT.below) < 0, 'archon.min is below archon.below')
assert.ok(compareVersions(COMPAT.tested, COMPAT.min) >= 0 && compareVersions(COMPAT.tested, COMPAT.below) < 0,
  'archon.tested lies inside the declared range')

const range = { tested: '0.10.1', min: '0.10.1', below: '0.11.0' }
assert.equal(checkCompatibility('0.10.1', range).compatible, true)
assert.equal(checkCompatibility('0.10.7', range).compatible, true)
assert.equal(checkCompatibility('0.11.0', range).compatible, false, 'next minor is outside the range')
assert.equal(checkCompatibility('0.10.0', range).compatible, false, 'older than min')
assert.equal(checkCompatibility('1.0.0-beta.1', range).compatible, false, 'pre-release of a newer major')
assert.equal(checkCompatibility('', range).compatible, null, 'unknown version is undecided, not incompatible')
assert.equal(checkCompatibility('garbage', range).compatible, null)
assert.match(checkCompatibility('0.11.0', range).reason, /newer/)
assert.match(checkCompatibility('0.9.9', range).reason, /older/)
assert.equal(checkCompatibility('0.10.1', { tested: '', min: '', below: '' }).compatible, null, 'missing range is undecided')

console.log(`  ok: declared range ${COMPAT.min} <= v < ${COMPAT.below} (tested ${COMPAT.tested})`)
console.log('compat-check.mjs: OK')
