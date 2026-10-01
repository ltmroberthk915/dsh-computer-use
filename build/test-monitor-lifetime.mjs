// build/test-monitor-lifetime.mjs
//
// CYCLE-LIFETIME guard for computer use (rewritten 2026-09-13 for the human's state model).
//
// THE MODEL THIS ENCODES (human, verbatim):
//   * "Computer use这个技能一旦启用, 立即挂打断监听和 computer ask 监听"
//        -> the monitors are armed for the WHOLE cycle, not only for a driving op.
//   * "从拉起到彻底退出之间, 任何情况下, CTRL+ALT+Q 直接退出"  and
//     "Computer use 周期结束之后, 所有跟 computer use 相关的监听, 全部都要终结."
//        -> the cycle is opened at the TURN boundary and killed (with its monitors) by calm/exit.
//   * "真正要解耦的是 computer use 的周期和会话周期 ... 周期结束之后, 必须得在下一个 session
//     开启之后才可能会再拉起新周期"
//        -> a cycle may be re-opened ONLY at the next turn boundary (the plugin's `resume`), never
//           by an op, never by a stray process, never by the plugin's own exit handler.
//
// WHY THIS FILE WAS REWRITTEN (2026-09-13, "R1 live cycle" self-test miss):
//   The old guard matched RAW source text, so a guard could be satisfied by a COMMENT that merely
//   quoted the code, and its self-test mutated with a NON-GLOBAL String.replace (first match only).
//   The literal `if (!CycleLit) return;` exists three times in worker.cs — Engage, EngageAsk and a
//   comment inside the dispatcher — so breaking Engage left two copies alive and the guard said
//   "still fine". Worse, the old self-test scored a mutation as "caught" when ANY invariant failed,
//   and two stale invariants failed on the pristine source, which made every mutation "caught".
//   Both defects are now structural, for every check:
//     * invariants run against COMMENT-STRIPPED source, and method-scoped invariants are anchored
//       on the enclosing method signature, so a comment or a sibling copy can never satisfy them;
//     * every mutation is applied GLOBALLY (lastIndex reset), asserted to have actually CHANGED the
//       text, and asserted to break THE CHECK IT BELONGS TO (attribution, not "something failed").
//
// Self-tested: a guard that cannot fire is worse than no guard.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = {
  worker: 'lib/core/worker.cs',
  core: 'lib/core/index.js',
  plugin: 'lib/index.js',
  tools: 'lib/tools.js',
  // The cycle GATE (identity, ownership, per-turn qualification). It is part of the plugin's layer,
  // so "no module in lib/ may open a cycle behind the gate's back" has to include it.
  cycle: 'lib/cycle.js',
}

/**
 * Remove comments while PRESERVING newlines (so line numbers and `[\s\S]{0,n}` windows stay
 * meaningful). String / char / verbatim literals are copied through untouched, so a "//" inside a
 * URL is not mistaken for a comment. This is the fix for "a guard satisfied by a comment": every
 * invariant below runs on the stripped text.
 */
function stripComments (src) {
  let out = ''
  let i = 0
  const n = src.length
  const keepNewlines = (from, to) => { for (let k = from; k < to; k++) if (src[k] === '\n') out += '\n' }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const t0 = i
      while (i < n && src[i] !== '\n') i++
      keepNewlines(t0, i)
      continue
    }
    if (c === '/' && d === '*') {
      const t0 = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      keepNewlines(t0, i)
      continue
    }
    if (c === '@' && d === '"') { // C# verbatim string
      out += '@"'; i += 2
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { out += '""'; i += 2; continue }
          out += '"'; i++; break
        }
        out += src[i]; i++
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') { // string / char / template literal
      out += c; i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] === undefined ? '' : src[i + 1]); i += 2; continue }
        out += src[i]
        if (src[i] === c) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const RAW = {}
const CODE = {}
for (const [key, rel] of Object.entries(FILES)) {
  RAW[key] = fs.readFileSync(path.join(root, rel), 'utf8')
  CODE[key] = stripComments(RAW[key])
}
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

// Every module of the plugin's own layer that this guard reads (lib/*.js):
// "no module OUTSIDE lib/index.js may open a cycle" is checked against this whole set, not against
// one hard-coded filename a new module could slip past.
const LIB_KEYS = Object.entries(FILES).filter(([, rel]) => rel.startsWith('lib/'))

// ---- slicing helpers -------------------------------------------------------------------------
const CS_END = '\n        }'      // a method's closing brace in worker.cs (8-space indent)
const JS_END = '\n  }'            // a class method's closing brace in the JS files
const HANDLER_END = '\n  })'      // the closing brace of a `x.on(...)` handler in the plugin

/** Slice from `sig` to the first `end` at/after it (the slice INCLUDES `end`). */
function sliceRange (text, sig, end) {
  const i = text.indexOf(sig)
  if (i < 0) return null
  const j = text.indexOf(end, i + sig.length)
  if (j < 0) return null
  return { start: i, end: j + end.length, text: text.slice(i, j + end.length) }
}

const SIG = {
  engage: 'public static void Engage(string why, bool temporary, string source, string evidence)',
  engageAsk: 'public static void EngageAsk(string why)',
  agentCalling: 'public static bool AgentCalling(string expectExit)',
  checkOp: 'public static void CheckOp(string op)',
  exit: 'public static void Exit(string why, string source, string evidence)',
  // ONE ending for the question (merge-design.md §5.1 item 4): `AskExpired` and `AskSettled` were
  // folded into `EndAsk`, and the raise-and-return half of `AskOp` became `BeginAskOp`.
  endAsk: 'public static void EndAsk(int id, bool keepPause, string via)',
  beginAskOp: 'static Dictionary<string, object> BeginAskOp(Dictionary<string, object> a)',
  coreResume: 'async resume (expectExit)',
  pluginExitHandler: "cu.on('exit'",
  pluginSessionEvent: "ctx.on('session/event'",
}

const R1 = 'if (!CycleLit) return;'

// The teardown an exit runs — DETECTED or ADOPTED (they must be indistinguishable from outside).
const TEARDOWN_SIG = 'static void ApplyExitTeardown()'

