import assert from 'node:assert/strict'
import { createToolQueue, continuationResult } from '../mcp/src/execution.js'
import { humanContinuation } from '../lib/core/index.js'

const queue = createToolQueue(), order = []
let release
const held = new Promise(resolve => { release = resolve })
const first = queue(async () => { order.push('batch-start'); await held; order.push('batch-end') })
const second = queue(async () => { order.push('second-agent') })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(order, ['batch-start'])
release()
await Promise.all([first, second])
assert.deepEqual(order, ['batch-start', 'batch-end', 'second-agent'])

const cancelled = new AbortController()
cancelled.abort()
await assert.rejects(queue(() => { throw Error('must not dispatch') }, cancelled.signal),
  e => e.code === 'INPUT_CANCELLED' && e.outcome === 'not-dispatched')
await assert.rejects(queue(() => { throw Error('failed first owner') }), /failed first owner/)
assert.equal(await queue(() => 42), 42)

for (const outcome of ['unknown', 'not-dispatched']) {
  const result = continuationResult({ code: 'HUMAN_REOBSERVE', op: 'type', outcome }, humanContinuation)
  assert.equal(result.status, 'continuation-required')
  assert.equal(result.taskStatus, 'continuing')
  assert.equal(result.continuation.required, true)
  assert.equal(result.continuation.replayInterruptedInput, false)
  assert.equal(result.continuation.outcome, outcome)
}
assert.equal(continuationResult({ code: 'INPUT_CANCELLED' }, humanContinuation), null)
assert.equal(continuationResult({ code: 'ABORTED' }, humanContinuation), null)
const recovered = continuationResult({ code: 'WORKER_REOBSERVE', outcome: 'not-dispatched',
  continuation: { required: true, reason: 'worker-restarted', replayInterruptedInput: false } }, humanContinuation)
assert.equal(recovered.status, 'continuation-required')
assert.equal(recovered.continuation.reason, 'worker-restarted')
assert.equal(recovered.continuation.handback, undefined)
console.log('ok test-mcp-execution — whole-call isolation, cancelled queue, failure recovery and nonterminal handoff')
