// Saved ("named") styles: what a style may contain, in one canonical form. Shared by the server
// (validation, storage) and the client (capture, CSS). No imports from doc.ts or extensions.ts, so
// both can use this module without an import cycle.

export const BLOCK_TYPES = ['paragraph', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
export const STYLE_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const

export type StyleBlock = (typeof BLOCK_TYPES)[number]
export type StyleAlign = (typeof STYLE_ALIGNMENTS)[number]

export type StyleProps = {
  fontFamily?: string
  fontSize?: string
  color?: string
  highlight?: string
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  block?: StyleBlock
  align?: StyleAlign
}

export type NamedStyle = {
  id: string
  name: string
  props: StyleProps
  /** 1, 2, 3…: stable favorite position (and shortcut number for 1–9); null when not a favorite. */
  favoriteSlot: number | null
  /** Deleted styles stay so text that uses them keeps its look; they're hidden from menus. */
  deleted: boolean
  createdAt: number
  updatedAt: number
}

export const MAX_STYLE_NAME = 60
export const MAX_PROPS_JSON = 2048
export const INLINE_KEYS = ['fontFamily', 'fontSize', 'color', 'highlight', 'bold', 'italic', 'underline', 'strike'] as const
export const BLOCK_KEYS = ['block', 'align'] as const
const FLAG_KEYS = ['bold', 'italic', 'underline', 'strike'] as const
const KEY_ORDER = [...INLINE_KEYS, ...BLOCK_KEYS] as const

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The same rules as the document validator (shared/doc.ts), restricted further: these values are
// written into a generated stylesheet, so nothing that could end a declaration or a rule.
// No control characters either: a newline inside a quoted name would end the CSS string early.
const FONT_NAME = String.raw`(?:"[^"'\\;:(){}<>\x00-\x1f\x7f]{1,100}"|'[^"'\\;:(){}<>\x00-\x1f\x7f]{1,100}'|[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)`
const SAFE_FONT_FAMILY = new RegExp(`^\\s*${FONT_NAME}(?:\\s*,\\s*${FONT_NAME}){0,19}\\s*$`)
const HEX = /^#[0-9a-f]{6}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Lowercase #rrggbb from #rgb, #rrggbb or rgb()/rgba() (opaque); null for anything else. */
export function canonicalColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  if (HEX.test(text)) return text
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(1|1\.0+|0?\.\d+|0)\s*)?\)$/.exec(text)
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 1) return null
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number)
    if (parts.some(part => part > 255)) return null
    return `#${parts.map(part => part.toString(16).padStart(2, '0')).join('')}`
  }
  return null
}

/** "<n>pt" with up to one decimal, 1–400; null otherwise. Accepts "14", "14pt", "14.0pt". */
export function canonicalFontSize(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*(pt)?\s*$/.exec(String(value))
  if (!match) return null
  const size = Math.round(Number(match[1]) * 10) / 10
  return size >= 1 && size <= 400 ? `${size}pt` : null
}

export function canonicalFontFamily(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 600 || !SAFE_FONT_FAMILY.test(value)) return null
  return value.trim().replace(/\s*,\s*/g, ', ')
}

/**
 * Cleans style props into canonical form. Returns null for anything invalid: unknown keys, unsafe
 * values, or nothing at all (a style must set at least one part).
 */
export function cleanStyleProps(value: unknown): StyleProps | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const props: StyleProps = {}
  for (const key of Object.keys(input)) {
    if (!(KEY_ORDER as readonly string[]).includes(key)) return null
    const raw = input[key]
    if (raw === undefined || raw === null) continue
    switch (key) {
      case 'fontFamily': {
        const family = canonicalFontFamily(raw)
        if (!family) return null
        props.fontFamily = family
        break
      }
      case 'fontSize': {
        const size = canonicalFontSize(raw)
        if (!size) return null
        props.fontSize = size
        break
      }
      case 'color':
      case 'highlight': {
        const color = canonicalColor(raw)
        if (!color) return null
        props[key] = color
        break
      }
      case 'block':
        if (!(BLOCK_TYPES as readonly unknown[]).includes(raw)) return null
        props.block = raw as StyleBlock
        break
      case 'align':
        if (!(STYLE_ALIGNMENTS as readonly unknown[]).includes(raw)) return null
        props.align = raw as StyleAlign
        break
      default:
        // bold, italic, underline, strike: only `true` means anything ("set"); false is "not part".
        if (raw === true) props[key as (typeof FLAG_KEYS)[number]] = true
        else if (raw !== false) return null
    }
  }
  if (Object.keys(props).length === 0) return null
  return JSON.stringify(canonicalProps(props)).length <= MAX_PROPS_JSON ? canonicalProps(props) : null
}

/** The same props with keys in a fixed order (stable JSON). */
export function canonicalProps(props: StyleProps): StyleProps {
  const out: Record<string, unknown> = {}
  for (const key of KEY_ORDER) if (props[key] !== undefined) out[key] = props[key]
  return out as StyleProps
}

export function hasInlineParts(props: StyleProps): boolean {
  return INLINE_KEYS.some(key => props[key] !== undefined)
}

