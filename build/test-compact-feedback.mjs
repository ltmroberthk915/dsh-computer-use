import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerTools } from '../lib/tools.js'
import { collectCompactState, feedbackViewport, limitCompactFeedback, COMPACT_FEEDBACK_BYTES } from '../lib/compact-feedback.js'
import { selectFeedbackDetail } from '../lib/feedback.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-compact-feedback-'))
try {
let checks = 0
const check = (ok, why) => { assert.ok(ok, why); checks++ }
const jsonBytes = x => Buffer.byteLength(JSON.stringify(x), 'utf8')
const contentBytes = x => x.content.filter(p => p.type === 'text').reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0)
const text = '观察🌏'.repeat(1000)
const probe = { root: { hwnd: 55, pid: 9, title: 'Owned fixture' }, receives: { hwnd: 56, pid: 9, title: 'Editable fixture' },
  element: { name: text, role: 'Edit', value: text, automationId: 'result', rect: { x: 100, y: 200, width: 30, height: 40 } },
  focused: { name: 'Result', role: 'Edit', value: text }, typingWouldReach: true,
  ancestors: Array.from({ length: 10 }, (_, i) => ({ name: text, role: 'Pane', automationId: 'p' + i })) }
const fullState = { active: { hwnd: 55 }, windows: [{ hwnd: 55, title: 'Owned fixture' }],
  uiaFlat: Array.from({ length: 260 }, (_, i) => ({ name: 'irrelevant nearby control '.repeat(6), value: i, role: 'Pane' })), uiaTruncated: false }

function fixture ({ image = false, enabled = true, detail, onCall, onAction, receipt: override, archive, onResolve, shotError } = {}) {
  const defs = new Map(), calls = [], screenshots = [], controller = new AbortController()
  const receipt = override || { ok: true, x: 123, y: 245, changedPct: 17.25, effectVerified: false,
    verification: 'Native receipt: pixels changed; task effect remains unverified.', preserved: { original: 'unchanged' } }
  let acts = 0, states = 0, activations = 0
  const exec = { agent: { id: 'compact-owned', session: { requestHeader: () => ({ config: { provider: 'fixture', model: 'arbitrary-model' } }) } }, signal: controller.signal }
  const act = async () => { acts++; onAction?.(controller); return structuredClone(receipt) }
  const cu = { stopped: false, exited: false, click: act, key: act, type: act, move: act, drag: act, scroll: act, selectRange: act,
    resolveTarget: async target => target,
    activateWindow: async () => { activations++; throw Error('unexpected automatic activation') },
    windowOp: async () => { activations++; throw Error('unexpected automatic window operation') },
    call: async (op, args, timeout) => { calls.push({ op, args, timeout }); onCall?.(op, args, controller); return op === 'cursor' ? { x: 9, y: 8 } : structuredClone(probe) },
    screenState: async () => { states++; return structuredClone(fullState) },
    screenshot: async args => { screenshots.push(args); if (shotError) throw Error(shotError); return { image: Buffer.from('test bytes'), mime: 'image/png', region: { x: args.x ?? 0, y: args.y ?? 0, width: args.width ?? 1000, height: args.height ?? 800 }, imageSize: [1000, 800], capturedAt: 1, ts: 2 } },
  }
  const ctx = { tools: { register: def => defs.set(def.name, def) }, get: name => name === 'llm'
    ? { resolveModelInfo: async () => { onResolve?.(controller); return { inputModalities: image ? ['text', 'image'] : ['text'] } } }
    : name === 'attachments' ? { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async () => ({ attachmentId: 'fixture', mediaType: 'image/png', width: 1000, height: 800, bytes: 10 }) } : undefined }
  registerTools({ ctx, cu, config: { actionFeedback: enabled, actionFeedbackDetail: detail, feedbackRules: [] }, dataDir: { root, shots: root },
    snapshotPath: () => path.join(root, 'test-' + randomUUID() + '.jpg'), defineTool: x => x,
    hooks: { archiveFeedback: archive ? (_, raw) => archive(raw) : undefined } })
  return { calls, screenshots, controller, receipt, cu, counts: () => ({ acts, states, activations }),
    run: async (name, args = {}) => { const def = defs.get(name), value = await def.execute(args, exec); return { value, content: def.output.render(args, value) } } }
}

