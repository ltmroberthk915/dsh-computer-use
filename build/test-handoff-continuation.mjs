import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'

let checks = 0
const tick = () => new Promise(resolve => setImmediate(resolve))
const event = (cu, phase, revision = 1) => cu.onLine(JSON.stringify({ event: 'handoff', cooperation: { phase, active: phase !== 'idle', revision } }))
const fresh = () => new ComputerUse({ workerExe: 'X:/NOT-STARTED.exe' })
function fixture (cu, hooks = {}, ensureCycle) {
  const definitions = new Map(), controller = new AbortController()
  registerTools({ ctx: { tools: { register: def => definitions.set(def.name, def) } }, cu,
    config: { actionFeedback: false }, hooks, ensureCycle, defineTool: def => def, dataDir: { root: 'X:/NOT-USED', shots: 'X:/NOT-USED' },
    snapshotPath: () => { throw Error('handoff must not trigger a screenshot') } })
  const run = (name, args = {}) => definitions.get(name).execute(args, { name, arguments: args, signal: controller.signal })
  return { definitions, controller, run }
}
function continuation (result, outcome) {
  assert.equal(result.status, 'continuation-required')
  assert.equal(result.taskStatus, 'continuing')
  assert.equal(result.transient, true)
  assert.equal(result.continuation.required, true)
  assert.equal(result.continuation.handback, 'received')
  assert.equal(result.continuation.replayInterruptedInput, false)
  assert.match(result.continuation.instruction, /MUST.*continue the original authorized task/)
  if (outcome) assert.equal(result.outcome, outcome)
  checks++
}

// A call already waiting for handback stays pending, then returns a normal tool checkpoint.
{
  const cu = fresh(), f = fixture(cu), calls = []
  cu.call = async op => { calls.push(op); return { ok: true } }
  event(cu, 'waiting')
  const p = f.run('computer_key', { combo: 'enter' })
  let settled = false; p.finally(() => { settled = true })
  await tick(); assert.equal(settled, false); assert.deepEqual(calls, [])
  event(cu, 'idle')
  const result = await p
  continuation(result, 'not-dispatched')
  const rendered = f.definitions.get('computer_key').output.render({}, result)
  assert.match(JSON.stringify(rendered), /continuation-required/)
  assert.deepEqual(calls, [])
  // The same tool session remains usable after the fresh observation.
  await cu.screenState()
  await f.run('computer_key', { combo: 'enter' })
  assert.equal(calls.filter(op => op === 'key').length, 1)
  assert.equal(cu.stopped, false); assert.equal(cu.exited, false)
}

// Mid-operation input effects are unknown; no automatic replay is allowed.
for (const outcome of ['unknown', 'not-dispatched']) {
  const cu = fresh(), f = fixture(cu), calls = []
  cu.call = async op => {
    calls.push(op)
    if (op === 'ping') { event(cu, 'waiting'); return { pong: true } }
    throw Object.assign(Error('native interrupted input'), { code: 'HUMAN_YIELD', outcome, requestId: 17 })
  }
  const p = f.run('computer_key', { combo: 'enter' })
  await tick(); assert.deepEqual(calls, ['key', 'ping'])
  event(cu, 'idle')
  const result = await p
  continuation(result, outcome)
  assert.equal(result.continuation.interruptedOperation, 'key')
  assert.equal(result.continuation.requestId, 17)
  assert.deepEqual(calls, ['key', 'ping'])
}

// Refocusing can inject input, so it follows the same local handoff wait as keyboard actions.
{
  const cu = fresh(), calls = []
  cu.call = async (op, args = {}) => {
    calls.push([op, args.refocus])
    if (op === 'ping') { event(cu, 'waiting'); return { pong: true } }
    if (args.refocus) throw Object.assign(Error('refocus interrupted'), { code: 'HUMAN_YIELD', outcome: 'unknown' })
    return { focused: true }
  }
  assert.equal((await cu.focus({ refocus: false })).focused, true)
  const pending = cu.focus({ refocus: true }); pending.catch(() => {})
  await tick()
  assert.equal(cu.cooperation.active, true)
  event(cu, 'idle')
  await assert.rejects(pending, error => error.code === 'HUMAN_REOBSERVE' && error.continuation.required && error.outcome === 'unknown')
  assert.deepEqual(calls, [['focus', false], ['focus', true], ['ping', undefined]])
  checks++
}

