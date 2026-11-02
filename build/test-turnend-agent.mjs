// The Agent voluntarily releases desktop work while its conversation remains alive.
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
import { policyDecision } from '../lib/policy.js'
import { isDrivingCall } from '../lib/skill-gate.js'
import { lifecycleFixture } from './lifecycle-fixture.mjs'

const f = await lifecycleFixture(), definitions = new Map()
let opened = 0, keys = 0
f.cu.key = async () => { keys++; return { ok: true } }
registerTools({ ctx: { tools: { register: d => definitions.set(d.name, d) } }, cu: f.cu,
  config: { actionFeedback: false }, defineTool: d => d, dataDir: { root: 'X:/NOT-USED', shots: 'X:/NOT-USED' },
  snapshotPath: () => { throw Error('released cycle must not capture') },
  ensureCycle: async exec => { opened++; await f.gate.open(f.claimOf(exec), async () => ({})) },
  hooks: { onStart: f.start, onEnd: f.end, releaseCycle: (exec, why) => f.lifecycle.release(exec, why) } })
const run = (name, args) => definitions.get(name).execute(args, { ...f.exec, name, arguments: args })
let checks = 0
const result = await run('computer_ctrl', { action: 'release' })
assert.equal(result.released, true); assert.equal(result.conversationContinues, true); assert.equal(opened, 0)
assert.match(JSON.stringify(definitions.get('computer_ctrl').output.render({}, result)), /conversationContinues/)
checks++
const again = await run('computer_ctrl', { action: 'release' })
assert.equal(again.alreadyReleased, true); assert.equal(opened, 0); assert.deepEqual(f.calls, ['calm'])
checks++
await run('computer_key', { combo: 'enter' })
assert.equal(keys, 1); assert.equal(opened, 1); assert.equal(f.gate.state(), 'open')
checks++
const batch = await run('computer_batch', { shot: 'never', actions: [
  { tool: 'computer_key', args: { combo: 'enter' } },
  { tool: 'computer_ctrl', args: { action: 'release' } },
  { tool: 'computer_key', args: { combo: 'enter' } },
] })
assert.equal(batch.actions[1].result.released, true)
assert.equal(batch.actions[2].outcome, 'not-dispatched'); assert.equal(keys, 2)
assert.equal(f.gate.state(), 'ended'); checks++
for (const mode of ['read-only', 'standard', 'autonomous', 'unrestricted']) {
  assert.equal(policyDecision('computer_ctrl', { action: 'release' }, mode).kind, 'allow')
}
assert.equal(isDrivingCall('computer_ctrl', { action: 'release' }), false); checks++
console.log(`ok test-turnend-agent — ${checks} explicit release/render/idempotence/same-turn-reopen/batch/policy checks`)
