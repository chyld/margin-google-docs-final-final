// Values that end up inside a style attribute or an href: what's safe to keep. No dependencies (no
// Tiptap), so the document validator, saved styles and the link popover can all use it.

// Colors end up inside a style attribute. Allow hex, CSS color functions and keywords, but nothing
// that can end the value early (no ";", quotes, colons or nested parentheses). Pasted HTML brings
// all of these forms, including oklch() and var() from modern sites.
const COLOR_FUNCTIONS = 'rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|var'
const SAFE_COLOR = new RegExp(`^(?:#[0-9a-f]{3,8}|(?:${COLOR_FUNCTIONS})\\([\\w.%\\s,/+#-]*\\)|[a-z]+)$`, 'i')
const SAFE_LINK = /^(?:(?:https?|mailto|tel):|\/(?!\/)|#)/i

// Font families also end up in a style attribute. Each list item is a quoted name or bare words;
// quotes must balance, otherwise a stray quote would swallow the rest of the style declarations.
const FONT_NAME = String.raw`(?:"[^"'\\;:(){}<>\x00-\x1f\x7f]{1,100}"|'[^"'\\;:(){}<>\x00-\x1f\x7f]{1,100}'|[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)`
const SAFE_FONT_FAMILY = new RegExp(`^\\s*${FONT_NAME}(?:\\s*,\\s*${FONT_NAME}){0,19}\\s*$`)
// Browsers write computed sizes with many decimals (e.g. 14.666666666666666px).
const FONT_SIZE = /^(\d{1,3}(?:\.\d{1,20})?)(pt|px|em|rem|%)$/
const FONT_SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'smaller',
  'larger',
])

export function isSafeColor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && SAFE_COLOR.test(value.trim())
}

/** Web, email, phone and same-site links. Browsers ignore control characters, so strip them first. */
export function isSafeLink(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return SAFE_LINK.test(value.replace(/[\u0000- \u007f-\u009f]/g, ''))
}

export function isSafeFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 600 && SAFE_FONT_FAMILY.test(value)
}

export function isSafeFontSize(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (FONT_SIZE_KEYWORDS.has(trimmed)) return true
  const match = FONT_SIZE.exec(trimmed)
  if (!match) return false
  const size = Number(match[1])
  return size > 0 && size <= 400
}
