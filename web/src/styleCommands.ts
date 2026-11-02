// Applying, removing and capturing saved styles. Pure ProseMirror transforms (no toolbar commands),
// so they act on exact ranges, merge textStyle attributes per text node, and run as one undo step.
import { Mark } from '@tiptap/pm/model'
import type { Node as PMNode, NodeType, Schema } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import {
  canonicalColor,
  canonicalFontFamily,
  canonicalFontSize,
  canonicalProps,
  hasBlockParts,
  hasInlineParts,
  isUuid,
} from '../../shared/styleProps.ts'
import type { NamedStyle, StyleBlock, StyleProps } from '../../shared/styleProps.ts'
import { APPLY_STYLE_META } from '../../shared/namedStyle.ts'

type Block = { pos: number; node: PMNode }

const STYLED_BLOCKS = new Set(['paragraph', 'heading'])
const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'color'] as const
const FLAG_MARKS = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike' } as const

type Selected = Pick<EditorState, 'selection' | 'doc'>

/** Textblocks the selection touches (just the cursor's block when it's collapsed). */
function touchedBlocks(state: Selected): Block[] {
  const { from, to, empty, $from } = state.selection
  if (empty) {
    const depth = $from.depth
    return $from.parent.isTextblock ? [{ pos: $from.before(depth), node: $from.parent }] : []
  }
  const blocks: Block[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node })
      return false
    }
    return true
  })
  return blocks
}

/** True when the selection is collapsed or covers each touched block from start to end. */
function coversWholeBlocks(state: Selected, blocks: Block[]): boolean {
  const { from, to, empty } = state.selection
  if (empty) return true
  return blocks.every(block => from <= block.pos + 1 && to >= block.pos + 1 + block.node.content.size)
}

/** Removes the direct formatting a style defines from [from, to), per text node. */
function resetDirectFormatting(tr: Transaction, schema: Schema, from: number, to: number, props: StyleProps): void {
  const textStyle = schema.marks.textStyle
  const highlight = schema.marks.highlight
  const namedStyle = schema.marks.namedStyle
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText) return true
    // Only text that will take the style tag (not inline code): elsewhere the reset would just lose formatting.
    if (namedStyle && (!parent?.type.allowsMarkType(namedStyle) || node.marks.some(mark => mark.type.name === 'code'))) return false
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + node.nodeSize)
    const current = textStyle ? node.marks.find(mark => mark.type === textStyle) : undefined
    if (textStyle && current && TEXT_STYLE_KEYS.some(key => props[key] !== undefined)) {
      // addMark would replace the whole textStyle mark, so rebuild it with only the defined keys cleared.
      const attrs = { ...current.attrs }
      for (const key of TEXT_STYLE_KEYS) if (props[key] !== undefined) attrs[key] = null
      if (Object.values(attrs).every(value => value === null || value === undefined)) tr.removeMark(start, end, textStyle)
      else tr.addMark(start, end, textStyle.create(attrs))
    }
    if (highlight && props.highlight !== undefined) tr.removeMark(start, end, highlight)
    for (const [key, markName] of Object.entries(FLAG_MARKS) as Array<[keyof typeof FLAG_MARKS, string]>) {
      const type = schema.marks[markName]
      if (props[key] && type) tr.removeMark(start, end, type)
    }
    return false
  })
}

/** Adds the style tag to every text node in [from, to) that can carry it (not inline code, not code blocks). */
function tagText(tr: Transaction, schema: Schema, from: number, to: number, style: NamedStyle): void {
  const namedStyle = schema.marks.namedStyle
  if (!namedStyle) return
  const mark = namedStyle.create({ id: style.id })
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText) return true
    if (!parent?.type.allowsMarkType(namedStyle) || !mark.isInSet(mark.addToSet(node.marks))) return false
    tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), mark)
    return false
  })
}

function blockTarget(schema: Schema, block: StyleBlock): { type: NodeType; level: number | null } | null {
  if (block === 'paragraph') return schema.nodes.paragraph ? { type: schema.nodes.paragraph, level: null } : null
  const heading = schema.nodes.heading
  return heading ? { type: heading, level: Number(block.slice(1)) } : null
}

