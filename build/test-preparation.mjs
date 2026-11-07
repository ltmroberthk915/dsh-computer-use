import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preparation-'))
const source = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const evidence = path.join(import.meta.dirname, 'preparation-evidence')
const win = process.env.WINDIR || 'C:/Windows'
const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
  ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name => path.join(gac, name, 'v4.0_4.0.0.0__31bf3856ad364e35', name + '.dll'))]
  refs.push(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
    path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
    path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd'))
const exe = path.join(dir, 'preparation.exe')
try {
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:PreparationFixture', '/out:' + exe,
      ...refs.map(ref => '/r:' + ref), source, path.join(import.meta.dirname, 'preparation-fixture.cs')],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' })
} catch (error) { console.error(error.stdout, error.stderr); throw error }
const result = JSON.parse(execFileSync(exe, [evidence], { windowsHide: true, timeout: 15000, encoding: 'utf8', env: {
  ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
  DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
  DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'desktop.owner'),
} }))
// 11 checks before 2026-11-07 + 1 for the continuous-operation grace window (human rule).
assert.equal(result.passed, 12)
assert.equal(result.nativeInput, false)
assert.equal(result.visibleOverlay, false)
fs.writeFileSync(path.join(evidence, 'logic.json'), JSON.stringify(result, null, 2))
console.log(`ok test-preparation — ${result.passed} cases; first-frame wait ${result.startupMs} ms; no real input/overlay; previews: ${evidence}`)
