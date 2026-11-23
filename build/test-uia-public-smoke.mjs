// PUBLIC integration smoke (CUA-IMPL-PUBLIC): the registered tools talking to the SHIPPED worker.
//
// Path under test — nothing mocked:
//   lib/tools.js registerTools -> computer_uia / computer_uia_act / computer_batch .execute
//     -> ComputerUse (lib/core/index.js) -> the real dsh-computer-use-worker.exe
//     -> the fixture's own UIA providers (same fixture source as the native regression)
//
// How the pieces are connected, and why that is still a real path:
//   * the worker is the PACKAGE's prebuilt lib/core/bin/dsh-computer-use-worker.exe, started by the
//     real ComputerUse class through its normal spawn (workerExe option);
//   * this script runs ON the private desktop created by private-desktop-test.mjs, so the worker it
//     spawns inherits that desktop and can never touch the user's foreground session;
//   * the fixture is a separate process started here, also on that desktop, and it accepts ONLY its
//     own lifecycle commands over a file channel.
//
// If the session's own machine lease refuses the run (another real plugin cycle is open), the exact
// refusal is printed and this script exits 2 — the layered native regression stays the evidence.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { requirePrivateDesktop } from './private-desktop-test.mjs'

// The launcher forwards only the script path, so a CLI --results must be converted to an ABSOLUTE
// path and handed to the child through the environment BEFORE requirePrivateDesktop re-executes us.
{
  const flag = process.argv.indexOf('--results')
  if (flag > 0 && process.argv[flag + 1]) process.env.CUA_UIA_FEATURE_RESULTS = path.resolve(process.argv[flag + 1])
}
const resultsPath = process.env.CUA_UIA_FEATURE_RESULTS || null
// The repository's own isolation: requirePrivateDesktop() compiles and drives the private-desktop
// launcher, verifies the child's real Win32 desktop, and supplies the test-private
// STOP/EXITED/OWNER/AUDIT triple. The results path travels in CUA_UIA_FEATURE_RESULTS because the
// launcher forwards only the script path to the child.
requirePrivateDesktop(import.meta.filename, { timeoutMs: 210000 })

