// Exercise production core/tools with an isolated transport: no native input or latches.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ComputerUse, discoverWorker } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'

let checks = 0
async function fixture() {
  const cu = new ComputerUse({ workerExe: 'X:/NEVER-STARTED.exe' })
  const definitions = new Map(), writes = [], reads = []
  const frame = { hwnd: 10, pid: 20, sig: 'A', region: { x: 0, y: 0, width: 800, height: 600 } }
  cu.frameSig = async () => structuredClone(frame)
  cu.call = async (op, args) => {
    reads.push({ op, args })
    if (op === 'uia') return { flat: [{ name: 'Save', role: 'Button', rect: { x: 80, y: 180, width: 40, height: 40 } }], count: 1, scanned: 2, truncated: false }
    if (op === 'cursor') return { x: 0, y: 0 }
    if (op === 'annotate') return { image: Buffer.from('test').toString('base64') }
    throw Error('unexpected read: ' + op)
  }
  cu.actuate = async (op, args) => { writes.push({ op, args }); return { ok: true } }
  cu.screenshot = async () => ({ image: Buffer.from('test'), region: frame.region })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mark-test-'))
  registerTools({ ctx: { tools: { register: d => definitions.set(d.name, d) } }, cu, config: {}, dataDir: { root: dir, shots: dir }, log: { warn() {} }, snapshotPath: () => path.join(dir, 'annotated.jpg'), defineTool: d => d })
  const map = await cu.landmarks()
  return { cu, frame, map, definitions, writes, reads, dir }
}
const owned = []
try {
  for (const offset of [{ dx: 7, dy: 9 }, { dx: -8, dy: 3 }, { dx: 0, dy: 0 }, { dx: 4, dy: -6, shift: true }, { atMark: true, dx: 3, dy: 2 }]) {
    const f = await fixture(); owned.push(f.dir)
    const args = { ...offset, ...(offset.atMark ? { at: f.map.marks[0].id } : { mark: f.map.marks[0].id }) }
    delete args.atMark
    await f.definitions.get('computer_click').execute(args, {})
    await f.definitions.get('computer_batch').execute({ actions: [{ tool: 'computer_click', args }], shot: 'never' }, {})
    assert.equal(f.writes.length, 2)
    for (const w of f.writes) {
      assert.equal(w.args.x, 100 + offset.dx); assert.equal(w.args.y, 200 + offset.dy)
      assert.equal(w.args.expectHwnd, 10)
    }
    checks++
  }
  for (const change of ['unchanged', 'pixels', 'position', 'hwnd', 'pid', 'refresh', 'unavailable']) {
    const f = await fixture(); owned.push(f.dir); const id = f.map.marks[0].id
    if (change === 'pixels') f.frame.sig = 'B'
    if (change === 'position') f.frame.region.x = 400
    if (change === 'hwnd') f.frame.hwnd = 11
    if (change === 'pid') f.frame.pid = 21
    if (change === 'refresh') await f.cu.landmarks({ refresh: true })
    if (change === 'unavailable') f.cu.frameSig = async () => { throw Error('closed') }
    if (change === 'unchanged') { await f.cu.click({ mark: id }); assert.equal(f.writes.length, 1) }
    else { await assert.rejects(f.cu.click({ mark: id }), e => e.code === 'STALE_MARK' && e.outcome === 'not-dispatched'); assert.equal(f.writes.length, 0) }
    checks++
  }
  const f = await fixture(); owned.push(f.dir)
  await f.cu.landmarks(); await f.cu.landmarks()
  assert.equal(f.reads.filter(r => r.op === 'uia').length, 1); checks++
  const refreshed = await f.cu.landmarks({ refresh: true })
  const annotated = await f.cu.marks({ landmarkMap: refreshed })
  assert.equal(annotated.marks[0].id, refreshed.marks[0].id)
  assert.equal(f.reads.find(r => r.op === 'annotate').args.marks[0].id, refreshed.marks[0].id)
  await f.cu.click({ mark: refreshed.marks[0].id }); checks++
  const render = f.definitions.get('computer_marks').output.render({}, { count: 1, hwnd: 10, marks: [{ id: 'M9', role: 'Button', name: 'Save', center: [1, 2] }], annotatedShot: 'C:/owned/marks.jpg' })
  assert.match(render[0].text, /C:\/owned\/marks.jpg/); checks++
  const args = { hwnd: 10, role: 'Button', id: 'save', name: 'Save', limit: 3, depth: 22 }
  await f.definitions.get('computer_uia').execute(args, {})
  await f.definitions.get('computer_batch').execute({ actions: [{ tool: 'computer_uia', args }], shot: 'never' }, {})
  const last = f.reads.filter(r => r.op === 'uia').slice(-2)
  assert.deepEqual(last[0], last[1]); assert.equal(last[0].args.automationId, 'save'); assert.equal(last[0].args.query, true); assert.equal(last[0].args.limit, 3); checks++
  f.cu.uiaAct = async a => { f.writes.push(a); return { ok: true } }
  await f.definitions.get('computer_uia_act').execute(args, {})
  await f.definitions.get('computer_batch').execute({ actions: [{ tool: 'computer_uia_act', args }], shot: 'never' }, {})
  const acts = f.writes.slice(-2); assert.deepEqual(acts[0], acts[1]); assert.equal(acts[0].requireUnique, true); assert.equal(acts[0].depth, 22); assert.equal(acts[0].automationId, 'save'); checks++
  f.cu.screenshot = async () => { f.frame.sig = 'changed-during-capture'; return { image: Buffer.from('x'), region: f.frame.region } }
  await assert.rejects(f.cu.marks({ landmarkMap: refreshed }), /STALE_MARK/); checks++
  // A newer unrelated cache entry must never win over the current source hash.
  const local = process.env.LOCALAPPDATA, cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discovery-test-')); owned.push(cache)
  try {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(new URL('../lib/core/worker.cs', import.meta.url))).digest('hex').slice(0, 16).toUpperCase()
    const compiled = path.join(local || '', 'dsh-computer-use/worker', sha, 'dsh-computer-use-worker.exe')
    assert.ok(fs.existsSync(compiled), 'compile the current worker before running this guard')
    process.env.LOCALAPPDATA = cache
    const wrong = path.join(cache, 'dsh-computer-use/worker/FFFF-TEST'); fs.mkdirSync(wrong, { recursive: true }); fs.copyFileSync(compiled, path.join(wrong, 'dsh-computer-use-worker.exe'))
    assert.equal(discoverWorker(), null); checks++
  } finally { if (local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = local }
  console.log('ok test-control-targets — ' + checks + ' behavioral cases, isolated transport')
} finally {
  // Every target is a freshly allocated, task-owned temp directory listed above.
  for (const dir of owned) { if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup'); fs.rmSync(dir, { recursive: true, force: true }) }
}
