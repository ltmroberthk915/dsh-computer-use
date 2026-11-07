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

function restoreFileGeometry (value) {
  if (!value.sourceImageSize) return
  value.imageSize = value.sourceImageSize
  if (value.sourceCursorInImage) value.cursorInImage = value.sourceCursorInImage
  else delete value.cursorInImage
  delete value.sourceImageSize
  delete value.sourceCursorInImage
  setCoordinates(value, value.imageSize)
}

// DSH image blocks reference the host's durable attachment store. Paths and raw
// base64 are not image blocks. Keep a usable file when a route cannot accept one.
export async function attachScreenshot (ctx, exec, value, data, options = {}) {
  // The local file has geometry even when the model route cannot accept images.
  setCoordinates(value, value.imageSize)
  const fallback = (reason) => {
    delete value.image
    restoreFileGeometry(value)
    value.imageStatus = 'path-only'
    value.imageReason = reason
    value.view = reason === 'model-text-only'
      ? 'Image not attached: this model does not declare image input. Use UIA/text or switch to an image-capable model.'
      : reason === 'delivery-path'
        ? 'Path delivery requested: no image block was attached. The file is on path; call read_image only if visual inspection is actually needed.'
        : 'Image not attached. Use read_image on path if visual inspection is needed.'
    if (value.settled === false) value.view = 'NOT settled — re-shoot. ' + value.view
    return value
  }
  // delivery:"path" — the caller has another way to verify (UIA/OCR/window text), so the pixels
  // are not evidence it will read. The file is still written and the path still returned; only
  // the image block is withheld, which is what keeps it out of the re-sent conversation history.
  if (options.delivery === 'path') return fallback('delivery-path')
  try {
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
    if (exec?.signal?.aborted) return fallback('cancelled')
    if (!attachments.imageLimits?.mediaTypes?.includes(value.mime)) return fallback('media-type-unavailable')
    const image = await attachments.saveImage({ data, mediaType: value.mime, name: basename(value.path) })
    if (exec?.signal?.aborted) return fallback('cancelled')
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

// A batch exposes one latest image as its checkpoint. Earlier explicit captures
// keep their paths for deliberate later reads, without multiplying vision input.
//
// `delivery` is the batch-level request, and it has to reach further than the checkpoint: when
// no checkpoint happens (shot:"never", a readback tail, or a later failure) the observation
// falls back to the last explicit step image. A batch that asked for paths must not hand one
// back as a picture just because the checkpoint was skipped — same pixels, quieter route.
export function selectBatchScreenshot (result, automatic, kind = 'image', delivery = 'auto') {
  let latest = automatic
  let index
  if (!latest) {
    for (const [i, action] of result.actions.entries()) {
      if (action.tool === 'computer_shot' && action.result?.path) {
        latest = action.result
        index = i
      }
    }
  }
  const pathDelivery = delivery === 'path'
  const pathNote = 'Path delivery requested: no image block was attached. Use read_image on this path only if these pixels are the evidence.'
  for (const action of result.actions) {
    const shot = action.result
    if (shot?.image && shot !== latest) {
      delete shot.image
      restoreFileGeometry(shot)
      shot.imageStatus = 'path-only'
      shot.imageReason = pathDelivery ? 'delivery-path' : 'earlier-batch-image'
      shot.view = pathDelivery
        ? pathNote
        : kind === 'state'
          ? 'A newer UIA state is returned. This earlier image remains at its path.'
          : 'Only the latest batch screenshot is attached. Use read_image on this path if this earlier frame is needed.'
    }
  }
  if (latest) {
    if (pathDelivery && latest.image) {
      delete latest.image
      restoreFileGeometry(latest)
      latest.imageStatus = 'path-only'
      latest.imageReason = 'delivery-path'
      latest.view = pathNote
    }
    result.observation = latest
    if (kind === 'state') result.observationSource = 'automatic final UIA state'
    else result.imageSource = automatic ? 'automatic final screenshot' : `action ${index + 1}; captured before any later actions`
    result.view = latest.view
  }
  return result
}
