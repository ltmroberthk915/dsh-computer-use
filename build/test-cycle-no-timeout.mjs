// Real plugin, gate and tool wrapper; fake worker transport, latches and clock.
// No native process, desktop input, real latch file, or host prompt is used.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { ComputerUse } from '../lib/core/index.js'
import { createCycleGate, agentKeyOf } from '../lib/cycle.js'
import { registerTools } from '../lib/tools.js'
import { recoveryProblem } from '../lib/recovery.js'

const SOURCE_URL = new URL(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../lib/index.js', import.meta.url)
const source = fs.readFileSync(SOURCE_URL, 'utf8')
const fluent = new Proxy(function () { return fluent }, { get() { return fluent } })
function harness(legacyTimeout) {
  let cu, gate, now = 1000000
  const timers = new Set(), handlers = new Map(), definitions = new Map()
  const state = { stop: false, exited: false, lit: false, calls: [], steers: [], policy: 'allow' }
  class FakeCU extends ComputerUse {
    constructor() { super({ workerExe: 'X:/NEVER-STARTED.exe' }); cu = this; this.proc = {} }
    async call(op, args = {}) {
      state.calls.push(op)
      if (op === 'panic') {
        if (state.deferPanic) await state.deferPanic
        state.stop = true
        state.pauseId = args.temporary ? 'temporary-1' : ''
        this.onLine(JSON.stringify({ event: 'panic', why: args.why, pauseId: state.pauseId }))
        return { engaged: true, pauseId: state.pauseId }
      }
      if (op === 'recover') {
        if (state.deferRecover) await state.deferRecover
        if (!state.pauseId || args.pauseId !== state.pauseId) return { recovered: false }
        state.stop = false
        return { recovered: true }
      }
      if (op === 'calm') { state.lit = false; return {} }
      if (op === 'windows') { if (!state.exited) state.lit = true; return { fakeTransport: true } }
      // THE QUESTION PATH IS TWO OPS NOW (merge-design.md §2.3, §6 G7). This file's own transport
      // threw on ANY unknown op, which is the right instinct — so these two are MODELED rather than
      // waved through: `beginAsk` raises the brake and notifies once (the core counts that
      // notification as its OWN, see `_askOpen`), `endAsk` releases it or keeps it, which is exactly
      // the pair the cycle gate has to survive. No case in this file drives them today; the real
      // invariant ("every ending releases") is measured against the real compiled worker in
      // build/test-ask-release.mjs, which is where it belongs.
      if (op === 'beginAsk') {
        state.stop = true
        this.onLine(JSON.stringify({ event: 'ask', why: args.question }))
        return { askId: 1, engaged: true, hostRaised: false, caretPlaced: false, stopped: true }
      }
      if (op === 'endAsk') {
        state.stop = !!args.keepPause
        return { released: !args.keepPause, reason: args.keepPause ? 'kept-pause' : 'released', stopped: state.stop, exited: false }
      }
      throw Error('Unexpected fake-worker operation: ' + op)
    }
    async kill() {}
  }
  const fakeDate = class extends Date { static now() { return now } }
  const fakeSetTimeout = (fn, ms) => { const t = { fn, at: now + ms, unref() {} }; timers.add(t); return t }
  const fakeClearTimeout = t => timers.delete(t)
  const advance = ms => {
    now += ms
    for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn() }
  }
  const log = { info() {}, warn() {} }
  // THE INJECTIONS ARE REAL ENOUGH TO LAND (merge-design.md §5.3 item 16). `apply` asks for
  // `userQuestions` through `ctx.inject(['userQuestions'], cb)` — that callback is what sets the
  // module-scope `asker` the question path reads at call time, so a no-op inject would leave
  // `computer_ask` unable to ask at all. `settings` is stubbed for the same reason.
  const services = { userQuestions: { ask: async () => ({ answers: [{ id: 'computer_ask', selected: [] }] }) }, settings: { register() {} } }
  const ctx = { logger: () => log, inject: (names, cb) => { const child = { ...services }; try { cb(child) } catch { /* a stub service may be too thin: this file is not about that wiring */ } }, effect() {}, on: (name, fn) => handlers.set(name, fn), tools: { register: def => definitions.set(def.name, def) } }
  const fakeFs = { existsSync: p => path.basename(p) === 'STOP' ? state.stop : path.basename(p) === 'EXITED' ? state.exited : false, readFileSync: () => '' }
  // `import.meta` IS MODULE-ONLY SYNTAX and this harness evaluates the file as a function body, so the
  // occurrence is rewritten to the module's real URL rather than banned from the plugin: an assertion
  // that the module may never learn where it lives would be a rule about the harness, not about the
  // product. Rewriting keeps `new URL(..., import.meta.url)` resolving exactly as it does in production.
  const prelude = source.replace(/^import .+$/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(SOURCE_URL.href))
  const apply = new Function('defineTool', 'Schema', 'ComputerUse', 'policyDecision', 'acknowledge', 'isAcked', 'ACK_HINT', 'isDrivingCall', 'mkDataDir', 'snapshotPath', 'appendAudit', 'registerTools', 'fs', 'os', 'path', 'createCycleGate', 'agentKeyOf', 'setTimeout', 'clearTimeout', 'Date', 'recoveryProblem', 'installHumanAttention', 'fileURLToPath', prelude + '\nreturn apply;')(
    def => def, fluent, FakeCU, () => ({ kind: state.policy }), () => true, () => true, '', () => false, () => '', () => '', () => {}, registerTools, fakeFs, os, path, (...args) => (gate = createCycleGate(...args)), agentKeyOf, fakeSetTimeout, fakeClearTimeout, fakeDate, recoveryProblem, () => {}, fileURLToPath)
  apply(ctx, { enabled: true, automationMode: 'standard', calmAfterMs: legacyTimeout, maxActionsPerMinute: 60 })
  const agent = { id: 'agentA', session: { id: 'A' }, status: 'running', inject() {}, steer: m => state.steers.push(m), cancel() {} }
  const exec = { name: 'computer_state', arguments: { windows: true }, session: 'A', agent }
  const pre = () => handlers.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }))
  pre()
  const run = () => definitions.get('computer_state').execute({ windows: true }, exec)
  const event = name => {
    if (name === 'panic') state.stop = true
    if (name === 'resume') state.stop = false
    if (name === 'exit') { state.exited = true; state.stop = false; state.lit = false }
    cu.onLine(JSON.stringify({ event: name, why: 'isolated no-timeout test' }))
  }
  return { state, gate, cu, agent, handlers, pre, run, event, advance, exec, definitions }
}
const settle = () => new Promise(r => setTimeout(r, 60))
const wakes = h => h.state.steers.filter(m => m.source.summary === 'computer-use resumed').length

