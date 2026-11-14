import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { registerTools } from '../lib/tools.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-feedback-owned-'))
let checks = 0
function check (value, label) { assert.ok(value, label); checks++ }
function fixture ({ model = 'glm-5.3-flash', provider = 'bigmodel-anthropic', enabled = true, images = true, modalities = ['text', 'image'], sourceSize = [200, 100], attachmentSize = [200, 100], onResolve, onAction, shotError, hooks = {} } = {}) {
  const defs = new Map(), controller = new AbortController(), counts = { actions: 0, shots: 0, states: 0, saves: [] }
  const exec = { agent: { id: crypto.randomUUID(), session: { requestHeader: () => ({ config: { provider, model } }) } }, signal: controller.signal }
  const receipt = { ok: true, receiver: { hwnd: 123, editable: true }, preserved: ['raw', 17] }
  const act = async () => { counts.actions++; onAction?.({ cu, controller }); return structuredClone(receipt) }
  const cu = { stopped: false, exited: false, click: act, type: act, key: act, move: act, scroll: act, drag: act, selectRange: act,
    resolveTarget: async p => p,
    screenState: async () => { counts.states++; return { active: { hwnd: 123 }, uiaFlat: [{ name: 'SUCCESS', value: 'verified value' }], uiaTruncated: false } },
    screenshot: async () => { counts.shots++; if (shotError) throw Error(shotError); return { image: Buffer.from('fixture bytes'), mime: 'image/png', region: { x: -100, y: 20, width: 400, height: 200 }, imageSize: sourceSize, capturedAt: 1000, ts: 1010, cursorScreenPos: { x: 0, y: 60 }, cursorInImage: { x: 50, y: 20 }, cursorDrawn: true, settled: true } },
  }
  const attachments = { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async ({ name }) => {
    counts.saves.push(name)
    return { attachmentId: 'fixture', mediaType: 'image/png', width: attachmentSize?.[0], height: attachmentSize?.[1], bytes: 13 }
  } }
  const ctx = { tools: { register: def => defs.set(def.name, def) }, get: name => name === 'attachments' ? images ? attachments : undefined : name === 'llm' ? { resolveModelInfo: async () => { onResolve?.({ cu, controller }); return { inputModalities: modalities } } } : undefined }
  const feedbackRules = [{ provider: 'bigmodel-anthropic', model: 'glm-5.3', adapterVersion: 'unversioned', grounding: 'failed', testedAt: '2000-01-01', expiresAt: '2099-01-01', reason: 'test evidence' }]
  registerTools({ ctx, cu, config: { actionFeedback: enabled, actionFeedbackDetail: 'full', feedbackRules }, defineTool: d => d, dataDir: { root, shots: root }, snapshotPath: () => path.join(root, crypto.randomUUID() + '.jpg'), hooks })
  return { defs, exec, counts, cu, controller, receipt,
    run: async (name, args = {}) => { const d = defs.get(name), value = await d.execute(args, exec); return { value, content: d.output.render(args, value) } },
  }
}
const args = { computer_click: { at: '12,34' }, computer_type: { text: 'hello' }, computer_key: { combo: 'enter' }, computer_move: { at: '12,34' }, computer_drag: { from: '12,34', to: '50,60' }, computer_select: { from: '12,34', to: '50,60' }, computer_scroll: { dir: 'down' } }
for (const route of [{}, { provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'deepseek-account', model: 'deepseek-flash' }, { provider: 'new-provider', model: 'new-image-model' }]) for (const [name, input] of Object.entries(args)) {
  const f = fixture(route), r = await f.run(name, input)
  check(r.content.filter(b => b.type === 'image').length === 1 && f.counts.shots === 1, name + ' one image')
  assert.deepEqual(r.value.preserved, f.receipt.preserved); checks++
  assert.deepEqual(r.value.observation.coordinates, { screenOrigin: [-100, 20], imageSize: [200, 100], screenPerImagePixel: [2, 2] }); checks++
  check(r.value.observation.capturedAt === 1000 && r.value.observation.ts === 1010, 'capture time survives tool wrapper and render')
  assert.deepEqual(r.value.observation.cursorInImage, { x: 50, y: 20 }); checks++
  check(!('sourceImageSize' in r.value.observation) && !('sourceCursorInImage' in r.value.observation), 'unchanged attachment adds no duplicate geometry')
  check(!JSON.stringify(r).includes('undefined'), 'lossless output')
}
for (const attachmentSize of [[100, 50], [100, 25]]) {
  const f = fixture({ attachmentSize }), r = await f.run('computer_shot')
  assert.deepEqual(r.value.imageSize, attachmentSize); checks++
  assert.deepEqual(r.value.coordinates.imageSize, attachmentSize); checks++
  assert.deepEqual(r.value.cursorInImage, { x: attachmentSize[0] / 4, y: attachmentSize[1] / 5 }); checks++
  assert.deepEqual(r.value.sourceImageSize, [200, 100]); checks++
  assert.deepEqual(r.value.sourceCursorInImage, { x: 50, y: 20 }); checks++
  check(r.value.coordinateRule.includes('path retains the original capture') && r.content.filter(b => b.type === 'image').length === 1,
    'resized attachment and original path have explicit distinct coordinate spaces')
}
for (const invalid of [[0, 100], [-1, 100], [Infinity, 100], [NaN, 100], ['200', 100], [200], null]) {
  for (const which of ['sourceSize', 'attachmentSize']) {
    const f = fixture({ [which]: invalid }), r = await f.run('computer_shot')
    check(r.value.imageStatus === 'path-only' && !r.value.image && r.value.path && r.content.every(b => b.type !== 'image'),
      'invalid dimensions retain only a usable source path: ' + which)
    check(r.value.imageReason === (which === 'sourceSize' ? 'invalid-source-image-size' : 'invalid-attachment-image-size'),
      'dimension failure reports the failed channel')
    if (which === 'sourceSize') check(!r.value.coordinates, 'invalid source dimensions never expose click scaling')
    else { assert.deepEqual(r.value.coordinates.imageSize, [200, 100]); checks++ }
  }
}
{
  const f = fixture({ attachmentSize: [100, 50] })
  const r = await f.run('computer_batch', { actions: [{ tool: 'computer_shot', args: {} }, { tool: 'computer_click', args: args.computer_click }] })
  const earlier = r.value.actions[0].result
  check(earlier.imageStatus === 'path-only' && !earlier.image && !earlier.sourceImageSize,
    'demoting an earlier attachment restores source-file geometry')
  assert.deepEqual(earlier.imageSize, [200, 100]); checks++
  assert.deepEqual(earlier.cursorInImage, { x: 50, y: 20 }); checks++
  assert.deepEqual(earlier.coordinates.imageSize, [200, 100]); checks++
  assert.deepEqual(r.value.observation.imageSize, [100, 50]); checks++
  assert.deepEqual(f.counts.saves, [path.basename(r.value.observation.path)]); checks++
}
const shotStep = delivery => ({ tool: 'computer_shot', args: delivery ? { delivery } : {} })
for (const [delivery, modes, saved] of [
  ['auto', [null, null, null], true],
  ['auto', ['path', 'path', null], true],
  ['auto', [null, null, 'path'], false],
  ['path', [null, 'auto', null], false],
  ['path', ['path', 'path', 'path'], false],
]) {
  const f = fixture(), r = await f.run('computer_batch', { delivery, shot: 'never', actions: modes.map(shotStep) })
  const paths = r.value.actions.map(a => a.result.path)
  check(paths.length === f.counts.shots && paths.every(p => fs.existsSync(p)) && new Set(paths).size === 3, 'all three distinct files survive')
  assert.deepEqual(f.counts.saves, saved ? [path.basename(paths[2])] : []); checks++
  check(r.content.filter(b => b.type === 'image').length === Number(saved) &&
    r.value.observation.path === paths[2] && r.value.imageSource.startsWith('action 3;'), 'only the selected explicit frame can be displayed')
}
{
  const f = fixture(), r = await f.run('computer_batch', { actions: [
    shotStep(), { tool: 'unknown' }, shotStep(),
  ] })
  check(f.counts.shots === 1 && !r.value.actions[1].ok && r.value.actions[2].outcome === 'not-dispatched' &&
    r.value.imageSource.startsWith('action 1;'), 'ordinary failure preserves the last completed capture with its step number')
  assert.deepEqual(f.counts.saves, [path.basename(r.value.actions[0].result.path)]); checks++
}
{
  const f = fixture({ onAction: ({ controller }) => controller.abort() })
  const r = await f.run('computer_batch', { actions: [shotStep(), { tool: 'computer_click', args: args.computer_click }] })
  check(r.value.actions[1].ok && fs.existsSync(r.value.observation.path) && f.counts.shots === 1 &&
    f.counts.saves.length === 0 && r.content.every(b => b.type !== 'image'), 'cancellation retains captured file without starting an attachment')
}
{
  const f = fixture(), r = await f.run('computer_batch', { delivery: 'path', actions: [
    shotStep(), shotStep('invalid'), shotStep(),
  ] })
  check(f.counts.shots === 1 && f.counts.saves.length === 0 && r.value.actions[1].code === 'BAD_DELIVERY' &&
    r.value.actions[2].outcome === 'not-dispatched', 'batch path does not mask invalid step delivery')
}
{
  const f = fixture({ onResolve: ({ cu }) => { cu.stopped = true } })
  const r = await f.run('computer_batch', { actions: [shotStep()], shot: 'never' })
  check(f.counts.saves.length === 0 && r.value.observation.imageStatus === 'path-only' && fs.existsSync(r.value.observation.path),
    'brake during deferred attachment lookup suppresses the save without discarding the file')
}
// File-only routes still expose exact image-to-screen mapping and capture age.
{
  const f = fixture({ images: false }), r = await f.run('computer_shot')
  check(r.value.imageStatus === 'path-only' && r.value.capturedAt === 1000, 'file-only capture retains timestamp')
  assert.deepEqual(r.value.coordinates, { screenOrigin: [-100, 20], imageSize: [200, 100], screenPerImagePixel: [2, 2] }); checks++
  check(r.content.every(b => b.type !== 'image') && JSON.stringify(r.content).includes('capturedAt'), 'render retains metadata without fake attachment')
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
for (const opts of [{ enabled: false }]) {
  const f = fixture(opts), r = await f.run('computer_click', args.computer_click)
  check(f.counts.shots + f.counts.states === 0 && !r.value.observation, 'no unsupported automatic capture')
}
for (const shot of ['auto', 'always']) {
  const f = fixture({ enabled: false })
  const r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: args.computer_click }], shot })
  check(f.counts.actions === 1 && f.counts.states === 0 && f.counts.shots === (shot === 'always' ? 1 : 0),
    'disabled feedback suppresses batch auto; explicit always still requests a screenshot')
  if (shot === 'auto') check(r.value.observationSkipped === 'disabled' && r.value.feedback.kind === null,
    'disabled batch feedback is reported without inventing an image policy')
}
for (const shot of ['auto', 'always']) {
  let owner = true
  const f = fixture({ onAction: () => { owner = false }, hooks: { assertOwnership: () => { if (!owner) throw Error('owner changed') } } })
  const r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: args.computer_click }], shot })
  check(r.value.actions[0].ok && r.value.observationError === 'owner changed' && f.counts.shots + f.counts.states === 0,
    'batch feedback cannot read after owner changes; accepted input receipt survives')
}
{
  const f = fixture({ onResolve: ({ controller }) => controller.abort() })
  const r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: args.computer_click }], shot: 'auto' })
  check(r.value.actions[0].ok && r.value.observationSkipped === 'cancelled-or-paused' && f.counts.shots + f.counts.states === 0,
    'batch cancellation during capability lookup suppresses automatic feedback')
}
{
  const f = fixture({ enabled: false, onAction: ({ controller }) => controller.abort() })
  const r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: args.computer_click }], shot: 'always' })
  check(r.value.actions[0].ok && f.counts.shots + f.counts.states === 0,
    'explicit always overrides disabled feedback, never cancellation')
}
for (const opts of [{ images: false }, { modalities: ['text'] }, { onResolve: () => { throw Error('catalog unavailable') } }]) {
  const f = fixture(opts), r = await f.run('computer_click', args.computer_click)
  check(f.counts.states === 1 && f.counts.shots === 0 && r.value.feedback.kind === 'state' && r.value.feedback.reason, 'missing transport uses explained fresh text evidence')
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
  check(f.counts.saves.length === 0, 'a final UIA observation supersedes explicit captures before attachment')
}
console.log(JSON.stringify({ pass: true, checks, artifacts: root }))