/** Sets a block's type (where its parent allows it) and attributes, keeping the attributes both types share. */
function setBlock(tr: Transaction, schema: Schema, pos: number, attrs: Record<string, unknown>, block?: StyleBlock): void {
  const node = tr.doc.nodeAt(pos)
  if (!node) return
  let type = node.type
  let level: number | null = node.type.name === 'heading' ? (node.attrs.level as number) : null
  if (block) {
    const target = blockTarget(schema, block)
    const $pos = tr.doc.resolve(pos)
    // e.g. a list item's first child must stay a paragraph: then only the look changes (via CSS).
    if (target && $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, target.type)) {
      type = target.type
      level = target.level
    }
  }
  const next: Record<string, unknown> = { ...attrs }
  for (const [key, value] of Object.entries(node.attrs)) if (key in (type.spec.attrs ?? {}) && !(key in next)) next[key] = value
  if (type.name === 'heading') next.level = level ?? 1
  else delete next.level
  tr.setNodeMarkup(pos, type, next, node.marks)
}

export type ApplyResult = { tr: Transaction } | { reason: 'deleted' | 'code' | 'nothing' }

/** Why nothing happened, for a notice. */
export function applyFailureMessage(reason: 'deleted' | 'code' | 'nothing', name: string): string {
  if (reason === 'deleted') return `“${name}” was deleted.`
  if (reason === 'code') return 'Styles don’t apply to code.'
  return `“${name}” didn’t change anything here.`
}

/**
 * Applies a style: one undoable step. Paragraph parts go to every paragraph the selection touches
 * (or the cursor's paragraph); text parts go to the selected text (or the whole paragraph for a
 * cursor or whole-paragraph selection). Applying resets the direct formatting the style defines, so
 * the style shows (later manual tweaks win again).
 */
export function applyStyle(state: EditorState, style: NamedStyle): ApplyResult {
  if (style.deleted) return { reason: 'deleted' }
  const { schema } = state
  const props = style.props
  const blocks = touchedBlocks(state).filter(block => !endsAtStart(state, block))
  if (blocks.length > 0 && blocks.every(block => block.node.type.name === 'codeBlock')) return { reason: 'code' }
  // A style without text parts is a paragraph style: it acts on whole paragraphs even when only
  // part of one is selected.
  const whole = coversWholeBlocks(state, blocks) || !hasInlineParts(props)
  const tr = state.tr

  // Paragraphs are linked whenever the style reaches them as paragraphs (even with no paragraph
  // parts yet), so parts added to the style later (alignment, a heading look) reach them too.
  if (whole || hasBlockParts(props)) {
    for (const block of blocks) {
      if (!STYLED_BLOCKS.has(block.node.type.name)) continue
      const attrs: Record<string, unknown> = { styleId: style.id }
      if (props.align) attrs.textAlign = null
      setBlock(tr, schema, block.pos, attrs, props.block)
    }
  }

  // Text is tagged whenever whole paragraphs are styled, even by a style with no text parts yet:
  // parts added later then reach it, and removing the style from some words really removes it.
  if (hasInlineParts(props) || whole) {
    const ranges = whole
      ? blocks.map(block => [block.pos + 1, block.pos + 1 + block.node.content.size] as const)
      : [[state.selection.from, state.selection.to] as const]
    for (const [from, to] of ranges) {
      if (to <= from) continue
      resetDirectFormatting(tr, schema, from, to, props)
      tagText(tr, schema, from, to, style)
    }
    // Typing at a collapsed cursor (e.g. in an empty paragraph) continues in the style.
    if (state.selection.empty && schema.marks.namedStyle && state.selection.$from.parent.type.allowsMarkType(schema.marks.namedStyle)) {
      const keep: Mark[] = []
      for (const mark of state.storedMarks ?? state.selection.$from.marks()) {
        if (mark.type.name === 'namedStyle' || overriddenBy(mark, props)) continue
        if (mark.type.name === 'textStyle') {
          // Clear the parts the style defines, so the next typed text shows the style (not, say, an old red).
          const attrs = { ...mark.attrs }
          for (const key of TEXT_STYLE_KEYS) if (props[key] !== undefined) attrs[key] = null
          if (Object.values(attrs).some(value => value !== null && value !== undefined)) keep.push(mark.type.create(attrs))
          continue
        }
        keep.push(mark)
      }
      // Through addToSet, so marks that exclude others (inline code) win and the set stays valid.
      let set = Mark.none
      for (const mark of keep) set = mark.addToSet(set)
      set = schema.marks.namedStyle.create({ id: style.id }).addToSet(set)
      tr.setStoredMarks(set)
    }
  }
  tr.setMeta(APPLY_STYLE_META, true)
  if (tr.docChanged || tr.storedMarksSet) return { tr }
  const inCode = state.selection.$from.marks().some(mark => mark.type.name === 'code')
  return { reason: inCode ? 'code' : 'nothing' }
}