check(selectFeedbackDetail(undefined) === 'compact' && selectFeedbackDetail('full') === 'full', 'shared detail defaults')
assert.throws(() => selectFeedbackDetail('invalid'), /compact, full or none/); checks++
check(feedbackViewport({}, { verificationRegion: { x: 1, y: 2, width: 340, height: 340 }, x: 20, y: 30 }).region === undefined,
  'native default crop never silently narrows vision')
assert.deepEqual(feedbackViewport({ verificationRegion: '-20,10,200,100' }, { x: 1, y: 2 }).point, { x: 80, y: 60 }); checks++
for (const origin of [0, -1, 123]) {
  assert.deepEqual(feedbackViewport({ verificationRegion: `${origin},${origin},1,1` }).point,
    { x: origin, y: origin }, 'one-pixel region center remains inside the half-open pixel rectangle'); checks++
}

let archived
const compactFixture = fixture({ archive: raw => { archived = raw; return { snapshot: 'Oowned-1' } } })
const compact = await compactFixture.run('computer_click', { at: '1,2' })
check(compactFixture.calls.length === 1 && compactFixture.calls[0].op === 'uiaFromPoint', 'one point query; no window inventory/full tree')
assert.deepEqual(compactFixture.calls[0].args, { x: 123, y: 245 }); checks++
check(compactFixture.calls[0].timeout <= 5000 && compactFixture.calls[0].timeout > 4900, 'healthy point gets up to five seconds')
check(compactFixture.counts().states === 0 && compactFixture.screenshots.length === 0, 'text route never captures or calls screenState')
check(compact.value.observation.snapshot === 'Oowned-1' && archived.probe.element.value === text, 'raw point archive retains full value without emitting it')
check(compact.value.observation.element.value.endsWith('…') && !compact.value.observation.element.value.includes('\ufffd'), 'UTF8 string truncation is marked and valid')
check(compact.value.budget.truncated && compact.value.budget.returnedBytes <= COMPACT_FEEDBACK_BYTES, 'compact feedback envelope strictly bounded')
for (const key of Object.keys(compactFixture.receipt)) { assert.deepEqual(compact.value[key], compactFixture.receipt[key]); checks++ }
check(!JSON.stringify(compact).includes('irrelevant nearby control'), 'full tree not copied into compact output')
{
  const f = fixture({ archive: () => ({ snapshot: 'Omemory-2', cache: { status: 'memory-only', reason: 'ENOSPC', fallback: 'inline', path: 'do-not-invent-or-emit-this-path' } }) })
  const r = await f.run('computer_click', { at: '1,2' })
  assert.deepEqual(r.value.observation.cache, { status: 'memory-only', reason: 'ENOSPC', fallback: 'inline' }); checks++
  check(r.value.observation.snapshot === 'Omemory-2' && f.counts().acts === 1 && !JSON.stringify(r).includes('do-not-invent-or-emit-this-path'), 'disk failure metadata retains memory snapshot and never replays action or emits a fabricated path')
}

