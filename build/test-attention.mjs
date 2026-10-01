import test from 'node:test'
import assert from 'node:assert/strict'
import { installHumanAttention } from '../lib/attention.js'

const tick = () => new Promise(r => setTimeout(r, 8))
function fixture ({ late = false, show, probe, result, fail = false, retryMs = 25 } = {}) {
  const root = new Map(), child = new Map(), logs = [], calls = [], records = []
  let injected, shown = 0, closed = false, failures = fail
  const native = {
    async start () {}, log (r) { records.push(r) }, async close () { closed = true },
    async request (op) { calls.push(op); if(op === 'probe') return probe || { focused: false, sampledVisible: false };
      if(failures) throw Error('native unavailable');
      return result || { visible: true, focused: false, status: 'visible-without-focus', flash: 'requested-unverified' }
    },
  }
  const desktop = { desktopRuntime: { show () { shown++; return show?.() } }, on (n,f,o) { child.set(n,{f,o}) } }
  const ctx = { inject (deps, fn) { assert.deepEqual(deps,['desktopRuntime']); injected=fn; if(!late) fn(desktop) }, on(n,f,o) { root.set(n,{f,o}) } }
  const raise = installHumanAttention(ctx,{ info: x=>logs.push(x), warn: x=>logs.push(x) }, { native, retryMs })
  const approval = (id, type='approval/asked', toolName='edit', side=child) => side.get('session/event').f('session-A',{ type, data:{id,toolName} })
  const question = (request, next=()=>new Promise(()=>{}), side=child) => side.get('user-questions/request').f(request,next)
  return { root, child, logs, calls, records, raise, approval, question, inject:()=>injected(desktop),
    get shown(){return shown}, get closed(){return closed}, setFail(v){failures=v}, dispose:()=>child.get('dispose').f() }
}

