// build/test-ask-invariants.mjs
//
// Guards the three features that were added on 2026-09-12 and that nothing else covers:
//
//   A. computer_ask — the ONE red border the human did not raise. It must stay unmistakable:
//      red like a stop but breathing at EXACTLY TWICE the cyan rate, time-boxed, and it must NOT
//      announce itself as a "panic" (that event tells the agent to wrap up, and the agent is the
//      one asking).
//   B. the host-guard exemption inside it — focus-only. The guard exists so the agent never drives
//      its own host by accident; the ask needs to raise the host and put the caret in the composer,
//      and NOTHING more. The moment that exemption grows a click or a keystroke, this fails.
//   C. the mouse WHEEL as a takeover trigger, with all of its gates (not our own input, only while
//      the agent is driving).
//
// Every invariant is self-tested against a mutated copy and the guard FAILS if the mutation is not
// caught — a guard that cannot fire is worse than no guard.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const SRC = {
  worker: read('lib/core/worker.cs'),
  core: read('lib/core/index.js'),
  tools: read('lib/tools.js'),
  plugin: read('lib/index.js'),
}

/**
 * Remove comments, PRESERVING newlines so line numbers and `[\s\S]{0,n}` windows stay meaningful.
 * String / char / verbatim literals are copied through untouched, so a "//" inside a URL is not
 * read as a comment. Invariants run on this stripped text (see the 2026-09-13 R1 self-test miss in
 * test-monitor-lifetime.mjs): a guard that matches raw text can be satisfied by a COMMENT that
 * merely quotes the code, and its self-test then mutates the code without the guard noticing.
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

const CODE = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, stripComments(v)]))

// Every check is { name, file, re | fn, brk:[pattern, replacement] }.
// `brk` MUST make the check fail; the self-test asserts that.
const CHECKS = [
  // ---------------------------------------------------------------- A. computer_ask
  {
    // ONE derivation for every visual state, and an EXIT outranks all of them (F2, 2026-09-13): the
    // light is no longer computed inline in the render loop, because that made "an exit clears the
    // flags" and "the loop paints red from the flags" a check-then-paint race — the ask window's own
    // ending could set _stoppedMode again a moment after the teardown had cleared it.
    name: 'ask is its own visual state (want=5 above stopped=4) and an EXIT outranks both',
    file: 'worker',
    re: /if \(Panic\.Exited\) return 0;\s*\n\s*return _askMode \? 5 : \(_stoppedMode \? 4 : \(flashOn \? 2 : committed\)\);/,
    brk: [/if \(Panic\.Exited\) return 0;\s*\n\s*return _askMode \? 5 : \(_stoppedMode \? 4 : \(flashOn \? 2 : committed\)\);/,
      'if (Panic.Exited) return 0;\n            return _stoppedMode ? 4 : (flashOn ? 2 : committed);'],
  },
  {
    name: 'the render loop DERIVES the light from that one function (no inline second opinion)',
    file: 'worker',
    re: /int want = DeriveWant\(flashOn, committed\);/,
    brk: [/int want = DeriveWant\(flashOn, committed\);/,
      'int want = _askMode ? 5 : (_stoppedMode ? 4 : (flashOn ? 2 : committed));'],
  },
  {
    name: 'ask renders on the RED bitmap (same as stopped)',
    file: 'worker',
    re: /\(want == 4 \|\| want == 5 \? 4 : 1\)/,
    brk: [/\(want == 4 \|\| want == 5 \? 4 : 1\)/, '(want == 4 ? 4 : 1)'],
  },
  {
    name: 'ask breathing period is EXACTLY half the cyan period',
    file: 'worker',
    fn: (s) => {
      const cyan = /double phase = \(Environment\.TickCount % (\d+)\)/.exec(s)
      const ask = /double askPhase = \(Environment\.TickCount % (\d+)\)/.exec(s)
      if (!cyan) return 'cyan breathing phase not found'
      if (!ask) return 'ask breathing phase not found'
      const c = Number(cyan[1]), a = Number(ask[1])
      if (a * 2 !== c) return `ask breathes every ${a} ms but cyan every ${c} ms — the human's spec is 2x the cyan rate`
      return null
    },
    brk: [/double askPhase = \(Environment\.TickCount % 1250\)/, 'double askPhase = (Environment.TickCount % 2500)'],
  },
  {
    name: 'ask does NOT announce itself as a panic, and its STOP record names its asker',
    file: 'worker',
    fn: (s) => {
      const m = /public static void EngageAsk\(string why\)[\s\S]*?\n        \}/.exec(s)
      if (!m) return 'EngageAsk not found'
      if (!/Notify\("ask", why\)/.test(m[0])) return 'EngageAsk does not notify the "ask" event'
      if (/Notify\("panic"/.test(m[0])) return 'EngageAsk emits panic — that orders the AGENT to wrap up, and the agent is the one asking'
      // The record must still PERSIST the stop, and since 2026-09-14 it must also NAME ITS ASKER
      // (merge-design.md §4 item 3): `source=agent-ask` + `askPid=` is what lets the next worker
      // process sweep an orphan instead of adopting a dead asker's brake for ever.
      if (!/WriteStopFile\(why \+ "\\nsource=agent-ask\\naskPid="/.test(m[0])) {
        return 'EngageAsk no longer writes the ask-marked STOP record (source=agent-ask + askPid=) — a leaked ask brake becomes indistinguishable from a live one and can only be cleared by hand'
      }
      return null
    },
    brk: [/Notify\("ask", why\);/, 'Notify("panic", why);'],
  },
  {
    // F2 / merge-design.md §5.1 item 4: ONE ending for the question, and the pause decision travels
    // IN FROM THE CALLER. `keepPause` is the human's own choice on the card (①让你停 vs ②放你走), so
    // deriving it from `via` — which is what the pre-merge `via == "answered"` rule did — would take
    // the decision away from them. The exit still outranks both.
    name: 'EndAsk is the ONE ending: id-checked, exit-checked, and the pause follows keepPause',
    file: 'worker',
    fn: (s) => {
      const m = /public static void EndAsk\(int id, bool keepPause, string via\)[\s\S]*?\n        \}/.exec(s)
      if (!m) return 'EndAsk(int id, bool keepPause, string via) not found — the one ending of a question is gone'
      const body = m[0]
      // THE ID CHECK IS STILL THE THING PINS — but it is no longer a bare one-liner, and that is the
      // point (independent audit finding, 2026-09-15): a refusal-by-return was SILENT, so `endAsk`
      // answering "no release" left nothing in the audit to say which of the three refusals fired, and
      // the core's one retry never ran because a return is not a rejection. The check must still exist;
      // it must now also name itself.
      // THE REFUSAL MUST STILL RETURN — a check with no `return` is not a refusal, it is a comment.
      // (Second audit, 2026-09-15: the retarget replaced `if (id != _askId) return;` with a test for the
      // bare comparison plus the audit token, and thereby DROPPED the `return;`. Deleting that `return;`
      // left this guard GREEN while the stale-id path fell through and released the brake anyway —
      // measured by the auditor. The two assertions below are deliberately separate: the comparison
      // alone does not refuse, and the audit line alone does not refuse either.)
      if (!/if \(id != _askId\)/.test(body)) return 'EndAsk does not check it is the ask that owns the brake'
      // The `return;` is anchored to the STALE-ID audit line rather than to a character window: a
      // fixed-length window is a paraphrase of "nearby", and it breaks the day someone reflows the
      // message — which would make this guard fail for a reason that has nothing to do with refusing.
      // (Note the check spans a line break in the real source — `if (id != _askId)` then the audit then
      // `return;` — so the pattern must be whitespace-tolerant, which is why it is not a literal.)
      if (!/if \(id != _askId\)[\s\S]{0,600}?ASK-RELEASE-STALE-ID[\s\S]{0,300}?return;/.test(body)) {
        return 'EndAsk refuses a stale id but never RETURNS — the comparison and the audit line are decoration, and a stale id would fall through and release the brake anyway'
      }
      if (!/ASK-RELEASE-STALE-ID/.test(body)) return 'EndAsk refuses a stale id SILENTLY — a refusal that leaves no audit record cannot be told apart from a release that did nothing'
      if (!/SyncExitedFromFile\(\);/.test(body)) return 'EndAsk never re-reads the exit record'
      if (!/if \(_exited\) return;/.test(body)) return 'EndAsk touches the machine of an exited session'
      if (!/if \(keepPause\)/.test(body)) return 'EndAsk does not honour the caller\'s keepPause — the human\'s own choice would be ignored'
      if (!/Glow\.Stopped\(true\)/.test(body)) return 'EndAsk does not settle into the ordinary stop when the pause is kept'
      if (/via == "answered"/.test(body)) return 'EndAsk derives the pause from `via` — `via` is an audit label and the pause belongs to the human\'s chosen option'
      return null
    },
    // The mutation must strike the DECISION itself, not a token that merely co-occurs with it:
    // swapping the EndAskOp local's SOURCE (`bool keepPause = GetB(...)`) leaves the worker's own
    // `if (keepPause)` branch intact, so it stays GREEN (measured). Making the branch read `via` —
    // the exact pre-D3 rule — is what trips the guard.
    brk: [/if \(keepPause\)/, 'if (via == "answered")'],
    // ...and a SECOND mutation for the OTHER clause this check gained: the stale-id refusal must RETURN.
    // Without this the restored `return;` assertion is green but unfalsified — which is the exact gap
    // the second audit found in the first retarget, one level down. The mutation must REMOVE ONLY the
    // `return;` and keep the statement valid: mangling the call instead leaves the assertion failing on
    // a missing token, so it would report "caught" for the wrong reason and prove nothing about the
    // fall-through this clause exists to forbid (measured — the first attempt did exactly that).
    brks: [[
      /(ASK-RELEASE-STALE-ID[\s\S]{0,600}?\);)\s*\n\s*return;\s+\/\/ a NEWER ask owns the brake now: not ours to end/,
      '$1 /* MUTANT: the refusal does not return, so a stale id falls through and releases */',
    ]],
  },
  {
    name: 'the ask op ENGAGES and RETURNS; the wait and the answer belong to the client UI',
    file: 'worker',
    fn: (s) => {
      const m = /static Dictionary<string, object> BeginAskOp\([\s\S]*?\n        \}/.exec(s)
      if (!m) return 'BeginAskOp not found'
      const body = m[0]
      if (!/Panic\.EngageAsk\(q\);/.test(body)) return 'BeginAskOp does not engage the ask brake'
      if (!/if \(!Panic\.Engaged\)/.test(body)) return 'BeginAskOp does not verify the brake really engaged'
      // THE WHOLE POINT OF THE MERGE: no clock, no loop, no input sampler in the op that raises the
      // brake. `LastInputTick()` here is what made a question a 60 s window the worker judged, and
      // the loop around it is what blocked the op loop (verify4 §3.B).
      if (/Native\.LastInputTick\(\)/.test(body)) return 'BeginAskOp reads the system input clock — there is no window left for it to judge'
      if (/while \(/.test(body)) return 'BeginAskOp contains a wait loop — the worker must never be occupied by the wait (that is the measured head-of-line blocking)'
      if (!/"askId", askId/.test(body)) return 'BeginAskOp does not report the ask id every ending must present'
      if (!/"hostRaised", raised/.test(body)) return 'BeginAskOp does not report the measured raise'
      if (/"timeoutMs"/.test(body)) return 'BeginAskOp still returns a timeoutMs field — the reply that lied to the model (verify4 D7)'
      return null
    },
    // THE SHAPE OF THE REVERTED R2, and the exact head-of-line blocking verify4 §3.B measured: a
    // bounded wait loop inside the op that raises the brake. (It cannot be a `LastInputTick()` swap:
    // the pre-merge text the old guard mutated is gone, so that anchor no longer exists anywhere in
    // this method — a mutation that changes nothing proves nothing.)
    brk: [/Panic\.EngageAsk\(q\);/, 'Panic.EngageAsk(q);\n            int t0 = Environment.TickCount;\n            while (unchecked(Environment.TickCount - t0) < 60000) { Thread.Sleep(40); }'],
  },
  {
    name: 'the ask ops are reachable and the old one-shot ask is gone',
    file: 'worker',
    fn: (s) => {
      if (!/case "beginAsk": return Ok\(BeginAskOp\(a\)\);/.test(s)) return 'the dispatcher has no beginAsk case'
      if (!/case "endAsk": return Ok\(EndAskOp\(a\)\);/.test(s)) return 'the dispatcher has no endAsk case — the release would have no route'
      if (/case "ask":/.test(s)) {
        return 'the old one-shot "ask" op is dispatched again: it holds the worker for the whole wait and can be killed by a caller timeout while still holding the brake'
      }
      return null
    },
    brk: [/case "endAsk": return Ok\(EndAskOp\(a\)\);/, ''],
  },
  {
    name: 'core forwards the ask event and exposes ask() that requires an answerer and releases in a finally',
    file: 'core',
    fn: (s) => {
      if (!/msg\.event === 'ask'/.test(s)) return 'the "ask" event is not forwarded out of the worker layer'
      if (!/async ask \(opts = \{\}\)/.test(s)) return 'ComputerUse has no ask() method'
      if (!/if \(typeof opts\.onAsk !== 'function'\)/.test(s)) {
        return 'ask() does not require an answer channel — a caller could raise a brake that nothing will ever release it'
      }
      if (!/this\.call\('beginAsk'/.test(s)) return 'ask() no longer engages the brake through beginAsk'
      if (/\btry \{[\s\S]*?this\.call\('beginAsk'[\s\S]*?\}\s*finally\s*\{[\s\S]*?this\.call\('endAsk'/.test(s)) { /* correct shape */ } else {
        return 'the endAsk call does not sit in the finally of the try that contains beginAsk — an ending (a throw, an abort, the deadline) could leave the brake up'
      }
      // The core's ask deadline must be its own literal. This is scoped to ask()'s own body: the CORE
      // has other, unrelated `?? 5000` defaults (`waitForIdle`), so a whole-file search would fire on
      // a method this merge never touched.
      const askBody = /async ask \(opts = \{\}\)[\s\S]*?\n  \}/.exec(s)
      if (!askBody) return 'the body of ask() could not be sliced — re-anchor this guard'
      if (/opts\.timeoutMs/.test(askBody[0])) return 'the core ask deadline is derived from the caller again — that coupling is what produced the measured 15 s kill'
      return null
    },
    brk: [/if \(typeof opts\.onAsk !== 'function'\)/, 'if (false)'],
  },
  {
    name: 'the tool exists and is wired to a handler',
    file: 'tools',
    fn: (s) => {
      if (!/name: 'computer_ask'/.test(s)) return 'computer_ask is not registered'
      if (!/computer_ask: \(a, exec\) => askQuestion\(a, exec\)/.test(s)) return 'computer_ask has no dispatch handler (computer_batch would not reach it)'
      if (!/const askQuestion = \(args, exec\) => cu\.ask\(/.test(s)) return 'there is no shared askQuestion orchestration for the tool and the batch'
      return null
    },
    brk: [/computer_ask: \(a, exec\) => askQuestion\(a, exec\)/, 'computer_askX: (a, exec) => askQuestion(a, exec)'],
  },
  {
    name: 'the plugin holds the asking state and hands the question to the CARD, not to a notice',
    file: 'plugin',
    fn: (s) => {
      const m = /cu\.on\('ask', \(\) => \{[\s\S]*?\n  \}\)/.exec(s)
      if (!m) return "cu.on('ask') not found, or it no longer takes the event"
      if (!/gate\.mark\('asking'/.test(m[0])) return "cu.on('ask') no longer marks the cycle asking — the owner would be treated as idle mid-question"
      if (/notice\(/.test(m[0])) {
        return "cu.on('ask') still injects a notice: the card is the answer surface now, and the notice promised a clock that no longer exists (and duplicated the question)"
      }
      return null
    },
    brk: [/gate\.mark\('asking'/, "notice('x'); gate.mark('asking'"],
  },

  // ---------------------------------------------------------------- B. the narrow host exemption
  {
    name: 'the host exemption is FOCUS-ONLY (no clicks, no keystrokes)',
    file: 'worker',
    fn: (s) => {
      const m = /public static bool FocusHostComposer\(IntPtr host\)[\s\S]*?\n        \}/.exec(s)
      if (!m) return 'FocusHostComposer not found'
      const body = m[0]
      const injected = ['SendKey', 'SendMouse', 'MouseInput', 'mouse_event', 'keybd_event'].filter((t) => body.includes(t))
      if (injected.length) return 'the exemption injects input into the host: ' + injected.join(', ')
      if (!/\.SetFocus\(\)/.test(body)) return 'the exemption no longer focuses anything'
      return null
    },
    brk: [/best\.SetFocus\(\);/, 'best.SetFocus(); MouseInput(0x0002);'],
  },
  {
    name: 'the host guard itself is still armed for driving ops',
    file: 'worker',
    fn: (s) => {
      // Counted, not guessed (measured 2026-09-12): HostGuard( is wired into activate, windowOp,
      // uiaAct and the click/key/type path; HostGuardPid( covers the element-based path. The floors
      // are today's numbers, so refactors are fine and DISMANTLING is caught.
      const viaWindow = s.split('HostGuard(').length - 1
      const viaPid = s.split('HostGuardPid(').length - 1
      if (viaWindow < 6) return `HostGuard( is called only ${viaWindow} time(s) — the guard has been dismantled from the driving ops`
      if (viaPid < 2) return `HostGuardPid( is called only ${viaPid} time(s) — the element-based path is unguarded`
      if (!/HOST-GUARDED: /.test(s)) return 'the refusal message is gone'
      return null
    },
    brk: [/HOST-GUARDED: /, 'NOT-GUARDED-XYZ: '],
  },

  // ---------------------------------------------------------------- C. the wheel trigger
  {
    name: 'the wheel is a takeover trigger, gated on our own input AND on the agent driving',
    file: 'worker',
    fn: (s) => {
      const m = /static IntPtr MouseHookCallback\([\s\S]*?\n        \}/.exec(s)
      if (!m) return 'MouseHookCallback not found'
      const body = m[0]
      if (!/WM_MOUSEWHEEL_/.test(body)) return 'the mouse hook does not look for WM_MOUSEWHEEL'
      if (!/m\.dwExtraInfo != OwnMagic/.test(body)) return 'our own synthetic wheel is not excluded — the agent can brake itself'
      // The gate must be the CODE, not a comment ABOUT the gate: "(_armed)" is mentioned in this
      // method's own doc comment, so a bare /_armed/ was satisfied by prose after the real gate was
      // deleted (same defect class as the R1 self-test miss in test-monitor-lifetime).
      if (!/m\.dwExtraInfo != OwnMagic && _armed|_armed && m\.dwExtraInfo != OwnMagic/.test(body)) {
        return 'the wheel brakes even when the agent is not driving (monitor lifetime) — the `dwExtraInfo && _armed` gate is gone'
      }
      if (!/delta/.test(body)) return 'the wheel delta is not carried into the STOP file (no evidence for the next "why?")'
      return null
    },
    brk: [/m\.dwExtraInfo != OwnMagic/, 'm.dwExtraInfo == OwnMagic'],
  },
  {
    name: 'the mouse hook is actually installed',
    file: 'worker',
    re: /_mouseHook = Native\.SetWindowsHookEx\(Native\.WH_MOUSE_LL, _mouseProc, hmod, 0\);/,
    brk: [/Native\.WH_MOUSE_LL, _mouseProc, hmod, 0\)/, 'Native.WH_MOUSE_LL, _mouseProc, hmod, 99)'],
  },

  // ---------------------------------------------------------------- D. no visual flag survives a stop
  {
    name: 'BOTH stop paths clear EVERY visual flag (the stuck red border)',
    file: 'worker',
    // The bug this catches (2026-09-12, "你这个呼吸红框一直在挂着"): Exit() cleared _stoppedMode and
    // called Glow.Kill(), but not _askMode — and the render loop reads `want = _askMode ? 5 : ...`
    // FIRST, so it painted the fast-breathing red border straight back on the frame after Kill().
    // The same cleanup lives in two places (Exit and Clear) and only one had been updated — the
    // SAME shape as the calm/resume exclusion-list bug one day earlier. Hence: check both, always.
    fn: (s) => {
      const paths = [
        ['Exit', /public static void Exit\(string why, string source, string evidence\)[\s\S]*?\n        \}/],
        ['Clear', /public static void Clear\(\)[\s\S]*?\n        \}/],
      ]
      // 2026-09-13: Exit's cleanup moved into the SHARED ApplyExitTeardown() (a detected exit and an
      // ADOPTED one have to look identical — the human watched a cyan border breathe while the
      // process reported "exited"), so the flags are asserted where they now live, and the ROUTE is
      // asserted too: if Exit stops calling the teardown, this check fails even if the flags remain.
      for (const [name, re] of paths) {
        const m = re.exec(s)
        if (!m) return `${name}() not found`
        let body = m[0]
        if (/ApplyExitTeardown\(\)/.test(body)) {
          const t = /static void ApplyExitTeardown\(\)[\s\S]*?\n        \}/.exec(s)
          if (!t) return `${name}() routes through ApplyExitTeardown() but that method was not found`
          body = t[0]
        }
        if (!/Glow\.Stopped\(false\)/.test(body)) return `${name}() does not clear the stopped border`
        if (!/Glow\.Ask\(false\)/.test(body)) return `${name}() does not clear the ASK border — a red box the human can never turn off`
      }
      return null
    },
    brk: [/try \{ Glow\.Ask\(false\); \} catch \{ \}/, '/* no ask reset */'],
  },
  {
    name: 'every breathing border swings the FULL 0..100 and is not eased away',
    file: 'worker',
    // Twice-asked-for spec. The trough must actually reach 0 and the peak 100, AND the breathing
    // frames must bypass the shared ~430 ms ease — a 1250 ms pulse pushed through that smoothing
    // shows up as a border that barely moves, which is what the human saw and rejected.
    fn: (s) => {
      const bands = [...s.matchAll(/target = (\d+) \+ \(int\)\(Math\.Sin\((\w+) \* 2 \* Math\.PI\) \* (\d+)\);/g)]
      if (bands.length < 2) return `found ${bands.length} breathing band(s), expected 2 (thinking + ask)`
      for (const b of bands) {
        const mid = Number(b[1]), amp = Number(b[3])
        if (mid !== 50 || amp !== 50) return `a breathing band is ${mid - amp}..${mid + amp}, not the full 0..100 the human asked for`
      }
      if (!/flashFrame \|\| breathFrame\) alpha = target/.test(s)) {
        return 'breathing still eases towards its target, which damps the very pulse it is meant to show'
      }
      return null
    },
    brk: [/target = 50 \+ \(int\)\(Math\.Sin\(askPhase \* 2 \* Math\.PI\) \* 50\);/,
      'target = 150 + (int)(Math.Sin(askPhase * 2 * Math.PI) * 52);'],
  },

  // ---------------------------------------------------------------- E. the agent's own Ctrl+Alt+Q
  {
    name: 'exit is dispatched AND reachable while stopped (or the ask protocol deadlocks)',
    file: 'worker',
    fn: (s) => {
      if (!/case "exit": return Ok\(ExitOp\(a\)\);/.test(s)) return 'the exit op is not dispatched'
      const co = /public static void CheckOp\(string op\)[\s\S]*?\n        \}/.exec(s)
      if (!co) return 'CheckOp not found'
      if (!/op == "exit"/.test(co[0])) {
        return 'CheckOp refuses exit while stopped — but after an ask the agent IS stopped, and that is exactly when it must be able to answer "I cannot proceed"'
      }
      if (!/Panic\.Exit\("the agent ended the session on its own: "/.test(s)) {
        return 'ExitOp does not go through Panic.Exit — that is the persistence + notify path, and going around it would leave the border or the monitors alive'
      }
      return null
    },
    brk: [/op == "exit"/, 'op == "exitX"'],
  },
  {
    name: 'exit is wired from computer_ctrl down to the worker',
    file: 'tools',
    re: /case 'exit': return cu\.exit\(a\.why\)/,
    brk: [/case 'exit': return cu\.exit\(a\.why\)/, "case 'exitX': return cu.exit(a.why)"],
  },
  {
    name: 'the core exposes exit()',
    file: 'core',
    re: /async exit \(why\) \{\s*\n\s*return this\.call\('exit', \{ why: why \|\| 'could not proceed' \}\)/,
    brk: [/async exit \(why\) \{/, 'async exitX (why) {'],
  },
]

const run = (check, text) => {
  if (check.fn) return check.fn(text)
  return check.re.test(text) ? null : `${check.name} — pattern not found`
}

const failures = []
let caught = 0
let breakers = 0

// The stripper must not move a line or remove nothing, or every "line NNN" above would be a lie.
for (const [k, v] of Object.entries(SRC)) {
  if (CODE[k].split('\n').length !== v.split('\n').length) failures.push(`self-test BUG: the comment stripper changed the line count of ${k}`)
  if (CODE[k].length >= v.length) failures.push(`self-test BUG: the comment stripper removed nothing from ${k}`)
}

for (const c of CHECKS) {
  const bad = run(c, CODE[c.file])
  if (bad) failures.push(`${c.file}: ${bad}`)

  if (!c.brk && !c.brks) { failures.push(`${c.file}: ${c.name} — has no self-test mutation`); continue }
  // ONE MUTATION PER INVARIANT WAS NOT ENOUGH (2026-09-15). A retargeted check can gain a second
  // independent clause — the `return;` in EndAsk's stale-id refusal is that case — and a check with one
  // `brk` covering only the first clause reports "self-tested" while the new clause is never falsified.
  // `brks` is optional and additive: every existing check keeps its single `brk` and behaves identically.
  for (const b of [c.brk, ...(c.brks || [])].filter(Boolean)) tryMutation(c, b)
}

function tryMutation (c, brk) {
  breakers++
  const [re, withWhat] = brk
  // Mutate EVERY occurrence. A single-replace mutation leaves the second copy of the token in
  // place, the check then still passes, and the suite reports success while being blind to the
  // very break it is supposed to catch — found the hard way on 2026-09-12, twice in one file.
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g')
  g.lastIndex = 0
  if (!g.test(SRC[c.file])) { failures.push(`${c.file}: self-test cannot mutate "${c.name}"`); return }
  g.lastIndex = 0
  const mutated = SRC[c.file].replace(g, withWhat)
  // A mutation that changes NOTHING proves nothing: that is a broken test, never a pass.
  if (mutated === SRC[c.file]) { failures.push(`${c.file}: self-test BUG — the mutation for "${c.name}" changed nothing`); return }
  // Match on the comment-stripped mutant: a comment quoting the code must never keep a guard alive.
  const verdict = run(c, stripComments(mutated))
  if (verdict === null) failures.push(`${c.file}: self-test FAILED — the guard accepted "${c.name}" broken; it cannot fire for that invariant`)
  else caught++
}

if (caught !== breakers) failures.push(`self-test: only ${caught}/${breakers} mutations were caught`)

if (failures.length) {
  console.error('FAIL test-ask-invariants')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`ok test-ask-invariants — ${CHECKS.length} invariants hold across 4 files (${caught}/${breakers} mutations caught by the self-test)`)