const fullFixture = fixture(), full = await fullFixture.run('computer_click', { at: '1,2', feedback: 'full' })
check(fullFixture.counts().states === 1 && fullFixture.calls.length === 0 && full.value.observation.uiaFlat.length === 260, 'explicit full retains original screenState behavior')
check(contentBytes(compact) < contentBytes(full) / 5, 'compact materially reduces synthetic full-tree wire bytes')
for (const opts of [{}, { enabled: false }]) {
  const f = fixture(opts), r = await f.run('computer_click', { at: '1,2', feedback: 'none' })
  check(f.calls.length + f.counts().states + f.screenshots.length === 0 && r.value.verification === f.receipt.verification, 'none preserves receipt with zero observation calls')
}
{
  const f = fixture({ enabled: false }), r = await f.run('computer_click', { at: '1,2', feedback: 'compact' })
  check(f.calls.length === 1 && r.value.feedback.detail === 'compact', 'explicit compact can override disabled automatic feedback')
}
{
  const f = fixture(); await assert.rejects(f.run('computer_click', { at: '1,2', feedback: 'bad' }), /feedback must/)
  check(f.counts().acts === 0, 'invalid detail rejected before input')
}
{
  const f = fixture({ receipt: { ok: false, error: 'HOST-GUARDED', outcome: 'not-dispatched' } }), r = await f.run('computer_click', { at: '1,2' })
  check(r.value.error === 'HOST-GUARDED' && f.calls.length === 0, 'input refusal unchanged and not observed')
}
{
  const f = fixture({ onCall: () => { throw Error('UIA_BUSY') } }), r = await f.run('computer_click', { at: '1,2' })
  check(f.calls.length === 1 && r.value.ok && r.value.effectVerified === false && r.value.observation.errors[0].error === 'UIA_BUSY', 'read error is partial observation; input is neither retried nor rewritten')
}
{
  const f = fixture({ receipt: { ok: true } }), r = await f.run('computer_key', { combo: 'Enter' })
  check(f.calls.map(c => c.op).join(',') === 'cursor,uiaFromPoint' && r.value.observation.point.source === 'current-cursor', 'missing action point reads current cursor once and labels its limitation')
}
for (const onResolve of [c => c.abort(), () => {}]) {
  const f = fixture({ onResolve }), r = await f.run('computer_click', { at: '1,2' })
  check(r.value.ok && (f.controller.signal.aborted ? f.calls.length === 0 : f.calls.length === 1), 'cancel during capability lookup retains action and suppresses reads')
}
{
  let clock = 0
  const calls = []
  const state = await collectCompactState({ call: async (op, args, timeout) => { calls.push({ op, timeout }); clock += op === 'cursor' ? 1000 : 4100; return op === 'cursor' ? { x: 1, y: 2 } : probe } }, { now: () => clock })
  check(state.elementAvailable && state.elapsedMs === 5100 && calls[1].timeout === 5000, '4.1 second healthy UIA read fits six-second plan without retry')
}
for (const explicit of [false, true]) {
  const f = fixture({ image: true, receipt: { ok: true, x: 70, y: 90, verificationRegion: { x: 1, y: 2, width: 340, height: 340 }, verificationSource: 'default-click-region' } })
  const r = await f.run('computer_click', { at: '70,90', ...(explicit ? { verificationRegion: '10,20,300,200' } : {}) })
  check(r.content.filter(b => b.type === 'image').length === 1 && f.calls.length === 0, 'all visual routes retain one actual attachment')
  check(explicit ? f.screenshots[0].x === 10 && f.screenshots[0].width === 300 : f.screenshots[0].x == null && f.screenshots[0].width == null,
    'image cropped only for user-requested region')
}
{
  const f = fixture({ image: true, receipt: { ok: true, verificationSource: 'requested-region', verificationRegion: { x: 2, y: 4, width: 100, height: 80 } } })
  await f.run('computer_click', { at: '1,2' })
  check(f.screenshots[0].x === 2 && f.screenshots[0].height === 80, 'explicit native requested-region receipt may carry crop')
}
for (const image of [false, true]) {
  const f = fixture({ image, receipt: { ok: true, verificationSource: 'requested-region',
    verificationRegion: { x: 0, y: 0, width: 100, height: 100 },
    requestedVerificationRegion: { x: -100, y: 0, width: 200, height: 100 } } })
  await f.run('computer_click', { at: '1,2', verificationRegion: '-100,0,200,100' })
  if (image) {
    const shot = f.screenshots[0]
    assert.deepEqual({ x: shot.x, y: shot.y, width: shot.width, height: shot.height }, { x: 0, y: 0, width: 100, height: 100 }); checks++
    check(f.calls.length === 0, 'clipped visual region retains existing image route without extra point query')
  } else {
    assert.deepEqual(f.calls[0].args, { x: 50, y: 50 }); checks++
    check(f.calls.length === 1 && f.screenshots.length === 0, 'text observation uses actual clipped region center once')
  }
}
{
  const f = fixture({ image: true, receipt: { ok: true, combo: 'alt+tab', reobserveRequired: true,
    receiverChanged: true, effectVerified: false, hint: 'Inspect and activate before continuing.' },
    shotError: 'KICKOFF-FOCUS-REQUIRED: this worker has no confirmed target for the current cycle' })
  const r = await f.run('computer_key', { combo: 'alt+tab' })
  for (const key of Object.keys(f.receipt)) { assert.deepEqual(r.value[key], f.receipt[key]); checks++ }
  check(String(r.value.observationError).includes('KICKOFF-FOCUS-REQUIRED'), 'post-key screenshot refusal is recorded separately from retained input receipt')
  check(f.counts().acts === 1 && f.screenshots.length === 1 && f.counts().activations === 0 && f.calls.length === 0,
    'failed auto observation neither repeats key nor activates a target')
}
for (const detail of ['compact', 'full', 'none']) {
  const f = fixture(), r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: { at: '1,2', verificationRegion: '100,200,60,40' } }], feedback: detail })
  check(f.counts().acts === 1 && (detail === 'compact' ? f.calls.length === 1 : detail === 'full' ? f.counts().states === 1 : f.calls.length + f.counts().states === 0), 'one final batch checkpoint with unified detail: ' + detail)
  if (detail === 'compact') { assert.deepEqual(f.calls[0].args, { x: 130, y: 220 }); checks++ }
  check(r.value.actions[0].result.changedPct === 17.25, 'batch retains native receipt')
}
{
  const f = fixture({ image: true }), r = await f.run('computer_batch', { actions: [{ tool: 'computer_click', args: { at: '1,2' } }] })
  check(f.screenshots.length === 1 && r.content.filter(p => p.type === 'image').length === 1, 'compact visual batch does not lose attachment')
}
for (const envelope of [
  { observation: { element: { value: text.repeat(100) } }, feedback: { detail: 'compact', kind: 'state' }, verification: 'read back before claiming success' },
  { observation: { unexpectedHugeProviderField: text.repeat(100) }, feedback: { huge: text.repeat(100), kind: 'state' }, verification: text.repeat(100) },
]) {
  const limited = limitCompactFeedback(envelope)
  check(jsonBytes(limited) <= 6144 && limited.budget.returnedBytes === jsonBytes(limited) && limited.budget.truncated, 'hostile oversized observation still obeys exact UTF8 budget')
}
const report = { pass: true, checks, fixtureOnly: true, nativeInput: false,
  comparison: { fullTextBytes: contentBytes(full), compactTextBytes: contentBytes(compact), compactEnvelopeLimit: 6144,
    fullUiTreeNodes: 260, compactCoreReads: compactFixture.calls.length, fullCallsHiddenInsideScreenState: 'existing implementation uses windows+cursor+uia; this test stubs screenState' },
  latency: 'Only timeout arguments and deterministic simulated 4.1s UIA timing verified; no real-machine latency claim.', temporaryArtifactsRemoved: true }
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
} finally {
  const target = path.resolve(root), expectedParent = path.resolve(os.tmpdir())
  assert.equal(path.dirname(target), expectedParent, 'cleanup stays within this test temporary parent')
  assert.ok(path.basename(target).startsWith('cu-compact-feedback-'), 'cleanup only the owned mkdtemp directory')
  fs.rmSync(target, { recursive: true, force: true })
}
