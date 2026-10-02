import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-evidence-fixture-'))
const win=process.env.WINDIR||'C:/Windows',gac=path.join(win,'Microsoft.NET/assembly/GAC_MSIL')
const refs=['System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Windows.Forms.dll',...['UIAutomationClient','UIAutomationTypes','WindowsBase'].map(n=>path.join(gac,n,'v4.0_4.0.0.0__31bf3856ad364e35',n+'.dll'))]
const exe=path.join(dir,'probe.exe'),source=process.env.DSH_EVIDENCE_SOURCE||path.join(import.meta.dirname,'../lib/core/worker.cs')
execFileSync(path.join(win,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/main:EvidenceProbe','/out:'+exe,...refs.map(r=>'/r:'+r),source,path.join(import.meta.dirname,'evidence-native-fixture.cs')],{windowsHide:true,timeout:30000})
const env={...process.env,DSH_HOME:path.join(dir,'home'),DSH_COMPUTER_USE_STOP_FILE:path.join(dir,'STOP'),DSH_COMPUTER_USE_EXIT_FILE:path.join(dir,'EXITED'),DSH_COMPUTER_USE_AUDIT_LOG:path.join(dir,'audit.jsonl')}
delete env.DSH_CU_HOST_PID;delete env.DSH_CU_HOST_EXE
let raw
try{raw=execFileSync(exe,process.env.DSH_EVIDENCE_BASELINE?['baseline']:[],{env,windowsHide:true,timeout:45000,encoding:'utf8'})}catch(e){process.stdout.write(e.stdout||'');throw e}
const rows=raw.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.ok(rows.length>=7&&rows.every(row=>row.ok))
if(process.env.DSH_EVIDENCE_RESULTS)fs.writeFileSync(process.env.DSH_EVIDENCE_RESULTS,JSON.stringify({source,dir,rows},null,2))
console.log('ok test-evidence-native — '+rows.length+' owned-window sampling/focus checks; artifacts: '+dir)
