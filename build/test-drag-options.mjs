import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'
import { createMcpToolSurface } from '../mcp/src/tools.js'

const cu = new ComputerUse({ workerExe: 'X:/NOT-STARTED.exe' })
const calls = [], definitions = new Map()
cu.actuate = async (op, args) => {
  calls.push({ op, args })
  return { dragStarted: true, effectVerified: false,
    cursorCheck: { status: args.expectCursor ? 'matched' : 'not-requested', expected: args.expectCursor || null, observed: args.expectCursor || 'unknown' } }
}
cu.resolveTarget = async target => target.mark
  ? { x: 12, y: 34, expectHwnd: 111 }
  : target
registerTools({ ctx: { tools: { register: def => definitions.set(def.name, def) } }, cu,
  config: { actionFeedback: false }, defineTool: def => def,
  dataDir: { root: 'X:/NOT-USED', shots: 'X:/NOT-USED' },
  snapshotPath: () => { throw Error('no capture expected') } })
const args = { from: 'M1', to: '50,60', expectCursor: 'resize-ew', hwnd: 999 }
const matched = await definitions.get('computer_drag').execute(args, {})
assert.equal(matched.cursorCheck.status, 'matched')
assert.equal(matched.effectVerified, false)
await definitions.get('computer_batch').execute({ shot: 'never', actions: [{ tool: 'computer_drag', args }] }, {})
assert.equal(calls.length, 2)
for (const { op, args: native } of calls) {
  assert.equal(op, 'drag')
  assert.equal(native.expectCursor, 'resize-ew')
  assert.equal(native.expectHwnd, 111, 'observed mark identity outranks caller-provided window')
  assert.deepEqual([native.fromX, native.fromY, native.toX, native.toY], [12, 34, 50, 60])
}
const optionalArgs = { from: '12,34', to: '50,60', hwnd: 999 }
const optional = await definitions.get('computer_drag').execute(optionalArgs, {})
assert.equal(calls.at(-1).args.expectCursor, undefined, 'tool never silently inserts a standard-shape expectation')
assert.equal(calls.at(-1).args.expectHwnd, 999, 'window target survives omitted shape check')
assert.equal(optional.cursorCheck.status, 'not-requested')
assert.equal(optional.cursorCheck.expected, null)
assert.equal(optional.effectVerified, false)
const mcp = createMcpToolSurface(cu, { allowInput: true })
const mcpOptional = await mcp.run('cu_drag', { fromX: 12, fromY: 34, toX: 50, toY: 60, hwnd: 999 })
assert.equal(mcpOptional.cursorCheck.status, 'not-requested')
assert.equal(calls.at(-1).args.expectCursor, undefined)
assert.equal(calls.at(-1).args.expectHwnd, 999)

// Feed actual worker-shaped JSON through the core parser, then both tool surfaces.
// This checks preservation of native facts, not merely properties on a hand-built Error.
for (const [status, classification, shape] of [
  ['mismatched', 'standard', 'arrow'], ['unverifiable', 'unrecognized', 'unknown'],
  ['unverifiable', 'not-visible', 'unknown'], ['unverifiable', 'unavailable', 'unknown'],
]) {
  const cursorCheck = { status, expected: 'resize-ew', observed: shape }
  const actualCursor = { shape, classification, available: classification !== 'unavailable', visible: ['standard', 'unrecognized'].includes(classification) }
  let parsedError
  cu.pending.set(777, { op: 'drag', reject: error => { parsedError = error }, resolve: () => assert.fail('refusal was resolved') })
  cu.onLine(JSON.stringify({ id: 777, ok: false, error: status + '; no button pressed',
    code: 'CURSOR_MISMATCH', outcome: 'unknown', dragStarted: false, expectedCursor: 'resize-ew', actualCursor, cursorCheck }))
  assert.deepEqual(parsedError.cursorCheck, cursorCheck)
  assert.deepEqual(parsedError.actualCursor, actualCursor)
  cu.drag = async () => { throw parsedError }
  await assert.rejects(definitions.get('computer_drag').execute(args, {}), error => error === parsedError && error.cursorCheck.status === status)
  const result = await definitions.get('computer_batch').execute({ shot: 'never', actions: [
    { tool: 'computer_drag', args }, { tool: 'computer_drag', args },
  ] }, {})
  assert.equal(result.actions[0].dragStarted, false)
  assert.deepEqual(result.actions[0].actualCursor, actualCursor)
  assert.deepEqual(result.actions[0].cursorCheck, cursorCheck)
  assert.equal(result.actions[0].outcome, 'unknown')
  assert.equal(result.actions[1].outcome, 'not-dispatched')
  const mcpResult = await mcp.run('cu_batch', { actions: [
    { tool: 'cu_drag', args: { fromX: 12, fromY: 34, toX: 50, toY: 60, expectCursor: 'resize-ew', hwnd: 999 } },
    { tool: 'cu_drag', args: { fromX: 12, fromY: 34, toX: 50, toY: 60, hwnd: 999 } },
  ] })
  assert.deepEqual(mcpResult.actions[0].cursorCheck, cursorCheck)
  assert.deepEqual(mcpResult.actions[0].actualCursor, actualCursor)
  assert.equal(mcpResult.actions[0].dragStarted, false)
  assert.equal(mcpResult.actions[1].outcome, 'not-dispatched')
}
console.log('ok test-drag-options — direct/batch DSH/MCP matched/optional/refusal evidence, core JSON preservation and mark ownership; no input')
