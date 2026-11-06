// Compile production helpers; never start the worker, show a window or send input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-geometry-'))
const win = process.env.WINDIR || 'C:/Windows'
const gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
  ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll')),
  path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
  path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
  path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd')]
const source = path.join(import.meta.dirname, '../lib/core/worker.cs')
const exe = path.join(dir, 'probe.exe')
try {
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:UiGeometryFixture', '/out:' + exe,
    ...refs.map(r => '/r:' + r), source, path.join(import.meta.dirname, 'ui-geometry-fixture.cs'),
  ], { windowsHide: true, timeout: 30000 })
  const result = JSON.parse(execFileSync(exe, [], { windowsHide: true, timeout: 15000, encoding: 'utf8' }))
  assert.equal(result.ok, true)
  assert.ok(result.checks >= 25)
  const text = fs.readFileSync(source, 'utf8')
  assert.match(text, /"cooperation", Panic.CooperationState\(\), "indicator", IndicatorSnapshot\(\)/)
  console.log(`ok test-ui-geometry — ${result.checks} invalid bounds, hidden/offscreen, negative monitor and indicator checks`)
} catch (error) {
  console.error(String(error.stdout || ''), String(error.stderr || ''))
  throw error
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
