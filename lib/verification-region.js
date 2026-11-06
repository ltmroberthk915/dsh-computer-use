// A witness rectangle describes where the caller expects an effect, independently
// of the input point. Validation happens before focus, pointer or button effects.
export function verificationRegion (value) {
  if (value === undefined) return undefined
  const tokens = typeof value === 'string' ? value.trim().split(/[,\s]+/) : null
  const parts = tokens ? (tokens.some(token => !token) ? [] : tokens.map(Number))
    : value && typeof value === 'object' && !Array.isArray(value)
      ? [value.x, value.y, value.width, value.height] : []
  const [x, y, width, height] = parts
  if (parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n > -2147483648 && n <= 2147483647) ||
      width <= 0 || height <= 0 || width * height > 16777216 ||
      x + width > 2147483647 || y + height > 2147483647) {
    throw Object.assign(new Error('verificationRegion must be "x,y,width,height" in integer screen pixels with positive size (maximum 16M pixels). No input was dispatched.'),
      { code: 'INVALID_VERIFICATION_REGION', outcome: 'not-dispatched' })
  }
  return { x, y, width, height }
}
