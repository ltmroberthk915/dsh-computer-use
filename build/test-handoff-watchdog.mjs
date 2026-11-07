// Issue #3 problem 2: a handoff that stops making progress must not consume the
// cooperative 3,600,000 ms tool deadline. These are JS-only cases with a fake
// worker; no native input or desktop is touched.
import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { handoffResult } from '../lib/continuation.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const handoff = (cu, overrides = {}) => cu.onLine(JSON.stringify({
  event: 'handoff',
  cooperation: { phase: 'waiting', active: true, revision: cu.cooperation.revision + 1, inputEpoch: cu.cooperation.inputEpoch + 1, heldCount: 0, quietRemainingMs: 0, ...overrides },
}))
const pending = () => new ComputerUse({ workerExe: 'X:/NOT-STARTED.exe' })

// 1. Silent active handoff: no idle event, ping stays active -> bounded timeout.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 150
  cu.handoffRecoveryMs = 40
  handoff(cu)
  cu.call = async () => ({ pong: true, cooperation: { phase: 'waiting', active: true, revision: 1, inputEpoch: 1, heldCount: 0, quietRemainingMs: 0 } })
  const started = Date.now()
  const error = await cu.waitForHuman().then(() => null, e => e)
  assert.equal(error?.code, 'HANDOFF_WAIT_TIMEOUT')
  assert.ok(Date.now() - started < 1500, 'watchdog must end the wait promptly')
  assert.ok(error.handoffWait && error.handoffWait.phase === 'timeout', 'timeout must be recorded')
  assert.equal(error.continuation?.required, true, 'timeout must carry a continuation checkpoint')
  assert.equal(error.taskStatus, 'continuing')
  assert.equal(handoffResult(error)?.status, 'continuation-required', 'tool/MCP layer must surface the timeout as a continuation')
  for (const event of ['handoff', 'panic', 'ask', 'exit', 'dead', 'input-cancel']) assert.equal(cu.listenerCount(event), 0, `listener ${event} must be removed`)
}

// 2. The worker lost the idle event but answers ping with idle: recover it.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 500
  cu.handoffRecoveryMs = 40
  handoff(cu)
  cu.call = async () => ({ pong: true, cooperation: { phase: 'idle', active: false, revision: 2, inputEpoch: 2, heldCount: 0, quietRemainingMs: 0 } })
  const started = Date.now()
  await cu.waitForHuman()
  assert.equal(cu.cooperation.active, false)
  assert.ok(Date.now() - started < 1500, 'recovery ping must resolve the wait')
  for (const event of ['handoff', 'panic', 'ask', 'exit', 'dead', 'input-cancel']) assert.equal(cu.listenerCount(event), 0, `listener ${event} must be removed`)
}

// 3. Continued physical input keeps the wait alive; stopping it lets the deadline fire.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 200
  cu.handoffRecoveryMs = 500
  handoff(cu)
  cu.call = async () => ({ pong: true, cooperation: { phase: 'waiting', active: true, revision: 1, inputEpoch: 1, heldCount: 0, quietRemainingMs: 0 } })
  let settled = false
  let error = null
  const wait = cu.waitForHuman().then(() => { settled = true }, e => { settled = true; error = e })
  const timer = setInterval(() => handoff(cu), 50)
  await new Promise(resolve => setTimeout(resolve, 350))
  clearInterval(timer)
  assert.equal(settled, false, 'active input must keep the wait alive past the inactivity limit')
  await wait
  assert.equal(error?.code, 'HANDOFF_WAIT_TIMEOUT')
  assert.equal(settled, true)
}

// 4. A genuinely held key is not a stalled handoff; it must not be cut off by the
//    normal inactivity window, but a stale held counter must still have a hard cap.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 120
  cu.handoffRecoveryMs = 500
  handoff(cu, { heldCount: 1 })
  cu.call = async () => ({ pong: true, cooperation: { phase: 'waiting', active: true, revision: 1, inputEpoch: 1, heldCount: 1, quietRemainingMs: 3000 } })
  let settled = false
  const wait = cu.waitForHuman().then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 320))
  assert.equal(settled, false, 'a held key must not hit the normal inactivity timeout')
  cu.onLine(JSON.stringify({ event: 'handoff', cooperation: { phase: 'idle', active: false, revision: 2, inputEpoch: 2, heldCount: 0, quietRemainingMs: 0 } }))
  await wait
  assert.equal(settled, true)
}

// 5. Five held windows is a hard cap: a stale heldCount cannot wait out the
//    cooperative 3,600,000 ms deadline.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 60
  cu.handoffRecoveryMs = 5000
  handoff(cu, { heldCount: 1 })
  cu.call = async () => ({ pong: true, cooperation: { phase: 'waiting', active: true, revision: 1, inputEpoch: 1, heldCount: 1, quietRemainingMs: 3000 } })
  const error = await cu.waitForHuman().then(() => null, e => e)
  assert.equal(error?.code, 'HANDOFF_HELD_TIMEOUT')
  assert.equal(error.continuation?.required, true)
  assert.equal(handoffResult(error)?.status, 'continuation-required')
}

// 6. A timeout that happens AFTER HUMAN_YIELD (the worker already interrupted an
//    in-flight actuation) must survive actuate()'s error rewrap as a continuation.
{
  const cu = pending()
  cu.handoffWaitLimitMs = 80
  cu.handoffRecoveryMs = 1000
  cu.call = async (op) => {
    if (op === 'key') {
      handoff(cu)
      throw Object.assign(new Error('physical input owns the desktop'), { code: 'HUMAN_YIELD', outcome: 'not-dispatched' })
    }
    if (op === 'ping') return { pong: true, cooperation: { phase: 'waiting', active: true, revision: 1, inputEpoch: 1, heldCount: 0, quietRemainingMs: 0 } }
    throw new Error('unexpected call ' + op)
  }
  const error = await cu.actuate('key', { combo: 'enter' }).then(() => null, e => e)
  assert.equal(error?.code, 'HANDOFF_WAIT_TIMEOUT')
  assert.equal(error.continuation?.required, true, 'mid-yield timeout must keep its continuation after actuate() rewrap')
  assert.equal(error.taskStatus, 'continuing')
  assert.equal(handoffResult(error)?.status, 'continuation-required')
}

await tick()
console.log('ok test-handoff-watchdog — silent handoff times out, missed idle recovers by ping, active input re-arms the deadline, held input is capped')
