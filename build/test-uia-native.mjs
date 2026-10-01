// Production UIA methods, invoked only against controls owned by this fixture.
// Worker Main, input hooks and the real host's STOP/EXITED files are never used.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uia-fixture-'))
try {
  const exe = path.join(dir, 'probe.exe'), win = process.env.WINDIR || 'C:/Windows'
  const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll'))]
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:OptimizeProbe', '/out:' + exe, ...refs.map(r => '/r:' + r), path.join(here, '../lib/core/worker.cs'), path.join(here, 'uia-native-fixture.cs')], { windowsHide: true, timeout: 30000 })
  const env = { ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_UIA_BENCH_QUICK: '1', DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.jsonl') }
  delete env.DSH_CU_HOST_PID; delete env.DSH_CU_HOST_EXE
  const raw = execFileSync(exe, [], { env, windowsHide: true, timeout: 90000, encoding: 'utf8' })
  const rows = raw.trim().split(/\r?\n/).map(s => JSON.parse(s)), get = name => { const row = rows.find(r => r.case === name); assert.ok(row, name); return row }
  assert.equal(get('select-one').serializedElements, 1)
  assert.equal(get('missing').serializedElements, 0)
  assert.equal(get('broad-80').serializedElements, 80)
  assert.equal(get('broad-80').truncated, true)
  assert.equal(get('exact-id-act').lastHit, 'button-80')
  assert.equal(get('exact-id-act').hits, 1)
  assert.equal(get('ambiguous-act').extraHits, 0)
  assert.match(get('ambiguous-act').refusal, /AMBIGUOUS_UIA_TARGET/)
  assert.equal(get('query-exact-id').count, 1)
  assert.equal(get('id-prefix').matched, false)
  for (const name of ['depth-truncated', 'budget-truncated']) {
    assert.equal(get(name).extraHits, 0)
    assert.match(get(name).refusal, /INCOMPLETE_UIA_SEARCH/)
  }
  assert.equal(get('complete').fixtureOnly, true)
  console.log('ok test-uia-native — matching, limits, exact IDs, one real invocation, ambiguous/incomplete refusal with zero extra clicks')
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
