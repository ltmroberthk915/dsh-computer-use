#!/usr/bin/env node
// @dsh/computer-use-mcp — MCP stdio server (stage-0)
//
// Zero-dependency MCP server (JSON-RPC 2.0 over stdio, one message per line)
// exposing the computer-use core. Implements the subset of the 2025-06-18
// spec a tools-only server needs: initialize / notifications/initialized /
// ping / tools/list / tools/call. Screenshots come back as MCP image content
// blocks; errors use isError:true so the model can self-correct.
//
// The launching host owns user authorization. Input is disabled unless it starts
// this server with DSH_CU_ALLOW_INPUT=1; no model-callable tool grants consent.
// DSH_CU_KILL=1 disables startup; DSH_CU_DRY_RUN=1 simulates permitted input.

// resolve the core package across layouts: installed dependency, sibling in
// node_modules (@dsh scope), or repo monorepo checkout (packages/*)
async function loadCore () {
  const candidates = ['../../lib/core/index.js']
  let lastErr
  for (const c of candidates) {
    try { return await import(c) } catch (e) { lastErr = e }
  }
  throw new Error(`cannot locate @dsh/computer-use-core (tried ${candidates.join(', ')}): ${lastErr && lastErr.message}`)
}
import { createToolQueue, continuationResult } from './execution.js'
import { createMcpToolSurface, renderMcpResult } from './tools.js'
import { actionError } from '../../lib/tool-contract.js'
import { readFileSync } from 'node:fs'
const { ComputerUse, humanContinuation } = await loadCore()

const PROTOCOL_VERSION = '2025-06-18'
const packageInfo = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const SERVER_INFO = { name: packageInfo.name + '-mcp', version: packageInfo.version }

if (process.env.DSH_CU_KILL === '1') {
  process.stderr.write('[dsh-computer-use] DSH_CU_KILL=1 — refusing to start\n')
  process.exit(1)
}

const allowInputDirect = process.env.DSH_CU_ALLOW_INPUT === '1'
const dryRun = process.env.DSH_CU_DRY_RUN === '1'
const cu = new ComputerUse({ dryRun })
const enqueueTool = createToolQueue()
const requests = new Map()

const { tools: TOOLS, run: runTool } = createMcpToolSurface(cu, { allowInput: allowInputDirect })

// ---------------- MCP plumbing ----------------
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handleLine(line)
  }
})
process.stdin.on('end', () => process.exit(0))

function send (obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

async function handleLine (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'notifications/cancelled') {
    requests.get(msg.params?.requestId)?.abort()
    return
  }
  if (msg.id === undefined) return // notification (initialized, cancelled) — no reply
  try {
    switch (msg.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } })
        break
      case 'ping':
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        break
      case 'tools/list':
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
        break
      case 'tools/call': {
        const name = msg.params && msg.params.name
        const args = (msg.params && msg.params.arguments) || {}
        const controller = new AbortController()
        requests.set(msg.id, controller)
        try {
          const value = await enqueueTool(() =>
            cu.withInputContext({ signal: controller.signal }, () => runTool(name, args, { signal: controller.signal })), controller.signal)
          send({ jsonrpc: '2.0', id: msg.id, result: renderMcpResult(name, args, value) })
        } catch (e) {
          const checkpoint = !controller.signal.aborted && !cu.stopped && !cu.exited
            ? continuationResult(e, humanContinuation) : null
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text',
            text: JSON.stringify(checkpoint || actionError(e)) }], isError: !checkpoint } })
        } finally { requests.delete(msg.id) }
        break
      }
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } })
  }
}

process.stderr.write(`[dsh-computer-use] mcp server up (allowInput=${allowInputDirect} dryRun=${dryRun})\n`)
