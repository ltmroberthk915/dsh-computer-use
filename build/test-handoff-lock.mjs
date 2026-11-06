import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-lock-'))
const win = process.env.WINDIR || 'C:/Windows', gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
  ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll')),
  path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
  path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
  path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd')]
const source = path.join(import.meta.dirname, '../lib/core/worker.cs')
try {
  const exe = path.join(dir, 'probe.exe')
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:HandoffLockFixture', '/out:' + exe,
    ...refs.map(r => '/r:' + r), source, path.join(import.meta.dirname, 'handoff-lock-fixture.cs'),
  ], { windowsHide: true, timeout: 30000 })
  const run = args => JSON.parse(execFileSync(exe, args, { windowsHide: true, timeout: 10000, encoding: 'utf8',
    env: { ...process.env, DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
      DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED') } }))
  assert.equal(run(['legacy']).confirmedLegacyDeadlock, true)
  const fixed = run([])
  assert.equal(fixed.entered, true)
  assert.equal(fixed.bothCompleted, true)
  assert.equal(fixed.emptyHandoffCredential, true)
  assert.equal(fixed.secureCompleted, true)
  const text = fs.readFileSync(source, 'utf8')
  const handler = text.slice(text.indexOf('Panic.Changed = delegate'), text.indexOf('Json.MaxJsonLength ='))
  assert.match(handler, /string pauseId = Panic.EventPauseId\(kind\)/)
  assert.doesNotMatch(handler, /Panic.TemporaryPauseId/)
  const audit = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8')
  assert.match(audit, /heldCount=0; quietRemainingMs=0; inputEpoch=/)
  console.log('ok test-handoff-lock — original lock inversion reproduced; fixed handoff/secure callbacks complete without input; phase audit includes held/quiet evidence')
} catch (error) {
  console.error(String(error.stdout || ''), String(error.stderr || ''))
  throw error
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
