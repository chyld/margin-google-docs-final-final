// Editor commands used by more than one control (the toolbar, the Format sidebar, keyboard shortcuts).
import type { Editor } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { ensureStyleFont } from '../state/fonts.ts'
import { favoriteInSlot, getStylesSnapshot, loadStyles } from '../state/namedStyles.ts'
import { showNotice } from '../state/notices.ts'
import { runWithEndStyle } from './endStyle.ts'
import { stepFontSize } from './fontSize.ts'
import { applyFailureMessage, applyStyle, clearInlineFormatting } from './styleCommands.ts'

/** Clears marks, style links and block types (Ctrl/⌘+\\ too). Works with a collapsed cursor. */
export function clearFormatting(editor: Editor, { focus = true } = {}): void {
  // Ends the style too (nothing to keep: everything is being cleared).
  runWithEndStyle(
    editor,
    c =>
      c
        .command(({ tr }) => {
          clearInlineFormatting(tr)
          return true
        })
        .clearNodes(),
    { materialize: false, focus },
  )
}

// Pressed again while the styles are still loading: one load, then the latest press is applied.
let pendingFavorite: { editor: Editor; slot: number } | null = null

function runFavorite(editor: Editor, slot: number): void {
  if (editor.isDestroyed || !editor.isEditable) return
  const style = favoriteInSlot(slot)
  if (!style) {
    showNotice(`No favorite style ${slot} yet. Star a style in the Styles menu.`)
    return
  }
  const result = applyStyle(editor.state, style)
  if ('tr' in result) editor.view.dispatch(result.tr)
  else showNotice(applyFailureMessage(result.reason, style.name))
  ensureStyleFont(style.props.fontFamily)
}

/** Applies favorite style `slot` to the editor's current selection, loading the styles first if needed. */
export function applyFavorite(editor: Editor, slot: number): void {
  if (getStylesSnapshot().loaded) {
    runFavorite(editor, slot)
    return
  }
  const waiting = pendingFavorite !== null
  pendingFavorite = { editor, slot }
  if (waiting) return
  loadStyles()
    .then(() => {
      const next = pendingFavorite
      pendingFavorite = null
      if (next) runFavorite(next.editor, next.slot)
    })
    .catch(() => {
      pendingFavorite = null
      showNotice("Couldn't load your styles. Try again in a moment.")
    })
}

/**
 * The document's own shortcuts (runs before the editor's keymaps). Keys are matched by position
 * (event.code) where Shift or the keyboard layout would change event.key. Returns true when handled.
 */
export function handleEditorShortcut(view: EditorView, event: KeyboardEvent, editor: Editor | null, { openLink }: { openLink: () => void }): boolean {
  const mod = event.metaKey || event.ctrlKey
  // Ctrl/⌘+Alt+Shift+1…9 applies favorite style 1…9.
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
  if (mod && event.altKey && event.shiftKey && digit) {
    event.preventDefault()
    if (!view.editable) return true
    if (editor) applyFavorite(editor, Number(digit))
    return true
  }
  // Ctrl/⌘+\ clears formatting, like Google Docs (Shift+\ is the sidebar).
  if (mod && !event.altKey && !event.shiftKey && event.code === 'Backslash') {
    event.preventDefault()
    if (view.editable && editor) clearFormatting(editor)
    return true
  }
  if (!mod || event.altKey) return false
  // Ctrl+Shift+. / Ctrl+Shift+, change the font size.
  if (event.shiftKey && (event.code === 'Period' || event.code === 'Comma')) {
    event.preventDefault()
    if (view.editable && editor) stepFontSize(editor, event.code === 'Period' ? 1 : -1)
    return true
  }
  if (event.shiftKey || event.key.toLowerCase() !== 'k') return false
  event.preventDefault()
  if (view.editable) openLink()
  return true
}
