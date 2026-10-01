import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runBatch } from '../lib/batch.js'
import { registerTools } from '../lib/tools.js'
import { snapshotPath } from '../lib/audit.js'
import { saveOwnedShot, cleanupOwnedShots } from '../lib/artifacts.js'
import { ComputerUse } from '../lib/core/index.js'

let checks = 0
for (const kind of ['activate-failed', 'throw', 'cancel', 'stop', 'read', 'readback', 'shot', 'write', 'never', 'always', 'unknown']) {
  let count = 0, images = 0, stopped = false
  const abort = new AbortController()
  const write = { tool: 'computer_type', args: { text: 'fixture' } }
  const steps = kind === 'activate-failed' ? [{ tool: 'computer_window' }, write]
    : kind === 'read' ? [{ tool: 'computer_state' }]
    : kind === 'readback' ? [write, { tool: 'computer_clip' }]
    : kind === 'shot' ? [write, { tool: 'computer_shot' }]
    : kind === 'unknown' ? [{ tool: 'constructor' }, write]
    : [write, ...(kind === 'write' || kind === 'never' || kind === 'always' ? [] : [write])]
  const result = await runBatch({ steps, signal: abort.signal, stopped: () => stopped,
    shot: kind === 'never' ? 'never' : kind === 'always' ? 'always' : 'auto',
    screenshot: async () => { images++; return '/fixture-image' },
    handlers: {
      computer_window: async () => ({ activated: false }),
      computer_type: async () => { count++; if (kind === 'throw') throw Error('uncertain write'); if (kind === 'cancel') abort.abort(); if (kind === 'stop') stopped = true; return {} },
      computer_state: async () => ({}), computer_clip: async () => ({ text: 'fixture' }), computer_shot: async () => ({ path: '/existing-image' }),
    } })
  assert.equal(images, ['write', 'always'].includes(kind) ? 1 : 0, kind)
  if (kind === 'activate-failed' || kind === 'unknown') assert.equal(count, 0, kind)
  if (['cancel', 'throw', 'stop'].includes(kind)) assert.equal(count, 1, kind)
  if (kind === 'throw') assert.equal(result.actions[0].outcome, 'unknown')
  checks++
}

// Both public dispatch paths honor all wait modes; no worker is instantiated.
const definitions = new Map(), waits = []
registerTools({ ctx: { tools: { register: d => definitions.set(d.name, d) } }, defineTool: d => d,
  cu: { waitForIdle: async () => waits.push('idle'), waitStable: async () => waits.push('stable'), waitChange: async () => waits.push('change') } })
for (const mode of ['idle', 'stable', 'change']) {
  await definitions.get('computer_wait').execute({ mode })
  await definitions.get('computer_batch').execute({ actions: [{ tool: 'computer_wait', args: { mode } }] })
}
assert.deepEqual(waits, ['idle', 'idle', 'stable', 'stable', 'change', 'change']); checks++

