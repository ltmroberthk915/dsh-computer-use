// Compile and exercise the production decision class, without worker Main, hooks or desktop input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { ComputerUse } from '../lib/core/index.js'

const worker = fs.readFileSync(new URL('../lib/core/worker.cs', import.meta.url), 'utf8')
const classStart = worker.indexOf('    public sealed class KickoffFocus')
const classEnd = worker.indexOf('    // ---------- interop ----------', classStart)
assert.ok(classStart > 0 && classEnd > classStart, 'production focus decision class missing')
const decision = worker.slice(classStart, classEnd)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kickoff-guard-'))
const fixture = path.join(dir, 'Fixture.cs')
const exe = path.join(dir, 'Fixture.exe')
fs.writeFileSync(fixture, `using System;
${decision}
public static class Fixture {
  static int checks;
  static void Check(bool value, string name) { checks++; if (!value) throw new Exception(name); }
  static bool Allowed(KickoffFocus f, bool active = true, bool paused = false, bool exited = false,
    bool exists = true, long current = 10, uint pid = 100, bool host = false) {
    return f.CaptureProblem(active, paused, exited, exists, current, pid, host) == null;
  }
  public static void Main() {
    var f = new KickoffFocus();
    Check(!Allowed(f), "new cycle must identify and activate before capturing");
    Check(!Allowed(f, host: true), "agent desktop is not kickoff orientation");
    Check(!Allowed(f), "failed activation cannot grant a capture");
    f.Confirm(10, 100);
    Check(Allowed(f), "confirmed foreground target may be captured");
    Check(Allowed(f), "later capture in the same cycle keeps qualification");
    Check(!Allowed(f, current: 20), "focus stolen after activation must refuse");
    Check(!Allowed(f, host: true), "host foreground must refuse");
    Check(!Allowed(f, exists: false), "closed browser window must refuse");
    Check(!Allowed(f, pid: 200), "reused HWND in a different process must refuse");
    f.Confirm(20, 200);
    Check(Allowed(f, current: 20, pid: 200), "explicit new target replaces old qualification");
    f.Reset();
    Check(!Allowed(f, current: 20, pid: 200), "a new cycle requires its own activation");
    Check(Allowed(f, active: false), "bare diagnostics stay available");
    Check(Allowed(f, paused: true, host: true), "pause inspection must not require driving");
    Check(Allowed(f, exited: true, host: true), "exit inspection must not require reopening");
    Check(KickoffFocus.InputProblem(10, false, 20) != null, "dead target must not fall through to Codex");
    Check(KickoffFocus.InputProblem(10, true, 20) != null, "failed refocus must refuse input");
    Check(KickoffFocus.InputProblem(10, true, 10) == null, "matching live target allows input");
    Check(KickoffFocus.InputProblem(0, false, 20) == null, "unbound legacy callers remain explicit");
    Console.WriteLine("ok kickoff focus: " + checks + " behavioral assertions");
  }
}`)
try {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, fixture], { windowsHide: true, timeout: 20000 })
  process.stdout.write(execFileSync(exe, [], { windowsHide: true, timeout: 20000 }))
} finally {
  // Remove only individually known files created by this guard, then its now-empty temp directory.
  for (const file of [fixture, exe]) if (fs.existsSync(file)) fs.unlinkSync(file)
  fs.rmdirSync(dir)
}

// Check the real call sites, so correct decisions cannot remain an unused test-only implementation.
const section = (start, end) => {
  const a = worker.indexOf(start), b = worker.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, `missing section ${start}`)
  return worker.slice(a, b)
}
const capture = section('static Dictionary<string, object> Capture(', 'static Dictionary<string, object>')
assert.equal((capture.match(/ValidateKickoffCapture\(a\)/g) || []).length, 3)
assert.ok(capture.indexOf('ValidateKickoffCapture(a)') < capture.indexOf('SettleWait('))
assert.ok(capture.lastIndexOf('ValidateKickoffCapture(a)') > capture.indexOf('Native.ReleaseDC('))
assert.match(capture, /catch \{ managed.Dispose\(\); throw; \}/)
const activate = section('static Dictionary<string, object> Activate(', 'static bool IsForeground')
assert.match(activate, /how == null \|\| !Native.IsWindow\(h\) \|\| !IsForeground\(h\)/)
assert.match(activate, /else\s*\{\s*SetSticky\(h\);\s*_kickoffFocus.Confirm\(h.ToInt64\(\), PidOf\(h\)\)/)
const light = section('public static bool TryLightCycle(', 'static bool RecordIsNewerThanProcess')
assert.match(light, /if \(!CycleLit\) Program.ResetKickoffFocus\(\);/)
const focus = section('static Dictionary<string, object> FocusReport(', 'static Dictionary<string, object> WindowOp(')
assert.equal((focus.match(/KickoffFocus.InputProblem\(/g) || []).length, 2)
assert.equal((focus.match(/throw new Exception\("INPUT-TARGET-REFUSED:/g) || []).length, 2)
assert.doesNotMatch(focus, /want = IntPtr.Zero; _stickyHwnd = IntPtr.Zero/)
for (const [start, end] of [['static Dictionary<string, object> Key(', 'static Dictionary<string, object> Type('], ['static Dictionary<string, object> Type(', 'static List<Dictionary<string, object>>']]) {
  const a = worker.indexOf(start)
  assert.ok(a > 0)
  const body = worker.slice(a, a + 1700)
  assert.match(body, /FocusReport\(a, true\)/)
}
const tools = fs.readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
assert.match(tools, /KICKOFF: first computer_state \{windows:true\}/)
assert.match(worker, /if \(!GetB\(a, "__kickoff", true\)\) return;/)
const plugin = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.match(plugin, /kickoffRequired: config.automationMode !== 'read-only'/)
// Exercise the real request signer with a fake pipe, never spawning a worker.
for (const required of [true, false]) {
  const cu = new ComputerUse({ workerExe: 'X:/never-started.exe', kickoffRequired: required })
  cu.ensureWorker = async () => {}
  let sent
  cu.proc = { stdin: { write(line) {
    sent = JSON.parse(line)
    cu.onLine(JSON.stringify({ id: sent.id, ok: true, data: {} }))
  } } }
  await cu.call('capture', { __kickoff: !required })
  assert.equal(sent.args.__kickoff, required, 'tool args must not override configured observation mode')
  assert.equal(sent.args.__cycle, true)
}
console.log('ok test-kickoff-focus — production decisions compiled; capture/activation/reset/input wiring checked; no worker Main or desktop input')