const here = import.meta.dirname
const repoRoot = path.resolve(here, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uia-public-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rows = []
const record = (name, ok, detail) => {
  rows.push({ name, ok: !!ok, detail })
  console.log(JSON.stringify(rows[rows.length - 1]))
}

try {
  // ---- fixture: the same source the native regression uses, in --serve-file mode --------------
  // Compiled here into this run's own temp directory: the smoke is self-contained and needs no
  // pre-built artifact or extra environment variable.
  const exe = path.join(dir, 'fixture.exe')
  const win = process.env.WINDIR || 'C:/Windows'
  const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll',
    'System.Windows.Forms.dll', ...['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase']
      .map(name => path.join(gac, name, 'v4.0_4.0.0.0__31bf3856ad364e35', name + '.dll'))]
  refs.push(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
    path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'))
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/main:UiaFeatureFixture',
      '/out:' + exe, ...refs.map(ref => '/r:' + ref),
      path.join(here, 'uia-feature-serve.cs')], { windowsHide: true, timeout: 60000 })

  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const fixture = spawn(exe, ['--state=' + stateDir], { windowsHide: true, stdio: 'ignore' })
  let state = null
  for (let attempt = 0; attempt < 200 && !state; attempt++) {
    await sleep(60)
    try { state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')) } catch {}
  }
  if (!state) throw Error('fixture never published its window state')
  record('fixture-ready', true, { pid: state.pid, hwnd: state.hwnd, desktop: state.desktop })

  // ---- the real tool layer -------------------------------------------------------------------
  const workerExe = path.join(repoRoot, 'lib/core/bin/dsh-computer-use-worker.exe')
  assert.ok(fs.existsSync(workerExe), 'the shipped worker binary must exist')
  const { ComputerUse } = await import('file:///' + repoRoot + '/lib/core/index.js')
  const { registerTools } = await import('file:///' + repoRoot + '/lib/tools.js')
  const cu = new ComputerUse({ workerExe, log: () => {} })
  const definitions = new Map()
  const exec = { agent: { options: { provider: 'fixture', model: 'fixture' } } }
  registerTools({
    ctx: { get: () => ({ imageLimits: { mediaTypes: ['image/png'] }, saveImage: async () => ({ width: 40, height: 20, attachmentId: 'x' }) }) },
    cu, defineTool: def => def, register: def => definitions.set(def.name, def),
    hooks: { contextOf: () => ({ cycleId: 1 }) },
    config: { actionFeedback: false },
    dataDir: { root: dir, shots: dir },
    snapshotPath: () => path.join(dir, 'shot.jpg'),
  })
  const run = (tool, args) => definitions.get('computer_' + tool).execute(args, exec)
  const closeAll = async () => { try { await cu.call('exit', { why: 'smoke finished' }) } catch {} try { await cu.kill() } catch {} }

  try {
    // ---- the public query with per-control actions -------------------------------------------
    const query = await run('uia', { hwnd: state.hwnd, id: 'scrollFixture', actions: true, targets: true, limit: 5 })
    const scroll = (query.elements || query.flat || []).find(element => element.automationId === 'scrollFixture')
    record('public-actions-query', !!scroll && Array.isArray(scroll.actions) && scroll.actions.includes('setScrollPercent'),
      { actions: scroll?.actions, schema: scroll?.actionSchema })

    const target = scroll?.target
    if (!target) throw Error('no target issued for scrollFixture')

    // ---- 70% through the registered tool ------------------------------------------------------
    const scrollReceipt = await run('uia_act', { target, action: 'setScrollPercent', horizontalPercent: -1, verticalPercent: 70 })
    const afterScroll = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    record('public-scroll-70', afterScroll.scroll.vertical === 70 && afterScroll.scroll.horizontal === 0,
      { fixture: afterScroll.scroll, receipt: { vertical: scrollReceipt.verticalPercent, horizontal: scrollReceipt.horizontalPercent } })

    // ---- the SAME view fixture: 1 -> 2 -------------------------------------------------------
    const viewQuery = await run('uia', { hwnd: state.hwnd, id: 'viewFixture', actions: true, targets: true, limit: 5 })
    const view = (viewQuery.elements || viewQuery.flat || []).find(element => element.automationId === 'viewFixture')
    const viewReceipt = await run('uia_act', { target: view.target, action: 'setCurrentView', value: '2' })
    const afterView = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    record('public-view-1-to-2', afterView.view.current === 2 && afterView.view.switches === 1,
      { fixture: afterView.view, receipt: { currentView: viewReceipt.currentView, beforeView: viewReceipt.beforeView } })

    // ---- Realize an off-screen row -----------------------------------------------------------
    const rowQuery = await run('uia', { hwnd: state.hwnd, id: 'row-8', targets: true, limit: 5 })
    const row = (rowQuery.elements || rowQuery.flat || []).find(element => element.automationId === 'row-8')
    const realizeReceipt = await run('uia_act', { target: row.target, action: 'realize' })
    const afterRealize = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    record('public-realize', afterRealize.realize.calls === 1 && realizeReceipt.realizeRequired !== false && realizeReceipt.realized === true,
      { fixture: afterRealize.realize, receipt: { realized: realizeReceipt.realized, reobserveRequired: realizeReceipt.reobserveRequired } })

    // ---- the three selection modes -----------------------------------------------------------
    const editorQuery = await run('uia', { hwnd: state.hwnd, id: 'countingEditor', targets: true, actions: true, limit: 5 })
    const editor = (editorQuery.elements || editorQuery.flat || []).find(element => element.automationId === 'countingEditor')
    const selectReceipt = await run('uia_act', { target: editor.target, action: 'selectText', value: 'value=alpha', prefix: 'editor ' })
    const beforeReceipt = await run('uia_act', { target: editor.target, action: 'selectText', value: 'value=alpha', prefix: 'editor ', selectionType: 'cursor_before' })
    const afterReceipt = await run('uia_act', { target: editor.target, action: 'selectText', value: 'value=alpha', prefix: 'editor ', selectionType: 'cursor_after' })
    const afterSelect = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    record('public-select-three-modes',
      selectReceipt.selectionVerified === true && selectReceipt.collapsed === false &&
      beforeReceipt.selectionVerified === true && beforeReceipt.collapsed === true &&
      afterReceipt.selectionVerified === true && afterReceipt.collapsed === true &&
      afterSelect.select.calls === 3,
      { select: { verified: selectReceipt.selectionVerified, collapsed: selectReceipt.collapsed },
        cursorBefore: { verified: beforeReceipt.selectionVerified, collapsed: beforeReceipt.collapsed },
        cursorAfter: { verified: afterReceipt.selectionVerified, collapsed: afterReceipt.collapsed },
        fixtureSelectCalls: afterSelect.select.calls })

    // ---- batch, when the existing tool supports it -------------------------------------------
    const batch = await run('batch', { shot: 'never', actions: [{ tool: 'computer_uia', args: { hwnd: state.hwnd, id: 'viewFixture', limit: 3 } }] })
    record('public-batch-uia', !!batch && Array.isArray(batch.actions) && batch.actions[0]?.result != null,
      { ok: !!batch, step: batch?.actions?.[0]?.result ? 'result-present' : 'no-result' })

    // Every public case must be present and green: a silently missing case is never a pass.
    const expected = ['fixture-ready', 'public-actions-query', 'public-scroll-70', 'public-view-1-to-2',
      'public-realize', 'public-select-three-modes', 'public-batch-uia']
    const missing = expected.filter(name => !rows.some(row => row.name === name))
    const failedCases = rows.filter(row => row.ok !== true)
    if (missing.length || failedCases.length) {
      console.log(`PUBLIC-SMOKE-FAILED: missing=[${missing.join(',')}] failed=[${failedCases.map(row => row.name).join(',')}]`)
      process.exitCode = 1
    }
  } finally {
    await closeAll()
    // One lifecycle command only: the fixture closes itself.
    try { fs.appendFileSync(path.join(stateDir, 'command.txt'), 'quit\n') } catch {}
    await sleep(400)
    try { fixture.kill() } catch {}
  }
} catch (error) {
  const message = String(error.message || error)
  record('public-smoke-error', false, { error: message })
  // A machine-lease or sandbox refusal is an ENVIRONMENT fact and reports exit 2 so the caller can
  // tell it apart from a product failure. Anything else is a real failure: exit 1.
  if (/MACHINE_OWNED|machine is owned by another computer-use cycle|EPERM|worker-unavailable/.test(message)) {
    console.log('PUBLIC-SMOKE-BLOCKED: the environment refused this run; see the native regression for evidence')
    process.exitCode = 2
  } else {
    console.log('PUBLIC-SMOKE-FAILED: ' + message)
    process.exitCode = 1
  }
} finally {
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true })
    fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2) + '\n')
    console.log('results written to ' + resultsPath)
  }
  // A run that produced a failed case must not exit 0 just because no exception escaped.
  if (process.exitCode === undefined) {
    const failed = rows.filter(row => row.ok !== true)
    if (failed.length > 0) {
      console.log(`PUBLIC-SMOKE-FAILED: ${failed.length} case(s) failed: ${failed.map(row => row.name).join(', ')}`)
      process.exitCode = 1
    }
  }
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
