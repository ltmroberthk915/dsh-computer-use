import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const isHost = process.argv[2] === '--private-host'

async function runPrivateHost () {
  const { ComputerUse } = await import(pathToFileURL(process.env.DSH_RESPAWN_TEST_CORE))
  const core = new ComputerUse()
  const generations = []
  try {
    for (let index = 0; index < 2; index++) {
      await core.ensureWorker()
      const child = core.proc
      assert.ok(child?.pid, 'worker failed to start')
      execFileSync(process.env.DSH_RESPAWN_TEST_LAUNCHER, ['verify', String(child.pid)], { windowsHide: true })
      const before = (await core.call('ping')).glowHealth
      assert.equal(before.workerPid, child.pid, 'ping belongs to a different worker')
      const started = performance.now()
      // No hwnd, selector or title means FindHwnd returns zero. WindowOp
      // rejects this immediately AFTER the normal preparation gate and BEFORE
      // the first mutating call. It cannot select or modify any window.
      await assert.rejects(core.call('windowOp', {}), /window not found/i)
      const elapsedMs = Math.round(performance.now() - started)
      assert.ok(elapsedMs >= 1100, 'native preparation wait (1200 ms) was bypassed')
      assert.equal(core.proc, child, 'the operation must complete on the same worker')
      const after = (await core.call('probe', { what: 'glow' })).glowHealth
      assert.equal(after.workerPid, child.pid, 'probe belongs to a different worker')
      assert.ok(after.threadAlive, 'renderer died during preparation')
      assert.ok(after.preparationSerial > before.preparationSerial, 'no new preparation was requested')
      assert.equal(after.presentedSerial, after.preparationSerial, 'the new preparation serial was not presented')
      assert.ok(after.presentSuccesses > before.presentSuccesses, 'no successful native present observed')
      generations.push({ pid: child.pid, verifiedPrivateDesktop: true, elapsedMs, result: 'window not found',
        preparationSerial: after.preparationSerial, presentedSerial: after.presentedSerial,
        newSuccessfulPresents: after.presentSuccesses - before.presentSuccesses })
      if (index === 0) {
        const death = once(core, 'dead')
        assert.ok(child.kill(), 'could not terminate the first worker created by this host')
        await death
        assert.equal(core.proc, null, 'core retained the terminated generation')
      }
    }
    assert.notEqual(generations[0].pid, generations[1].pid, 'expected a new worker PID after respawn')
    return { passed: true, nodeHostPid: process.pid, sameCore: true, generations }
  } finally {
    // The graceful-abort API may release input that was never acquired.
    // Terminate only the test-owned child, with no desktop control command.
    if (core.proc) {
      const death = once(core, 'dead')
      core.proc.kill()
      await death
    }
  }
}

if (isHost) {
  const result = process.env.DSH_RESPAWN_TEST_RESULT
  try {
    fs.writeFileSync(result, JSON.stringify(await runPrivateHost()))
  } catch (error) {
    fs.writeFileSync(result, JSON.stringify({ passed: false, error: String(error.stack || error) }))
    process.exitCode = 1
  }
} else {
  if (process.platform !== 'win32') throw new Error('requires Windows native desktop support')
  const packageCore = path.join(here, '../lib/core/index.js')
  const source = path.resolve(process.argv[2] || (fs.existsSync(packageCore)
    ? packageCore : path.join(here, '../packages/computer-use-core/src/index.js')))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-respawn-'))
  const helper = path.join(dir, 'private-desktop.exe')
  const result = path.join(dir, 'result.json')
  try {
    const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + helper,
      path.join(here, 'native-respawn-desktop.cs')], { windowsHide: true, stdio: 'inherit' })
    const test = spawnSync(helper, ['run', process.execPath, import.meta.filename], {
      windowsHide: true, timeout: 65000, encoding: 'utf8', env: {
        ...process.env, LOCALAPPDATA: dir, DSH_HOME: dir,
        DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'),
        DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'owner'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.log'),
        DSH_RESPAWN_TEST_CORE: source, DSH_RESPAWN_TEST_DESKTOP: 'DshRespawn-' + randomUUID(),
        DSH_RESPAWN_TEST_RESULT: result, DSH_RESPAWN_TEST_LAUNCHER: helper
      }
    })
    if (test.error) throw test.error
    if (!fs.existsSync(result)) throw new Error('no isolated-host result: ' + test.stderr)
    const report = JSON.parse(fs.readFileSync(result, 'utf8'))
    assert.ok(report.passed && test.status === 0, report.error || test.stderr)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
