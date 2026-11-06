// Coordinate metadata is transport-independent; attachments and MCP content
// must describe the same captured pixels without serializing binary bytes as text.
export function captureCoordinates (region, imageSize) {
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
      region.width <= 0 || region.height <= 0 || !Array.isArray(imageSize) || imageSize.length !== 2 ||
      !imageSize.every(n => Number.isFinite(n) && n > 0)) return null
  return { screenOrigin: [region.x, region.y], imageSize,
    screenPerImagePixel: [region.width / imageSize[0], region.height / imageSize[1]] }
}

export function imageMime (bytes, declared) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (declared === 'image/png' || declared === 'image/jpeg') return declared
  throw new Error('IMAGE_FORMAT_UNKNOWN: missing supported image signature or MIME')
}

export function splitMediaResult (value) {
  const images = []
  const clean = (input, location) => {
    if (Buffer.isBuffer(input)) return undefined
    if (Array.isArray(input)) return input.map((child, i) => clean(child, `${location}[${i}]`))
    if (!input || typeof input !== 'object') return input
    const output = {}
    for (const [key, child] of Object.entries(input)) {
      if (!Buffer.isBuffer(child)) output[key] = clean(child, `${location}.${key}`)
    }
    const bytes = Buffer.isBuffer(input.annotated) ? input.annotated
      : Buffer.isBuffer(input.image) ? input.image : Buffer.isBuffer(input.raw) ? input.raw : null
    if (bytes) {
      const mime = imageMime(bytes, input.mime)
      output.mime = mime
      const coordinates = captureCoordinates(input.region, input.imageSize)
      if (coordinates) output.coordinates = coordinates
      images.push({ bytes, mime, location, metadata: output })
    }
    return output
  }
  const text = clean(value, 'result')
  const latest = images.at(-1)
  for (const entry of images) entry.metadata.imageStatus = entry === latest ? 'attached' : 'omitted-earlier-batch-image'
  return { value: text, ...(latest ? { image: latest.bytes, mime: latest.mime, imageSource: latest.location } : {}) }
}
