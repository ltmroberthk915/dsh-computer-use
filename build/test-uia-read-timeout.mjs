// Exercise the real core dispatcher with a controllable transport; no desktop input.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { ComputerUse } from '../lib/core/index.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture () {
  const core = new ComputerUse()
  const commands = []
  const child = { kills: 0, pid: 123, kill () { this.kills++; return true },
    stdin: { write (line) { commands.push(JSON.parse(line)) } } }
  core.proc = child
  core.ready = true
  const reply = (cmd, data = {}) => core.onLine(JSON.stringify({ id: cmd.id, ok: true, data }))
  return { core, commands, child, reply }
}
const isError = code => error => error.code === code && error.outcome === 'not-dispatched'

// An ordinary slow tree gets one grace period. No write can be queued into
// the resident while the old UIA result is outstanding, including a retry.
{
  const { core, child, commands, reply } = fixture()
  const tree = assert.rejects(core.call('uia', {}, 60), isError('worker-timeout'))
  await flush()
  const write = assert.rejects(core.call('click', {}, 250), isError('worker-uia-busy'))
  await Promise.all([tree, write])
  assert.equal(child.kills, 0)
  await assert.rejects(core.call('type'), isError('worker-uia-busy'))
  assert.deepEqual(commands.map(c => c.op), ['uia'])
  const latest = core.cooperation
  reply(commands[0], { cooperation: { active: true, revision: 99 } })
  assert.equal(core.cooperation, latest, 'late metadata was discarded')
  const next = core.call('windows')
  await flush()
  reply(commands[0], { stale: true })
  reply(commands[1], { target: 72 })
  assert.deepEqual(await next, { target: 72 })
  await sleep(80)
  assert.equal(child.kills, 0, 'matching late reply disarmed the watchdog')
}

// Permanent provider hang: bounded recovery of the matching resident only.
{
  const { core, child, commands, reply } = fixture()
  await assert.rejects(core.call('uia', {}, 25), isError('worker-timeout'))
  reply({ id: commands[0].id + 1000 })
  await sleep(65)
  assert.equal(child.kills, 1)
  core.onWorkerExit(1)
  assert.equal(core.uiaRead, null)
}
{
  const { core, child } = fixture()
  await assert.rejects(core.call('uia', {}, 25), isError('worker-timeout'))
  const nextChild = { kill () { throw Error('wrong worker generation') } }
  core.proc = nextChild
  await sleep(65)
  assert.equal(core.proc, nextChild)
  assert.equal(child.kills, 0)
  core.onWorkerExit(1)
}

// Normal concurrent work resumes after a successful query. Cancellation,
// including while waiting for admission, does not dispatch or replay writes.
{
  const { core, commands, reply } = fixture()
  const tree = core.call('uia', {}, 300)
  await flush()
  const signal = new AbortController()
  const write = assert.rejects(core.withInputContext({ signal: signal.signal }, () => core.call('click')), isError('INPUT_CANCELLED'))
  const query = core.call('windows')
  await flush()
  signal.abort()
  await write
  const cancel = core.call('cancelInput', { requestId: 82 }, 500, false)
  await flush()
  assert.deepEqual(commands.map(c => c.op), ['uia', 'cancelInput'])
  reply(commands[1])
  await cancel
  reply(commands[0], { count: 10 })
  assert.equal((await tree).count, 10)
  await flush()
  assert.deepEqual(commands.map(c => c.op), ['uia', 'cancelInput', 'windows'])
  reply(commands[2])
  await query
}
console.log('ok UIA deadlines, bounded recovery, stale reply isolation, cancellation and unsent writes')
