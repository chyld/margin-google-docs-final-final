// What counts as a Margin image: the size limit, the accepted types, and how notes refer to images.
// No dependencies (no Tiptap), so the server's upload guard and the browser can both use it.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** The accepted image types, and the extension each is stored under. */
export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const
export type ImageType = keyof typeof IMAGE_TYPES

export function isImageType(value: string): value is ImageType {
  return Object.hasOwn(IMAGE_TYPES, value)
}

const ID = '[0-9a-f]{64}' // the SHA-256 of the image's bytes
const EXT = Object.values(IMAGE_TYPES).join('|')

/** An image id on its own. */
export const IMAGE_ID = new RegExp(`^${ID}$`)
/** A stored image's file name: its id plus an extension. */
export const IMAGE_NAME = new RegExp(`^(${ID})\\.(${EXT})$`)
/** The src of an image stored by this server, as documents hold it. */
export const IMAGE_SRC = new RegExp(`^/api/images/${ID}\\.(?:${EXT})$`)

/** Every image id a stored note or a local draft refers to (decides which images the cleanup keeps). */
export function imageIdsIn(text: string): string[] {
  return [...text.matchAll(new RegExp(`/api/images/(${ID})\\.(?:${EXT})`, 'g'))].map(match => match[1] as string)
}
