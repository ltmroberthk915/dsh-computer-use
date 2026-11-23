// Real acceptance for the CUA-IMPL-1123 UIA features, on a private non-input desktop.
//
// The measured code is the SHIPPED lib/core/worker.cs, compiled unchanged with the fixture into one
// probe exe; the fixture only provides targets and its own counters. Nothing here mocks the worker:
// every number comes from the production Uia/UiaAct methods.
//
// Usage: node build/test-uia-feature.mjs [--results <path>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { requirePrivateDesktop } from './private-desktop-test.mjs'

// The launcher forwards only the script path, so a CLI --results must be converted to an ABSOLUTE
// path and handed to the child through the environment BEFORE requirePrivateDesktop re-executes us.
{
  const flag = process.argv.indexOf('--results')
  if (flag > 0 && process.argv[flag + 1]) process.env.CUA_UIA_FEATURE_RESULTS = path.resolve(process.argv[flag + 1])
}
const resultsPath = process.env.CUA_UIA_FEATURE_RESULTS || null
// The generic launcher (private-desktop-test-launcher.cs) refuses a timeout above 210000 ms, so the
// runner stays inside that budget instead of asking the launcher to relax its own guard.
requirePrivateDesktop(import.meta.filename, { timeoutMs: 210000 })

const here = import.meta.dirname
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uia-feature-'))
try {
  const exe = path.join(dir, 'probe.exe')
  const win = process.env.WINDIR || 'C:/Windows'
  const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll',
    'System.Windows.Forms.dll', ...['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase']
      .map(name => path.join(gac, name, 'v4.0_4.0.0.0__31bf3856ad364e35', name + '.dll'))]
  refs.push(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
    path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
    path.resolve(here, '../lib/core/winmd/Windows.winmd'))
  // The probe compiles the SHIPPED worker source; a compile failure is a feature failure, not a skip.
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:UiaFeatureProbe', '/out:' + exe,
      ...refs.map(ref => '/r:' + ref),
      path.join(here, '../lib/core/worker.cs'), path.join(here, 'uia-feature-fixture.cs')],
    { windowsHide: true, timeout: 60000 })

  const env = { ...process.env, DSH_HOME: path.join(dir, 'home'),
    DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
    DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'),
    DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.jsonl') }
  delete env.DSH_CU_HOST_PID
  delete env.DSH_CU_HOST_EXE

  let raw
  // Compile + run must both fit inside the launcher's 210 s budget: measured worst case is a few
  // seconds each, so 60 s + 140 s leaves the launcher room to report its own timeout instead.
  try { raw = execFileSync(exe, ['--out=' + path.join(dir, 'rows.jsonl')], { env, windowsHide: true, timeout: 140000, encoding: 'utf8' }) }
  catch (error) { process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); throw error }

  const rows = raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const failed = rows.filter(row => row.ok !== true)
  if (resultsPath) fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2) + '\n')

  // Every expected case must be present: a silently missing case is a failure, never a pass.
  const expected = [
    'actions-editor-selectable', 'actions-password-no-selectText', 'actions-readonly-no-setValue',
    'actions-disabled-no-invoke', 'actions-disabled-no-focus', 'actions-nosroll-axis',
    'actions-leaf-node-no-expand-collapse', 'actions-expand-collapse-state-filtered',
    'actions-clearable-single-allows-remove', 'actions-required-single-no-remove',
    'actions-required-multi-allows-remove', 'actions-required-multi-last-no-remove',
    'actions-unselected-add-only', 'actions-multi-select-add-when-unselected',
    'actions-multi-select-remove-when-selected',
    'actions-no-view-without-pattern',
    'actions-scroll-axes-reported', 'actions-views-reported', 'actions-opt-in-only',
    'scroll-starts-two-axis', 'scroll-exact-70-untouched-axis', 'scroll-horizontal-only-untouched-vertical',
    'scroll-omitted-axis-unchanged', 'scroll-illegal-value-no-mutation', 'scroll-requires-an-axis',
    'scroll-unsupported-control-refused', 'scroll-unavailable-axis-refused', 'scroll-direction-still-works',
    'realize-row-offscreen-first', 'realize-provider-called', 'realize-requires-reobserve',
    'realize-unsupported-control-refused',
    'views-start-at-one', 'views-switch-one-to-two', 'views-unsupported-id-refused',
    'views-non-numeric-refused', 'views-unsupported-control-refused',
    'select-default-whole-range', 'select-cursor-before', 'select-cursor-after',
    'select-repeated-still-ambiguous', 'select-suffix-disambiguates', 'select-absent-refused',
    'select-bad-selectionType-refused', 'select-unicode-offsets', 'select-password-refused',
    'select-wrong-range-not-verified', 'select-exactly-one-commit',
    'fixture-complete',
  ]
  for (const name of expected) {
    const row = rows.find(entry => entry.name === name)
    assert.ok(row, `missing case: ${name}`)
    assert.equal(row.ok, true, `${name} failed: ${JSON.stringify(row.detail)}`)
  }
  assert.deepEqual(failed, [], 'every measured case must pass')
  console.log(`ok test-uia-feature — ${rows.length} production UIA checks: per-control actions with ` +
    'password/read-only/disabled/axis negatives, exact 70% with an untouched axis and rejected illegal values, ' +
    'real VirtualizedItem.Realize with reobserve, 1->2 view switch with unsupported-id refusal, and ' +
    'selectText default/cursor_before/cursor_after with real endpoint verification')
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
