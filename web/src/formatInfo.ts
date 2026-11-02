// What formatting the selection has, and where each part comes from: the Format sidebar's
// data. A leaf module (no editor or app imports), so the toolbar's helpers can use it too.
import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { DEFAULT_FONT, firstFontFamily } from '../../shared/fonts.ts'
import { BLOCK_TYPOGRAPHY, canonicalColor } from '../../shared/styleProps.ts'
import type { NamedStyle, StyleBlock, StyleProps } from '../../shared/styleProps.ts'

/**
 * Where a value comes from:
 * direct (a mark on the text), style (a saved style), element (how the page draws links, code,
 * quotes, table headers…; see `label`), default (the page or heading default), unresolved (a style
 * that hasn't loaded or doesn't exist), mixed (values differ), mixed-sources (same value, different
 * origins).
 */
export type Source = 'direct' | 'style' | 'element' | 'default' | 'unresolved' | 'mixed' | 'mixed-sources'

export type Field<T> = {
  /** null when mixed or unresolved (check `source`). */
  value: T | null
  source: Source
  /** The style that supplies it (source 'style'). */
  styleId?: string
  /** What draws it (source 'element'): "Link", "Code", "Quote", "Table header", "Collapsible title". */
  label?: string
}

export type StylesStatus = 'loading' | 'loaded' | 'failed'

export type StyleRef =
  | { kind: 'none' }
  /** `ids`: up to three of the styles involved; `total`: how many (null = no style counts). */
  | { kind: 'mixed'; ids: string[]; total: number }
  | { kind: 'style'; id: string; name: string; deleted: boolean; props: StyleProps }
  | { kind: 'unresolved'; id: string; status: StylesStatus }

export type BlockType = StyleBlock | 'other'
export type Align = 'left' | 'center' | 'right' | 'justify'

export type FormatInfo = {
  styles: { text: StyleRef; paragraph: StyleRef }
  block: Field<BlockType>
  align: Field<Align>
  /** Containers around the cursor (the selection's start): "Bulleted list", "Quote", "Table"… */
  context: string[]
  /** An image selected on its own (its alignment), instead of text formatting. */
  image: { align: Align } | null
  /** Another non-text node selected on its own ("Horizontal line"…): no text formatting applies. */
  node: string | null
  /** Every touched block is a code block. */
  codeBlock: boolean
  /** A collapsed cursor: the values are what the next typed character gets. */
  typingHere: boolean
  text: {
    fontFamily: Field<string>
    /** In points; null with source 'direct' when the size isn't in pt/px. */
    fontSize: Field<number>
    bold: Field<boolean>
    italic: Field<boolean>
    underline: Field<boolean>
    strike: Field<boolean>
    code: Field<boolean>
    color: Field<string>
    /** null value with a non-mixed source: no highlight. */
    highlight: Field<string | null>
    link: Field<string | null>
  }
}

const CONTEXT_LABELS: Record<string, string> = {
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  taskList: 'Checklist',
  blockquote: 'Quote',
  codeBlock: 'Code block',
  table: 'Table',
  details: 'Collapsible section',
}

const FLAG_MARKS = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike' } as const

const NODE_LABELS: Record<string, string> = {
  horizontalRule: 'Horizontal line',
  table: 'Table',
  details: 'Collapsible section',
  codeBlock: 'Code block',
  blockquote: 'Quote',
}

// How the page draws some elements (web/src/styles/editor.css), as defaults with a named source.
const LINK_COLOR = '#1a73e8'
const QUOTE_COLOR = '#5f6368'
const CHECKED_COLOR = '#5f6368'
/** A highlight mark without a color (.document mark). */
const HIGHLIGHT_DEFAULT = '#fff475'
const CODE_FONT = 'Monospace'

/** "11pt" / "12px" → points (rounded to 0.5), else null. Shared with the toolbar's size box. */
export function parseFontSize(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(pt|px)\s*$/i.exec(value)
  if (!match) return null
  const size = Number(match[1])
  const points = match[2]?.toLowerCase() === 'px' ? size * 0.75 : size
  return Math.round(points * 2) / 2
}

