import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {ComputerUse} from '../lib/core/index.js';

const root=path.join(import.meta.dirname,'handoff-evidence');fs.mkdirSync(root,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-handoff-owned-'));
const source=path.resolve(import.meta.dirname,'../lib/core/worker.cs');
const win=process.env.WINDIR||'C:/Windows',gac=path.join(win,'Microsoft.NET/assembly/GAC_MSIL');
const refs=['System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Windows.Forms.dll',...['UIAutomationClient','UIAutomationTypes','WindowsBase'].map(n=>path.join(gac,n,'v4.0_4.0.0.0__31bf3856ad364e35',n+'.dll'))];
const exe=path.join(dir,'fixture.exe');
try { execFileSync(path.join(win,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/main:HumanHandoffFixture','/out:'+exe,...refs.map(r=>'/r:'+r),source,path.join(import.meta.dirname,'human-handoff-fixture.cs')],{windowsHide:true,timeout:30000,encoding:'utf8'}); }
catch(error){console.error(error.stdout,error.stderr);throw error}
const native=JSON.parse(execFileSync(exe,[],{windowsHide:true,timeout:15000,encoding:'utf8',env:{...process.env,DSH_HOME:path.join(dir,'home'),DSH_COMPUTER_USE_STOP_FILE:path.join(dir,'STOP'),DSH_COMPUTER_USE_EXIT_FILE:path.join(dir,'EXITED'),DSH_COMPUTER_USE_AUDIT_LOG:path.join(dir,'audit.log')}}));
assert.equal(native.passed,18);
const js=[];
const fresh=()=>new ComputerUse({workerExe:'X:/NOT-STARTED.exe'});
const event=(cu,phase,revision=1)=>cu.onLine(JSON.stringify({event:'handoff',cooperation:{phase,active:phase!=='idle',revision}}));
const test=async(name,fn)=>{await fn();js.push(name)};
const tick=()=>new Promise(r=>setImmediate(r));
await test('handoff is separate from manual pause; caches invalidated',async()=>{
 const cu=fresh();cu.lastMarks=[{id:'M1'}];cu.maps.set('77',{});event(cu,'yielding');
 assert.equal(cu.stopped,false);assert.equal(cu.exited,false);assert.equal(cu.cooperation.active,true);assert.equal(cu.lastMarks.length,0);assert.equal(cu.maps.size,0);
});
await test('local wait ends with re-observation; zero model or native polling',async()=>{
 const cu=fresh();event(cu,'waiting');let calls=0;cu.call=async()=>{calls++};
 const p=cu.actuate('key',{combo:'enter'});let settled=false;p.catch(()=>{settled=true});await tick();assert.equal(settled,false);assert.equal(calls,0);
 event(cu,'idle');await assert.rejects(p,e=>e.code==='HUMAN_REOBSERVE'&&e.outcome==='not-dispatched');assert.equal(calls,0);assert.equal(cu.rateWindow.length,0);
});
for(const outcome of ['unknown','not-dispatched'])await test('interrupted action waits then requires readback without replay: '+outcome,async()=>{
 const cu=fresh(),calls=[];cu.call=async(op)=>{calls.push(op);if(op==='ping'){event(cu,'waiting');return {pong:true}}throw Object.assign(new Error('physical input'),{code:'HUMAN_YIELD',outcome})};
 const p=cu.actuate('type',{text:'do not duplicate'});p.catch(()=>{});await tick();assert.deepEqual(calls,['type','ping']);
 event(cu,'idle');await assert.rejects(p,e=>e.code==='HUMAN_REOBSERVE'&&e.outcome===outcome);assert.deepEqual(calls,['type','ping']);
});
await test('Ctrl+Esc manual pause supersedes automatic wait',async()=>{
 const cu=fresh();event(cu,'yielding');const p=cu.waitForHuman();p.catch(()=>{});
 cu.onLine(JSON.stringify({event:'panic',why:'Ctrl+Esc chord detected'}));await assert.rejects(p,e=>e.code==='ABORTED');event(cu,'idle');assert.equal(cu.stopped,true);
});
await test('exit, cancellation and worker death settle waits without leaked listeners',async()=>{
 for(const type of ['exit','cancel','dead','signal']){
  const cu=fresh(),controller=new AbortController();event(cu,'waiting');
  const p=cu.withInputContext({signal:controller.signal},()=>cu.waitForHuman());p.catch(()=>{});
  if(type==='exit')cu.onLine(JSON.stringify({event:'exit'}));else if(type==='cancel')cu.cancelInputs();else if(type==='dead')cu.onWorkerExit(1);else controller.abort();
  await assert.rejects(p);for(const name of ['handoff','panic','ask','exit','dead','input-cancel'])assert.equal(cu.listenerCount(name),0);
 }
});
await test('stale idle event cannot steal back physical ownership',async()=>{
 const cu=fresh();event(cu,'yielding',10);event(cu,'idle',9);assert.equal(cu.cooperation.active,true);
 event(cu,'idle',10);assert.equal(cu.cooperation.active,false);
});
await test('cancel targets exactly its pending native request and reports unknown effect',async()=>{
 const cu=fresh(),writes=[],controller=new AbortController();cu.ensureWorker=async()=>{};
 cu.proc={stdin:{write(line){const x=JSON.parse(line);writes.push(x);if(x.op==='cancelInput')queueMicrotask(()=>cu.onLine(JSON.stringify({id:x.id,ok:true,data:{cancelled:true}})))}}};
 const p=cu.withInputContext({signal:controller.signal},()=>cu.call('type',{text:'abc'}));p.catch(()=>{});await tick();controller.abort();
 await assert.rejects(p,e=>e.code==='INPUT_CANCELLED'&&e.outcome==='unknown');await tick();
 assert.equal(writes.length,2);assert.equal(writes[1].op,'cancelInput');assert.equal(writes[1].args.requestId,writes[0].id);assert.equal(cu.pending.size,0);
});
await test('already cancelled scope sends no input',async()=>{
 const cu=fresh(),controller=new AbortController();controller.abort();cu.ensureWorker=()=>{throw new Error('must not start')};
 await assert.rejects(cu.withInputContext({signal:controller.signal},()=>cu.call('key',{})),e=>e.code==='INPUT_CANCELLED'&&e.outcome==='not-dispatched');
});
const result={at:new Date().toISOString(),sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),native,js:{passed:js.length,cases:js},artifacts:dir};
fs.writeFileSync(path.join(root,'logic.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