/** A block the selection only touches at its very start (the selection ends there): not "touched". */
function endsAtStart(state: Selected, block: Block): boolean {
  const { from, to, empty } = state.selection
  return !empty && to === block.pos + 1 && from < block.pos + 1
}

function overriddenBy(mark: Mark, props: StyleProps): boolean {
  if (mark.type.name === 'highlight') return props.highlight !== undefined
  if (mark.type.name in FLAG_MARKS) return Boolean(props[mark.type.name as keyof typeof FLAG_MARKS])
  return false
}

/** Removes style tags from the selection (or the cursor's block) and paragraph links from its blocks. */
export function removeStyle(state: EditorState): Transaction | null {
  const { schema } = state
  const blocks = touchedBlocks(state)
  const tr = state.tr
  const namedStyle = schema.marks.namedStyle
  if (namedStyle) {
    if (state.selection.empty) {
      for (const block of blocks) tr.removeMark(block.pos + 1, block.pos + 1 + block.node.content.size, namedStyle)
      tr.removeStoredMark(namedStyle)
    } else {
      tr.removeMark(state.selection.from, state.selection.to, namedStyle)
    }
  }
  // A few selected words lose their tags; the paragraph keeps its link unless all of it is selected.
  if (coversWholeBlocks(state, blocks)) {
    for (const block of blocks) if (block.node.attrs.styleId) tr.setNodeAttribute(block.pos, 'styleId', null)
  }
  return tr.docChanged || tr.storedMarksSet ? tr : null
}

/**
 * Clear formatting: every mark and style tag in the selection, and the paragraph links of blocks it
 * covers completely. With a collapsed cursor, only what you type next is plain (as in Google Docs);
 * the rest of the paragraph is left alone. Block types are reset separately by clearNodes.
 */
export function clearInlineFormatting(tr: Transaction): void {
  // Works on the transaction's current doc and selection (also inside a command chain).
  tr.setStoredMarks([])
  if (tr.selection.empty) return
  const blocks = touchedBlocks(tr)
  tr.removeMark(tr.selection.from, tr.selection.to)
  if (coversWholeBlocks(tr, blocks)) {
    for (const block of blocks) if (block.node.attrs.styleId) tr.setNodeAttribute(block.pos, 'styleId', null)
  }
}

/**
 * Clears paragraph-style links on the selection's blocks (a manual paragraph-type change wins).
 * The style's alignment stays as the paragraph's own, so only the type the user picked changes.
 */
export function detachBlockStyles(tr: Transaction, styleOf?: (id: string) => StyleProps | undefined): void {
  for (const block of touchedBlocks(tr)) {
    const id = block.node.attrs.styleId as string | null | undefined
    if (!id) continue
    const align = styleOf?.(id)?.align
    if (align && !block.node.attrs.textAlign) tr.setNodeAttribute(block.pos, 'textAlign', align)
    tr.setNodeAttribute(block.pos, 'styleId', null)
  }
}

/** Marks at the selection's start: the stored marks for a cursor, else the first text node's marks. */
function marksAtStart(state: EditorState): readonly Mark[] {
  const { from, to, empty, $from } = state.selection
  if (empty) return state.storedMarks ?? $from.marks()
  let found: readonly Mark[] | null = null
  state.doc.nodesBetween(from, to, node => {
    if (found) return false
    if (node.isText) {
      found = node.marks
      return false
    }
    return true
  })
  return found ?? $from.marks()
}

export type CurrentStyle = { kind: 'none' } | { kind: 'mixed' } | { kind: 'style'; id: string; source: 'text' | 'paragraph' }

