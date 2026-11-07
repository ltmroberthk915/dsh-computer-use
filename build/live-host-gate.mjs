// Live gate test (real host identity): spawn the shipped worker with the SAME host identity the
// plugin core injects, then aim driving ops at the REAL Harness window.
//
//  1 switch off, both flags false  -> HOST_DEBUG_GATE (host recognized, nothing dispatched)
//  2 switch off, both flags true   -> HOST_DEBUG_GATE (debug gate)
//  3 switch on,  full=incomplete   -> HOST_DEBUG_GATE (conversation gate)
//  4 switch on,  both true         -> activate allowed (audited HOST-CONTROL)
//  5 switch on,  both true         -> windowOp close REFUSED (never negotiable)
//  6 switch off again, both true   -> HOST_DEBUG_GATE (hot read, no restart)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST_EXE = 'D:\\Users\\Ming\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const HOST_PID = 46732
const HOST_HWND = 37295386
const exe = path.resolve(import.meta.dirname, '../lib/core/bin/dsh-computer-use-worker.exe')
const debugFile = path.join(os.tmpdir(), `dsh-host-gate-${process.pid}.json`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const writeSwitch = (enabled) => fs.writeFileSync(debugFile, JSON.stringify({ enabled, since: enabled ? new Date().toISOString() : null, lastBlockedAt: null }), 'utf8')

const child = spawn(exe, [], { env: { ...process.env, DSH_CU_HOST_PID: String(HOST_PID), DSH_CU_HOST_EXE: HOST_EXE, DSH_CU_HOST_DEBUG_FILE: debugFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const waiters = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.event === 'ready') { waiters.get('ready')?.(msg); continue }
    const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg) }
  }
})
const ready = new Promise((resolve) => waiters.set('ready', resolve))
let seq = 0
const call = (op, args = {}) => new Promise((resolve) => {
  const id = ++seq
  waiters.set(id, resolve)
  child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); resolve({ id, ok: false, error: 'timeout' }) } }, 20000)
})
const results = []
const check = (name, cond, detail) => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 150) : ''}`) }
const gated = (a) => /HOST_DEBUG_GATE/.test(String(a.error || ''))

await ready
const base = { hwnd: HOST_HWND, __cycle: true }

writeSwitch(false); await sleep(900)
let a = await call('activate', { ...base, __hostDebug: false, __hostFull: false })
check('1 host recognized, both gates closed -> refused', gated(a), a.error)

a = await call('activate', { ...base, __hostDebug: true, __hostFull: true })
check('2 switch off -> refused (debug gate)', gated(a), a.error)

writeSwitch(true); await sleep(900)
a = await call('activate', { ...base, __hostDebug: true, __hostFull: false })
check('3 switch on, conversation not full -> refused', gated(a), a.error)

a = await call('activate', { ...base, __hostDebug: true, __hostFull: true })
check('4 both gates open -> activate allowed', a.ok === true, JSON.stringify(a.data || a.error))

a = await call('windowOp', { ...base, hwnd: HOST_HWND, op: 'close', __hostDebug: true, __hostFull: true })
check('5 close host refused even when allowed', gated(a), a.error)

writeSwitch(false); await sleep(900)
a = await call('activate', { ...base, __hostDebug: true, __hostFull: true })
check('6 switch off again -> hot refusal (no restart)', gated(a) || /HUMAN_YIELD/.test(String(a.error || '')), a.error)

child.kill()
const failed = results.filter(x => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} live gate checks passed`)
try { fs.unlinkSync(debugFile) } catch { }
process.exit(failed.length ? 1 : 0)
