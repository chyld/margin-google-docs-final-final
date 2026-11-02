// Opening a note: the server copy combined with edits the server hasn't confirmed yet, from this
// tab's memory or from a local draft (asking first when the note was saved again after the draft).
import { checkSchema } from '../../../shared/schema.ts'
import type { DocJSON, Note } from '../../../shared/types.ts'
import { displayTitle } from '../format.ts'
import { decideDraft } from './drafts.ts'
import type { SavePatch, SaveQueue } from './saveQueue.ts'

export type Prepared = { title: string; content: DocJSON; tags: string[]; notice: string | null }

/**
 * What the note view shows for a note just loaded. Registers the note with the queue. `confirm` asks
 * the user (window.confirm in the app).
 */
export function restoreForOpen(queue: SaveQueue, note: Note, { confirm }: { confirm: (message: string) => boolean }): Prepared {
  const saved: Prepared = { title: note.title, content: note.content, tags: note.tags, notice: null }
  // Pending edits, plus saved ones if this response is older than our last save (it raced the PATCH).
  const local = queue.getLocalChanges(note.id, note.updatedAt)
  // Drafts written from now on are based on this version.
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
    confirm(
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
