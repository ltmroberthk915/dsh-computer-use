import fs from 'node:fs'

const sleeper = new Int32Array(new SharedArrayBuffer(4))
// The fixture publishes replaceable snapshots. A missing name during a replace
// is retriable; malformed JSON, denied access, and other I/O errors are not.
export function readJson (file, { timeoutMs = 100, read = fs.readFileSync,
  now = () => performance.now(), pause = ms => Atomics.wait(sleeper, 0, 0, ms) } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    try { return JSON.parse(read(file, 'utf8').replace(/^\uFEFF/, '')) }
    catch (error) {
      const remaining = deadline - now()
      if (error.code !== 'ENOENT' || remaining <= 0) throw error
      pause(Math.min(10, remaining))
    }
  }
}
