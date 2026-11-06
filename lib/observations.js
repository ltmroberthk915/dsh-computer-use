import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import v8 from 'node:v8'
import { createHash, randomBytes } from 'node:crypto'

const clone = value => JSON.parse(JSON.stringify(value))
const encode = value => JSON.stringify(value)
const elementKey = e => e.target || (e.runtimeId ? `uia:${e.pid ?? ''}:${e.runtimeId}` : null)
const windowKey = w => w.hwnd ? `window:${w.pid ?? ''}:${w.hwnd}` : null
const pagedFields = ['elements', 'uiaFlat', 'windows', 'ancestors']
const TTL = 24 * 60 * 60 * 1000, MEMORY_BYTES = 4 * 1024 * 1024, DISK_BYTES = 32 * 1024 * 1024
const FORMAT = 'dsh-computer-use-observation-cache-v1', ID = /^[a-f0-9]{32}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = code => Object.assign(new Error('Observation cache unavailable'), { code })
const unavailable = () => new Error('OBSERVATION_UNAVAILABLE: snapshot expired or belongs to another Agent/tool; request a fresh full observation')
const pressure = () => { const heap = v8.getHeapStatistics(); return os.freemem() < 256 * 1024 * 1024 || heap.used_heap_size / heap.heap_size_limit > 0.85 }

