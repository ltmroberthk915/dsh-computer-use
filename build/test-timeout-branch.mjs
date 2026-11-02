// The retired turn-end timer is replaced by immediate, guarded automatic release.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lifecycleFixture } from './lifecycle-fixture.mjs'

let checks = 0
for (const kind of ['completed', 'error', undefined]) {
  const f = await lifecycleFixture()
  const result = await f.lifecycle.completeTurn(f.session, kind)
  assert.equal(result.released, true)
  assert.equal(result.conversationContinues, true)
  assert.equal(f.gate.state(), 'ended')
  assert.deepEqual(f.calls, ['calm'])
  checks++
}
for (const kind of ['aborted', 'interrupted']) {
  const f = await lifecycleFixture()
  assert.equal(f.lifecycle.completeTurn(f.session, kind), null)
  assert.deepEqual(f.calls, [])
  checks++
}
{
  const f = await lifecycleFixture({ calm: async () => { throw Error('native release failed') } })
  await assert.rejects(f.lifecycle.completeTurn(f.session), /native release failed/)
  assert.equal(f.gate.state(), 'open')
  checks++
}
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.equal(source.includes('askAtTurnEnd'), false)
assert.equal(source.includes('recommendContinueNow'), false)
assert.equal(source.includes('turn-end-timeout'), false)
assert.match(source, /lifecycle\.completeTurn\(session, kind \|\| 'completed'\)/)
assert.match(source, /legacy setting; ignored — ordinary completion releases computer use automatically/)
checks++
console.log(`ok test-timeout-branch — ${checks} automatic completion cases; no turn-end question, recommendation or timer`)
