import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createMcpToolSurface, renderMcpResult } from '../mcp/src/tools.js'
import { captureCoordinates } from '../lib/media-contract.js'

// Transport and handler fixtures only: never starts the native worker or injects input.
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const jpeg = Buffer.from([255, 216, 255, 224, 0])
const shot = () => ({ image: png, mime: 'image/png', region: { x: -120, y: 30, width: 400, height: 200 },
  imageSize: [200, 100], capturedAt: 1700, ts: 1720, cursorScreenPos: { x: -20, y: 60 },
  cursorInImage: { x: 50, y: 15 }, settled: false, settleNote: 'fixture moving' })
let checks = 0
function fixture (allowInput = false) {
  const calls = []
  const cu = { stopped: false, exited: false,
    screenshot: async args => { calls.push(['screenshot', args]); return shot() },
    screenState: async () => ({ active: { hwnd: 1 } }),
    marks: async args => { calls.push(['marks', args]); return { ...shot(), image: undefined, annotated: jpeg, marks: [{ id: 'M1' }] } },
    call: async (op, args) => { calls.push([op, args]); return op === 'uia' ? { flat: Array.from({ length: 70 }, (_, i) => ({ name: `b${i}`, role: 'Button' })), count: 70, truncated: false } : { ok: true } },
    indicator: async args => { calls.push(['indicator', args]); return { holding: args.hold } },
    calm: async () => { calls.push(['calm']); return { released: true } },
    key: async (combo, opts) => { calls.push(['key', combo, opts]); return { ok: true } },
    type: async (...args) => { calls.push(['type', ...args]); return { ok: true } },
    drag: async (...args) => { calls.push(['drag', ...args]); return { ok: true } },
    scroll: async (...args) => { calls.push(['scroll', ...args]); return { ok: true } },
    activateWindow: async args => { calls.push(['activate', args]); return { activated: false } },
  }
  return { cu, calls, ...createMcpToolSurface(cu, { allowInput }) }
}

