// Tool-layer CONTRACT test for the new public parameters (CUA-IMPL-PUBLIC), runnable without a
// worker process.
//
// This deliberately is NOT an end-to-end test and says so in its own output: it drives the REAL
// registered computer_uia / computer_uia_act / computer_batch execute functions from lib/tools.js
// against a RECORDING core, so what it proves is exactly what belongs to this layer —
//   * actions:true reaches the worker op as `actions:true` and only when asked;
//   * selectionType and the two scroll axis parameters are forwarded unchanged;
//   * the point/percentage contract reaches `setScrollPercent` with the axis names the worker reads;
//   * batch reuses the same tool bodies.
// What it does NOT prove: that the worker implements them (that is test-uia-feature.mjs, which runs
// the shipped worker source) or that a live desktop grants the worker a pipe (test-uia-public-smoke.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerTools } from '../lib/tools.js'

const resultsPath = process.env.CUA_UIA_FEATURE_RESULTS || null
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uia-contract-'))
const rows = []
const record = (name, ok, detail) => {
  rows.push({ name, ok: !!ok, detail })
  console.log(JSON.stringify(rows[rows.length - 1]))
}

try {
  const calls = []
  const definitions = new Map()
  // A recording core: the shape ComputerUse exposes, capturing each op+args the tool layer sends.
  const cu = {
    workerGeneration: 'contract',
    cooperation: { revision: 0 },
    stateSeq: 0,
    call: async (op, args) => { calls.push({ op, args }); return { count: 1, flat: [], scanned: 1, truncated: false, hwnd: args?.hwnd, pid: 1 } },
    uiaAct: args => { calls.push({ op: 'uiaAct', args }); return { action: args.action, via: 'recording' } },
  }
  registerTools({
    ctx: { get: () => ({ imageLimits: { mediaTypes: ['image/png'] }, saveImage: async () => ({ width: 1, height: 1, attachmentId: 'x' }) }) },
    cu, defineTool: def => def, register: def => definitions.set(def.name, def),
    hooks: { contextOf: () => ({ cycleId: 1 }) },
    config: { actionFeedback: false },
    dataDir: { root: dir, shots: dir },
    snapshotPath: () => path.join(dir, 'shot.jpg'),
  })
  const exec = { agent: { options: { provider: 'fixture', model: 'fixture' } } }
  const run = (tool, args) => definitions.get('computer_' + tool).execute(args, exec)

  // ---- computer_uia: actions is opt-in and forwarded verbatim --------------------------------
  await run('uia', { hwnd: 12, id: 'scrollFixture', actions: true })
  const withActions = calls.at(-1)
  record('tool-uia-actions-forwarded',
    withActions.op === 'uia' && withActions.args.actions === true && withActions.args.automationId === 'scrollFixture',
    { op: withActions.op, actions: withActions.args.actions })

  await run('uia', { hwnd: 12, id: 'scrollFixture' })
  const without = calls.at(-1)
  record('tool-uia-actions-default-off', without.args.actions === false,
    { note: 'a plain query asks for no action discovery, so it costs nothing', actions: without.args.actions })

  // ---- computer_uia_act: the new parameters reach the worker unchanged -----------------------
  const target = 'T' + 'a'.repeat(31)
  const fakeTargets = new Set([target])
  // ownsTarget lives in the observation store; give this Agent a target it issued.
  const originalPublish = definitions.get('computer_uia').execute
  void originalPublish
  // The observation cache issues targets itself; instead drive the act tool through hwnd+id, which
  // needs no prior target and exercises the same forwarding.
  await run('uia_act', { hwnd: 12, id: 'scrollFixture', action: 'setScrollPercent', horizontalPercent: -1, verticalPercent: 70 })
  const percent = calls.at(-1)
  record('tool-act-scroll-percent-forwarded',
    percent.op === 'uiaAct' && percent.args.horizontalPercent === -1 && percent.args.verticalPercent === 70,
    { op: percent.op, horizontalPercent: percent.args.horizontalPercent, verticalPercent: percent.args.verticalPercent })

  await run('uia_act', { hwnd: 12, id: 'viewFixture', action: 'setCurrentView', value: '2' })
  const view = calls.at(-1)
  record('tool-act-view-forwarded', view.args.action === 'setCurrentView' && view.args.value === '2',
    { action: view.args.action, value: view.args.value })

  await run('uia_act', { hwnd: 12, id: 'row-8', action: 'realize' })
  record('tool-act-realize-forwarded', calls.at(-1).args.action === 'realize', { action: calls.at(-1).args.action })

  await run('uia_act', { hwnd: 12, id: 'countingEditor', action: 'selectText', value: 'value=alpha', prefix: 'editor ', selectionType: 'cursor_before' })
  const select = calls.at(-1)
  record('tool-act-selectionType-forwarded',
    select.args.selectionType === 'cursor_before' && select.args.value === 'value=alpha' && select.args.prefix === 'editor ',
    { selectionType: select.args.selectionType })

  await run('uia_act', { hwnd: 12, id: 'countingEditor', action: 'selectText', value: 'value=alpha' })
  record('tool-act-selectionType-optional', calls.at(-1).args.selectionType === undefined,
    { note: 'omitting it keeps the old default (whole match), so old callers are unaffected' })

  // ---- the declared schema advertises the new fields ----------------------------------------
  const uiaParams = definitions.get('computer_uia').parameters
  const actParams = definitions.get('computer_uia_act').parameters
  record('tool-schema-declares-new-fields',
    !!uiaParams.actions && !!actParams.selectionType && !!actParams.horizontalPercent && !!actParams.verticalPercent,
    { uia: Object.keys(uiaParams), act: Object.keys(actParams) })

  // ---- batch reuses the same bodies ---------------------------------------------------------
  const batch = await run('batch', { shot: 'never', actions: [{ tool: 'computer_uia_act', args: { hwnd: 12, id: 'viewFixture', action: 'setCurrentView', value: '2' } }] })
  record('tool-batch-reuses-act', !!batch && batch.actions[0]?.result?.action === 'setCurrentView',
    { step: batch?.actions?.[0]?.result?.action ?? null })

  const failed = rows.filter(row => row.ok !== true)
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true })
    fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2) + '\n')
  }
  assert.deepEqual(failed, [], 'every contract case must pass')
  console.log(`ok test-uia-tool-contract — ${rows.length} tool-layer contract checks ` +
    '(forwarding + schema only; the worker implementation is proven by test-uia-feature.mjs)')
} finally {
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true })
    fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2) + '\n')
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