// Only this dedicated directory is maintained. A manifest reserves ownership
// before data is written, so a crash/partial write remains identifiable on restart.
class DiskCache {
  constructor (directory, io, now) { this.directory = directory; this.io = io; this.now = now; this.lastSweep = -Infinity }
  file (name) { return path.join(this.directory, name) }
  regular (file) { const stat = this.io.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('CACHE_UNSAFE'); return stat }
  remove (file) {
    try { const stat = this.regular(file); this.io.unlinkSync(file); return stat.size }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  }
  lock (body, create = true) {
    if (!this.directory || path.basename(this.directory).toLowerCase() !== 'observation-cache') throw failure('CACHE_DIRECTORY')
    if (create) this.io.mkdirSync(this.directory, { recursive: true })
    const directory = this.io.lstatSync(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('CACHE_UNSAFE')
    const lockFile = this.file('.lock'), nonce = randomBytes(16).toString('hex')
    let handle
    try { handle = this.io.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = this.regular(lockFile); if (stat.size > 4096) throw failure('CACHE_LOCKED')
      let stale; try { stale = JSON.parse(this.io.readFileSync(lockFile, 'utf8')) } catch { throw failure('CACHE_LOCKED') }
      if (stale.format !== FORMAT || !ID.test(stale.nonce) || !Number.isSafeInteger(stale.pid) || stale.pid < 1) throw failure('CACHE_LOCKED')
      if (stale.pid !== process.pid || this.recoverableLock !== stale.nonce)
        try { process.kill(stale.pid, 0); throw failure('CACHE_LOCKED') } catch (alive) { if (alive.code !== 'ESRCH') throw failure('CACHE_LOCKED') }
      // This exact temporary filename is owned by the persisted dead lock.
      this.remove(this.file(`.manifest-${stale.nonce}.tmp`)); this.remove(lockFile)
      this.recoverableLock = null
      handle = this.io.openSync(lockFile, 'wx', 0o600)
    }
    const lease = { nonce, keep: false }
    try {
      this.io.writeFileSync(handle, encode({ format: FORMAT, nonce, pid: process.pid }) + '\n', 'utf8')
      return body(lease)
    } finally {
      this.io.closeSync(handle)
      if (lease.keep) this.recoverableLock = nonce
      else this.remove(lockFile)
    }
  }
  manifest () {
    const file = this.file('.manifest.json')
    let value
    try { const stat = this.regular(file); if (stat.size > 128 * 1024) throw failure('CACHE_MANIFEST'); value = JSON.parse(this.io.readFileSync(file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    if (value.format !== FORMAT || !Array.isArray(value.entries) || value.entries.length > 64) throw failure('CACHE_MANIFEST')
    const ids = new Set()
    for (const e of value.entries) {
      if (!ID.test(e.id) || !ID.test(e.owner) || ids.has(e.id) || !Number.isFinite(e.createdAt) ||
          !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !/^[a-f0-9]{64}$/.test(e.sha256)) throw failure('CACHE_MANIFEST')
      ids.add(e.id)
    }
    return value.entries
  }
  commit (entries, lease) {
    const temp = this.file(`.manifest-${lease.nonce}.tmp`)
    let opened = false, handle
    try {
      handle = this.io.openSync(temp, 'wx', 0o600); opened = true
      this.io.writeFileSync(handle, encode({ format: FORMAT, entries }) + '\n', 'utf8')
      this.io.closeSync(handle); handle = undefined
      this.io.renameSync(temp, this.file('.manifest.json')); opened = false
    } finally {
      if (handle !== undefined) this.io.closeSync(handle)
      if (opened) try { this.remove(temp) } catch { lease.keep = true }
    }
  }
  trim (entries, incomingBytes = 0, incomingFiles = 0) {
    let changed = false, retained = 0
    const discard = entry => {
      try { this.remove(this.file(entry.id + '.json')); entries.splice(entries.indexOf(entry), 1); changed = true; return true }
      catch { retained++; return false }
    }
    for (const entry of [...entries]) {
      let missing = false
      try { this.regular(this.file(entry.id + '.json')) } catch (error) { missing = error.code === 'ENOENT' }
      if (missing || this.now() - entry.createdAt >= TTL) discard(entry)
    }
    for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
      if (entries.length + incomingFiles <= 64 && entries.reduce((n, e) => n + e.bytes, 0) + incomingBytes <= DISK_BYTES) break
      discard(entry)
    }
    return { changed, retained, fits: entries.length + incomingFiles <= 64 && entries.reduce((n, e) => n + e.bytes, 0) + incomingBytes <= DISK_BYTES }
  }
  sweep (force = false) {
    if (!this.directory || (!force && performance.now() - this.lastSweep < 60000)) return
    this.lastSweep = performance.now()
    try { this.lock(lease => { const entries = this.manifest(); if (this.trim(entries).changed) this.commit(entries, lease) }, false) } catch { /* Later save reports bounded fallback. */ }
  }
  save (owner, full) {
    try {
      const bytes = Buffer.from(encode(full) + '\n', 'utf8')
      if (bytes.length > DISK_BYTES) throw failure('CACHE_CAPACITY')
      return this.lock(lease => {
        const entries = this.manifest(), cleanup = this.trim(entries, bytes.length, 1)
        if (cleanup.changed) this.commit(entries, lease)
        if (!cleanup.fits) throw failure('CACHE_CAPACITY')
        const entry = { id: randomBytes(16).toString('hex'), owner, createdAt: this.now(), bytes: bytes.length, sha256: digest(bytes) }
        entries.push(entry); this.commit(entries, lease)
        const file = this.file(entry.id + '.json'); let handle, created = false
        try { handle = this.io.openSync(file, 'wx', 0o600); created = true; this.io.writeFileSync(handle, bytes) }
        catch (error) {
          if (handle !== undefined) { this.io.closeSync(handle); handle = undefined }
          let removed = !created
          if (created) try { this.remove(file); removed = true } catch { }
          if (removed) { entries.pop(); try { this.commit(entries, lease) } catch { } }
          throw error
        } finally { if (handle !== undefined) this.io.closeSync(handle) }
        this.lastSweep = performance.now()
        return { path: file, bytes: entry.bytes, sha256: entry.sha256, status: 'saved', cacheId: entry.id }
      })
    } catch (error) {
      return { status: 'memory-only', reason: ['ENOSPC', 'EDQUOT'].includes(error.code) ? 'disk-full' : error.code === 'CACHE_CAPACITY' ? 'capacity' : 'disk-unavailable', fallback: 'inline' }
    }
  }
  read (owner, archive) {
    return this.lock(() => {
      const entry = this.manifest().find(e => e.id === archive.cacheId && e.owner === owner)
      if (!entry || this.now() - entry.createdAt >= TTL) throw unavailable()
      const file = this.file(entry.id + '.json'), stat = this.regular(file)
      if (stat.size !== entry.bytes || stat.size > DISK_BYTES) throw unavailable()
      const bytes = this.io.readFileSync(file)
      if (digest(bytes) !== entry.sha256) throw unavailable()
      return JSON.parse(bytes)
    }, false)
  }
  clear (owner) {
    if (!this.directory) return { filesRemoved: 0, bytesFreed: 0, retainedOnFailure: 0 }
    try { this.io.lstatSync(this.directory) } catch (error) { if (error.code === 'ENOENT') return { filesRemoved: 0, bytesFreed: 0, retainedOnFailure: 0 }; throw error }
    return this.lock(lease => {
      const entries = this.manifest(); let filesRemoved = 0, bytesFreed = 0, retainedOnFailure = 0
      for (const entry of [...entries]) if (entry.owner === owner) {
        try { const bytes = this.remove(this.file(entry.id + '.json')); filesRemoved += bytes > 0 ? 1 : 0; bytesFreed += bytes; entries.splice(entries.indexOf(entry), 1) }
        catch { retainedOnFailure++ }
      }
      this.commit(entries, lease)
      return { filesRemoved, bytesFreed, retainedOnFailure }
    }, false)
  }
}

// An explicit base prevents implicit deltas after compaction or in an unrelated Agent.
// Full immutable observations are retained, including every provider field; only the wire view differs.
export class ObservationStore {
  constructor ({ capacity = 64, archiveDir, memoryPressure = pressure, fileSystem = fs, now = Date.now } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Observation capacity must be a positive integer')
    if (archiveDir !== undefined && (typeof archiveDir !== 'string' || !archiveDir.trim())) throw new TypeError('archiveDir must be a nonempty directory path')
    this.capacity = Math.min(64, capacity)
    this.archiveDir = archiveDir === undefined ? null : path.resolve(archiveDir)
    this.now = now
    this.disk = new DiskCache(this.archiveDir, fileSystem, now)
    this.memoryPressure = memoryPressure
    this.lastPressureCheck = -Infinity
    this.pressured = false
    this.entries = new Map()
    this.memoryBytes = 0
    this.epoch = 0
    this.hasRead = false
    this.owners = new WeakMap()
    this.scopes = new WeakMap()
    this.unscoped = {}
    this.sequence = 0
    this.prefix = randomBytes(4).toString('hex')
  }
  scope (exec) {
    const owner = exec?.agent || this.unscoped
    let cache = this.scopes.get(owner)
    if (!cache) { cache = new Map(); this.scopes.set(owner, cache) }
    return cache
  }
  owner (exec) {
    const key = exec?.agent || this.unscoped
    if (!this.owners.has(key)) this.owners.set(key, randomBytes(16).toString('hex'))
    return this.owners.get(key)
  }
  evict (id) {
    const entry = this.entries.get(id)
    if (entry) { this.memoryBytes -= entry.full ? entry.bytes : 0; entry.cache.delete(id); this.entries.delete(id) }
  }
  checkPressure () {
    if (performance.now() - this.lastPressureCheck >= 5000) {
      this.lastPressureCheck = performance.now()
      try { this.pressured = !!this.memoryPressure() } catch { this.pressured = true }
      if (this.pressured) for (const [id, entry] of this.entries) {
        if (entry.archive?.status === 'saved') { this.memoryBytes -= entry.full ? entry.bytes : 0; entry.full = null }
        else this.evict(id)
      }
    }
    return this.pressured
  }
  fullOf (entry) {
    if (!entry || this.now() - entry.createdAt >= TTL) { if (entry) this.evict(entry.id); return null }
    if (entry.full) return entry.full
    try { return this.disk.read(entry.owner, entry.archive) } catch { this.evict(entry.id); return null }
  }
  invalidate (reason = 'evidence-invalidated') {
    this.epoch++
    return { invalidated: true, reason, historicalSnapshotsRetained: true }
  }
  clear (exec) {
    const cache = this.scope(exec), cleared = cache.size
    const knownFiles = [...cache.values()].filter(e => e.archive?.status === 'saved').length
    for (const id of [...cache.keys()]) this.evict(id)
    let disk = { filesRemoved: 0, bytesFreed: 0, retainedOnFailure: 0 }
    if (this.archiveDir) try { disk = this.disk.clear(this.owner(exec)) }
    catch { disk.retainedOnFailure = knownFiles || null }
    return { cleared, ...disk }
  }
  get (exec, id, kind, view = {}) {
    this.checkPressure(); this.disk.sweep(!this.hasRead); this.hasRead = true
    const entry = this.scope(exec).get(id)
    if (!entry || entry.kind !== kind) throw unavailable()
    const full = this.fullOf(entry)
    if (!full) throw unavailable()
    const snapshot = clone(full)
    snapshot.snapshotHistorical = true
    snapshot.targetsValid = entry.epoch === this.epoch
    if (entry.archive) snapshot.archive = { ...entry.archive }
    if (view.offset !== undefined || view.limit !== undefined) {
      const offset = view.offset ?? 0, limit = view.limit ?? 80
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 80)
        throw new RangeError('Observation pagination requires offset >= 0 and limit between 1 and 80')
      const page = { offset, limit, fields: {} }
      for (const field of pagedFields) if (Array.isArray(snapshot[field])) {
        const total = snapshot[field].length
        snapshot[field] = snapshot[field].slice(offset, offset + limit)
        const returned = snapshot[field].length, hasMore = offset < total && returned < total - offset
        page.fields[field] = { total, returned, hasMore, nextOffset: hasMore ? offset + returned : null }
      }
      // A second complete tree would defeat an explicitly requested page. The
      // default full read and archive still preserve every provider field.
      if (Object.hasOwn(snapshot, 'uiaRoot')) { delete snapshot.uiaRoot; page.omittedFields = ['uiaRoot'] }
      snapshot.page = page
    }
    return snapshot
  }
  ownsTarget (exec, target) {
    this.checkPressure()
    return [...this.scope(exec).values()].some(entry => entry.epoch === this.epoch && (this.fullOf(entry)?.elements || []).some(e => e.target === target))
  }
  publish (exec, kind, query, value, since, options = {}) {
    // The action already allocated its result. Under pressure do not create a
    // second deep copy, diff, encoded buffer, or new disk record for that result.
    if (this.checkPressure()) {
      const inline = { ...value, capturedAt: value.capturedAt ?? value.ts ?? new Date().toISOString(), mode: 'full',
        archive: { status: 'uncached', reason: 'memory-pressure', fallback: 'inline' } }
      delete inline.observation
      return inline
    }
    const cache = this.scope(exec)
    const fields = kind === 'uia' ? { elements: elementKey } : { windows: windowKey, uiaFlat: elementKey }
    const full = clone({ ...value, capturedAt: value.capturedAt ?? value.ts ?? new Date().toISOString(),
      observation: `O${this.prefix}-${++this.sequence}`, mode: 'full' })
    // The scope includes the exact query and observed window/process. A change forces a full view.
    const scope = encode([query, value.hwnd ?? value.active?.hwnd ?? null, value.pid ?? value.active?.pid ?? null])
    const previousEntry = since && cache.get(since), previousFull = this.fullOf(previousEntry)
    const previous = previousFull && { ...previousEntry, full: previousFull }
    let wire = full
    if (since) {
      let reason = !previous ? 'base-unavailable' : previous.kind !== kind || previous.scope !== scope ? 'scope-changed'
        : previous.full.truncated || previous.full.uiaTruncated || full.truncated || full.uiaTruncated ? 'incomplete-observation' : null
      if (!reason) {
        const delta = {}
        for (const [field, keyOf] of Object.entries(fields)) {
          const before = previous.full[field] || [], after = full[field] || []
          const keyMap = rows => {
            const map = new Map()
            for (const row of rows) {
              const key = keyOf(row)
              if (!key || map.has(key)) return null
              map.set(key, row)
            }
            return map
          }
          const oldMap = keyMap(before), newMap = keyMap(after)
          if (!oldMap || !newMap) { reason = 'ambiguous-identity'; break }
          delta[field] = { added: [], changed: [], removed: [] }
          for (const [key, row] of newMap) {
            if (!oldMap.has(key)) delta[field].added.push({ key, element: row })
            else if (encode(oldMap.get(key)) !== encode(row)) delta[field].changed.push({ key, element: row })
          }
          for (const key of oldMap.keys()) if (!newMap.has(key)) delta[field].removed.push(key)
          if (encode([...oldMap.keys()]) !== encode([...newMap.keys()])) delta[field].order = [...newMap.keys()]
        }
        if (!reason) {
          wire = { ...full, mode: 'diff', base: since, delta }
          for (const field of Object.keys(fields)) delete wire[field]
          if (encode(wire).length >= encode(full).length) reason = 'delta-not-smaller'
        }
      }
      if (reason) wire = { ...full, resetReason: reason }
    }
    let archive = options.archive === true ? this.disk.save(this.owner(exec), full) : undefined
    const bytes = Buffer.byteLength(encode(full)), keepMemory = !this.checkPressure() && bytes <= MEMORY_BYTES
    if (!keepMemory && archive?.status !== 'saved') {
      const inline = clone(full); delete inline.observation
      return { ...inline, archive: { status: 'uncached', reason: 'memory-pressure', fallback: 'inline' } }
    }
    if (keepMemory) for (const [id, entry] of this.entries) {
      if (this.memoryBytes + bytes <= MEMORY_BYTES) break
      if (!entry.full) continue
      if (entry.archive?.status === 'saved') { this.memoryBytes -= entry.bytes; entry.full = null }
      else this.evict(id)
    }
    const entry = { id: full.observation, full: keepMemory ? full : null, bytes, kind, scope, archive,
      owner: this.owner(exec), createdAt: this.now(), epoch: this.epoch, cache }
    cache.set(full.observation, entry); this.entries.set(full.observation, entry)
    if (keepMemory) this.memoryBytes += bytes
    while (cache.size > this.capacity) this.evict(cache.keys().next().value)
    while (this.entries.size > 64) this.evict(this.entries.keys().next().value)
    // Neither the full wire view nor delta rows may alias the retained snapshot.
    return { ...clone(wire), ...(archive ? { archive: { ...archive } } : {}) }
  }
}
