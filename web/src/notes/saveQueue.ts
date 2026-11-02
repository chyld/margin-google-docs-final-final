// Autosave engine. Framework-free so it can be unit tested with fake timers.
// One queue per app; entries are keyed by note id so remounting the editor never creates a second writer.
import type { DocJSON, NoteSummary } from '../../../shared/types.ts'
import { normalizeTags } from '../../../shared/tags.ts'
import { isAuthFailure } from './authFailure.ts'

export type SavePatch = { title?: string; content?: DocJSON; tags?: string[] }

/**
 * pending: edited, waiting for the debounce. retrying: transient failure. error: permanent failure.
 * paused: signed out (or another account took over this browser); nothing is sent until resume().
 */
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'retrying' | 'paused' | 'error'
export type SaveState = { status: SaveStatus; error: string | null }

/** Unsaved edits kept in localStorage until the server confirms them. */
export type Draft = SavePatch & {
  editedAt: number
  /** The note's server `updatedAt` this tab last saw when the draft was written. */
  baseUpdatedAt: number | null
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type SendPatch = (id: string, patch: SavePatch, init?: { keepalive?: boolean }) => Promise<NoteSummary>

export type SaveQueueOptions = {
  send: SendPatch
  storage?: DraftStorage | null
  now?: () => number
  onSaved?: (summary: NoteSummary) => void
  debounceMs?: number
  maxWaitMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** Where this account's drafts live in storage (draftPrefixFor(userId)): one prefix per account. */
  draftPrefix: string
}

// Browsers cap keepalive request bodies at 64 KiB in total; stay safely below it.
export const KEEPALIVE_LIMIT_BYTES = 60_000
export const DRAFT_PREFIX = 'margin:draft:'
export const PAUSED_MESSAGE = 'Signed out. Sign in to keep saving'

/** Drafts for one account: margin:draft:<userId>:<noteId>. */
export function draftPrefixFor(userId: string): string {
  return `${DRAFT_PREFIX}${userId}:`
}
// Drafts stringify the whole document, so batch rapid keystrokes.
export const DRAFT_DELAY_MS = 300

const IDLE: SaveState = { status: 'idle', error: null }

type Timer = ReturnType<typeof setTimeout>

type Entry = {
  pending: SavePatch | null
  sending: SavePatch | null
  inFlight: boolean
  lastEditAt: number
  /** Everything the server has confirmed this session, and the version it confirmed last. */
  confirmed: SavePatch | null
  confirmedAt: number | null
  debounceTimer: Timer | null
  maxWaitTimer: Timer | null
  retryTimer: Timer | null
  draftTimer: Timer | null
  retryAttempt: number
  state: SaveState
  waiters: Array<(saved: boolean) => void>
  cancelled: boolean
}

/** Network failures and server errors are worth retrying; other HTTP errors are not. */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return true
  return status >= 500 || status === 408 || status === 429
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

function errorMessage(error: unknown): string {
  if (statusOf(error) === 404) return 'This note was deleted'
  if (error instanceof Error && error.message) return error.message
  return 'Unknown error'
}

function hasKeys(patch: SavePatch | null): patch is SavePatch {
  return patch !== null && (patch.title !== undefined || patch.content !== undefined || patch.tags !== undefined)
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

export function createSaveQueue(options: SaveQueueOptions) {
  const {
    send,
    storage = null,
    now = Date.now,
    onSaved,
    debounceMs = 800,
    maxWaitMs = 5000,
    retryBaseMs = 1000,
    retryMaxMs = 30_000,
    draftPrefix,
  } = options
  // Notes deleted in this session: later edits to them are ignored.
  const deleted = new Set<string>()

  // paused: waiting for sign-in, resumable. suspended: this queue is finished (signing out or
  // switching accounts) and never sends again.
  let paused = false
  let suspended = false

  const entries = new Map<string, Entry>()
  const baseUpdatedAt = new Map<string, number>()
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function getEntry(id: string): Entry {
    let entry = entries.get(id)
    if (!entry) {
      entry = {
        pending: null,
        sending: null,
        inFlight: false,
        lastEditAt: 0,
        confirmed: null,
        confirmedAt: null,
        debounceTimer: null,
        maxWaitTimer: null,
        retryTimer: null,
        draftTimer: null,
        retryAttempt: 0,
        state: IDLE,
        waiters: [],
        cancelled: false,
      }
      entries.set(id, entry)
    }
    return entry
  }

  function setState(entry: Entry, status: SaveStatus, error: string | null = null): void {
    if (entry.state.status === status && entry.state.error === error) return
    entry.state = { status, error }
    emit()
  }

  // Everything the server hasn't confirmed yet: the request in flight plus newer edits.
  function unsaved(entry: Entry | undefined): SavePatch | null {
    if (!entry || (!entry.sending && !entry.pending)) return null
    return { ...entry.sending, ...entry.pending }
  }

  /** Returns false when the draft couldn't be stored (storage full or unavailable). */
  function writeDraft(id: string, entry: Entry): boolean {
    if (entry.draftTimer) clearTimeout(entry.draftTimer)
    entry.draftTimer = null
    const patch = unsaved(entry)
    if (!patch) return true
    if (!storage) return false
    const draft: Draft = { ...patch, editedAt: entry.lastEditAt, baseUpdatedAt: baseUpdatedAt.get(id) ?? null }
    try {
      storage.setItem(draftPrefix + id, JSON.stringify(draft))
      return true
    } catch {
      // Storage full or unavailable: drafts are a best-effort safety net.
      return false
    }
  }

  function scheduleDraft(id: string, entry: Entry): void {
    entry.draftTimer ??= setTimeout(() => writeDraft(id, entry), DRAFT_DELAY_MS)
  }

  function raiseBase(id: string, updatedAt: number): void {
    baseUpdatedAt.set(id, Math.max(baseUpdatedAt.get(id) ?? 0, updatedAt))
  }

  function clearDraft(id: string): void {
    try {
      storage?.removeItem(draftPrefix + id)
    } catch {
      // Ignore storage errors.
    }
  }

  function clearTimers(entry: Entry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer)
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    entry.debounceTimer = null
    entry.maxWaitTimer = null
    entry.retryTimer = null
  }

  function settleWaiters(entry: Entry, saved: boolean): void {
    const waiters = entry.waiters
    entry.waiters = []
    for (const resolve of waiters) resolve(saved)
  }

  function start(id: string, options: { keepalive?: boolean } = {}): void {
    const entry = entries.get(id)
    if (!entry || entry.inFlight) return
    clearTimers(entry)
    if (paused || suspended) {
      if (hasKeys(entry.pending)) setState(entry, 'paused', PAUSED_MESSAGE)
      settleWaiters(entry, false)
      return
    }
    if (!hasKeys(entry.pending)) {
      entry.pending = null
      settleWaiters(entry, entry.state.status !== 'error')
      return
    }

    const patch = entry.pending
    entry.sending = patch
    entry.pending = null
    entry.inFlight = true
    setState(entry, 'saving')
    writeDraft(id, entry)

    // keepalive lets the request outlive the page, but only small bodies fit.
    const keepalive = options.keepalive && new TextEncoder().encode(JSON.stringify(patch)).length <= KEEPALIVE_LIMIT_BYTES
    send(id, patch, keepalive ? { keepalive: true } : undefined).then(
      summary => handleSuccess(id, entry, patch, summary),
      error => handleFailure(id, entry, error),
    )
  }

  function handleSuccess(id: string, entry: Entry, patch: SavePatch, summary: NoteSummary): void {
    if (entry.cancelled) return
    entry.inFlight = false
    entry.sending = null
    entry.retryAttempt = 0
    entry.confirmed = { ...entry.confirmed, ...patch }
    entry.confirmedAt = Math.max(entry.confirmedAt ?? 0, summary.updatedAt)
    raiseBase(id, summary.updatedAt)
    onSaved?.(summary)

    // Edits arrived while saving: send one follow-up with the latest state.
    if (entry.pending) {
      start(id)
      return
    }
    clearDraft(id)
    setState(entry, 'saved')
    settleWaiters(entry, true)
  }

  function handleFailure(id: string, entry: Entry, error: unknown): void {
    if (entry.cancelled) return
    entry.inFlight = false

    // The note is gone (deleted elsewhere): nothing left to save or recover.
    if (statusOf(error) === 404) {
      entry.pending = null
      entry.sending = null
      clearTimers(entry)
      clearDraft(id)
      setState(entry, 'error', errorMessage(error))
      settleWaiters(entry, false)
      return
    }

    // Put the failed patch back underneath any newer edits.
    entry.pending = { ...entry.sending, ...entry.pending }
    entry.sending = null
    writeDraft(id, entry)

    // Signed out, or another account signed in: keep everything and wait for resume().
    if (isAuthFailure(error)) {
      paused = true
      entry.retryAttempt = 0
      clearTimers(entry)
      setState(entry, 'paused', PAUSED_MESSAGE)
      settleWaiters(entry, false)
      return
    }

    if (isRetryable(error)) {
      const delay = Math.min(retryBaseMs * 2 ** entry.retryAttempt, retryMaxMs)
      entry.retryAttempt += 1
      clearTimers(entry)
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null
        start(id)
      }, delay)
      setState(entry, 'retrying', errorMessage(error))
    } else {
      entry.retryAttempt = 0
      setState(entry, 'error', errorMessage(error))
    }
    settleWaiters(entry, false)
  }

  const queue = {
    /** Records an edit and schedules a save. */
    update(id: string, patch: SavePatch): void {
      // A deleted note (cancel) takes no more edits, e.g. a tag committed as its view closes.
      if (deleted.has(id)) return
      const entry = getEntry(id)
      entry.pending = { ...entry.pending, ...patch }
      entry.lastEditAt = now()
      // Keep a crash-safe copy even while a request is in flight or waiting to retry.
      scheduleDraft(id, entry)

      // A request in flight sends a follow-up when it finishes; a scheduled retry picks up the edit.
      if (entry.inFlight || entry.retryTimer) return
      if (paused || suspended) {
        setState(entry, 'paused', PAUSED_MESSAGE)
        return
      }

      setState(entry, 'pending')
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => start(id), debounceMs)
      entry.maxWaitTimer ??= setTimeout(() => start(id), maxWaitMs)
    },

    /** Saves now. Resolves true once every edit is saved, false if the attempt failed. */
    flush(id: string): Promise<boolean> {
      const entry = entries.get(id)
      if (!entry || (!entry.pending && !entry.inFlight)) {
        return Promise.resolve(entry?.state.status !== 'error')
      }
      return new Promise(resolve => {
        entry.waiters.push(resolve)
        if (!entry.inFlight) start(id)
      })
    },

    /** Forgets a note's pending saves and draft, e.g. before deleting it. */
    cancel(id: string): void {
      deleted.add(id)
      const entry = entries.get(id)
      if (entry) {
        entry.cancelled = true
        clearTimers(entry)
        if (entry.draftTimer) clearTimeout(entry.draftTimer)
        settleWaiters(entry, false)
        entries.delete(id)
      }
      baseUpdatedAt.delete(id)
      clearDraft(id)
      emit()
    },

    /** Records the server version a view just loaded, used to judge drafts later. Never moves back. */
    open(id: string, serverUpdatedAt: number): void {
      raiseBase(id, serverUpdatedAt)
    },

    /** Edits for this note that the server hasn't confirmed yet. */
    getUnsaved(id: string): SavePatch | null {
      return unsaved(entries.get(id))
    },

    /**
     * What this tab knows that a server copy at `serverUpdatedAt` may be missing: unconfirmed edits, plus
     * confirmed ones when that copy is older than the last confirmed save (a GET that raced a PATCH).
     */
    getLocalChanges(id: string, serverUpdatedAt: number): SavePatch | null {
      const entry = entries.get(id)
      if (!entry) return null
      const stale = entry.confirmedAt !== null && serverUpdatedAt < entry.confirmedAt
      const pending = unsaved(entry)
      if (!stale && !pending) return null
      return { ...(stale ? entry.confirmed : null), ...pending }
    },

    getState(id: string): SaveState {
      return entries.get(id)?.state ?? IDLE
    },

    hasUnsaved(): boolean {
      for (const entry of entries.values()) if (unsaved(entry)) return true
      return false
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    readDraft(id: string): Draft | null {
      try {
        const raw = storage?.getItem(draftPrefix + id)
        if (!raw) return null
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
    },

    discardDraft(id: string): void {
      clearDraft(id)
    },

    /** Writes every unsaved note to storage right away. Returns false if any draft couldn't be stored. */
    persistDrafts(): boolean {
      let ok = true
      for (const [id, entry] of entries) if (!writeDraft(id, entry)) ok = false
      return ok
    },

    /** Stops sending (e.g. the session ended) without losing anything. */
    pause(): void {
      if (suspended) return
      paused = true
      for (const entry of entries.values()) {
        clearTimers(entry)
        if (unsaved(entry) && !entry.inFlight) setState(entry, 'paused', PAUSED_MESSAGE)
      }
    },

    /** Signed in again as the same user: send everything that waited, right away. */
    resume(): void {
      if (suspended) return
      paused = false
      for (const [id, entry] of entries) {
        entry.retryAttempt = 0
        if (entry.pending && !entry.inFlight) start(id)
      }
    },

    /**
     * This queue is done (signing out or switching accounts): nothing is sent from now on, not even
     * the flush when a view unmounts. Drafts can still be written with persistDrafts().
     */
    suspend(): void {
      suspended = true
      for (const entry of entries.values()) {
        clearTimers(entry)
        settleWaiters(entry, false)
      }
    },

    /**
     * Saves everything and waits (up to `timeoutMs`) for the server to confirm, including follow-up
     * saves. Resolves true when nothing is left unsaved.
     */
    async drain(timeoutMs: number): Promise<boolean> {
      const pending = [...entries]
        .filter(([, entry]) => entry.pending || entry.inFlight)
        .map(([id]) => queue.flush(id))
      if (pending.length > 0) {
        let timer: Timer | undefined
        await Promise.race([
          Promise.all(pending),
          new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs)
          }),
        ])
        clearTimeout(timer)
      }
      return !queue.hasUnsaved()
    },

    /**
     * Starts saving every note with waiting edits. When the page is being hidden or closed, pass
     * keepalive so small saves survive the page; they stay tracked so an older request can't land last.
     */
    flushAll(options: { keepalive?: boolean } = {}): void {
      if (paused || suspended) return
      for (const [id, entry] of entries) if (entry.pending && !entry.inFlight) start(id, options)
    },
  }
  return queue
}

export type SaveQueue = ReturnType<typeof createSaveQueue>
