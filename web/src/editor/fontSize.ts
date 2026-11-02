// Font sizes in points, as the toolbar shows them.
import type { Editor } from '@tiptap/core'
import { BLOCK_TYPOGRAPHY } from '../../../shared/styleProps.ts'
import { getStylesSnapshot } from '../state/namedStyles.ts'
import { runWithEndStyle } from './endStyle.ts'
import { formatInfoFor, parseFontSize } from './formatInfo.ts'
import { stylesStatus } from './styleIndex.ts'
import { toolbarFontSize } from './toolbarState.ts'

/** Normal text's size (pt), from the page's typography. */
const DEFAULT_SIZE = parseFontSize(BLOCK_TYPOGRAPHY.paragraph.fontSize) ?? 11

export const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96]
export const MIN_FONT_SIZE = 1
export const MAX_FONT_SIZE = 400

/** A stored font-size value in points, or null when it isn't expressed in pt or px (defined in formatInfo.ts). */
export { parseFontSize }

/** The size at the cursor, as the toolbar's size box shows it (null when mixed or not in pt/px). */
export function currentFontSize(editor: Editor): number | null {
  const snapshot = getStylesSnapshot()
  return toolbarFontSize(formatInfoFor(editor.state, snapshot.styles, stylesStatus(snapshot)), editor.state)
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
  // Mixed sizes (blank box): step from normal text's size.
  const size = currentFontSize(editor) ?? DEFAULT_SIZE
  return setFontSize(editor, size + delta)
}
