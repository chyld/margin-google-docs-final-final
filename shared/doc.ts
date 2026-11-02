// Validates a stored Tiptap document, strips unsafe attributes and extracts its plain text.
// The allowlists must match the editor's extensions (shared/extensions.ts). Structure is checked
// separately against the real editor schema (shared/schema.ts).
import { HEADING_LEVELS as EDITOR_HEADING_LEVELS, TEXT_ALIGNMENTS as EDITOR_TEXT_ALIGNMENTS } from './extensions.ts'
import { IMAGE_ALIGNMENTS, IMAGE_SRC } from './image.ts'
import { schema } from './schema.ts'
import { isUuid } from './styleProps.ts'

const NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'image',
  'details',
  'detailsSummary',
  'detailsContent',
])

const MARK_TYPES = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'textStyle',
  'highlight',
  'namedStyle',
])

// Nodes that end a line of plain text.
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'detailsSummary',
  'detailsContent',
])

const TEXT_ALIGNMENTS = new Set<unknown>(EDITOR_TEXT_ALIGNMENTS)
const HEADING_LEVELS = new Set<unknown>(EDITOR_HEADING_LEVELS)
const IMAGE_ALIGN = new Set<unknown>(IMAGE_ALIGNMENTS)
// prosemirror-tables only renders these for cells (no justify).
const CELL_ALIGN = new Set<unknown>(['left', 'center', 'right'])
const TABLE_CELLS = new Set(['tableCell', 'tableHeader'])

export const MAX_DEPTH = 100
export const MAX_NODES = 200_000
export const SNIPPET_LENGTH = 140

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

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] } as const

type Json = Record<string, unknown>

export type InspectResult = { ok: true; text: string; doc: Json } | { ok: false; error: string }

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

// Numbers, or numeric strings as parsed from HTML attributes.
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value)
  return null
}

function inRange(value: unknown, min: number, max: number): number | null {
  const number = toNumber(value)
  return number !== null && number >= min && number <= max ? number : null
}

// Attributes the editor's schema defines for each node and mark type. Anything else is dropped:
// the editor would ignore it anyway, and it shouldn't be stored for other readers of the JSON.
function knownAttrs(spec: { attrs?: Record<string, unknown> | null } | undefined, attrs: Json): Json {
  const allowed = spec?.attrs ? Object.keys(spec.attrs) : []
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => allowed.includes(key)))
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type MarkResult = { mark: Json | null } | { error: string }

// Returns a cleaned copy of the mark, null to drop it, or an error.
function cleanMark(mark: unknown): MarkResult {
  if (!isPlainObject(mark) || typeof mark.type !== 'string') return { error: 'mark must be an object with a type' }
  if (!MARK_TYPES.has(mark.type)) return { error: `unsupported mark type "${mark.type}"` }
  if (mark.attrs !== undefined && mark.attrs !== null && !isPlainObject(mark.attrs)) {
    return { error: `attrs of mark "${mark.type}" must be an object` }
  }

  const attrs = isPlainObject(mark.attrs) ? knownAttrs(schema.marks[mark.type]?.spec, mark.attrs) : undefined
  if ((mark.type === 'textStyle' || mark.type === 'highlight') && attrs) {
    // A value we can't vouch for is dropped rather than failing the whole save. Only formatting is
    // lost, never text.
    if (attrs.color !== undefined && attrs.color !== null && !isSafeColor(attrs.color)) attrs.color = null
  }
  if (mark.type === 'textStyle' && attrs) {
    if (attrs.fontFamily !== undefined && attrs.fontFamily !== null && !isSafeFontFamily(attrs.fontFamily)) {
      attrs.fontFamily = null
    }
    if (attrs.fontSize !== undefined && attrs.fontSize !== null && !isSafeFontSize(attrs.fontSize)) {
      attrs.fontSize = null
    }
  }
  // A saved-style tag is only a uuid; the look comes from the user's style definitions.
  if (mark.type === 'namedStyle' && !isUuid(attrs?.id)) return { mark: null }
  if (mark.type === 'link' && !isSafeLink(attrs?.href)) {
    // Keep the text, lose the link.
    return { mark: null }
  }
  return { mark: attrs ? { ...mark, attrs } : { ...mark } }
}