// Model-callable approval cannot mutate host configuration, directly or inside a batch.
{
  const f = fixture()
  assert.equal((await f.run('cu_approve', { minutes: 10 })).approved, false)
  await assert.rejects(f.run('cu_key', { combo: 'enter' }), e => e.code === 'MCP_INPUT_DISABLED' && e.outcome === 'not-dispatched')
  const result = await f.run('cu_batch', { actions: [
    { tool: 'cu_approve', args: { minutes: 10 } }, { tool: 'cu_key', args: { combo: 'enter' } },
  ] })
  assert.equal(result.actions[1].code, 'MCP_INPUT_DISABLED')
  assert.equal(result.actions[1].outcome, 'not-dispatched')
  assert.deepEqual(f.calls, [])
  assert.equal(renderMcpResult('cu_batch', {}, result).isError, true)
  const observed = await f.run('cu_batch', { actions: [{ tool: 'cu_screen_state' }] })
  assert.equal(observed.actions[0].ok, true)
  await f.run('cu_hold'); await f.run('cu_free')
  assert.deepEqual(f.calls, [['indicator', { hold: true }], ['indicator', { hold: false }]])
  checks += 9
}
{
  const f = fixture(true)
  const approval = await f.run('cu_approve', { minutes: 1 })
  assert.equal(approval.approved, false); assert.equal(approval.inputEnabled, true)
  await f.run('cu_key', { combo: ' Escape + CONTROL + shift + control ' })
  assert.equal(f.calls[0][1], 'ctrl+shift+esc')
  await f.run('cu_drag', { fromX: 10, fromY: 20, toX: 50, toY: 60, durationMs: 600, expectCursor: 'resize-ew', hwnd: 12 })
  assert.deepEqual(f.calls[1], ['drag', { x: 10, y: 20 }, { x: 50, y: 60 }, { durationMs: 600, expectCursor: 'resize-ew', expectHwnd: 12 }])
  await f.run('cu_scroll', { direction: 'down', lines: 4, x: 12, y: 34 })
  assert.deepEqual(f.calls[2], ['scroll', 'down', 4, { at: { x: 12, y: 34 } }])
  await assert.rejects(f.run('cu_key', { combo: 'ctrl++a' }), /KEY_COMMAND_INVALID/)
  await assert.rejects(f.run('cu_drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, expectCursor: 'maybe' }), /invalid argument value/)
  await assert.rejects(f.run('cu_batch', { actions: Array(21).fill({ tool: 'cu_screen_state' }) }), /array outside size range/)
  assert.equal(f.calls.length, 3)
  checks += 9
}

// Semantic refusal is shared with DSH and stops subsequent steps, including nested batches.
for (const nested of [false, true]) {
  const f = fixture(true)
  const actions = [{ tool: 'cu_activate_window', args: { hwnd: 42 } }, { tool: 'cu_key', args: { combo: 'enter' } }]
  const result = await f.run('cu_batch', { actions: nested ? [{ tool: 'cu_batch', args: { actions } }, actions[1]] : actions })
  assert.deepEqual(f.calls, [['activate', { hwnd: 42 }]])
  assert.equal(result.actions[0].ok, false)
  assert.equal(result.actions[1].outcome, 'not-dispatched')
  assert.equal(renderMcpResult('cu_batch', {}, result).isError, true)
  assert.equal(renderMcpResult('cu_activate_window', {}, { activated: false }).isError, true)
  checks += 5
}
for (const nested of [false, true]) {
  const f = fixture(true), release = { tool: 'cu_release' }
  const result = await f.run('cu_batch', { actions: [nested ? { tool: 'cu_batch', args: { actions: [release] } } : release, { tool: 'cu_key', args: { combo: 'enter' } }] })
  assert.deepEqual(f.calls, [['calm']]); assert.equal(result.actions[1].outcome, 'not-dispatched')
  assert.equal(result.endedBy.tool, 'cu_release')
  checks += 3
}
for (const nested of [false, true]) {
  const f = fixture(true)
  f.cu.key = async () => { throw Object.assign(Error('human handed back'), { code: 'HUMAN_REOBSERVE', outcome: 'unknown',
    continuation: { required: true, replayInterruptedInput: false } }) }
  const first = { tool: 'cu_key', args: { combo: 'enter' } }, later = { tool: 'cu_type', args: { text: 'unfinished' } }
  const result = await f.run('cu_batch', { actions: [nested ? { tool: 'cu_batch', args: { actions: [first, later] } } : first, later] })
  assert.equal(result.taskStatus, 'continuing'); assert.equal(result.continuation.replayInterruptedInput, false)
  assert.equal(result.continuation.resumeFromActionIndex, 0)
  assert.equal(result.actions[1].status, 'deferred')
  assert.equal(renderMcpResult('cu_batch', {}, result).isError, false)
  assert.deepEqual(f.calls, [])
  if (nested) assert.deepEqual(result.continuation.resumeActionPath, [0, 0])
  checks += 6
}
{
  const f = fixture(true), controller = new AbortController()
  controller.abort()
  await assert.rejects(f.run('cu_key', { combo: 'enter' }, { signal: controller.signal }), e => e.code === 'INPUT_CANCELLED' && e.outcome === 'not-dispatched')
  assert.deepEqual(f.calls, [])
  checks += 2
}

// Exact media, capture geometry, failed-settle metadata, and complete parseable text survive rendering.
{
  const f = fixture(), capture = await f.run('cu_screenshot')
  const rendered = renderMcpResult('cu_screenshot', {}, capture), text = JSON.parse(rendered.content[0].text)
  assert.deepEqual(rendered.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
  assert.deepEqual(text.coordinates, { screenOrigin: [-120, 30], imageSize: [200, 100], screenPerImagePixel: [2, 2] })
  assert.equal(text.capturedAt, 1700); assert.equal(text.settled, false); assert.deepEqual(text.cursorInImage, { x: 50, y: 15 })
  assert.equal(text.image, undefined); assert.equal(text.imageStatus, 'attached')
  assert.equal(capture.image, png)
  assert.equal(captureCoordinates(capture.region, undefined), null)
  assert.equal(captureCoordinates(capture.region, [0, 100]), null)
  const marks = renderMcpResult('cu_marks', {}, await f.run('cu_marks'))
  assert.equal(marks.content[1].mimeType, 'image/jpeg')
  assert.equal(JSON.parse(marks.content[0].text).mime, 'image/jpeg')
  assert.equal(f.calls.at(-1)[1].raw, true)
  const emptyMarks = renderMcpResult('cu_marks', {}, { ...shot(), image: undefined, annotated: null, raw: png, marks: [] })
  assert.equal(emptyMarks.content[1].mimeType, 'image/png')
  const batch = await f.run('cu_batch', { actions: [{ tool: 'cu_screenshot' }, { tool: 'cu_marks' }] })
  const batchRendered = renderMcpResult('cu_batch', {}, batch), batchText = JSON.parse(batchRendered.content[0].text)
  assert.equal(batchRendered.content.filter(b => b.type === 'image').length, 1)
  assert.equal(batchRendered.content[1].mimeType, 'image/jpeg')
  assert.equal(batchText.actions[0].result.imageStatus, 'omitted-earlier-batch-image')
  assert.equal(batchText.actions[1].result.imageStatus, 'attached')
  assert.equal(batchText.imageSource, 'result.actions[1].result')
  assert.doesNotMatch(batchRendered.content[0].text, /"type":\s*"Buffer"/)
  const long = 'complete metadata '.repeat(6000)
  assert.equal(JSON.parse(renderMcpResult('cu_screen_state', {}, { long }).content[0].text).long, long)
  const uia = await f.run('cu_uia_query', { role: 'Button' })
  assert.equal(uia.flat.length, 60); assert.equal(uia.truncated, true); assert.equal(uia.returnedCount, 60)
  checks += 24
}

// Real stdio adapter smoke: initialize/list/approve/input-disabled never loads a worker.
{
  const child = spawn(process.execPath, ['mcp/src/index.js'], { cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { ...process.env, DSH_CU_ALLOW_INPUT: '', DSH_CU_KILL: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const responses = new Map()
  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('MCP stdio smoke timed out: ' + stderr)) }, 10000)
    child.on('error', reject)
    child.stderr.on('data', c => { stderr += c })
    child.stdout.on('data', c => {
      stdout += c
      let nl
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1)
        if (line.trim()) { const msg = JSON.parse(line); responses.set(msg.id, msg) }
      }
      if (responses.size === 4) { clearTimeout(timer); child.stdin.end(); resolve() }
    })
    child.on('exit', code => { if (responses.size !== 4) { clearTimeout(timer); reject(Error(`MCP exited ${code}: ${stderr}`)) } })
  })
  const requests = [
    { id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'cu_approve', arguments: { minutes: 10 } } },
    { id: 4, method: 'tools/call', params: { name: 'cu_key', arguments: { combo: 'enter' } } },
  ]
  for (const request of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n')
  await complete
  assert.equal(responses.get(1).result.serverInfo.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
  assert.ok(responses.get(2).result.tools.some(t => t.name === 'cu_hold'))
  assert.equal(JSON.parse(responses.get(3).result.content[0].text).approved, false)
  assert.equal(responses.get(4).result.isError, true)
  assert.equal(JSON.parse(responses.get(4).result.content[0].text).code, 'MCP_INPUT_DISABLED')
  checks += 5
}
console.log(JSON.stringify({ pass: true, checks, desktopInput: false, nativeWorkerStarted: false }))
