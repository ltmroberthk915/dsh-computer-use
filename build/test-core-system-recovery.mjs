import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { handoffResult } from '../lib/continuation.js'

const cases = []
const tick = () => new Promise(resolve => setImmediate(resolve))
function transport (handler) {
  const cu = new ComputerUse({ workerExe: 'X:/NO-WORKER-TEST.exe' }), writes = []
  const child = { kills: 0, pid: 42, kill () { this.kills++; return true }, stdin: { write (line) {
    const request = JSON.parse(line); writes.push(request); handler?.(request, reply, cu)
  } } }
  const reply = (request, data) => queueMicrotask(() => cu.onLine(JSON.stringify({ id: request.id, ok: true, data })))
  cu.proc = child; cu.ready = true; cu.workerGeneration = 'generation-A'
  cu.runtime = { buildId: 'audit-build', protocolVersion: 2, workerGeneration: 'generation-A' }
  cu.inputCleanupGraceMs = 35
  return { cu, child, writes, reply }
}
async function test (name, body) { await body(); cases.push(name) }

await test('dead handoff state cannot wait on a dead worker or replay input', async () => {
  const { cu, writes } = transport()
  cu.cooperation = { phase: 'waiting', active: true, revision: 7 }
  cu.lastMarks = [{ id: 'M1' }]; cu.maps.set('old', {})
  cu.onWorkerExit(1)
  let respawns = 0
  cu.ensureWorker = async () => {
    respawns++
    cu.onLine(JSON.stringify({ event: 'ready', workerGeneration: 'generation-B', cooperation: {
      phase: 'idle', active: false, revision: 0, workerGeneration: 'generation-B', stateSeq: 0,
    } }))
  }
  await assert.rejects(cu.actuate('key', { combo: 'enter' }), error => {
    assert.equal(error.code, 'WORKER_REOBSERVE')
    assert.equal(handoffResult(error).continuation.reason, 'worker-restarted')
    assert(!error.message.includes('handed back'))
    return error.outcome === 'not-dispatched'
  })
  assert.equal(respawns, 1); assert.equal(writes.length, 0)
  assert.equal(cu.listenerCount('handoff'), 0); assert.equal(cu.lastMarks.length, 0); assert.equal(cu.maps.size, 0)
})

await test('worker generation and state sequence reject reordered equal-revision handoff', async () => {
  const { cu } = transport()
  const state = (generation, stateSeq, phase) => ({ workerGeneration: generation, stateSeq, phase,
    active: phase !== 'idle', revision: 4, inputEpoch: 8 })
  assert.equal(cu.syncCooperation(state('generation-A', 12, 'idle')), true)
  assert.equal(cu.syncCooperation(state('generation-A', 11, 'waiting')), false)
  assert.equal(cu.syncCooperation(state('generation-A', 12, 'waiting')), false)
  assert.equal(cu.syncCooperation(state('old-generation', 999, 'waiting')), false)
  assert.equal(cu.syncCooperation({ phase: 'waiting', active: true, revision: 99 }), false)
  assert.equal(cu.cooperation.phase, 'idle')
  cu.onLine(JSON.stringify({ event: 'ready', workerGeneration: 'generation-B', cooperation: state('generation-B', 0, 'idle') }))
  assert.equal(cu.syncCooperation(state('generation-B', 1, 'waiting')), true)
  assert.equal(cu.cooperation.active, true)
})

for (const op of ['capture', 'uia', 'indicator']) for (const lost of ['cancel', 'owner']) {
  await test(`${op} rechecks ${lost} after asynchronous startup`, async () => {
    const { cu, writes } = transport()
    let release, owner = true, checks = 0
    cu.ensureWorker = () => new Promise(resolve => { release = resolve })
    const controller = new AbortController()
    const pending = cu.withInputContext({ signal: controller.signal, assertOwnership () {
      checks++; if (!owner) throw Object.assign(new Error('owner changed'), { code: 'COMPUTER_OWNER_CHANGED' })
    } }, () => cu.call(op, { hold: false }))
    if (lost === 'cancel') controller.abort(); else owner = false
    release()
    await assert.rejects(pending, error => error.code === (lost === 'cancel' ? 'INPUT_CANCELLED' : 'COMPUTER_OWNER_CHANGED'))
    assert.equal(writes.length, 0); assert(checks >= 1)
  })
}

