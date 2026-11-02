// What the formatting toolbar shows. Formatting values come from the same reading as the Format
// sidebar (formatInfo.ts), so the two can't disagree; the rest (what can be done here, which lists
// and blocks are active) comes from the editor.
import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { ImageAlign } from '../../../shared/image.ts'
import { BLOCK_TYPOGRAPHY } from '../../../shared/styleProps.ts'
import type { NamedStyle, StyleAlign } from '../../../shared/styleProps.ts'
import { formatInfoFor, parseFontSize } from './formatInfo.ts'
import type { BlockType, FormatInfo } from './formatInfo.ts'
import { currentStyle } from './styleCommands.ts'
import type { CurrentStyle } from './styleCommands.ts'
import type { StylesStatus } from './styleIndex.ts'

export type ToolbarState = {
  editable: boolean
  canUndo: boolean
  canRedo: boolean
  /** 'other' when mixed or not a paragraph or heading (shown as "—"). */
  block: BlockType
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  canCode: boolean
  color: string | null
  highlight: string | null
  link: boolean
  /** null when the paragraphs are aligned differently. */
  align: StyleAlign | null
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
  codeBlock: boolean
  canMarks: boolean
  canBulletList: boolean
  canOrderedList: boolean
  canTaskList: boolean
  canBlockquote: boolean
  canCodeBlock: boolean
  canHorizontalRule: boolean
  canAlign: boolean
  fontFamily: string | null
  /** In points; null when mixed or not in pt/px. */
  fontSize: number | null
  imageSelected: boolean
  imageAlign: ImageAlign
  inTable: boolean
  canInsertTable: boolean
  details: boolean
  canDetails: boolean
  style: CurrentStyle
}

/** The cursor's paragraph type from the node alone (while its paragraph style isn't known). */
function nodeBlock(state: EditorState): BlockType {
  const node = state.selection.$from.parent
  if (node.type.name === 'heading') return `h${node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6}`
  return node.type.name === 'paragraph' ? 'paragraph' : 'other'
}

/** The size box's value: a style that hasn't loaded shows the paragraph type's default size. */
export function toolbarFontSize(info: FormatInfo, state: EditorState): number | null {
  if (info.text.fontSize.source !== 'unresolved') return info.text.fontSize.value
  const block = nodeBlock(state)
  return parseFontSize(BLOCK_TYPOGRAPHY[block === 'other' ? 'paragraph' : block].fontSize)
}

/** The toolbar's formatting values for a reading of the selection. */
export function toolbarFormatting(info: FormatInfo, state: EditorState) {
  const { text, explicit } = info
  // Only values a mark or a saved style gives every part; not the page's or an element's look.
  const flag = (key: 'bold' | 'italic' | 'underline' | 'strike') => text[key].value === true && explicit[key]
  const shown = <T,>(key: 'fontFamily' | 'color' | 'highlight', value: T | null) => (explicit[key] ? value : null)
  return {
    bold: flag('bold'),
    italic: flag('italic'),
    underline: flag('underline'),
    strike: flag('strike'),
    fontFamily: shown('fontFamily', text.fontFamily.value),
    color: shown('color', text.color.value),
    highlight: shown('highlight', text.highlight.value),
    fontSize: toolbarFontSize(info, state),
    align: info.align.source === 'unresolved' ? 'left' : info.align.value,
    block: info.block.source === 'unresolved' ? nodeBlock(state) : (info.block.value ?? 'other'),
  } satisfies Partial<ToolbarState>
}

// Runs after every transaction (and when the saved styles change); editor.can() must be called here
// so disabled states stay current.
export function selectState(editor: Editor | null, styles: readonly NamedStyle[], status: StylesStatus): ToolbarState | null {
  if (!editor) return null
  const can = editor.can()
  const imageSelected = editor.isActive('image')
  const details = editor.isActive('details')
  return {
    ...toolbarFormatting(formatInfoFor(editor.state, styles, status), editor.state),
    editable: editor.isEditable,
    canUndo: can.undo(),
    canRedo: can.redo(),
    code: editor.isActive('code'),
    canCode: can.toggleCode(),
    link: editor.isActive('link'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    canMarks: can.toggleBold(),
    canBulletList: can.toggleBulletList(),
    canOrderedList: can.toggleOrderedList(),
    canTaskList: can.toggleTaskList(),
    canBlockquote: can.toggleBlockquote(),
    canCodeBlock: can.toggleCodeBlock(),
    canHorizontalRule: can.setHorizontalRule(),
    canAlign: can.setTextAlign('left'),
    imageSelected,
    imageAlign: imageSelected ? ((editor.getAttributes('image').align as ImageAlign | null) ?? 'left') : 'left',
    inTable: editor.isActive('table'),
    canInsertTable: can.insertTable({ rows: 1, cols: 1 }),
    details,
    canDetails: details ? can.unsetDetails() : can.setDetails(),
    style: currentStyle(editor.state),
  }
}
