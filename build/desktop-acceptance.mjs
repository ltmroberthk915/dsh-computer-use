// Explicit, fixture-only LIVE acceptance. Importing this file or invoking it
// without --run never imports ComputerUse, starts a worker, or sends input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { readJson } from './desktop-acceptance-io.mjs'

const defaultPackage = 'C:/Users/Ming/.dsh/profiles/desktop/node_modules/dsh-codex-style-computer-use'
const expectedSource = 'd823141874d38a1029b6c7d4849708eb2768172d5d13ec201de98e8dc0d10574'
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (['--run', '--help'].includes(key)) args[key.slice(2)] = true
  else if (['--fixture', '--confirm-fixture', '--package', '--output-root', '--timeout-ms', '--expected-source-sha'].includes(key)) {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error('missing value for ' + key)
    args[key.slice(2)] = process.argv[++i]
  } else throw Error('unknown option: ' + key)
}
if (args.help || !args.fixture) {
  console.log('Preparation only by default. Supply --fixture manifest.json to print a plan. LIVE execution additionally requires --run --confirm-fixture "HWND:PID:nonce". Optional --package, --output-root, --timeout-ms (10000..120000), --expected-source-sha. Never clears STOP/EXITED, resumes a brake, isolates global ownership, closes the fixture, or kills any process other than its own ComputerUse child.')
  process.exit(args.run ? 2 : 0)
}

const manifestPath = path.resolve(args.fixture)
const fixture = readJson(manifestPath)
assert(Number.isSafeInteger(fixture.hwnd) && fixture.hwnd > 0 && Number.isSafeInteger(fixture.pid) && fixture.pid > 0, 'exact positive HWND/PID required')
assert(typeof fixture.nonce === 'string' && /^[a-zA-Z0-9_-]{12,80}$/.test(fixture.nonce), 'dedicated fixture nonce required')
assert(typeof fixture.title === 'string' && fixture.title.includes(fixture.nonce), 'fixture title must contain nonce')
assert(path.isAbsolute(fixture.exePath) && path.isAbsolute(fixture.stateFile), 'fixture executable/state paths must be absolute')
assert(/fixture/i.test(path.basename(fixture.exePath)) && !/^(node|dsh|codex|chrome|msedge|explorer|powershell|pwsh)\.exe$/i.test(path.basename(fixture.exePath)), 'only a dedicated fixture executable is allowed')
assert(fixture.pid !== process.pid, 'fixture cannot be this runner')
const rect = fixture.clientRect
assert(rect && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) && rect.width > 20 && rect.height > 20, 'measured fixture clientRect required')
const moves = fixture.movePoints2 || fixture.movePoints
assert(Array.isArray(moves) && moves.length === 2, 'two fixture move points required')
const inside = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= rect.x + 2 && p.y >= rect.y + 2 && p.x < rect.x + rect.width - 2 && p.y < rect.y + rect.height - 2
assert([...moves, fixture.drag?.from, fixture.drag?.to].every(inside), 'every input endpoint must be inside the dedicated client area')
assert(fixture.drag.expectCursor === 'resize-ew', 'this acceptance fixture expects the standard horizontal resize cursor')
const confirmation = `${fixture.hwnd}:${fixture.pid}:${fixture.nonce}`
const packageRoot = path.resolve(args.package || defaultPackage)
const timeoutMs = Number(args['timeout-ms'] || 60000)
assert(Number.isInteger(timeoutMs) && timeoutMs >= 10000 && timeoutMs <= 120000, 'bounded total timeout required')
const plan = { mode: args.run ? 'LIVE fixture-only' : 'PLAN — no worker/input', packageRoot, fixture: {
  hwnd: fixture.hwnd, pid: fixture.pid, title: fixture.title, exePath: fixture.exePath, clientRect: rect,
}, confirmationRequired: confirmation, timeoutMs,
steps: ['verify exact installed runtime identity and untouched global brake', 'activate fixture; verify first 1000ms preparation completed',
  'two independent pointer moves; verify repeated 100ms preparation', 'two moves in one series; verify only one preparation', 'hold/free indicators (8/3) and domain state',
  'drag measured splitter; separate native delivery receipt from paneWidth business readback',
  'F8 held only in fixture, cancel after its real KeyDown, verify cleanup acknowledgement and real release',
  'calm own cycle if unpaused, shut down only own worker; leave fixture open'] }
