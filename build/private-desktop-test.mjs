import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

// The child verifies its actual Win32 desktop before any test code starts.
// An environment flag alone is never accepted as proof of isolation.
export function requirePrivateDesktop (script, { timeoutMs = 180000 } = {}) {
  if (process.platform !== 'win32') throw Error('This native test requires Windows')
  if (process.env.DSH_PRIVATE_TEST_ACTIVE === '1') {
    execFileSync(process.env.DSH_PRIVATE_TEST_LAUNCHER, ['verify', String(process.pid)], { windowsHide: true })
    const log = process.env.DSH_PRIVATE_TEST_LOG
    const capture = (chunk, encoding, callback) => {
      fs.appendFileSync(log, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'))
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') queueMicrotask(done)
      return true
    }
    process.stdout.write = capture; process.stderr.write = capture
    process.on('uncaughtExceptionMonitor', error => fs.appendFileSync(log, String(error.stack || error) + '\n'))
    console.log('ISOLATION verified: private non-input desktop; no SwitchDesktop; descendants contained by kill-on-close job')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-isolated-test-'))
  const launcher = path.join(dir, 'launcher.exe'), log = path.join(dir, 'test.log')
  try {
    const csc = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + launcher,
      path.join(import.meta.dirname, 'private-desktop-test-launcher.cs')], { windowsHide: true, timeout: 30000 })
    const env = { ...process.env, DSH_PRIVATE_TEST_ACTIVE: '1', DSH_PRIVATE_TEST_DESKTOP: 'DshIsolatedTest-' + randomUUID(),
      DSH_PRIVATE_TEST_LAUNCHER: launcher, DSH_PRIVATE_TEST_LOG: log, DSH_PRIVATE_TEST_TIMEOUT_MS: String(timeoutMs),
      DSH_HOME: path.join(dir, 'home'), LOCALAPPDATA: path.join(dir, 'local'),
      DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'),
      DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'owner'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log') }
    delete env.DSH_CU_HOST_PID; delete env.DSH_CU_HOST_EXE
    const child = spawnSync(launcher, ['run', process.execPath, path.resolve(script)], {
      windowsHide: true, cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: timeoutMs + 10000 })
    if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log))
    if (child.error) throw child.error
    assert.equal(child.status, 0, child.stderr || child.stdout || 'isolated test failed')
  } finally {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe test cleanup')
    fs.rmSync(dir, { recursive: true, force: true })
  }
  process.exit(0)
}
