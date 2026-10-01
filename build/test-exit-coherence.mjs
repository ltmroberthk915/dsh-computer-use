// build/test-exit-coherence.mjs
//
// AN EXIT HAS TO BE ONE FACT, AND IT HAS TO NAME ITS WITNESS.
//
// Two incidents (2026-09-13) made "exited" a lie in two different ways:
//
//   1. A record written at 01:17:44 was INHERITED wholesale by a session that started at 01:19.
//      Every driving op was refused, and the refusal said "Ctrl+Alt+Q" with no time and no witness
//      — so the agent told the human THEY had pressed the key, about a press that had happened
//      four minutes earlier, in a different session, possibly by nobody at all.
//   2. The record was adopted by flipping ONE flag. The process reported `exited: true` while its
//      own cyan border kept breathing and its human monitors stayed armed — the human watched a
//      dead session advertise itself as live.
//
// So the marker is a RECORD (who / when / on what evidence), a DETECTED exit and an ADOPTED one
// run the SAME teardown, a dead cycle can never be lit, and neither chord detector may decide a
// chord on global key state alone (GetAsyncKeyState cannot say whose Ctrl it is — our own injection
// and AltGr both look human there). Every invariant below is asserted on the source and then
// FALSIFIED by mutating an in-memory copy of it: a guard that cannot fail is decoration.
//
// READ-ONLY, including the real EXITED marker: this file only reads worker.cs and (if it ever can)
// runs the compiled exe against a synthetic record in a TEMP directory. It never writes, moves or
// deletes %LOCALAPPDATA%\dsh-computer-use\EXITED — that file is evidence for an incident that is
// still being investigated.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const NAME = 'test-exit-coherence'
// Both resolved from THIS file's directory: never a drive-absolute path, so the guard keeps
// working when the repo moves (which it has).
const WORKER = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const EXE = path.resolve(import.meta.dirname, '../../_build/dsh-computer-use-worker.exe')
const raw = fs.readFileSync(WORKER, 'utf8')
const sha = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)

// ---------- reading C# without a parser ------------------------------------------------
// Comments are removed (string-literal aware) before every content assertion. Two reasons, both
// learned the hard way in this repo: a sentence that merely DESCRIBES the old bug must not satisfy
// — or trip — a check, and a commented-out `ApplyExitTeardown();` is not a call site.
function deComment (s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '@' && s[i + 1] === '"') {          // verbatim string: "" is an escaped quote
      out += '""'
      i += 2
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { out += '""'; i += 2; continue }
          out += '"'
          i++
          break
        }
        out += s[i]
        i++
      }
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < s.length) {
        const d = s[i]
        out += d
        if (d === '\\') { out += s[i + 1] === undefined ? '' : s[i + 1]; i += 2; continue }
        i++
        if (d === q) break
      }
      continue
    }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && s[i + 1] === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

const code = deComment(raw)

// A method body, brace-matched. Only used on methods that hold no braces inside strings or
// comments; `Main` (which does: "{\"op\":") is checked by ORDER of anchors instead.
function spanOf (s, sig) {
  const i = s.indexOf(sig)
  if (i < 0) return null
  const open = s.indexOf('{', i + sig.length)
  if (open < 0) return null
  let d = 0
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') d++
    else if (s[j] === '}') { d--; if (d === 0) return { sig: i, open, close: j, body: s.slice(open, j + 1) } }
  }
  return null
}
const bodyOf = (s, sig) => { const r = spanOf(s, sig); return r ? r.body : null }

// Replace a method body in place — mutations must land INSIDE the method under test, never on the
// first look-alike elsewhere in a 4600-line file.
function spliceBody (s, sig, fn) {
  const r = spanOf(s, sig)
  if (!r) return null
  const next = fn(r.body)
  if (!next || next === r.body) return null
  return s.slice(0, r.open) + next + s.slice(r.close + 1)
}

