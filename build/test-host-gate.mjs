// Host-driving debug gates: the allowed shape and the two things that must never be possible.
//
// The gates exist because the agent must not be able to open them itself. These assertions are
// about SOURCE SHAPE on purpose: the settings route writes the switch, the worker reads it, and
// the gate notice card is fire-and-forget. A behavior test that mounted the real host would need
// the whole DSH runtime; this file pins the wiring the behavior depends on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const index = read('lib/index.js')
const hostDebug = read('lib/host-debug.js')
const worker = read('lib/core/worker.cs')
const core = read('lib/core/index.js')
const client = read('client.js')

// 1) The switch is host-side and only the route writes it.
assert.match(hostDebug, /export function writeHostDebug/)
assert.match(hostDebug, /export function readHostDebug/)
assert.match(hostDebug, /export function sessionPermission/)
assert.match(hostDebug, /sandbox === 'danger-full-access'/, 'gate 1 is exactly danger-full-access')
assert.equal((index.match(/writeHostDebug\(/g) || []).length, 1, 'only the settings route writes the switch')
assert.ok(!/writeHostDebug/.test(core), 'the core never writes the switch')

// 2) Both gates are stamped per call and fail closed.
assert.match(core, /signed\.__hostDebug = !!\(gate && gate\.debug === true\)/)
assert.match(core, /signed\.__hostFull = !!\(gate && gate\.full === true\)/)
assert.match(core, /DSH_CU_HOST_DEBUG_FILE: this\.hostDebugFile/)

// 3) The worker requires BOTH, refuses close/minimize/hide even when allowed, and audits.
assert.match(worker, /_requestHostDebug && _requestHostFull && HostDebugFileEnabled\(\)/)
assert.match(worker, /op == "close" \|\| op == "minimize" \|\| op == "hide"/)
// The click path has an EXTRA preliminary HOST-GUARDED label before GuardHostDriving. When the
// gates allow, that label must be cleared or the generic blocked!=null refusal wins even though
// the gate just returned successfully (the 2026-11-09 "debug ON, full access, click still refused"
// report). Dry-run must report the same decision without dispatching.
assert.match(worker, /bool hostClickAllowed = hostVictim && HostDrivingAllowed\(\)/)
assert.match(worker, /if \(hostVictim\)\s*\{\s*GuardHostDriving\([\s\S]{0,240}?blocked = null;[\s\S]{0,160}?detail = null;/,
  'host click must clear the preliminary HOST-GUARDED label after GuardHostDriving allows')
assert.match(worker, /"HOST_DEBUG_GATE: "/)
assert.match(worker, /AuditRecord\("HOST-CONTROL"/)
// A worker launched WITHOUT host identity (CLI/MCP/test harness) must not be able to close the
// Harness either — the 2026-11-08 accident did exactly that. confirmHost:true is the only escape.
assert.match(worker, /static bool LooksLikeHarness\(IntPtr h\)/)
assert.match(worker, /!HostGuardConfigured\(\) && LooksLikeHarness\(h\)/)
assert.match(worker, /confirmHost:true is for an intentional CLI shutdown only/)

// 4) The notice is one card, deduped, and never blocks the failed call.
assert.match(index, /function notifyHostGate \(log\)/)
assert.match(index, /Date\.now\(\) - gateNoticeAt < 10 \* 60_000/, 'cards are deduped for ten minutes')
assert.match(index, /notifyHostGate\(log\)/)
assert.ok(!/await notifyHostGate/.test(index), 'the failed tool call never waits for the card')

// 5) The settings page exists and calls the same-origin route.
assert.match(client, /__ModuleLoader__\.load/)
assert.match(client, /settings\.section/)
assert.match(client, /\/api\/computer-use\/host-debug/)

console.log('ok test-host-gate — switch is host-only, both gates fail closed, host close is never allowed, notice is deduped')
