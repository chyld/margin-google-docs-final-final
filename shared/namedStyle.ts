// Saved styles in the document: text and paragraphs only say WHICH style they use. The look comes
// from a stylesheet generated from the user's style definitions (shared/styleProps.ts), so editing a
// style restyles every use at once and notes are never rewritten.
import { Extension, Mark } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'
import { isUuid } from './styleProps.ts'

/** Set on transactions that apply a style (their block-type changes are the style's own). */
export const APPLY_STYLE_META = 'namedStyleApply'

/** Inline: <span data-style="<uuid>">. */
export const NamedStyle = Mark.create({
  name: 'namedStyle',
  // Rendered outside the other marks, so their own formatting (inline styles, <strong>…) sits inside
  // the style span and wins: manual tweaks override the style.
  priority: 1001,
  // Typing at the end of styled text continues the style. A span has one style (marks exclude their
  // own type by default).
  inclusive: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => {
          const id = element.getAttribute('data-style')
          return isUuid(id) ? id : null
        },
        renderHTML: attributes => (isUuid(attributes.id) ? { 'data-style': attributes.id } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-style]', getAttrs: element => (isUuid(element.getAttribute('data-style')) ? null : false) }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0]
  },
})

/** Paragraph styles: data-style-id="<uuid>" on paragraphs and headings. */
export const NamedStyleBlock = Extension.create({
  name: 'namedStyleBlock',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          styleId: {
            default: null,
            // Enter continues the paragraph style, like Word.
            keepOnSplit: true,
            parseHTML: element => {
              const id = element.getAttribute('data-style-id')
              return isUuid(id) ? id : null
            },
            renderHTML: attributes => (isUuid(attributes.styleId) ? { 'data-style-id': attributes.styleId } : {}),
          },
        },
      },
    ]
  },

  // Any manual change of a linked paragraph's type (Ctrl+Alt+1–6, "## ", the toolbar, Enter after
  // a heading) unlinks it, so the manual choice shows instead of the style's look.
  addProseMirrorPlugins() {
    return [detachOnTypeChange()]
  },
})

/** Unlinks paragraph styles whose paragraph type changed manually (exported for tests). */
export function detachOnTypeChange(): Plugin {
  return new Plugin({
    key: new PluginKey('namedStyleBlockDetach'),
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.getMeta(APPLY_STYLE_META))) return null
      const back = transactions.map(tr => tr.mapping)
      const ranges: Array<[number, number]> = []
      for (const [index, tr] of transactions.entries()) {
        for (const map of tr.mapping.maps) {
          map.forEach((_from, _to, newFrom, newTo) => {
            // Map forward through the rest of this batch's transactions.
            let from = newFrom
            let to = newTo
            for (const later of transactions.slice(index + 1)) {
              from = later.mapping.map(from, -1)
              to = later.mapping.map(to, 1)
            }
            ranges.push([from, to])
          })
        }
      }
      const tr = newState.tr
      for (const [from, to] of ranges) {
        newState.doc.nodesBetween(Math.max(0, from), Math.min(newState.doc.content.size, to), (node, pos) => {
          if (!node.isTextblock) return true
          if (!node.attrs.styleId) return false
          let oldPos = pos
          for (const mapping of [...back].reverse()) oldPos = mapping.invert().map(oldPos)
          // The block this one came from: the node at that spot, or (for a block split off by
          // Enter) the textblock around that spot.
          const direct = oldState.doc.nodeAt(oldPos)
          const around = oldState.doc.resolve(Math.min(oldPos, oldState.doc.content.size)).parent
          const old = direct?.isTextblock ? direct : around.isTextblock ? around : null
          if (!old) return false
          const changed = old.type !== node.type || old.attrs.level !== node.attrs.level
          if (changed && tr.doc.nodeAt(pos)?.attrs.styleId) tr.setNodeAttribute(pos, 'styleId', null)
          return false
        })
      }
      return tr.docChanged ? tr : null
    },
  })
}

