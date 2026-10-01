import assert from 'node:assert/strict'
import { ObservationStore } from '../lib/observations.js'
const store = new ObservationStore({ capacity: 4 }), a = { agent: {} }, b = { agent: {} }
const rows = Array.from({ length: 24 }, (_, i) => ({ target: `T${i}`, name: `Record ${i}`, role: 'Edit', value: `before ${i}`, retainedDetail: { custom: true, nested: [i, 'complete'] } }))
const data = elements => ({ hwnd: 7, pid: 9, count: elements.length, scanned: 28, truncated: false, elements })
let n = 0
const check = (name, fn) => { fn(); n++ }
const first = store.publish(a, 'uia', ['same query'], data(rows))
const edited = structuredClone(rows); edited[5].value = 'after'; edited.splice(8, 1); edited.push({ target: 'T-new', name: 'new', value: 'all fields' }); edited.reverse()
const second = store.publish(a, 'uia', ['same query'], data(edited), first.observation)
check('actual delta with no hidden full array', () => { assert.equal(second.mode, 'diff'); assert.equal(second.elements, undefined); assert.equal(second.delta.elements.changed.length, 1) })
check('delta reconstructs the exact complete array, including ordering', () => {
 const map = new Map(first.elements.map(e => [e.target, e]))
 for (const key of second.delta.elements.removed) map.delete(key)
 for (const {key, element} of [...second.delta.elements.added, ...second.delta.elements.changed]) map.set(key, element)
 assert.deepEqual(second.delta.elements.order.map(key => map.get(key)), edited)
})
check('complete immutable originals and current snapshots remain available', () => { rows[5].value = 'tampered'; assert.equal(store.get(a, first.observation, 'uia').elements[5].value, 'before 5'); assert.deepEqual(store.get(a, second.observation, 'uia').elements, edited) })
check('foreign Agent cannot read or use an observation', () => { assert.throws(() => store.get(b, first.observation, 'uia'), /UNAVAILABLE/); assert.equal(store.ownsTarget(b, 'T5'), false) })
check('unknown base returns full', () => assert.equal(store.publish(b, 'uia', [], data(rows), first.observation).resetReason, 'base-unavailable'))
check('changed query returns full', () => assert.equal(store.publish(a, 'uia', ['different query'], data(rows), second.observation).resetReason, 'scope-changed'))
check('partial evidence returns full', () => assert.equal(store.publish(a, 'uia', ['same query'], {...data(rows), truncated: true}, second.observation).resetReason, 'incomplete-observation'))
check('retained snapshots are capacity bounded', () => { store.publish(a, 'uia', [], data(rows)); assert.throws(() => store.get(a, first.observation, 'uia'), /UNAVAILABLE/) })
const collision = new ObservationStore(), same = collision.publish(a, 'uia', [], data([{target:'duplicate'},{target:'duplicate'}]))
check('duplicate identity refuses incremental interpretation', () => assert.equal(collision.publish(a, 'uia', [], data([{target:'duplicate'}]), same.observation).resetReason, 'ambiguous-identity'))
const short = collision.publish(a, 'uia', [], data([]))
check('a larger diff falls back to full', () => assert.equal(collision.publish(a, 'uia', [], data([]), short.observation).resetReason, 'delta-not-smaller'))
console.log(`ok test-observations — ${n} behavioral checks; reconstruction, complete retention, Agent isolation, expiry and full fallbacks`)
