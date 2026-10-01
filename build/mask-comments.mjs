// mask-comments.mjs — ONE comment masker, shared by every guard that matches source text.
//
// WHY THIS EXISTS (review finding, 2026-09-16). This repository's style is to QUOTE CODE INSIDE ITS
// COMMENTS — the kernel32 fix quotes the very declaration it explains, three lines above the declaration
// itself. A rule matching raw text can therefore be satisfied by PROSE while the code it protects is gone.
// That is not hypothetical: `test-timeout-branch.mjs`'s own fallback rule first shipped that way, and two
// of its mutations left it green.
//
// WHY A SCANNER AND NOT TWO `replace` CALLS: anchors here legitimately live INSIDE string literals (an
// entire PowerShell script is one big pair of them), so strings must survive. A naive `//` replace would
// also cut every URL and every `//` inside a string, silently truncating an anchor.
//
// THE CONTRACT: the returned string has EXACTLY the same length and the same newlines, with the bytes of
// real comments replaced by MASK. Offsets therefore still address the original text, so `indexOf`-derived
// slices keep working — which is the only reason this can be dropped into an existing guard.
export const MASK = '\u0000'

export function maskComments (text) {
  const out = text.split('')
  let i = 0
  let quote = null
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = MASK; i++ }
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      out[i] = MASK; out[i + 1] = MASK; i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] !== '\n') out[i] = MASK; i++ }
      if (i < text.length) { out[i] = MASK; out[i + 1] = MASK; i += 2 }
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Mask, then refuse the two ways this can quietly become decoration: a masking step that changed the
 * LENGTH (every offset-derived slice would be wrong) and one that found NOTHING to mask (a silent no-op
 * restores the exact defect this exists to remove). Returns the masked text.
 * @param {string} text
 * @param {string} label file name, for the failure message
 */
export function maskChecked (text, label) {
  const masked = maskComments(text)
  if (masked.length !== text.length) {
    throw new Error(`masking changed the length of ${label} — every offset-derived slice would be wrong`)
  }
  if (!masked.includes(MASK)) {
    throw new Error(`masking found no comments in ${label} — it is not doing anything, which is the same as no masking`)
  }
  return masked
}