// Batches retain successful prefix receipts and an exact resume index, with no later writes.
{
  const cu = fresh(), f = fixture(cu), calls = []
  cu.call = async op => {
    calls.push(op)
    if (op === 'ping') { event(cu, 'waiting'); return { pong: true } }
    if (op === 'key') throw Object.assign(Error('native interrupted input'), { code: 'HUMAN_YIELD', outcome: 'unknown', requestId: 19 })
    return { ok: true, activated: true }
  }
  const p = f.run('computer_batch', { shot: 'never', actions: [
    { tool: 'computer_window', args: { hwnd: 1 } },
    { tool: 'computer_key', args: { combo: 'enter' } },
    { tool: 'computer_type', args: { text: 'must not replay' } },
  ] })
  await tick(); event(cu, 'idle')
  const result = await p
  continuation(result)
  assert.equal(result.continuation.resumeFromActionIndex, 1)
  assert.equal(result.actions[0].ok, true)
  continuation(result.actions[1], 'unknown')
  assert.equal(result.actions[2].status, 'deferred')
  assert.equal(result.actions[2].outcome, 'not-dispatched')
  assert.equal(result.actions[2].error, undefined)
  assert.deepEqual(calls, ['activate', 'key', 'ping'])
  assert.match(JSON.stringify(f.definitions.get('computer_batch').output.render({}, result)), /resumeFromActionIndex/)
}

// Explicit cancellation outranks continuation, without misreporting an already-started write.
{
  const cu = fresh(), f = fixture(cu)
  cu.call = async op => {
    if (op === 'ping') { event(cu, 'waiting'); return { pong: true } }
    throw Object.assign(Error('native interrupted input'), { code: 'HUMAN_YIELD', outcome: 'unknown' })
  }
  const p = f.run('computer_key', { combo: 'enter' }); p.catch(() => {})
  await tick(); f.controller.abort()
  await assert.rejects(p, e => e.code === 'INPUT_CANCELLED' && e.outcome === 'unknown' && !e.continuation &&
    e.cancelSource === 'host-signal' && e.handoffWait.cooperation.phase === 'waiting' &&
    !e.message.includes('No input was dispatched'))
  checks++
}

// Wait diagnostics distinguish explicit host cancellation from core cleanup, without polling.
for (const source of ['host-signal', 'core-input-cancel']) {
  const cu = fresh(), controller = new AbortController(), records = []
  cu.on('handoff-wait', record => records.push(record))
  event(cu, 'waiting')
  const pending = cu.withInputContext({ signal: controller.signal }, () => cu.waitForHuman())
  pending.catch(() => {})
  if (source === 'host-signal') controller.abort(Object.assign(Error('private payload'), { code: 'TOOL_TIMEOUT' }))
  else cu.cancelInputs()
  await assert.rejects(pending, error => error.cancelSource === source && error.outcome === 'not-dispatched' &&
    error.handoffWait.waitedMs >= 0 && !error.message.includes('private payload'))
  assert.deepEqual(records.map(r => r.phase), ['started', 'ended-with-error'])
  assert.equal(cu.listenerCount('handoff'), 0)
  checks++
}

// hold/free are advisory state transitions and work through the direct and batch paths.
{
  const cu = fresh(), calls = []; let opens = 0
  const f = fixture(cu, {}, async () => { opens++ })
  cu.indicator = async args => { calls.push(args); return { holding: args.hold } }
  await f.run('computer_ctrl', { action: 'hold' })
  await f.run('computer_ctrl', { action: 'free' })
  await f.run('computer_batch', { shot: 'never', actions: [
    { tool: 'computer_ctrl', args: { action: 'hold' } },
    { tool: 'computer_ctrl', args: { action: 'free' } },
  ] })
  assert.deepEqual(calls, [{ hold: true }, { hold: false }, { hold: true }, { hold: false }])
  assert.equal(opens, 0, 'hold/free cannot open a cycle, even when wrapped in a batch')
  checks++
}

// Manual stop/exit while handing back remains authoritative, never a continuation checkpoint.
for (const type of ['panic', 'exit']) {
  const cu = fresh(), f = fixture(cu)
  event(cu, 'waiting')
  const p = f.run('computer_key', { combo: 'enter' }); p.catch(() => {})
  await tick(); cu.onLine(JSON.stringify({ event: type, why: 'explicit control hotkey' }))
  await assert.rejects(p, e => e.code === 'ABORTED' && !e.continuation)
  assert.equal(type === 'panic' ? cu.stopped : cu.exited, true)
  checks++
}

// Passive input invalidates stale target evidence without taking ownership or pausing.
{
  const cu = fresh()
  cu.maps.set('one', {}); cu.lastMarks = [{ id: 'M1' }]; cu.lastMarkFrame = { sig: 'old' }
  cu.syncCooperation({ phase: 'idle', active: false, revision: 0, inputEpoch: 1 })
  assert.equal(cu.maps.size, 0); assert.equal(cu.lastMarks.length, 0); assert.equal(cu.lastMarkFrame, null)
  assert.equal(cu.cooperation.active, false); assert.equal(cu.stopped, false); assert.equal(cu.exited, false)
  cu.syncCooperation({ phase: 'idle', active: false, revision: 0, inputEpoch: 0 })
  assert.equal(cu.cooperation.inputEpoch, 1)
  checks++
}

