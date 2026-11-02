// Local drafts: unsaved edits kept in localStorage (one key per account and note) until the server
// confirms them. The save queue writes them; opening a note decides what to do with one.
import type { DocJSON } from '../../../shared/types.ts'
import { imageIdsIn } from '../../../shared/imageRules.ts'
import { normalizeTags } from '../../../shared/tags.ts'

/** Unsaved edits kept in localStorage until the server confirms them. */
export type Draft = { title?: string; content?: DocJSON; tags?: string[] } & {
  editedAt: number
  /** The note's server `updatedAt` this tab last saw when the draft was written. */
  baseUpdatedAt: number | null
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const DRAFT_PREFIX = 'margin:draft:'

/** Drafts for one account: margin:draft:<userId>:<noteId>. */
export function draftPrefixFor(userId: string): string {
  return `${DRAFT_PREFIX}${userId}:`
}

/** localStorage, or null where the browser blocks it (some private modes). */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** A stored draft, or null when it's missing or unreadable. */
export function parseDraft(raw: string | null | undefined): Draft | null {
  if (!raw) return null
  try {
    const draft = JSON.parse(raw) as Draft
    if (typeof draft !== 'object' || draft === null || typeof draft.editedAt !== 'number') return null
    // Invalid tags in a stored draft would make every save of this note fail: drop just the tags.
    if (draft.tags !== undefined) {
      const tags = Array.isArray(draft.tags) ? normalizeTags(draft.tags) : null
      if (tags?.ok) draft.tags = tags.tags
      else delete draft.tags
    }
    return draft
  } catch {
    return null
  }
}

export type DraftDecision = 'none' | 'discard' | 'restore' | 'ask'

/**
 * What to do with a stored draft when its note is opened.
 * restore: nothing was saved since the draft's base, so the draft is newer.
 * ask: the note changed on the server after the draft's base; it may or may not include these edits.
 */
export function decideDraft(
  draft: Draft | null,
  note: { title: string; content: DocJSON; tags?: string[]; updatedAt: number },
): DraftDecision {
  if (!draft) return 'none'
  const sameTitle = draft.title === undefined || draft.title === note.title
  const sameContent = draft.content === undefined || JSON.stringify(draft.content) === JSON.stringify(note.content)
  // A draft from before tags existed has none: that means "unchanged".
  const sameTags = draft.tags === undefined || draft.tags.join(' ') === (note.tags ?? []).join(' ')
  if (sameTitle && sameContent && sameTags) return 'discard'
  if (draft.baseUpdatedAt !== null && note.updatedAt <= draft.baseUpdatedAt) return 'restore'
  return 'ask'
}

/**
 * The server only sees saved notes, so it could clean up an image that just a local draft still
 * uses. Tells it about this account's draft images (once per page load), at most 500 ids per call.
 */
export function touchDraftImages(storage: Storage | null, prefix: string, touch: (ids: string[]) => Promise<unknown>): void {
  if (!storage) return
  const ids = new Set<string>()
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    for (const id of imageIdsIn(storage.getItem(key) ?? '')) ids.add(id)
  }
  const list = [...ids]
  for (let start = 0; start < list.length; start += 500) {
    void touch(list.slice(start, start + 500)).catch(() => undefined)
  }
}
