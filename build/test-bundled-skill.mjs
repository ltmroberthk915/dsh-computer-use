// test-bundled-skill.mjs — the plugin must SERVE its own manual, not merely ship it.
//
// WHY THIS GUARD EXISTS (2026-10-01, the day this plugin was prepared for a public release):
// `skill-gate.js` refuses every DRIVING call until the session produces a receipt phrase that exists
// only inside `skills/computer-use/SKILL.md`. The host discovers skills through
// `@deepseek-ai/dsh-skill-filesystem`, which scans project/custom/user roots — never `node_modules`.
// So "the file is in the tarball" does NOT mean "the model can read it": a fresh `dsh plugin add`
// user gets driving tools locked by a manual nothing serves, with the deny hint pointing at a path no
// provider can read. `ctx.skills.register()` is the host's documented seam for that, and this guard
// pins the three ways it can silently stop working:
//
//   1. the registered BODY loses the receipt phrase -> the gate locks every session forever;
//   2. the frontmatter loses name/description      -> the registry rejects the contribution silently;
//   3. `skills` is added to `inject`               -> a deployment without that service leaves the
//      whole fiber INACTIVE and `apply` never runs, i.e. every tool disappears to fix a warning.
//
// The functions are EXECUTED, not pattern-matched: the real source block is extracted into a temp
// module whose `import.meta.url` points at a temp copy of the package, so a mutated SKILL.md is real
// input to the real code. Each "must not fire" case is paired with a fixture that must make it fire.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const F = {
  index: path.join(ROOT, 'lib/index.js'),
  gate: path.join(ROOT, 'lib/skill-gate.js'),
  skill: path.join(ROOT, 'skills/computer-use/SKILL.md'),
}
const read = (p) => fs.readFileSync(p, 'utf8')
const failures = []
const t = (name, ok, detail) => { if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`) }

// Comment-stripped source for the STATIC checks: a comment quoting the wiring once satisfied a guard
// in this repo while the code underneath was broken, so matching runs on code only.
function stripComments (src) {
  let out = ''; let i = 0; let mode = 'code'
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2 } else { if (c === '\n') out += c; i++ } continue }
    if (c === '\\') { out += c + (d || ''); i += 2; continue }
    if (c === mode) mode = 'code'
    out += c; i++
  }
  return out
}

const indexSrc = read(F.index)
const indexCode = stripComments(indexSrc)
// The phrase is read OUT OF THE SOURCE TEXT, like test-skill-gate.mjs: a mutation exists only in text,
// so importing the module would test the unmutated file on disk and could never fire.
const PHRASE = ((read(F.gate).match(/export const REQUIRED_PHRASE = '([^']+)'/) || [])[1] || '')
const REAL_SKILL = read(F.skill)

// ---- static wiring: registered, and NOT through `inject` -----------------------------------------
const injectDecl = (indexCode.match(/export const inject = \[[^\]]*\]/) || [''])[0]
t('wiring: `skills` is NOT in inject (a missing service would leave the fiber INACTIVE and kill every tool)',
  injectDecl !== '' && !/'skills'/.test(injectDecl), `inject = ${injectDecl || '(not found)'}`)
t('wiring: apply() calls registerBundledSkill',
  /registerBundledSkill\(ctx, log\)/.test(indexCode), 'apply() never calls it — the skill is shipped but never served')
t('wiring: the skill is contributed through the lazy ctx.inject seam',
  /ctx\.inject\(\['skills'\]/.test(indexCode), 'no lazy injection of the skills service found')

// ---- extract the real functions into a temp package whose SKILL.md we control ---------------------
const BLOCK = (() => {
  const start = indexSrc.indexOf('const SKILL_DIR_URL')
  const end = indexSrc.indexOf('export const name = ')
  if (start < 0 || end < 0 || end < start) return ''
  return indexSrc.slice(start, end)
})()
t('harness: the skill block is extractable from index.js', BLOCK.length > 0,
  'the `const SKILL_DIR_URL` / `export const name = ` anchors moved — this guard is now blind, which is a test bug, not a pass')

const tempDirs = []
function harness (skillMd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-skill-'))
  tempDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'skills', 'computer-use'), { recursive: true })
  if (skillMd !== null) fs.writeFileSync(path.join(dir, 'skills', 'computer-use', 'SKILL.md'), skillMd)
  const metaUrl = pathToFileURL(path.join(dir, 'lib', 'index.js')).href
  const modPath = path.join(dir, 'harness.mjs')
  fs.writeFileSync(modPath,
    'import fs from \'node:fs\'\n' +
    'import { fileURLToPath } from \'node:url\'\n' +
    `const IMPORT_META_URL = ${JSON.stringify(metaUrl)}\n` +
    BLOCK.replaceAll('import.meta.url', 'IMPORT_META_URL') + '\n' +
    'export { splitSkillFile, registerBundledSkill }\n')
  return modPath
}

let seq = 0
/**
 * Execute the real registerBundledSkill against a stub context.
 * @param skillMd - SKILL.md body to place in the temp package, or null for "the file is missing".
 * @param service - undefined: a working recording stub; null: the service never arrives; object: used as given.
 */
async function run (skillMd, service) {
  const modPath = harness(skillMd)
  const mod = await import(pathToFileURL(modPath).href + '?t=' + (++seq))
  const registered = []
  const logs = []
  const ctx = {
    inject (deps, cb) {
      if (service === null) return                 // the service never arrives
      if (service === undefined) {                 // the ordinary case: a service that records
        cb({ skills: { register: (s) => { registered.push(s); return () => {} } } })
        return
      }
      cb({ skills: service })                      // a service supplied by the caller, verbatim
    },
  }
  const log = { warn: (m) => logs.push(['warn', String(m)]), info: (m) => logs.push(['info', String(m)]) }
  mod.registerBundledSkill(ctx, log)
  return { mod, registered, logs }
}

// ---- A. the SHIPPED manual registers, with the receipt phrase in its body -------------------------
const good = await run(REAL_SKILL, undefined)
const g = good.registered[0]
t('shipped: exactly one skill is registered', good.registered.length === 1, `registered ${good.registered.length}`)
t('shipped: the name comes from the frontmatter', g && g.name === 'computer-use', `name = ${g && g.name}`)
t('shipped: the description is present and non-empty', g && typeof g.description === 'string' && g.description.length > 20, `description = ${g && g.description}`)
t('shipped: the body KEEPS the receipt phrase the gate quotes (else every session locks forever)',
  g && PHRASE.length > 0 && g.content.includes(PHRASE), 'the registered body does not contain REQUIRED_PHRASE')
t('shipped: the body is the manual, not the frontmatter', g && !/^---/.test(g.content) && /^#\s/.test(g.content.trimStart()), 'frontmatter leaked into the body')
t('shipped: resourceBase points at the skill directory so references/*.md resolve',
  g && g.resourceBase && g.resourceBase.kind === 'directory' && /skills[\\/]computer-use[\\/]?$/.test(g.resourceBase.path), `resourceBase = ${JSON.stringify(g && g.resourceBase)}`)
t('shipped: the registration is announced at info level',
  good.logs.some(([lvl]) => lvl === 'info'), 'no info line — a silent success is indistinguishable from a silent failure')

// ---- B. FIXTURE: with the phrase removed, the check above WOULD fire (it is falsifiable) ----------
const withoutPhrase = REAL_SKILL.replaceAll(PHRASE, 'something else entirely')
const mutated = await run(withoutPhrase, undefined)
t('fixture: the phrase-removal fixture really removes the phrase', !withoutPhrase.includes(PHRASE), 'replaceAll left the phrase in place')
t('fixture: a manual without the phrase still registers but would FAIL the body check above',
  mutated.registered.length === 1 && !mutated.registered[0].content.includes(PHRASE),
  'the body check cannot distinguish a manual that lost the phrase')

// ---- C. frontmatter without `description` -> the registry would drop it, so nothing may register ---
const noDescription = REAL_SKILL.replace(/^description:.*$/m, '')
const missingDescription = await run(noDescription, undefined)
t('fixture: the description-stripping fixture really strips it', !/^description:/m.test(noDescription), 'the fixture still has a description line')
t('guard: frontmatter without a description registers NOTHING and warns',
  missingDescription.registered.length === 0 && missingDescription.logs.some(([lvl]) => lvl === 'warn'),
  `registered ${missingDescription.registered.length}, warnings ${missingDescription.logs.length}`)

// ---- D. no frontmatter at all -> same refusal, no throw --------------------------------------------
const bare = await run('# bare manual\n\nno frontmatter here\n', undefined)
t('guard: a manual without frontmatter registers nothing and does not throw', bare.registered.length === 0, `registered ${bare.registered.length}`)

// ---- E. SKILL.md missing entirely -> warn, no throw, no registration -------------------------------
const missing = await run(null, undefined)
t('guard: a missing SKILL.md warns instead of throwing',
  missing.registered.length === 0 && missing.logs.some(([lvl]) => lvl === 'warn'), 'a missing file was not reported')

// ---- F. the skills service never arrives -> silent no-op, never a crash ----------------------------
const absent = await run(REAL_SKILL, null)
t('guard: an absent skills service is a no-op (never a crash, never a false success log)',
  absent.registered.length === 0 && absent.logs.length === 0, `logs: ${JSON.stringify(absent.logs)}`)

// ---- G. a service mounted without register() -> one warning, still no crash ------------------------
const noReg = await run(REAL_SKILL, {})
t('guard: a register()-less service warns and continues',
  noReg.registered.length === 0 && noReg.logs.some(([lvl]) => lvl === 'warn'), 'a service without register() was not reported')

// ---- H. splitSkillFile itself (the frontmatter reader) ---------------------------------------------
const { splitSkillFile } = good.mod
const parsed = splitSkillFile(REAL_SKILL)
t('parse: frontmatter keys are read as scalars',
  parsed.data.name === 'computer-use' && typeof parsed.data.description === 'string' && parsed.data.description.length > 20, JSON.stringify(parsed.data))
t('parse: a CRLF manual parses too', splitSkillFile(REAL_SKILL.replace(/\n/g, '\r\n')).data.name === 'computer-use', 'CRLF manual failed to parse')
t('parse: a colon inside a value does not truncate it',
  splitSkillFile('---\nname: x\ndescription: A thing: with a colon.\n---\nbody\n').data.description === 'A thing: with a colon.', 'a colon truncated the value')
t('parse: quoted values lose their quotes',
  splitSkillFile('---\nname: x\ndescription: "Quoted: value."\n---\nbody\n').data.description === 'Quoted: value.', 'quotes survived')
t('parse: a nested block is not mistaken for a scalar',
  splitSkillFile('---\nname: x\ndescription: d\nmetadata:\n  owner: nobody\n---\nbody\n').data.metadata === undefined, 'a nested mapping was read as a scalar')

for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.error(`FAIL test-bundled-skill — ${failures.length} problem(s)`)
  process.exit(1)
}
console.log(`ok test-bundled-skill — the shipped manual is registered with the host (phrase, frontmatter, resourceBase), an absent or register()-less skills service is a warn-only no-op, and \`skills\` is deliberately NOT in inject (${good.registered.length} skill registered from the real SKILL.md)`)