// A target changed during the startup warning: native asks for readback without sending input.
{
  const cu = fresh(), f = fixture(cu)
  cu.ensureWorker = async () => {}
  cu.proc = { stdin: { write (line) {
    const message = JSON.parse(line)
    queueMicrotask(() => cu.onLine(JSON.stringify({ id: message.id, ok: false,
      code: 'HUMAN_REOBSERVE', outcome: 'not-dispatched', error: 'target changed during warning' })))
  } } }
  continuation(await f.run('computer_key', { combo: 'enter' }), 'not-dispatched')
}

// A warning series belongs to one external call/batch, never to another concurrent agent.
{
  const cu = fresh(), writes = []
  cu.ensureWorker = async () => {}
  cu.proc = { stdin: { write (line) {
    const message = JSON.parse(line); writes.push(message)
    queueMicrotask(() => cu.onLine(JSON.stringify({ id: message.id, ok: true, data: {} })))
  } } }
  await Promise.all([
    cu.withInputContext({}, async () => {
      await cu.call('key', { agent: 'A', __inputSeries: 'forged' })
      await cu.call('key', { agent: 'A' })
    }),
    cu.withInputContext({}, () => cu.call('key', { agent: 'B' })),
  ])
  const a = writes.filter(x => x.args.agent === 'A'), b = writes.find(x => x.args.agent === 'B')
  assert.equal(a[0].args.__inputSeries, a[1].args.__inputSeries)
  assert.notEqual(a[0].args.__inputSeries, 'forged')
  assert.notEqual(a[0].args.__inputSeries, b.args.__inputSeries)
  await cu.call('key'); await cu.call('key')
  assert.notEqual(writes.at(-1).args.__inputSeries, writes.at(-2).args.__inputSeries)
  await cu.call('focus', { refocus: false })
  assert.equal(writes.at(-1).args.__inputSeries, undefined)
  await cu.call('focus', { refocus: true })
  assert.equal(typeof writes.at(-1).args.__inputSeries, 'string')
  checks++
}

// Handback cannot resume a stale owner after another turn has taken over.
for (const stage of ['before-dispatch', 'partial-input']) {
  const cu = fresh(); let owns = true
  const f = fixture(cu, { assertOwnership () {
    if (!owns) throw Object.assign(Error('ownership changed'), { code: 'COMPUTER_OWNER_CHANGED', outcome: 'not-dispatched' })
  } })
  if (stage === 'before-dispatch') event(cu, 'waiting')
  cu.call = async op => {
    if (op === 'ping') { event(cu, 'waiting'); return {} }
    throw Object.assign(Error('native interrupted input'), { code: 'HUMAN_YIELD', outcome: 'unknown' })
  }
  const p = f.run('computer_key', { combo: 'enter' }); p.catch(() => {})
  await tick(); owns = false; event(cu, 'idle')
  await assert.rejects(p, e => e.code === 'COMPUTER_OWNER_CHANGED' && !e.continuation &&
    e.outcome === (stage === 'before-dispatch' ? 'not-dispatched' : 'unknown'))
  checks++
}

// Ownership is checked again after an asynchronous worker startup, immediately before input.
{
  const cu = fresh(); let valid = true, release
  cu.ensureWorker = () => new Promise(resolve => { release = resolve })
  cu.proc = { stdin: { write () { throw Error('stale owner must not reach stdin') } } }
  const p = cu.withInputContext({ assertOwnership () {
    if (!valid) throw Object.assign(Error('stale owner'), { code: 'OWNER_CHANGED', outcome: 'not-dispatched' })
  } }, () => cu.call('key'))
  p.catch(() => {}); await tick(); valid = false; release()
  await assert.rejects(p, e => e.code === 'OWNER_CHANGED')
  checks++
}

// Cleanup has its own owner guard, because it intentionally runs in the releasing state.
{
  const cu = fresh(); let valid = true, release
  cu.ensureWorker = () => new Promise(resolve => { release = resolve })
  cu.proc = { stdin: { write () { throw Error('stale cleanup must not reach stdin') } } }
  const pending = cu.calm({ beforeDispatch () {
    if (!valid) throw Object.assign(Error('cleanup superseded'), { code: 'COMPUTER_OWNER_CHANGED', outcome: 'not-dispatched' })
  } })
  pending.catch(() => {}); await tick(); valid = false; release()
  await assert.rejects(pending, error => error.code === 'COMPUTER_OWNER_CHANGED')
  checks++
}
console.log(`ok test-handoff-continuation — ${checks} direct/batch/resume/cancel/ownership checks; no native input`)