await test('explicit cleanup runs despite caller cancellation and retains its own owner guard', async () => {
  const { cu, writes } = transport((request, reply) => reply(request, { released: true }))
  const controller = new AbortController(); controller.abort()
  let guards = 0
  await cu.withInputContext({ signal: controller.signal, assertOwnership () { throw Error('old user owner') } },
    () => cu.calm({ beforeDispatch () { guards++ } }))
  assert.equal(guards, 2); assert.deepEqual(writes.map(x => x.op), ['calm'])
  assert.equal(writes[0].args.__cycle, false)
})

await test('input timeout cancels out of band and keeps the worker only after confirmed release', async () => {
  const { cu, child, writes } = transport((request, reply) => {
    if (request.op === 'cancelInput') reply(request, { requestId: request.args.requestId,
      cancelled: true, cleanupConfirmed: true, ownedInputCount: 0, cleanupState: 'released' })
  })
  await assert.rejects(cu.call('key', { combo: 'a' }, 10), error => {
    assert.equal(error.code, 'worker-timeout'); assert.equal(error.outcome, 'unknown')
    assert.equal(error.cleanup.cleanupConfirmed, true); assert.equal(error.cleanup.requestId, writes[0].id)
    return true
  })
  assert.deepEqual(writes.map(x => x.op), ['key', 'cancelInput']); assert.equal(child.kills, 0)
  assert.equal(cu.pending.size, 0)
})

await test('unconfirmed cleanup waits for bounded acknowledgement before killing original worker', async () => {
  const { cu, child, writes } = transport()
  let error
  try { await cu.call('type', { text: 'private' }, 10) } catch (caught) { error = caught }
  assert.equal(error.code, 'worker-timeout'); assert.equal(error.cleanup.cleanupConfirmed, false)
  assert.equal(error.cleanup.workerKilled, true); assert.equal(error.outcome, 'unknown')
  assert.deepEqual(writes.map(x => x.op), ['type', 'cancelInput']); assert.equal(child.kills, 1)
})

await test('delayed cleanup cannot kill a replacement generation', async () => {
  const { cu, child } = transport((request, reply) => {
    if (request.op === 'cancelInput') cu.proc = { kill () { throw Error('new worker must not be killed') } }
  })
  await assert.rejects(cu.call('key', { combo: 'a' }, 10), error => error.cleanup?.cleanupState === 'worker-exited')
  assert.equal(child.kills, 0)
})

await test('caller cancellation waits for release acknowledgement and records unknown effect', async () => {
  const { cu, writes } = transport((request, reply) => {
    if (request.op === 'cancelInput') reply(request, { requestId: request.args.requestId,
      cancelled: true, cleanupConfirmed: true, ownedInputCount: 0, cleanupState: 'released' })
  })
  const controller = new AbortController()
  const pending = cu.withInputContext({ signal: controller.signal }, () => cu.call('key', { combo: 'a' }))
  await tick(); controller.abort()
  await assert.rejects(pending, error => error.code === 'INPUT_CANCELLED' && error.outcome === 'unknown' && error.cleanup.cleanupConfirmed)
  assert.deepEqual(writes.map(x => x.op), ['key', 'cancelInput'])
})

await test('action start and settlement correlate native request, cycle, worker and redacted args', async () => {
  const { cu, writes } = transport((request, reply) => reply(request, { delivered: true }))
  const records = []
  cu.on('action', record => records.push(record)); cu.on('action:settled', record => records.push(record))
  await cu.withInputContext({ cycleId: 12, sessionKey: 'chat', agentKey: 'agent' },
    () => cu.actuate('type', { text: 'do-not-log' }))
  assert.equal(records.length, 2); assert.equal(records[0].attemptId, records[1].attemptId)
  assert.equal(records[0].phase, 'started'); assert.equal(records[1].phase, 'settled')
  assert.equal(records[0].requestId, null); assert.equal(records[1].requestId, writes[0].id)
  assert.equal(records[1].cycleId, 12); assert.equal(records[1].workerGeneration, 'generation-A')
  assert.equal(records[1].runtime.buildId, 'audit-build'); assert.equal(records[1].outcome, 'delivered')
  assert.equal(JSON.stringify(records).includes('do-not-log'), false)
})

