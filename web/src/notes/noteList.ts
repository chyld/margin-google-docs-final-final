// The notes list, the recent-notes rail and the tag counts, kept in step with saves, searches,
// creates and deletes. Framework-free (one store per signed-in page; App reads it with
// useSyncExternalStore), so the ordering rules below are unit tested with fake timers.
//
// The rules that keep it right:
// - Only the newest list (and tag-count) request may apply: older answers can arrive late. Changing
//   the search, creating, deleting and patching a saved row all invalidate a request in flight.
// - Rows show edits still on their way to the server (a title being typed, a tag just added).
// - A save landing while a search is active, or while a list request is in flight, asks the server
//   again instead of patching (the note may enter or leave the results; patching would discard the
//   pending answer). Otherwise the row is patched in place, moving to the top only for a newer edit.
import type { NoteSummary, TagCount } from '../../../shared/types.ts'
import type { SaveQueue } from './saveQueue.ts'

export type ListState = 'loading' | 'ready' | 'error'

export type NoteListSnapshot = {
  notes: NoteSummary[]
  /** The newest notes, for the collapsed rail; frozen while a search filters the list. */
  recent: NoteSummary[]
  listState: ListState
  /** The search box's text (with any #tags). */
  query: string
  /** Every tag the user has, with counts. */
  tagCounts: TagCount[]
}

type NoteListApi = {
  listNotes: (query: string) => Promise<NoteSummary[]>
  listTags: () => Promise<TagCount[]>
}

const RAIL_NOTES = 12
const SEARCH_DELAY_MS = 250
const TAGS_DELAY_MS = 400