// ---- Styles keep going (Phase 5) ----

const STYLED_TYPES = new Set(['paragraph', 'heading'])
const LIST_ITEMS = new Set(['listItem', 'taskItem'])
/** Containers where Enter on an empty styled line still makes a new styled line (elsewhere it exits). */
const SPLIT_INSIDE = new Set(['doc', 'tableCell', 'tableHeader'])
/** Marks that never continue onto a new line. */
const NOT_ACROSS_LINES = new Set(['link', 'code'])
const AUTO_TAG_META = 'namedStyleAutoTag'

function hasText(node: PMNode): boolean {
  let found = false
  node.forEach(child => {
    if (child.isText) found = true
  })
  return found
}

/**
 * Enter in a styled paragraph or heading: the new line is the same type (heading level included) and
 * keeps the style, until the user changes it. Returns false to let the normal Enter run (lists'
 * first lines, leaving a quote or section from an empty line, unstyled lines).
 */
export function continueStyleOnEnter(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const tr = state.tr
  if (!state.selection.empty) tr.deleteSelection()
  const $pos = tr.selection.$from
  if (!tr.selection.empty) return false
  const block = $pos.parent
  if (!STYLED_TYPES.has(block.type.name) || !isUuid(block.attrs.styleId)) return false
  const container = $pos.node($pos.depth - 1)
  const inItem = LIST_ITEMS.has(container.type.name)
  const empty = block.content.size === 0
  // A list item's first line: its own Enter makes the next item (and carries the style).
  if (inItem && $pos.index($pos.depth - 1) === 0) return false
  // An empty last line of a collapsible section: Enter leaves the section with the line, style and
  // all. (The section's own Enter only exits from a plain empty paragraph and would split instead.)
  if (empty && container.type.name === 'detailsContent') return exitSection(state, tr, dispatch)
  // An empty line inside a quote or list item: Enter exits there, as usual (the line keeps its style).
  if (empty && !SPLIT_INSIDE.has(container.type.name)) return false
  const types = [{ type: block.type, attrs: { ...block.attrs } }]
  if (!canSplit(tr.doc, $pos.pos, 1, types)) return false
  if (!dispatch) return true

  // What the next typed text carries: the marks at the cursor that belong on a new line, plus the
  // style's tag on an empty line (which has no text to inherit it from).
  const namedStyle = state.schema.marks.namedStyle
  let marks: readonly PMMark[] = (state.selection.empty ? state.storedMarks : null) ?? $pos.marks()
  marks = marks.filter(mark => !NOT_ACROSS_LINES.has(mark.type.name))
  if (namedStyle && !marks.some(mark => mark.type === namedStyle) && (empty || !hasText(block))) {
    marks = namedStyle.create({ id: block.attrs.styleId }).addToSet(marks)
  }
  tr.split($pos.pos, 1, types)
  tr.setStoredMarks(marks)
  tr.setMeta(APPLY_STYLE_META, true)
  dispatch(tr.scrollIntoView())
  return true
}

/** Moves the empty styled line at the cursor, the last line of a section, to just after the section. */
function exitSection(state: EditorState, tr: Transaction, dispatch?: (tr: Transaction) => void): boolean {
  const $pos = tr.selection.$from
  const depth = $pos.depth
  const content = $pos.node(depth - 1)
  if ($pos.index(depth - 1) !== content.childCount - 1) return false
  const sectionDepth = depth - 2
  if (sectionDepth < 1) return false
  const above = $pos.node(sectionDepth - 1)
  const after = $pos.indexAfter(sectionDepth - 1)
  const block = $pos.parent
  if (!above.canReplaceWith(after, after, block.type)) return false
  if (!dispatch) return true
  const insertAt = $pos.after(sectionDepth)
  tr.insert(insertAt, block.type.create(block.attrs))
  const mark = tr.mapping.maps.length
  // The section keeps at least one line: an only line stays (as a plain empty paragraph).
  if (content.childCount > 1) tr.delete($pos.before(depth), $pos.after(depth))
  else tr.setNodeMarkup($pos.before(depth), state.schema.nodes.paragraph ?? block.type, {})
  const start = tr.mapping.slice(mark).map(insertAt)
  tr.setSelection(TextSelection.create(tr.doc, start + 1))
  const namedStyle = state.schema.marks.namedStyle
  tr.setStoredMarks(namedStyle ? [namedStyle.create({ id: block.attrs.styleId })] : [])
  tr.setMeta(APPLY_STYLE_META, true)
  dispatch(tr.scrollIntoView())
  return true
}