await test('pre-dispatch cancellation still has one correlated settled audit record', async () => {
  const { cu, writes } = transport()
  const records = []
  cu.on('action', record => records.push(record)); cu.on('action:settled', record => records.push(record))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(cu.withInputContext({ signal: controller.signal }, () => cu.actuate('key', { combo: 'a' })), error => error.code === 'INPUT_CANCELLED')
  assert.equal(writes.length, 0); assert.equal(records.length, 2)
  assert.equal(records[1].outcome, 'not-dispatched'); assert.equal(records[1].attemptId, records[0].attemptId)
})

await test('canonical key grammar is used at dispatch', async () => {
  const { cu, writes } = transport((request, reply) => reply(request, { delivered: true }))
  await cu.key('F4 + ALT')
  assert.equal(writes[0].args.combo, 'alt+f4')
  await assert.rejects(cu.key('ctrl++a'), /KEY_COMMAND_INVALID/)
  assert.equal(writes.length, 1)
})

await test('audit receipts and errors never persist provider values, images or input text', async () => {
  const secret = 'password-must-not-persist'
  const { cu } = transport((request, reply) => reply(request, { delivered: true, count: 9,
    focus: { value: secret }, image: secret, clipboard: secret, tree: [{ name: secret }], typed: secret }))
  const records = []; cu.on('action:settled', record => records.push(record))
  const data = await cu.actuate('uiaAct', { action: 'setValue', value: secret, selector: { name: secret } })
  assert.equal(data.focus.value, secret, 'caller still needs full result')
  assert.deepEqual(records[0].result, { delivered: true, count: 9 })
  cu.call = async () => { throw Object.assign(new Error(secret), { code: 'UIA_VALUE_FAILED' }) }
  await assert.rejects(cu.actuate('uiaAct', { value: secret }), error => error.message === secret)
  assert.equal(records[1].error, 'UIA_VALUE_FAILED')
  assert(!JSON.stringify(records).includes(secret))
})

await test('a real spawn rejects legacy ready messages without generation ordering', async () => {
  const { cu, child } = transport()
  cu.spawnRuntime = { protocolVersion: 2 }
  let incompatible
  cu.on('worker-incompatible', error => { incompatible = error })
  cu.onLine(JSON.stringify({ event: 'ready', cooperation: { phase: 'idle', active: false, revision: 0 } }))
  assert.equal(incompatible.code, 'WORKER_PROTOCOL_INCOMPATIBLE')
  assert.equal(cu.ready, false); assert.equal(cu.workerStateInvalid, true); assert.equal(child.kills, 1)
})

await test('restart between the actuation gate and dispatch cannot replay stale input', async () => {
  const { cu, writes } = transport()
  cu.ensureWorker = async () => {
    cu.onWorkerExit(1)
    cu.onLine(JSON.stringify({ event: 'ready', workerGeneration: 'generation-B', cooperation: {
      phase: 'idle', active: false, revision: 0, workerGeneration: 'generation-B', stateSeq: 0,
    } }))
    cu.proc = { stdin: { write () { throw Error('must not dispatch') } } }
  }
  await assert.rejects(cu.actuate('key', { combo: 'enter' }), error => error.code === 'WORKER_REOBSERVE')
  assert.equal(writes.length, 0)
})

await test('screen state exposes verified runtime and mark screenshots keep geometry', async () => {
  const { cu } = transport((request, reply) => reply(request, request.op === 'windows' ? { windows: [] } : {}))
  assert.equal((await cu.screenState()).runtime.buildId, 'audit-build')
  cu.validateMarkFrame = async () => {}
  const raw = Buffer.from('test-image')
  cu.screenshot = async () => ({ image: raw, mime: 'image/png', region: { x: 50, y: 70, width: 100, height: 80 },
    imageSize: { width: 50, height: 40 }, scaledTo: 50, capturedAt: 123, ts: 124, cursorInImage: { x: 1, y: 2 } })
  const marks = await cu.marks({ landmarkMap: { hwnd: 1, marks: [] } })
  assert.equal(marks.raw, raw); assert.equal(marks.mime, 'image/png'); assert.equal(marks.capturedAt, 123)
  assert.deepEqual(marks.region, { x: 50, y: 70, width: 100, height: 80 })
  assert.deepEqual(marks.imageSize, { width: 50, height: 40 }); assert.deepEqual(marks.cursorInImage, { x: 1, y: 2 })
  cu.landmarks = async opts => { assert.equal(opts.maxMarks, 5); return { hwnd: 1, marks: [] } }
  await cu.marks({ maxMarks: 5 })
})

