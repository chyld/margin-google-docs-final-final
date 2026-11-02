import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import { Selection } from '@tiptap/pm/state'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { AlertTriangle, CircleCheck, CloudOff, Download, Loader2, PanelRight, Trash2 } from 'lucide-react'
import { MAX_TITLE_LENGTH } from '../../../shared/constants.ts'
import { checkSchema } from '../../../shared/schema.ts'
import type { DocJSON, Note } from '../../../shared/types.ts'
import { api, ApiError, StaleSessionError } from '../api.ts'
import { displayTitle } from '../format.ts'
import { pendingImageUploads, subscribePendingUploads } from '../editor/imageInput.ts'
import { decideDraft } from '../notes/saveQueue.ts'
import type { SavePatch, SaveQueue, SaveState } from '../notes/saveQueue.ts'
import { Editor } from './Editor.tsx'
import { TagEditor } from './TagEditor.tsx'
import { toggleFormatPanel, useFormatPanel } from '../state/formatPanel.ts'

type NoteViewProps = {
  id: string
  queue: SaveQueue
  autoFocusTitle: boolean
  /** Read-only while signing out. */
  locked: boolean
  /** Bumped when the same user signs in again after the session ended. */
  reauthEpoch: number
  /** Put keyboard focus on the title once loaded without selecting it (opened from the phone drawer). */
  focusOnOpen?: boolean
  onTitleChange: (id: string, title: string) => void
  /** The note's tags changed here (not yet saved): the sidebar row follows right away. */
  onTagsChange: (id: string, tags: string[]) => void
  onDelete: (id: string) => void
  /** All of the user's tags, for suggestions. */
  allTags: string[]
  /** A tag chip's name was clicked: filter the notes list by it. */
  onOpenTag: (tag: string) => void
}

type Prepared = { title: string; content: DocJSON; tags: string[]; notice: string | null }

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; note: Note; prepared: Prepared }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }

/** Combines the server copy with edits the server hasn't confirmed yet (in memory or in a draft). */
function prepareNote(queue: SaveQueue, note: Note): Prepared {
  const saved: Prepared = { title: note.title, content: note.content, tags: note.tags, notice: null }
  // Pending edits, plus saved ones if this response is older than our last save (it raced the PATCH).
  const local = queue.getLocalChanges(note.id, note.updatedAt)
  queue.open(note.id, note.updatedAt)

  if (local) {
    return { title: local.title ?? note.title, content: local.content ?? note.content, tags: local.tags ?? note.tags, notice: null }
  }

  const draft = queue.readDraft(note.id)
  const decision = decideDraft(draft, note)
  if (!draft || decision === 'none') return saved
  if (decision === 'discard') {
    queue.discardDraft(note.id)
    return saved
  }
  // A draft the editor can't open (e.g. written by another version) is left in storage, not restored.
  if (draft.content !== undefined && !checkSchema(draft.content).ok) return saved

  const restore =
    decision === 'restore' ||
    window.confirm(
      `Margin found changes to "${displayTitle(note.title)}" from ${new Date(draft.editedAt).toLocaleString()} ` +
        "that weren't confirmed as saved. The note was saved again after that.\n\nRestore those changes?",
    )
  if (!restore) {
    queue.discardDraft(note.id)
    return saved
  }

  const patch: SavePatch = {}
  if (draft.title !== undefined) patch.title = draft.title
  if (draft.content !== undefined) patch.content = draft.content
  if (draft.tags !== undefined) patch.tags = draft.tags
  queue.update(note.id, patch)
  return {
    title: patch.title ?? note.title,
    content: patch.content ?? note.content,
    tags: patch.tags ?? note.tags,
    notice: "Restored changes that hadn't been saved yet.",
  }
}

/** Shows or hides the Format sidebar. */
function FormatToggle() {
  const { open } = useFormatPanel()
  const mac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
  return (
    <button
      type="button"
      className={open ? 'icon-button format-toggle is-active' : 'icon-button format-toggle'}
      aria-label="Format sidebar"
      title={`Format sidebar (${mac ? '⌘⌥⇧' : 'Ctrl+Alt+Shift+'}\\)`}
      aria-expanded={open}
      aria-controls={open ? 'format-panel' : undefined}
      onClick={toggleFormatPanel}
    >
      <PanelRight size={18} aria-hidden="true" />
    </button>
  )
}

/** Focus is nowhere useful: on the page body, or still on the (now hidden) phone drawer. */
function isFocusLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || active.closest('.sidebar') !== null
}