/**
 * Text that lands on an empty styled line takes the line's style, even when the formatting held for
 * the next keystroke was lost (a click away and back, another plugin's change). Narrow on purpose:
 * text added next to deliberately unstyled words is left alone, and undo, redo and IME composition
 * are never touched.
 */
export function tagTextOnEmptyStyledLines(): Plugin {
  return new Plugin({
    key: new PluginKey('namedStyleAutoTag'),
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(tr => tr.docChanged)) return null
      const skip = transactions.some(
        tr => tr.getMeta(AUTO_TAG_META) || tr.getMeta('history$') || tr.getMeta('composition') !== undefined,
      )
      if (skip) return null
      const namedStyle = newState.schema.marks.namedStyle
      const code = newState.schema.marks.code
      if (!namedStyle) return null
      const ranges = changedRanges(transactions)
      const tr = newState.tr
      const seen = new Set<number>()
      for (const [from, to] of ranges) {
        newState.doc.nodesBetween(Math.max(0, from), Math.min(newState.doc.content.size, to), (node, pos) => {
          if (!node.isTextblock) return true
          if (seen.has(pos) || !STYLED_TYPES.has(node.type.name) || !isUuid(node.attrs.styleId)) return false
          seen.add(pos)
          if (!node.type.allowsMarkType(namedStyle)) return false
          const old = blockBefore(transactions, oldState, pos)
          if (!old || hasText(old)) return false
          const mark = namedStyle.create({ id: node.attrs.styleId })
          node.forEach((child, offset) => {
            if (!child.isText || child.marks.some(m => m.type === namedStyle || m.type === code)) return
            tr.addMark(pos + 1 + offset, pos + 1 + offset + child.nodeSize, mark)
          })
          return false
        })
      }
      if (!tr.docChanged) return null
      return tr.setMeta(AUTO_TAG_META, true).setMeta('addToHistory', false)
    },
  })
}

/** Ranges (in the final document) touched by a batch of transactions. */
function changedRanges(transactions: readonly Transaction[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const [index, tr] of transactions.entries()) {
    for (const map of tr.mapping.maps) {
      map.forEach((_from, _to, newFrom, newTo) => {
        let from = newFrom
        let to = newTo
        for (const later of transactions.slice(index + 1)) {
          from = later.mapping.map(from, -1)
          to = later.mapping.map(to, 1)
        }
        ranges.push([from, to])
      })
    }
  }
  return ranges
}

/** The textblock (before the batch) that the block at `pos` (after it) came from. */
function blockBefore(transactions: readonly Transaction[], oldState: EditorState, pos: number): PMNode | null {
  let oldPos = pos
  for (const tr of [...transactions].reverse()) oldPos = tr.mapping.invert().map(oldPos)
  const direct = oldState.doc.nodeAt(oldPos)
  const around = oldState.doc.resolve(Math.min(oldPos, oldState.doc.content.size)).parent
  return direct?.isTextblock ? direct : around.isTextblock ? around : null
}

/** Enter continues styles; empty styled lines type in their style. */
export const StyleContinuation = Extension.create({
  name: 'styleContinuation',
  // Before StarterKit's, the lists' and the details' Enter (all priority 100).
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }: { editor: Editor }) => continueStyleOnEnter(editor.state, tr => editor.view.dispatch(tr)),
    }
  },

  addProseMirrorPlugins() {
    return [tagTextOnEmptyStyledLines()]
  },
})
