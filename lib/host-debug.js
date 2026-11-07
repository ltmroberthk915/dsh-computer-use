// host-debug.js — the two gates that decide whether the agent may drive its OWN Harness window.
//
// WHY THIS EXISTS
// The host guard refuses every driving op aimed at the DSH window. That is right for ordinary
// work (the agent must never approve its own approvals, type as the human, or press Stop), but it
// also makes self-iteration — debugging another plugin inside the same instance — impossible.
// The answer is not to weaken the default; it is an explicit DEBUG MODE with two gates:
//
//   1. the CALLING CONVERSATION has full permission: its sandbox mode is danger-full-access;
//   2. debug mode was switched on BY HAND in Settings → 电脑操控（调试）.
//
// Neither gate can be turned on from inside a tool call: gate 1 is the session's own policy (the
// human sets it in the composer) and gate 2 is a host-side file that only the settings page
// writes. Tools can read both; they cannot write either.
//
// SETTINGS PAGE CONTRACT (host side):
//   GET  /api/computer-use/host-debug  -> { enabled, since, session:{id,sandbox,fullAccess}, lastBlockedAt }
//   POST /api/computer-use/host-debug  -> { enabled: boolean }  (writes the file, returns the same shape)
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dshHome = () => process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')

/** Where the debug switch lives. Deliberately NOT inside any profile: one machine, one switch. */
export const HOST_DEBUG_FILE = () => path.join(dshHome(), 'data', 'computer-use', 'host-debug.json')

function readJson (file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Hot read; the worker also polls this file (500 ms cache) so a toggle needs no restart. */
export function readHostDebug () {
  const j = readJson(HOST_DEBUG_FILE())
  if (!j || typeof j !== 'object') return { enabled: false, since: null, lastBlockedAt: null }
  return {
    enabled: j.enabled === true,
    since: typeof j.since === 'string' ? j.since : null,
    lastBlockedAt: typeof j.lastBlockedAt === 'string' ? j.lastBlockedAt : null,
  }
}

export function writeHostDebug (enabled) {
  const file = HOST_DEBUG_FILE()
  mkdirSync(path.dirname(file), { recursive: true })
  const previous = readHostDebug()
  const next = {
    enabled: enabled === true,
    since: enabled === true ? (previous.enabled ? previous.since : new Date().toISOString()) : null,
    lastBlockedAt: previous.lastBlockedAt,
  }
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** Record that a host-driving call was refused by a gate, so the settings page can say so. */
export function noteHostBlocked () {
  try {
    const file = HOST_DEBUG_FILE()
    const current = readHostDebug()
    if (!existsSync(file)) return
    writeFileSync(file, JSON.stringify({ ...current, lastBlockedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  } catch { /* a failed note must never break the refusal itself */ }
}

const SESSION_ROOTS = () => [
  path.join(dshHome(), 'storages', 'session_projcache', 'sessions'),
  path.join(dshHome(), 'storages', 'sessions'),
  path.join(dshHome(), 'sessions'),
]

/** The session record is a live cache under DSH_HOME; find the one for this id (cheap, per call). */
function sessionRecord (sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  for (const root of SESSION_ROOTS()) {
    const file = path.join(root, `${sessionId}.json`)
    if (existsSync(file)) return readJson(file)
  }
  return null
}

/** Gate 1: does the CALLING conversation hold full permission? Unknown => false (fail closed). */
export function sessionPermission (sessionId) {
  const rec = sessionRecord(sessionId)
  const rows = rec?.record?.rows
  const sandbox = rows?.permissions?.val?.sandbox || rows?.sandboxMode?.val || null
  const approval = rows?.permissions?.val?.approval || rows?.approvalState?.val?.policy || null
  return { id: sessionId || null, sandbox, approval, fullAccess: sandbox === 'danger-full-access' }
}
