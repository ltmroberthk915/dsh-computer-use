// Runtime regression test for #3 (idle approval click/keyboard stays free) and
// #4 (an actuation-time handoff publishes handoff:yielding then handoff:idle by
// itself). Production worker.cs + real PollThread; no OS input or overlay.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { workerReferences } from '../lib/core/native-runtime.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-runtime-'))
const exe = path.join(dir, 'fixture.exe')
const audit = path.join(dir, 'audit.log')
try {
  execFileSync(path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/main:HandoffRuntimeFixture', '/out:' + exe,
    ...workerReferences().map(r => '/r:' + r),
    path.resolve(import.meta.dirname, '../lib/core/worker.cs'),
    path.join(import.meta.dirname, 'handoff-runtime-fixture.cs'),
  ], { windowsHide: true, timeout: 30000, encoding: 'utf8' })

  const out = execFileSync(exe, [], { windowsHide: true, timeout: 25000, encoding: 'utf8', env: {
    ...process.env, DSH_HOME: path.join(dir, 'home'),
    DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
    DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'),
    DSH_COMPUTER_USE_AUDIT_LOG: audit,
    DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'owner'),
  } })
  const result = JSON.parse(out.trim().split(/\r?\n/u).filter(Boolean).at(-1))
  assert.equal(result.idleInput.phase, 'idle', '#3: idle click/typing must not start a handoff')
  assert.equal(Number(result.idleInput.revision), 0, '#3: idle input must not bump the takeover revision')
  assert.notEqual(result.typed.phase, 'idle', '#4: keyboard during actuation must yield')
  assert.equal(result.normalIdle, true, '#4: handoff must auto-idle within 4.5s')
  assert.equal(result.normal.phase, 'idle', '#4: handoff phase')
  assert.ok(result.events.includes('yielding'), '#4: JS-visible handoff:yielding must be published')
  assert.ok(result.events.includes('idle'), '#4: JS-visible handoff:idle must be published')
  const log = fs.readFileSync(audit, 'utf8')
  assert.match(log, /HUMAN-HANDOFF.*phase=yielding/u)
  assert.match(log, /HUMAN-HANDOFF.*phase=idle/u)
  console.log('ok test-handoff-runtime — #3 idle input is free; #4 publishes yielding and self-idles (events + audit)')
} finally {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(dir, { recursive: true, force: true })
}