// End of the C# statement that starts at `from`, skipping strings and comments.
function stmtEnd (s, from) {
  let inStr = false
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === ';') return i
  }
  return -1
}
const sub = (s, re, to) => { const out = s.replace(re, to); return out === s ? null : out }
// Move a statement out of one method and into another, so a call-site COUNT can stay healthy while
// the method that actually needed the call loses it.
function moveCall (s, fromSig, toSig, call) {
  const a = spliceBody(s, fromSig, (b) => b.replace(call, ''))
  if (!a) return null
  return spliceBody(a, toSig, (b) => '{\n            ' + call + b.slice(1))
}

const SIG = {
  exit: 'public static void Exit(string why, string source, string evidence)',
  sync: 'public static void SyncExitedFromFile()',
  teardown: 'static void ApplyExitTeardown()',
  record: 'static string ExitRecordText(string why)',
  hook: 'static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)',
  poll: 'static void PollThread()',
  agentCalling: 'public static void AgentCalling()',
  // AskSettled/AskExpired were folded into ONE ending (merge-design.md §5.1 item 4): the method this
  // anchor reaches must be the single place a question's brake can be released or kept.
  endAsk: 'public static void EndAsk(int id, bool keepPause, string via)',
  main: 'static int Main(string[] args)'
}

const TEARDOWN_MUST = [
  '_engaged = false', '_stopped = false', 'CycleLit = false', 'Disarm()',
  'Glow.Kill()', 'Glow.Ask(false)', 'Glow.Stopped(false)', 'DeleteStopFile()'
]
const OLD_REFUSAL = 'Ctrl+Alt+Q ended computer use for this session'
const TEARDOWN_CALL = 'ApplyExitTeardown();'
const countTeardownCalls = (s) => (s.match(/ApplyExitTeardown\(\)\s*;/g) || []).length