/** Which style the selection uses: the text's tag first, then its paragraph's link. */
export function currentStyle(state: EditorState): CurrentStyle {
  const { from, to, empty } = state.selection
  const blocks = touchedBlocks(state)
  if (empty) {
    const tag = marksAtStart(state).find(mark => mark.type.name === 'namedStyle')
    if (tag) return { kind: 'style', id: tag.attrs.id as string, source: 'text' }
    const blockId = blocks[0]?.node.attrs.styleId as string | null | undefined
    return blockId ? { kind: 'style', id: blockId, source: 'paragraph' } : { kind: 'none' }
  }
  const ids = new Set<string | null>()
  state.doc.nodesBetween(from, to, node => {
    if (!node.isText) return true
    ids.add((node.marks.find(mark => mark.type.name === 'namedStyle')?.attrs.id as string | undefined) ?? null)
    return false
  })
  if (ids.size > 1) return { kind: 'mixed' }
  const only = [...ids][0]
  if (only) return { kind: 'style', id: only, source: 'text' }
  const blockIds = new Set(blocks.map(block => (block.node.attrs.styleId as string | null) ?? null))
  if (blockIds.size > 1) return { kind: 'mixed' }
  const blockId = [...blockIds][0]
  return blockId ? { kind: 'style', id: blockId, source: 'paragraph' } : { kind: 'none' }
}

/**
 * The formatting at the selection's start, as style props: only what is explicitly set (no implicit
 * 11pt / page font / heading defaults), with an existing style's parts underneath.
 */
export function captureProps(state: EditorState, styleOf: (id: string) => StyleProps | undefined): StyleProps {
  const marks = marksAtStart(state)
  const props: Record<string, unknown> = {}
  const block = touchedBlocks(state)[0]?.node

  const blockStyle = block?.attrs.styleId ? styleOf(block.attrs.styleId as string) : undefined
  const tag = marks.find(mark => mark.type.name === 'namedStyle')
  const textStyleProps = tag ? styleOf(tag.attrs.id as string) : undefined
  Object.assign(props, blockStyle ?? {}, textStyleProps ?? {})

  const textStyle = marks.find(mark => mark.type.name === 'textStyle')
  if (textStyle) {
    const family = canonicalFontFamily(textStyle.attrs.fontFamily)
    const size = canonicalFontSize(textStyle.attrs.fontSize)
    const color = canonicalColor(textStyle.attrs.color)
    if (family) props.fontFamily = family
    if (size) props.fontSize = size
    if (color) props.color = color
  }
  const highlight = marks.find(mark => mark.type.name === 'highlight')
  const highlightColor = canonicalColor(highlight?.attrs.color)
  if (highlightColor) props.highlight = highlightColor
  for (const key of Object.keys(FLAG_MARKS) as Array<keyof typeof FLAG_MARKS>) {
    if (marks.some(mark => mark.type.name === FLAG_MARKS[key])) props[key] = true
  }
  // A linked paragraph's type comes from its style (the node may predate a change to the style).
  if (block?.type.name === 'heading' && blockStyle?.block === undefined) props.block = `h${block.attrs.level as number}`
  if (block && typeof block.attrs.textAlign === 'string') props.align = block.attrs.textAlign
  return canonicalProps(props as StyleProps)
}

// ---- Ending a style (Phase 5) ----
// Any formatting-bar change ends the style from that point on, and the text keeps its look: the
// style's parts become direct formatting, then the tag (and, where it applies, the paragraph link)
// is removed.

type StyleOf = (id: string) => StyleProps | undefined

/** The style's text parts as direct marks on top of `existing` (direct values already there win). */
export function materializedMarks(schema: Schema, existing: readonly Mark[], props: StyleProps): readonly Mark[] {
  let set: readonly Mark[] = existing.filter(mark => mark.type.name !== 'namedStyle')
  const textStyle = schema.marks.textStyle
  if (textStyle && TEXT_STYLE_KEYS.some(key => props[key] !== undefined)) {
    const current = set.find(mark => mark.type === textStyle)
    const attrs: Record<string, unknown> = { ...(current?.attrs ?? {}) }
    for (const key of TEXT_STYLE_KEYS) if (props[key] !== undefined && (attrs[key] === null || attrs[key] === undefined)) attrs[key] = props[key]
    set = textStyle.create(attrs).addToSet(set)
  }
  const highlight = schema.marks.highlight
  if (highlight && props.highlight && !set.some(mark => mark.type === highlight)) set = highlight.create({ color: props.highlight }).addToSet(set)
  for (const key of Object.keys(FLAG_MARKS) as Array<keyof typeof FLAG_MARKS>) {
    const type = schema.marks[FLAG_MARKS[key]]
    if (props[key] && type && !set.some(mark => mark.type === type)) set = type.create().addToSet(set)
  }
  return set
}

/**
 * Unlinks a paragraph while keeping its look: the style's alignment becomes the paragraph's own,
 * and a paragraph type the style gave it only through CSS becomes the real node type. Where the
 * schema can't take that type (a list item's first line as a heading), the link stays.
 */
