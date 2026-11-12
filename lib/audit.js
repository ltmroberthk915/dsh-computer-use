// audit.js — snapshot paths + JSONL audit trail for dsh-computer-use.
// Every actuation the core emits lands here: {ts, op, args(redacted), result?|error?}.
// Screenshots taken before risky ops (v1) will join the same stream.

import { appendFileSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function mkDataDir (configured) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = configured && configured.length > 0
    ? configured
    : join(dshHome, 'data', 'computer-use')
  const shots = join(dir, 'shots')
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true })
  return { root: dir, shots }
}

export function snapshotPath (dataDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const ms = Date.now() % 1000
  return join(dataDir.shots, `shot-${ts}-${ms}-${randomUUID()}.jpg`)
}

export function appendAudit (dataDir, rec) {
  try {
    appendFileSync(join(dataDir.root, 'audit.jsonl'), JSON.stringify(rec) + '\n')
  } catch { /* audit must never break the action */ }
}

export function installAudit (cu, dataDir) {
  const events = ['action', 'action:settled', 'handoff-wait']
  const write = record => appendAudit(dataDir, record)
  for (const event of events) cu.on(event, write)
  return () => { for (const event of events) cu.off(event, write) }
}

// ---- gate diagnostics: WHO asked, WHO could have answered, WHAT was decided ------------------
// A separate stream from audit.jsonl on purpose: the actuation audit must keep its shape, and a
// policy question must stay answerable from a file the next report can attach. One line per
// gated call that reaches the decision (the procedure-gate deny and `acknowledge` return earlier
// by design), written after the decision, never containing typed text or clipboard contents.
// Bounded: past GATE_ROTATE_BYTES the stream becomes policy.jsonl.1 and a fresh file starts.
const GATE_ROTATE_BYTES = 4 * 1024 * 1024
export function appendGate (dataDir, rec) {
  if (!dataDir || typeof dataDir.root !== 'string') return
  try {
    const file = join(dataDir.root, 'policy.jsonl')
    try {
      if (existsSync(file) && statSync(file).size > GATE_ROTATE_BYTES) renameSync(file, `${file}.1`)
    } catch { /* a failed rotation must not lose the record we are about to append */ }
    appendFileSync(file, JSON.stringify(rec) + '\n')
  } catch { /* diagnostics must never break the decision */ }
}

// A launch target may be a URL carrying userinfo or a query token. The gate records and logs
// run through here, so neither the log line nor policy.jsonl can become a credential store.
const URL_SHAPE = /^([a-z][a-z0-9+.\-]*:\/\/)([^/?#]*)([^?#]*)([?#][\s\S]*)?$/i
function redactUrl (url) {
  const match = URL_SHAPE.exec(url)
  if (!match) return url
  const authority = match[2].includes('@') ? match[2].slice(match[2].lastIndexOf('@') + 1) : match[2]
  const tail = match[4] === undefined ? '' : (match[4][0] === '?' ? '?<redacted>' : '#<redacted>')
  return `${match[1]}${authority}${match[3]}${tail}`
}
export function redactTarget (value) {
  if (typeof value !== 'string') return value
  return redactUrlTokens(value.slice(0, 400)).slice(0, 120)
}
/** Redact every URL-shaped token in free text: a target can embed one ("cmd https://u:p@h/?t=1"),
 *  and a decision reason quotes the target. */
const redactUrlTokens = (text) => text.replace(/[a-z][a-z0-9+.\-]*:\/\/[^\s"'<>)\]]+/gi, (token) => redactUrl(token))
export function redactReasonText (value) {
  return typeof value === 'string' ? redactUrlTokens(value) : value
}

const GATE_ARG_KEYS = new Set(['combo', 'op', 'action', 'target', 'hwnd', 'button', 'clicks',
  'allowPassword', 'holdMs', 'mark', 'at', 'from', 'to', 'dir', 'lines', 'x', 'y', 'deltaX', 'deltaY'])

/** Argument summary safe to persist: identities, coordinates and lengths, never payload text.
 *  Every string goes through the URL redaction, so a URL stuffed into a coordinate field cannot
 *  smuggle credentials into the diagnostics either. */
export function gateArgSummary (name, args) {
  const a = args || {}
  const out = {}
  for (const key of Object.keys(a)) {
    if (!GATE_ARG_KEYS.has(key)) continue
    const value = a[key]
    if (key === 'target') out.target = redactTarget(value)
    else if (typeof value === 'string') out[key] = redactUrlTokens(value).slice(0, 120)
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  if (name === 'computer_type' && typeof a.text === 'string') out.textLength = a.text.length
  if (name === 'computer_batch' && Array.isArray(a.actions)) out.steps = a.actions.length
  return out
}

