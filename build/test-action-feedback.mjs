import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { registerTools } from '../lib/tools.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-feedback-owned-'))
let checks = 0
function check (value, label) { assert.ok(value, label); checks++ }
function fixture ({ model = 'glm-5.3-flash', provider = 'bigmodel-anthropic', enabled = true, images = true, onResolve, onAction, shotError, hooks = {} } = {}) {
  const defs = new Map(), controller = new AbortController(), counts = { actions: 0, shots: 0, states: 0 }
  const exec = { agent: { id: crypto.randomUUID(), session: { requestHeader: () => ({ config: { provider, model } }) } }, signal: controller.signal }
  const receipt = { ok: true, receiver: { hwnd: 123, editable: true }, preserved: ['raw', 17] }
  const act = async () => { counts.actions++; onAction?.({ cu, controller }); return structuredClone(receipt) }
  const cu = { stopped: false, exited: false, click: act, type: act, key: act, move: act, scroll: act, drag: act, selectRange: act,
    resolveTarget: async p => p,
    screenState: async () => { counts.states++; return { active: { hwnd: 123 }, uiaFlat: [{ name: 'SUCCESS', value: 'verified value' }], uiaTruncated: false } },
    screenshot: async () => { counts.shots++; if (shotError) throw Error(shotError); return { image: Buffer.from('fixture bytes'), mime: 'image/png', region: { x: -100, y: 20, width: 400, height: 200 }, settled: true } },
  }
  const attachments = { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async () => ({ attachmentId: 'fixture', mediaType: 'image/png', width: 200, height: 100, bytes: 13 }) }
  const ctx = { tools: { register: def => defs.set(def.name, def) }, get: name => name === 'attachments' ? images ? attachments : undefined : name === 'llm' ? { resolveModelInfo: async () => { onResolve?.({ cu, controller }); return { inputModalities: ['text', 'image'] } } } : undefined }
  registerTools({ ctx, cu, config: { actionFeedback: enabled }, defineTool: d => d, dataDir: { root, shots: root }, snapshotPath: () => path.join(root, crypto.randomUUID() + '.jpg'), hooks })
  return { defs, exec, counts, cu, controller, receipt,
    run: async (name, args = {}) => { const d = defs.get(name), value = await d.execute(args, exec); return { value, content: d.output.render(args, value) } },
  }
}
const args = { computer_click: { at: '12,34' }, computer_type: { text: 'hello' }, computer_key: { combo: 'enter' }, computer_move: { at: '12,34' }, computer_drag: { from: '12,34', to: '50,60' }, computer_select: { from: '12,34', to: '50,60' }, computer_scroll: { dir: 'down' } }
for (const route of [{}, { provider: 'deepseek-official', model: 'deepseek-flash' }]) for (const [name, input] of Object.entries(args)) {
  const f = fixture(route), r = await f.run(name, input)
  check(r.content.filter(b => b.type === 'image').length === 1 && f.counts.shots === 1, name + ' one image')
  assert.deepEqual(r.value.preserved, f.receipt.preserved); checks++
  assert.deepEqual(r.value.observation.coordinates, { screenOrigin: [-100, 20], imageSize: [200, 100], screenPerImagePixel: [2, 2] }); checks++
  check(!JSON.stringify(r).includes('undefined'), 'lossless output')
}
for (const model of ['glm-5.3-flash', 'glm-5.3']) {
  const f = fixture({ model }), r = await f.run('computer_batch', { actions: Object.entries(args).map(([tool, args]) => ({ tool, args })) })
  check(f.counts.actions === 7 && f.counts.shots + f.counts.states === 1, 'one final batch checkpoint')
  check(model === 'glm-5.3' ? r.value.feedback.kind === 'state' && r.content.every(b => b.type !== 'image') : r.content.filter(b => b.type === 'image').length === 1, 'batch route selection')
}
{
  const f = fixture({ model: 'glm-5.3' }), r = await f.run('computer_click', args.computer_click)
  check(f.counts.states === 1 && f.counts.shots === 0 && r.value.observation.uiaFlat[0].name === 'SUCCESS', 'Max uses fresh UIA state')
  const s = await f.run('computer_shot')
  check(s.value.visionStatus === 'unverified-route' && s.value.image && s.value.path && !s.value.view.includes('Inspect it directly'), 'Max explicit image retained with truthful warning')
}
for (const opts of [{ enabled: false }, { model: 'unknown-model' }, { provider: 'unverified-provider' }, { images: false }]) {
  const f = fixture(opts), r = await f.run('computer_click', args.computer_click)
  check(f.counts.shots + f.counts.states === 0 && !r.value.observation, 'no unsupported automatic capture')
}
for (const onAction of [({ cu }) => { cu.stopped = true }, ({ cu }) => { cu.exited = true }, ({ controller }) => controller.abort()]) {
  const f = fixture({ onAction }), r = await f.run('computer_click', args.computer_click)
  check(r.value.ok && f.counts.shots === 0, 'brake/cancel after input retains receipt without capture')
}
for (const onResolve of [({ cu }) => { cu.stopped = true }, ({ controller }) => controller.abort()]) {
  const f = fixture({ onResolve }), r = await f.run('computer_click', args.computer_click)
  check(r.value.ok && f.counts.shots === 0, 'brake/cancel during route resolution')
}
{
  const f = fixture({ shotError: 'fixture capture failed' }), r = await f.run('computer_type', args.computer_type)
  check(r.value.ok && r.value.observationError === 'fixture capture failed' && r.value.verification.includes('before repeating'), 'capture failure never erases successful input')
}
{
  const f = fixture(); f.cu.click = async () => ({ ok: false, error: 'HUMAN_POINTER_ACTIVE' })
  const r = await f.run('computer_click', args.computer_click)
  check(r.value.ok === false && f.counts.shots === 0, 'no feedback after refused input')
  const b = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: args.computer_click }, { tool: 'computer_type', args: args.computer_type }] })
  check(b.value.actions[1].outcome === 'not-dispatched' && f.counts.shots === 0, 'batch failure still stops and skips capture')
}
for (const shot of ['never', 'auto']) {
  const f = fixture(), actions = [{ tool: 'computer_click', args: args.computer_click }, ...(shot === 'auto' ? [{ tool: 'computer_state', args: {} }] : [])]
  await f.run('computer_batch', { actions, shot })
  check(f.counts.shots === 0, 'never/explicit final readback avoids redundant image')
}
{
  const f = fixture({ model: 'glm-5.3' }), r = await f.run('computer_batch', { actions: [{ tool: 'computer_shot', args: {} }, { tool: 'computer_click', args: args.computer_click }] })
  check(r.value.observationSource === 'automatic final UIA state' && !r.value.imageSource, 'state checkpoint is never labelled as an earlier screenshot')
  check(r.value.actions[0].result.imageStatus === 'path-only' && r.value.actions[0].result.path && !r.value.actions[0].result.image, 'earlier explicit image path retained without claiming attachment')
}
console.log(JSON.stringify({ pass: true, checks, artifacts: root }))