type StyleState = { status: StylesStatus; byId: ReadonlyMap<string, NamedStyle> }

type Piece = {
  marks: readonly Mark[]
  /** The text's own style (its tag), or on an empty linked line the paragraph's style. */
  style: { id: string; props: StyleProps } | null
  /** A style id that couldn't be resolved (not loaded yet, or unknown). */
  unresolved: string | null
  block: BlockType
  /** Ancestors that change the look: quote, table header, collapsible title. */
  inQuote: boolean
  inHeader: boolean
  inSummary: boolean
  /** A checked checklist line (drawn grey and struck through). */
  inChecked: boolean
  /** The block's look comes from a paragraph style's type (its CSS sets the color explicitly). */
  linkedBlock: boolean
  /** The block's paragraph style hasn't loaded (or doesn't exist): its type, so its look, is unknown. */
  blockUnresolved: string | null
}

type Sourced<T> = { value: T | null; source: Exclude<Source, 'mixed' | 'mixed-sources'>; styleId?: string; label?: string }

/** Folds values in one pass; `done` once the field can't become uniform again. */
class Fold<T> {
  private first: Sourced<T> | null = null
  private sameValue = true
  private sameSource = true
  done = false

  add(item: Sourced<T>): void {
    if (this.done) return
    if (!this.first) {
      this.first = item
      return
    }
    // Unresolved parts agree only when the same (missing) style supplies them.
    const unresolvedPair = item.source === 'unresolved' || this.first.source === 'unresolved'
    if (unresolvedPair ? item.source !== this.first.source || item.styleId !== this.first.styleId : item.value !== this.first.value) {
      this.sameValue = false
      this.done = true
      return
    }
    if (item.source !== this.first.source || item.styleId !== this.first.styleId || item.label !== this.first.label) this.sameSource = false
  }

  result(): Field<T> {
    const first = this.first
    if (!first || !this.sameValue) return { value: null, source: 'mixed' }
    if (!this.sameSource) return { value: first.value, source: 'mixed-sources' }
    const out: Field<T> = { value: first.value, source: first.source }
    // (An unresolved part's id only matters for comparing; the field doesn't name a style.)
    if (first.styleId && first.source !== 'unresolved') out.styleId = first.styleId
    if (first.label) out.label = first.label
    return out
  }
}

function look(block: BlockType) {
  return BLOCK_TYPOGRAPHY[block === 'other' ? 'paragraph' : block]
}

class StyleIds {
  private ids = new Set<string | null>()
  add(id: string | null): void {
    this.ids.add(id)
  }
  get mixed(): boolean {
    return this.ids.size > 1
  }
  result(styles: StyleState): StyleRef {
    const real = [...this.ids].filter((id): id is string => Boolean(id))
    if (this.ids.size > 1) return { kind: 'mixed', ids: real.slice(0, 3), total: real.length }
    const id = real[0]
    if (!id) return { kind: 'none' }
    const style = styles.byId.get(id)
    if (style) return { kind: 'style', id, name: style.name, deleted: style.deleted, props: style.props }
    return { kind: 'unresolved', id, status: styles.status }
  }
}

function tagOf(marks: readonly Mark[]): string | null {
  return (marks.find(mark => mark.type.name === 'namedStyle')?.attrs.id as string | undefined) ?? null
}

/**
 * The formatting at the selection. `styles` maps style ids to styles (deleted ones included) and
 * says whether they've loaded. Walks only the selection (each of its ranges, so table cell
 * selections are exact) and stops as soon as everything is known to be mixed.
 */
