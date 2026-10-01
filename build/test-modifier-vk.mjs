// build/test-modifier-vk.mjs
//
// Regression guard for the 2026-09-13 bug (found by the human, proven from their own log):
//
//   IsBareModifier() only knew the GENERIC modifier virtual-key codes
//   (VK_SHIFT 0x10 / VK_CONTROL 0x11 / VK_MENU 0x12), but a WH_KEYBOARD_LL hook delivers the
//   LEFT/RIGHT-SPECIFIC ones: left Ctrl arrives as 0xA2, left Alt as 0xA4. So every Ctrl and every
//   Alt press was classified as "the human is typing at the keyboard" -> Engage() -> brake.
//   The RESUME hotkey IS Ctrl+Alt+R (Ctrl 0xA2 + Alt 0xA4 + R), so each press emitted
//   stop-then-resume: the abort notice killed the agent's turn, an aborted turn re-armed the brake,
//   and R could never win. The human saw "press Ctrl+Alt+R -> the red frame fades in, forever",
//   with a wall of paired "resumed" / "aborted" cards as the receipt.
//
// A guard that cannot fire is worse than no guard, so this one is SELF-TESTED: it also runs its
// checks against a copy of the known-buggy function and FAILS if that copy is accepted.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'lib/core/worker.cs')
const src = fs.readFileSync(file, 'utf8')

const FN = /static bool IsBareModifier\(uint vk\)\s*\{[\s\S]*?\n\s*\}/

// Every one of these must appear in the body. The four specific codes are the whole point:
// they are what the hook actually hands us.
const REQUIRED = [
  ['VK_SHIFT', 'generic Shift 0x10'],
  ['VK_CONTROL', 'generic Ctrl 0x11'],
  ['VK_MENU', 'generic Alt 0x12'],
  ['0xA0', 'left Shift'],
  ['0xA1', 'right Shift'],
  ['0xA2', 'left Ctrl  <- what the hook really sends'],
  ['0xA3', 'right Ctrl'],
  ['0xA4', 'left Alt   <- and this'],
  ['0xA5', 'right Alt'],
  ['0x5B', 'left Windows key'],
  ['0x5C', 'right Windows key'],
]

function findings (text, label) {
  const m = FN.exec(text)
  if (!m) return [`${label}: IsBareModifier() not found — did it get renamed?`]
  const out = []
  for (const [tok, why] of REQUIRED) {
    if (!m[0].includes(tok)) out.push(`${label}: IsBareModifier() is missing ${tok} (${why})`)
  }
  return out
}

const failures = findings(src, 'worker.cs')

// --- self-test: the guard must REJECT the known-buggy body (generic codes only) ---
const BUGGY = `static bool IsBareModifier(uint vk)
        {
            return vk == Native.VK_SHIFT || vk == Native.VK_CONTROL || vk == Native.VK_MENU ||
                   vk == 0x5B || vk == 0x5C;       // left / right Windows key
        }`
if (!FN.test(src)) failures.push('self-test: cannot find IsBareModifier() to mutate')
else {
  const mutated = src.replace(FN, BUGGY)
  const caught = findings(mutated, 'self-test')
  if (caught.length < 4) {
    failures.push(`self-test FAILED: the guard accepted the known-buggy body (only ${caught.length} findings) — this guard cannot fire, fix the guard before trusting it`)
  }
}

if (failures.length) {
  console.error('FAIL test-modifier-vk')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('ok test-modifier-vk — IsBareModifier covers the generic AND the left/right-specific modifier VKs (guard self-tested against the buggy version)')
