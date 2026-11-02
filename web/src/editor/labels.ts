// How paragraph types and alignments are named on screen (toolbar, Styles menu, Format sidebar).
import { STYLE_BLOCKS } from '../../../shared/styleProps.ts'
import type { StyleAlign, StyleBlock } from '../../../shared/styleProps.ts'

export const BLOCK_LABELS: Record<StyleBlock, string> = {
  paragraph: 'Normal text',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
}

/** The paragraph types in menu order, with their names. */
export const BLOCK_OPTIONS = STYLE_BLOCKS.map(block => ({ value: block, label: BLOCK_LABELS[block] }))

/** A paragraph type's name; anything else (a list item, a code block) is "Other". */
export function blockLabel(block: string): string {
  return BLOCK_LABELS[block as StyleBlock] ?? (block === 'other' ? 'Other' : block)
}

/** Alignment as a value ("Justified"), as the Format sidebar reports it. */
export const ALIGN_NAMES: Record<StyleAlign, string> = { left: 'Left', center: 'Center', right: 'Right', justify: 'Justified' }
