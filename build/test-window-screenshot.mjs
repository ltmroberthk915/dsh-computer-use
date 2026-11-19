import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerTools } from '../lib/tools.js'

// The host may resize attachments on each axis. Exercise the registered tool and
// batch paths without sending any OS input or using a real user's screenshots.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-frame-'))
const actions = [], definitions = new Map()
let cycleId = 1
const exec = { agent: { options: { provider: 'fixture', model: 'fixture' } } }
const cu = {
  screenshot: async () => ({ hwnd: 12, shotGeometry: 'fixed', shotWitness: 'local-pixels', image: Buffer.from('test'),
    mime: 'image/png', region: { x: -100, y: 600, width: 200, height: 160 }, imageSize: [200, 160] }),
  click: async (point, options) => { actions.push({ point, options }); return { ok: true } },
}
const ctx = { get: name => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } :
  { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async () => ({ width: 100, height: 40, attachmentId: 'fixture' }) } }
registerTools({ ctx, cu, register: def => definitions.set(def.name, def), defineTool: def => def,
  hooks: { contextOf: () => ({cycleId}) }, config: { actionFeedback: false }, dataDir: { root: dir, shots: dir },
  snapshotPath: () => path.join(dir, 'shot-' + randomUUID() + '.jpg') })
const run = (tool, args, owner = exec) => definitions.get('computer_' + tool).execute(args, owner)
try {
  // OCR rectangles and text centers are expressed in physical screen coordinates.
  // Sorting native column-first lines should keep the words of a CJK label together.
  const lines = [
    {text:'A4', words:[{text:'A4',x:190,y:91,w:20,h:12}]},
    {text:'纸张大小', words:[{text:'纸张',x:-80,y:90,w:25,h:14},{text:'大小',x:-50,y:90,w:25,h:14}]},
    {text:'Copies 12', words:[{text:'Copies',x:-80,y:45,w:50,h:14},{text:'12',x:190,y:46,w:20,h:12}]},
  ]
  cu.ocr = async params => {
    assert.deepEqual(params, {hwnd:12,x:-120,y:21,width:350,height:120,scale:1})
    return {hwnd:12,language:'zh-Hans-CN',region:[-100,21,330,120],requestedRegion:[-120,21,350,120],scale:1,lines}
  }
  const ocr = await run('ocr',{hwnd:12,region:'  -120,21,350,120  ',scale:1})
  const [message] = definitions.get('computer_ocr').output.render({},ocr)
  assert.equal(message.type,'text')
  assert.match(message.text,/clippedFrom=-120,21,350,120/)
  assert.match(message.text,/@-55,52 Copies  \|  @200,52 12\n@-53,97 纸张大小  \|  @200,97 A4/)
  assert.deepEqual(ocr.lines,lines)
  await assert.rejects(run('ocr',{hwnd:12,region:'0,0,-1,10'}),/region/)
  await assert.rejects(run('ocr',{hwnd:12,region:'0,0,2147483648,20'}),/32-bit/)
  await assert.rejects(run('ocr',{hwnd:12,scale:3}),/scale/)


  const shot = await run('shot', { hwnd: 12 })
  assert.deepEqual(shot.imageSize, [100, 40])
  const args = { screenshotId: shot.screenshotId, x: 25, y: 20 }
  await run('click', args)
  assert.deepEqual(actions[0].point, { x: -49, y: 682 })
  assert.equal(actions[0].options.expectHwnd, 12)
  assert.equal(actions[0].options.shotGeometry, 'fixed')
  assert.equal(actions[0].options.shotWitness, 'local-pixels')
  await assert.rejects(run('click', args, { agent: {} }), /STALE_SCREENSHOT/)
  await assert.rejects(run('click', { ...args, x: 100 }), /outside/)
  await assert.rejects(run('click', { ...args, at: '1,1' }), /either/)
  const batch = await run('batch', { actions: [{ tool: 'computer_shot', args: { hwnd: 12 } }], shot: 'never' })
  await run('click', { screenshotId: batch.observation.screenshotId, at: '25,20' })
  assert.deepEqual(actions[1].point, actions[0].point)
  cycleId++
  await assert.rejects(run('click', args), /STALE_SCREENSHOT/)
  const file = await run('shot', { hwnd: 12, delivery: 'path' })
  await run('click', { screenshotId: file.screenshotId, at: '25,20' })
  assert.deepEqual(actions[2].point, { x: -75, y: 620 })
  await run('ctrl', { action: 'clear_cache' })
  await assert.rejects(run('click', { screenshotId: file.screenshotId, at: '25,20' }), /STALE_SCREENSHOT/)
  assert.equal(actions.length, 3)
  const visible = cu.screenshot
  cu.screenshot = async () => ({ ...(await visible()), captureBackend: 'windows-graphics-capture', shotGeometry: undefined })
  const covered = await run('shot', { hwnd: 12 })
  assert.equal(covered.captureBackend, 'windows-graphics-capture')
  assert.equal(covered.hwnd, 12)
  assert.equal(covered.screenshotId, undefined)
  cu.screenshot = async () => ({ ...(await visible()), settled: false })
  assert.equal((await run('shot', { hwnd: 12 })).screenshotId, undefined)
  console.log('ok window screenshots: rendered dimensions, path, batch, negative origin, agent/cycle/cache boundaries')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
