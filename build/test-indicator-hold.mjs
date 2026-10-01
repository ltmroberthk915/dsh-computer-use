// A light that lies is worse than no light. This guard exists because the deep-blue "acting" border
// stayed lit for THIRTY SECONDS after a millisecond of input: the default hold was 30000 while the
// plugin never passes indicatorMs, so blue meant "recently touched", not "touching now" — and it
// outranks cyan, so a reading agent looked like a driving one. Keep the default a tail, not an era.
import fs from 'node:fs'
import path from 'node:path'
const W = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const src = fs.readFileSync(W, 'utf8')
const failures = []
const cap = 2500

const defaults = [...src.matchAll(/GetI\(a, "indicatorMs", (\d+)\)/g)].map((m) => Number(m[1]))
if (defaults.length === 0) failures.push('no indicatorMs default found at all — did the wording change?')
for (const d of defaults) {
  if (!(d > 0 && d <= cap)) failures.push(`indicatorMs default is ${d} ms — a single input would paint the ACTING light for ${(d / 1000).toFixed(1)} s (cap ${cap} ms)`)
}
const acting = /int hold = GetI\(a, "indicatorMs", (\d+)\)/.test(src) || /hold = GetI\(a, "indicatorMs", (\d+)\)/.test(src)
if (!acting) failures.push('the AgentActing hold is no longer derived from indicatorMs — re-check what the blue light means now')

// the guard must be able to fail: putting 30000 back has to trip it
let fired = false
for (const d of defaults) {
  const mutated = src.split(`"indicatorMs", ${d})`).join('"indicatorMs", 30000)')
  if (mutated === src) continue
  const bad = [...mutated.matchAll(/GetI\(a, "indicatorMs", (\d+)\)/g)].map((m) => Number(m[1])).filter((v) => v > cap)
  if (bad.length > 0) fired = true
}
if (!fired) failures.push('self-test FAILED: restoring the 30000 ms default did not trip the cap')

// ---- 2026-09-13 (indicator bug, measured on the production build): the hold is a TAIL, so it must
// never be the only thing that decides "acting" while input is still being injected. A real
// move(moveDurationMs=3500) ran 3823 ms and the blue expired at 1200 ms mid-flight (pixels: blue at
// 1737 ms, cyan at 2153/3438 ms, moveStillPending on all 8 frames). The light now also reads the
// injection itself, and its hold is ANCHORED to the last real injection rather than the op's start —
// without lengthening the hold and without letting blue outlive the input.
const SIC = /static void SendInputChecked\(INPUT\[\] arr\)[\s\S]*?\n        \}/.exec(src)
const sicBody = SIC ? SIC[0] : ''
const order = (...tokens) => {
  let at = -1
  for (const t of tokens) { const i = sicBody.indexOf(t, at + 1); if (i < 0) return false; at = i }
  return at >= 0
}
const CHECKS = [
  ['the ACTING light is true while an injection sequence is in flight',
    /bool acting = _enabled && \(Injecting \|\|/.test(src),
    'the render loop decides ACTING only from the hold timer — a long injection would go cyan mid-flight'],
  // Order inside the ONE injection gate, not proximity: the interrupt gate added in 2026-09-13 sits
  // between the function head and KeepActing, and a length window is not a contract.
  ['every real injection re-anchors the hold (SendInputChecked is the one gate)',
    order('Glow.InputBegin()', 'Glow.KeepActing()', 'Native.SendInput('),
    'SendInputChecked no longer marks the injection, re-anchors the ACTING light and then injects, in that order'],
  ['the injection mark is cleared in a finally (blue cannot outlive the input)',
    order('Glow.InputBegin()', 'finally { Glow.InputEnd(); }'),
    'the injection refcount is not released in a finally — a thrown SendInput would leave the light stuck blue'],
  ['an interrupt is enforced at the injection gate, BEFORE anything is sent',
    order('if (Panic.Exited)', 'if (Panic.Engaged || Panic.Stopped)', 'Glow.InputBegin()', 'Glow.KeepActing()'),
    'SendInputChecked injects without re-checking a mid-action stop/exit — a 2.5 s move would keep moving after the brake'],
  ['cleanup releases do NOT go through the gate that refuses after a stop/exit',
    /ReleaseStuck\(\)[\s\S]{0,2500}?Native\.SendInput\(/.test(src) && !/ReleaseStuck\(\)[\s\S]{0,2500}?SendInputChecked\(/.test(src),
    'ReleaseStuck() sends through SendInputChecked — the interrupt gate would block the cleanup that releases a stuck drag/key'],
  ['an animated move brackets the whole SEQUENCE, not one step',
    /Stopwatch sw = Stopwatch\.StartNew\(\);[\s\S]{0,400}?Glow\.InputBegin\(\);[\s\S]{0,900}?finally \{ Glow\.InputEnd\(\); \}/.test(src),
    'AnimatedMove does not hold the injection mark across its sleeps — the gaps read as thinking again'],
  ['probe reports the injection state as a fact',
    /"injecting", Glow\.Injecting/.test(src),
    'probe does not report whether input is in flight, so the light cannot be checked numerically'],
]
for (const [name, ok, why] of CHECKS) {
  if (!ok) failures.push(`${name} — ${why}`)
}
if (!failures.some((f) => f.startsWith('the ACTING light'))) {
  const stripped = src.replace('bool acting = _enabled && (Injecting ||', 'bool acting = _enabled && (false ||')
  if (/bool acting = _enabled && \(Injecting \|\|/.test(stripped)) failures.push('self-test FAILED: removing the injection term did not trip the check')
}

if (failures.length) { for (const f of failures) console.log('  FAIL ' + f); console.log('FAIL test-indicator-hold'); process.exit(1) }
console.log(`ok test-indicator-hold — the ACTING light's hold defaults are ${defaults.join('/')} ms (cap ${cap}); a 30 s restore is caught by the self-test`)