// Offscreen pixel checks against the production C# painter. No desktop windows
// or input; artifacts include raw-alpha overlays and synthetic-page previews.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const source = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const worker = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n')
// Reviewed 2026-11-05 baseline includes adaptive preparation, scene hold/free, pointer companion,
// capture/drag/UIA evidence and handoff diagnostics; functional fixtures cover those changes.
// Re-reviewed 2026-11-06 against the 1.3.3 saved source: this release adds the
// direct kite pointer, shared native shape classification and an early guardian
// entrypoint with a bounded cursor visibility lease. The entire Glow painting
// block is byte-identical. Pointer/pump/lease fixtures cover these changes;
// cursor/drag fixtures retain native shape evidence and pre-dispatch checks.
// Re-reviewed 2026-11-06 against frozen 1.3.4: native differences are bounded UIA
// traversal/identity read budgets, exact window-management chord release and
// target invalidation, requested pixel witness regions, shift-click receiver
// guards, and honest BitBlt failure handling. The 12,315-character painting
// block remains byte-identical (normalized LF); verification-region, UIA-budget,
// and native-hardening fixtures cover the non-paint behavior independently.
// Re-reviewed 2026-11-07 (human rule): the countdown follows CONTINUITY OF A HANDS-OFF STATE, with
// no state fabricated anywhere. PrepareActuation gained a sliding grace window: after one countdown
// no further countdown of any duration is shown for the next 5 s, and every dispatched mutation
// pushes that deadline forward (MarkMutation), so a continuous sequence stays exempt indefinitely
// while a real pause lets the window lapse and the next action warns again. The window is RESET when
// the hands-off state itself ends (Glow.Kill → cycle release/calm/brake), so a later sequence warns
// from scratch. Glow's derivation, the 8-state ladder, the painting block and the pointer
// replacement are untouched — the kite still appears only for real acting/holding.
// Re-reviewed 2026-11-07 (fourth change, measured live with Word): SAME-INPUT-FAMILY. A modal
// dialog of the same app (Find/Replace, Save As) is a different hwnd that takes the foreground and
// used to be refused as INPUT_TARGET_CHANGED (keys) / KICKOFF-FOCUS-REQUIRED (screenshots), which
// made dialogs a blind black hole. Now: keyboard and point receivers accept a same-family
// foreground (same pid, descendant process, or owned/parented window) and follow it; activate
// adopts a modal dialog and reports hwnd+modalOf; the kickoff capture check accepts the family
// foreground. Mouse clicks keep the strict pixel-owner check — nothing is retargeted for clicks.
// Re-reviewed 2026-11-07 (fifth change): computer_focus / op focusField. Typing follows the focused control, not the window (measured: Word kept focus in the document while the Find dialog was foreground). The op clicks the field, reports the UIA focused control, and proves a caret either from GUITHREADINFO or a two-frame blink comparison; calls land in DrivesMachineOps so brake/audit/halo apply. New tool: computer_focus. Painting block untouched.
// Re-reviewed 2026-11-07 (sixth change): host-driving DEBUG GATES. Driving the agent's own Harness
// window used to be refused unconditionally; that also blocked self-iteration (debugging another
// plugin in the same instance), so two gates now exist, both set OUTSIDE a tool call: the CALLING
// conversation must be danger-full-access, and debug mode must be switched on by hand in
// Settings -> 电脑操控（调试）. The worker reads the switch hot (500 ms, no restart), stamps both
// flags per request from the core, refuses close/minimize/hide of the host even in debug mode, and
// audits every allowed host control as HOST-CONTROL. Everything outside the guard block (painting,
// pump, pointer, timing) is byte-identical.
// Re-reviewed 2026-11-08 (seventh change): NO-IDENTITY HARNESS PROTECTION. A worker launched
// without DSH_CU_HOST_PID/EXE (CLI, MCP, a test harness) has its guard fail-open by design, and
// on 2026-11-08 a harness used exactly that to send WM_CLOSE to the real Harness. windowOp
// close/minimize/hide now also refuses when the target image is DeepSeek Harness.exe and host
// identity is absent, unless the caller passes confirmHost:true. Painting block untouched.\n// Re-reviewed 2026-11-09: the host-debug click path clears its preliminary HOST-GUARDED label\n// after GuardHostDriving allows, so debug mode actually reaches the host. Painting block untouched.
const artStart = worker.indexOf('        // Thin, square screen-edge rails')
const artEnd = worker.indexOf('\n    }\n\n    // ---------- emergency stop ----------', artStart)
assert(artStart > 0 && artEnd > artStart, 'known contiguous presentation block')
const controlSource = (worker.slice(0, artStart) + '        /* VISUAL_PAINTING */\n' + worker.slice(artEnd))
  .replace('        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);\n', '')
  .replace('            TryExcludeOverlayFromCapture(hwnd);\n', '')
