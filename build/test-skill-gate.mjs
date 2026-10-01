// test-skill-gate.mjs — the read-receipt gate ("未先读 skill 时拒绝驱动类 op") must exist, must be
// wired in BOTH dispatch paths, must never be able to block the safety direction, and the phrase it
// demands must actually live in the manual. A gate whose phrase is missing from SKILL.md locks the
// agent out forever; a gate that also covers computer_ask or stop() can block a brake. Both are worse
// than no gate, so both are checked — and every check carries a mutation that must make it fire.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const F = {
  gate: path.join(ROOT, 'lib/skill-gate.js'),
  index: path.join(ROOT, 'lib/index.js'),
  tools: path.join(ROOT, 'lib/tools.js'),
  skill: path.join(ROOT, 'skills/computer-use/SKILL.md'),
}
const read = (p) => fs.readFileSync(p, 'utf8')
const SRC = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, read(p)]))
// The phrase is read OUT OF THE SOURCE TEXT, not out of an imported module: a mutation exists only in
// the text, so checking an import would test the unmutated file on disk and could never fire.
const phraseOf = (gateSrc) => ((gateSrc.match(/export const REQUIRED_PHRASE = '([^']+)'/) || [])[1] || '')

// TEXT CHECKS RUN ON COMMENT-STRIPPED SOURCE. A comment quoting `next(decision)` satisfied the
// negative check below while the code was fine — and, worse, a comment quoting a rule once satisfied
// the cycle guard while the code underneath was broken. Newlines are preserved so line-anchored
// patterns keep working; string literals are copied through so a `//` inside a URL is not a comment.
function stripComments (src) {
  let out = ''; let i = 0; let mode = 'code'
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2 } else { if (c === '\n') out += c; i++ } continue }
    if (c === '\\') { out += c + (d || ''); i += 2; continue }
    if (c === mode) mode = 'code'
    out += c; i++
  }
  return out
}
const stripAll = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stripComments(v)]))
const CHECKSRC = stripAll(SRC)