// ---------- A. the invariants ------------------------------------------------------------
function a1 (s) {
  const e = bodyOf(s, SIG.exit)
  const y = bodyOf(s, SIG.sync)
  if (!e) return 'Exit(string, string, string) was not found — the exit detector has been restructured; re-check by hand'
  if (!y) return 'SyncExitedFromFile() was not found — the adoption path has been restructured; re-check by hand'
  const n = countTeardownCalls(s)
  if (n < 2) return `only ${n} live call site(s) of ApplyExitTeardown() (expected >= 2: Exit + SyncExitedFromFile) — the shared teardown is no longer the one path a dead cycle is killed through`
  if (!/ApplyExitTeardown\(\)\s*;/.test(e)) return 'Exit(...) does not run ApplyExitTeardown() — a DETECTED exit would tear the cycle down differently from an ADOPTED one'
  if (!/ApplyExitTeardown\(\)\s*;/.test(y)) return 'SyncExitedFromFile() does not run ApplyExitTeardown() — adopting the record would flip a flag and leave the cyan border breathing with the monitors armed (the 2026-09-13 report)'
  return null
}
function a2 (s) {
  const b = bodyOf(s, SIG.teardown)
  if (!b) return 'ApplyExitTeardown() was not found — the one teardown of a dead cycle has been restructured; re-check by hand'
  const missing = TEARDOWN_MUST.filter((t) => !b.includes(t))
  if (missing.length) return `ApplyExitTeardown() no longer does: ${missing.join(' + ')} — an adopted exit would leave the cyan border breathing and the human monitors armed`
  return null
}
function a3 (s) {
  if (!/File\.WriteAllText\(\s*ExitMarkerPath\(\)\s*,\s*ExitRecordText\(/.test(s)) {
    return 'the EXITED marker is no longer written through ExitRecordText(...) — the record on disk cannot carry its provenance'
  }
  const b = bodyOf(s, SIG.record)
  if (!b) return 'ExitRecordText(...) was not found — the record builder has been restructured; re-check by hand'
  const missing = ['source=', 'at=', 'evidence='].filter((k) => !b.includes('"' + k + '"'))
  if (missing.length) {
    return `the exit record no longer writes: ${missing.join(' + ')} — provenance on disk is the only thing that makes a stale record checkable by the NEXT session`
  }
  return null
}
function a4 (s) {
  const start = s.indexOf('bool cycleOp =')
  if (start < 0) return 'the cycleOp gate was not found — the cycle-lighting gate has been restructured; re-check by hand'
  const end = stmtEnd(s, start)
  if (end < 0) return 'the cycleOp statement could not be delimited — the cycle-lighting gate has been restructured; re-check by hand'
  const expr = s.slice(start, end)
  if (!/!\s*\(?\s*Panic\.Exited\b/.test(expr)) {
    return 'cycleOp does not test !Panic.Exited — a DEAD cycle could be lit again (the cyan border that kept breathing on a session the human had ended)'
  }
  return null
}
function a5 (s) {
  const h = bodyOf(s, SIG.hook)
  const p = bodyOf(s, SIG.poll)
  if (!h) return 'HookCallback(...) was not found — the hook chord detector has been restructured; re-check by hand'
  if (!p) return 'PollThread() was not found — the poll chord detector has been restructured; re-check by hand'
  if (!/bool\s+ctrl\s*=\s*_humanCtrl\s*&&/.test(h) || !/bool\s+alt\s*=\s*_humanAlt\s*&&/.test(h)) {
    return 'the HOOK chord branch does not derive Ctrl/Alt from the hook-tracked _humanCtrl/_humanAlt — async key state alone cannot say whose Ctrl it is (our own SendInput and AltGr both look human there)'
  }
  if (!/_humanCtrl\s*&&\s*_humanAlt/.test(p)) {
    return 'the POLL chord branch does not require BOTH hook-tracked modifiers (_humanCtrl && _humanAlt) — an async Q bit cannot say whose chord it is'
  }
  // D (2026-09-13): the poll MUST measure the async modifier state, because (a) the record has to
  // carry a real measurement rather than a hard-coded "confirmed", and (b) a stale hook track (a
  // key-up the hook never saw) is what turns a bare Q into a chord nobody pressed. What is still
  // forbidden is deciding on that state ALONE: the tracked flags above must gate it.
  const asyncRead = /GetAsyncKeyState\(Native\.VK_CONTROL\)/.test(p) && /GetAsyncKeyState\(Native\.VK_MENU\)/.test(p)
  if (!asyncRead) return 'PollThread() does not measure the async modifier state — the evidence line would report a confirmation nobody made (D)'
  if (!/asyncCtrl\s*&&\s*asyncAlt|asyncAlt\s*&&\s*asyncCtrl/.test(p)) {
    return 'PollThread() measures the async modifier state but does not REQUIRE it in the chord condition — a stale hook track could still fire a chord'
  }
  const evidence = /ChordEvidence\(kk,\s*asyncCtrl,\s*asyncAlt\)/.test(p)
  if (!evidence) return 'PollThread() does not pass the MEASURED values into ChordEvidence — the record would claim an async confirmation that was hard-coded (D)'
  return null
}
function a6 (s) {
  const p = bodyOf(s, SIG.poll)
  if (!p) return 'PollThread() was not found — the poll chord detector has been restructured; re-check by hand'
  const ci = p.indexOf('Clear()')
  const xi = p.indexOf('Exit(')
  if (ci < 0) return 'PollThread() never calls Clear() — a missed keydown would leave Ctrl+Alt+R with no fallback at all'
  if (xi < 0) return 'PollThread() never calls Exit() — a missed hook keydown would never end the session'
  if (!(ci < xi)) {
    return 'PollThread() evaluates Exit( before Clear(): a stale Q latch could beat the real Ctrl+Alt+R re-arm (the key that brings computer use BACK must never be able to END it)'
  }
  const gate = /if\s*\(\s*warm\s*<\s*(\d+)\s*\)\s*warm\+\+\s*;/.exec(p)
  if (!gate) {
    return 'PollThread() has no warm-up guard (a `warm` counter) — the OS "pressed since last query" bits survive from BEFORE this thread existed, so a fresh process inherits a stale Q as a live chord'
  }
  if (Number(gate[1]) < 1) return `the warm-up guard drains for ${gate[1]} iteration(s) — it drains nothing`
  if (!/bool\s+agentQuiet\s*=\s*[^;]*_agentActAt/.test(p)) {
    return 'PollThread() does not derive agentQuiet from _agentActAt — our own injected Q could be read as the human\'s'
  }
  if (!/else\s+if\s*\([^)]*agentQuiet[^)]*\)/.test(p)) {
    return 'PollThread() does not require agentQuiet before deciding a chord — the fallback may only ever interpret a keydown the hook MISSED, never one we sent'
  }
  return null
}
function refusalOf (s) {
  const start = s.indexOf('"CYCLE-ENDED:')
  if (start < 0) return null
  let end = s.indexOf('Refused:', start)
  if (end < 0) end = start
  const semi = s.indexOf(';', end)
  return s.slice(start, semi < 0 ? s.length : semi + 1)
}
function a7 (s) {
  const msg = refusalOf(s)
  if (!msg) return 'the CYCLE-ENDED refusal message was not found — the text an agent repeats to the human has been restructured; re-check by hand'
  if (msg.includes(OLD_REFUSAL)) {
    return `the CYCLE-ENDED refusal still contains "${OLD_REFUSAL}" — that sentence is what produced "you pressed Ctrl+Alt+Q" in a session that never saw the key`
  }
  if (!msg.includes('_exitAt')) return 'the CYCLE-ENDED refusal does not name the recorded time (_exitAt) — the agent cannot say WHEN it ended, so "just now" is the only reading left'
  if (!msg.includes('RECORD') && !msg.includes('do NOT tell the human')) {
    return 'the CYCLE-ENDED refusal neither says RECORD nor forbids the accusation ("do NOT tell the human") — the agent is free to tell the human they pressed the key'
  }
  return null
}
// B (static leg). Main must ADOPT the record before ANY op is handled, so a one-shot
// `worker.exe --op click` cannot drive a machine the human already ended.
function b1 (s) {
  const main = s.indexOf(SIG.main)
  if (main < 0) return 'Main(string[] args) was not found — re-check by hand'
  const changed = s.indexOf('Panic.Changed', main)
  const sync = s.indexOf('Panic.SyncExitedFromFile();', main)
  let opBranch = s.indexOf('args[0] == "--op"', main)
  if (opBranch < 0) opBranch = s.indexOf('"--op"', main)
  if (changed < 0) return 'the Panic.Changed wiring was not found in Main — re-check by hand'
  if (sync < 0) return 'Main does not adopt the EXITED record before handling an op (no Panic.SyncExitedFromFile()): a fresh one-shot process would drive a machine the human had already ended'
  if (opBranch < 0) return 'the --op one-shot branch was not found in Main — re-check by hand'
  if (!(main < changed && changed < sync)) {
    return 'Main adopts the EXITED record BEFORE the Panic.Changed wiring — an adoption that cannot be announced is a silent lie'
  }
  if (!(sync < opBranch)) {
    return 'Main adopts the EXITED record AFTER the --op one-shot branch — a one-shot worker would run its op before it ever looked at the record'
  }
  return null
}

const CHECKS = [
  {
    id: 'A1',
    name: 'Exit(...) and SyncExitedFromFile() both route through ApplyExitTeardown()',
    run: a1,
    mutations: [
      {
        why: 'comment out the teardown call in SyncExitedFromFile (a commented call must not count as a call site)',
        make: (s) => spliceBody(s, SIG.sync, (b) => b.replace(TEARDOWN_CALL, '// ' + TEARDOWN_CALL)),
        expect: /live call site/
      },
      {
        // NB: with a call site deleted, the ">= 2 live call sites" half of A1 is what fires first —
        // the mutation is caught, by the count rather than by the per-method message.
        why: 'delete the teardown call from Exit (caught by the shared-teardown count)',
        make: (s) => spliceBody(s, SIG.exit, (b) => b.replace(TEARDOWN_CALL, '/* teardown removed */')),
        expect: /live call site\(s\) of ApplyExitTeardown/
      },
      {
        why: 'delete the teardown call from SyncExitedFromFile (caught by the shared-teardown count)',
        make: (s) => spliceBody(s, SIG.sync, (b) => b.replace(TEARDOWN_CALL, '/* teardown removed */')),
        expect: /live call site\(s\) of ApplyExitTeardown/
      }
    ]
  },
  {
    id: 'A2',
    name: 'ApplyExitTeardown turns off EVERY visual flag and kills the cycle',
    run: a2,
    mutations: [
      { why: 'drop Glow.Ask(false)', make: (s) => spliceBody(s, SIG.teardown, (b) => b.replace('Glow.Ask(false)', 'Glow.Ask(true)')), expect: /no longer does: .*Glow\.Ask\(false\)/ },
      { why: 'drop _stopped = false', make: (s) => spliceBody(s, SIG.teardown, (b) => b.replace('_stopped = false;', '_stopped = true;')), expect: /no longer does: .*_stopped = false/ },
      { why: 'restore the old one-flag adoption body', make: (s) => spliceBody(s, SIG.teardown, () => '{ _exited = true; }'), expect: /no longer does:/ }
    ]
  },
  {
    id: 'A3',
    name: 'the EXITED record carries provenance (source= / at= / evidence=)',
    run: a3,
    mutations: [
      { why: 'stop writing evidence=', make: (s) => spliceBody(s, SIG.record, (b) => b.replace('"evidence="', '"note="')), expect: /no longer writes: evidence=/ },
      { why: 'write the raw sentence instead of the record builder', make: (s) => sub(s, /File\.WriteAllText\(ExitMarkerPath\(\), ExitRecordText\(why\)/, 'File.WriteAllText(ExitMarkerPath(), why'), expect: /no longer written through ExitRecordText/ }
    ]
  },
  {
    id: 'A4',
    name: 'the cycle-lighting gate cannot light a dead cycle (!Panic.Exited)',
    run: a4,
    mutations: [
      {
        why: 'delete the negated Panic.Exited term',
        make: (s) => {
          const start = s.indexOf('bool cycleOp =')
          if (start < 0) return null
          const end = stmtEnd(s, start)
          if (end < 0) return null
          const expr = s.slice(start, end)
          const next = expr.replace(/!\s*\(?\s*Panic\.Exited\b/, 'true')
          return next === expr ? null : s.slice(0, start) + next + s.slice(end)
        },
        expect: /cycleOp does not test !Panic\.Exited/
      },
      { why: 'rename the cycleOp gate away', make: (s) => sub(s, /bool cycleOp =/, 'bool cycleVisible ='), expect: /the cycleOp gate was not found/ }
    ]
  },
  {
    id: 'A5',
    name: 'neither chord detector decides on async/global key state alone',
    run: a5,
    mutations: [
      {
        why: 'hook: Ctrl judged on async state alone',
        make: (s) => sub(s, /_humanCtrl\s*&&\s*\(Native\.GetAsyncKeyState\(Native\.VK_CONTROL\)/, '(Native.GetAsyncKeyState(Native.VK_CONTROL)'),
        expect: /HOOK chord branch does not derive/
      },
      {
        why: 'hook: Alt judged on async state alone',
        make: (s) => sub(s, /_humanAlt\s*&&\s*\(Native\.GetAsyncKeyState\(Native\.VK_MENU\)/, '(Native.GetAsyncKeyState(Native.VK_MENU)'),
        expect: /HOOK chord branch does not derive/
      },
      {
        why: 'poll: drop the hook-tracked Alt requirement',
        make: (s) => spliceBody(s, SIG.poll, (b) => b.replace('_humanCtrl && _humanAlt && asyncCtrl && asyncAlt && agentQuiet', '_humanCtrl && agentQuiet')),
        expect: /POLL chord branch does not require BOTH/
      },
      {
        // D (2026-09-13): the poll's evidence line used to PASS true,true — claiming an async
        // confirmation it never measured. Dropping the measurement is the mutation.
        why: 'poll: report an async confirmation that was never measured',
        make: (s) => spliceBody(s, SIG.poll, (b) => b.replace('ChordEvidence(kk, asyncCtrl, asyncAlt)', 'ChordEvidence(kk, true, true)')),
        expect: /does not pass the MEASURED values into ChordEvidence/
      },
      {
        why: 'poll: measure the async state but decide alone on it (no hook-tracked gate)',
        make: (s) => spliceBody(s, SIG.poll, (b) => b.replace('_humanCtrl && _humanAlt && asyncCtrl && asyncAlt && agentQuiet', 'asyncCtrl && asyncAlt && agentQuiet')),
        expect: /does not require BOTH hook-tracked modifiers/
      },
      {
        why: 'poll: stop measuring the async modifier state (hard-coded confirmation comes back)',
        make: (s) => spliceBody(s, SIG.poll, (b) => b.replace('bool asyncCtrl = (Native.GetAsyncKeyState(Native.VK_CONTROL) & 0x8000) != 0;', 'bool asyncCtrl = true;')),
        expect: /does not measure the async modifier state/
      }
    ]
  },
  {
    id: 'A6',
    name: 'PollThread: Clear() before Exit(, OS latch drained on start, agent quiet',
    run: a6,
    mutations: [
      {
        why: 'swap Clear()/Exit( order (a stale Q latch may beat the re-arm)',
        make: (s) => spliceBody(s, SIG.poll, (b) => {
          const i = b.indexOf('Clear()')
          if (i < 0) return null
          const ls = b.lastIndexOf('\n', i) + 1
          const le = b.indexOf('\n', i)
          if (le < 0) return null
          const line = b.slice(ls, le)
          const rest = b.slice(0, ls) + b.slice(le + 1)
          const close = rest.lastIndexOf('}')
          return rest.slice(0, close) + line + '\n' + rest.slice(close)
        }),
        expect: /evaluates Exit\( before Clear\(/
      },
      {
        why: 'remove the warm-up guard (drain the OS latch bits on start)',
        make: (s) => spliceBody(s, SIG.poll, (b) => sub(b, /if\s*\(\s*warm\s*<\s*\d+\s*\)\s*warm\+\+\s*;\s*else\s+if/, 'if')),
        expect: /has no warm-up guard/
      },
      {
        why: 'make the warm-up drain nothing',
        make: (s) => spliceBody(s, SIG.poll, (b) => sub(b, /if\s*\(\s*warm\s*<\s*\d+\s*\)/, 'if (warm < 0)')),
        expect: /drains for 0 iteration/
      },
      {
        why: 'drop the agentQuiet requirement',
        make: (s) => spliceBody(s, SIG.poll, (b) => b.replace('&& agentQuiet)', ')')),
        expect: /does not require agentQuiet/
      }
    ]
  },
  {
    id: 'A7',
    name: 'the CYCLE-ENDED refusal names the time and forbids the accusation',
    run: a7,
    mutations: [
      {
        why: 'put the old sentence back into the refusal',
        make: (s) => sub(s, /"CYCLE-ENDED: /, '"CYCLE-ENDED: ' + OLD_REFUSAL + '. '),
        expect: /still contains "Ctrl\+Alt\+Q ended computer use for this session"/
      },
      {
        why: 'stop naming the recorded time',
        make: (s) => {
          const msg = refusalOf(s)
          if (!msg) return null
          const next = msg.split('_exitAt').join('""')
          return next === msg ? null : s.replace(msg, next)
        },
        expect: /does not name the recorded time/
      },
      {
        why: 'remove both the RECORD wording and the prohibition',
        make: (s) => {
          const msg = refusalOf(s)
          if (!msg) return null
          const next = msg.split('RECORD').join('moment').split('do NOT tell the human').join('never mention')
          return next === msg ? null : s.replace(msg, next)
        },
        expect: /neither says RECORD nor forbids/
      }
    ]
  },
  {
    id: 'B1',
    name: 'Main adopts the record after the Panic.Changed wiring and before the --op branch',
    run: b1,
    mutations: [
      {
        why: 'delete the adoption call from Main',
        make: (s) => {
          const i = s.indexOf(SIG.main)
          const j = s.indexOf('Panic.SyncExitedFromFile();', i)
          if (j < 0) return null
          return s.slice(0, s.lastIndexOf('\n', j) + 1) + s.slice(s.indexOf('\n', j) + 1)
        },
        expect: /does not adopt the EXITED record before handling an op|AFTER the --op one-shot branch/
      },
      {
        why: 'move the adoption into the --op branch (too late)',
        make: (s) => {
          const i = s.indexOf(SIG.main)
          const j = s.indexOf('Panic.SyncExitedFromFile();', i)
          if (j < 0) return null
          const out = s.slice(0, s.lastIndexOf('\n', j) + 1) + s.slice(s.indexOf('\n', j) + 1)
          const k = out.indexOf('args[0] == "--op"', i)
          if (k < 0) return null
          const brace = out.indexOf('{', k) + 1
          return out.slice(0, brace) + '\n                Panic.SyncExitedFromFile();' + out.slice(brace)
        },
        expect: /adopts the EXITED record AFTER the --op one-shot branch/
      }
    ]
  }
]

// ---------- run the static leg, then prove it can fail -----------------------------------
const failures = []
for (const c of CHECKS) {
  const msg = c.run(code)
  if (msg) failures.push(`${c.id} (${c.name}): ${msg}`)
}
let proven = 0
let mutations = 0
for (const c of CHECKS) {
  for (const m of c.mutations) {
    mutations++
    const mutant = m.make(raw)
    if (!mutant) {
      failures.push(`self-test ${c.id}: the mutation "${m.why}" could NOT be constructed (anchor missing in the source) — the guard is not proven falsifiable for this invariant`)
      continue
    }
    const msg = c.run(deComment(mutant))
    if (!msg) {
      failures.push(`self-test FAILED ${c.id}: mutation "${m.why}" did NOT trip the guard`)
    } else if (!m.expect.test(msg)) {
      failures.push(`self-test ${c.id}: mutation "${m.why}" tripped a different check than intended — got: ${msg}`)
    } else {
      proven++
    }
  }
}

// ---------- B. behavioural leg, only where it cannot touch the evidence ------------------
// The worker resolves the EXITED marker from LocalApplicationData with NO environment override
// (exit-marker path ≠ DSH_COMPUTER_USE_STOP_FILE, which only moves the BRAKE file). So a synthetic
// record cannot be planted anywhere but the REAL %LOCALAPPDATA%\dsh-computer-use\EXITED — which is
// evidence for the incident under investigation and is never written, moved or deleted by this
// guard. When that is the case the adoption point is asserted statically instead (B1 above).
const markerPathBody = bodyOf(code, 'static string ExitMarkerPath()')
const markerEnvMatch = markerPathBody ? /GetEnvironmentVariable\("([^"]+)"\)/.exec(markerPathBody) : null
const markerEnv = markerEnvMatch ? markerEnvMatch[1] : null
const exePresent = fs.existsSync(EXE)
let leg
if (!exePresent) {
  leg = `SKIP behavioural (no compiled exe at ${path.relative(path.dirname(import.meta.dirname), EXE)}) — the static leg is authoritative`
} else if (!markerEnv) {
  leg = 'SKIP behavioural (the worker has no env override for the EXITED marker path — ExitMarkerPath() reads LocalApplicationData only, so the only plantable record is the REAL %LOCALAPPDATA%\\dsh-computer-use\\EXITED, which is evidence and must not be touched) — asserted statically instead: ' +
    (b1(code) ? 'FAILED, see above' : 'Main calls Panic.SyncExitedFromFile() after the Panic.Changed wiring and before the --op one-shot branch')
} else {
  // Reachable only if the worker grows an override: plant the record in a private temp dir, point
  // EVERY real path the worker can write at that dir, and make the exe (a READ-ONLY `probe`, which
  // reports the cycle state) prove it adopted the record before handling the op.
  //
  // ALL THREE PATHS, NOT ONE (2026-09-13, real damage): this leg used to redirect only the EXITED
  // marker, while the production teardown ALSO deletes the STOP file and appends to the audit log —
  // so running it adopted a synthetic exit, deleted the machine's REAL brake file and wrote two
  // EXIT-ADOPTED lines into the REAL audit log (measured: 10:17:22.854 and 10:18:20.926). A test may
  // not leave a footprint on the evidence, so the isolation now covers EXIT_FILE + STOP_FILE +
  // AUDIT_LOG, and the snapshot check below PROVES the real paths came out unchanged.
  let dir = null
  // METADATA IS NOT CONTENT: exists/size/mtime can miss a same-size rewrite, so the snapshot below
  // carries a real SHA-256 of every file that exists (and "ABSENT" when it does not).
  const LOCAL = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-computer-use')
  const realPaths = ['EXITED', 'STOP', 'worker-audit.log'].map((n) => path.join(LOCAL, n))
  const snap = () => realPaths.map((p) => {
    try { const b = fs.readFileSync(p); return `${p}|${b.length}|${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}` } catch { return `${p}|ABSENT` }
  })
  const before = snap()
  // THIS LEG IS NOT READ-ONLY, AND THEREFORE NOT DEFAULT (2026-09-13, Codex review). Even with all
  // three writable paths redirected, a REAL worker that adopts a synthetic EXITED runs
  // ReleaseStuck() → SendInput, which can release keys physically held on the live desktop right now.
  // A test with a desktop side effect must not ride along inside the ordinary suite and must never be
  // reported as a pass by default: it is opt-in, and the default says SKIP out loud.
  const NATIVE_LEG = process.env.DSH_CU_NATIVE_RELEASE_LEG === '1'
  if (!NATIVE_LEG) {
    leg = 'SKIP behavioural native leg (opt-in): it SPAWNS A REAL WORKER, and an adopted record runs ReleaseStuck() → SendInput, which can lift keys held on the live desktop — not a read-only probe. It is NOT a pass. Run the dedicated desktop acceptance with DSH_CU_NATIVE_RELEASE_LEG=1 (three-path isolation is then mandatory).'
  } else try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exit-coherence-'))
    const marker = path.join(dir, 'EXITED')
    fs.writeFileSync(marker, ['Ctrl+Alt+Q chord detected', 'source=hook', 'at=2020-01-01 00:00:00', 'evidence=vk=0x51', 'note=synthetic record planted by ' + NAME].join('\r\n'), 'utf8')
    const r = spawnSync(EXE, ['--op', 'probe', '{}'], {
      env: {
        ...process.env,
        [markerEnv]: marker,
        DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
        DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
      },
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    if (!/"exited"\s*:\s*true/.test(out)) {
      failures.push(`behavioural: the exe did not adopt the synthetic record planted at ${markerEnv}=<temp> (probe did not report exited:true) — stdout was: ${out.slice(0, 400)}`)
    }
    // THE ISOLATION IS ITSELF CHECKED: if any REAL path changed, this leg is a contaminating test.
    const after = snap()
    for (let i = 0; i < realPaths.length; i++) {
      if (after[i] !== before[i]) {
        failures.push(`behavioural leg TOUCHED THE REAL MACHINE STATE: ${path.basename(realPaths[i])} was "${before[i].split('|').slice(1).join('|')}" before and "${after[i].split('|').slice(1).join('|')}" after — this test must run with EXIT_FILE + STOP_FILE + AUDIT_LOG all redirected`)
      }
    }
    leg = `behavioural RAN (${markerEnv}=<temp>, STOP_FILE=<temp>, AUDIT_LOG=<temp>; the real EXITED/STOP/audit were verified unchanged)`
  } catch (e) {
    failures.push(`behavioural leg threw: ${e && e.message ? e.message : String(e)}`)
    leg = 'behavioural: could not run (see failure)'
  } finally {
    try {
      if (dir && path.resolve(dir).startsWith(path.resolve(os.tmpdir())) && path.basename(dir).startsWith('dsh-exit-coherence-')) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch { }
  }
}

if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  console.log('FAIL ' + NAME)
  process.exit(1)
}
console.log(
  'ok ' + NAME + ' — ' + CHECKS.length + ' invariants on worker.cs@' + sha + ': ' +
  'Exit() and SyncExitedFromFile() both run ApplyExitTeardown(), which clears every visual flag (_engaged/_stopped/CycleLit off, Disarm(), Glow.Kill()/Ask(false)/Stopped(false), DeleteStopFile()); ' +
  'the EXITED record on disk carries source= / at= / evidence=; ' +
  'the cycleOp gate tests !Panic.Exited so a dead cycle cannot be lit; ' +
  'both chord detectors require the hook-tracked _humanCtrl/_humanAlt and PollThread never reads async Ctrl/Alt; ' +
  'PollThread drains the OS latch on start, requires agentQuiet, and puts Clear() before Exit( so Ctrl+Alt+R can never be read as Ctrl+Alt+Q; ' +
  'the CYCLE-ENDED refusal drops the old "Ctrl+Alt+Q ended computer use for this session" sentence and names the recorded time while forbidding the accusation; ' +
  'each invariant falsified: ' + proven + '/' + mutations + ' in-memory mutations tripped exactly the intended check; ' +
  leg
)