console.log(JSON.stringify(plan, null, 2))
if (!args.run) process.exit(0)
assert.equal(args['confirm-fixture'], confirmation, 'explicit exact fixture confirmation required')
assert.equal(process.platform, 'win32', 'Windows-only live fixture')
for (const name of ['DSH_COMPUTER_USE_OWNER_FILE', 'DSH_COMPUTER_USE_STOP_FILE', 'DSH_COMPUTER_USE_EXIT_FILE'])
  assert(!process.env[name], 'live acceptance must respect the real global ownership/brake; unset test override ' + name)
const globalDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'dsh-computer-use')
for (const name of ['STOP', 'EXITED']) assert(!fs.existsSync(path.join(globalDir, name)), 'existing global ' + name + ' remains authoritative; acceptance does not clear it')
const installedSource = path.join(packageRoot, 'lib/core/worker.cs')
const sourceSha = hashFile(installedSource)
assert.equal(sourceSha, args['expected-source-sha'] || expectedSource, 'installed source differs from the specifically accepted build')
const packageInfo = readJson(path.join(packageRoot, 'package.json'))
assert.equal(packageInfo.name, 'dsh-codex-style-computer-use')

// Read-only OS identity check before importing/starting any ComputerUse worker.
// PID is a validated integer; no fixture text is interpolated into PowerShell.
const ps = 'pwsh.exe'
const processInfo = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
  `$p=Get-Process -Id ${fixture.pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;exePath=$p.Path;hwnd=$p.MainWindowHandle.ToInt64();title=$p.MainWindowTitle}|ConvertTo-Json -Compress`],
{ windowsHide: true, timeout: 5000, encoding: 'utf8' }).replace(/^\uFEFF/, '').trim())
assert.equal(processInfo.pid, fixture.pid)
assert.equal(processInfo.hwnd, fixture.hwnd)
assert.equal(processInfo.title, fixture.title)
assert.equal(path.resolve(processInfo.exePath).toLowerCase(), path.resolve(fixture.exePath).toLowerCase())

const outputRoot = path.resolve(args['output-root'] || path.join(import.meta.dirname, 'desktop-acceptance-results'))
fs.mkdirSync(outputRoot, { recursive: true })
const output = fs.mkdtempSync(path.join(outputRoot, 'run-'))
const report = { startedAt: new Date().toISOString(), installed: { packageRoot, packageVersion: packageInfo.version, sourceSha },
  fixture: { ...plan.fixture, nonce: fixture.nonce }, hostGuard: 'ComputerUse protects this runner PID/node image; strict fixture HWND/PID/exe/title confinement additionally excludes the DSH host. No host guard bypass is enabled.',
  timingScope: 'Operation elapsed times include target checks, motion and readback. preparationMs plus completedSerial prove the configured/presented countdown; exact visible durations are separately tested by native/private-desktop fixtures.',
  checks: [], actions: [], events: [], success: false }
