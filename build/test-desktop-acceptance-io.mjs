import assert from 'node:assert/strict'
import { readJson } from './desktop-acceptance-io.mjs'

let clock = 0, attempts = 0
const enoent = Object.assign(new Error('snapshot replacing'), { code: 'ENOENT' })
const timing = { now: () => clock, pause: ms => { clock += ms } }
assert.deepEqual(readJson('fixture', { ...timing, read: () => {
  attempts++; if (attempts < 4) throw enoent; return '\uFEFF{"nonce":"fixture"}'
} }), { nonce: 'fixture' })
assert.equal(clock, 30); assert.equal(attempts, 4)
clock = attempts = 0
assert.throws(() => readJson('missing', { ...timing, read: () => { attempts++; throw enoent } }), error => error === enoent)
assert.equal(clock, 100); assert.equal(attempts, 11)
for (const failure of [Object.assign(new Error('denied'), { code: 'EACCES' }), new SyntaxError('bad snapshot')]) {
  clock = attempts = 0
  assert.throws(() => readJson('invalid', { ...timing, read: () => { attempts++; throw failure } }), error => error === failure)
  assert.equal(clock, 0); assert.equal(attempts, 1)
}
assert.throws(() => readJson('json', { read: () => '{not json}' }), SyntaxError)
console.log('ok desktop-acceptance-io: only ENOENT retries, successful replacement recovers, 100ms bound, other I/O/JSON errors fail immediately; no worker/input')
