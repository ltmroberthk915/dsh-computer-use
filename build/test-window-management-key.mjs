import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { workerReferences } from '../lib/core/native-runtime.js'

const source = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const text = fs.readFileSync(source, 'utf8')
const key = text.slice(text.indexOf('static Dictionary<string, object> Key('), text.indexOf('static Dictionary<string, object> Type('))
assert.match(key, /WindowManagementChord\.IsExact\(combo\)/)
assert.match(key, /WindowManagementChord\.Run\(vks, SendKey, ReleaseKeyForCleanup/)
assert.match(key, /WaitForKeyHold\(0\).*InvalidateKeyboardTarget/)
assert.match(key, /keyOut\["receiverChanged"\][\s\S]*?focus\["pid"\]/)
assert.match(key, /keyOut\["effectVerified"\] = false/)
assert.doesNotMatch(key, /"switched"/)
const activate = text.slice(text.indexOf('static Dictionary<string, object> Activate('), text.indexOf('static bool IsForeground('))
assert.match(activate, /CheckHumanInput\(\);\s*if \(how != "failed"\) _keyboardReobserveRequired = false/)
assert.equal([...text.matchAll(/_keyboardReobserveRequired\s*=\s*false/g)].length, 1, 'only successful explicit activation clears gate')
const focus = text.slice(text.indexOf('static Dictionary<string, object> FocusReport('), text.indexOf('static Dictionary<string, object> WindowOp('))
assert.ok(focus.indexOf('CheckKeyboardReobserve()') < focus.indexOf('RefocusWindow('), 'stale expectHwnd cannot auto-refocus before gate')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-window-key-'))
try {
  const exe = path.join(dir, 'fixture.exe')
  execFileSync(path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/main:WindowManagementKeyFixture', '/out:' + exe,
    ...workerReferences().map(r => '/r:' + r), source, path.join(import.meta.dirname, 'window-management-key-fixture.cs'),
  ], { windowsHide: true, timeout: 30000 })
  const result = JSON.parse(execFileSync(exe, [], { windowsHide: true, timeout: 15000, encoding: 'utf8', env: {
    ...process.env, DSH_HOME: path.join(dir, 'home'), DSH_COMPUTER_USE_STOP_FILE: path.join(dir, 'STOP'),
    DSH_COMPUTER_USE_EXIT_FILE: path.join(dir, 'EXITED'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(dir, 'audit.jsonl'),
    DSH_COMPUTER_USE_OWNER_FILE: path.join(dir, 'owner'),
  } }))
  assert.equal(result.ok, true)
  assert.equal(result.realInput, false)
  assert.equal(result.realForegroundChange, false)
  assert.ok(result.assertions >= 70)
  console.log(JSON.stringify(result))
} catch (error) {
  if (error.stdout) process.stderr.write(String(error.stdout))
  if (error.stderr) process.stderr.write(String(error.stderr))
  throw error
} finally {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(dir, { recursive: true, force: true })
}