function unlinkKeepingLook(tr: Transaction, pos: number, props: StyleProps): void {
  const node = tr.doc.nodeAt(pos)
  if (!node?.attrs.styleId) return
  const attrs: Record<string, unknown> = { styleId: null }
  if (props.align && !node.attrs.textAlign) attrs.textAlign = props.align
  if (props.block) {
    const target = blockTarget(tr.doc.type.schema, props.block)
    const matches = target && target.type === node.type && (target.level === null || target.level === node.attrs.level)
    if (target && !matches) {
      const $pos = tr.doc.resolve(pos)
      const canChange = $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, target.type)
      if (!canChange && node.content.size > 0) return
      if (canChange) {
        setBlock(tr, tr.doc.type.schema, pos, attrs, props.block)
        return
      }
    }
  }
  for (const [key, value] of Object.entries(attrs)) tr.setNodeAttribute(pos, key, value)
}

/**
 * Ends the style at the selection (see the top of this section). With `materialize: false` (Clear
 * formatting) the tags and links are just dropped. Styles that can't be resolved (not loaded yet)
 * are left alone: a look we can't reproduce is never thrown away. Returns the marks the next typed
 * text should carry (collapsed cursor), or null.
 */
export function endStyle(tr: Transaction, styleOf: StyleOf, { materialize = true } = {}): readonly Mark[] | null {
  const schema = tr.doc.type.schema
  const namedStyle = schema.marks.namedStyle
  if (!namedStyle) return null
  const blocks = touchedBlocks(tr)

  if (tr.selection.empty) {
    const $from = tr.selection.$from
    const marks = tr.storedMarks ?? $from.marks()
    const tag = marks.find(mark => mark.type === namedStyle)
    const block = blocks[0]
    const blockId = block?.node.attrs.styleId as string | null | undefined
    const empty = block ? block.node.content.size === 0 : false
    const id = (tag?.attrs.id as string | undefined) ?? (empty && blockId ? blockId : undefined)
    const props = id ? styleOf(id) : undefined
    if (id && !props) return null
    // The paragraph first: its change is a step, and steps clear the marks held for typing.
    // Only when a style is really active at the cursor (its tag, or an empty linked line): in
    // deliberately unstyled words of a linked paragraph there's nothing to end.
    if (block && blockId && (tag || empty)) {
      const blockProps = styleOf(blockId)
      if (blockProps) unlinkKeepingLook(tr, block.pos, materialize ? blockProps : {})
    }
    if (!props) return null
    const typing = materialize ? materializedMarks(schema, marks, props) : marks.filter(mark => mark.type !== namedStyle)
    tr.setStoredMarks(typing)
    return typing
  }

  // A selection: each tagged piece of text turns its own style into direct formatting.
  const { from, to } = tr.selection
  const pieces: Array<{ start: number; end: number; marks: readonly Mark[]; props: StyleProps }> = []
  let unresolved = false
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    const tag = node.marks.find(mark => mark.type === namedStyle)
    if (!tag) return false
    const props = styleOf(tag.attrs.id as string)
    if (!props) {
      unresolved = true
      return false
    }
    pieces.push({ start: Math.max(from, pos), end: Math.min(to, pos + node.nodeSize), marks: node.marks, props })
    return false
  })
  for (const piece of pieces) {
    tr.removeMark(piece.start, piece.end, namedStyle)
    if (!materialize) continue
    for (const mark of materializedMarks(schema, piece.marks, piece.props)) {
      if (!piece.marks.some(existing => existing.eq(mark))) tr.addMark(piece.start, piece.end, mark)
    }
  }
  // Every paragraph the selection covers completely is unlinked (each on its own; partly covered
  // ones stay linked).
  if (!unresolved) {
    for (const block of blocks) {
      if (!coversWholeBlocks(tr, [block])) continue
      const id = block.node.attrs.styleId as string | null | undefined
      const props = id ? styleOf(id) : undefined
      if (props) unlinkKeepingLook(tr, tr.mapping.map(block.pos), materialize ? props : {})
    }
  }
  return null
}

/**
 * The style's text parts that really apply at the selection (for the toolbar's buttons). For a
 * range, a part counts when every piece of text has it, from its own style or directly (two
 * different bold styles still show Bold).
 */
