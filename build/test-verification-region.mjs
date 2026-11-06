// Adapter and core stubs plus reflected pure C# helpers. Never worker Main,
// native capture, foreground changes, mouse input or keyboard input.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { verificationRegion } from '../lib/verification-region.js'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'
import { createMcpToolSurface } from '../mcp/src/tools.js'

let checks = 0
const failures = []
const check = (ok, label) => { checks++; if (!ok) failures.push(label) }
const equal = (actual, expected, label) => { checks++; try { assert.deepEqual(actual, expected) } catch { failures.push(label + ': ' + JSON.stringify(actual)) } }
const expected = { x: -300, y: 40, width: 200, height: 120 }
const witness = '-300,40,200,120'
function coreFixture () {
  const calls = [], resolves = [], validated = []
  const cu = { stopped: false, exited: false, lastMarks: [{ id: 'M7', cx: 200, cy: 300 }], lastMarkFrame: { hwnd: 777 },
    validateMarkFrame: async () => { validated.push(true) },
    resolveTarget: async function (target) { resolves.push(target); return ComputerUse.prototype.resolveTarget.call(this, target) },
    click: ComputerUse.prototype.click, shiftClick: ComputerUse.prototype.shiftClick,
    actuate: async (op, args) => { calls.push({ op, args }); return { ok: true, x: args.x, y: args.y, effectVerified: false } },
  }
  return { cu, calls, resolves, validated }
}

equal(verificationRegion(witness), expected, 'string normalized')
equal(verificationRegion(expected), expected, 'object normalized without mutation')
check(verificationRegion(undefined) === undefined, 'omitted region preserves original behavior')
equal(verificationRegion('0 0 4096 4096'), { x: 0, y: 0, width: 4096, height: 4096 }, 'exact area boundary')
const invalid = [null, [], {}, '', '1,2,3', '1,2,3,4,5', ',0,10,10', '0,,10,10', '0,0,0,10', '0,0,10,-1', '0.5,0,10,10',
  '0,0,4097,4096', '2147483646,0,2,1', '0,2147483646,1,2', '-2147483648,0,1,1',
  { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: Infinity, width: 1, height: 1 }, { x: true, y: 0, width: 1, height: 1 },
  { x: 0, y: 0, width: 2147483647, height: 2147483647 }]
