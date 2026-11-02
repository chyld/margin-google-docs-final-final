import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { EditorOptions, JSONContent, Editor as TiptapEditor } from '@tiptap/react'
import { extensions as sharedExtensions } from '../../../shared/extensions.ts'
import type { DocJSON } from '../../../shared/types.ts'
import { loadDocumentFonts } from '../state/fonts.ts'
import { subscribeStyles } from '../state/namedStyles.ts'
import { styledClipboardSerializer } from '../editor/clipboard.ts'
import { handleEditorShortcut } from '../editor/commands.ts'
import { EndStyleShortcuts } from '../editor/endStyle.ts'
import { onReauthenticated } from '../state/session.ts'
import { cancelImageUploads, ImageInput } from '../editor/imageInput.ts'
import { showNotice } from '../state/notices.ts'
import { Toolbar } from './Toolbar.tsx'
import { createPortal } from 'react-dom'
import { getFormatPanel, setFormatPanelOpen, toggleFormatPanel, useFormatPanel } from '../state/formatPanel.ts'
import { FormatPanel } from './FormatPanel.tsx'

// Module-level so useEditor sees the same array every render (a new one would re-apply options).
// ImageInput is client-only behavior and adds nothing to the schema the server checks against.
const extensions = [...sharedExtensions, ImageInput, EndStyleShortcuts]
const FONT_SCAN_DELAY_MS = 500

type EditorProps = {
  content: DocJSON
  /** Can't be edited (and its uploads are cancelled). */
  readOnly: boolean
  /** Briefly not editable (signing out); uploads keep going. */
  paused?: boolean
  editorRef: RefObject<TiptapEditor | null>
  onChange: (content: DocJSON) => void
  onContentError: () => void
}

