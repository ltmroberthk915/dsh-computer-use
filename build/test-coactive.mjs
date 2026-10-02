import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {ComputerUse} from '../lib/core/index.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-coactive-owned-'));
const source=path.join(import.meta.dirname,'../lib/core/worker.cs');
const fixture=path.join(import.meta.dirname,'coactive-fixture.cs');
const win=process.env.WINDIR||'C:/Windows',gac=path.join(win,'Microsoft.NET/assembly/GAC_MSIL');
const refs=['System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Windows.Forms.dll',...['UIAutomationClient','UIAutomationTypes','WindowsBase'].map(n=>path.join(gac,n,'v4.0_4.0.0.0__31bf3856ad364e35',n+'.dll'))];
const exe=path.join(dir,'probe.exe');
try {
 execFileSync(path.join(win,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/main:CoactiveFixture','/out:'+exe,...refs.map(r=>'/r:'+r),source,fixture],{windowsHide:true,timeout:30000,encoding:'utf8'});
 const raw=execFileSync(exe,[],{windowsHide:true,timeout:15000,encoding:'utf8',env:{...process.env,DSH_HOME:path.join(dir,'home'),DSH_COMPUTER_USE_STOP_FILE:path.join(dir,'STOP'),DSH_COMPUTER_USE_EXIT_FILE:path.join(dir,'EXITED'),DSH_COMPUTER_USE_AUDIT_LOG:path.join(dir,'audit.jsonl')}});
 const result=JSON.parse(raw);assert(result.assertions>=65);assert(result.cases.filter(r=>'pass'in r).every(r=>r.pass));
 const text=fs.readFileSync(source,'utf8');
 assert.match(text,/KeyboardChord.Run\(vks, SendKey, ReleaseKeyForCleanup/);
 assert.match(text,/if \(!lease.StillOwned\(\)\)/);
 assert.match(text,/finally\s*\{[\s\S]*?restore = lease.Restore\(\)/);
 // Owned-key cleanup is behavior-tested in test-human-handoff; its old direct
 // SendInput implementation is intentionally replaced by the ownership ledger.
 result.workerSha256=crypto.createHash('sha256').update(text).digest('hex');result.at=new Date().toISOString();result.artifacts=dir;
 const cases=[
  {name:'auto-preservation-refusal',opts:{},code:'CLIPBOARD_PRESERVATION_UNAVAILABLE',outcome:'not-dispatched',fallback:true},
  {name:'explicit-auto-preservation-refusal',opts:{mode:'auto'},code:'CLIPBOARD_PRESERVATION_UNAVAILABLE',outcome:'not-dispatched',fallback:true},
  {name:'explicit-paste-no-fallback',opts:{mode:'paste'},code:'CLIPBOARD_PRESERVATION_UNAVAILABLE',outcome:'not-dispatched'},
  {name:'unknown-paste-no-replay',opts:{},code:'CLIPBOARD_PRESERVATION_UNAVAILABLE',outcome:'unknown'},
  {name:'concurrent-copy-no-replay',opts:{},code:'CLIPBOARD_CHANGED',outcome:'not-dispatched'},
  {name:'interrupted-paste-no-replay',opts:{},code:'INTERRUPTED',outcome:'unknown'},
 ];
 for(const test of cases){
  const cu=new ComputerUse({workerExe:'X:/NOT-STARTED.exe'}),calls=[];
  cu.call=async()=>({});
  const error=Object.assign(new Error(test.name),{code:test.code,outcome:test.outcome});
  cu.actuate=async(op,args)=>{calls.push({op,args});if(calls.length===1)throw error;return {mode:args.mode,chars:2,focus:{hwnd:77}}};
  if(test.fallback){const value=await cu.type('中文',{...test.opts,expectHwnd:77});assert.equal(value.mode,'unicode');assert.equal(value.modeFallback,'clipboard-preservation-unavailable');assert.equal(calls[1].args.expectHwnd,77);}
  else await assert.rejects(cu.type('中文',test.opts),e=>e===error);
  assert.equal(calls.length,test.fallback?2:1);result.cases.push({name:test.name,pass:true});
 }
 const cu=new ComputerUse({workerExe:'X:/NOT-STARTED.exe'});cu.call=async()=>({});let calls=0;
 cu.actuate=async()=>{calls++;throw Object.assign(new Error('stopped'),{code:calls===1?'CLIPBOARD_PRESERVATION_UNAVAILABLE':'INTERRUPTED',outcome:calls===1?'not-dispatched':'unknown'})};
 await assert.rejects(cu.type('中文'),e=>e.code==='INTERRUPTED');assert.equal(calls,2);
 result.cases.push({name:'fallback-refuses-new-brake',pass:true});result.jsCases=7;
 const guarded=new ComputerUse({workerExe:'X:/NOT-STARTED.exe'});let focusReads=0,typed=0;
 guarded.call=async()=>({element:{isPassword:++focusReads>1}});
 guarded.actuate=async()=>{typed++;throw Object.assign(new Error('unsupported'),{code:'CLIPBOARD_PRESERVATION_UNAVAILABLE',outcome:'not-dispatched'})};
 await assert.rejects(guarded.type('中文'),/password field/);assert.equal(focusReads,2);assert.equal(typed,1);
 result.cases.push({name:'fallback-rechecks-password-focus',pass:true});result.jsCases=8;
 if(process.env.DSH_COACTIVE_RESULTS)fs.writeFileSync(process.env.DSH_COACTIVE_RESULTS,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}catch(e){console.error(e.stdout??'',e.stderr??'');throw e}