export function effectiveTextProps(state: EditorState, styleOf: StyleOf): StyleProps | null {
  if (state.selection.empty) {
    const current = currentStyle(state)
    if (current.kind !== 'style') return null
    if (current.source === 'paragraph') {
      // A paragraph link alone gives text parts only to an empty line (typing there takes the style).
      const block = state.selection.$from.parent
      if (block.content.size > 0) return null
    }
    return styleOf(current.id) ?? null
  }
  const pieces: Array<{ marks: readonly Mark[]; props: StyleProps }> = []
  state.doc.nodesBetween(state.selection.from, state.selection.to, node => {
    if (!node.isText) return true
    const tag = node.marks.find(mark => mark.type.name === 'namedStyle')
    pieces.push({ marks: node.marks, props: (tag ? styleOf(tag.attrs.id as string) : undefined) ?? {} })
    return false
  })
  if (pieces.length === 0 || pieces.every(piece => Object.keys(piece.props).length === 0)) return null
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FLAG_MARKS) as Array<keyof typeof FLAG_MARKS>) {
    if (pieces.every(piece => piece.props[key] || piece.marks.some(mark => mark.type.name === FLAG_MARKS[key]))) out[key] = true
  }
  for (const key of ['color', 'highlight', 'fontFamily', 'fontSize'] as const) {
    const values = new Set(pieces.map(piece => piece.props[key]))
    if (values.size === 1 && [...values][0] !== undefined) out[key] = [...values][0]
  }
  return out as StyleProps
}

/**
 * Each touched paragraph's alignment (its own, else its style's), to put back after a type change:
 * Tiptap drops attributes when a type change spans several paragraphs.
 */
export type BlockTarget = { type: 'paragraph' } | { type: 'heading'; level: number }

/**
 * A paragraph-type change from the formatting bar: each selected line becomes the target type where
 * its container allows it (a list item's first line must stay a paragraph), keeping its alignment
 * and link (unlinked right after). `toggle` turns lines that are all that heading back into
 * paragraphs. Applicable when a line changes or is linked to a style: the change also ends the
 * style, even where the type itself can't change. Never lifts lines out of their list or quote.
 */
export function setTypeWhereAllowed(tr: Transaction, target: BlockTarget, { toggle = false } = {}): boolean {
  const { schema } = tr.doc.type
  const blocks = touchedBlocks(tr).filter(block => !endsAtStart(tr, block))
  const isTarget = (node: PMNode) =>
    node.type.name === target.type && (target.type !== 'heading' || node.attrs.level === target.level)
  const goal: BlockTarget = toggle && target.type === 'heading' && blocks.length > 0 && blocks.every(b => isTarget(b.node)) ? { type: 'paragraph' } : target
  const type = schema.nodes[goal.type]
  if (!type) return false
  let applicable = blocks.some(block => isUuid(block.node.attrs.styleId))
  for (const block of [...blocks].reverse()) {
    const { node } = block
    if (node.type === type && (goal.type !== 'heading' || node.attrs.level === goal.level)) continue
    const $pos = tr.doc.resolve(block.pos)
    const index = $pos.index()
    if (!$pos.parent.canReplaceWith(index, index + 1, type)) continue
    const attrs: Record<string, unknown> = { textAlign: node.attrs.textAlign ?? null, styleId: node.attrs.styleId ?? null }
    if (goal.type === 'heading') attrs.level = goal.level
    tr.setBlockType(block.pos, block.pos + node.nodeSize, type, attrs)
    applicable = true
  }
  return applicable
}

export function rememberAlignments(tr: Transaction, styleOf?: StyleOf): Array<{ pos: number; align: string | null }> {
  return touchedBlocks(tr).map(block => {
    const own = block.node.attrs.textAlign as string | null | undefined
    const id = block.node.attrs.styleId as string | null | undefined
    return { pos: block.pos, align: own ?? (id ? (styleOf?.(id)?.align ?? null) : null) }
  })
}

export function restoreAlignments(tr: Transaction, saved: Array<{ pos: number; align: string | null }>, since: number): void {
  for (const { pos, align } of saved) {
    if (!align) continue
    let mapped = pos
    for (const map of tr.mapping.maps.slice(since)) mapped = map.map(mapped)
    const node = tr.doc.nodeAt(mapped)
    if (node?.isTextblock && 'textAlign' in node.attrs && !node.attrs.textAlign) tr.setNodeAttribute(mapped, 'textAlign', align)
  }
}