// ---- the invariants --------------------------------------------------------------------------
// Every check is { name, file, re | fn, brks: [mutation, ...] }.
//   re   -> the pattern MUST be present (absent = the invariant is broken)
//   fn   -> returns null while the invariant holds, or the reason it is broken
//   brks -> [ [find, with], ... ] or [ { scope, end, find, with }, ... ] : a mutation that MUST
//           make THIS check fail. `find` may be a RegExp or a plain string (string = replaced
//           globally via split/join, i.e. every occurrence).
const CHECKS = [
  // ------------------------------------------------------------------ the human monitors
  {
    name: 'the human-monitor arm flag still exists and defaults OFF',
    file: 'worker',
    re: /static volatile bool _armed = false;/,
    brks: [[/static volatile bool _armed = false;/, 'static volatile bool _armed = true;']],
  },
  {
    name: 'MonitorHuman returns immediately while the monitors are NOT armed',
    file: 'worker',
    re: /if \(!_armed\) \{ _monHave = false; return; \}/,
    brks: [[/if \(!_armed\) \{ _monHave = false; return; \}/, 'if (false) { _monHave = false; return; }']],
  },
  {
    name: 'the keyboard mirror is gated on the armed monitors',
    file: 'worker',
    re: /else if \(_armed && Program\.HostConfigured\(\)/,
    brks: [[/else if \(_armed && Program\.HostConfigured\(\)/, 'else if (Program.HostConfigured()']],
  },
  {
    name: 'calm() ends the cycle AND disarms the monitors',
    file: 'worker',
    re: /case "calm":[\s\S]{0,200}?Panic\.CycleLit = false;[\s\S]{0,200}?Panic\.Disarm\(\);/,
    brks: [[/Panic\.Disarm\(\);/, 'Panic.DisarmX();']],
  },
  {
    // R2, RESTORED TO ITS ORIGINAL SCOPE after the cold-start fix over-reached (2026-09-13): the red
    // and its announcement belong to a stop that lands on a LIVE cycle. Making them depend only on
    // "not exited" painted a red border for a bare worker start (health probe, deploy check, no
    // computer use at all) — the old "red with nothing running" lie, against the rule that a cycle
    // opens on the FIRST REAL USE. What replaces it is TryLightCycle: the first signed call lights
    // the cycle and then shows the ordinary PAUSE red because a brake is standing.
    name: 'the cross-process brake SHOWS red, and is ANNOUNCED, only for a live un-exited cycle (R2)',
    file: 'worker',
    fn: (s) => {
      if (!/bool showRed = !_exited && CycleLit;/.test(s)) return 'showRed no longer requires a LIVE cycle — a worker started without any computer use would paint the red border'
      if (!/if \(showRed\) Notify\("panic", _why\);/.test(s)) return 'the adopted stop is announced outside a live cycle again (an inherited STOP must not look like a fresh key press)'
      // ... and the real first call must still choose the pause red over "thinking" when braked
      const t = sliceRange(s, 'public static bool TryLightCycle(int thinkMs)', CS_END)
      if (!t) return 'TryLightCycle is gone'
      if (!/if \(_engaged \|\| _stopped\)[\s\S]{0,300}?Glow\.Stopped\(true\)/.test(t.text)) return 'TryLightCycle no longer paints the PAUSE red when a brake stands — the first real call would hide an existing stop behind cyan'
      return null
    },
    brks: [
      { find: /bool showRed = !_exited && CycleLit;/, with: 'bool showRed = !_exited;' },
      { find: /if \(showRed\) Notify\("panic", _why\);/, with: 'Notify("panic", _why);' },
      { scope: 'public static bool TryLightCycle(int thinkMs)', end: CS_END, find: /if \(_engaged \|\| _stopped\)/, with: 'if (false)' },
    ],
  },
  {
    name: 'a mouse swing must be big (HumanLegPx >= 80 physical px)',
    file: 'worker',
    re: /const int HumanLegPx = (\d+);/,
    fn: (s) => {
      const m = /const int HumanLegPx = (\d+);/.exec(s)
      if (!m) return 'HumanLegPx — pattern not found'
      return Number(m[1]) >= 80 ? null : `HumanLegPx = ${m[1]} px — at 175% scaling that is hand tremor, not a swing`
    },
    brks: [[/const int HumanLegPx = \d+;/, 'const int HumanLegPx = 24;']],
  },
  {
    // THE WHEEL MUST NOT BRAKE ON ONE NOTCH (2026-09-15).
    //
    // The wheel monitor used to brake on ANY `delta != 0`, i.e. a single 120-notch click stopped the
    // machine. The human must be able to scroll to read, to work and to talk to the agent, so the
    // signal could not separate "reading a page" from "get off my machine" — the exact defect the
    // 604 px distance rule was switched OFF for ("a signal that cannot separate those two cases must
    // not drive a brake", said of HumanTravelEnabled just above these constants). Measured cost: every
    // attempt to use the machine braked the session; the human reported "无端触发 computer use 中止".
    name: 'the wheel needs SEVERAL notches to brake (WheelNotches >= 4 in a short window)',
    file: 'worker',
    fn: (s) => {
      const n = /const int WheelNotches = (\d+);/.exec(s)
      const w = /const int WheelWindowMs = (\d+);/.exec(s)
      if (!n) return 'WheelNotches is gone — a single notch brakes the session again'
      if (!w) return 'WheelWindowMs is gone — the notch count has no window, so it accumulates forever and ordinary reading eventually brakes'
      if (Number(n[1]) < 4) return `WheelNotches = ${n[1]} — ordinary scrolling reaches that, so the wheel is a false-positive machine again`
      if (Number(w[1]) > 3000) return `WheelWindowMs = ${w[1]} — too long a window makes the count accumulate across separate scroll gestures`
      // The count must be RESET when the window expires, or `_wheelN` grows without bound and a long
      // reading session trips the brake no matter how high the bar is.
      if (!/_wheelN = 0; _wheelT0 = now;/.test(s)) return 'the wheel counter is never reset on window expiry — a long scroll session accumulates and brakes anyway'
      // ...and the brake must be conditioned on the count, not on a bare delta.
      if (/if \(delta != 0\)\s*\n\s*Engage\(/.test(s)) return 'the wheel brakes on a bare delta again — one notch is not a takeover'
      // ...AND THE CONDITION ITSELF MUST EXIST. Without this clause, replacing the test with `if
      // (true)` walks straight through every other assertion here (they check the constants' VALUES
      // and the reset, not that the count is what gates the brake) — measured: that mutation was the
      // one this guard could not catch on its first run. A guard that pins a threshold but not its use
      // pins nothing.
      if (!/if \(_wheelN >= WheelNotches\)/.test(s)) return 'the wheel no longer brakes on the NOTCH COUNT — the threshold constants are decoration and the brake fires on whatever the surrounding condition happens to be'
      return null
    },
    brks: [
      { file: 'worker', find: /const int WheelNotches = \d+;/, with: 'const int WheelNotches = 1;' },
      { file: 'worker', find: /if \(_wheelN >= WheelNotches\)/, with: 'if (true)' },
      { file: 'worker', find: /_wheelN = 0; _wheelT0 = now;/, with: '_wheelT0 = now;' },
    ],
  },

  // ------------------------------------------------------------------ R1: no red without a cycle
  // METHOD-SCOPED on purpose: the literal `if (!CycleLit) return;` exists in BOTH setters (Engage
  // and EngageAsk) plus a comment, so a bare-text check can be satisfied by the wrong copy.
  {
    name: 'R1 on the BRAKE: Engage refuses to light red without a LIVE cycle',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.engage, CS_END)
      if (!body) return 'Engage(string why) not found'
      const guard = body.text.indexOf(R1)
      if (guard < 0) return 'Engage() no longer refuses to light red without a live cycle'
      if (guard > body.text.indexOf('_engaged = true;')) return 'Engage() lights the brake BEFORE it checks that a cycle is live'
      return null
    },
    brks: [
      { scope: SIG.engage, end: CS_END, find: /if \(!CycleLit\) return;/, with: 'if (false) return;' },
      // commenting the guard out leaves the literal in the FILE (twice: this comment + the one in
      // the dispatcher). The old raw-text guard still matched it and called the mutant healthy;
      // this guard must still fire.
      { scope: SIG.engage, end: CS_END, find: /if \(!CycleLit\) return;/, with: '// if (!CycleLit) return;' },
    ],
  },
  {
    name: 'R1 on the ASK border: EngageAsk refuses too (an ask IS a red border)',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.engageAsk, CS_END)
      if (!body) return 'EngageAsk(string why) not found'
      const guard = body.text.indexOf(R1)
      if (guard < 0) return 'EngageAsk() can light the ask border with no live cycle'
      if (guard > body.text.indexOf('_engaged = true;')) return 'EngageAsk() stops the machine BEFORE it checks that a cycle is live'
      return null
    },
    brks: [
      { scope: SIG.engageAsk, end: CS_END, find: /if \(!CycleLit\) return;/, with: 'if (false) return;' },
    ],
  },

  // ------------------------------------------------------------------ the __cycle gate
  {
    name: '__cycle is the ONLY way into a cycle, and it excludes the plugin\'s housekeeping ops',
    file: 'worker',
    fn: (s) => {
      const gate = sliceRange(s, 'bool cycleOp = GetB(a, "__cycle", false)', ';')
      if (!gate) return 'the `bool cycleOp = GetB(a, "__cycle", false)` gate is gone — a cycle could open from anywhere'
      for (const op of ['abort', 'ping', 'echoargs', 'indicator', 'calm', 'panic', 'resume']) {
        if (!gate.text.includes(`op != "${op}"`)) return `the __cycle gate no longer excludes "${op}" (the plugin sends it by itself as housekeeping)`
      }
      return null
    },
    brks: [
      { find: /GetB\(a, "__cycle", false\)/, with: 'true' },
      { find: /op != "indicator" && op != "calm" && op != "panic" && op != "resume"/, with: 'op != "resume"' },
    ],
  },
  {
    name: 'the indicator NAMES the state: 监听中 only while listening, 未监听 once the cycle is over',
    file: 'worker',
    fn: (s) => {
      if (!/PaintBadge\(g, "监听中 · ESC 暂停 · Ctrl\+Alt\+Q 退出"/.test(s)) return 'the live badge no longer says 监听中'
      if (!/PaintBadge\(g, "已暂停 · Ctrl\+Alt\+R 继续 · Ctrl\+Alt\+Q 退出"/.test(s)) return 'the pause badge no longer names both keys (Ctrl+Alt+R 继续 / Ctrl+Alt+Q 退出)'
      if (!/"AI 已停止操控 · 未监听"/.test(s)) return 'the idle title no longer says 未监听 — a dead cycle would read like a live one'
      return null
    },
    brks: [
      { find: /监听中 · ESC 暂停 · Ctrl\+Alt\+Q 退出/, with: '运行中 · ESC 暂停 · Ctrl+Alt+Q 退出' },
      { find: /"AI 已停止操控 · 未监听"/, with: '"AI 已停止操控"' },
    ],
  },
  {
    name: 'the exit record reader distinguishes "no file" from "cannot read it"',
    file: 'worker',
    fn: (s) => {
      const b = sliceRange(s, 'public static string ReadMarkerText()', CS_END)
      if (!b) return 'ReadMarkerText() not found'
      if (!/if \(!File\.Exists\(p\)\) return "";/.test(b.text)) return 'ReadMarkerText() no longer returns "" for a genuinely absent record'
      if (!/catch \{ return null; \}/.test(b.text)) return 'a READ FAILURE is reported as "" (nothing to clear) instead of null — a locked record would look like an empty one'
      return null
    },
    brks: [{ scope: 'public static string ReadMarkerText()', end: CS_END, find: /catch \{ return null; \}/, with: 'catch { return ""; }' }],
  },
  {
    name: 'the cycle is LIT, and the monitors ARMED, inside that branch and nowhere else',
    file: 'worker',
    fn: (s) => {
      const block = sliceRange(s, 'if (cycleOp)', CS_END.slice(1))
      if (!block) return 'the `if (cycleOp)` branch is gone'
      if (!/Panic\.TryLightCycle\(/.test(block.text)) return 'the __cycle branch no longer lights the cycle through Panic.TryLightCycle'
      const t = sliceRange(s, 'public static bool TryLightCycle(int thinkMs)', CS_END)
      if (!t) return 'TryLightCycle is gone — lighting would be a check-then-act race with the exit thread again'
      if (!/lock \(SyncLock\)/.test(t.text)) return 'TryLightCycle does not share an ordered boundary (SyncLock) with Panic.Exit'
      const guard = t.text.indexOf('if (_exited) return false;')
      const lit = t.text.indexOf('CycleLit = true;')
      const arm = t.text.indexOf('Arm();')
      if (guard < 0 || lit < 0 || arm < 0) return 'TryLightCycle no longer checks the exit and then lights AND arms the cycle'
      if (guard > lit || guard > arm) return 'TryLightCycle checks the exit AFTER lighting — a Ctrl+Alt+Q between the check and the write would re-light a dead cycle'
      const other = [...s.matchAll(/CycleLit\s*=\s*true/g)].map((m) => m.index).filter((i) => i < t.start || i > t.end)
      if (other.length) return `CycleLit is set true in ${other.length} place(s) outside TryLightCycle — the gate is not the only way in`
      const armed = [...s.matchAll(/Panic\.Arm\(\)/g)].map((m) => m.index).filter((i) => i < t.start || i > t.end)
      const clear = sliceRange(s, 'public static void Clear()', CS_END)
      const stray = armed.filter((i) => !(clear && i >= clear.start && i <= clear.end))
      if (stray.length) return `Panic.Arm() is called ${stray.length} time(s) outside TryLightCycle and Clear() — a monitor would outlive its cycle`
      return null
    },
    brks: [
      // the exit check moved AFTER the light: the F2 timing the review flagged is back
      { scope: 'public static bool TryLightCycle(int thinkMs)', end: CS_END,
        find: /if \(_exited\) return false;/,
        with: 'CycleLit = true;\n                if (_exited) return false;' },
      // the ordered boundary removed
      { find: /public static bool TryLightCycle\(int thinkMs\)\n        \{\n            lock \(SyncLock\)/, with: 'public static bool TryLightCycle(int thinkMs)\n        {\n            {' },
      // a second, unguarded way to light the cycle
      { find: /case "calm":/, with: 'case "calm":\n                    Panic.CycleLit = true;' },
    ],
  },
  {
    name: 'the OLD denylist cycle-opener is gone (the cycle belongs to the TURN, not to an op)',
    file: 'worker',
    fn: (s) => {
      if (/Panic\.DrivesMachineOps\.Contains\(/.test(s)) return 'the old `if (op != null && Panic.DrivesMachineOps.Contains(op)) Panic.AgentCalling();` branch is back: an OP can open a cycle again'
      if (/DrivesMachineOps\.Contains\(op\)\)\s*Panic\.AgentCalling\(\)/.test(s)) return 'the old denylist cycle-opener is back'
      return null
    },
    brks: [{
      find: /bool cycleOp = GetB\(a, "__cycle", false\)/,
      with: 'if (op != null && Panic.DrivesMachineOps.Contains(op)) Panic.AgentCalling();\n            bool cycleOp = GetB(a, "__cycle", false)',
    }],
  },
  {
    name: 'calm is still excluded from the cycle gate (it undid Ctrl+Alt+Q once)',
    file: 'worker',
    re: /op != "indicator" && op != "calm"/,
    brks: [[/op != "indicator" && op != "calm"/, 'op != "indicator"']],
  },
  {
    name: 'AgentCalling is called from exactly ONE place — case "resume" — and never arms the monitors',
    file: 'worker',
    fn: (s) => {
      const calls = [...s.matchAll(/Panic\.AgentCalling\(/g)].map((m) => m.index)
      if (calls.length !== 1) return `Panic.AgentCalling(...) has ${calls.length} call site(s) — exactly one is allowed, and it must be case "resume"`
      const stmt = sliceRange(s, 'case "resume":', '\n                case "waitStable":')
      if (!stmt || calls[0] < stmt.start || calls[0] > stmt.end) return 'the single AgentCalling(...) call site is NOT inside case "resume"'
      const body = sliceRange(s, SIG.agentCalling, CS_END)
      if (!body) return 'AgentCalling() not found'
      if (/Arm\(\)/.test(body.text)) return 'AgentCalling() arms the monitors again — the monitors would then run through turns that never touch this machine'
      if (!/File\.Delete\(path\)/.test(body.text)) return 'AgentCalling() no longer deletes the EXITED marker: Ctrl+Alt+Q would outlive the new cycle'
      // #6: the caller's expectation is compared AGAINST THE RECORD inside the same lock Exit writes
      // it in, so a resume that was already in flight cannot clear a newer Ctrl+Alt+Q.
      if (!/lock \(SyncLock\)/.test(body.text)) return 'AgentCalling() no longer shares the ordered boundary (SyncLock) with Exit()'
      if (!/ReadMarkerText\(\)/.test(body.text) || !/!= expectExit/.test(body.text)) return 'AgentCalling() no longer compares the exit record the caller saw — an older resume could clear a newer Q'
      if (!/if \(id != _askId\) return;/.test(s) && !/RESUME-REFUSED/.test(s)) return 'a refused resume is not reported (no RESUME-REFUSED)'
      // API BUG (2026-09-13): success used to be reported after a SWALLOWED delete, with the flag
      // flipped first — with the record held open by another process, `resume` answered cycleOpen:true
      // while the record was still on disk. Success must now depend on the record really being gone.
      if (!/string path = ExitMarkerPath\(\)/.test(body.text)) return 'AgentCalling() no longer works on one resolved marker path'
      if (!/catch \(Exception ex\)/.test(body.text)) return 'the delete failure is swallowed again — success would be claimed without the record being gone'
      if (!/the exit record is STILL PRESENT after a delete/.test(body.text)) return 'the delete is not VERIFIED after it returns (Delete() not throwing is not proof)'
      const flip = body.text.indexOf('_exited = false;')
      const del = body.text.indexOf('File.Delete(path);')
      if (flip >= 0 && del >= 0 && flip < del) return 'the exit flag is flipped BEFORE the record is deleted — the flag and the disk can disagree'
      return null
    },
    brks: [
      { find: /case "panic": Panic\.Engage\(/, with: 'case "panic": Panic.AgentCalling(null); Panic.Engage(' },
      { find: /public static bool AgentCalling\(string expectExit\)\n        \{\n            lock \(SyncLock\)\n            \{/, with: 'public static bool AgentCalling(string expectExit)\n        {\n            lock (SyncLock)\n            {\n                Arm();' },
      // the expectation comparison removed: an older resume clears a newer record again
      { find: /if \(found != expectExit\)/, with: 'if (false)' },
    ],
  },
  {
    name: 'the EXITED latch is cleared in exactly ONE place: AgentCalling()',
    file: 'worker',
    fn: (s) => {
      const clears = [...s.matchAll(/\n\s*_exited = false;/g)].map((m) => m.index)
      if (clears.length !== 1) return `_exited = false appears ${clears.length} time(s) — only AgentCalling() may clear the Ctrl+Alt+Q latch`
      const body = sliceRange(s, SIG.agentCalling, CS_END)
      if (!body || clears[0] < body.start || clears[0] > body.end) return 'the Ctrl+Alt+Q latch is cleared somewhere other than AgentCalling()'
      return null
    },
    brks: [{ find: /case "calm":/, with: 'case "calm":\n                    _exited = false;' }],
  },

  // ------------------------------------------------------------------ CheckOp / Exit / resume
  {
    name: 'CheckOp refuses a DEAD cycle BEFORE its early return (else the refusal is dead code)',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.checkOp, CS_END)
      if (!body) return 'CheckOp(string op) not found'
      const refusal = body.text.indexOf('_exited && op != null && DrivesMachineOps.Contains(op)')
      const early = body.text.indexOf('if (!_stopped || op == null || ReadOnlyOps.Contains(op) || op == "exit") return;')
      if (refusal < 0) return 'CheckOp no longer refuses during a dead cycle (CYCLE-ENDED is gone)'
      if (early < 0) return "CheckOp's stopped/read-only early return was not found"
      if (refusal > early) return 'the CYCLE-ENDED refusal sits AFTER the early return — dead code: a dead cycle would drive the machine again'
      if (!/CYCLE-ENDED: /.test(body.text)) return 'the CYCLE-ENDED refusal message is gone'
      return null
    },
    brks: [{
      scope: SIG.checkOp,
      end: CS_END,
      find: /if \(_exited && op != null && DrivesMachineOps\.Contains\(op\)\)/,
      with: 'if (!_stopped || op == null || ReadOnlyOps.Contains(op) || op == "exit") return;\n            if (_exited && op != null && DrivesMachineOps.Contains(op))',
    }],
  },
  {
    name: 'Exit() kills the cycle, disarms the monitors, and clears EVERY visual flag',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.exit, CS_END)
      if (!body) return 'Exit(why, source, evidence) not found'
      // 2026-09-13: the cleanup is SHARED with an adopted record now (SyncExitedFromFile), because
      // a process that says "exited" while its cyan border keeps breathing is the contradiction the
      // human photographed. So Exit must ROUTE THROUGH the teardown, and the flags are asserted
      // where they live — asserting only Exit's own body would pass while the teardown rotted.
      if (!/ApplyExitTeardown\(\)/.test(body.text)) {
        return 'Exit() no longer routes through the shared teardown — a detected exit and an ADOPTED one would drift apart'
      }
      const tear = sliceRange(s, TEARDOWN_SIG, CS_END)
      if (!tear) return 'Exit() routes through ApplyExitTeardown() but that method is missing'
      const scope = body.text + '\n' + tear.text
      const need = [
        ['CycleLit = false;', 'the cycle stays lit after Ctrl+Alt+Q'],
        ['Disarm();', 'the human monitors (and the wheel hook) outlive the cycle'],
        ['Glow.Kill()', 'the overlay survives the exit'],
        ['Glow.Ask(false)', 'the ASK border survives the exit'],
        ['Glow.Stopped(false)', 'the STOP border survives the exit'],
      ]
      for (const [token, why] of need) if (!scope.includes(token)) return `Exit() no longer clears "${token}" — ${why}`
      return null
    },
    brks: [
      { scope: SIG.exit, end: CS_END, find: /ApplyExitTeardown\(\);/, with: '/* teardown skipped */' },
      { scope: TEARDOWN_SIG, end: CS_END, find: /Disarm\(\);/, with: '/* monitors kept */' },
      { scope: TEARDOWN_SIG, end: CS_END, find: /CycleLit = false;/, with: '' },
      { scope: TEARDOWN_SIG, end: CS_END, find: /try \{ Glow\.Ask\(false\); \} catch \{ \}/, with: '' },
      { scope: TEARDOWN_SIG, end: CS_END, find: /try \{ Glow\.Stopped\(false\); \} catch \{ \}/, with: '' },
    ],
  },
  {
    name: 'resume opens a NEW cycle WITHOUT releasing a human pause (only Ctrl+Alt+R does)',
    file: 'worker',
    fn: (s) => {
      const stmt = sliceRange(s, 'case "resume":', '\n                case "waitStable":')
      if (!stmt) return 'case "resume" not found'
      if (!/Panic\.AgentCalling\(GetS\(a, "expectExit", null\)\)/.test(stmt.text)) return 'case "resume" no longer opens the cycle with the caller\'s expected record'
      if (!/RESUME-REFUSED/.test(stmt.text)) return 'case "resume" no longer refuses a record newer than the one the opener saw'
      if (!/cycleOpen/.test(stmt.text)) return 'case "resume" no longer reports the cycle state'
      for (const forbidden of ['Panic.Clear()', 'DeleteStopFile()', '_engaged = false', '_stopped = false']) {
        if (stmt.text.includes(forbidden)) return `case "resume" releases the human's pause ("${forbidden}") — a new turn must never undo the brake a human raised`
      }
      return null
    },
    brks: [{ find: /case "resume":\n                    \/\/ The expected exit record rides along/, with: 'case "resume":\n                    Panic.Clear();\n                    // The expected exit record rides along' }],
  },
  {
    name: "Clear() (the human's Ctrl+Alt+R) re-arms the monitors ONLY while the cycle is live",
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, 'public static void Clear()', CS_END)
      if (!body) return 'Clear() not found'
      if (!/if \(CycleLit\) Arm\(\); else Disarm\(\);/.test(body.text)) {
        return 'Clear() no longer ties the monitors to the cycle: either Ctrl+Alt+R never brings them back, or they listen outside a cycle'
      }
      return null
    },
    brks: [
      { scope: 'public static void Clear()', end: CS_END, find: /if \(CycleLit\) Arm\(\); else Disarm\(\);/, with: 'Disarm();' },
      { scope: 'public static void Clear()', end: CS_END, find: /if \(CycleLit\) Arm\(\); else Disarm\(\);/, with: 'Arm();' },
    ],
  },
  {
    name: 'probe reports the state machine as a FACT (the cycle, and what the indicator shows)',
    file: 'worker',
    fn: (s) => {
      const c = sliceRange(s, 'case "probe":', '\n                }')
      if (!c) return 'the probe case is gone — the state machine would have no ground-truth readout'
      for (const token of ['"cycleLit", Panic.CycleLit', '"armed", Panic.Armed', '"engaged", Panic.Engaged',
        '"stopped", Panic.Stopped', '"exited", Panic.Exited', '"want", Glow.Want']) {
        if (!c.text.includes(token)) return `probe no longer reports ${token}`
      }
      return null
    },
    brks: [
      { scope: 'case "probe":', end: '\n                }', find: /"armed", Panic\.Armed,/, with: '' },
      { scope: 'case "probe":', end: '\n                }', find: /"exited", Panic\.Exited,/, with: '' },
    ],
  },

  // ------------------------------------------------------------------ the ask window
  {
    // RETARGETED (merge-design.md §6 G7, and the brief's D3 refinement). The old check pinned
    // "`via == "answered"` keeps the pause, every other `via` releases". D3 makes that WRONG: the card
    // offers ① 让你停 / ② 放你走 as ordinary options, so a submitted answer is not automatically a
    // pause — the PAUSE FOLLOWS THE HUMAN'S CHOSEN OPTION, and every ending that is not ① releases.
    // `via` is an audit label. The EXIT-outranks-both check is kept, unchanged in force.
    name: 'EndAsk: the pause follows the chosen option, every other ending releases — and an EXIT outranks both',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.endAsk, CS_END)
      if (!body) return 'EndAsk(int id, bool keepPause, string via) not found'
      // 1. the exit check comes FIRST, before either ending runs.
      const exitAt = body.text.indexOf('if (_exited) return;')
      const keepAt = body.text.indexOf('if (keepPause)')
      const dropAt = body.text.indexOf('if (!_engaged || !_stopped) return;')
      if (exitAt < 0) return 'EndAsk does not let an EXIT outrank the ending — it would repaint the border of a session the human just ended'
      if (keepAt < 0) return "EndAsk has no keepPause branch — ① 让你停 on the card would release a brake the human asked to keep"
      if (exitAt > keepAt) return 'the exit check sits AFTER the keepPause branch — an exit would be overridden by the question ending'
      // 2. the pause branch is chosen by the HUMAN's decision, never derived from how the call ended.
      //    (`via == null` just above is the null-guard on the audit label, not a decision.)
      if (/if \(via\s*==/.test(body.text)) return 'EndAsk derives the pause from `via` — `via` is an audit label and the pause belongs to the option the human clicked'
      if (dropAt < 0) return 'EndAsk has no release branch for every other ending — ② 放你走, a dismissal and an abort would all leave the brake up'
      if (dropAt < keepAt) return 'the release branch precedes the keepPause branch — the ordering no longer reads as "keep only when told to"'
      return null
    },
    brks: [
      // mutate the DECISION, not a co-occurring token: making the branch read `via` is the pre-D3 rule.
      { scope: SIG.endAsk, end: CS_END, find: /if \(keepPause\)/, with: 'if (via == "answered")' },
      // and the exit must stay ahead of it.
      { scope: SIG.endAsk, end: CS_END, find: /if \(_exited\) return;/, with: 'if (false) return;' },
    ],
  },
  {
    name: 'BeginAskOp refuses to open an ask outside a live cycle (NO-CYCLE)',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.beginAskOp, CS_END)
      if (!body) return 'BeginAskOp not found'
      const engage = body.text.indexOf('Panic.EngageAsk(')
      const guard = body.text.indexOf('if (!Panic.Engaged)')
      if (engage < 0) return 'BeginAskOp no longer engages the ask brake'
      if (guard < 0 || guard < engage) return 'BeginAskOp does not verify the ask actually engaged — an ask outside a cycle would report stopped:true while stopping nothing'
      if (!/NO-CYCLE/.test(body.text)) return 'the NO-CYCLE refusal is gone'
      // AND IT MUST NOT WAIT (merge-design.md §2.1 invariant 4): the whole merge is "engage and
      // return". A loop or a clock read here re-creates the head-of-line blocking verify4 §3.B
      // measured and the kill-while-holding-the-brake ending that leaked the STOP file.
      if (/while \(/.test(body.text)) return 'BeginAskOp contains a wait loop — the worker must never be occupied by the wait'
      if (/Native\.LastInputTick\(\)/.test(body.text)) return 'BeginAskOp samples the input clock — the worker no longer judges when a question ends'
      return null
    },
    brks: [
      { scope: SIG.beginAskOp, end: CS_END, find: /if \(!Panic\.Engaged\)/, with: 'if (false)' },
      { scope: SIG.beginAskOp, end: CS_END, find: /Panic\.EngageAsk\(q\);/, with: 'Panic.EngageAsk(q);\n            int t0 = Environment.TickCount;\n            while (unchecked(Environment.TickCount - t0) < 60000) { Thread.Sleep(40); }' },
    ],
  },
  {
    name: 'EndAsk hands the machine back — and never fakes a "resume" the human did not do',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, SIG.endAsk, CS_END)
      if (!body) return 'EndAsk() not found'
      const need = [
        ['_engaged = false;', 'the brake stays engaged'],
        ['_stopped = false;', 'the session stays stopped'],
        ['Glow.Ask(false)', 'the ask border stays lit'],
        ['Glow.Stopped(false)', 'the stop border stays lit'],
        ['ResetMonitorRun()', 'stale travel brakes the moment the agent resumes'],
      ]
      for (const [token, why] of need) if (!body.text.includes(token)) return `EndAsk() no longer clears "${token}" — ${why}`
      if (/Notify\("resume"/.test(body.text)) return 'EndAsk() notifies "resume" — no human re-armed anything, so that event would lie to the agent'
      // RELEASE FAILURE (2026-09-13, real FileShare.Read lock): the brake may only be unwound on a
      // release that actually reached the disk — otherwise the reply claims a machine that is still
      // stopped and the next poll re-adopts the brake.
      if (!/if \(!DeleteStopFile\(\)\)/.test(body.text)) return 'EndAsk() no longer gates the unwind on a VERIFIED release — it would clear state while the STOP file survives'
      // The retired "ASK-EXPIRED-*" wording became "ASK-RELEASE-*" with the rename; the BRANCHES are
      // live and must not be dropped (merge-design.md §2.4).
      if (!/ASK-RELEASE-STOP-LOCKED/.test(body.text)) return 'a locked ask brake is not recorded (ASK-RELEASE-STOP-LOCKED)'
      if (!/ASK-RELEASE-FOREIGN-STOP/.test(body.text)) return 'a brake that changed hands mid-question is not recorded (ASK-RELEASE-FOREIGN-STOP)'
      if (!/ASK-RELEASE/.test(body.text)) return 'the release is not recorded at all — ENGAGE-ASK would have no matching line'
      const rel = body.text.indexOf('if (!DeleteStopFile())')
      const unl = body.text.indexOf('_engaged = false;')
      if (rel >= 0 && unl >= 0 && rel > unl) return 'the state is unwound BEFORE the release is verified'
      return null
    },
    brks: [
      { scope: SIG.endAsk, end: CS_END, find: /if \(!DeleteStopFile\(\)\)/, with: 'if (false)' },
      { scope: SIG.endAsk, end: CS_END, find: /ResetMonitorRun\(\);/, with: '' },
      { scope: SIG.endAsk, end: CS_END, find: /_engaged = false;/, with: '' },
      { scope: SIG.endAsk, end: CS_END, find: /ResetMonitorRun\(\);/, with: 'ResetMonitorRun();\n            Notify("resume", "");' },
    ],
  },
  {
    // merge-design.md §4, item 1-2 and §6 G5 (static half): the sweep must sit BEFORE the adoption
    // branch, on the UNTRUNCATED text, or a >200-char question loses its `askPid=` line and a dead
    // asker's brake is adopted for ever.
    name: 'SyncFromFile sweeps an orphaned ask brake BEFORE it adopts anything',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, 'public static void SyncFromFile()', CS_END)
      if (!body) return 'SyncFromFile() not found'
      const sweep = body.text.indexOf('TrySweepOrphanAskStop(why)')
      const adopt = body.text.indexOf('if (!_engaged)')
      if (sweep < 0) return 'SyncFromFile no longer sweeps an orphaned ask brake — the measured leak (ENGAGE-ASK → ENGAGE-ADOPTED with no release) comes straight back'
      if (adopt < 0) return 'SyncFromFile no longer has its adoption branch'
      if (sweep > adopt) return 'the orphan sweep sits AFTER the adoption branch — dead code: the brake would already have been adopted'
      const truncate = body.text.indexOf('why.Length > 240')
      if (truncate >= 0 && truncate < sweep) return 'the 240-char truncation runs BEFORE the sweep, so a long question loses its askPid= line and the orphan is adopted'
      if (!/if \(TrySweepOrphanAskStop\(why\)\) return;/.test(body.text)) return 'the sweep no longer returns early — the dead asker\'s brake would still be adopted on this same pass'
      return null
    },
    brks: [
      { scope: 'public static void SyncFromFile()', end: CS_END, find: /if \(TrySweepOrphanAskStop\(why\)\) return;/, with: '/* sweep removed */' },
    ],
  },
  {
    // BOTH SIDES, AND THE RIGHT PHYSICAL KEY (bug found by the Codex review, 2026-09-13): the plan loop
    // returned after the FIRST side that reported down, so with both left and right Shift held only
    // `UP:0xA0` was planned — measured as a PRODUCTION PLAN (deployed build, down=[160,161] → [UP:0xA0]);
    // no OS-level residue was measured, and none is claimed. The generic VK is a fallback for a state
    // that names no side. The extended (E0-prefixed) set is right Ctrl/Alt plus BOTH Windows keys —
    // left Win included, per the Keyboard Input Overview's extended-key flag section — while right
    // SHIFT (0xA1) is not an extended key.
    name: 'the stuck-release plan covers BOTH sides of a modifier and names the extended keys',
    file: 'worker',
    fn: (s) => {
      const b = sliceRange(s, 'static void AddModifier(', CS_END)
      if (!b) return 'AddModifier() not found'
      if (/plan\.Add\("UP:0x" \+ vk\.ToString\("X2"\)\); return;/.test(b.text)) return 'AddModifier() still returns after the FIRST side that is down — the other side is dropped'
      if (!/bool any = false;/.test(b.text)) return 'AddModifier() has no "did any specific side report down" flag'
      if (!/if \(!any && generic != 0 && down\(generic\)\)/.test(b.text)) return 'the generic VK is not a fallback-only release (it would double-release a named side)'
      if (!/static bool IsExtendedVk\(ushort vk\) \{ return vk == 0x5B \|\| vk == 0x5C \|\| vk == 0xA3 \|\| vk == 0xA5; \}/.test(s)) return 'IsExtendedVk() must be both Windows keys (0x5B/0x5C) plus right Ctrl/Alt (0xA3/0xA5) — right Shift is not an extended key'
      if (!/KEYEVENTF_KEYUP \| \(IsExtendedVk\(vk\) \? Native\.KEYEVENTF_EXTENDEDKEY : 0\)/.test(s)) return 'the synthesised release does not carry KEYEVENTF_EXTENDEDKEY for the extended keys'
      return null
    },
    brks: [
      { scope: 'static void AddModifier(', end: CS_END, find: /if \(down\(vk\)\) \{ plan\.Add\("UP:0x" \+ vk\.ToString\("X2"\)\); any = true; \}/, with: 'if (down(vk)) { plan.Add("UP:0x" + vk.ToString("X2")); return; }' },
      { scope: 'static void AddModifier(', end: CS_END, find: /if \(!any && generic != 0 && down\(generic\)\)/, with: 'if (generic != 0 && down(generic))' },
      { find: /return vk == 0x5B \|\| vk == 0x5C \|\| vk == 0xA3 \|\| vk == 0xA5;/, with: 'return vk == 0x5C || vk == 0xA3 || vk == 0xA5;' },
      { find: /return vk == 0x5B \|\| vk == 0x5C \|\| vk == 0xA3 \|\| vk == 0xA5;/, with: 'return vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5 || vk == 0xA1;' },
      { find: /KEYEVENTF_KEYUP \| \(IsExtendedVk\(vk\) \? Native\.KEYEVENTF_EXTENDEDKEY : 0\)/, with: 'KEYEVENTF_KEYUP' },
    ],
  },
  {
    name: 'the STOP release is verified, and Clear() only unwinds the brake it really released',
    file: 'worker',
    fn: (s) => {
      const d = sliceRange(s, 'static bool DeleteStopFile()', CS_END)
      if (!d) return 'DeleteStopFile() is not the boolean, verified form'
      if (!/if \(File\.Exists\(StopPath\)\) \{ LastStopError = "the STOP file is still present after a delete"; return false; \}/.test(d.text)) return 'the delete is not VERIFIED after it returns'
      if (!/catch \(Exception ex\) \{ LastStopError = ex\.Message; return false; \}/.test(d.text)) return 'a delete failure is swallowed again — the caller would unwind a brake that is still on disk'
      if (/_engaged|_stopped/.test(d.text)) return 'DeleteStopFile() touches the in-memory brake state — the caller must own that decision'
      const c = sliceRange(s, 'public static void Clear()', CS_END)
      if (!c) return 'Clear() not found'
      if (!/if \(!DeleteStopFile\(\)\)/.test(c.text)) return 'Clear() does not gate the release on a verified delete'
      if (!/CLEAR-FAILED/.test(c.text)) return 'a failed Ctrl+Alt+R release is not recorded (CLEAR-FAILED)'
      const rel = c.text.indexOf('if (!DeleteStopFile())')
      const unl = c.text.indexOf('_engaged = false;')
      if (rel >= 0 && unl >= 0 && rel > unl) return 'Clear() unwinds the brake BEFORE the release is verified'
      // exit priority must survive a failed release
      const t = sliceRange(s, TEARDOWN_SIG, CS_END)
      if (!t) return 'ApplyExitTeardown() not found'
      if (!/if \(!DeleteStopFile\(\)\)[\s\S]{0,200}?EXIT-STOP-RELEASE-FAILED/.test(t.text)) return 'teardown no longer reports a failed release (and checks whether the release happened)'
      return null
    },
    brks: [
      { scope: 'public static void Clear()', end: CS_END, find: /if \(!DeleteStopFile\(\)\)/, with: 'if (false)' },
      { scope: 'static bool DeleteStopFile()', end: CS_END, find: /the STOP file is still present after a delete/, with: 'gone' },
      { scope: TEARDOWN_SIG, end: CS_END, find: /if \(!DeleteStopFile\(\)\)/, with: 'if (false)' },
    ],
  },

  // ------------------------------------------------------------------ the JS layer
  {
    name: 'core signs every call with __cycle, stamped AFTER ...args (an op cannot forge it)',
    file: 'core',
    fn: (s) => {
      if (!/const signed = \{ \.\.\.args, __cycle: true \}/.test(s)) return 'the __cycle signature is gone, or no longer stamped AFTER ...args (an op could forge it)'
      if (!/args: signed/.test(s)) return 'the signed args are not what gets written to the worker'
      return null
    },
    brks: [[/const signed = \{ \.\.\.args, __cycle: true \}/, 'const signed = { __cycle: true, ...args }']],
  },
  {
    name: "core's resume() clears its own exited/stopped view (it must not drift from the worker)",
    file: 'core',
    fn: (s) => {
      const body = sliceRange(s, SIG.coreResume, JS_END)
      if (!body) return 'resume() not found in the core'
      if (!/this\.call\('resume'/.test(body.text)) return 'resume() no longer asks the worker to open a cycle'
      if (!/this\.exited = false/.test(body.text)) return 'resume() leaves this.exited true — the core would keep believing the session is over'
      if (!/this\.stopped = false/.test(body.text)) return 'resume() leaves this.stopped true'
      return null
    },
    brks: [{ scope: SIG.coreResume, end: JS_END, find: /this\.exited = false\n/, with: '' }],
  },
  {
    name: "REGRESSION: cu.on('exit') must never resurrect the cycle (no cu.resume(), no selfResume)",
    file: 'plugin',
    fn: (s) => {
      const h = sliceRange(s, SIG.pluginExitHandler, HANDLER_END)
      if (!h) return "the cu.on('exit') handler is gone — Ctrl+Alt+Q would no longer cancel the turn"
      if (/cu\.resume/.test(h.text)) return 'cu.on(\'exit\') calls cu.resume() — the plugin resurrects the very cycle Ctrl+Alt+Q just killed'
      if (/selfResume/.test(h.text)) return 'the deleted selfResume flag is back inside cu.on(\'exit\')'
      return null
    },
    brks: [
      {
        scope: SIG.pluginExitHandler,
        end: HANDLER_END,
        find: /selfAbortUntil = Date\.now\(\) \+ 8000/,
        with: 'selfAbortUntil = Date.now() + 8000\n    cu.resume().catch(() => {})',
      },
      {
        scope: SIG.pluginExitHandler,
        end: HANDLER_END,
        find: /selfAbortUntil = Date\.now\(\) \+ 8000/,
        with: 'selfAbortUntil = Date.now() + 8000\n    if (selfResume) cu.calm().catch(() => {})',
      },
    ],
  },
  {
    // ONE OPENER, AND IT IS THE CALL THAT REACHES THE WORKER (2026-09-13, A/B from the Codex review).
    // The turn/start `resume` is GONE on purpose: a turn boundary is a host-wide event that says
    // nothing about who is about to touch this machine, so opening from there was a resurrection path
    // with no call behind it. What must stay true: exactly ONE `cu.resume(` call site in the whole
    // plugin, it lives in ensureCycle, and ensureCycle delegates identity/ownership/once-per-turn to
    // lib/cycle.js instead of a module-wide boolean.
    name: 'the ONLY cycle opener is the once-per-turn ensureCycle path, and the turn boundary opens nothing',
    file: 'plugin',
    fn: (s) => {
      const calls = [...s.matchAll(/cu\.resume\s*\(/g)].map((m) => m.index)
      if (calls.length !== 1) return `the plugin calls cu.resume() ${calls.length} time(s) — expected exactly 1 (ensureCycle, on the call path)`
      const ens = /const ensureCycle = async \(exec\) => \{([\s\S]*?)\n  \}\n/.exec(s)
      if (!ens) return 'ensureCycle(exec) is gone — a new session could never open a cycle after an exit'
      const ensStart = s.indexOf(ens[0])
      if (calls[0] < ensStart || calls[0] > ensStart + ens[0].length) {
        return 'the only cu.resume() is OUTSIDE ensureCycle — the opener must be the call that reaches the worker'
      }
      const g = RAW.cycle
      if (!g) return 'lib/cycle.js is not in this guard\'s file set — the cycle gate would go unchecked'
      if (!/if \(e\.promise\) return e\.promise/.test(g)) return 'lib/cycle.js lost the shared once-per-turn qualification — concurrent calls could each try to open'
      if (!/export function createCycleGate/.test(g)) return 'lib/cycle.js lost the cycle gate — identity and ownership would be back in a module-wide boolean'
      if (!/gate\.open\(cl,/.test(ens[1])) return 'ensureCycle no longer claims the cycle through the gate'
      if (!/!cu\.exited && !exitedLatch\(\)/.test(ens[1])) return 'ensureCycle no longer consults the record — it would spawn a worker on every turn'
      if (!/cu\.stopped \|\| brakeLatch\(\)/.test(ens[1])) return "ensureCycle lost its brake refusal — it could clear a human's brake"
      return null
    },
    brks: [
      // a SECOND call site anywhere breaks "exactly one opener"
      { find: /if \(st !== 'idle' \|\| inFlight !== 0\) return/,
        with: "if (st !== 'idle' || inFlight !== 0) return\n      cu.resume().catch(() => {})" },
      // comment the call-path opener out: the token stays in the FILE, but it is not a call
      { find: /await cu\.resume\(expect\)/, with: '/* ensureCycle sends nothing */' },
      // ensureCycle loses its brake refusal
      { find: /cu\.stopped \|\| brakeLatch\(\)/, with: 'false' },
      // a FRESH qualification key on every call: two calls in a turn, two openers
      { find: /gate\.open\(cl,/, with: 'gate.open({ ...cl, turn: Date.now() },' },
    ],
  },
  {
    name: 'turn/start RENEWS one session\'s qualification and opens NOTHING; turn/end never opens',
    file: 'plugin',
    fn: (s) => {
      if (!/event\.type === 'turn\/start'/.test(s)) return "the turn/start branch is gone — a session's turn could never renew its qualification"
      if (!/if \(session\) gate\.noteTurnStart\(session\)/.test(s)) {
        return 'turn/start no longer renews THIS session\'s qualification — a new session (or a later turn) could never open a cycle'
      }
      const openers = [...s.matchAll(/cu\.resume\s*\(/g)].length
      if (openers !== 1) return `the plugin calls cu.resume() ${openers} time(s) — the turn boundary must not open anything`
      if (!/event\.type !== 'turn\/end'/.test(s)) return 'the turn/end branch is gone — an aborted turn would no longer brake the machine'
      return null
    },
    brks: [
      { find: /if \(event\.type === 'turn\/start'\) \{/, with: "if (event.type === 'turn/end') {" },
      // the renewal removed: a session whose first call already consumed its turn could never reopen
      { find: /if \(session\) gate\.noteTurnStart\(session\)/, with: '/* renewal removed */' },
      // the boundary opens the cycle again
      { find: /if \(session\) gate\.noteTurnStart\(session\)/, with: 'if (session) { gate.noteTurnStart(session); cu.resume().catch(() => {}) }' },
    ],
  },
  {
    name: "Ctrl+Alt+Q ends the SESSION: the plugin cancels the turn and keeps the farewell",
    file: 'plugin',
    fn: (s) => {
      const h = sliceRange(s, SIG.pluginExitHandler, HANDLER_END)
      if (!h) return "the cu.on('exit') handler is gone"
      if (!/typeof agent\.cancel === 'function'/.test(h.text)) return 'the exit handler no longer cancels the turn — the model would keep working after Ctrl+Alt+Q'
      if (!/keepInbox: true/.test(h.text)) return 'the farewell notice is no longer kept across the abort'
      return null
    },
    brks: [{ scope: SIG.pluginExitHandler, end: HANDLER_END, find: /typeof agent\.cancel === 'function'/, with: 'false' }],
  },

  // ------------------------------------------------------------------ the TYPE layer
  // A dead cycle must not be reachable from the tool surface either. The plugin's turn boundary is
  // the ONE opener (lib/index.js session/event turn/start); the tool layer must not be able to
  // un-latch Ctrl+Alt+Q, and no description may promise that it can.
  {
    name: 'no module in lib/ can re-open a cycle: cu.resume() is called ONLY from lib/index.js turn/start',
    file: 'plugin',
    multi: true,
    fn: (code) => {
      const offenders = LIB_KEYS
        .filter(([key, rel]) => path.basename(rel) !== 'index.js' && /cu\.resume\s*\(/.test(code[key]))
        .map(([, rel]) => rel)
      if (offenders.length) return `cu.resume() is called from ${offenders.join(', ')} — a TOOL CALL could re-open a cycle the human ended; only the plugin's turn/start may`
      if (!/cu\.resume\s*\(/.test(code.plugin)) return 'lib/index.js no longer calls cu.resume(): a dead cycle could never come back at the next turn'
      return null
    },
    brks: [
      // the exact regression: a tool that can open a cycle again
      { file: 'tools', find: /case 'calibrate': return cu\.calibrate\(\{\}\)/,
        with: "case 'calibrate': return cu.calibrate({})\n        case 'resume': return cu.resume()" },
    ],
  },
  {
    name: 'computer_ctrl has no resume/cycle opener; manual pause release remains the human R chord',
    file: 'tools',
    fn: (s) => {
      const block = sliceRange(s, "name: 'computer_ctrl'", '\n  })')
      if (!block) return 'the computer_ctrl registration is gone'
      const desc = /description:\s*'([^']*)'/.exec(block.text)
      if (!desc) return 'computer_ctrl has no description'
      const d = desc[1]
      if (/resume|re-arm|rearm|re arm/i.test(d)) return `the description still offers an action that does not exist ("${(d.match(/[^|]*(?:resume|re-arm|rearm)[^|]*/i) || [''])[0].trim().slice(0, 70)}") — no tool call can re-arm or release a pause`
      if (!/Ctrl\+Alt\+R/.test(d)) return 'the description no longer tells the model that the HUMAN releases the brake (Ctrl+Alt+R)'
      if (!/stop/i.test(d)) return 'the description no longer documents the stop action'
      if (!/exit/i.test(d)) return 'the description no longer documents the exit action'
      const act = /action: P\('string',\s*'([^']*)'/.exec(block.text)
      if (!act) return 'computer_ctrl no longer declares its action parameter'
      if (act[1].split('|').map((x) => x.trim()).includes('resume')) return `the action enum still advertises resume: ${act[1]}`
      return null
    },
    brks: [
      { find: /"stop" = raise the emergency brake/,
        with: '"resume" = re-arm after a stop (ask the human first) | "stop" = raise the emergency brake' },
      { find: /selftest \| calibrate \| stop \| exit \| indicator/,
        with: 'selftest | calibrate | stop | resume | exit | indicator' },
    ],
  },
  {
    name: 'every action computer_ctrl advertises is WIRED in BOTH dispatch paths (tool + computer_batch)',
    file: 'tools',
    fn: (s) => {
      const block = sliceRange(s, "name: 'computer_ctrl'", '\n  })')
      if (!block) return 'the computer_ctrl registration is gone'
      const act = /action: P\('string',\s*'([^']*)'/.exec(block.text)
      if (!act) return 'computer_ctrl no longer declares its action parameter'
      // selftest is the documented `default:` of both switches, the rest must be explicit cases.
      const actions = act[1].split('|').map((x) => x.trim()).filter((x) => x && x !== 'selftest')
      const toolSwitch = sliceRange(block.text, 'async execute (args, exec)', 'default:')
      if (!toolSwitch) return "computer_ctrl's execute() no longer ends its switch with a `default:` (selftest) branch"
      const table = sliceRange(s, 'const HANDLERS = {', '\n    },\n  }')
      const tableSwitch = table ? sliceRange(table.text, 'computer_ctrl: (a, exec) =>', 'default:') : null
      if (!tableSwitch) return 'the computer_batch handler for computer_ctrl is gone'
      for (const a of actions) {
        if (!toolSwitch.text.includes(`case '${a}':`)) return `computer_ctrl advertises "${a}" but execute() has no case for it — the call would fall through to selftest and silently do something else`
        if (!tableSwitch.text.includes(`case '${a}':`)) return `computer_ctrl advertises "${a}" but the computer_batch handler has no case for it`
      }
      return null
    },
    brks: [
      { scope: "name: 'computer_ctrl'", end: '\n  })', find: /case 'exit': return cu\.exit\(args\.why\)\n/, with: '' },
    ],
  },
]

// ---- run the invariants against the real source ----------------------------------------------
// `code` is the whole map { fileKey -> comment-stripped text }. A `multi` check gets the map (it
// reasons across files); every other check gets its own file's text.
const runCheck = (check, code) => {
  if (check.fn) return (check.multi ? check.fn(code) : check.fn(code[check.file])) || null
  if (!check.re) return `${check.name} — the check has neither re nor fn (test bug)`
  return check.re.test(code[check.file]) ? null : `${check.name} — pattern not found`
}

const failures = []
for (const check of CHECKS) {
  const bad = runCheck(check, CODE)
  if (bad) failures.push(`${FILES[check.file]}: ${bad}`)
}

// ---- the harness itself ----------------------------------------------------------------------
// The stripper must not move a single line: every "line NNN" in a failure message has to be true.
for (const [key, rel] of Object.entries(FILES)) {
  const before = RAW[key].split('\n').length
  const after = CODE[key].split('\n').length
  if (before !== after) failures.push(`self-test BUG: the comment stripper changed the line count of ${rel} (${before} -> ${after})`)
}
// The stripper must actually strip, or a comment could satisfy an invariant again.
for (const [key, rel] of Object.entries(FILES)) {
  if (CODE[key].length >= RAW[key].length) failures.push(`self-test BUG: the comment stripper removed nothing from ${rel}`)
}
// Method anchors must point at CODE, not at a comment that quotes a signature.
for (const [key, sig, tail] of [
  ['worker', SIG.engage, '\n        {'], ['worker', SIG.engageAsk, '\n        {'],
  ['worker', SIG.agentCalling, '\n        {'], ['worker', SIG.checkOp, '\n        {'],
  ['worker', SIG.exit, '\n        {'], ['worker', SIG.endAsk, '\n        {'],
  ['worker', SIG.beginAskOp, '\n        {'], ['core', SIG.coreResume, ' {'],
]) {
  const i = RAW[key].indexOf(sig)
  if (i < 0 || !RAW[key].startsWith(tail, i + sig.length)) {
    failures.push(`self-test BUG: the ${FILES[key]} anchor "${sig}" does not point at a method body`)
  }
}

// ---- self-test: every check must be able to fire ---------------------------------------------
const replaceAll = (text, find, withWhat) => {
  if (typeof find === 'string') return text.split(find).join(withWhat)
  const g = new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g')
  g.lastIndex = 0
  return text.replace(g, withWhat)
}

/** A mutation is either [find, with] (whole file) or { scope, end, find, with } (one method). */
const normalize = (brk) => Array.isArray(brk) ? { find: brk[0], with: brk[1] } : brk

const applyMutation = (raw, brkspec) => {
  const brk = normalize(brkspec)
  const scoped = brk.scope ? sliceRange(raw, brk.scope, brk.end) : null
  if (brk.scope && !scoped) return null
  const target = scoped ? scoped.text : raw
  const mutated = replaceAll(target, brk.find, brk.with)
  if (mutated === target) return null
  return scoped ? raw.slice(0, scoped.start) + mutated + raw.slice(scoped.end) : mutated
}

let caught = 0
let mutations = 0
for (const check of CHECKS) {
  if (!check.brks || check.brks.length === 0) {
    failures.push(`self-test BUG: "${check.name}" has no mutation — an invariant nobody can break is not tested`)
    continue
  }
  for (const brk of check.brks) {
    mutations++
    // A mutation may target another file (brk.file) — the "only lib/index.js may open a cycle" check
    // has to break a module OUTSIDE its own file to prove it fires.
    const target = normalize(brk).file || check.file
    const mutant = applyMutation(RAW[target], brk)
    if (mutant === null) {
      failures.push(`self-test BUG: the mutation for "${check.name}" did not apply to ${FILES[target]} (anchor absent) — fix the test, not the guard`)
      continue
    }
    if (mutant === RAW[target]) {
      failures.push(`self-test BUG: the mutation for "${check.name}" changed NOTHING in ${FILES[target]} — a no-op mutation proves nothing, and must never count as a pass`)
      continue
    }
    // Attribution: THIS check must fire, not merely "some check somewhere".
    const mutantCode = { ...CODE, [target]: stripComments(mutant) }
    if (runCheck(check, mutantCode) === null) {
      failures.push(`${FILES[check.file]}: self-test FAILED — the guard accepted the source with "${check.name}" broken; it cannot fire for this invariant`)
    } else {
      caught++
    }
  }
}
if (caught !== mutations) failures.push(`self-test: only ${caught}/${mutations} mutations were caught`)

if (failures.length) {
  console.error('FAIL test-monitor-lifetime')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`ok test-monitor-lifetime — ${CHECKS.length} cycle-lifetime invariants hold across ${Object.keys(FILES).length} files (${caught}/${mutations} mutations caught by the self-test)`)
console.log(`   sources: ${Object.entries(FILES).map(([k, rel]) => `${path.basename(rel)}@${sha(RAW[k])}`).join(' ')}`)
