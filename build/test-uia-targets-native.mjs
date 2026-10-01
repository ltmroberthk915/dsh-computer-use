// Exercise production UIA recovery exclusively on this fixture's own controls.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const here = import.meta.dirname
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-target-fixture-'))
try {
  const exe = path.join(dir, 'probe.exe'), win = process.env.WINDIR || 'C:/Windows'
  const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll'))]
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:UiTargetProbe', '/out:' + exe, ...refs.map(r => '/r:' + r), path.join(here, '../lib/core/worker.cs'), path.join(here, 'uia-target-fixture.cs')], { windowsHide: true, timeout: 30000 })
  const env = { ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.jsonl') }
  delete env.DSH_CU_HOST_PID; delete env.DSH_CU_HOST_EXE
  let raw
  try { raw = execFileSync(exe, [], { env, windowsHide: true, timeout: 60000, encoding: 'utf8' }) }
  catch (error) { process.stdout.write(error.stdout || ''); throw error }
  const rows = raw.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(rows.length, 12)
  assert.ok(rows.every(row => row.ok))
  if (process.env.DSH_TARGET_RESULTS) fs.writeFileSync(process.env.DSH_TARGET_RESULTS, JSON.stringify(rows, null, 2))
  console.log('ok test-uia-targets-native — 12 native fixture checks: original/recreated identities, semantic recovery, ambiguity/context/window/incomplete refusals; 3 real owned-control invocations')
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
