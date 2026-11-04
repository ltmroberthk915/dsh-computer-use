// Real OS handle exclusion across processes, with no hooks or desktop input.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createCycleGate } from '../lib/cycle.js'

let passed = 0
const gate = createCycleGate(), session = 'same-session'
gate.noteTurnStart(session)
const a = gate.claim({ session, agent: { id: 'parent' } })
let releaseOpen
const open = gate.open(a, () => new Promise(resolve => { releaseOpen = resolve }))
await Promise.resolve()
assert.throws(() => gate.open(gate.claim({ session, agent: { id: 'child' } }), () => {}), e => e.dshCycleRefusal)
releaseOpen({ opened: true }); await open
const cycleId = gate.snapshot().id
gate.assertOwnership(a, cycleId); passed++
gate.mark('paused')
assert.throws(() => gate.open(gate.claim({ session: 'other', agent: 'other' }), () => {}), e => e.dshCycleRefusal)
gate.assertOwnership(a, cycleId); passed++
gate.noteTurnStart(session)
assert.throws(() => gate.assertOwnership(a, cycleId), e => e.code === 'COMPUTER_OWNER_CHANGED')
const a2 = gate.claim({ session, agent: 'parent' }); await gate.open(a2, () => {})
gate.assertOwnership(a2, cycleId); passed++
gate.release('owner finished')
assert.throws(() => gate.assertOwnership(a2, cycleId), e => e.code === 'COMPUTER_OWNER_CHANGED')
const b = gate.claim({ session, agent: 'child' }); await gate.open(b, () => {})
gate.assertOwnership(b, gate.snapshot().id); passed++
const anonymous = createCycleGate(), agent1 = {}, agent2 = {}
await anonymous.open(anonymous.claim({ agent: agent1 }), () => {})
assert.throws(() => anonymous.open(anonymous.claim({ agent: agent2 }), () => {}), e => e.dshCycleRefusal)
assert.throws(() => createCycleGate().open({}), e => e.code === 'COMPUTER_OWNER_REQUIRED'); passed++
const separators = createCycleGate()
await separators.open(separators.claim({ session: 'one|two', agent: 'three' }), () => {})
assert.throws(() => separators.open(separators.claim({ session: 'one', agent: 'two|three' }), () => {}), e => e.dshCycleRefusal); passed++

if (process.platform === 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-desktop-ownership-'))
  const exe = path.join(dir, 'fixture.exe'), file = path.join(dir, 'desktop.owner')
  const source = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
  // Compile production with an alternate Main: no worker hooks, overlay startup,
  // or native inputs. Boundary tests replace the native sender with a throwing seam.
  const worker = fs.readFileSync(source, 'utf8')
  const marker = '    public sealed class DesktopOwnershipLease'
  assert(worker.includes(marker), 'production worker contains the ownership lease')
  const holders = []
  const launch = async (name, hold = false) => {
    const child = spawn(exe, [file, name, ...(hold ? ['hold'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    holders.push(child)
    const lines = createInterface({ input: child.stdout })
    const ended = once(child, 'exit')
    const [line] = await Promise.race([once(lines, 'line'), ended.then(([code]) => { throw Error('fixture ended before output: ' + code) })])
    return { child, line, ended }
  }
  try {
    const win = process.env.WINDIR || 'C:/Windows', gac = path.join(win, 'Microsoft.NET/assembly/GAC_MSIL')
    const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
      ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(n => path.join(gac, n, 'v4.0_4.0.0.0__31bf3856ad364e35', n + '.dll'))]
      refs.push(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll'),
        path.join(gac, 'System.Runtime.WindowsRuntime/v4.0_4.0.0.0__b77a5c561934e089/System.Runtime.WindowsRuntime.dll'),
        path.resolve(import.meta.dirname, '../lib/core/winmd/Windows.winmd'))
    execFileSync(path.join(win, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:x64', '/main:DesktopOwnershipFixture', '/out:' + exe, ...refs.map(r => '/r:' + r), source, path.join(import.meta.dirname, 'desktop-ownership-fixture.cs')],
      { windowsHide: true, timeout: 30000, encoding: 'utf8' })
    const first = await launch('agent-a', true); assert.equal(first.line, 'owned')
    assert.equal(execFileSync(exe, [file, 'foreign-agent', 'boundary'], { windowsHide: true, timeout: 5000, encoding: 'utf8',
      env: { ...process.env, DSH_COMPUTER_USE_OWNER_FILE: file, DSH_COMPUTER_USE_STOP_FILE: file + '.STOP',
        DSH_COMPUTER_USE_EXIT_FILE: file + '.EXITED', DSH_COMPUTER_USE_AUDIT_LOG: file + '.audit' } }).trim(), 'boundaries:8'); passed++
    const other = await launch('agent-b'); assert.match(other.line, /^busy:.*owner=agent-a/)
    assert.equal((await other.ended)[0], 2); passed++
    first.child.stdin.end('\n'); assert.equal((await first.ended)[0], 0)
    const next = await launch('agent-b', true); assert.equal(next.line, 'owned'); passed++
    next.child.kill(); await next.ended
    const recovered = await launch('agent-c'); assert.equal(recovered.line, 'owned'); await recovered.ended; passed++
    // Record left on disk is not itself ownership. No age/PID-based lock stealing.
    fs.writeFileSync(file, 'pid=1\nowner=stale-record\n')
    const stale = await launch('agent-d'); assert.equal(stale.line, 'owned'); await stale.ended; passed++
    const contenders = await Promise.all(Array.from({ length: 6 }, (_, i) => launch('race-' + i, true)))
    assert.equal(contenders.filter(x => x.line === 'owned').length, 1)
    for (const contender of contenders) { if (contender.line === 'owned') contender.child.stdin.end('\n'); await contender.ended }
    passed++
  } finally {
    const running = holders.filter(child => child.exitCode === null && child.signalCode === null)
    const exits = running.map(child => once(child, 'exit'))
    for (const child of running) child.kill()
    await Promise.all(exits)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
console.log(`ok test-desktop-ownership — ${passed} ownership cases; session/agent/turn assertions and native process exclusion, release, crash, stale record, six-way race`)
