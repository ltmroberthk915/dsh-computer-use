// One command grammar for approval and dispatch. Native parsing implements the
// same contract for direct worker clients; cross-language fixtures guard parity.
export const KEY_ALIASES = Object.freeze({
  control: 'ctrl', lwin: 'win', windows: 'win', meta: 'win',
  return: 'enter', escape: 'esc', bksp: 'backspace', del: 'delete',
  ins: 'insert', pageup: 'pgup', pagedown: 'pgdn', capslock: 'caps', printscreen: 'prtsc',
})
const modifierOrder = ['ctrl', 'alt', 'shift', 'win', 'rwin']
const named = new Set([...modifierOrder, 'enter', 'esc', 'tab', 'space', 'backspace', 'delete',
  'insert', 'home', 'end', 'pgup', 'pgdn', 'up', 'down', 'left', 'right', 'caps', 'apps',
  'prtsc', 'numlock', 'plus', 'minus', 'comma', 'period'])

export function parseKeyCommand (combo) {
  if (typeof combo !== 'string' || !combo.trim()) throw new Error('KEY_COMMAND_INVALID: nonempty key combo required')
  const unique = []
  for (const part of combo.split('+')) {
    const raw = part.trim().toLowerCase()
    const key = KEY_ALIASES[raw] || raw
    if (!key || !(named.has(key) || /^[a-z0-9]$/.test(key) || /^f(?:[1-9]|1\d|2[0-4])$/.test(key))) {
      throw new Error(`KEY_COMMAND_INVALID: unknown or empty key ${JSON.stringify(raw)}`)
    }
    if (!unique.includes(key)) unique.push(key)
  }
  const modifiers = modifierOrder.filter(key => unique.includes(key))
  const keys = unique.filter(key => !modifierOrder.includes(key))
  const tokens = [...modifiers, ...keys]
  return { combo: tokens.join('+'), tokens, modifiers, keys }
}

export function keyCommandRisk (combo) {
  const { tokens } = parseKeyCommand(combo)
  const has = key => tokens.includes(key)
  const win = has('win') || has('rwin')
  return has('delete') || has('backspace') ||
    (win && ['r', 'l', 'd'].some(has)) || (has('alt') && has('f4')) ||
    (has('ctrl') && has('shift') && has('esc'))
}
