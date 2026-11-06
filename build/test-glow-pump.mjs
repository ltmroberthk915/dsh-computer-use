import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const here = import.meta.dirname
const win = process.env.WINDIR || 'C:/Windows'
const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
  ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name =>
    path.join(gac, name, 'v4.0_4.0.0.0__31bf3856ad364e35', name + '.dll'))]
    refs.push(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
      path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
      path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd'))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-glow-pump-'))
const source = path.resolve(process.argv[2] || path.join(here, '../lib/core/worker.cs'))
const exe = path.join(dir, 'glow-pump.exe')
try {
  // Observe successful Win32 presents without adding diagnostics to the shipped
  // binary or faking a presentation. Keep the actual call and its arguments intact.
  const worker = fs.readFileSync(source, 'utf8')
  const legacyCall = /if \((UpdateLayeredWindow\([^\r\n]+?\)) && want == 7/g
  const currentCall = /if \(presented && want == 7(?= && !PreparationVisible)/g
  const currentRenderer = worker.includes('bool presented = UpdateLayeredWindow(')
  if ([...worker.matchAll(currentRenderer ? currentCall : legacyCall)].length !== 1)
    throw new Error('cannot instrument native overlay present')
  const startLoop = /int committed = 0;(?=\s*while \(true\))/
  const publishState = /_want = want;/
  if (!publishState.test(worker)) throw new Error('cannot stage a pre-presentation freeze')
  const refocus = /static string RefocusWindow\(IntPtr h, bool clickFallback\)\s*\{/
  if (!refocus.test(worker)) throw new Error('cannot guard native refocus')
  if (!startLoop.test(worker)) throw new Error('cannot stage the first real render frame')
  const observed = path.join(dir, 'worker.cs')
  // The hidden desktop cannot own the user's foreground. Report its real HWND
  // as the target, and remove the physical SendInput binding in this executable.
  const readForeground = /\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr GetForegroundWindow\(\);/
  const physicalInput = /\[DllImport\("user32\.dll", SetLastError = true\)\]\s*public static extern uint SendInput\(uint nInputs, INPUT\[\] pInputs, int cbSize\);/
  const asyncKeys = /\[DllImport\("user32\.dll"\)\]\s*public static extern short GetAsyncKeyState\(int vKey\);/
  const hookChain = /\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr CallNextHookEx\(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam\);/
  const replaceRequest = /static bool RequestReplacement\(bool show\)\s*\{\s*if \(show\) return PointerVisibilityLease\.TryHide\(\); PointerVisibilityLease\.Show\(\); return false;\s*\}/g
  const pointerSurface = /static void EnsureSurface\(int w, int h\)\s*\{/g
  const pointerPresent = /UpdateLayeredWindow\(window, screenDc, ref target,/g
  const pointerCursor = '[DllImport("user32.dll")] static extern bool GetCursorInfo(ref CursorInfo info);'
  const guardianStart = /static void StartAndMonitor\(Session s\)\s*\{/g
  const magBinding = /\[System\.Runtime\.InteropServices\.DllImport\("Magnification\.dll"\)\]\s*static extern bool (MagInitialize|MagShowSystemCursor|MagUninitialize)\(([^)]*)\);/g
  if (![readForeground, physicalInput, asyncKeys, hookChain].every(pattern => pattern.test(worker)))
    throw new Error('unrecognized native input, hook or foreground binding')
  if ([...worker.matchAll(replaceRequest)].length !== 1 || [...worker.matchAll(pointerSurface)].length !== 1 ||
      [...worker.matchAll(pointerPresent)].length !== 1 || worker.split(pointerCursor).length !== 2 ||
      [...worker.matchAll(guardianStart)].length !== 1 || [...worker.matchAll(magBinding)].length !== 3)
    throw new Error('unrecognized pointer seam; refusing any private-desktop execution')
  let fixture = worker
    .replace(readForeground, 'public static IntPtr GetForegroundWindow() { return GlowPumpFixture.Target; }')
    .replace(pointerCursor, '[DllImport("user32.dll", EntryPoint="GetCursorInfo")] static extern bool RealGetCursorInfo(ref CursorInfo info); static bool GetCursorInfo(ref CursorInfo info) { if (!GlowPointer.SyntheticCursor) return RealGetCursorInfo(ref info); info.Flags = 1; info.Cursor = Native.LoadCursor(IntPtr.Zero, new IntPtr(32512)); info.Position.X = GlowPointer.CursorX; info.Position.Y = GlowPointer.CursorY; return true; }')
    .replace(replaceRequest, 'static bool RequestReplacement(bool show) { return GlowPointer.RequestReplacement(show); }')
    // Defense in depth: even an unintended lifecycle path cannot hide a cursor
    // or create a guardian in this executable. Dispose of an unstarted lease is
    // still the real production Show/no-current-session path.
    .replace(guardianStart, '$& GlowPointer.ForbidGuardian();')
    .replace(magBinding, (_, name, args) => `static bool ${name}(${args}) { GlowPointer.ForbidMag(); return false; }`)
    .replace(pointerSurface, '$& GlowPointer.BeforeSurface();')
    .replace(pointerPresent, 'UpdateLayeredWindow(GlowPointer.PresentHwnd(window), screenDc, ref target,')
    .replace(physicalInput, 'public static uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize) { Interlocked.Increment(ref GlowPointer.NativeInputCalls); throw new InvalidOperationException("physical input forbidden in fixture"); }')
    .replace(asyncKeys, 'public static short GetAsyncKeyState(int vKey) { return GlowHotkeys.ReadKey(vKey); }')
    .replace(hookChain, 'public static IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam) { return IntPtr.Zero; }')
    .replace(refocus, '$& if (GlowBoundaries.GuardRefocus) throw new InvalidOperationException("dry run attempted to refocus");')
    .replace(startLoop, '$& GlowHotkeys.AwaitFirstPreparation();')
    .replace(publishState, '$& GlowFailures.BeforePresent(want);')
    .replace('UpdateLayeredWindow(hwnd, screenDc', 'UpdateLayeredWindow(GlowFailures.PresentHwnd(hwnd, want), screenDc')
  fixture = currentRenderer
    ? fixture.replace(currentCall, 'if (GlowPumpFixture.SamplePresentedFrame(presented, want, bits, vw, vh) && want == 7')
    : fixture.replace(legacyCall, 'if (GlowPumpFixture.SamplePresentedFrame($1, want, bits, vw, vh) && want == 7')
  if (fixture.includes('DllImport("Magnification.dll")')) throw new Error('native cursor visibility binding survived isolation')
  fs.writeFileSync(observed, fixture)
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:GlowPumpFixture', '/out:' + exe,
      ...refs.map(ref => '/r:' + ref), observed, path.join(here, 'glow-pump-fixture.cs'), path.join(here, 'glow-hotkeys.cs'),
      path.join(here, 'glow-boundaries.cs'), path.join(here, 'glow-failures.cs'), path.join(here, 'glow-pointer.cs')],
    { windowsHide: true, timeout: 30000, stdio: 'inherit' })
  const cases = ['capture', 'pointer', 'pointer-fail-surface', 'pointer-fail-present', 'normal', 'resume', 'exit', 'pause-exit', 'poll-exit', 'queued-exit', 'hook-unavailable',
    'unsigned-normal', 'unsigned-exit', 'dry-run', 'one-shot-drain', 'present-recovery', 'present-timeout', 'present-stall', 'render-freeze']
  const selected = process.argv[3] ? cases.filter(name => name === process.argv[3]) : cases
  if (!selected.length) throw new Error('unknown test case')
  for (const name of selected) {
    const home = path.join(dir, name)
    fs.mkdirSync(home)
    const pointerFailure = name.startsWith('pointer-fail-') ? name.slice('pointer-fail-'.length) : ''
    execFileSync(exe, [pointerFailure ? 'pointer' : name], { windowsHide: true, timeout: name === 'present-timeout' ? 22000 : 15000, stdio: 'inherit', env: {
      ...process.env, DSH_HOME: home, DSH_COMPUTER_USE_STOP_FILE: path.join(home, 'STOP'),
      DSH_COMPUTER_USE_EXIT_FILE: path.join(home, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(home, 'audit.log'),
      DSH_COMPUTER_USE_OWNER_FILE: path.join(home, 'desktop.owner'),
      DSH_CU_POINTER_FAILURE: pointerFailure,
    } })
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
