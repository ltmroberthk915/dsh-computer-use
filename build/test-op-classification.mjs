// build/test-op-classification.mjs
//
// THE DRIFT GUARD. Every op in the worker's dispatcher must be CLASSIFIED, because the two sets that
// decide what an op may do are load-bearing:
//
//   DrivesMachineOps — may re-open an EXITED session (undo the human's Ctrl+Alt+Q)
//   ReadOnlyOps      — still allowed while the brake is engaged (the brake stops CONTROL, not sight)
//
// The bug this exists for (2026-09-12): re-opening was gated by a DENYLIST, and `probe` — the op our
// own deploy script runs after every build — was never on it, so deploy silently deleted the EXITED
// marker and re-opened a session the human had ended; a red border then appeared "out of nowhere".
// Third time that shape bit us (calm, then resume, then probe). A new op must therefore FORCE a
// decision instead of defaulting into "yes, it can drive".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const worker = fs.readFileSync(path.join(root, 'lib/core/worker.cs'), 'utf8')

// Housekeeping: sent by the PLUGIN or by a diagnostic script on its own behalf, never by the model
// asking for the machine. These must never re-open a session and must never be mistaken for work.
const HOUSEKEEPING = new Set(['abort', 'ping', 'echoargs', 'indicator', 'calm', 'resume', 'panic',
  'selftest', 'cursor', 'probe', 'echoargs',
  // keyClass (D, 2026-09-13) is a TEST SEAM: it drives the production key-classification transition
  // (Panic.ClassifyAndTrackKey) with explicit evidence, so a guard can measure "an injected key is not
  // the human's" without touching a real keyboard. It must never drive the machine, light anything or
  // re-open an exited session — so it belongs here, beside the other read-only/housekeeping ops.
  // keyClass (D) and stuckPlan (ReleaseStuck bug) are TEST SEAMS: they drive the production
  // classification/release-decision functions with explicit evidence, send no input and light
  // nothing, and must answer while a brake is up (that is when the decision is inspected).
  'keyClass', 'stuckPlan'])

const setOf = (src, name) => {
  const m = new RegExp(name + '[\\s\\S]*?\\{([\\s\\S]*?)\\}\\s*;').exec(src)
  if (!m) return null
  return new Set([...m[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]))
}

function analyze (src) {
  const start = src.indexOf('switch (op)')
  if (start < 0) return { err: 'the dispatcher switch (op) was not found' }
  const tail = src.slice(start)
  const end = tail.indexOf('\n            }')
  const region = end > 0 ? tail.slice(0, end) : tail
  const labels = [...region.matchAll(/case "([A-Za-z0-9_]+)":/g)].map((m) => m[1])

  // A broken extraction must never look like a pass.
  if (labels.length < 10) return { err: `only ${labels.length} dispatcher cases extracted — the EXTRACTION is broken, not the source (expected 15+)` }

  const driving = setOf(src, 'DrivesMachineOps')
  const readOnly = setOf(src, 'ReadOnlyOps')
  if (!driving) return { err: 'DrivesMachineOps not found' }
  if (!readOnly) return { err: 'ReadOnlyOps not found' }

  const unclassified = []
  const doubled = []
  for (const l of labels) {
    const inDrive = driving.has(l), inRead = readOnly.has(l), inHouse = HOUSEKEEPING.has(l)
    if (!inDrive && !inRead && !inHouse) unclassified.push(l)
    if (inDrive && inRead) doubled.push(l)      // a driving op is never "read only"
  }
  const errs = []
  if (unclassified.length) {
    errs.push(`UNCLASSIFIED op(s): ${unclassified.join(', ')} — decide on purpose: add to DrivesMachineOps (it drives the machine and may re-open an exited session) or to ReadOnlyOps/housekeeping (it must not)`)
  }
  if (doubled.length) errs.push(`op(s) in BOTH sets: ${doubled.join(', ')}`)
  if (errs.length) return { err: errs.join(' | ') }
  return { labels, driving, readOnly }
}

const failures = []
const main = analyze(worker)
if (main.err) failures.push(main.err)

// self-test: a NEW op must be rejected until someone classifies it.
const ANCHOR = '                case "beginAsk": return Ok(BeginAskOp(a));'
if (!worker.includes(ANCHOR)) {
  failures.push('self-test: cannot find the dispatcher anchor to inject a new op')
} else {
  const mutated = worker.replace(ANCHOR, '                case "brandNewOp": return Ok(Dict("x", 1));\n' + ANCHOR)
  const m = analyze(mutated)
  if (!m.err || !m.err.includes('brandNewOp')) {
    failures.push('self-test FAILED: the guard accepted an unclassified new op — it cannot fire for the drift it exists to catch')
  }
}

if (failures.length) {
  console.error('FAIL test-op-classification')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`ok test-op-classification — ${main.labels.length} dispatcher ops classified (${main.driving.size} driving, ${main.readOnly.size} read-only, housekeeping); a new op must be classified on purpose (self-tested)`)
