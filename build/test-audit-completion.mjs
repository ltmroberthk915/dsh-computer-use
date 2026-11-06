import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ComputerUse } from '../lib/core/index.js'
import { installAudit } from '../lib/audit.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-settled-'))
const cu = new ComputerUse({ dryRun: true })
const detach = installAudit(cu, { root })
await cu.withInputContext({ cycleId: 42 }, () => cu.actuate('type', { text: 'private-content' }))
const rows = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows.length, 2)
assert.equal(rows[0].phase, 'started'); assert.equal(rows[1].phase, 'settled')
assert.equal(rows[0].attemptId, rows[1].attemptId); assert.equal(rows[1].cycleId, 42)
assert.equal(rows[1].outcome, 'not-dispatched')
assert(!JSON.stringify(rows).includes('private-content'))
detach()
assert.equal(cu.listenerCount('action'), 0); assert.equal(cu.listenerCount('action:settled'), 0)
console.log('ok audit-completion: real writer persists correlated start/settlement and detaches')