// Cleans node-specific attributes in place. Returns an error for values that can't be fixed
// without losing content.
function cleanNodeAttrs(type: string, attrs: Json): string | null {
  if (type === 'image') {
    // Never silently drop an image: the client only creates Margin srcs, so anything else is a bug
    // worth surfacing (the save fails and the local draft is kept).
    if (typeof attrs.src !== 'string' || !IMAGE_SRC.test(attrs.src)) return 'Image source not allowed'
    for (const key of ['width', 'height'] as const) {
      if (attrs[key] !== undefined && attrs[key] !== null) attrs[key] = inRange(attrs[key], 1, 10_000)
    }
    for (const key of ['alt', 'title'] as const) {
      const value = attrs[key]
      if (value === undefined || value === null) continue
      const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
      attrs[key] = typeof text === 'string' && text.length <= 1000 ? text : null
    }
    if (attrs.align !== undefined && attrs.align !== null && !IMAGE_ALIGN.has(attrs.align)) attrs.align = null
  }

  if (TABLE_CELLS.has(type)) {
    // Spans are layout, not content: odd values from pasted HTML (0, 150, "2") are clamped rather
    // than rejected, which would make the whole note unsaveable.
    for (const key of ['colspan', 'rowspan'] as const) {
      if (attrs[key] === undefined) continue
      const span = toNumber(attrs[key])
      attrs[key] = span === null || span < 1 ? 1 : Math.min(100, Math.floor(span))
    }
    if (attrs.colwidth !== undefined && attrs.colwidth !== null) {
      // prosemirror-tables writes 0 for columns without a set width, and fractional widths while
      // dragging; JSON turns NaN into null.
      const colspan = typeof attrs.colspan === 'number' ? attrs.colspan : 1
      const widths = Array.isArray(attrs.colwidth) ? attrs.colwidth.map(width => (width === null ? 0 : inRange(width, 0, 10_000))) : []
      attrs.colwidth = widths.length === colspan && widths.every(width => width !== null) ? widths : null
    }
    if (attrs.align !== undefined && attrs.align !== null && !CELL_ALIGN.has(attrs.align)) attrs.align = null
  }

  if (type === 'details' && attrs.open !== undefined && typeof attrs.open !== 'boolean') attrs.open = false
  return null
}

/** Validates `value` as a Margin document. Returns a cleaned copy and its plain text. */
export function inspectDoc(value: unknown): InspectResult {
  if (!isPlainObject(value) || value.type !== 'doc') {
    return { ok: false, error: 'content must be a document with type "doc"' }
  }

  const parts: string[] = []
  let nodeCount = 0

  // Returns a cleaned copy of the node, or an error message.
  function walk(node: unknown, depth: number): { node: Json } | { error: string } {
    if (depth > MAX_DEPTH) return { error: `document is nested deeper than ${MAX_DEPTH} levels` }
    nodeCount += 1
    if (nodeCount > MAX_NODES) return { error: `document has more than ${MAX_NODES} nodes` }

    if (!isPlainObject(node) || typeof node.type !== 'string') return { error: 'node must be an object with a type' }
    if (!NODE_TYPES.has(node.type)) return { error: `unsupported node type "${node.type}"` }
    if (node.type === 'doc' && depth > 0) return { error: 'a document cannot contain another document' }

    const copy: Json = { ...node }

    if (node.attrs !== undefined && node.attrs !== null) {
      if (!isPlainObject(node.attrs)) return { error: `attrs of node "${node.type}" must be an object` }
      const attrs = knownAttrs(schema.nodes[node.type]?.spec, node.attrs)
      if (node.type === 'heading' && !HEADING_LEVELS.has(attrs.level)) {
        return { error: `heading level must be between 1 and ${EDITOR_HEADING_LEVELS.length}` }
      }
      if (attrs.textAlign !== undefined && attrs.textAlign !== null && !TEXT_ALIGNMENTS.has(attrs.textAlign)) {
        attrs.textAlign = null
      }
      if (attrs.styleId !== undefined && attrs.styleId !== null && !isUuid(attrs.styleId)) attrs.styleId = null
      const error = cleanNodeAttrs(node.type, attrs)
      if (error) return { error }
      copy.attrs = attrs
    } else if (node.type === 'image') {
      return { error: 'Image source not allowed' }
    }

    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return { error: 'marks must be an array' }
      const marks: Json[] = []
      for (const mark of node.marks) {
        const result = cleanMark(mark)
        if ('error' in result) return result
        if (result.mark) marks.push(result.mark)
      }
      copy.marks = marks
    }

    if (node.type === 'text') {
      if (typeof node.text !== 'string') return { error: 'text node must have a string "text"' }
      parts.push(node.text)
      return { node: copy }
    }
    if (node.type === 'hardBreak') {
      parts.push('\n')
      return { node: copy }
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return { error: `content of node "${node.type}" must be an array` }
      const content: Json[] = []
      for (const child of node.content) {
        const result = walk(child, depth + 1)
        if ('error' in result) return result
        content.push(result.node)
      }
      copy.content = content
    }

    if (BLOCK_TYPES.has(node.type)) parts.push('\n')
    return { node: copy }
  }

  const result = walk(value, 0)
  if ('error' in result) return { ok: false, error: result.error }

  const text = parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return { ok: true, text, doc: result.node }
}

/** First characters of the note's text, on one line. */
export function makeSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= SNIPPET_LENGTH) return oneLine
  return `${oneLine.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`
}