export function inspectFormatting(state: EditorState, styles: StyleState): FormatInfo {
  const { selection } = state
  const { empty, $from } = selection
  const resolve = (id: string | null | undefined) => (id ? styles.byId.get(id) : undefined)

  const blockTypeOf = (node: PMNode): BlockType => {
    const linked = resolve(node.attrs.styleId as string)?.props.block
    if (linked) return linked
    if (node.type.name === 'heading') return `h${node.attrs.level as number}` as StyleBlock
    return node.type.name === 'paragraph' ? 'paragraph' : 'other'
  }

  // Folds for every field.
  const text = {
    fontFamily: new Fold<string>(),
    fontSize: new Fold<number>(),
    bold: new Fold<boolean>(),
    italic: new Fold<boolean>(),
    underline: new Fold<boolean>(),
    strike: new Fold<boolean>(),
    code: new Fold<boolean>(),
    color: new Fold<string>(),
    highlight: new Fold<string | null>(),
    link: new Fold<string | null>(),
  }
  const blockFold = new Fold<BlockType>()
  const alignFold = new Fold<Align>()
  const textStyles = new StyleIds()
  const paragraphStyles = new StyleIds()
  let blockCount = 0
  let codeBlocks = 0
  let pieceCount = 0
  const allMixed = () =>
    Object.values(text).every(fold => fold.done) && blockFold.done && alignFold.done && textStyles.mixed && paragraphStyles.mixed

  const addBlock = (node: PMNode) => {
    blockCount += 1
    if (node.type.name === 'codeBlock') codeBlocks += 1
    const id = (node.attrs.styleId as string | null | undefined) ?? null
    paragraphStyles.add(id)
    const style = resolve(id)
    if (id && !style && node.type.name !== 'codeBlock') {
      blockFold.add({ value: null, source: 'unresolved', styleId: id })
      alignFold.add({ value: null, source: 'unresolved', styleId: id })
      return
    }
    const linked = style?.props.block
    if (linked && id) blockFold.add({ value: linked, source: 'style', styleId: id })
    else {
      const type = blockTypeOf(node)
      blockFold.add({ value: type, source: type === 'paragraph' || type === 'other' ? 'default' : 'direct' })
    }
    const own = node.attrs.textAlign as Align | null | undefined
    const styled = style?.props.align as Align | undefined
    if (own) alignFold.add({ value: own, source: 'direct' })
    else if (styled && id) alignFold.add({ value: styled, source: 'style', styleId: id })
    else alignFold.add({ value: 'left', source: 'default' })
  }

  const addPiece = (piece: Piece) => {
    pieceCount += 1
    textStyles.add(tagOf(piece.marks))
    const has = (name: string) => piece.marks.some(mark => mark.type.name === name)
    const attr = (name: string, key: string) => (piece.marks.find(mark => mark.type.name === name)?.attrs[key] as string | null | undefined) ?? null
    const props = piece.style?.props
    const viaStyle = <T,>(value: T | null | undefined): Sourced<T> | null =>
      value !== undefined && value !== null && piece.style ? { value, source: 'style', styleId: piece.style.id } : null
    const unresolved: Sourced<never> | null = piece.unresolved ? { value: null, source: 'unresolved', styleId: piece.unresolved } : null
    const isCode = has('code')
    const isLink = has('link')
    const blockLook = look(piece.block)
    const element = (label: string) => ({ source: 'element' as const, label })
    // A paragraph style that hasn't loaded may change the block's type: its defaults aren't known.
    const blockDefault = <T,>(value: T): Sourced<T> =>
      piece.blockUnresolved ? { value: null, source: 'unresolved', styleId: piece.blockUnresolved } : { value, source: 'default' }

    // Font: direct → code element → style → default.
    const family = firstFontFamily(attr('textStyle', 'fontFamily'))
    text.fontFamily.add(
      family ? { value: family, source: 'direct' } : isCode ? { value: CODE_FONT, ...element('Code') } : (unresolved ?? viaStyle(firstFontFamily(props?.fontFamily)) ?? { value: DEFAULT_FONT, source: 'default' }),
    )

    const rawSize = attr('textStyle', 'fontSize')
    text.fontSize.add(
      rawSize
        ? { value: parseFontSize(rawSize), source: 'direct' }
        : (unresolved ?? viaStyle(parseFontSize(props?.fontSize)) ?? blockDefault(parseFontSize(blockLook.fontSize) ?? 11)),
    )

    for (const key of Object.keys(FLAG_MARKS) as Array<keyof typeof FLAG_MARKS>) {
      if (has(FLAG_MARKS[key])) {
        text[key].add({ value: true, source: 'direct' })
        continue
      }
      if (key === 'underline' && isLink) {
        text.underline.add({ value: true, ...element('Link') })
        continue
      }
      if (key === 'strike' && piece.inChecked) {
        text.strike.add({ value: true, ...element('Checked item') })
        continue
      }
      const styled = props?.[key] ? viaStyle(true) : null
      if (styled) {
        text[key].add(styled)
        continue
      }
      if (unresolved && !props) {
        text[key].add(unresolved)
        continue
      }
      // Inherited bold reaches only text whose block doesn't set a weight (headings set their own).
      if (key === 'bold' && (piece.inHeader || piece.inSummary) && (piece.block === 'paragraph' || piece.block === 'other') && !piece.linkedBlock) {
        text.bold.add({ value: true, ...element(piece.inHeader ? 'Table header' : 'Collapsible title') })
        continue
      }
      const byDefault = key === 'bold' ? blockLook.fontWeight >= 700 : key === 'italic' ? blockLook.fontStyle === 'italic' : false
      text[key].add(key === 'bold' || key === 'italic' ? blockDefault(byDefault) : { value: byDefault, source: 'default' })
    }

    text.code.add({ value: isCode, source: isCode ? 'direct' : 'default' })

    const color = canonicalColor(attr('textStyle', 'color'))
    // A style's color beats the link blue (.document span[data-style] a); a quote's grey only
    // reaches normal text and headings 1–2 (smaller headings keep their own color).
    const quoteColors = !piece.linkedBlock && (piece.block === 'paragraph' || piece.block === 'h1' || piece.block === 'h2' || piece.block === 'other')
    text.color.add(
      color
        ? { value: color, source: 'direct' }
        : (unresolved ??
          viaStyle(canonicalColor(props?.color)) ??
          (isLink
            ? { value: LINK_COLOR, ...element('Link') }
            : piece.blockUnresolved
              ? blockDefault(blockLook.color)
              : piece.inChecked
              ? { value: CHECKED_COLOR, ...element('Checked item') }
              : piece.inQuote && quoteColors
                ? { value: QUOTE_COLOR, ...element('Quote') }
                : blockDefault(blockLook.color))),
    )

    text.highlight.add(
      has('highlight')
        ? { value: canonicalColor(attr('highlight', 'color')) ?? HIGHLIGHT_DEFAULT, source: 'direct' }
        : (unresolved ?? viaStyle<string | null>(canonicalColor(props?.highlight)) ?? { value: null, source: 'default' }),
    )

    const href = attr('link', 'href')
    text.link.add(href ? { value: href, source: 'direct' } : { value: null, source: 'default' })
  }

  const pieceFor = (
    marks: readonly Mark[],
    block: PMNode,
    ancestors: { quote: boolean; header: boolean; summary: boolean; checked: boolean },
    emptyLine: boolean,
  ): Piece => {
    const tag = tagOf(marks)
    const tagStyle = resolve(tag)
    const blockId = (block.attrs.styleId as string | null | undefined) ?? null
    // A paragraph style gives text parts only to an empty line (typing there takes the style).
    const lineId = !tag && emptyLine ? blockId : null
    const lineStyle = resolve(lineId)
    let style: Piece['style'] = null
    let unresolved: string | null = null
    if (tag) {
      if (tagStyle) style = { id: tag, props: tagStyle.props }
      else unresolved = tag
    } else if (lineId) {
      if (lineStyle) style = { id: lineId, props: lineStyle.props }
      else unresolved = lineId
    }
    return {
      marks,
      style,
      unresolved,
      block: blockTypeOf(block),
      inQuote: ancestors.quote,
      inHeader: ancestors.header,
      inSummary: ancestors.summary,
      inChecked: ancestors.checked,
      linkedBlock: Boolean(resolve(blockId)?.props.block),
      blockUnresolved: blockId && !resolve(blockId) ? blockId : null,
    }
  }

  const ancestorsAt = (pos: number) => {
    const $pos = state.doc.resolve(pos)
    let quote = false
    let header = false
    let summary = false
    let checked = false
    for (let depth = 1; depth <= $pos.depth; depth += 1) {
      const node = $pos.node(depth)
      const name = node.type.name
      if (name === 'blockquote') quote = true
      if (name === 'tableHeader') header = true
      if (name === 'detailsSummary') summary = true
      // Everything inside a checked item is drawn checked, nested items included (the CSS inherits).
      if (name === 'taskItem' && node.attrs.checked === true) checked = true
    }
    return { quote, header, summary, checked }
  }

  const imageNode = selection instanceof NodeSelection && selection.node.type.name === 'image' ? selection.node : null

  if (empty || selection instanceof NodeSelection) {
    // A cursor (or a selected node): the typing marks at that spot. An explicit empty set of stored
    // marks is authoritative (the formatting was just cleared).
    const block = $from.parent
    if (block.isTextblock) {
      addBlock(block)
      const marks = empty ? (state.storedMarks ?? $from.marks()) : $from.marks()
      addPiece(pieceFor(marks, block, ancestorsAt($from.pos), block.content.size === 0))
    }
  } else {
    const emptyLines: Piece[] = []
    walk: for (const range of selection.ranges) {
      const from = range.$from.pos
      const to = range.$to.pos
      let stop = false
      state.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (stop) return false
        if (node.isTextblock) {
          // A selection that only reaches the start of a block doesn't touch it.
          if (to === pos + 1 && from < pos + 1) return false
          addBlock(node)
          // An empty line has no characters: it only counts for text if nothing else is selected.
          if (node.content.size === 0) emptyLines.push(pieceFor([], node, ancestorsAt(pos + 1), true))
          return true
        }
        if (node.isText && parent) {
          addPiece(pieceFor(node.marks, parent, ancestorsAt(pos), false))
          if (allMixed()) stop = true
          return false
        }
        return true
      })
      if (stop) break walk
    }
    if (pieceCount === 0) for (const piece of emptyLines) addPiece(piece)
    // Nothing textual at all: describe what typing at the start would get.
    if (blockCount === 0 && $from.parent.isTextblock) addBlock($from.parent)
    if (pieceCount === 0 && $from.parent.isTextblock) addPiece(pieceFor($from.marks(), $from.parent, ancestorsAt($from.pos), false))
  }

  const context: string[] = []
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    const label = CONTEXT_LABELS[$from.node(depth).type.name]
    if (label && !context.includes(label)) context.push(label)
  }

  return {
    styles: { text: textStyles.result(styles), paragraph: paragraphStyles.result(styles) },
    block: blockCount ? blockFold.result() : { value: 'other', source: 'default' },
    align: blockCount ? alignFold.result() : { value: 'left', source: 'default' },
    context,
    image: imageNode ? { align: (imageNode.attrs.align as Align | null) ?? 'left' } : null,
    node: selection instanceof NodeSelection && !imageNode && !selection.node.isTextblock ? (NODE_LABELS[selection.node.type.name] ?? 'Block') : null,
    codeBlock: blockCount > 0 && codeBlocks === blockCount,
    typingHere: empty,
    text: {
      fontFamily: text.fontFamily.result(),
      fontSize: text.fontSize.result(),
      bold: text.bold.result(),
      italic: text.italic.result(),
      underline: text.underline.result(),
      strike: text.strike.result(),
      code: text.code.result(),
      color: text.color.result(),
      highlight: text.highlight.result(),
      link: text.link.result(),
    },
  }
}

/** Style id → style, built once per styles snapshot (styleById is a linear search). */
const indexes = new WeakMap<readonly NamedStyle[], Map<string, NamedStyle>>()
export function styleIndex(list: readonly NamedStyle[]): Map<string, NamedStyle> {
  let index = indexes.get(list)
  if (!index) {
    index = new Map(list.map(style => [style.id, style]))
    indexes.set(list, index)
  }
  return index
}

/** One computation per editor state and styles snapshot, shared by every reader. */
const cache = new WeakMap<EditorState, { list: readonly NamedStyle[]; status: StylesStatus; info: FormatInfo }>()
export function formatInfoFor(state: EditorState, list: readonly NamedStyle[], status: StylesStatus): FormatInfo {
  const hit = cache.get(state)
  if (hit && hit.list === list && hit.status === status) return hit.info
  const info = inspectFormatting(state, { status, byId: styleIndex(list) })
  cache.set(state, { list, status, info })
  return info
}
