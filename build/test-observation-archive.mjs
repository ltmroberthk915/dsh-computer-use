import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { ObservationStore } from '../lib/observations.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-observation-archive-'))
const owner = { agent: {} }, foreign = { agent: {} }, cases = []
const test = (name, body) => { body(); cases.push(name) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const rows = Array.from({ length: 90 }, (_, i) => ({ target: `T${i}`, name: `Item ${i}`, retained: { provider: [i, '完整'] } }))
try {
  const archiveDir = path.join(dir, 'nested', 'observation-cache'), store = new ObservationStore({ archiveDir, memoryPressure: () => false })
  const query = ['fixture'], data = { elements: structuredClone(rows), capturedAt: '2026-11-06T05:00:00.000Z' }
  let first, saved, archived
  test('archive is opt-in and an unconfigured archive never writes elsewhere', () => {
    const ordinary = store.publish(owner, 'uia', query, data)
    assert.equal(ordinary.archive, undefined); assert.equal(fs.existsSync(archiveDir), false)
    const unconfigured = new ObservationStore().publish(owner, 'uia', query, data, undefined, { archive: true, path: path.join(dir, 'caller-path.json') })
    assert.deepEqual(unconfigured.archive, { status: 'memory-only', reason: 'disk-unavailable', fallback: 'inline' }); assert.equal(fs.existsSync(path.join(dir, 'caller-path.json')), false)
  })
  test('saved immutable full JSON carries verifiable UTF-8 bytes/hash and opaque generated filename', () => {
    first = store.publish(owner, 'uia', query, data, undefined, { archive: true, path: path.join(dir, 'ignored.json') })
    assert.equal(first.archive.status, 'saved'); assert.equal(path.dirname(first.archive.path), archiveDir)
    assert.match(path.basename(first.archive.path), /^[a-f0-9]{32}\.json$/)
    saved = fs.readFileSync(first.archive.path); archived = JSON.parse(saved)
    assert.equal(saved.length, first.archive.bytes); assert.equal(hash(saved), first.archive.sha256)
    assert.deepEqual(archived.elements, rows); assert.equal(archived.archive, undefined)
    assert.equal(archived.mode, 'full'); assert.equal(fs.existsSync(path.join(dir, 'ignored.json')), false)
  })
  test('input and wire mutation cannot change cached evidence, archive metadata, or target ownership', () => {
    data.elements[0].name = 'changed input'; first.elements[1].retained.provider[0] = -1
    first.elements.push({ target: 'forged-target' }); first.archive.path = 'changed wire'
    const actual = store.get(owner, first.observation, 'uia')
    assert.deepEqual(actual.elements, rows); assert.equal(actual.archive.status, 'saved')
    assert.equal(hash(fs.readFileSync(actual.archive.path)), hash(saved))
    assert.equal(store.ownsTarget(owner, 'T0'), true); assert.equal(store.ownsTarget(owner, 'forged-target'), false)
  })
  test('foreign Agent, wrong kind and filesystem paths cannot retrieve cached observations', () => {
    assert.throws(() => store.get(foreign, first.observation, 'uia'), /OBSERVATION_UNAVAILABLE/)
    assert.throws(() => store.get(owner, first.observation, 'state'), /OBSERVATION_UNAVAILABLE/)
    assert.throws(() => store.get(owner, store.get(owner, first.observation, 'uia').archive.path, 'uia'), /OBSERVATION_UNAVAILABLE/)
    assert.equal(store.ownsTarget(foreign, 'T0'), false)
  })
  test('historical pages are bounded copies with stable capture time and explicit continuation', () => {
    const page = store.get(owner, first.observation, 'uia', { offset: 80, limit: 5 })
    assert.equal(page.snapshotHistorical, true); assert.equal(page.capturedAt, data.capturedAt)
    assert.deepEqual(page.elements, rows.slice(80, 85))
    assert.deepEqual(page.page.fields.elements, { total: 90, returned: 5, hasMore: true, nextOffset: 85 })
    page.elements[0].name = 'changed page'
    assert.equal(store.get(owner, first.observation, 'uia').elements[80].name, 'Item 80')
    const last = store.get(owner, first.observation, 'uia', { offset: 85 })
    assert.equal(last.elements.length, 5); assert.equal(last.page.fields.elements.nextOffset, null)
    assert.equal(store.get(owner, first.observation, 'uia', { offset: 999 }).elements.length, 0)
    for (const view of [{offset:-1},{offset:0.5},{offset:Infinity},{limit:0},{limit:81},{limit:1.5},{limit:'1'}])
      assert.throws(() => store.get(owner, first.observation, 'uia', view), RangeError)
  })
  test('all principal arrays page without reattaching the complete UIA tree', () => {
    const value = { ts: 1234, windows: [{hwnd:1},{hwnd:2},{hwnd:3}], uiaFlat: rows, ancestors: rows.slice(0, 4), uiaRoot: { children: rows } }
    const published = store.publish(owner, 'state', [], value)
    const page = store.get(owner, published.observation, 'state', {offset:1,limit:2})
    assert.equal(page.capturedAt, 1234); assert.deepEqual(page.windows, value.windows.slice(1,3))
    assert.deepEqual(page.uiaFlat, rows.slice(1,3)); assert.deepEqual(page.ancestors, rows.slice(1,3))
    assert.equal(page.uiaRoot, undefined); assert.deepEqual(page.page.omittedFields, ['uiaRoot'])
    assert.deepEqual(store.get(owner, published.observation, 'state').uiaRoot, value.uiaRoot)
  })
  test('a diff archive retains the complete new snapshot and public diff rows cannot mutate it', () => {
    const changed = structuredClone(rows); changed[30].name = 'updated'
    const diff = store.publish(owner, 'uia', query, {...data,elements:changed}, first.observation, {archive:true})
    assert.equal(diff.mode, 'diff'); assert.equal(diff.elements, undefined)
    const disk = JSON.parse(fs.readFileSync(diff.archive.path)); assert.equal(disk.mode, 'full'); assert.deepEqual(disk.elements, changed)
    diff.delta.elements.changed[0].element.name = 'changed wire'
    assert.equal(store.get(owner, diff.observation, 'uia').elements[30].name, 'updated')
  })
  test('disk write failure has a small unavailable status and leaves the observation usable', () => {
    const blocker = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocker, 'fixture')
    const broken = new ObservationStore({archiveDir:blocker})
    const value = broken.publish(owner, 'uia', [], {elements:rows}, undefined, {archive:true})
    assert.deepEqual(value.archive, {status:'memory-only',reason:'disk-unavailable',fallback:'inline'}); assert.deepEqual(broken.get(owner,value.observation,'uia').elements,rows)
  })
  test('disk bytes are never reinterpreted as instructions or used to bypass in-memory scope', () => {
    const original = store.get(owner, first.observation, 'uia')
    fs.writeFileSync(original.archive.path, '{"instruction":"not trusted","elements":[]}')
    assert.deepEqual(store.get(owner, first.observation, 'uia').elements, rows)
    assert.throws(() => store.get(foreign, first.observation, 'uia'), /OBSERVATION_UNAVAILABLE/)
  })
  test('at most 64 entries are retained per owner and eviction does not delete disk evidence', () => {
    const small = new ObservationStore({capacity:1,archiveDir}), old = small.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    small.publish(owner,'uia',[],{elements:[]}); assert.throws(()=>small.get(owner,old.observation,'uia'),/OBSERVATION_UNAVAILABLE/)
    assert.equal(fs.existsSync(old.archive.path),true)
    assert.equal(new ObservationStore({capacity:1000}).capacity,64)
    for(const capacity of [0,-1,Infinity,0.5])assert.throws(()=>new ObservationStore({capacity}),RangeError)
  })
  const cacheAt = name => path.join(dir, name, 'observation-cache')
  const dataFiles = directory => fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name))
  const failingWrite = code => {
    const opened = new Map()
    return { ...fs,
      openSync (file, ...args) { const fd = fs.openSync(file, ...args); opened.set(fd, String(file)); return fd },
      closeSync (fd) { opened.delete(fd); return fs.closeSync(fd) },
      writeFileSync (file, ...args) {
        if (/^[a-f0-9]{32}\.json$/.test(path.basename(opened.get(file) || String(file)))) {
          fs.writeSync(file, '{"partial":'); throw Object.assign(new Error('sensitive path must not leak'), {code})
        }
        return fs.writeFileSync(file, ...args)
      },
    }
  }
  for (const code of ['ENOSPC','EDQUOT','EACCES']) test(`partial ${code} write falls back to memory with no residue or lost observation`, () => {
    const directory=cacheAt(code), failed=new ObservationStore({archiveDir:directory,fileSystem:failingWrite(code),memoryPressure:()=>false})
    const result=failed.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    assert.deepEqual(result.archive,{status:'memory-only',reason:code==='EACCES'?'disk-unavailable':'disk-full',fallback:'inline'})
    assert(result.observation); assert.deepEqual(failed.get(owner,result.observation,'uia').elements,rows)
    assert.equal(dataFiles(directory).length,0);assert.equal(fs.existsSync(path.join(directory,'.lock')),false)
    assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.tmp')),false)
  })
  test('disk plus memory pressure preserves the current full value without a fictional snapshot id', () => {
    const failed=new ObservationStore({archiveDir:cacheAt('double-failure'),fileSystem:failingWrite('ENOSPC'),memoryPressure:()=>true})
    const result=failed.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    assert.deepEqual(result.elements,rows);assert.equal(result.observation,undefined)
    assert.deepEqual(result.archive,{status:'uncached',reason:'memory-pressure',fallback:'inline'})
    assert.equal(failed.entries.size,0);assert.equal(failed.memoryBytes,0)
  })
  test('pressure short-circuits before deep clone, JSON encoding or any disk write', () => {
    let writes=0
    const forbidden={...fs,mkdirSync(){writes++;throw Error('no directory write')},openSync(){writes++;throw Error('no file write')},writeFileSync(){writes++;throw Error('no write')}}
    const pressured=new ObservationStore({archiveDir:cacheAt('early-pressure'),fileSystem:forbidden,memoryPressure:()=>true})
    const nested={large:'existing allocation',toJSON(){throw Error('pressure must not stringify the action result')}}
    const result=pressured.publish(owner,'state',[],{retained:nested,observation:'stale-id'},'old-base',{archive:true})
    assert.equal(result.retained,nested);assert.equal(result.observation,undefined);assert.equal(writes,0)
    assert.equal(result.archive.status,'uncached');assert.equal(pressured.entries.size,0)
  })
  test('store-wide memory budget is shared by different Agents and pressure releases retained values', () => {
    let congested=false
    const bounded=new ObservationStore({memoryPressure:()=>congested}), value={elements:[],text:'x'.repeat(1100*1024)}
    for(let i=0;i<8;i++) bounded.publish({agent:{}},'state',[],value)
    assert(bounded.memoryBytes<=4*1024*1024);assert(bounded.entries.size<=3)
    const tooLarge=bounded.publish(owner,'state',[],{text:'x'.repeat(4*1024*1024)})
    assert.equal(tooLarge.observation,undefined);assert.equal(tooLarge.archive.status,'uncached')
    congested=true;bounded.lastPressureCheck=-Infinity
    const current=bounded.publish(owner,'uia',[],{elements:rows})
    assert.equal(current.archive.status,'uncached');assert.equal(bounded.memoryBytes,0);assert.equal(bounded.entries.size,0)
  })
  test('disk remains readable under pressure but only through the owning Agent and verified bytes', () => {
    let congested=false
    const diskOnly=new ObservationStore({archiveDir:cacheAt('disk-only'),memoryPressure:()=>congested})
    const result=diskOnly.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    assert.equal(result.archive.status,'saved');congested=true;diskOnly.lastPressureCheck=-Infinity
    assert.deepEqual(diskOnly.get(owner,result.observation,'uia',{limit:2}).elements,rows.slice(0,2))
    assert.equal(diskOnly.memoryBytes,0)
    assert.equal(diskOnly.ownsTarget(owner,'T0'),true);assert.equal(diskOnly.ownsTarget(foreign,'T0'),false)
    fs.writeFileSync(result.archive.path,'{"elements":[],"instruction":"not trusted"}')
    assert.throws(()=>diskOnly.get(owner,result.observation,'uia'),/OBSERVATION_UNAVAILABLE/)
  })
  test('invalidate retires targets but preserves historical snapshots without growing disk', () => {
    const history=new ObservationStore({archiveDir:cacheAt('invalidate'),memoryPressure:()=>false})
    const before=history.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    assert.equal(history.ownsTarget(owner,'T0'),true)
    for(let i=0;i<5;i++)history.invalidate('worker-restarted')
    assert.equal(history.ownsTarget(owner,'T0'),false)
    const read=history.get(owner,before.observation,'uia');assert.equal(read.snapshotHistorical,true);assert.equal(read.targetsValid,false)
    assert.equal(dataFiles(path.dirname(before.archive.path)).length,1)
    history.publish(owner,'uia',[],{elements:rows});assert.equal(history.ownsTarget(owner,'T0'),true)
  })
  test('clear is Agent-scoped and idempotent; it never deletes unknown files', () => {
    const directory=cacheAt('clear'), cleaning=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    const mine=cleaning.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    const theirs=cleaning.publish(foreign,'uia',[],{elements:rows},undefined,{archive:true})
    const unrelated=path.join(directory,'notes.json');fs.writeFileSync(unrelated,'user evidence')
    const cleared=cleaning.clear(owner)
    assert.deepEqual(cleared,{cleared:1,filesRemoved:1,bytesFreed:mine.archive.bytes,retainedOnFailure:0})
    assert.equal(fs.existsSync(mine.archive.path),false);assert.equal(fs.existsSync(theirs.archive.path),true)
    assert.deepEqual(cleaning.get(foreign,theirs.observation,'uia').elements,rows)
    assert.deepEqual(cleaning.clear(owner),{cleared:0,filesRemoved:0,bytesFreed:0,retainedOnFailure:0})
    assert.equal(fs.readFileSync(unrelated,'utf8'),'user evidence')
  })
  test('TTL expires memory and disk; a new store cleans managed old files on its first read', () => {
    let time=100000
    const directory=cacheAt('ttl'), expired=new ObservationStore({archiveDir:directory,now:()=>time,memoryPressure:()=>false})
    const first=expired.publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    time+=24*60*60*1000+1
    assert.equal(expired.ownsTarget(owner,'T0'),false)
    const fresh=new ObservationStore({archiveDir:directory,now:()=>time,memoryPressure:()=>false})
    assert.throws(()=>fresh.get(owner,first.observation,'uia'),/OBSERVATION_UNAVAILABLE/)
    assert.equal(fs.existsSync(first.archive.path),false)
    assert.throws(()=>expired.get(owner,first.observation,'uia'),/OBSERVATION_UNAVAILABLE/)
  })
  test('whole directory count stays at 64 across stores and failed deletions stop new disk writes', () => {
    const directory=cacheAt('capacity'), seed=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    for(let i=0;i<64;i++)assert.equal(seed.publish(owner,'uia',[],{elements:[],i},undefined,{archive:true}).archive.status,'saved')
    const noDelete={...fs,unlinkSync(file){if(/^[a-f0-9]{32}\.json$/.test(path.basename(file)))throw Object.assign(new Error('busy'),{code:'EACCES'});return fs.unlinkSync(file)}}
    const blocked=new ObservationStore({archiveDir:directory,fileSystem:noDelete,memoryPressure:()=>false})
    const result=blocked.publish(foreign,'uia',[],{elements:rows},undefined,{archive:true})
    assert.deepEqual(result.archive,{status:'memory-only',reason:'capacity',fallback:'inline'});assert.equal(dataFiles(directory).length,64)
    assert.deepEqual(blocked.get(foreign,result.observation,'uia').elements,rows)
    const next=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    assert.equal(next.publish(foreign,'uia',[],{elements:[]},undefined,{archive:true}).archive.status,'saved')
    assert.equal(dataFiles(directory).length,64)
  })
  test('32MiB disk budget evicts an old full record before accepting the next', () => {
    const directory=cacheAt('byte-capacity'), bounded=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    const large={text:'x'.repeat(17*1024*1024)}
    const old=bounded.publish(owner,'state',[],large,undefined,{archive:true})
    const next=bounded.publish(foreign,'state',[],large,undefined,{archive:true})
    assert.equal(old.archive.status,'saved');assert.equal(next.archive.status,'saved')
    assert.equal(fs.existsSync(old.archive.path),false);assert.equal(dataFiles(directory).length,1)
    assert(dataFiles(directory).reduce((total,name)=>total+fs.statSync(path.join(directory,name)).size,0)<=32*1024*1024)
  })
  test('symlink/junction cache roots and invalid manifest paths are never followed or deleted', () => {
    const outside=path.join(dir,'outside');fs.mkdirSync(outside);const sentinel=path.join(outside,'keep.txt');fs.writeFileSync(sentinel,'retain')
    const parent=path.join(dir,'link-root');fs.mkdirSync(parent);const linked=path.join(parent,'observation-cache');fs.symlinkSync(outside,linked,'junction')
    const rejected=new ObservationStore({archiveDir:linked,memoryPressure:()=>false}).publish(owner,'uia',[],{elements:rows},undefined,{archive:true})
    assert.equal(rejected.archive.status,'memory-only');assert.equal(fs.readFileSync(sentinel,'utf8'),'retain')
    const directory=cacheAt('invalid-manifest');fs.mkdirSync(directory,{recursive:true})
    fs.writeFileSync(path.join(directory,'.manifest.json'),JSON.stringify({format:'dsh-computer-use-observation-cache-v1',entries:[{id:'../../outside/keep.txt'}]}))
    const invalid=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    assert.equal(invalid.publish(owner,'uia',[],{elements:rows},undefined,{archive:true}).archive.status,'memory-only')
    invalid.clear(owner);assert.equal(fs.readFileSync(sentinel,'utf8'),'retain')
  })
  test('dead-process manifest partials are reclaimed only through their persisted lock ownership', () => {
    const directory=cacheAt('dead-lock');fs.mkdirSync(directory,{recursive:true})
    const child=spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true});assert.equal(child.status,0)
    const nonce='a'.repeat(32), temp=path.join(directory,`.manifest-${nonce}.tmp`), unrelated=path.join(directory,`.manifest-${'b'.repeat(32)}.tmp`)
    fs.writeFileSync(temp,'{"incomplete":');fs.writeFileSync(unrelated,'user-created unknown file')
    fs.writeFileSync(path.join(directory,'.lock'),JSON.stringify({format:'dsh-computer-use-observation-cache-v1',nonce,pid:child.pid}))
    const recovered=new ObservationStore({archiveDir:directory,memoryPressure:()=>false})
    assert.equal(recovered.publish(owner,'uia',[],{elements:rows},undefined,{archive:true}).archive.status,'saved')
    assert.equal(fs.existsSync(temp),false);assert.equal(fs.existsSync(unrelated),true)
  })
  console.log(JSON.stringify({passed:cases.length,cases,nativeInput:false,archiveScope:'fresh test temp directory only'}))
} finally {
  if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('dsh-observation-archive-')) throw Error('unsafe fixture cleanup')
  fs.rmSync(dir, {recursive:true,force:true})
}