test('late service injection supplies a callable; unavailable service reports failure',async()=>{
  const f=fixture({late:true}); assert.equal(await f.raise('before','turn end'),false); f.inject();
  assert.equal(await f.raise('after','turn end'),true); f.dispose()
})
test('question waterfall is prepended on both contexts; its answer is preserved',async()=>{
  const f=fixture(); for(const side of [f.root,f.child]) assert.equal(side.get('user-questions/request').o.prepend,true)
  let answer; const promise=new Promise(r=>{answer=r}); const got=f.question({questions:[{id:'user-question'}]},()=>promise)
  assert.equal(got,promise); await tick(); assert.equal(f.shown,1); answer('human answer'); assert.equal(await got,'human answer'); f.dispose()
})
test('duplicate deliveries share the result, different cards each raise, anonymous cards do not collide',async()=>{
  const f=fixture(); const q={questions:[{id:'q1'}]}; f.question(q); f.question(q,undefined,f.root)
  f.question({questions:[{id:'q2'}]}); f.question({questions:[{}]}); f.question({questions:[{}]});
  await tick(); assert.equal(f.shown,4); f.dispose()
})
test('file, sandbox escalation and computer approvals use the same attention path',async()=>{
  const f=fixture(); f.approval('file'); f.approval('file','approval/asked','edit',f.root)
  f.approval('sandbox','approval/asked','exec_command'); f.approval('computer','approval/asked','computer_batch');
  await tick(); assert.equal(f.shown,3); f.dispose()
})
test('focus denied but visibility confirmed is success; it is explicitly logged as unfocused',async()=>{
  const f=fixture(); assert.equal(await f.raise('card','question'),true)
  const r=f.records.find(x=>x.stage==='raise-result'); assert.equal(r.focused,false); assert.equal(r.visible,true); assert.equal(r.within1s,true); f.dispose()
})
test('API success and a flash request cannot substitute for measured visibility',async()=>{
  const f=fixture({ result:{visible:false,focused:false,foregroundApi:true,topmostApi:true,flash:'requested-unverified',status:'not-visible'} })
  assert.equal(await f.raise('card','question'),false); assert.equal(await f.raise('card','question'),false)
  assert.equal(f.shown,2); f.dispose()
})
test('a focused window hidden by an overlay still requires visibility fallback',async()=>{
  const f=fixture({probe:{focused:true,sampledVisible:false}}); await f.raise('x','question'); assert.equal(f.shown,1); f.dispose()
})
test('already visible and focused is a measured no-op',async()=>{
  const f=fixture({probe:{focused:true,sampledVisible:true}}); assert.equal(await f.raise('x','question'),true)
  assert.equal(f.shown,0); assert.deepEqual(f.calls,['probe']); f.dispose()
})
test('throwing, rejected and hanging host show cannot prevent independent fallback',async()=>{
  for(const show of [()=>{throw Error('sync')},()=>Promise.reject(Error('async')),()=>new Promise(()=>{})]) {
    const f=fixture({show}); assert.equal(await f.raise('x','question'),true); assert.ok(f.calls.includes('raise')); f.dispose()
  }
})
test('native error is recorded and a later delivery can succeed',async()=>{
  const f=fixture({fail:true}); assert.equal(await f.raise('x','question'),false); f.setFail(false)
  assert.equal(await f.raise('x','question'),true); assert.ok(f.records.some(x=>x.status==='error'&&x.error.includes('native unavailable'))); f.dispose()
})
test('a failed pending approval retries once; a decision cancels the retry',async()=>{
  const f=fixture({fail:true}); f.approval('a'); await new Promise(r=>setTimeout(r,80)); assert.equal(f.shown,2); f.dispose()
  const g=fixture({fail:true}); g.approval('b'); await tick(); g.approval('b','approval/decided'); await new Promise(r=>setTimeout(r,60)); assert.equal(g.shown,1); g.dispose()
})
test('answering a question cancels pending retry and dispose closes the helper',async()=>{
  const f=fixture({fail:true}); let answer; f.question({questions:[{id:'q'}]},()=>new Promise(r=>{answer=r}))
  await tick(); answer(); await new Promise(r=>setTimeout(r,60)); assert.equal(f.shown,1)
  f.dispose(); await tick(); assert.equal(f.closed,true); assert.equal(await f.raise('late','turn end'),false)
})
test('same question IDs in separate requests cannot suppress another session',async()=>{
  const f=fixture(); f.question({questions:[{id:'confirm'}]}); f.question({questions:[{id:'confirm'}]})
  await tick(); assert.equal(f.shown,2); f.dispose()
})
test('after both attempts fail, a fresh approval delivery remains retryable',async()=>{
  const f=fixture({fail:true}); f.approval('a'); await new Promise(r=>setTimeout(r,80)); assert.equal(f.shown,2)
  f.setFail(false); f.approval('a'); await tick(); assert.equal(f.shown,3); f.dispose()
})
test('a question answered while probing cannot cause a late raise',async()=>{
  const f=fixture(); f.question({questions:[{id:'already-answered'}]},()=> 'answer')
  await tick(); assert.equal(f.shown,0); f.dispose()
})
test('official Desktop without desktopRuntime installs immediately and raises through native helper',async()=>{
  const handlers=new Map(), records=[], calls=[]
  const native={async start(){},log:r=>records.push(r),async close(){},async request(op){calls.push(op);return op==='probe'?{focused:false,sampledVisible:false}:{visible:true,focused:true,status:'foreground'}}}
  const ctx={inject(){throw Error('official host must not wait for missing service')},get(){return undefined},get desktopRuntime(){throw Error('service is not registered')},on(n,f){handlers.set(n,f)}}
  const raise=installHumanAttention(ctx,{info(){},warn(){}},{native,nativeHost:true})
  assert.ok(handlers.has('user-questions/request')); assert.ok(handlers.has('session/event'))
  assert.equal(await raise('turn-end','decision card'),true); assert.deepEqual(calls,['probe','raise'])
  assert.equal(records.find(r=>r.stage==='installed').hostMode,'official-desktop-native')
  assert.equal(records.find(r=>r.stage==='raise-result').show,'unavailable-native-fallback');handlers.get('dispose')()
})
