import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'win32') throw Error('This native request guard requires Windows')
const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'))
const { AttentionNative } = await import(pathToFileURL(path.join(root, 'lib/attention-native.js')))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-attention-request-'))
const before = process.env.LOCALAPPDATA
let attention
try {
  process.env.LOCALAPPDATA = path.join(scratch, 'local')
  // No executable exists at this unique path, so neither request can select or
  // raise a real window. Both still cross the real JS/native stdin/stdout boundary.
  attention = new AttentionNative({ exe: path.join(scratch, 'absent-host.exe'), hostPid: 0, dataDir: scratch })
  const results = await Promise.all(['probe', 'raise'].map(op => attention.request(op)))
  for (const result of results) {
    assert.equal(result.status, 'no-window')
    assert.equal(result.visible, false)
    assert.equal(result.focused, false)
    assert.match(result.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert(Number.isFinite(result.roundTripMs))
  }
  assert.notEqual(results[0].requestId, results[1].requestId)
  assert.equal(attention.pending.size, 0)
  const cleanup = await attention.request('cleanup')
  assert.equal(cleanup.status, 'cleanup-complete')
  await attention.close()
  const records = fs.readFileSync(attention.journal, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  for (const result of [...results, cleanup]) {
    assert.equal(records.find(record => record.id === result.requestId)?.result.status, result.status)
  }
  await assert.rejects(attention.request('probe'), /disposed/)
  console.log('ok attention-native: real probe/raise/cleanup round trips, unique IDs, native journal correlation, disposed refusal; no real window targeted')
} finally {
  await attention?.close()
  if (before === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = before
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
  assert(path.basename(scratch).startsWith('cu-attention-request-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
