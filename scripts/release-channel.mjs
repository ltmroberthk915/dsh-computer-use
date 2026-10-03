// Publisher tool. This file is never an npm lifecycle hook.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PACKAGE = 'dsh-codex-style-computer-use'
export const MIN_AGE_MS = 24 * 60 * 60 * 1000
export function releaseReadiness(metadata, version, now = Date.now()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Promotion requires an exact stable version, e.g. 1.2.1')
  const manifest = metadata.versions?.[version]
  if (manifest?.name !== PACKAGE || manifest.version !== version) throw Error('The requested published version is missing or has the wrong identity')
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (repository?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '') !== 'https://github.com/ltmroberthk915/dsh-computer-use') throw Error('Published repository identity does not match')
  const publishedText = metadata.time?.[version]
  const publishedAt = typeof publishedText === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(publishedText) ? Date.parse(publishedText) : NaN
  if (!Number.isFinite(publishedAt) || publishedAt > now) throw Error('Missing or invalid registry publication time; refusing promotion')
  const latest = metadata['dist-tags']?.latest
  if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
    const a = version.split('.').map(Number), b = latest.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) throw Error('Refusing to move latest backwards')
      if (a[i] > b[i]) break
    }
  }
  const eligibleAt = publishedAt + MIN_AGE_MS
  return { package: PACKAGE, version, ready: now >= eligibleAt, publishedAt: new Date(publishedAt).toISOString(), eligibleAt: new Date(eligibleAt).toISOString(), remainingSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, version] = process.argv.slice(2)
    if (!['check', 'promote'].includes(operation) || !/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Usage: node scripts/release-channel.mjs check|promote <stable-version>')
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    if (!fs.existsSync(npm)) throw Error('Run this publisher command with the Node.js installation that includes npm')
    const npmArgs = ['--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=20000']
    const manifest = JSON.parse(execFileSync(process.execPath, [npm, 'view', `${PACKAGE}@${version}`, '--json', ...npmArgs], { encoding: 'utf8', windowsHide: true }))
    const metadata = { ...manifest, versions: { [version]: manifest } }
    const verdict = releaseReadiness(metadata, version)
    console.log(JSON.stringify(verdict, null, 2))
    if (!verdict.ready) { process.exitCode = 2 }
    else if (operation === 'promote') {
      execFileSync(process.execPath, [npm, 'dist-tag', 'add', `${PACKAGE}@${version}`, 'latest', ...npmArgs], { stdio: 'inherit', windowsHide: true })
      const tag = JSON.parse(execFileSync(process.execPath, [npm, 'view', PACKAGE, 'dist-tags.latest', '--json', ...npmArgs], { encoding: 'utf8', windowsHide: true }))
      if (tag !== version) throw Error('Registry latest did not match after promotion')
      console.log(`Verified latest: ${PACKAGE}@${version}`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
