// Lift the complete production opener/disposer, including their closures and
// await boundaries. The transport is mocked; no worker or desktop input starts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'
import { createCycleGate } from '../lib/cycle.js'
import { installAudit } from '../lib/audit.js'

const plugin = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const start = plugin.indexOf('  const ensureCycle = async (exec) => {')
const end = plugin.indexOf('  const lifecycle = createCycleLifecycle(', start)
assert(start >= 0 && end > start, 'complete production opener must be extractable')
const opener = plugin.slice(start, end)
const disposer = plugin.match(/const disposer = \(\) => \{[^\r\n]+\}/)?.[0]
assert(disposer, 'production disposer must be extractable')
const tick = () => new Promise(resolve => setImmediate(resolve))
const cases = []

async function opening (kind, source = opener) {
  const gate = createCycleGate(), callOwners = new WeakMap(), sent = [], contexts = [], definitions = new Map()
  const cu = new ComputerUse({ workerExe: 'NEVER-STARTED.exe' }), controller = new AbortController()
  const exec = { session: 'owner-chat', agent: 'owner-agent', signal: controller.signal }
  const claimOf = value => gate.claim(value)
  let startup, first = true
  cu.exited = true
  cu.proc = { stdin: { write (line) {
    const request = JSON.parse(line); sent.push(request)
    queueMicrotask(() => cu.onLine(JSON.stringify({ id: request.id, ok: true, data: { delivered: true } })))
  } } }
  cu.ensureWorker = () => {
    contexts.push(cu.inputContext.getStore())
    if (!first) return Promise.resolve()
    first = false
    return new Promise(resolve => { startup = resolve })
  }
  const make = new Function('cu', 'gate', 'claimOf', 'callOwners', 'bus', 'exitedLatch', 'brakeLatch', 'exitRecordText', 'log',
    `${source}; return ensureCycle`)
  const ensureCycle = make(cu, gate, claimOf, callOwners, {}, () => cu.exited, () => false, () => 'old EXIT record', { warn () {}, info () {} })
  registerTools({ ctx: { tools: { register: definition => definitions.set(definition.name, definition) } }, cu,
    config: { actionFeedback: false }, defineTool: x => x, ensureCycle, hooks: {
      contextOf: value => { const owner = callOwners.get(value); return { cycleId: owner.cycleId, ...owner.claim } },
      assertOwnership: value => { const owner = callOwners.get(value); gate.assertOwnership(owner.claim, owner.cycleId) },
    } })
  const pending = definitions.get('computer_key').execute({ combo: 'enter' }, exec)
  pending.catch(() => {})
  await tick()
  assert.equal(typeof startup, 'function', 'opener reached asynchronous startup')
  if (kind === 'cancel') controller.abort()
  if (kind === 'owner') {
    gate.mark('ended', { why: 'old owner disposed' })
    await gate.open(gate.claim({ session: 'replacement-chat', agent: 'replacement-agent' }), () => {})
  }
  startup()
  if (kind === 'allowed') await pending
  else await assert.rejects(pending, error => kind === 'cancel' ? /cancelled/.test(error.message) : error.code === 'COMPUTER_OWNER_CHANGED')
  return { sent, contexts, exec }
}

for (const kind of ['cancel', 'owner', 'allowed']) {
  const result = await opening(kind)
  assert.deepEqual(result.sent.map(request => request.op), kind === 'allowed' ? ['resume', 'key'] : [])
  const context = result.contexts[0]
  assert.equal(context.signal, result.exec.signal)
  assert.equal(context.sessionKey, 'owner-chat'); assert.equal(context.agentKey, 'owner-agent')
  assert.equal(typeof context.cycleId, 'number'); assert.equal(typeof context.assertOwnership, 'function')
  cases.push(`complete opener preserves ${kind} ownership and cancellation semantics`)
}
const unscoped = opener.replace('await cu.withInputContext(openingContext, resume)', 'await resume()')
assert.notEqual(unscoped, opener)
assert.deepEqual((await opening('cancel', unscoped)).sent.map(request => request.op), ['resume'], 'mutation must expose the original stale-opener dispatch')
cases.push('opener regression catches removal of its caller context')

async function shutdown (source = disposer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-root-shutdown-'))
  try {
    const cu = new ComputerUse(), child = new EventEmitter(), rows = []
    cu.ready = true; cu.workerGeneration = 'shutdown-generation'; cu.proc = child
    child.stdin = { write (line) {
      const request = JSON.parse(line)
      if (request.op === 'abort') queueMicrotask(() => cu.onLine(JSON.stringify({ id: request.id, ok: true, data: {} })))
    } }
    child.on('exit', code => cu.onWorkerExit(code))
    // Match ChildProcess.kill: requesting termination is synchronous; exit is a
    // later event. A microtask-only fake would conceal early audit unsubscription.
    child.kill = () => { setImmediate(() => child.emit('exit', 1)); return true }
    cu.on('action:settled', row => rows.push(row))
    const detach = installAudit(cu, { root: dir })
    const pending = cu.actuate('key', { combo: 'enter' }); pending.catch(() => {})
    await tick()
    const dispose = new Function('detachAudit', 'cu', `${source}; return disposer`)(detach, cu)
    await dispose()
    await assert.rejects(pending, error => error.code === 'worker-exited')
    assert.equal(rows.length, 1)
    const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    return { audit, detached: cu.listenerCount('action') === 0 && cu.listenerCount('action:settled') === 1 }
  } finally {
    if (path.dirname(dir) !== os.tmpdir()) throw Error('unsafe scratch path')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
{
  const { audit, detached } = await shutdown()
  assert.deepEqual(audit.map(row => row.phase), ['started', 'settled'])
  assert.equal(audit[0].attemptId, audit[1].attemptId)
  assert.equal(audit[1].outcome, 'unknown'); assert.equal(audit[1].code, 'worker-exited')
  assert(detached, 'listeners detach only after settlement')
  cases.push('asynchronous worker exit persists settlement before audit detaches')
}
assert.deepEqual((await shutdown('const disposer = () => { detachAudit(); return cu.kill() }')).audit.map(row => row.phase), ['started'])
cases.push('shutdown regression catches early audit detachment')
console.log(JSON.stringify({ passed: cases.length, cases, workerStarted: false, desktopInput: false }))
