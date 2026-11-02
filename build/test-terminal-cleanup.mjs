import assert from 'node:assert/strict'
import { createCycleGate } from '../lib/cycle.js'
import { createTerminalCleanup } from '../lib/terminal-cleanup.js'
import { ComputerUse } from '../lib/core/index.js'

let passed = 0
async function fixture () {
  const gate = createCycleGate(), exec = { session: 'chat', agent: 'owner' }
  gate.noteTurnStart(exec.session)
  const claim = gate.claim(exec); await gate.open(claim, () => {})
  let pause = false, calls = 0, cancels = 0, resolveCalm
  const reports = []
  const cu = {
    cancelInputs: () => { cancels++ },
    calm: async ({ beforeDispatch } = {}) => { beforeDispatch?.(); calls++; return new Promise(resolve => { resolveCalm = resolve }) },
  }
  const cleanup = createTerminalCleanup({ gate, cu, claimOf: value => gate.claim(value), owner: () => exec,
    paused: () => pause, report: error => reports.push(error) })
  return { gate, exec, claim, cu, cleanup, calls: () => calls, cancels: () => cancels, reports,
    pause: value => { pause = value; gate.mark(value ? 'paused' : 'open') }, done: value => resolveCalm(value ?? { released: true }) }
}
{
  const f = await fixture(), id = f.gate.snapshot().id
  const promise = f.cleanup.request('owner cancelled')
  assert.equal(f.gate.state(), 'releasing')
  assert.throws(() => f.gate.open(f.gate.claim({ session: 'other', agent: 'other' }), () => {}), e => e.dshCycleRefusal)
  assert.throws(() => f.gate.assertOwnership(f.claim, id), e => e.code === 'COMPUTER_OWNER_CHANGED')
  await Promise.resolve(); assert.equal(f.calls(), 1); assert.equal(f.cancels(), 1)
  f.done(); assert.equal(await promise, true)
  let reopened = 0; await f.gate.open(f.claim, () => { reopened++ }); assert.equal(reopened, 0)
  assert.equal(f.gate.state(), 'ended')
  const peer = f.gate.claim({ session: 'other', agent: 'other' }); await f.gate.open(peer, () => {})
  assert.notEqual(f.gate.snapshot().id, id); assert.equal(f.calls(), 1); passed++
}
{
  const f = await fixture(); f.pause(true)
  assert.equal(f.cleanup.request('owner disposed'), null)
  assert.equal(f.gate.state(), 'paused'); assert.equal(f.calls(), 0)
  f.pause(false); assert.equal(f.cleanup.resumePending(), true)
  await Promise.resolve(); assert.equal(f.calls(), 1)
  f.done(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(f.gate.state(), 'ended'); passed++
}
{
  const f = await fixture(), promise = f.cleanup.request('cancel before microtask')
  f.gate.mark('ended', { why: 'Q' }); f.cleanup.forget()
  const peer = f.gate.claim({ session: 'peer', agent: 'peer' }); await f.gate.open(peer, () => {})
  await promise
  assert.equal(f.calls(), 0); assert.equal(f.gate.state(), 'open'); passed++
}
{
  const f = await fixture()
  let workerReady, writes = 0
  f.cu.calm = async ({ beforeDispatch }) => {
    beforeDispatch()
    await new Promise(resolve => { workerReady = resolve })
    beforeDispatch(); writes++
    return { released: true }
  }
  const promise = f.cleanup.request('cancel during worker startup'); await Promise.resolve()
  f.gate.mark('ended', { why: 'Q' }); f.cleanup.forget()
  const peer = f.gate.claim({ session: 'peer', agent: 'peer' }); await f.gate.open(peer, () => {})
  workerReady(); await promise
  assert.equal(writes, 0); assert.equal(f.gate.state(), 'open'); passed++
}
{
  const f = await fixture(), token = f.gate.beginCompletion(f.claim, f.gate.snapshot().id)
  assert.equal(f.cleanup.request('owner cancelled during normal cleanup'), null)
  assert.equal(token.terminal, true)
  assert.equal(f.gate.finishCompletion(token), true)
  let reopened = 0; await f.gate.open(f.claim, () => { reopened++ }); assert.equal(reopened, 0)
  assert.equal(f.calls(), 0); passed++
}
{
  const cu = new ComputerUse({ workerExe: 'X:/NOT-STARTED.exe' })
  let ready, lost = false, checks = 0, writes = 0
  cu.ensureWorker = () => new Promise(resolve => { ready = resolve })
  cu.proc = { stdin: { write () { writes++ } } }
  const pending = cu.calm({ beforeDispatch: () => { checks++; if (lost) throw Error('superseded cleanup') } })
  lost = true; ready()
  await assert.rejects(pending, /superseded cleanup/)
  assert.equal(checks, 2); assert.equal(writes, 0); passed++
}
console.log(`ok test-terminal-cleanup — ${passed} cases: reserved cancellation/disposal, paused recovery, terminal qualification, Q/startup stale-cleanup races`)
