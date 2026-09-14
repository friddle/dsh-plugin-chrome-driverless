/**
 * Screenshot plumbing: chrome-driverless returns base64 PNG, DSH wants a
 * durable attachment reference.
 *
 * The conversion is deliberately best-effort. `attachments` is a host service
 * that not every profile mounts, and a browser tool that refuses to navigate
 * because it cannot *show* the result would be useless — so when the service is
 * missing the tool still returns its text and the caller learns why the image
 * is absent.
 *
 * @module chrome-driverless/images
 */

/** Media type the service always produces. */
export const SCREENSHOT_MEDIA_TYPE = 'image/png'

/**
 * Store one base64 screenshot in the attachment service.
 *
 * @param {object|undefined} attachments - `ctx.get('attachments')`, when mounted.
 * @param {string} base64 - the service's `image` field.
 * @param {string} [name] - display name; never a path.
 * @returns {Promise<object|undefined>} a JSON-safe image reference for the tool's canonical value.
 * @throws {Error} when the service is mounted but refuses the image (byte/dimension caps).
 */
export async function saveScreenshot(attachments, base64, name = 'screenshot.png') {
  if (attachments === undefined || attachments === null) return undefined
  if (typeof attachments.saveImage !== 'function') return undefined
  if (typeof base64 !== 'string' || base64 === '') return undefined

  const data = Buffer.from(base64, 'base64')
  if (data.byteLength === 0) return undefined

  const ref = await attachments.saveImage({ data, mediaType: SCREENSHOT_MEDIA_TYPE, name })
  return imageRefToValue(ref)
}

/**
 * Project one durable attachment reference into the canonical tool value.
 *
 * @param {object} ref - the attachment service's reference.
 * @returns {object} the JSON-safe subset the output schema declares.
 */
export function imageRefToValue(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

/**
 * Build the image content block for a stored screenshot.
 *
 * @param {object} value - one {@link imageRefToValue} projection.
 * @returns {{type: 'image', attachment: object}} the block `render` returns.
 */
export function imageBlock(value) {
  return { type: 'image', attachment: { ...value } }
}

/**
 * Describe a screenshot for the model's text stream.
 *
 * @param {object|undefined} value - the stored reference, or undefined.
 * @param {string} [fallback] - what to say when no image could be stored.
 * @returns {string} one line appended to the tool's text block.
 */
export function describeScreenshot(value, fallback = 'screenshot not attached (no attachment service is mounted)') {
  if (value === undefined) return fallback
  return `screenshot ${value.width}x${value.height} px, ${value.bytes} bytes`
}