const overall = new AbortController()
const deadline = setTimeout(() => overall.abort(new Error('acceptance total deadline exceeded')), timeoutMs)
const interrupt = () => overall.abort(new Error('acceptance interrupted'))
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
const { ComputerUse } = await import(pathToFileURL(path.join(packageRoot, 'lib/core/index.js')).href)
const cu = new ComputerUse({ autoApprove: true })
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const state = () => {
  const s = readJson(fixture.stateFile)
  assert.equal(s.nonce, fixture.nonce); assert.equal(s.pid, fixture.pid)
  if (s.hwnd !== undefined) assert.equal(s.hwnd, fixture.hwnd)
  assert(!s.closed, 'fixture has closed')
  return s
}
const currentDrag = () => {
  const fresh = readJson(manifestPath)
  for (const key of ['nonce', 'pid', 'hwnd', 'title', 'exePath', 'stateFile'])
    assert.equal(fresh[key], fixture[key], 'fixture identity changed in current manifest: ' + key)
  assert.deepEqual(fresh.clientRect, rect, 'fixture client area moved; obtain a fresh confirmed plan')
  assert(Number.isFinite(fresh.updatedAtMs) && Date.now() - fresh.updatedAtMs >= -1000 && Date.now() - fresh.updatedAtMs < 3000,
    'current splitter geometry requires a recent fixture manifest')
  assert(fresh.drag?.expectCursor === 'resize-ew' && [fresh.drag.from, fresh.drag.to].every(inside), 'fresh drag points must remain in the confirmed fixture')
  return { ...fresh.drag, measuredAt: fresh.updatedAtMs }
}
const assertOwnership = () => {
  if (overall.signal.aborted) throw overall.signal.reason
  state() // exact fixture nonce, never infer permission from a window title alone
  assert(!cu.stopped && !cu.exited && !cu.cooperation?.active, 'human pause/takeover remains authoritative; stop this acceptance run')
}
const record = (name, evidence) => { report.checks.push({ name, at: new Date().toISOString(), evidence }); save() }
const glow = () => cu.call('probe', { what: 'glow' }, 2000, false)
const cooperation = async () => {
  const ping = await cu.call('ping', {}, 2000, false)
  assert.equal(ping.cooperation.workerGeneration, cu.workerGeneration)
  assert(Number.isSafeInteger(ping.cooperation.stateSeq) && ping.cooperation.stateSeq >= 0)
  return ping.cooperation
}
const validateTarget = async () => {
  assertOwnership()
  const w = await cu.call('probe', { what: 'window', hwnd: fixture.hwnd }, 2000, false)
  assert.equal(w.hwnd, fixture.hwnd); assert.equal(w.pid, fixture.pid)
  assert(w.visible && w.enabled && !w.minimized && !w.hung, 'fixture must remain live and visible')
  assert(w.rect && rect.x >= w.rect.x && rect.y >= w.rect.y && rect.x + rect.width <= w.rect.x + w.rect.width && rect.y + rect.height <= w.rect.y + w.rect.height, 'fixture moved since its measured manifest')
  return w
}
const input = async (fn, signal = overall.signal) => {
  await validateTarget()
  return cu.withInputContext({ signal, assertOwnership, cycleId: fixture.nonce, sessionKey: 'desktop-acceptance', agentKey: 'fixture-only' }, fn)
}
const waitFor = async (read, predicate, ms = 2500) => {
  const until = performance.now() + ms
  do { assertOwnership(); const value = await read(); if (predicate(value)) return value; await sleep(25) } while (performance.now() < until)
  throw Error('fixture observation deadline expired')
}
cu.on('action:settled', a => report.actions.push(a))
for (const event of ['handoff', 'panic', 'ask', 'exit', 'secure']) cu.on(event, value => report.events.push({ event, value }))
try {
  state()
  await cu.ensureWorker()
  assert(!cu.stopped && !cu.exited, 'native adopted an existing brake; do not resume it')
  assert(cu.runtime?.verified && cu.runtime.protocolVersion === 2 && cu.workerGeneration, 'ordered runtime identity required')
  assert.equal(cu.runtime.sourceHash, sourceSha)
  assert.equal(cu.runtime.binaryHash, hashFile(cu.workerExe))
  const initialCooperation = await cooperation()
  record('installed runtime identity', { runtime: cu.runtime, workerPid: cu.proc.pid, workerExe: cu.workerExe, cooperation: initialCooperation })
  const before = await glow()
  assert.equal(before.glowHealth.preparationSerial, 0, 'acceptance requires its own fresh worker')
  const start = performance.now()
  const activation = await input(() => cu.activateWindow({ hwnd: fixture.hwnd }))
  assert.equal(activation.activated, true)
  const first = await glow()
  assert.equal(first.glow.preparationMs, 1000)
  assert.equal(first.glowHealth.preparationSerial, before.glowHealth.preparationSerial + 1)
  assert.equal(first.glowHealth.completedSerial, first.glowHealth.preparationSerial)
  record('first preparation', { elapsedMs: performance.now() - start, glow: first.glow, health: first.glowHealth })
  let lastSerial = first.glowHealth.preparationSerial
  for (const point of moves) {
    const started = performance.now()
    await input(() => cu.actuate('move', { ...point, expectHwnd: fixture.hwnd }))
    const repeated = await glow()
    assert.equal(repeated.glow.preparationMs, 100)
    assert.equal(repeated.glowHealth.preparationSerial, lastSerial + 1, 'each independent input series must announce once')
    assert.equal(repeated.glowHealth.completedSerial, repeated.glowHealth.preparationSerial)
    lastSerial = repeated.glowHealth.preparationSerial
    record('repeat preparation', { point, elapsedMs: performance.now() - started, glow: repeated.glow, health: repeated.glowHealth })
  }
  const sameSeries = []
  const sharedSerial = lastSerial + 1
  await input(async () => {
    for (const point of moves) {
      const started = performance.now()
      await cu.actuate('move', { ...point, expectHwnd: fixture.hwnd })
      const observed = await glow()
      assert.equal(observed.glow.preparationMs, 100)
      assert.equal(observed.glowHealth.preparationSerial, sharedSerial, 'one coherent input series must not repeat its cue')
      assert.equal(observed.glowHealth.completedSerial, sharedSerial)
      sameSeries.push({ point, elapsedMs: performance.now() - started, glow: observed.glow, health: observed.glowHealth })
    }
  })
  record('two moves share exactly one preparation', { beforeSerial: lastSerial, sharedSerial, steps: sameSeries })
  await cu.indicator({ hold: true })
  const held = await waitFor(glow, p => p.glow.holding && !p.glow.acting && p.glow.want === 8)
  await cu.indicator({ hold: false })
  const free = await waitFor(glow, p => !p.glow.holding && !p.glow.acting && p.glow.want === 3)
  record('hold/free', { held: held.glow, free: free.glow })
  const dragBefore = state()
  const drag = currentDrag()
  const receipt = await input(() => cu.drag(drag.from, drag.to, { expectHwnd: fixture.hwnd, expectCursor: drag.expectCursor, durationMs: 550 }))
  assert.equal(receipt.dragStarted, true); assert.equal(receipt.effectVerified, false)
  const after = await waitFor(() => state(), s => s.dragCount > dragBefore.dragCount && Math.abs(s.paneWidth - dragBefore.paneWidth) >= 5)
  assert(Math.sign(after.paneWidth - dragBefore.paneWidth) === Math.sign(drag.to.x - drag.from.x), 'splitter must move in the intended direction')
  record('drag delivery and separate business readback', { measuredDrag: drag, receipt, before: dragBefore, after, businessVerified: true })
  const cancel = new AbortController()
  const signal = AbortSignal.any([overall.signal, cancel.signal])
  const keyBefore = state()
  const attempt = input(() => cu.key('f8', { expectHwnd: fixture.hwnd, holdMs: 4000 }), signal).then(value => ({ value }), error => ({ error }))
  let down
  try { down = await waitFor(() => state(), s => s.keysDown?.includes('F8') && s.f8DownCount > keyBefore.f8DownCount, 3000) }
  finally { cancel.abort(new Error('fixture intentionally cancelled after measured F8 down')) }
  const outcome = await attempt
  assert(outcome.error, 'cancelled input must produce an interruption receipt')
  assert.equal(outcome.error.code, 'INPUT_CANCELLED')
  assert(outcome.error.cleanup?.cleanupConfirmed && outcome.error.cleanup.ownedInputCount === 0, 'accepted inputs must be confirmed cleaned, not merely worker-killed')
  const released = await waitFor(() => state(), s => !s.keysDown?.includes('F8') && s.f8UpCount > keyBefore.f8UpCount)
  record('cancel accepted input and verify release', { down, released, error: { code: outcome.error.code, outcome: outcome.error.outcome, cleanup: outcome.error.cleanup } })
  const finalCooperation = await cooperation()
  assert.equal(finalCooperation.workerGeneration, initialCooperation.workerGeneration)
  assert(finalCooperation.stateSeq > initialCooperation.stateSeq, 'completed input scopes must advance cooperation ordering')
  record('cooperation generation and sequence', { before: initialCooperation, after: finalCooperation })
  report.success = true
} catch (error) {
  report.error = { name: error.name, message: error.message, code: error.code, outcome: error.outcome, cleanup: error.cleanup }
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  // Internal cleanup stays available after cancellation; it cannot resume or clear
  // a human brake. kill() owns only the child created by this ComputerUse object.
  if (cu.proc) {
    try {
      const final = await glow(); report.beforeCleanup = final
      if (final.cycle.cycleLit && !final.cycle.engaged && !final.cycle.stopped && !final.cycle.exited)
        await cu.callInternal('calm', {}, 2000, false)
    } catch (error) { report.cleanupObservationError = error.message }
    try { await cu.kill() } catch (error) { report.workerCleanupError = error.message; report.success = false; process.exitCode = 1 }
  }
  report.finishedAt = new Date().toISOString()
  report.remainingGlobalMarkers = ['STOP', 'EXITED'].filter(name => fs.existsSync(path.join(globalDir, name)))
  save()
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  console.log(JSON.stringify({ success: report.success, report: path.join(output, 'report.json') }))
}
