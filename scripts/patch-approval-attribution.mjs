import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const automaticReason = 'the request was automatically rejected without asking the user'
const channelReason = 'was rejected by the approval channel'

function replaceOnce (source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unsupported DSH tools source: missing or ambiguous patch anchor')
  return source.replace(before, after)
}

/** Patch the compiled DSH 0.2.1-rc.2 tool runtime; policy and audit stay unchanged. */
export function patchApprovalAttribution (source) {
  const start = source.indexOf('\tasync serviceAsk(exec, ask) {')
  const end = source.indexOf('\n\t/**', start)
  if (start < 0 || end < start) throw new Error('Unsupported DSH tools source: serviceAsk not found')
  const method = source.slice(start, end)
  const originalReason = '\t\t\t\t\treason: `the user rejected tool "${exec.name}"`'
  if (method.includes(automaticReason) && method.includes(channelReason) &&
      method.includes('const approvalPolicy = approval.effectivePolicy(exec.agent.session);') &&
      !method.includes(originalReason)) return { source, changed: false }
  let patched = replaceOnce(method,
    '\t\tconst outcome = await approval.request({',
    '\t\tconst approvalPolicy = approval.effectivePolicy(exec.agent.session);\n\t\tconst outcome = await approval.request({')
  patched = replaceOnce(patched, originalReason,
    '\t\t\t\t\treason: (approvalPolicy === "never"\n' +
    '\t\t\t\t\t\t? `tool "${exec.name}" requires approval, but approval prompts are disabled in this session (approval policy: never); the request was automatically rejected without asking the user`\n' +
    '\t\t\t\t\t\t: `approval for tool "${exec.name}" was rejected by the approval channel`) + (ask.reason ? `; approval required because: ${ask.reason}` : "")')
  // Replace the obsolete attribution comment; this also keeps the verified
  // compiled module small enough for a separate fixed-layout ASAR deployment.
  const docStart = source.lastIndexOf('\t/**\n\t* Resolve an `ask` decision', start)
  if (docStart < 0) throw new Error('Unsupported DSH tools source: expected serviceAsk documentation')
  const doc = '\t/**\n\t* Resolve asks through approval, retaining fail-closed behavior.\n\t* Snapshot policy before requesting: the never policy skips all answerers.\n\t* A channel rejection alone does not identify a human as its source.\n\t*/\n'
  return { source: source.slice(0, docStart) + doc + patched + source.slice(end), changed: true }
}

/** Preserve the original UTF-8 byte length, using trailing whitespace only. */
export function fixedLengthPayload (original, patched) {
  const size = Buffer.byteLength(original)
  const content = Buffer.from(patched)
  if (content.length > size) throw new Error('Patched source exceeds the original byte length')
  const output = Buffer.alloc(size, 0x20)
  content.copy(output)
  if (content.length < size) output[output.length - 1] = 0x0a
  return output
}

function main (args) {
  let input, output, fixedLength = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '--output') {
      const option = args[i], value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
      if (option === '--input') {
        if (input) throw new Error('Duplicate --input')
        input = path.resolve(value)
      } else {
        if (output) throw new Error('Duplicate --output')
        output = path.resolve(value)
      }
    } else if (args[i] === '--fixed-length') fixedLength = true
    else throw new Error(`Unknown option: ${args[i]}`)
  }
  if (!input) throw new Error('Usage: node scripts/patch-approval-attribution.mjs --input <extracted dsh-tools/lib/index.js> [--output <new file>] [--fixed-length]')
  if (output === input) throw new Error('--output must be a new file; installation replacement is a separate step')
  const original = fs.readFileSync(input, 'utf8')
  const patch = patchApprovalAttribution(original)
  const payload = fixedLength ? fixedLengthPayload(original, patch.source) : Buffer.from(patch.source)
  if (output) fs.writeFileSync(output, payload, { flag: 'wx' })
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  console.log(JSON.stringify({
    status: patch.changed ? 'patched' : 'already-patched',
    preview: !output,
    originalBytes: Buffer.byteLength(original), patchedBytes: payload.length,
    originalSha256: hash(Buffer.from(original)), patchedSha256: hash(payload),
  }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
