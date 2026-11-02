import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { ExternalLink, Unlink } from 'lucide-react'
import { isSafeHref, normalizeUrl } from '../links.ts'

type LinkPopoverProps = {
  editor: Editor
  onClose: () => void
}

export function LinkPopover({ editor, onClose }: LinkPopoverProps) {
  const currentHref = (editor.getAttributes('link').href as string | undefined) ?? ''
  // Remember the selection from when the popover opened; focus moves to the input after this.
  const [range] = useState(() => ({ from: editor.state.selection.from, to: editor.state.selection.to }))
  const [url, setUrl] = useState(currentHref)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function close() {
    onClose()
    editor.view.focus()
  }

  function removeLink() {
    editor.chain().focus().setTextSelection(range).extendMarkRange('link').unsetLink().run()
    onClose()
  }

  function apply(event: FormEvent) {
    event.preventDefault()
    const text = url.trim()
    if (!text) {
      removeLink()
      return
    }

    const href = normalizeUrl(text)
    if (!isSafeHref(href)) {
      setError('Use a web, email or phone link.')
      return
    }

    const empty = range.from === range.to
    const applied =
      empty && !currentHref
        ? // Nothing selected: insert the address itself as linked text.
          editor
            .chain()
            .focus()
            .setTextSelection(range.from)
            .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
            .run()
        : editor.chain().focus().setTextSelection(range).extendMarkRange('link').setLink({ href }).run()

    if (!applied) {
      setError("That link can't be used here.")
      return
    }
    onClose()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  return (
    <div className="popover link-popover" role="dialog" aria-label="Edit link">
      <form onSubmit={apply}>
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          placeholder="Paste or type a link"
          aria-label="Link address"
          value={url}
          onChange={event => {
            setUrl(event.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="button primary small">
          Apply
        </button>
      </form>
      {error && <p className="popover-error">{error}</p>}
      {currentHref && (
        <div className="link-actions">
          {isSafeHref(currentHref) && (
            <a className="button small" href={currentHref} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> Open
            </a>
          )}
          <button type="button" className="button small" onClick={removeLink}>
            <Unlink size={14} aria-hidden="true" /> Remove
          </button>
        </div>
      )}
    </div>
  )
}