// Actual core request timeouts do not replay a possibly committed input or call a lifecycle opener.
const core = new ComputerUse({ workerExe: 'never-started.exe' })
const sent = []
core.ready = true
core.proc = { stdin: { write: value => sent.push(JSON.parse(value)) }, kill() {} }
await assert.rejects(core.call('type', { text: 'fixture' }, 10), e => e.code === 'worker-timeout' && e.outcome === 'unknown')
assert.equal(sent.length, 1); assert.equal(sent[0].op, 'type'); assert.equal(core.exited, false); checks++

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-rules-'))
const data = { root: dir, shots: path.join(dir, 'shots') }
fs.mkdirSync(data.shots)
const files = []
try {
  const paths = new Set(Array.from({ length: 100 }, () => snapshotPath(data)))
  assert.equal(paths.size, 100)
  const keep = snapshotPath(data), remove = snapshotPath(data), foreign = path.join(data.shots, 'shot-user-file.jpg')
  files.push(keep, remove, foreign, path.join(dir, 'owned-shots.jsonl'))
  saveOwnedShot(data, keep, Buffer.from('old')); saveOwnedShot(data, remove, Buffer.from('owned'))
  fs.writeFileSync(keep, 'user edited this'); fs.writeFileSync(foreign, 'not ours')
  const before = Date.now() + 1000
  assert.deepEqual(cleanupOwnedShots(data, { before }).files, [remove]); assert.equal(fs.existsSync(remove), true)
  assert.deepEqual(cleanupOwnedShots(data, { before, dryRun: false }).files, [remove])
  assert.equal(fs.readFileSync(keep, 'utf8'), 'user edited this'); assert.equal(fs.existsSync(foreign), true); checks++

  const worker = fs.readFileSync(new URL('../lib/core/worker.cs', import.meta.url), 'utf8')
  const a = worker.indexOf('    public sealed class RecoveryPermit'), b = worker.indexOf('    // Text-first kickoff:', a)
  assert.ok(a > 0 && b > a)
  const fixture = path.join(dir, 'Fixture.cs'), exe = path.join(dir, 'Fixture.exe'), stop = path.join(dir, 'isolated-stop')
  files.push(fixture, exe, stop)
  fs.writeFileSync(fixture, `using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
${worker.slice(a, b)}
public static class Fixture {
  static void Check(bool value, string name) { if (!value) throw new Exception(name); }
  public static void Main(string[] args) {
    var permit = new RecoveryPermit { Target = 10, Pid = 20, InputVersion = 30, InputTick = 40 };
    Check(permit.Problem(permit.Id, true, false, true, 30, 40, true, 10, 20) != null, "must observe after pause");
    permit.Observed = true;
    Check(permit.Problem(permit.Id, true, false, true, 30, 40, true, 10, 20) == null, "eligible owner target");
    Check(permit.Problem("old", true, false, true, 30, 40, true, 10, 20) != null, "old credential");
    Check(permit.Problem(permit.Id, false, false, true, 30, 40, true, 10, 20) != null, "dead cycle");
    Check(permit.Problem(permit.Id, true, true, true, 30, 40, true, 10, 20) != null, "Q wins");
    Check(permit.Problem(permit.Id, true, false, false, 30, 40, true, 10, 20) != null, "no longer paused");
    Check(permit.Problem(permit.Id, true, false, true, 31, 40, true, 10, 20) != null, "new input event");
    Check(permit.Problem(permit.Id, true, false, true, 30, 41, true, 10, 20) != null, "poll detects missed event");
    Check(permit.Problem(permit.Id, true, false, true, 30, 0, true, 10, 20) != null, "missing input measurement");
    Check(permit.Problem(permit.Id, true, false, true, 30, 40, false, 10, 20) != null, "closed window");
    Check(permit.Problem(permit.Id, true, false, true, 30, 40, true, 11, 20) != null, "foreground changed");
    Check(permit.Problem(permit.Id, true, false, true, 30, 40, true, 10, 21) != null, "PID changed");
    string file = args[0], error;
    File.WriteAllText(file, "new STOP", new UTF8Encoding(false));
    Check(!OwnedStopRecord.TryRelease(file, "old STOP", out error), "newer stop cannot be deleted");
    Check(File.ReadAllText(file) == "new STOP", "mismatch preserves bytes");
    using (var held = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
      Check(!OwnedStopRecord.TryRelease(file, "new STOP", out error), "locked stop remains");
    Check(File.Exists(file), "locked stop still present");
    Check(OwnedStopRecord.TryRelease(file, "new STOP", out error), "matching owned stop released");
    Check(!File.Exists(file), "deleted exact handle");
    Check(!OwnedStopRecord.TryRelease(file, "new STOP", out error), "missing file grants no recovery");
    Console.WriteLine("ok native recovery: 19 isolated assertions; no worker Main/hooks/input");
  }
}`)
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, fixture], { windowsHide: true, timeout: 20000 })
  process.stdout.write(execFileSync(exe, [stop], { windowsHide: true, timeout: 20000 }))
  for (const source of ['Panic.ObserveTemporary(pauseId)', 'OwnedStopRecord.TryRelease(StopPath, expected', 'Interlocked.Increment(ref _externalInput)', 'case "recover": return Ok(Panic.RecoverTemporary']) assert.ok(worker.includes(source), source)
} finally {
  for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file)
  fs.rmdirSync(data.shots); fs.rmdirSync(dir)
}
console.log('ok test-task-rules — ' + checks + ' batch/transport/storage scenarios plus isolated native recovery')
