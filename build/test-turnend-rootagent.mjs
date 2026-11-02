// Ownership still decides automatic release; no turn-end question routing remains.
import assert from 'node:assert/strict'
import { lifecycleFixture } from './lifecycle-fixture.mjs'

let checks = 0
{
  const f = await lifecycleFixture()
  assert.equal(f.lifecycle.completeTurn({ id: 'other-session' }), null)
  assert.equal(f.lifecycle.idle({ id: 'child-agent', session: f.session }), null)
  await assert.rejects(f.lifecycle.release({ session: f.session, agent: { id: 'child-agent' } }), /OWNER_CHANGED/)
  assert.equal(f.gate.state(), 'open'); assert.deepEqual(f.calls, [])
  checks++
}
for (const state of ['paused', 'asking']) {
  const f = await lifecycleFixture(); f.gate.mark(state)
  assert.equal(f.lifecycle.completeTurn(f.session), null)
  assert.equal(f.lifecycle.idle(f.agent), null)
  assert.equal((await f.lifecycle.release(f.exec)).released, false)
  assert.equal(f.gate.state(), state); assert.deepEqual(f.calls, [])
  checks++
}
{
  const f = await lifecycleFixture(); f.cu.stopped = true
  assert.equal((await f.lifecycle.release(f.exec)).released, false)
  assert.equal(f.lifecycle.completeTurn(f.session), null)
  assert.deepEqual(f.calls, []); checks++
}
{
  const f = await lifecycleFixture(); f.setInFlight(1)
  assert.equal(f.lifecycle.completeTurn(f.session), null)
  f.setInFlight(2)
  assert.equal((await f.lifecycle.release(f.exec)).released, false)
  assert.deepEqual(f.calls, []); checks++
}
for (const state of ['paused', 'asking', 'ended']) {
  const f = await lifecycleFixture({ calm: async ({ gate }) => { gate.mark(state); return { released: state === 'ended' } } })
  assert.equal((await f.lifecycle.release(f.exec)).released, false)
  assert.equal(f.gate.state(), state)
  checks++
}
{
  const f = await lifecycleFixture()
  assert.equal((await f.lifecycle.idle(f.agent)).released, true)
  assert.equal(f.lifecycle.idle(f.agent), null)
  assert.deepEqual(f.calls, ['calm']); checks++
}
for (const event of ['turn-end', 'idle']) {
  const f = await lifecycleFixture(); f.setInFlight(1)
  assert.equal(event === 'turn-end' ? f.lifecycle.completeTurn(f.session) : f.lifecycle.idle(f.agent), null)
  assert.equal(f.gate.state(), 'open'); assert.deepEqual(f.calls, [])
  f.setInFlight(0)
  assert.equal((await f.lifecycle.settle()).released, true)
  assert.deepEqual(f.calls, ['calm']); checks++
}
{
  const f = await lifecycleFixture(); f.setInFlight(1)
  f.lifecycle.completeTurn(f.session)
  f.gate.noteTurnStart(f.session)
  f.setInFlight(0)
  assert.equal(f.lifecycle.settle(), null)
  assert.deepEqual(f.calls, []); assert.equal(f.gate.state(), 'open'); checks++
}
{
  const f = await lifecycleFixture(); f.cu.cooperation.active = true
  assert.equal(f.lifecycle.completeTurn(f.session), null)
  assert.deepEqual(f.calls, [])
  f.cu.cooperation.active = false
  assert.equal((await f.lifecycle.settle()).released, true)
  assert.deepEqual(f.calls, ['calm']); checks++
}
{
  const f = await lifecycleFixture({ beforeCalmDispatch: async ({ gate }) => {
    gate.mark('ended', { why: 'new Q before cleanup dispatch' })
    const newer = gate.claim({ session: 'new-session', agent: { id: 'new-agent' } })
    await gate.open(newer, async () => ({}))
  } })
  await assert.rejects(f.lifecycle.release(f.exec), error => error.code === 'COMPUTER_OWNER_CHANGED')
  assert.deepEqual(f.calls, [])
  assert.equal(f.gate.ownerSessionKey(), 'new-session'); assert.equal(f.gate.state(), 'open'); checks++
}
console.log(`ok test-turnend-rootagent — ${checks} owner, pause/question, in-flight and release-race cases`)
