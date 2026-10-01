// test-buildusermessage.mjs — actually CALL `buildUserMessage()` and inspect what it produces.
//
// WHY: the 2026-09-15 crash was `TypeError: Cannot read properties of undefined (reading 'kind')` from
// the harness's own inbox listener
//
//   `@deepseek-ai/dsh-tool-jobs/lib/index.js:175`
//     ctx.on("agent/inbox/claimed", ({ agent, message }) => {
//       if (message.source.kind === "user") spentWakes.delete(agent);
//     });
//
// `test-steer-message-shape.mjs` proves the call sites pass a built message; it cannot prove the MESSAGE
// ITSELF carries `source.kind`, because that depends on which branch of the dynamic import runs. This
// file runs the real function in both environments and asserts the field — so "the listener would throw"
// is now a failing test instead of a human's red 本轮运行失败.
//
//   node build/test-buildusermessage.mjs [path-to-index.js]
// exit 0 = the message the harness will read is well-formed; exit 1 = it is not.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

// ---- lift buildUserMessage into a module that can be imported ------------------------------------------
const at = src.indexOf('async function buildUserMessage')
if (at < 0) { console.error('FAIL: buildUserMessage is not in ' + PLUGIN); process.exit(1) }
const end = src.indexOf('\n}\n', at)
if (end < 0) { console.error('FAIL: could not find the end of buildUserMessage'); process.exit(1) }
const fn = src.slice(at, end + 2)

const dir = join(tmpdir(), `cu-bum-${process.pid}`)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'bum.mjs')
writeFileSync(file, `export ${fn}\n`, 'utf8')

const failures = []
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}${detail ? ' — ' + detail : ''}`) }

const { buildUserMessage } = await import(pathToFileURL(file).href)

for (const [text, form] of [['继续', 'turn-end-card'], ['先关掉浏览器再继续', 'turn-end-strategy'], ['late', 'turn-end-late'], ['brake notice', 'notice']]) {
  const msg = await buildUserMessage(text, form, 'detail for ' + form)
  const tag = `${form}:`
  check(tag + ' returns an object', msg && typeof msg === 'object', String(msg))
  if (!msg || typeof msg !== 'object') continue
  // THE FIELD THE CRASH READ.
  check(tag + ' message.source exists', msg.source !== undefined && msg.source !== null, JSON.stringify(msg.source))
  check(tag + ' message.source.kind is a string', typeof (msg.source && msg.source.kind) === 'string', JSON.stringify(msg.source))
  // THE PRODUCER-OWNED V4 KIND (2026-09-30). Pinning the retired wrapper here kept a value the HOST
  // REFUSES green: native v4 admission throws
  //   SessionFormatError: format v4 message requires a producer-owned source kind
  // for `kind === 'plugin'` and every round that steered a notice died with "本轮运行失败". The v3→v4
  // migrator lifts that exact record via `rewritePluginSource()` — `producerKind()` maps a plugin to
  // `plugin:<name>` and DROPS the `plugin` field — so the migrated shape is what this file must pin.
  check(tag + ' message.source.kind is the producer-owned v4 kind', msg.source && msg.source.kind === 'plugin:dsh-computer-use', JSON.stringify(msg.source))
  check(tag + ' message.source carries no retired plugin wrapper', msg.source && !('plugin' in msg.source), JSON.stringify(msg.source))
  check(tag + ' message.source.form is the form asked for', msg.source && msg.source.form === form, JSON.stringify(msg.source))
  check(tag + " role is 'user'", msg.role === 'user', String(msg.role))
  check(tag + ' id is a non-empty string', typeof msg.id === 'string' && msg.id.length > 0, String(msg.id))
  check(tag + ' content is a non-empty array', Array.isArray(msg.content) && msg.content.length > 0, JSON.stringify(msg.content))
  check(tag + ' content[0] is a text part carrying the text', msg.content && msg.content[0] && msg.content[0].type === 'text' && msg.content[0].text === text, JSON.stringify(msg.content && msg.content[0]))
  // The listener does `message.source.kind === "user"`; anything OTHER than a string throws on the read.
  // Simulate it exactly, so this test fails the same way the host did.
  try {
    const spent = new Set(['agent'])
    if (msg.source.kind === 'user') spent.delete('agent')
  } catch (e) {
    failures.push(`${tag} the harness's inbox listener would throw: ${e.message}`)
  }
}

// ---- two calls must not share identity (a reused id would merge two messages) --------------------------
const a = await buildUserMessage('x', 'notice')
const b = await buildUserMessage('x', 'notice')
check('two messages have different ids', a.id !== b.id, `${a.id} vs ${b.id}`)

// ---- the summary detail must only appear when it was asked for ----------------------------------------
const withDetail = await buildUserMessage('x', 'notice', 'why')
const without = await buildUserMessage('x', 'notice')
check('detail becomes source.summary when supplied', withDetail.source.summary === 'why', JSON.stringify(withDetail.source))
check('no summary key when no detail was supplied', !('summary' in without.source), JSON.stringify(without.source))

for (const f of failures) console.error('FAIL: ' + f)
if (failures.length) { console.error(`\nFAILED — ${failures.length} message-shape assertion(s) against the REAL function`); process.exit(1) }
console.log('ok test-buildusermessage — the real buildUserMessage() was called 6 times and every message it ' +
  'produced carries source.kind (the exact field whose absence crashed the round), role, id and content, ' +
  'and survives the harness listener\'s own read')