for (const value of invalid) {
  for (const operation of ['click', 'shiftClick']) {
    const f = coreFixture()
    let error
    try {
      if (operation === 'click') await f.cu.click({ mark: 'M7' }, { verificationRegion: value })
      else await f.cu.shiftClick(1, 2, { verificationRegion: value })
    } catch (e) { error = e }
    check(error?.code === 'INVALID_VERIFICATION_REGION' && error?.outcome === 'not-dispatched', operation + ' rejects invalid region: ' + JSON.stringify(value))
    check(f.calls.length === 0, operation + ' rejects before actuate: ' + JSON.stringify(value))
    if (operation === 'click') check(f.resolves.length === 0, 'bad region rejected before mark resolution: ' + JSON.stringify(value))
  }
}
{
  const f = coreFixture()
  await f.cu.click({ mark: 'M7' }, { verificationRegion: witness, expectHwnd: 999 })
  equal(f.calls[0].args.verificationRegion, expected, 'core witness normalized')
  check(f.calls[0].args.expectHwnd === 777 && f.validated.length === 1, 'mark identity wins over conflicting override')
  await f.cu.shiftClick(-4, 5, { verificationRegion: witness, expectHwnd: 777 })
  check(f.calls[1].op === 'shiftClick' && f.calls[1].args.expectHwnd === 777, 'shift click preserves intended window')
  equal(f.calls[1].args.verificationRegion, expected, 'shift witness normalized')
}
{
  const f = coreFixture(), defs = new Map()
  registerTools({ ctx: { tools: { register: def => defs.set(def.name, def) } }, cu: f.cu,
    config: { actionFeedback: false }, defineTool: d => d, hooks: {}, dataDir: { root: os.tmpdir(), shots: os.tmpdir() }, snapshotPath: () => { throw Error('screenshot forbidden') } })
  const run = (name, args) => defs.get(name).execute(args, { agent: { id: 'verification-fixture' } })
  check(defs.get('computer_click').parameters.verificationRegion.type === 'string', 'DSH discovery exposes string region')
  await run('computer_click', { mark: 'M7', verificationRegion: witness })
  equal(f.calls[0].args.verificationRegion, expected, 'DSH direct transports witness to core')
  check(f.calls[0].args.expectHwnd === 777, 'DSH direct mark identity retained')
  await run('computer_click', { mark: 'M7', dx: 3, dy: -4, shift: true, verificationRegion: witness })
  check(f.calls[1].op === 'shiftClick' && f.calls[1].args.x === 203 && f.calls[1].args.y === 296 && f.calls[1].args.expectHwnd === 777, 'DSH offset shift mark retains identity and coordinate')
  equal(f.calls[1].args.verificationRegion, expected, 'DSH shift carries independent witness')
  const batch = await run('computer_batch', { actions: [{ tool: 'computer_click', args: { mark: 'M7', verificationRegion: witness } }], shot: 'never' })
  check(batch.actions[0].ok && f.calls[2].args.expectHwnd === 777, 'DSH batch mark identity retained')
  equal(f.calls[2].args.verificationRegion, expected, 'DSH batch witness retained')
  const before = f.calls.length
  const refused = await run('computer_batch', { actions: [{ tool: 'computer_click', args: { at: '1,2', verificationRegion: '0,0,0,10' } }, { tool: 'computer_click', args: { at: '1,2' } }], shot: 'never' })
  check(f.calls.length === before && refused.actions[1].outcome === 'not-dispatched', 'DSH invalid witness stops later batch input')
}
{
  const f = coreFixture(), mcp = createMcpToolSurface(f.cu, { allowInput: true })
  check(mcp.tools.find(d => d.name === 'cu_click').inputSchema.properties.verificationRegion.type === 'string', 'MCP discovery exposes string region')
  await mcp.run('cu_click', { mark: 'M7', verificationRegion: witness })
  equal(f.calls[0].args.verificationRegion, expected, 'MCP direct witness transported')
  check(f.calls[0].args.expectHwnd === 777, 'MCP mark identity retained')
  const batch = await mcp.run('cu_batch', { actions: [{ tool: 'cu_click', args: { mark: 'M7', verificationRegion: witness } }] })
  check(batch.actions[0].ok && f.calls[1].args.expectHwnd === 777, 'MCP batch mark identity retained')
  equal(f.calls[1].args.verificationRegion, expected, 'MCP batch witness transported')
  const before = f.calls.length
  const refused = await mcp.run('cu_batch', { actions: [{ tool: 'cu_click', args: { x: 1, y: 2, verificationRegion: '0,0,0,10' } }, { tool: 'cu_click', args: { x: 1, y: 2 } }] })
  check(f.calls.length === before && refused.actions[1].outcome === 'not-dispatched', 'MCP invalid witness stops later batch input')
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verification-region-'))
const win = process.env.WINDIR || 'C:/Windows', gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
  ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll')),
  path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
  path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
  path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd')]
const source = path.join(import.meta.dirname, '../lib/core/worker.cs'), exe = path.join(dir, 'probe.exe')
let native
try {
  const worker = fs.readFileSync(source, 'utf8')
  const copyBinding = /\[DllImport\("gdi32\.dll"[^\]]*\)\]\s*public static extern bool BitBlt\(IntPtr dst, int x, int y, int w, int h, IntPtr src, int x1, int y1, uint rop\);/g
  const inputBinding = /\[DllImport\("user32\.dll", SetLastError = true\)\]\s*public static extern uint SendInput\(uint nInputs, INPUT\[\] pInputs, int cbSize\);/g
  assert.equal([...worker.matchAll(copyBinding)].length, 1, 'exactly one native BitBlt binding before isolation')
  assert.equal([...worker.matchAll(inputBinding)].length, 1, 'exactly one physical input binding before isolation')
  const shiftStart = worker.indexOf('static Dictionary<string, object> ShiftClick(')
  const shiftEnd = worker.indexOf('static void ClickTimes(', shiftStart)
  const shiftBody = worker.slice(shiftStart, shiftEnd)
  const guard = 'using (GuardReceiver(targetWindow, targetPid, false))'
  assert.equal(shiftBody.split(guard).length, 2, 'one real receiver scope in ShiftClick')
  const guardStart = shiftBody.indexOf(guard), guardOpen = shiftBody.indexOf('{', guardStart)
  let guardDepth = 1, guardEnd = guardOpen + 1
  for (; guardEnd < shiftBody.length && guardDepth; guardEnd++) {
    if (shiftBody[guardEnd] === '{') guardDepth++
    if (shiftBody[guardEnd] === '}') guardDepth--
  }
  assert.equal(guardDepth, 0, 'whole guarded production sequence extracted')
  const guardedSequence = shiftBody.slice(guardStart, guardEnd)
  // The behavioral fixture runs this exact production sequence, not a hand-written
  // analogue. Preparation/movement is excluded; real guard/sender/owned-up helpers
  // still run. Source removal/reordering therefore changes the tested behavior.
  const fixtureEntry = `public static void FixtureShiftClickSequence(IntPtr targetWindow, uint targetPid, int clicks) { ${guardedSequence} }\n        `
  const isolatedWorker = worker
    .replace(copyBinding, 'public static bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int x1, int y1, uint rop) { return VerificationRegionFixture.FailCopy(); }')
    .replace(inputBinding, 'public static uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize) { VerificationRegionFixture.ForbidNativeInput(); return 0; }')
    .replace('static Dictionary<string, object> ShiftClick(', fixtureEntry + 'static Dictionary<string, object> ShiftClick(')
  assert.ok(!isolatedWorker.includes('extern bool BitBlt('), 'no real pixel-copy binding remains')
  assert.ok(!isolatedWorker.includes('extern uint SendInput('), 'no physical input binding remains')
  const isolatedSource = path.join(dir, 'worker-isolated.cs')
  fs.writeFileSync(isolatedSource, isolatedWorker)
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:VerificationRegionFixture', '/out:' + exe,
    ...refs.map(r => '/r:' + r), isolatedSource, path.join(import.meta.dirname, 'verification-region-fixture.cs')], { windowsHide: true, timeout: 30000 })
  native = JSON.parse(execFileSync(exe, [], { windowsHide: true, timeout: 15000, encoding: 'utf8', env: {
    ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
    DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'desktop.owner'),
    DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
  } }))
  for (const failure of native.failures) failures.push('C#: ' + failure)
  checks += native.checks
  for (const [begin, end, marker] of [['static Dictionary<string, object> Click(', 'static Exception DragPrecondition(', 'AgentActing('], ['static Dictionary<string, object> ShiftClick(', 'static void ClickTimes(', 'HostGuardPoint(']]) {
    const body = worker.slice(worker.indexOf(begin), worker.indexOf(end, worker.indexOf(begin)))
    check(body.indexOf('VerificationSampleRegion(') >= 0 && body.indexOf('VerificationSampleRegion(') < body.indexOf(marker), 'native region validation precedes focus/movement/input setup')
  }
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
const report = { pass: failures.length === 0, checks, nativeChecks: native?.checks, failures,
  failedPixelCopyCalls: native?.failedPixelCopyCalls, physicalInputCalls: native?.physicalInputCalls,
  scope: 'Adapter/core stubs, reflected pure helpers, real GDI allocation with BitBlt replaced by false, and exact ShiftClick guarded body with fake InputSender. No pixel capture, physical input or worker Main.' }
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
assert.equal(failures.length, 0, failures.join('\n'))
