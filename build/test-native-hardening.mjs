import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { workerReferences } from '../lib/core/native-runtime.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-hardening-'))
const win = process.env.WINDIR || 'C:/Windows'
try {
  const exe = path.join(dir, 'fixture.exe')
  execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/main:NativeHardeningFixture', '/out:' + exe,
    ...workerReferences().map(r => '/r:' + r), path.resolve(import.meta.dirname, '../lib/core/worker.cs'),
    path.join(import.meta.dirname, 'native-hardening-fixture.cs'),
  ], { windowsHide: true, timeout: 30000 })
  const result = JSON.parse(execFileSync(exe, [path.join(import.meta.dirname, 'key-command-cases.json')], {
    windowsHide: true, timeout: 15000, encoding: 'utf8', env: {
      ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
      DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
      DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'desktop.owner'), DSH_CU_BUILD_ID: 'fixture-build', DSH_CU_SOURCE_HASH: 'fixture-source',
    },
  }))
  assert.equal(result.passed, 8)
  assert.ok(result.assertions >= 65)
  assert.equal(result.nativeInput, false)
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(String(error.stdout || ''), String(error.stderr || ''))
  throw error
} finally {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