function downloadNote(note: Note): void {
  const blob = new Blob([JSON.stringify(note, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${displayTitle(note.title).replace(/[\\/:*?"<>|]+/g, '_')}.json`
  link.click()
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The label is always in the DOM for screen readers; on phones only the icon shows.
function SaveIndicator({ state, uploading }: { state: SaveState; uploading: number }) {
  if (uploading > 0 && state.status !== 'error' && state.status !== 'paused') {
    return (
      <span className="save-status is-busy" role="status">
        <Loader2 size={15} className="spin" aria-hidden="true" />
        <span className="save-label">{uploading === 1 ? 'Uploading image…' : `Uploading ${uploading} images…`}</span>
      </span>
    )
  }
  switch (state.status) {
    case 'pending':
    case 'saving':
      return (
        <span className="save-status is-busy" role="status">
          <Loader2 size={15} className="spin" aria-hidden="true" />
          <span className="save-label">Saving…</span>
        </span>
      )
    case 'saved':
      return (
        <span className="save-status is-saved" role="status">
          <CircleCheck size={15} aria-hidden="true" />
          <span className="save-label">All changes saved</span>
        </span>
      )
    case 'retrying':
      return (
        <span className="save-status is-warning" role="status" title={state.error ?? undefined}>
          <CloudOff size={15} aria-hidden="true" />
          <span className="save-label">Save failed, retrying…</span>
        </span>
      )
    case 'paused':
      return (
        <span className="save-status is-paused" role="status">
          <CloudOff size={15} aria-hidden="true" />
          <span className="save-label">Signed out, not saving yet</span>
        </span>
      )
    case 'error':
      return (
        <span className="save-status is-error" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="save-label">Couldn't save: {state.error}</span>
        </span>
      )
    default:
      return <span className="save-status" />
  }
}

export function NoteView(props: NoteViewProps) {
  const { id, queue, autoFocusTitle, locked, reauthEpoch, focusOnOpen = false, onTitleChange, onTagsChange, onDelete } = props
  const { allTags, onOpenTag } = props
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [contentError, setContentError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<TiptapEditor | null>(null)
  const saveState = useSyncExternalStore(queue.subscribe, () => queue.getState(id))
  const uploading = useSyncExternalStore(subscribePendingUploads, pendingImageUploads)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    api
      .getNote(id, controller.signal)
      .then(note => {
        if (controller.signal.aborted) return
        const prepared = prepareNote(queue, note)
        setTitle(prepared.title)
        setTags(prepared.tags)
        // The sidebar row shows unsaved tags too (e.g. restored from a draft).
        if (prepared.tags.join(' ') !== note.tags.join(' ')) onTagsChange(note.id, prepared.tags)
        setLoad({ kind: 'ready', note, prepared })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // Sent with the session a sign-in just replaced: load again with the new one.
        if (error instanceof StaleSessionError) {
          setAttempt(value => value + 1)
          return
        }
        if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
          setLoad({ kind: 'missing' })
        } else {
          setLoad({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      })

    return () => {
      controller.abort()
      // Leaving the note: save what's pending now instead of waiting for the debounce.
      void queue.flush(id)
    }
  }, [id, queue, attempt])

  // Signed in again after the session ended: retry only if loading failed; a ready editor stays as is.
  const failed = load.kind === 'failed'
  useEffect(() => {
    if (reauthEpoch > 0 && failed) setAttempt(value => value + 1)
    // Only a new epoch should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reauthEpoch])

  useEffect(() => {
    if (load.kind !== 'ready') return
    if (autoFocusTitle) {
      titleRef.current?.focus()
      titleRef.current?.select()
    } else if (focusOnOpen && isFocusLost()) {
      titleRef.current?.focus({ preventScroll: true })
    }
    // Only when the note first becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind, autoFocusTitle])

  // Ctrl/Cmd+S saves right away instead of opening the browser's save dialog.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void queue.flush(id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [id, queue])

  function handleTitleChange(value: string) {
    setTitle(value)
    queue.update(id, { title: value })
    onTitleChange(id, value)
  }

  function handleTagsChange(next: string[]) {
    setTags(next)
    queue.update(id, { tags: next })
    onTagsChange(id, next)
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const editor = editorRef.current
    if (!editor?.isEditable) return
    // Focus synchronously (commands.focus waits a frame) so fast typing lands in the document.
    editor.view.dispatch(editor.state.tr.setSelection(Selection.atStart(editor.state.doc)))
    editor.view.focus()
  }

  if (load.kind === 'loading') {
    return <main className="note-view is-loading" aria-busy="true" />
  }

  if (load.kind === 'missing') {
    return (
      <main className="empty-main">
        <div className="empty-state">
          <h1>Note not found</h1>
          <p>It may have been deleted.</p>
        </div>
      </main>
    )
  }

  if (load.kind === 'failed') {
    return (
      <main className="empty-main">
        <div className="empty-state">
          <h1>Couldn't open this note</h1>
          <p>{load.message}</p>
          <button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  const { note, prepared } = load

  return (
    <main className="note-view">
      <header className="note-header">
        <input
          ref={titleRef}
          className="note-title"
          value={title}
          placeholder="Untitled document"
          aria-label="Title"
          maxLength={MAX_TITLE_LENGTH}
          readOnly={contentError || locked}
          onChange={event => handleTitleChange(event.target.value)}
          onKeyDown={handleTitleKeyDown}
        />
        <SaveIndicator state={saveState} uploading={uploading} />
        <FormatToggle />
        <button
          type="button"
          className="icon-button danger"
          title="Delete note"
          aria-label="Delete note"
          onClick={() => onDelete(id)}
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </header>

      <TagEditor
        tags={tags}
        suggestions={allTags}
        disabled={contentError || locked}
        onChange={handleTagsChange}
        onOpenTag={onOpenTag}
        onLeave={() => void queue.flush(id)}
      />

      {prepared.notice && <div className="banner info">{prepared.notice}</div>}
      {contentError && (
        <div className="banner error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            This note contains content Margin can't display, so it's open read-only. The saved version has not
            been changed.
          </span>
          <button type="button" className="button small" onClick={() => downloadNote(note)}>
            <Download size={14} aria-hidden="true" /> Download raw content
          </button>
        </div>
      )}

      <Editor
        content={prepared.content}
        readOnly={contentError}
        paused={locked}
        editorRef={editorRef}
        onChange={content => queue.update(id, { content })}
        onContentError={() => setContentError(true)}
      />
    </main>
  )
}