// A previously saved finite setting must not silently restore an expiry after upgrade.
for (const legacy of [600000, 1, 0]) {
  const h = harness(legacy); await h.run()
  const id = h.gate.snapshot().id
  for (const elapsed of [600001, 53 * 60000, 86400000, 366 * 86400000]) {
    h.advance(elapsed)
    assert.equal(h.gate.state(), 'open', `elapsed time ended the cycle (legacy ${legacy}, advance ${elapsed})`)
    assert.equal(h.gate.snapshot().id, id)
    assert.equal(h.state.lit, true)
    assert.equal(h.state.calls.includes('calm'), false)
  }
}
// Replay the reported approval wait and pause/chat/R, using the real execute wrapper.
{
  const h = harness(600000); await h.run(); const id = h.gate.snapshot().id
  h.state.policy = 'ask'; assert.equal(h.pre().kind, 'ask')
  h.advance(53 * 60000); await h.run()
  assert.equal(h.gate.state(), 'open'); assert.equal(h.gate.snapshot().id, id)
  h.event('panic'); h.advance(366 * 86400000)
  assert.equal(h.gate.state(), 'paused'); assert.equal(h.cu.stopped, true)
  h.handlers.get('agent/status')({ agent: h.agent, status: 'idle' })
  h.handlers.get('session/event')('A', { type: 'turn/start', data: { turn: 2 } })
  h.handlers.get('session/event')('A', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(h.gate.state(), 'paused')
  h.event('resume'); await settle()
  assert.equal(h.gate.state(), 'open'); assert.equal(h.gate.snapshot().id, id)
  assert.equal(h.cu.stopped, false); assert.equal(wakes(h), 1)
}
// Approval that is declined (no execute) adds no timer; normal completion still closes the cycle.
{
  const h = harness(600000); await h.run(); h.state.policy = 'ask'; h.pre()
  h.advance(86400000); assert.equal(h.gate.state(), 'open')
  h.handlers.get('session/event')('A', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  h.handlers.get('agent/status')({ agent: h.agent, status: 'idle' })
  assert.equal(h.gate.state(), 'ended'); assert.equal(h.state.lit, false)
}
// Q during a long approval wait is still terminal and a late R must not wake the owner.
{
  const h = harness(600000); await h.run(); h.state.policy = 'ask'; h.pre()
  h.event('exit'); h.advance(366 * 86400000); h.event('resume'); await settle()
  assert.equal(h.gate.state(), 'ended'); assert.equal(wakes(h), 0)
}
// Host abort -> idle while native panic is still pending: preserve the cycle synchronously.
{
  const h = harness(0); await h.run()
  let release; h.state.deferPanic = new Promise(r => { release = r })
  h.handlers.get('session/event')('A', { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  h.handlers.get('agent/status')({ agent: h.agent, status: 'idle' })
  assert.equal(h.gate.state(), 'paused'); assert.equal(h.state.calls.includes('calm'), false)
  release(); await settle(); assert.equal(h.cu.stopped, true)
}
// Real tool + plugin + core hooks: owner-only recovery, approval blocking and in-flight invalidation.
for (const scenario of ['success', 'approval', 'late-approval', 'human-stop', 'Q', 'stale-token', 'foreign-owner', 'new-cycle']) {
  const h = harness(0); await h.run()
  const ctrl = args => h.definitions.get('computer_ctrl').execute(args, h.exec)
  const noticesBefore = h.state.steers.length
  const pause = await ctrl({ action: 'stop', temporary: true, why: 'inspect transient blocker' })
  assert.equal(h.gate.state(), 'paused'); assert.equal(h.state.steers.length, noticesBefore)
  const id = h.gate.snapshot().id
  const approval = () => h.handlers.get('session/event')('A', { type: 'approval/asked', data: { id: 'approval-1' } })
  if (scenario === 'approval') approval()
  if (scenario === 'human-stop') h.event('panic')
  if (scenario === 'Q') h.event('exit')
  if (scenario === 'foreign-owner') {
    h.exec.agent = { id: 'agentB', session: { id: 'B' } }; h.exec.session = 'B'
  }
  if (scenario === 'new-cycle') { h.gate.mark('ended'); h.gate.noteTurnStart('A'); await h.run() }
  let release
  if (scenario === 'late-approval') h.state.deferRecover = new Promise(r => { release = r })
  const pending = ctrl({ action: 'recover', pauseId: scenario === 'stale-token' ? 'old' : pause.pauseId })
  if (release) { await settle(); approval(); release() }
  if (scenario === 'foreign-owner') await assert.rejects(pending, /owned by another/)
  else {
    const result = await pending
    assert.equal(result.recovered, scenario === 'success', scenario)
    if (scenario === 'success') { assert.equal(h.gate.state(), 'open'); assert.equal(h.gate.snapshot().id, id); assert.equal(h.cu.stopped, false) }
    if (scenario === 'late-approval') { assert.equal(h.cu.stopped, true); assert.equal(h.state.stop, true) }
  }
}
// The native thinking light is a latch too, not a second ten-minute timer.
const native = fs.readFileSync(new URL('../lib/core/worker.cs', import.meta.url), 'utf8')
assert.match(native, /bool thinking = ThinkingActive;/)
assert.match(native, /ThinkingActive \{ get \{ return _enabled && _thinking; \} \}/)
assert.doesNotMatch(native, /ThinkSafetyNetMs|_thinkHoldMs|_lastOpMs/)

// The MERGED question path, through the REAL tool definition (merge-design.md §6 G7): `beginAsk`
// raises the brake and emits `ask` once, the tool waits for the channel, and `endAsk` releases it —
// and the cycle gate must come out of that pair exactly where it went in, because `core.ask()` emits
// `ask-ended` from its `finally`. A gate left on `asking` is the measured lifecycle bug (the owner's
// idle and its turn/end were both refused, and every other session stayed locked out).
{
  const h = harness(0); await h.run()
  assert.equal(h.gate.state(), 'open')
  const exec2 = { name: 'computer_ask', arguments: { question: 'may I proceed?' }, session: 'A', agent: h.agent,
    signal: new AbortController().signal }
  const res = await h.definitions.get('computer_ask').execute({ question: 'may I proceed?' }, exec2)
  assert.equal(h.state.calls.includes('beginAsk'), true, 'the merged ask never engaged the brake')
  assert.equal(h.state.calls.includes('endAsk'), true, 'the merged ask never released the brake — the leak the merge exists to remove')
  assert.equal(res.answered, true, 'the answer from the card channel did not reach the tool result')
  assert.equal(res.keepPause, false, 'an empty selection must NOT read as "keep the pause" — a skip or a custom answer releases')
  assert.equal(h.state.stop, false, 'the brake is still up after a no-answer ending')
  assert.equal(h.gate.state(), 'open', `the cycle gate was left on ${h.gate.state()} after the question ended — the owner would be refused`)
}
console.log('ok test-cycle-no-timeout — finite legacy settings ignored; long thinking/approval/pause retained; R wakes once; completion and Q still close; the merged ask engages, answers and releases without stranding the gate')
