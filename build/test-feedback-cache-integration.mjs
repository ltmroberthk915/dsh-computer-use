import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerTools } from '../lib/tools.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-feedback-cache-'))
try {
const definitions = new Map(), calls = []
let cycles = 0, inputs = 0
const cu = { workerGeneration: 'first', stateSeq: 0, cooperation: { revision: 0 },
  async click () { inputs++; return { x: 50, y: 60, changedPct: 0, effectVerified: false } },
  async call (op) {
    calls.push(op)
    if (op === 'uiaFromPoint') return { element: { name: 'pause', role: 'Image', value: 'full local evidence '.repeat(200) }, ancestors: [] }
    if (op === 'uia') return { count: 1, flat: [{ target: 'owned-target', name: 'Pause', runtimeId: 'fixture' }], hwnd: 42, pid: 8, truncated: false }
    throw Error('Unexpected read: ' + op)
  },
  uiaAct () { inputs++; return {} },
}
const owner = { agent: {} }, foreign = { agent: {} }
registerTools({ ctx: { tools: { register: d => definitions.set(d.name, d) } }, cu, config: {},
  dataDir: { root, shots: root }, defineTool: d => d, ensureCycle: async () => { cycles++ },
  snapshotPath: () => { throw Error('Image not requested') } })
const run = (tool, args, exec = owner) => definitions.get(tool).execute(args, exec)
const click = await run('computer_click', { at: '50,60' })
assert.equal(inputs, 1); assert.deepEqual(calls, ['uiaFromPoint'])
assert.equal(click.observation.element.name, 'pause'); assert.equal(click.effectVerified, false)
const snapshot = click.observation.snapshot
assert.match(snapshot, /^O/)
const retained = await run('computer_state', { snapshot })
assert.equal(retained.snapshotHistorical, true)
assert.equal(retained.probe.element.value, 'full local evidence '.repeat(200))
assert.equal(retained.archive.status, 'saved'); assert(fs.existsSync(retained.archive.path))
assert.deepEqual(calls, ['uiaFromPoint'], 'historical retrieval never re-observes or replays input')
await assert.rejects(run('computer_state', { snapshot }, foreign), /OBSERVATION_UNAVAILABLE/)
const query = await run('computer_uia', { hwnd: 42, name: 'Pause' })
cu.workerGeneration = 'replacement'
await assert.rejects(run('computer_uia_act', { target: 'owned-target', action: 'invoke' }), /TARGET_NOT_OBSERVED/)
assert.equal(inputs, 1)
const historical = await run('computer_uia', { snapshot: query.observation })
assert.equal(historical.targetsValid, false)
cu.stopped = true
const before = { cycles, calls: calls.length, inputs }
const cleared = await run('computer_ctrl', { action: 'clear_cache' })
assert(cleared.cleared >= 2); assert.equal(cleared.filesRemoved, 1)
assert.equal(cleared.desktopInput, false)
assert.deepEqual({ cycles, calls: calls.length, inputs }, before, 'local clear does not open a cycle or use the computer')
assert.equal(fs.existsSync(retained.archive.path), false)
assert.equal((await run('computer_ctrl', { action: 'clear_cache' })).cleared, 0)

// Exercise the actual action adapter and renderer, not only the compact helper.
// A cache failure must not discard the sole remaining copy of its large probe.
const pressureCases = []
for (const mode of ['memory-pressure', 'archive-throws', 'memory-only']) {
  const defs = new Map(), counts = { actions: 0, reads: [], archives: 0, screenshots: 0, fullStates: 0 }
  const exec = { agent: {} }, caseRoot = path.join(root, mode)
  fs.mkdirSync(caseRoot)
  const largeValue = '完整原始证据🙂 ' + '保留全部字段 '.repeat(1800) + ' END-OF-RAW-VALUE'
  const probe = {
    root: { hwnd: 42, pid: 8, title: 'Fixture title '.repeat(100) },
    receives: { hwnd: 42, pid: 8, active: true },
    element: { name: 'Pressure fixture', role: 'Edit', value: largeValue,
      opaqueProviderEvidence: { details: largeValue + '-opaque', complete: true } },
    ancestors: Array.from({ length: 8 }, (_, index) => ({ name: `ancestor-${index}`, role: 'Pane', value: largeValue })),
    focused: { name: 'Editor', value: largeValue }, typingWouldReach: true,
  }
  let archivedRaw
  const nativeReceipt = { x: 50, y: 60, effectVerified: false, preservedReceipt: ['one-action', 17] }
  const fake = {
    workerGeneration: 'pressure-fixture', stateSeq: 0, cooperation: { revision: 0 },
    async click () { counts.actions++; return structuredClone(nativeReceipt) },
    async call (op, params) {
      counts.reads.push({ op, params })
      assert.equal(op, 'uiaFromPoint', 'cache pressure never triggers a broad tree query or retry')
      return structuredClone(probe)
    },
    async screenshot () { counts.screenshots++; throw Error('Pressure fallback must not take an image') },
    async screenState () { counts.fullStates++; throw Error('Pressure fallback must not recollect full state') },
  }
  registerTools({ ctx: { tools: { register: def => defs.set(def.name, def) } }, cu: fake,
    config: { actionFeedbackDetail: 'compact' }, dataDir: { root: caseRoot, shots: caseRoot },
    defineTool: def => def, ensureCycle: async () => {},
    snapshotPath: () => { throw Error('Pressure fallback must not allocate a screenshot') },
    hooks: { archiveFeedback: async (actualExec, raw) => {
      counts.archives++; assert.equal(actualExec, exec); archivedRaw = structuredClone(raw)
      if (mode === 'archive-throws') throw Error('fixture archive write failed')
      if (mode === 'memory-only') return { snapshot: 'O-retained-in-memory', archive: { status: 'memory-only', reason: 'disk-unavailable', fallback: 'memory' } }
      return { archive: { status: 'uncached', reason: 'memory-pressure', fallback: 'inline' } }
    } },
  })
  const definition = defs.get('computer_click'), args = { at: '50,60' }
  const value = await definition.execute(args, exec)
  const content = definition.output.render(args, value)
  const rendered = content.filter(block => block.type === 'text').map(block => {
    try { return JSON.parse(block.text) } catch { return null }
  }).find(item => item?.feedback && item?.observation)
  assert.ok(rendered, 'actual tool renderer exposes the feedback observation')
  assert.deepEqual(value.preservedReceipt, nativeReceipt.preservedReceipt)
  assert.equal(value.effectVerified, false, 'resource fallback cannot upgrade input into verified effect')
  assert.deepEqual(counts, { actions: 1, reads: [{ op: 'uiaFromPoint', params: { x: 50, y: 60 } }],
    archives: 1, screenshots: 0, fullStates: 0 }, 'one action, one point read, one archive attempt, no secondary work')
  assert.deepEqual(archivedRaw.probe, probe, 'archive is offered complete evidence before summary clipping')
  const envelopeBytes = Buffer.byteLength(JSON.stringify(rendered), 'utf8')
  if (mode === 'memory-only') {
    assert.equal(value.feedback.detail, 'compact')
    assert.equal(value.observation.snapshot, 'O-retained-in-memory')
    assert.equal(value.observation.cache.status, 'memory-only')
    assert.equal(Object.hasOwn(value.observation, 'inlineEvidence'), false, 'a usable retained snapshot stays compact')
    assert.ok(value.observation.element.value.length < largeValue.length)
    assert.ok(value.budget.returnedBytes <= 6144 && envelopeBytes <= 6144, 'memory-only snapshot still obeys 6 KiB envelope cap')
  } else {
    assert.equal(value.feedback.detail, 'full')
    assert.match(value.feedback.reason, /cache.*unavailable.*inline/i, 'resource fallback is explained')
    assert.equal(value.observation.cache.status, 'uncached')
    assert.equal(value.observation.cache.fallback, 'inline')
    assert.equal(value.observation.cache.reason, mode === 'memory-pressure' ? 'memory-pressure' : 'cache-unavailable')
    assert.equal(Object.hasOwn(value.observation, 'snapshot'), false, 'uncached evidence never advertises a false snapshot')
    assert.equal(Object.hasOwn(rendered.observation, 'snapshot'), false)
    assert.deepEqual(value.observation.inlineEvidence, archivedRaw, 'lossless tool result retains all original fields')
    assert.deepEqual(rendered.observation.inlineEvidence, archivedRaw, 'renderer also retains all original fields')
    assert.equal(value.observation.inlineEvidence.probe.element.value, largeValue)
    assert.equal(value.observation.inlineEvidence.probe.ancestors.length, 8)
    assert.ok(envelopeBytes > 6144, 'only the explicit uncached fallback escapes the compact byte cap')
    assert.equal(Object.hasOwn(value, 'budget'), false, 'full fallback must not claim the compact limit was applied')
    if (mode === 'archive-throws') assert.equal(value.observation.archiveError, 'fixture archive write failed')
  }
  pressureCases.push({ mode, passed: true, envelopeBytes, actions: counts.actions, pointReads: counts.reads.length })
}
console.log(JSON.stringify({ pass: true, nativeInput: false, localCacheLifecycle: true, pressureCases, directory: root }))
} finally {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cu-feedback-cache-')) throw Error('unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
}
