// The host-debug settings page is a client bundle, not a server module. dsh-client-modules only
// discovers it through exports["./client"]; missing that key turns the shipped client.js into a
// silent dead file and leaves Settings -> 电脑操控（调试） unreachable (the 2.2.7 incident).
// This guard is deliberately about the shipped identity, not the page's styling.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be web')
const exported = pkg.exports?.['./client']
assert.ok(exported, 'package.json must export "./client"')
const target = typeof exported === 'string' ? exported : exported?.default
assert.equal(target, './client.js', 'exports["./client"] must point at ./client.js')
assert.ok(pkg.files?.includes('client.js'), 'npm files must include client.js')
assert.ok(fs.existsSync(path.join(root, target)), `${target} is missing`)

const client = fs.readFileSync(path.join(root, target), 'utf8')
for (const needle of [
  'window.__ModuleLoader__.load',
  'settings.section',
  '电脑操控（调试）',
  '/api/computer-use/host-debug',
]) assert.ok(client.includes(needle), `client bundle lost ${needle}`)

// The server side that must exist for the page to do anything: the host-debug route is mounted by
// the plugin and the worker reads the same file hot. This is a static identity check; the native
// gate behavior has its own tests.
const server = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
assert.match(server, /\/api\/computer-use\/host-debug/, 'host-debug route missing from lib/index.js')
assert.ok(fs.existsSync(path.join(root, 'lib/host-debug.js')), 'host-debug.js missing')

console.log('ok test-client-export — package exports ./client, client.js is shipped and contains the settings section/API, host-debug server is present')