await test('shutdown cleanup cannot terminate a replacement worker', async () => {
  const { cu, child } = transport((request, reply) => {
    cu.proc = { kill () { throw Error('replacement must survive') } }
    reply(request, { aborted: true })
  })
  await cu.kill()
  assert.equal(child.kills, 0)
})

for (const lost of ['cancel', 'owner']) await test(`queued observation rechecks ${lost} after UIA finishes`, async () => {
  const { cu, writes, reply } = transport()
  const read = cu.call('uia')
  await tick()
  let owner = true
  const controller = new AbortController()
  const queued = cu.withInputContext({ signal: controller.signal, assertOwnership () {
    if (!owner) throw Object.assign(new Error('owner changed'), { code: 'COMPUTER_OWNER_CHANGED' })
  } }, () => cu.call('capture'))
  await tick()
  if (lost === 'cancel') controller.abort(); else owner = false
  reply(writes[0], { root: {} })
  await read
  await assert.rejects(queued, error => error.code === (lost === 'cancel' ? 'INPUT_CANCELLED' : 'COMPUTER_OWNER_CHANGED'))
  assert.deepEqual(writes.map(request => request.op), ['uia'])
})

for (const lost of ['cancel', 'owner']) await test(`ask waits for its receipt and releases exact brake after ${lost}`, async () => {
  let begin, cards = 0, owner = true
  const { cu, writes, reply } = transport((request, reply) => {
    if (request.op === 'beginAsk') begin = request
    else if (request.op === 'endAsk') reply(request, { released: true, stopped: false })
  })
  const controller = new AbortController()
  const pending = cu.withInputContext({ signal: controller.signal, assertOwnership () {
    if (!owner) throw Object.assign(new Error('owner changed'), { code: 'COMPUTER_OWNER_CHANGED' })
  } }, () => cu.ask({ question: 'fixture', onAsk: async () => { cards++; return { answered: true, keepPause: false } } }))
  await tick()
  if (lost === 'cancel') controller.abort(); else owner = false
  reply(begin, { askId: 81, stopped: true })
  await assert.rejects(pending, error => error.code === (lost === 'cancel' ? 'INPUT_CANCELLED' : 'COMPUTER_OWNER_CHANGED'))
  assert.equal(cards, 0); assert.deepEqual(writes.map(request => request.op), ['beginAsk', 'endAsk'])
  assert.equal(writes[1].args.askId, 81); assert.equal(writes[1].args.keepPause, false); assert.equal(writes[1].args.__cycle, false)
})

await test('an old question cannot release a replacement worker with a recycled askId', async () => {
  const { cu, writes } = transport((request, reply) => reply(request, { askId: 1, stopped: true }))
  await cu.ask({ question: 'fixture', onAsk: async () => {
    cu.proc = { stdin: { write () { throw Error('replacement must receive no old cleanup') } } }
    return { answered: true, keepPause: false }
  } })
  assert.deepEqual(writes.map(request => request.op), ['beginAsk'])
})

await test('shutdown is bounded and settles unknown outcomes when process exit is not confirmed', async () => {
  const { cu, child } = transport((request, reply) => {
    if (request.op === 'abort') reply(request, { aborted: true })
  })
  cu.shutdownGraceMs = 20
  const records = []; cu.on('action:settled', record => records.push(record))
  const pending = cu.actuate('key', { combo: 'enter' }); pending.catch(() => {})
  await tick()
  await cu.kill()
  await assert.rejects(pending, error => error.code === 'worker-shutdown-unconfirmed' &&
    error.outcome === 'unknown' && error.cleanup.cleanupConfirmed === false)
  assert.equal(child.kills, 1); assert.equal(cu.activeActions.size, 0); assert.equal(cu.pending.size, 0)
  assert.equal(records.length, 1); assert.equal(records[0].code, 'worker-shutdown-unconfirmed')
})

await test('an action may request shutdown without waiting for its own settlement', async () => {
  const cu = new ComputerUse()
  cu.shutdownGraceMs = 1000
  cu.call = async () => { await cu.kill(); return { delivered: false } }
  let timer
  try {
    await Promise.race([cu.actuate('key', { combo: 'enter' }), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('shutdown awaited its own action')), 100)
    })])
  } finally { clearTimeout(timer) }
  assert.equal(cu.activeActions.size, 0)
})
console.log(JSON.stringify({ passed: cases.length, cases, desktopInput: false, workerStarted: false }))
