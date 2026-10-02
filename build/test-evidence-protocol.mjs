import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'
const cu=new ComputerUse({workerExe:'X:/NOT-STARTED.exe'});let checks=0
for(const [extra,code,outcome] of [
 [{code:'TYPE_FOCUS_NOT_EDITABLE',outcome:'not-dispatched'},'TYPE_FOCUS_NOT_EDITABLE','not-dispatched'],
 [{code:'TARGET_STALE',outcome:'not-dispatched'},'TARGET_STALE','not-dispatched'],
 [{code:'HUMAN_POINTER_ACTIVE',outcome:'not-dispatched'},'HUMAN_POINTER_ACTIVE','not-dispatched'],
 [{},'worker-refusal-or-error','unknown'],
 [{outcome:'success'},'worker-refusal-or-error','unknown'],
]){
 const promise=new Promise((resolve,reject)=>cu.pending.set(7,{op:'type',resolve,reject}))
 cu.onLine(JSON.stringify({id:7,ok:false,error:'fixture refusal',...extra}))
 await assert.rejects(promise,e=>e.code===code&&e.outcome===outcome&&e.requestId===7)
 assert.equal(cu.pending.size,0);checks++
}
for(const changed of ['sig','hwnd','pid','x']){
 let reads=0;const first={sig:'A',hwnd:10,pid:20,region:{x:0,y:0,width:800,height:600}}
 cu.frameSig=async()=>{const f=structuredClone(first);if(reads++>0){if(changed==='x')f.region.x=1;else f[changed]=changed==='sig'?'B':99}return f}
 cu.call=async()=>({flat:[],truncated:false})
 await assert.rejects(cu.landmarks({refresh:true}),e=>e.code==='STALE_MARK'&&e.message.includes(changed==='sig'?'sampled-frame-signature':changed==='x'?'region.x':changed))
 checks++
}
const defs=new Map(),seen=[]
cu.waitStable=async a=>{seen.push(['stable',a]);return {stable:true}}
cu.waitChange=async a=>{seen.push(['change',a]);return {changed:false}}
registerTools({ctx:{tools:{register:d=>defs.set(d.name,d)}},cu,config:{},dataDir:{root:'X:/NOT-USED',shots:'X:/NOT-USED'},log:{warn(){}},snapshotPath:()=>{throw Error('unexpected screenshot')},defineTool:d=>d})
for(const mode of ['stable','change']){
 const args={mode,hwnd:123,timeoutMs:400}
 await defs.get('computer_wait').execute(args,{})
 await defs.get('computer_batch').execute({actions:[{tool:'computer_wait',args}],shot:'never'},{})
 assert.deepEqual(seen.at(-1),seen.at(-2));assert.equal(seen.at(-1)[1].hwnd,123);checks++
}
console.log('ok test-evidence-protocol — '+checks+' refusal, diagnostic and wait dispatch checks')
