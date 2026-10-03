import assert from 'node:assert/strict'
import { releaseReadiness, releaseRegistry, OFFICIAL_REGISTRY, PACKAGE, MIN_AGE_MS } from '../scripts/release-channel.mjs'
const published = Date.parse('2026-10-03T03:50:11.586Z')
const metadata = { time: { '1.2.0': new Date(published).toISOString() }, versions: { '1.2.0': { name: PACKAGE, version: '1.2.0', repository: { url: 'git+https://github.com/ltmroberthk915/dsh-computer-use.git' } } }, 'dist-tags': { latest: '1.1.0' } }
assert.equal(releaseReadiness(metadata, '1.2.0', published + MIN_AGE_MS - 1).ready, false)
assert.equal(releaseReadiness(metadata, '1.2.0', published + MIN_AGE_MS).ready, true)
assert.equal(releaseReadiness(metadata, '1.2.0', published + MIN_AGE_MS).remainingSeconds, 0)
assert.throws(() => releaseReadiness(metadata, '1.2.0-rc.3', published + MIN_AGE_MS), /exact stable/)
assert.throws(() => releaseReadiness({ ...metadata, time: {} }, '1.2.0'), /publication time/)
assert.throws(() => releaseReadiness(metadata, '1.2.0', published - 1), /publication time/)
assert.throws(() => releaseReadiness({ ...metadata, 'dist-tags': { latest: '1.3.0' } }, '1.2.0'), /backwards/)
const foreign = structuredClone(metadata); foreign.versions['1.2.0'].repository.url = 'https://github.com/someone/another-plugin'
assert.throws(() => releaseReadiness(foreign, '1.2.0'), /repository identity/)
assert.throws(() => releaseReadiness({ ...metadata, versions: {} }, '1.2.0'), /missing/)
assert.equal(releaseRegistry('check', ''), OFFICIAL_REGISTRY)
assert.equal(releaseRegistry('check', ' https://registry.npmmirror.com/ '), 'https://registry.npmmirror.com')
assert.equal(releaseRegistry('check', 'https://mirrors.cloud.tencent.com/npm/'), 'https://mirrors.cloud.tencent.com/npm')
assert.equal(releaseRegistry('check', 'https://registry.npmjs.org/'), OFFICIAL_REGISTRY)
assert.equal(releaseRegistry('promote', 'https://registry.npmmirror.com'), OFFICIAL_REGISTRY)
assert.equal(releaseRegistry('promote', 'invalid'), OFFICIAL_REGISTRY)
for (const registry of ['invalid', 'http://registry.npmmirror.com', 'https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#secret']) {
  assert.throws(() => releaseRegistry('check', registry), /CU_REGISTRY/)
}
assert.throws(() => releaseRegistry('publish', ''), /check or promote/)
console.log('ok release-channel: publication-age boundary, metadata/identity/prerelease/downgrade guards, explicit mirror checks and origin-only promotion')
