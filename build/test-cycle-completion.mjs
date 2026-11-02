import assert from 'node:assert/strict'
import { createCycleGate } from '../lib/cycle.js'

let passed = 0
const fresh = async () => {
  const gate = createCycleGate()
  gate.noteTurnStart('chat')
  const claim = gate.claim({ session: 'chat', agent: 'agent' })
  await gate.open(claim, () => ({ opened: true }))
  return { gate, claim, id: gate.snapshot().id }
}
{
  const { gate, claim, id } = await fresh()
  const token = gate.beginCompletion(claim, id)
  assert.equal(gate.state(), 'releasing')
  assert.throws(() => gate.open(claim, () => {}), e => e.code === 'COMPUTER_CYCLE_RELEASING')
  assert.throws(() => gate.assertOwnership(claim, id), e => e.code === 'COMPUTER_OWNER_CHANGED')
  assert.equal(gate.finishCompletion(token), true)
  assert.equal(gate.state(), 'ended')
  assert.equal(gate.finishCompletion(token), false)
  let reopened = 0
  await gate.open(claim, () => { reopened++; return { opened: true } })
  assert.equal(reopened, 1)
  assert.notEqual(gate.snapshot().id, id)
  assert.throws(() => gate.assertOwnership(claim, id), e => e.code === 'COMPUTER_OWNER_CHANGED')
  gate.assertOwnership(claim, gate.snapshot().id)
  passed++
}
{
  const { gate, claim, id } = await fresh()
  const foreign = gate.claim({ session: 'chat', agent: 'subagent' })
  assert.throws(() => gate.beginCompletion(foreign, id), e => e.code === 'COMPUTER_OWNER_CHANGED')
  gate.assertOwnership(claim, id); passed++
}
for (const state of ['paused', 'asking']) {
  const { gate, claim, id } = await fresh()
  gate.mark(state)
  assert.throws(() => gate.beginCompletion(claim, id), e => e.code === 'COMPUTER_CYCLE_PAUSED')
  assert.equal(gate.state(), state); passed++
}
{
  const { gate, claim, id } = await fresh()
  const token = gate.beginCompletion(claim, id)
  gate.mark('ended', { why: 'physical Q' })
  assert.equal(gate.finishCompletion(token), false)
  assert.equal(gate.cancelCompletion(token), false)
  let reopened = 0
  await gate.open(claim, () => { reopened++ })
  assert.equal(reopened, 0)
  assert.equal(gate.state(), 'ended'); passed++
}
{
  const { gate, claim, id } = await fresh()
  const token = gate.beginCompletion(claim, id)
  gate.mark('paused', { why: 'physical Ctrl+Esc during native calm' })
  assert.equal(gate.finishCompletion(token), false)
  assert.equal(gate.cancelCompletion(token), false)
  assert.equal(gate.state(), 'paused'); passed++
}
{
  const { gate, claim, id } = await fresh()
  const token = gate.beginCompletion(claim, id)
  assert.equal(gate.cancelCompletion(token), true)
  gate.assertOwnership(claim, id)
  assert.equal(gate.finishCompletion(token), false); passed++
}
console.log(`ok test-cycle-completion — ${passed} cases: graceful same-turn reacquisition, pending-call rejection, foreign owner, pause/ask, Q during release and failed native cleanup`)
