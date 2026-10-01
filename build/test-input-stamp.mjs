// A guard that exists because the same bug landed twice in one night: a path that injects input but
// forgets `dwExtraInfo = OwnMagic`. The worker's own monitors then read the agent's input as the
// human's and brake the session, and the STOP file names the human. Text-only, but it pins the two
// senders that matter, and it can fail.
import fs from 'node:fs'
import path from 'node:path'

const W = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const src = fs.readFileSync(W, 'utf8')
// The FACT is "this INPUT carries the signature". `OwnMagic` alone is correct inside the Panic class
// (MouseInput lives there); `Panic.OwnMagic` is required from Program (SendMouse). Accept both — an
// earlier version of this guard demanded the qualified spelling everywhere and produced a false
// positive on the very function that had always been correct.
const STAMP_RE = /dwExtraInfo\s*=\s*(Panic\.)?OwnMagic/
const failures = []

/** the body of a C# method, by brace counting from its opening brace (no indentation guessing) */
function body (text, signature) {
  const i = text.indexOf(signature)
  if (i < 0) return null
  const open = text.indexOf('{', i)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(open, j + 1) }
  }
  return null
}

const SENDERS = [
  ['static void SendMouse', 'SendMouse'],
  ['static INPUT MouseInput', 'MouseInput'],
]
for (const [sig, name] of SENDERS) {
  const b = body(src, sig)
  if (b === null) { failures.push(`cannot locate ${name}() — did it get renamed?`); continue }
  if (!STAMP_RE.test(b)) failures.push(`${name}() injects input WITHOUT a dwExtraInfo = [Panic.]OwnMagic stamp — its events are read as the human's and trip the takeover brake`)
}
if (!/SendKey[\s\S]{0,400}?dwExtraInfo = Panic\.OwnMagic/.test(src)) {
  failures.push('the keyboard sender no longer stamps OwnMagic')
}

// the guard must be able to fail: delete the stamp, the SendMouse check has to go red
const broken = src.replace('inp.u.mi.dwExtraInfo = Panic.OwnMagic;', '')
const bb = body(broken, 'static void SendMouse')
let fired = false
if (bb !== null && !STAMP_RE.test(bb)) fired = true
if (!fired) failures.push('self-test FAILED: removing the stamp from SendMouse did not trip this guard')

if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  console.log('FAIL test-input-stamp')
  process.exit(1)
}
console.log('ok test-input-stamp — SendMouse / MouseInput / the keyboard sender all stamp dwExtraInfo = Panic.OwnMagic; deleting the stamp is caught by the self-test')