export function createNoteList({ api, queue }: { api: NoteListApi; queue: Pick<SaveQueue, 'getUnsaved'> }) {
  let snapshot: NoteListSnapshot = { notes: [], recent: [], listState: 'loading', query: '', tagCounts: [] }
  const listeners = new Set<() => void>()
  let running = false
  let listRequest = 0
  // The list request in flight, if any (a save landing meanwhile must not discard its answer).
  let listLoading: number | null = null
  let tagsRequest = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let tagsTimer: ReturnType<typeof setTimeout> | null = null
  // The last tags the server confirmed for each note, to notice when a save changed them.
  const savedTags = new Map<string, string>()

  function set(change: Partial<NoteListSnapshot>): void {
    const next = { ...snapshot, ...change }
    if (change.notes) {
      // Notes added without a list answer (a new note) start with what we know of their tags.
      for (const note of change.notes) if (!savedTags.has(note.id)) savedTags.set(note.id, note.tags.join(' '))
    }
    // The rail follows the full list: only when it's loaded and the search box is empty.
    if ((change.notes || change.listState || change.query !== undefined) && next.listState === 'ready' && !next.query.trim()) {
      next.recent = next.notes.slice(0, RAIL_NOTES)
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  /** Rows show edits still on their way to the server. */
  function withUnsaved(note: NoteSummary): NoteSummary {
    const unsaved = queue.getUnsaved(note.id)
    return unsaved ? { ...note, title: unsaved.title ?? note.title, tags: unsaved.tags ?? note.tags } : note
  }

  async function loadList(search: string): Promise<void> {
    const requestId = ++listRequest
    listLoading = requestId
    try {
      const list = await api.listNotes(search)
      if (!running || requestId !== listRequest) return
      let tagsChanged = false
      for (const note of list) {
        const key = note.tags.join(' ')
        const known = savedTags.get(note.id)
        if (known !== undefined && known !== key) tagsChanged = true
        savedTags.set(note.id, key)
      }
      // Tags changed elsewhere (another tab, or a save whose answer is still on its way): new counts.
      if (tagsChanged) refreshTags()
      set({ notes: list.map(withUnsaved), listState: 'ready' })
    } catch {
      if (running && requestId === listRequest) set({ listState: 'error' })
    } finally {
      if (listLoading === requestId) listLoading = null
    }
  }

  async function loadTags(): Promise<void> {
    const requestId = ++tagsRequest
    try {
      const list = await api.listTags()
      if (running && requestId === tagsRequest) set({ tagCounts: list })
    } catch {
      // Keep the last counts; the next change or sign-in asks again.
    }
  }

  /** Asks for fresh counts soon (after a burst of tag changes, once). */
  function refreshTags(): void {
    if (tagsTimer) clearTimeout(tagsTimer)
    tagsTimer = setTimeout(() => {
      tagsTimer = null
      void loadTags()
    }, TAGS_DELAY_MS)
  }

  /** Loads the list for the current search, after the typing delay (none for an empty search). */
  function scheduleList(): void {
    // A response for the previous search must not land while the new one waits for its delay.
    listRequest += 1
    if (searchTimer) clearTimeout(searchTimer)
    const search = snapshot.query
    searchTimer = setTimeout(
      () => {
        searchTimer = null
        void loadList(search)
      },
      search ? SEARCH_DELAY_MS : 0,
    )
  }

  function setQuery(query: string): void {
    if (query === snapshot.query) return
    set({ query })
    if (running) scheduleList()
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot(): NoteListSnapshot {
      return snapshot
    },

    /** Loads the list and the tag counts. Safe to call again after dispose() (React StrictMode). */
    start(): void {
      if (running) return
      running = true
      scheduleList()
      void loadTags()
    },
    /** Stops timers; answers still on their way are ignored. */
    dispose(): void {
      running = false
      if (searchTimer) clearTimeout(searchTimer)
      if (tagsTimer) clearTimeout(tagsTimer)
      searchTimer = null
      tagsTimer = null
      listRequest += 1
      tagsRequest += 1
    },

    setQuery,

    /** Loads the list again now (the "Try again" after a failed load). */
    retryList(): void {
      void loadList(snapshot.query)
    },

    /** Loads the list (current search) and the counts again now (after signing in again). */
    refresh(): void {
      void loadList(snapshot.query)
      void loadTags()
    },

    /** The save queue confirmed a save. */
    noteSaved(summary: NoteSummary): void {
      if (!running) return
      const tagKey = summary.tags.join(' ')
      if (savedTags.get(summary.id) !== tagKey) {
        savedTags.set(summary.id, tagKey)
        refreshTags()
      }
      // A saved note may enter or leave the search results, so ask the server again. Same while a
      // list request is in flight (e.g. the search was just cleared): patching the old list would
      // discard that answer.
      if (snapshot.query.trim() || listLoading !== null) {
        void loadList(snapshot.query)
        return
      }
      // Keep the title and tags the user is still editing instead of flashing back to the saved ones.
      const item = withUnsaved(summary)
      listRequest += 1 // a list request sent before this save would bring back the old row
      const existing = snapshot.notes.find(note => note.id === summary.id)
      // Only a real change (a newer edit time) moves the note to the top; otherwise it stays put.
      const notes =
        existing && summary.updatedAt <= existing.updatedAt
          ? snapshot.notes.map(note => (note.id === summary.id ? item : note))
          : [item, ...snapshot.notes.filter(note => note.id !== summary.id)]
      set({ notes })
    },

    /** A note was just created: it goes on top, and the search clears to show it. */
    noteCreated(note: { id: string; title: string; updatedAt: number }): void {
      listRequest += 1 // a list request already in flight would drop the new note
      setQuery('')
      set({ notes: [{ id: note.id, title: note.title, snippet: '', tags: [], updatedAt: note.updatedAt }, ...snapshot.notes.filter(item => item.id !== note.id)] })
    },

    /**
     * A note was deleted on the server. Returns the note to open next: its neighbor in `listAtStart`
     * (the list when the delete began).
     */
    noteDeleted(id: string, listAtStart: readonly NoteSummary[]): NoteSummary | undefined {
      listRequest += 1 // a list request already in flight would bring the note back
      const index = listAtStart.findIndex(note => note.id === id)
      const remaining = listAtStart.filter(note => note.id !== id)
      savedTags.delete(id)
      set({ notes: snapshot.notes.filter(note => note.id !== id), recent: snapshot.recent.filter(note => note.id !== id) })
      void loadTags()
      return remaining[index] ?? remaining[index - 1]
    },

    /** The open note's title or tags changed here (not saved yet): its row follows right away. */
    localTitle(id: string, title: string): void {
      set({ notes: snapshot.notes.map(note => (note.id === id ? { ...note, title } : note)) })
    },
    localTags(id: string, tags: string[]): void {
      set({ notes: snapshot.notes.map(note => (note.id === id ? { ...note, tags } : note)) })
    },
  }
}

export type NoteList = ReturnType<typeof createNoteList>