export function hasBlockParts(props: StyleProps): boolean {
  return BLOCK_KEYS.some(key => props[key] !== undefined)
}

/**
 * Cleans a style name: NFC, no control or bidi/format characters, single spaces, trimmed, 1–60
 * characters. Returns null when nothing is left or it's too long.
 */
export function cleanStyleName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length === 0 || [...name].length > MAX_STYLE_NAME) return null
  return name
}

/** Case-insensitive key for uniqueness (Unicode-aware, unlike SQLite's NOCASE). */
export function styleNameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('und')
}

// Typography of the built-in paragraph types, matching web/src/styles/editor.css. A paragraph style
// with a block type takes this look from generated CSS, so changing the style's type later restyles
// every use, even where the node type itself couldn't change (e.g. the first line of a list item).
export type BlockLook = { fontSize: string; fontWeight: number; lineHeight: string; color: string; fontStyle: string; margin: string }
export const BLOCK_TYPOGRAPHY: Record<StyleBlock, BlockLook> = {
  paragraph: { fontSize: '11pt', fontWeight: 400, lineHeight: '1.6', color: '#202124', fontStyle: 'normal', margin: '0' },
  h1: { fontSize: '20pt', fontWeight: 400, lineHeight: '1.25', color: '#202124', fontStyle: 'normal', margin: '1.2em 0 0.4em' },
  h2: { fontSize: '16pt', fontWeight: 400, lineHeight: '1.25', color: '#202124', fontStyle: 'normal', margin: '1.2em 0 0.4em' },
  h3: { fontSize: '14pt', fontWeight: 400, lineHeight: '1.25', color: '#434343', fontStyle: 'normal', margin: '1.2em 0 0.4em' },
  h4: { fontSize: '12pt', fontWeight: 700, lineHeight: '1.25', color: '#666666', fontStyle: 'normal', margin: '1.2em 0 0.4em' },
  h5: { fontSize: '11pt', fontWeight: 700, lineHeight: '1.25', color: '#666666', fontStyle: 'normal', margin: '1.2em 0 0.4em' },
  h6: { fontSize: '11pt', fontWeight: 400, lineHeight: '1.25', color: '#666666', fontStyle: 'italic', margin: '1.2em 0 0.4em' },
}

/**
 * CSS declarations for a style. `inline` styles tagged text (every use of a style tags its text);
 * `block` gives linked paragraphs the heading look and alignment; `blockMargin` is the heading
 * spacing, only for top-level paragraphs (list lines keep their own spacing). Values are
 * re-validated here (never trust storage).
 */
export function styleDeclarations(rawProps: unknown): { inline: string[]; block: string[]; blockMargin: string | null } | null {
  const props = cleanStyleProps(rawProps)
  if (!props) return null
  const inline: string[] = []
  if (props.fontFamily) inline.push(`font-family: ${props.fontFamily}`)
  if (props.fontSize) inline.push(`font-size: ${props.fontSize}`)
  if (props.color) inline.push(`color: ${props.color}`)
  if (props.highlight) inline.push(`background-color: ${props.highlight}`)
  if (props.bold) inline.push('font-weight: 700')
  if (props.italic) inline.push('font-style: italic')
  const lines = [props.underline && 'underline', props.strike && 'line-through'].filter(Boolean)
  if (lines.length) inline.push(`text-decoration-line: ${lines.join(' ')}`)

  const block: string[] = []
  let blockMargin: string | null = null
  if (props.block) {
    const look = BLOCK_TYPOGRAPHY[props.block]
    block.push(
      `font-size: ${look.fontSize}`,
      `font-weight: ${look.fontWeight}`,
      `line-height: ${look.lineHeight}`,
      `color: ${look.color}`,
      `font-style: ${look.fontStyle}`,
    )
    // Normal text keeps the page's own paragraph spacing.
    if (props.block !== 'paragraph') blockMargin = look.margin
  }
  if (props.align) block.push(`text-align: ${props.align}`)
  return { inline, block, blockMargin }
}

/** The stylesheet for a user's styles. Ids must be uuids, so nothing can break out of a rule. */
export function stylesheetFor(styles: Array<Pick<NamedStyle, 'id' | 'props'>>): string {
  const rules: string[] = []
  for (const style of styles) {
    if (!isUuid(style.id)) continue
    const declarations = styleDeclarations(style.props)
    if (!declarations) continue
    const props = cleanStyleProps(style.props)
    if (declarations.inline.length) rules.push(`.document span[data-style="${style.id}"] { ${declarations.inline.join('; ')}; }`)
    // Links have their own blue; a style's color should reach them too (inline tweaks still win).
    if (props?.color) rules.push(`.document span[data-style="${style.id}"] a { color: ${props.color}; }`)
    if (declarations.block.length) rules.push(`.document [data-style-id="${style.id}"] { ${declarations.block.join('; ')}; }`)
    if (declarations.blockMargin) rules.push(`.document > [data-style-id="${style.id}"] { margin: ${declarations.blockMargin}; }`)
  }
  // As in editor.css: the document's first block sits flush with the top of the page.
  if (rules.length) rules.push('.document > [data-style-id]:first-child { margin-top: 0; }')
  return rules.join('\n')
}
