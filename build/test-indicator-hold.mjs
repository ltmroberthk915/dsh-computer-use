// The dark-blue cue and physical ownership must describe the actual action scope.
// Timing and offscreen visual behavior are exercised by test-preparation.mjs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { maskComments } from './mask-comments.mjs'
const source = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/core/worker.cs'), 'utf8')
const code = maskComments(source)
const body = (text, signature) => {
  const start = text.indexOf(signature), end = text.indexOf('\n        }', start)
  return start < 0 || end < 0 ? '' : text.slice(start, end)
}
const ordered = (text, ...tokens) => {
  let at = -1
  for (const token of tokens) { const next = text.indexOf(token, at + 1); if (next < 0) return false; at = next }
  return true
}
const cleanupBypassesGate = text => {
  const stuck = body(text, 'static void ReleaseStuck()')
  const owned = body(text, 'public static uint ReleaseOwnedInputs()')
  const key = body(text, 'static uint ReleaseOwnedKey(string key)')
  return stuck.includes('Program.ReleaseOwnedInputs()') && owned.includes('ReleaseOwnedKey(key)') &&
    ordered(key, 'OwnedUps.TryGetValue(key, out input)', 'Panic.HumanHolds(physical)', 'InputSender(new INPUT[] { release })') &&
    !/SendInputChecked\(|SendTrackedInput\(|Panic\.Check\(/.test(stuck + owned + key)
}
const exactScope = text => /bool acting = _enabled && _sceneVisible && Acting;/.test(text) &&
  !/_lastTouchMs|_holdMs|pendingSince/.test(text) &&
  ordered(body(text, '\n        static void BeginActuation()'), 'Panic.BeginActuation()', 'CheckHumanInput()') &&
  body(text, 'static Dictionary<string, object> Handle(string line)').includes('finally { _operationActing = false; Panic.EndActuation(); Glow.Prepare(false); }')
assert.ok(exactScope(code), 'actual action scope controls blue, with no timer tail or dwell')
assert.equal(exactScope(code.replace('bool acting = _enabled && _sceneVisible && Acting;', 'bool acting = true;')), false, 'the guard rejects an always-on cue')
assert.equal(exactScope(code.replace('finally { _operationActing = false; Panic.EndActuation(); Glow.Prepare(false); }',
  'finally { _operationActing = false; Glow.Prepare(false); }')), false, 'the guard rejects missing finally cleanup')
const input = body(code, 'static void SendInputChecked(INPUT[] arr)')
assert.ok(ordered(input, 'if (Panic.Exited)', 'if (Panic.Engaged || Panic.Stopped)', 'CheckHumanInput()',
  'BeginActuation()', 'Glow.InputBegin()', 'SendTrackedInput(arr)', 'finally { Glow.InputEnd(); }'),
  'every injection obeys brake and ownership checks and balances its injection scope')
assert.ok(body(code, 'static uint SendTrackedInput(INPUT[] inputs)').includes('InputSender(inputs)'), 'accepted inputs use the testable sender')
assert.ok(/InputSender = delegate\(INPUT\[\] inputs\)\s*\{\s*return Native.SendInput\(/.test(code), 'production sender calls Windows')
assert.ok(cleanupBypassesGate(code), 'accepted-input cleanup remains possible after a brake')
for (const [signature, before, after] of [
  ['static void ReleaseStuck()', 'Program.ReleaseOwnedInputs()', 'Program.NoCleanup()'],
  ['static uint ReleaseOwnedKey(string key)', 'InputSender(new INPUT[] { release })', 'SendTrackedInput(new INPUT[] { release })'],
]) {
  const original = body(code, signature)
  assert.ok(original.includes(before))
  assert.equal(cleanupBypassesGate(code.replace(original, original.replace(before, after))), false, `cleanup mutation rejected: ${before}`)
}
const moving = body(code, 'static void AnimatedMove(int tx, int ty, int durationMs)')
assert.ok(ordered(moving, 'Glow.InputBegin()', 'Thread.Sleep(stepMs)', 'finally { Glow.InputEnd(); }'), 'animated sequence includes inter-step gaps')
const warning = body(code, 'static void PrepareActuation(string op, Dictionary<string, object> request)')
assert.ok(ordered(warning, 'Glow.Prepare(true)', 'while (!Glow.PreparationVisible)', 'while (timer.ElapsedMilliseconds < Glow.PreparationMs || !Glow.PreparationComplete)',
  'finally { Glow.Prepare(false); }'), 'warning duration starts after visibility and clears on failure')
assert.ok(/FullMs = 1000, RepeatMs = 100, RepeatWindowMs = 180000/.test(code), 'warning uses a rolling three-minute 1s/100ms cadence')
assert.ok(code.includes('Holding && sceneVisible ? 8') && code.includes('SceneControl.SetHolding(GetB(a, "hold", false))'), 'explicit scene hold is authoritative independently of renderer visibility')
assert.ok(!warning.includes('BeginActuation()'), 'warning does not claim physical input')
assert.ok(ordered(body(code, 'static Dictionary<string, object> Click(Dictionary<string, object> a)'),
  'if (i < clicks - 1) Thread.Sleep(gap)', 'EndActuationForReadback()', 'verifyDelayMs', 'FocusReport(a, false)'),
  'click releases real control before verification delays and focus readback')
assert.ok(ordered(body(code, 'static Dictionary<string, object> UiaAct(Dictionary<string, object> a)'),
  'switch (action)', 'EndActuationForReadback()', 'Thread.Sleep(GetI(a, "settleMs", 120))'),
  'UIA releases real control before its settling/readback phase')
assert.ok(code.includes('"acting", Glow.Acting') && code.includes('"preparing", Glow.Preparing') && code.includes('"injecting", Glow.Injecting'),
  'probe exposes observable actuation, preparation and injection facts')
console.log('ok test-indicator-hold — actual-scope cue, balanced injection, no timed tail, visible adaptive preparation and cleanup guards')
