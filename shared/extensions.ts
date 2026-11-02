// The editor's extensions, shared so the server validates documents against the exact same schema.
// Adding one? Review its attributes in shared/doc.ts and add its node and mark names there (a test
// fails until you do).
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { Highlight } from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { TextAlign } from '@tiptap/extension-text-align'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import { StarterKit } from '@tiptap/starter-kit'
import { MarginImage } from './image.ts'
import { NamedStyle, NamedStyleBlock, StyleContinuation } from './namedStyle.ts'
import { STYLE_ALIGNMENTS } from './styleProps.ts'

export const TEXT_ALIGNMENTS = STYLE_ALIGNMENTS
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

// StarterKit already includes link, underline, lists, undo/redo, drop/gap cursor and trailing node.
export const extensions = [
  StarterKit.configure({
    heading: { levels: [...HEADING_LEVELS] },
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
  }),
  NamedStyle,
  NamedStyleBlock,
  StyleContinuation,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'], alignments: [...TEXT_ALIGNMENTS] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // Column resizing is only installed when the editor is created editable. Margin creates it
  // read-only only for notes it can't open, which never become editable, so that's fine.
  TableKit.configure({ table: { resizable: true, cellMinWidth: 48 } }),
  MarginImage.configure({
    inline: false,
    allowBase64: false,
    resize: {
      enabled: true,
      directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      minWidth: 48,
      minHeight: 48,
      alwaysPreserveAspectRatio: true,
    },
  }),
  Details.configure({ persist: true, HTMLAttributes: { class: 'details' } }),
  DetailsSummary,
  DetailsContent,
  // CSS shows the document placeholder only on an empty first paragraph, and the summary one on
  // empty section titles, so decorating every empty node is harmless.
  Placeholder.configure({
    includeChildren: true,
    showOnlyCurrent: false,
    placeholder: ({ node }) => (node.type.name === 'detailsSummary' ? 'Section title' : 'Start writing…'),
  }),
]
