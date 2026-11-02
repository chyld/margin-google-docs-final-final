// Font sizes in points, as the toolbar shows them.
import type { Editor } from '@tiptap/core'
import { HEADING_LEVELS } from '../../../shared/extensions.ts'
import { runWithEndStyle } from './endStyle.ts'
import { styleById } from '../state/namedStyles.ts'
import { effectiveTextProps } from './styleCommands.ts'
import { parseFontSize } from './formatInfo.ts'

export const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96]
export const MIN_FONT_SIZE = 1
export const MAX_FONT_SIZE = 400

// Matches the pt sizes in editor.css.
const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 }
const PARAGRAPH_SIZE = 11

/** A stored font-size value in points, or null when it isn't expressed in pt or px. */
// Moved to formatInfo.ts (a leaf module shared with the Format sidebar).
export { parseFontSize }

/**
 * The size at the cursor: the mark's size, else the size the text's style gives it, else the block's
 * default. Null if it can't be shown in pt.
 */
export function currentFontSize(editor: Editor): number | null {
  const raw = editor.getAttributes('textStyle').fontSize as string | null | undefined
  if (raw) return parseFontSize(raw)
  const styled = effectiveTextProps(editor.state, id => styleById(id)?.props)?.fontSize
  if (styled) return parseFontSize(styled)
  const linked = styleById(editor.state.selection.$from.parent.attrs.styleId as string | undefined)?.props.block
  if (linked && linked !== 'paragraph') return HEADING_SIZES[Number(linked.slice(1))] ?? PARAGRAPH_SIZE
  for (const level of HEADING_LEVELS) {
    if (editor.isActive('heading', { level })) return HEADING_SIZES[level] ?? PARAGRAPH_SIZE
  }
  return PARAGRAPH_SIZE
}

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size * 2) / 2))
}

export function setFontSize(editor: Editor, size: number): boolean {
  // A formatting-bar change: ends the active style first (keeping its look).
  return runWithEndStyle(editor, c => c.setFontSize(`${clampFontSize(size)}pt`))
}

/** Steps the size at the cursor by `delta` points (Ctrl+Shift+. and Ctrl+Shift+,). */
export function stepFontSize(editor: Editor, delta: number): boolean {
  const size = currentFontSize(editor) ?? PARAGRAPH_SIZE
  return setFontSize(editor, size + delta)
}
