import { basename } from 'node:path'
import { visionEvidence } from './feedback.js'
import { captureCoordinates } from './media-contract.js'

export function screenshotMetadata (shot) {
  const value = {}
  for (const key of ['capturedAt', 'ts', 'imageSize', 'settled', 'settleMs', 'settleDiffPct', 'settleNote',
    'cursor', 'cursorRequested', 'cursorDrawn', 'cursorScreenPos', 'cursorInImage', 'cursorNote']) {
    if (shot[key] !== undefined) value[key] = shot[key]
  }
  return value
}

function setCoordinates (value, size) {
  const coordinates = captureCoordinates(value.region, size)
  if (!coordinates) { delete value.coordinates; delete value.coordinateRule; return }
  value.coordinates = coordinates
  value.coordinateRule = 'screen = screenOrigin + imagePixel * screenPerImagePixel (per axis). Do not apply DPI or browser zoom again. After resize/move/zoom, obtain fresh evidence.'
}

const validImageSize = size => Array.isArray(size) && size.length === 2 && size.every(n => Number.isFinite(n) && n > 0)
const validPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)

export function screenshotPathOnly (value, reason) {
  value.imageStatus = 'path-only'
  value.imageReason = reason
  setCoordinates(value, value.imageSize)
  const notes = {
    'model-text-only': 'Image not attached: this model does not declare image input. Use UIA/text or switch to an image-capable model.',
    'delivery-path': 'Path delivery requested: no image block was attached. The file is on path; call read_image only if visual inspection is actually needed.',
    'earlier-batch-image': 'This earlier capture is available at its path.',
  }
  value.view = notes[reason] || 'Image not attached. Use read_image on path if visual inspection is needed.'
  if (value.settled === false) value.view = 'NOT settled — re-shoot. ' + value.view
  return value
}

// DSH image blocks reference the host's durable attachment store. Paths and raw
// base64 are not image blocks. Keep a usable file when a route cannot accept one.
export async function attachScreenshot (ctx, exec, value, data, options = {}) {
  const fallback = reason => screenshotPathOnly(value, reason)
  // delivery:"path" — the caller has another way to verify (UIA/OCR/window text), so the pixels
  // are not evidence it will read. The file is still written and the path still returned; only
  // the image block is withheld, which is what keeps it out of the re-sent conversation history.
  if (options.delivery === 'path') return fallback('delivery-path')
  const blocked = () => exec?.signal?.aborted || options.blocked?.()
  try {
    const interrupted = () => fallback(exec?.signal?.aborted ? 'cancelled' : 'cancelled-or-paused')
    if (blocked()) return interrupted()
    if (!validImageSize(value.imageSize)) return fallback('invalid-source-image-size')
    const sourceSize = [...value.imageSize]
    const attachments = ctx.get?.('attachments')
    const llm = ctx.get?.('llm')
    if (!attachments?.saveImage) return fallback('attachments-unavailable')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!llm?.resolveModelInfo || !provider || !model) return fallback('route-unavailable')
    const active = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!active.inputModalities?.includes('image')) return fallback('model-text-only')
    if (blocked()) return interrupted()
    if (!attachments.imageLimits?.mediaTypes?.includes(value.mime)) return fallback('media-type-unavailable')
    const image = await attachments.saveImage({ data, mediaType: value.mime, name: basename(value.path) })
    if (blocked()) return interrupted()
    const attachedSize = [image?.width, image?.height]
    if (!validImageSize(attachedSize)) return fallback('invalid-attachment-image-size')
    const evidence = visionEvidence(exec, { ...options, adapterVersion: active.adapterVersion || 'unversioned' })
    const resized = attachedSize.some((n, axis) => n !== sourceSize[axis])
    if (resized) {
      value.sourceImageSize = sourceSize
      if (validPoint(value.cursorInImage)) {
        value.sourceCursorInImage = { ...value.cursorInImage }
        value.cursorInImage = { x: value.cursorInImage.x * attachedSize[0] / sourceSize[0],
          y: value.cursorInImage.y * attachedSize[1] / sourceSize[1] }
      } else delete value.cursorInImage
      value.imageSize = attachedSize
    }
    value.image = image
    value.imageStatus = 'attached'
    delete value.imageReason
    setCoordinates(value, attachedSize)
    if (resized && value.coordinateRule) value.coordinateRule += ' imageSize, cursorInImage and coordinates describe the attached image. path retains the original capture: use sourceImageSize and sourceCursorInImage for that file; map its pixels using region.width/sourceImageSize[0] and region.height/sourceImageSize[1].'
    value.view = value.settled === false
      ? 'NOT settled — may be a partial render; re-shoot.'
      : 'Image attached. Inspect it directly; no read_image needed. Coordinates for clicks are screen pixels.'
    value.visionEvidence = evidence
    if (value.visionEvidence.grounding === 'failed') {
      value.visionStatus = 'unverified-route'
      value.view = 'Image transport succeeded, but a current route record reports failed grounding. Use UIA/text readback; the image and path remain available. See visionEvidence for the scope and expiry.'
    } else {
      value.visionStatus = value.visionEvidence.grounding === 'verified' ? 'grounding-verified' : 'grounding-unverified'
    }
    return value
  } catch (error) {
    // Capturing succeeded; an optional image channel must not discard its path.
    return fallback(exec?.signal?.aborted ? 'cancelled' : 'attachment-failed')
  }
}

export function renderScreenshot (value) {
  const { image, ...text } = value
  return [
    { type: 'text', text: JSON.stringify(text) },
    ...(image ? [{ type: 'image', attachment: image }] : []),
  ]
}

// If no automatic checkpoint exists (including after a failed step), identify the
// last successful explicit capture by its actual step, not the end of the batch.
export function selectBatchScreenshot (result, automatic, kind = 'image') {
  const index = automatic ? -1 : result.actions.findLastIndex(a => a.tool === 'computer_shot' && a.result?.path)
  const latest = automatic ?? result.actions[index]?.result
  if (latest) {
    result.observation = latest
    if (kind === 'state') result.observationSource = 'automatic final UIA state'
    else result.imageSource = automatic ? 'automatic final screenshot' : `action ${index + 1}; captured before any later actions`
    result.view = latest.view
  }
  return result
}
