// launch.js — validation for computer_launch. EXECUTION lives in the worker (lib/core/worker.cs
// `launch` op) on purpose: a launch must go through the SAME funnel as every other actuation —
// brake/pause checks, the status halo, the audit JSONL and the rate window — and the human has
// to SEE that the machine was just acted on. A Node-side spawn skipped all of that (measured
// 2026-11-07: the halo never lit, so nothing told the human an app was opening).
//
// Validation still lives here so an impossible target is refused BEFORE dispatch: the receipt
// says outcome:"not-dispatched", and that has to be true. The policy layer also needs the string.
//
// RESOLUTION IS ShellExecute's (worker: ProcessStartInfo.UseShellExecute). Measured on this
// machine: `explorer.exe calc` opens a FILE EXPLORER window (a bare word is a location to
// explorer), while ShellExecute("calc") starts Calculator — so the launcher, not a shell
// wrapper, is the correct resolver for App Paths aliases, shell: verbs, URLs and associations.
//
// The target crosses as ONE value: no command line is composed here or in the worker, and no
// shell interpreter is involved. The deny-list below is defence in depth for anything
// downstream that might interpolate the string — the boundary is the single-value call.
const MAX_LEN = 2000

// Control characters: C0 (includes \r \n \t), DEL, C1, and the Unicode line/paragraph
// separators (U+2028/U+2029 still break line discipline in several parsers). None has an
// honest use in a path, URL or alias.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

// Metacharacters for a shell or a string interpolator. Percent is deliberately NOT here:
// "%20"-style percent-encoding is a legitimate, unavoidable part of URLs, and no shell is
// involved, so there is no %VAR% expansion to fear.
const INJECTIVE = /["'&|;<>$`^]/

const badTarget = (why) => {
  throw Object.assign(new Error(`bad launch target: ${why}`), { code: 'LAUNCH_BAD_TARGET', outcome: 'not-dispatched' })
}

/** Trim and validate a launch target; throws LAUNCH_BAD_TARGET (not-dispatched) when impossible.
 *  Everything is checked on the TRIMMED string, i.e. on exactly what the worker will receive. */
export function validateLaunchTarget (target) {
  if (typeof target !== 'string') badTarget('must be a string')
  const t = target.trim()
  if (!t) badTarget('empty (or only whitespace)')
  if (t.length > MAX_LEN) badTarget(`longer than ${MAX_LEN} characters`)
  const c = CONTROL.exec(t)
  if (c) badTarget(`control character U+${c[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  const m = INJECTIVE.exec(t)
  if (m) badTarget(`forbidden character ${JSON.stringify(m[0])}`)
  return t
}

const badArgs = (why) => {
  throw Object.assign(new Error(`bad launch arguments: ${why}`), { code: 'LAUNCH_BAD_ARGS', outcome: 'not-dispatched' })
}

/** Validate the optional argument array. Each entry is ONE argument VALUE — never a command
 *  line, never shell syntax: the worker quotes each entry exactly once. Spaces, backslashes and
 *  `--flag=value` are ordinary; only NUL, control characters and empties are impossible. */
export function validateLaunchArgs (args) {
  if (args === undefined || args === null) return undefined
  if (!Array.isArray(args)) badArgs('must be an array of strings')
  if (args.length > 64) badArgs('more than 64 arguments')
  return args.map((value, index) => {
    if (typeof value !== 'string') badArgs(`argument ${index} must be a string`)
    if (value.length === 0) badArgs(`argument ${index} is empty`)
    if (value.length > MAX_LEN) badArgs(`argument ${index} longer than ${MAX_LEN} characters`)
    const c = CONTROL.exec(value)
    if (c) badArgs(`argument ${index} contains control character U+${c[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    return value
  })
}