export function Editor({ content, readOnly, paused = false, editorRef, onChange, onContentError }: EditorProps) {
  const [linkOpen, setLinkOpen] = useState(false)
  // Bumped by the Format sidebar's style name: opens the toolbar's Styles menu.
  const [stylesMenuRequest, setStylesMenuRequest] = useState(0)
  const openStylesMenu = useCallback(() => setStylesMenuRequest(count => count + 1), [])
  // Once the stored content fails to load, the editor holds a fallback doc that must never be saved.
  const blocked = useRef(false)
  const callbacks = useRef({ onChange, onContentError })

  useEffect(() => {
    callbacks.current = { onChange, onContentError }
  })

  // Stable options: a new object each render would make Tiptap re-apply them on every keystroke.
  const editorProps = useMemo<EditorOptions['editorProps']>(
    () => ({
      attributes: { class: 'document', 'aria-label': 'Document', spellcheck: 'true' },
      handleKeyDown: (view, event) => handleEditorShortcut(view, event, editorRef.current, { openLink: () => setLinkOpen(true) }),
      // Links don't open on a plain click (that would make them hard to edit); Ctrl/Cmd+click opens them.
      handleClick: (_view, _pos, event) => {
        if (!(event.metaKey || event.ctrlKey)) return false
        const href = (event.target as HTMLElement | null)?.closest('a[href]')?.getAttribute('href')
        if (!href) return false
        window.open(href, '_blank', 'noopener,noreferrer')
        return true
      },
      clipboardSerializer: styledClipboardSerializer,
    }),
    [],
  )

  const editor = useEditor({
    extensions,
    content: content as JSONContent,
    editable: !readOnly,
    enableContentCheck: true,
    // Runs inside the Editor constructor, during render: only record it here (see the effect below).
    onContentError: () => {
      blocked.current = true
    },
    onUpdate: ({ editor: current }) => {
      if (blocked.current || !current.isEditable) return
      callbacks.current.onChange(current.getJSON() as DocJSON)
    },
    editorProps,
  })

  // A layout effect, so a note that can't be edited is locked before the first paint.
  useLayoutEffect(() => {
    if (!editor) return
    if (blocked.current) callbacks.current.onContentError()
    // Pass emitUpdate=false: an update event here would autosave the fallback doc.
    editor.setEditable(!readOnly && !paused && !blocked.current, false)
    if (readOnly || blocked.current) cancelUploads(editor)
  }, [editor, readOnly, paused])

  // Leaving the note cancels its uploads; say so rather than silently dropping the images.
  useEffect(() => {
    if (!editor) return
    return () => cancelUploads(editor)
  }, [editor])

  // Load the Google Fonts this note uses, now and whenever the content changes.
  useEffect(() => {
    if (!editor) return
    void loadDocumentFonts(content).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onUpdate = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void loadDocumentFonts(editor.getJSON()).catch(() => undefined), FONT_SCAN_DELAY_MS)
    }
    editor.on('update', onUpdate)
    return () => {
      clearTimeout(timer)
      editor.off('update', onUpdate)
    }
    // The initial content only matters once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Styles load (or change) after the note: load the fonts their look needs.
  useEffect(() => {
    if (!editor) return
    return subscribeStyles(() => {
      if (!editor.isDestroyed) void loadDocumentFonts(editor.getJSON()).catch(() => undefined)
    })
  }, [editor])

  // Signed in again after the session ended: fonts and images that failed meanwhile load now.
  useEffect(() => {
    if (!editor) return
    return onReauthenticated(() => {
      if (editor.isDestroyed) return
      void loadDocumentFonts(editor.getJSON()).catch(() => undefined)
      for (const image of editor.view.dom.querySelectorAll('img')) {
        const src = image.getAttribute('src')
        // Setting src again makes the browser fetch it again.
        if (src && image.complete && image.naturalWidth === 0) image.setAttribute('src', src)
      }
    })
  }, [editor])

  useEffect(() => {
    editorRef.current = editor
    return () => {
      editorRef.current = null
    }
  }, [editor, editorRef])

  const panel = useFormatPanel()

  /** Closes the Format sidebar; focus goes back to its toggle unless something else takes it. */
  const closePanel = useCallback(({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    setFormatPanelOpen(false)
    // After the phone sheet's inert background is live again.
    if (restoreFocus) requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('.format-toggle')?.focus()))
  }, [])

  // Leaving the note closes an overlay or sheet (the docked choice is remembered as it is).
  useEffect(
    () => () => {
      if (getFormatPanel().mode !== 'docked' && getFormatPanel().open) setFormatPanelOpen(false)
    },
    [],
  )

  // Ctrl/⌘+Alt+Shift+\ shows or hides the Format sidebar (matched by key position, any layout).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || !event.shiftKey || event.code !== 'Backslash') return
      // AltGr (Ctrl+Alt on Windows) types characters on some layouts: never take it.
      if (event.repeat || event.isComposing || event.getModifierState?.('AltGraph')) return
      // Not while the session dialog or another modal (the open notes drawer) is up. The drawer keeps
      // role="dialog" while closed, so only modal ones count.
      if (document.querySelector('.session-overlay, [role="dialog"][aria-modal="true"]:not(#format-panel)')) return
      event.preventDefault()
      event.stopPropagation()
      const { open, mode } = getFormatPanel()
      // Closing an overlay or sheet hands focus back like its close button (it may hold focus).
      if (open && mode !== 'docked' && document.activeElement?.closest('#format-panel')) closePanel()
      else toggleFormatPanel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closePanel])

  function focusEnd(event: MouseEvent<HTMLDivElement>) {
    // Clicking the gray canvas or page margin puts the cursor at the end, like a word processor.
    if (event.target !== event.currentTarget || !editor || !editor.isEditable) return
    event.preventDefault()
    editor.commands.focus('end')
  }

  // No changes possible: read-only, signing out, or content Margin can't edit. One flag for the
  // toolbar and the Format sidebar, so they agree.
  const off = readOnly || paused || blocked.current
  const panelNode = editor && panel.open && (
    <FormatPanel
      editor={editor}
      mode={panel.mode}
      off={off}
      readOnlyNote={readOnly || blocked.current}
      onClose={closePanel}
      onOpenStyles={openStylesMenu}
    />
  )

  return (
    <>
      <Toolbar editor={editor} readOnly={off} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} stylesMenuRequest={stylesMenuRequest} />
      <div className="editor-body">
        <div className="canvas" onMouseDown={focusEnd}>
          <div className="page" onMouseDown={focusEnd}>
            <EditorContent editor={editor} />
          </div>
        </div>
        {panel.mode !== 'sheet' && panelNode}
      </div>
      {panel.mode === 'sheet' &&
        panelNode &&
        createPortal(
          <>
            <div className="format-scrim" aria-hidden="true" onClick={() => closePanel()} />
            {panelNode}
          </>,
          document.body,
        )}
    </>
  )
}

function cancelUploads(editor: TiptapEditor) {
  const cancelled = cancelImageUploads(editor)
  if (cancelled > 0) showNotice(cancelled === 1 ? 'Image upload cancelled.' : `${cancelled} image uploads cancelled.`)
}
