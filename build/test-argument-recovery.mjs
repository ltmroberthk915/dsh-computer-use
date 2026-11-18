import assert from 'node:assert/strict'
import { installArgumentRecovery } from '../lib/argument-recovery.js'

const handlers = new Map()
const names = new Set(['computer_click','computer_type'])
const notices = []
const session = {id:'one', requestHeader: () => ({tools:[{name:'computer_click'}]}),
  append(type, message, options) { assert.equal(type,'user/message'); assert.equal(options.surfaceOp,'append'); notices.push(message) }}
const controller = new AbortController()
const event = {agent:{session},turn:1,step:2,signal:controller.signal,
  failure:{code:'MALFORMED_RESPONSE',message:'Tool call "computer_click": invalid JSON\n\nReceived arguments:\nPRIVATE_UNPARSED_INPUT'}}
const fallback = () => 'delegated'
installArgumentRecovery({on:(name, listener)=>handlers.set(name,listener)}, names, async text=>text, r=>r.loop)
const recover = (patch={}) => handlers.get('agent/request-error')({...event,...patch},fallback)
const stream = (patch={}) => handlers.get('llm/stream')({sessionId:'one',signal:controller.signal,loop:true,...patch},fallback)

for(const failure of [{...event.failure,code:'ABORTED'}, {...event.failure,message:'upstream data malformed'},
  {...event.failure,message:event.failure.message.replace('computer_click','other_tool')},
  {...event.failure,message:event.failure.message.replace('computer_click','computer_type')}]){
  assert.equal(await recover({failure}),'delegated')
}
assert.equal(await recover({signal:AbortSignal.abort()}),'delegated')
assert.equal(notices.length,0)
assert.deepEqual(await recover(),{kind:'retry'})
assert.match(notices[0],/\{"at":"<screenX>,<screenY>"\}/)
assert.ok(!notices[0].includes('PRIVATE_UNPARSED_INPUT'))
assert.equal(stream(),'delegated')
assert.deepEqual(await recover(),{kind:'retry'})
assert.deepEqual(await recover(),{kind:'retry'})
assert.equal(stream({sessionId:'two'}),'delegated')
assert.equal(stream({loop:false}),'delegated')
assert.equal(stream({signal:new AbortController().signal}),'delegated')
const chunks = []
for await (const chunk of stream()) chunks.push(chunk)
assert.deepEqual(chunks.at(-1),{type:'finish',reason:{kind:'stop'}})
assert.ok(chunks.some(chunk=>chunk.type==='text-delta'&&chunk.text.includes('Windows Computer Use 插件')))
assert.equal(stream(),'delegated')
assert.deepEqual(await recover({step:3}),{kind:'retry'})
assert.equal(stream(),'delegated')
assert.deepEqual(await recover({step:4}),{kind:'retry'})
assert.deepEqual(await recover({step:5}),{kind:'retry'})
assert.equal(stream(),'delegated')
console.log('ok argument recovery: scoped, bounded, redacted, cancellable, next step resets and unrelated failures delegate')