// ---- behavioural test of the gate module itself (it is pure, so this is a real test) -------------
const mod = await import(pathToFileURL(F.gate).href + '?t=' + Date.now())
mod.resetAcks()
const failures = []
const t = (name, ok, detail) => { if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`) }

t('gate: a WRONG phrase is rejected', mod.acknowledge('nope', 's1') === false, 'acknowledge("nope") returned true')
t('gate: a wrong phrase does not open anything', mod.isAcked('s1') === false, 'session s1 became acked')
t('gate: the exact phrase opens its session', mod.acknowledge(mod.REQUIRED_PHRASE, 's1') === true, 'exact phrase rejected')
t('gate: and only that session', mod.isAcked('s1') === true && mod.isAcked('s2') === false, 'ack leaked to another session')
t('classify: a batch of pure OBSERVATION steps is not driving', mod.isDrivingCall('computer_batch', { actions: [{ tool: 'computer_wait', args: {} }, { tool: 'computer_state', args: {} }] }) === false, 'a batch of observation steps was classified as driving')
t('classify: a batch containing a click IS driving', mod.isDrivingCall('computer_batch', { actions: [{ tool: 'computer_wait', args: {} }, { tool: 'computer_click', args: { at: '1,1' } }] }) === true, 'a batch with a click was not driving')
t('classify: a NESTED batch is judged by its innermost steps', mod.isDrivingCall('computer_batch', { actions: [{ tool: 'computer_batch', args: { actions: [{ tool: 'computer_move', args: { at: '1,1' } }] } }] }) === true, 'nested driving step was missed')
t('classify: an empty batch is not driving', mod.isDrivingCall('computer_batch', { actions: [] }) === false, 'empty batch was driving')
t('classify: clipboard read is not driving, write is', mod.isDrivingCall('computer_clip', {}) === false && mod.isDrivingCall('computer_clip', { text: 'x' }) === true, 'clipboard classification wrong')
t('classify: the safety direction is never driving', mod.isDrivingCall('computer_ask', {}) === false && mod.isDrivingCall('computer_ctrl', { action: 'stop' }) === false && mod.isDrivingCall('computer_ctrl', { action: 'exit' }) === false, 'a safety-direction call was classified as driving')
t('classify: calibrate moves the pointer, so it IS driving', mod.isDrivingCall('computer_ctrl', { action: 'calibrate' }) === true, 'calibrate was not driving')
t('classify: a driving tool drives, an observation tool does not', mod.isDrivingCall('computer_click', { at: '1,1' }) === true && mod.isDrivingCall('computer_shot', {}) === false, 'tool classification wrong')
t('gate: surrounding whitespace is tolerated', mod.acknowledge('  ' + mod.REQUIRED_PHRASE + '  ', 's3') === true, 'trimmed phrase rejected')

// ---- the gate is actually enforced, in index.js --------------------------------------------------
const CHECKS = [
  ['phrase lives in SKILL.md', (s) => { const p = phraseOf(s.gate); return !!p && s.skill.includes(p) }],
  ['index imports the gate', (s) => /from '\.\/skill-gate\.js'/.test(s.index)],
  ['index refuses DRIVING calls until acked', (s) => /isDrivingCall\(exec\.name, gArgs\)/.test(s.index) && /kind: 'deny', reason: `READ THE PROCEDURE FIRST/.test(s.index)],
  ['index handles the acknowledge action', (s) => /gAct === 'acknowledge'/.test(s.index) && /acknowledge\(gArgs\.text, sessionKey\(drv\)\)/.test(s.index)],
  ['the gate refuses a WRONG phrase too', (s) => /return \{ kind: 'deny', reason: `acknowledge failed/.test(s.index)],
  // THE HOOK CONTRACT (found 2026-09-13 by A/B: a call policy.js denies reached its HANDLER). On this
  // DSH build `next` is `() => Promise<PreToolDecision>` — it takes NO arguments — so a decision fed
  // to next() is silently discarded and the waterfall falls back to its {kind:'allow'} default: the
  // whole approval gate was inert while its side effects still ran. Decisions must be RETURNED.
  ['pre-execute decisions are RETURNED, never passed to next()', (s) => /return decision/.test(s.index) && !/next\(decision\)/.test(s.index) && !/next\(\{/.test(s.index)],
  ['computer_ask is NEVER gated (safety direction)', (s) => /if \(name === 'computer_ask'\) return false/.test(s.gate)],
  ['stop/selftest/exit are NEVER gated', (s) => /if \(name === 'computer_ctrl'\) return String\(a\.action \|\| 'selftest'\) === 'calibrate'/.test(s.gate)],
  ['a batch is driving only if something INSIDE it drives', (s) => /steps\.some\(\(step\) => step && isDrivingCall/.test(s.gate)],
  ['tools.js wires acknowledge in the TOOL path', (s) => /case 'acknowledge': return \{ acknowledged: true/.test(s.tools)],
  ['tools.js wires acknowledge in the BATCH path', (s) => (s.tools.match(/case 'acknowledge': return \{ acknowledged: true/g) || []).length >= 2],
  ['tools.js advertises acknowledge in the enum', (s) => /selftest \| calibrate \| stop \| exit \| indicator \| acknowledge/.test(s.tools)],
]

for (const [name, fn] of CHECKS) t(name, fn(CHECKSRC), 'pattern not found in the source')

// ---- every check must be able to fail: break one thing, that check must go red -------------------
const MUTATIONS = [
  ['ask becomes gated', 'gate', "if (name === 'computer_ask') return false", 'if (name === \'computer_ask\') return true', 'computer_ask is NEVER gated'],
  ['stop/exit become gated', 'gate', "if (name === 'computer_ctrl') return String(a.action || 'selftest') === 'calibrate'", "if (name === 'computer_ctrl') return true", 'stop/selftest/exit are NEVER gated'],
  ['the gate is dropped', 'index', 'isDrivingCall(exec.name, gArgs)', 'false', 'index refuses DRIVING'],
  ['batch path unwired', 'tools', "        case 'acknowledge': return { acknowledged: true, note: 'procedure acknowledged — driving is open for this session' }\n", '', 'BATCH path'],
  ['the phrase drifts from the manual', 'gate', mod.REQUIRED_PHRASE, mod.REQUIRED_PHRASE + ' (changed)', 'phrase lives in SKILL.md'],
  ['a decision is fed to next() again', 'index', '      return decision', '      return next(decision)', 'RETURNED, never passed'],
  ['a batch is gated as a whole again', 'gate', "return steps.some((step) => step && isDrivingCall(String(step.tool || ''), step.args || {}))", 'return true', 'a batch is driving only if'],
  ['a deny is fed to next() again', 'index', "        return { kind: 'deny', reason: `READ THE PROCEDURE FIRST. ${ACK_HINT}` }", "        return next({ kind: 'deny', reason: `READ THE PROCEDURE FIRST. ${ACK_HINT}` })", 'RETURNED, never passed'],
]
let caught = 0
for (const [label, file, from, to, expectCheck] of MUTATIONS) {
  const mutated = { ...SRC }
  if (!mutated[file].includes(from)) { failures.push(`self-test BUG: cannot mutate "${label}" (anchor absent in ${file})`); continue }
  mutated[file] = mutated[file].split(from).join(to)
  if (mutated[file] === SRC[file]) { failures.push(`self-test BUG: mutation "${label}" changed NOTHING`); continue }
  // re-evaluate only the checks that apply to mutated files, plus the skill cross-check
  let fired = false
  const mStripped = stripAll(mutated)
  for (const [name, fn] of CHECKS) {
    if (name.includes(expectCheck) && !fn(mStripped)) fired = true
  }
  if (fired) caught++
  else failures.push(`self-test FAILED: nothing fired for mutation "${label}" (expected ${expectCheck})`)
}

if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  console.log(`FAIL test-skill-gate — ${failures.length} problem(s); self-test ${caught}/${MUTATIONS.length}`)
  process.exit(1)
}
console.log(`ok test-skill-gate — 9 invariant groups hold across 4 files; the read-receipt gate is enforced, wired in both paths, never blocks the safety direction, and its phrase is quoted from the manual (self-test ${caught}/${MUTATIONS.length} mutations caught)`)