assert.equal(createHash('sha256').update(controlSource).digest('hex'),
  "31d527965d8ed2581f2db1c5b825ae81a79a295a894c36fc006364543d2ad5dd",
  'painting changes preserve the reviewed control logic, timing and window interaction styles')
assert(worker.includes('public static int HumanYieldAlpha(int tick)\n        { return 90 + (int)Math.Round(35 * (1 - Math.Cos((unchecked((uint)tick) % 2800) * 2 * Math.PI / 2800.0))); }'),
  'breathing timing inside painting region is unchanged')
const exclusion = worker.slice(worker.indexOf('        static void TryExcludeOverlayFromCapture('), worker.indexOf('        static void PaintBlue('))
assert.match(exclusion, /number >= 19041\)\s*SetWindowDisplayAffinity\(hwnd, 0x00000011\);/)
assert.equal((worker.match(/SetWindowDisplayAffinity\(hwnd,/g) || []).length, 1, 'no old-OS WDA_MONITOR fallback')

if (process.platform !== 'win32') {
  console.log('SKIP test-glow-visual — production GDI+ painter requires Windows')
  process.exit(0)
}
const output = path.resolve(process.env.DSH_CU_VISUAL_OUTPUT || path.join(import.meta.dirname, 'glow-visual-evidence'))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-glow-visual-'))
try {
  const win = process.env.WINDIR || 'C:/Windows', gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
    ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll')),
    path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
    path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
    path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd')]
  const exe = path.join(temp, 'fixture.exe')
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/main:GlowVisualFixture', '/out:' + exe, ...refs.map(r => '/r:' + r), source, path.join(import.meta.dirname, 'glow-visual-fixture.cs')],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' })
  const metrics = JSON.parse(execFileSync(exe, [output], { windowsHide: true, timeout: 30000, encoding: 'utf8',
    env: { ...process.env, DSH_COMPUTER_USE_OWNER_FILE: path.join(temp, 'owner'), DSH_COMPUTER_USE_STOP_FILE: path.join(temp, 'STOP'),
      DSH_COMPUTER_USE_EXIT_FILE: path.join(temp, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(temp, 'audit') } }))
  assert.equal(metrics.length, 15)
  for (const m of metrics) {
    const label = `${m.name} ${m.width}x${m.height}`
    assert.equal(m.edgeHoles, 0, label + ': every perimeter pixel is visible, including corners')
    assert(m.minCornerAlpha > 0, label + ': no rounded-corner blank gaps')
    assert.equal(m.outsidePixels, 0, label + ': capture decoration stays within requested rectangle')
    assert.equal(m.invalidPremultiplied, 0, label + ': alpha is valid for UpdateLayeredWindow')
    if (m.name.startsWith('capture') || m.name === 'thinking' || m.name === 'acting')
      assert.equal(m.contentPixels, 0, label + ': interior beyond the 1.6cm edge rail is transparent')
    else {
      assert(m.contentBounds, label + ': compact state hint remains visible')
      const b = m.contentBounds
      assert(b.width <= 620 && b.height <= 96, label + ': hint remains compact')
      assert(b.y >= 8 && b.y + b.height <= 120, label + ': hint stays in the top margin')
      assert(Math.abs(b.x + b.width / 2 - m.width / 2) < 4, label + ': hint stays centered')
    }
  }
  console.log(`ok test-glow-visual — ${metrics.length} offscreen renders; closed corners, continuous rails, transparent interiors, compact hints, crop bounds and premultiplied alpha; artifacts: ${output}`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
