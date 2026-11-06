import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { workerReferences } from '../lib/core/native-runtime.js'
import { requirePrivateDesktop } from './private-desktop-test.mjs'
requirePrivateDesktop(import.meta.filename)
const dir=path.dirname(process.env.DSH_HOME), exe=path.join(dir,'fault-fixture.exe')
execFileSync(path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),[
  '/nologo','/target:exe','/platform:x64','/main:NativeFaultLifecycleFixture','/out:'+exe,
  ...workerReferences().map(ref=>'/r:'+ref),path.resolve(import.meta.dirname,'../lib/core/worker.cs'),
  path.join(import.meta.dirname,'native-fault-lifecycle-fixture.cs')],{windowsHide:true,timeout:30000})
const children=[]
const launch=async mode=>{
  const child=spawn(exe,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child)
  const lines=createInterface({input:child.stdout}), ended=once(child,'exit')
  let stderr='';child.stderr.on('data',b=>{stderr+=b})
  const next=()=>Promise.race([once(lines,'line').then(([s])=>JSON.parse(s)),ended.then(()=>{throw Error('fixture exited: '+stderr)})])
  return {child,ended,next,ready:await next()}
}
try{
  const normal=await launch('hold');assert.equal(normal.ready.data.owned,1)
  const blocked=await launch('fresh');assert.equal(blocked.ready.data.acquired,false);await blocked.ended
  const release=normal.next();normal.child.stdin.end('release\n')
  const receipt=await release;assert.deepEqual(receipt.data,{released:1,owned:0,lease:false,sends:2});await normal.ended
  const crash=await launch('hold');assert.equal(crash.ready.data.owned,1)
  crash.child.kill();await crash.ended
  const fresh=await launch('fresh');assert.equal(fresh.ready.data.acquired,true);assert.equal(fresh.ready.data.owned,0)
  assert.equal(fresh.ready.data.sends,0,'fresh process must not invent global key-ups');assert.notEqual(fresh.ready.data.generation,crash.ready.data.generation);await fresh.ended
  const boundaries=execFileSync(exe,['boundaries'],{windowsHide:true,encoding:'utf8',timeout:15000}).trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(boundaries.length,2);assert(boundaries.every(row=>row.data.nativeInput===false))
  console.log(JSON.stringify({passed:5,nativeInput:false,privateDesktop:true,normalRelease:'owned ledger and lease released',
    hardKill:'real process terminated; OS lease reacquired; process-local ledger empty; zero invented releases',
    osInputAfterKill:'unknown — fake InputSender does not measure OS key state',boundaries}))
}finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill()
}
