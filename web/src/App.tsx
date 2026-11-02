import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FilePlus2, Menu, Plus, X } from 'lucide-react'
import { LIST_LIMIT } from '../../shared/constants.ts'
import { parseTagQuery, toggleTagInQuery } from '../../shared/tags.ts'
import type { NoteSummary, TagCount } from '../../shared/types.ts'
import { api, ApiError, setAuthFailureHandler } from './api.ts'
import type { Me } from './api.ts'
import { EmptyIllustration } from './components/EmptyIllustration.tsx'
import { SessionDialog } from './components/LoginScreen.tsx'
import { Notices } from './components/Notices.tsx'
import { NoteView } from './components/NoteView.tsx'
import { Sidebar, TagList } from './components/Sidebar.tsx'
import type { ListState } from './components/Sidebar.tsx'
import { UserMenu } from './components/UserMenu.tsx'
import { forgetFailedFonts } from './fonts.ts'
import { pendingImageUploads, subscribePendingUploads } from './imageInput.ts'
import { showNotice } from './notices.ts'
import { navigate, noteIdFromPath, notePath, usePathname } from './router.ts'
import { createSaveQueue, DRAFT_PREFIX, draftPrefixFor } from './saveQueue.ts'
import { broadcastAuth, notifyReauthenticated, onAuthBroadcast } from './session.ts'
import { useMediaQuery } from './useMediaQuery.ts'
import { setFormatPanelOpen, useFormatPanel } from './formatPanel.ts'

const IMAGE_ID = /\/api\/images\/([0-9a-f]{64})\./g
const LEGACY_DRAFT = /^margin:draft:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const SIGN_OUT_WAIT_MS = 5000
const SIDEBAR_KEY = 'margin:sidebar'
const RAIL_NOTES = 12
const UPLOAD_WAIT_MS = 15_000

/**
 * The server only sees saved notes, so it could clean up an image that just a local draft still
 * uses. Tell it about this account's draft images once per page load.
 */
function touchDraftImages(storage: Storage | null, prefix: string) {
  if (!storage) return
  const ids = new Set<string>()
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    for (const match of (storage.getItem(key) ?? '').matchAll(IMAGE_ID)) ids.add(match[1] as string)
  }
  // The endpoint takes up to 500 ids per request.
  const list = [...ids]
  for (let start = 0; start < list.length; start += 500) {
    void api.touchImages(list.slice(start, start + 500)).catch(() => undefined)
  }
}

/**
 * Drafts from before accounts (margin:draft:<noteId>) belong to whoever claimed the old notes. Each
 * old key is removed only after its new copy is written.
 */
function adoptLegacyDrafts(storage: Storage | null, prefix: string) {
  if (!storage) return
  const legacy: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && LEGACY_DRAFT.test(key)) legacy.push(key)
  }
  for (const key of legacy) {
    const noteId = (LEGACY_DRAFT.exec(key) as RegExpExecArray)[1] as string
    try {
      const value = storage.getItem(key)
      if (value !== null && storage.getItem(prefix + noteId) === null) storage.setItem(prefix + noteId, value)
      storage.removeItem(key)
    } catch {
      // Storage full: leave the old key for next time.
    }
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function waitForUploads(timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (pendingImageUploads() === 0) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    const unsubscribe = subscribePendingUploads(() => {
      if (pendingImageUploads() !== 0) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}

type SessionEnded = null | 'expired' | 'switched'

export function App({ me }: { me: Me }) {
  const user = me.user
  const activeId = noteIdFromPath(usePathname())
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [listState, setListState] = useState<ListState>('loading')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null)
  const [sessionEnded, setSessionEnded] = useState<SessionEnded>(null)
  const [reauthEpoch, setReauthEpoch] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [locked, setLocked] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const legacyKey = `margin:legacy-hint-dismissed:${user.id}`
  const [legacyHint, setLegacyHint] = useState(() => me.legacyPending && browserStorage()?.getItem(legacyKey) !== '1')
  const mobile = useMediaQuery('(max-width: 760px)')
  const [collapsed, setCollapsed] = useState(() => browserStorage()?.getItem(SIDEBAR_KEY) === 'collapsed')
  // The rail shows the newest notes even while the search box filters the list.
  const [recent, setRecent] = useState<NoteSummary[]>([])
  // Every tag the user has, with counts (the sidebar, home and suggestions).
  const [tagCounts, setTagCounts] = useState<TagCount[]>([])
  const homeHeadingRef = useRef<HTMLHeadingElement>(null)
  // The Format sidebar's phone sheet is modal: the app behind it is inert.
  const formatPanel = useFormatPanel()
  const formatSheetOpen = formatPanel.mode === 'sheet' && formatPanel.open && activeId !== null

  const queryRef = useRef(query)
  const listRequest = useRef(0)
  // The list request in flight, if any (a save landing meanwhile must not discard its answer).
  const listLoading = useRef<number | null>(null)
  // The last tags the server confirmed for each note, to notice when a save changed them.
  const savedTags = useRef(new Map<string, string>())
  const refreshTagsRef = useRef<() => void>(() => undefined)
  const onSavedRef = useRef<(summary: NoteSummary) => void>(() => {})
  // Set while Margin itself is leaving the page (sign out, switching accounts): no unload prompt.
  const leaving = useRef(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const draftPrefix = draftPrefixFor(user.id)

  const [queue] = useState(() =>
    createSaveQueue({
      send: api.updateNote,
      storage: browserStorage(),
      draftPrefix,
      onSaved: summary => onSavedRef.current(summary),
    }),
  )

  useEffect(() => {
    if (me.legacyOwner) adoptLegacyDrafts(browserStorage(), draftPrefix)
    touchDraftImages(browserStorage(), draftPrefix)
  }, [me.legacyOwner, draftPrefix])

  const loadList = useCallback(async (search: string) => {
    // Only the newest request may update the list; older responses can arrive late.
    const requestId = ++listRequest.current
    listLoading.current = requestId
    try {
      const list = await api.listNotes(search)
      if (requestId !== listRequest.current) return
      let tagsChanged = false
      for (const note of list) {
        const key = note.tags.join(' ')
        const known = savedTags.current.get(note.id)
        if (known !== undefined && known !== key) tagsChanged = true
        savedTags.current.set(note.id, key)
      }
      // Tags changed elsewhere (another tab, or a save whose answer is still on its way): new counts.
      if (tagsChanged) refreshTagsRef.current()
      // Rows show edits still on their way to the server (a title being typed, a tag just added).
      setNotes(
        list.map(note => {
          const unsaved = queue.getUnsaved(note.id)
          return unsaved ? { ...note, title: unsaved.title ?? note.title, tags: unsaved.tags ?? note.tags } : note
        }),
      )
      setListState('ready')
    } catch {
      if (requestId === listRequest.current) setListState('error')
    } finally {
      if (listLoading.current === requestId) listLoading.current = null
    }
  }, [queue])

  // Only the newest tags request may update the counts; older responses can arrive late.
  const tagsRequest = useRef(0)
  const tagsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadTags = useCallback(async () => {
    const requestId = ++tagsRequest.current
    try {
      const list = await api.listTags()
      if (requestId === tagsRequest.current) setTagCounts(list)
    } catch {
      // Keep the last counts; the next change or sign-in asks again.
    }
  }, [])
  /** Asks for fresh counts soon (after a burst of tag changes, once). */
  const refreshTags = useCallback(() => {
    if (tagsTimer.current) clearTimeout(tagsTimer.current)
    tagsTimer.current = setTimeout(() => {
      tagsTimer.current = null
      void loadTags()
    }, 400)
  }, [loadTags])
  refreshTagsRef.current = refreshTags
  useEffect(() => {
    void loadTags()
    return () => {
      if (tagsTimer.current) clearTimeout(tagsTimer.current)
    }
  }, [loadTags])

  // ---- the session ending, and other tabs ----

  const sessionEndedRef = useRef(sessionEnded)
  useEffect(() => {
    sessionEndedRef.current = sessionEnded
  }, [sessionEnded])


  const endSession = useCallback(
    (reason: 'expired' | 'switched') => {
      if (leaving.current) return
      queue.pause()
      queue.persistDrafts()
      if (!focusBeforeDialog.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        // The Format sheet closes when the session ends: come back to its toggle instead.
        focusBeforeDialog.current = document.activeElement.closest('#format-panel')
          ? document.querySelector<HTMLElement>('.format-toggle')
          : document.activeElement
      }
      // A different account wins over "expired": its message tells the user what really happened.
      setSessionEnded(current => (current === 'switched' ? current : reason))
    },
    [queue],
  )

  // Bumped on every sign-in, so an older account check answering late can't undo it.
  const authGeneration = useRef(0)
  // What had focus when the session ended, to give it back afterwards.
  const focusBeforeDialog = useRef<HTMLElement | null>(null)

  // The session ending closes the Format sheet (its dialog would sit under the session dialog).
  useEffect(() => {
    if (sessionEnded && formatPanel.mode === 'sheet' && formatPanel.open) setFormatPanelOpen(false)
  }, [sessionEnded, formatPanel.mode, formatPanel.open])

  const resumeSession = useCallback(() => {
    authGeneration.current += 1
    setSessionEnded(null)
    const previous = focusBeforeDialog.current
    focusBeforeDialog.current = null
    requestAnimationFrame(() => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    })
    queue.resume()
    forgetFailedFonts()
    notifyReauthenticated()
    setReauthEpoch(value => value + 1)
    void loadList(queryRef.current)
    void loadTags()
  }, [queue, loadList, loadTags])

  /**
   * Leaves the page for good: no more saves from this tab, drafts kept for next time. If the browser
   * can't keep the unsaved edits, asks first (returns false when the user stays).
   */
  const leaveTo = useCallback(
    (url: string, { confirmed = false } = {}) => {
      if (!confirmed && !queue.persistDrafts() && queue.hasUnsaved()) {
        const ok = window.confirm(
          "Some changes haven't reached the server, and this browser couldn't keep a copy. Leaving now loses them.\n\nLeave anyway?",
        )
        if (!ok) return false
      }
      leaving.current = true
      queue.suspend()
      queue.persistDrafts()
      window.location.assign(url)
      return true
    },
    [queue],
  )

  // Any request that finds the session gone (401) or owned by someone else (409).
  useEffect(() => {
    setAuthFailureHandler(failure => endSession(failure.status === 409 ? 'switched' : 'expired'))
    return () => setAuthFailureHandler(null)
  }, [endSession])

  const recheck = useCallback(async () => {
    if (leaving.current) return
    const generation = authGeneration.current
    try {
      const current = await api.me()
      if (generation !== authGeneration.current) return
      if (current.user.id !== user.id) endSession('switched')
      else if (sessionEndedRef.current) resumeSession()
    } catch (error) {
      if (generation !== authGeneration.current) return
      if (error instanceof ApiError && error.status === 401) endSession('expired')
    }
  }, [user.id, endSession, resumeSession])

  useEffect(
    () =>
      onAuthBroadcast(message => {
        if (message.type === 'signed-out') endSession('expired')
        else if (message.userId !== user.id) endSession('switched')
        else void recheck()
      }),
    [user.id, endSession, recheck],
  )

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [recheck])

  async function signInAgain(username: string, password: string) {
    const sameUser = username.trim().toLowerCase() === user.username
    // Before the cookie changes hands: nothing of this account may be sent under another one, and
    // unsaved edits must be safe in this browser (or the user must accept losing them).
    let confirmedLoss = false
    if (!sameUser) {
      queue.pause()
      if (!queue.persistDrafts() && queue.hasUnsaved()) {
        confirmedLoss = window.confirm(
          `Some of ${user.username}'s changes haven't reached the server, and this browser couldn't keep a copy. ` +
            'Signing in as someone else loses them.\n\nContinue?',
        )
        if (!confirmedLoss) return
      }
    }
    const result = await api.login(username, password)
    broadcastAuth({ type: 'signed-in', userId: result.user.id })
    if (result.user.id !== user.id) {
      leaveTo('/', { confirmed: true })
      return
    }
    resumeSession()
  }

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    const uploadsDone = await waitForUploads(UPLOAD_WAIT_MS)
    // Not editable while the last saves go out (uploads, if any, keep running until confirmed).
    // Synchronous, so fields that commit on lock (a typed tag) queue their edit before the drain.
    flushSync(() => setLocked(true))
    const saved = await queue.drain(SIGN_OUT_WAIT_MS)
    const stored = queue.persistDrafts()
    const stayed = () => {
      setLocked(false)
      setSigningOut(false)
    }
    if (!saved || !uploadsDone) {
      const problems: string[] = []
      if (!uploadsDone) problems.push('An image is still uploading and will be lost.')
      if (!saved) {
        problems.push(
          stored
            ? "Some changes haven't reached the server yet. They stay in this browser and come back when you open the note after signing in again."
            : "Some changes haven't reached the server yet, and this browser couldn't keep a copy, so they will be lost.",
        )
      }
      if (!window.confirm(`${problems.join('\n\n')}\n\nSign out anyway?`)) {
        stayed()
        return
      }
    }
    // Paused (not suspended) until the server confirms, so a failed sign-out can carry on normally.
    queue.pause()
    try {
      await api.logout()
    } catch (error) {
      // 401: already signed out. 409: this browser is now someone else's; either way, leave.
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        queue.resume()
        stayed()
        showNotice("Couldn't sign out. Check your connection and try again.")
        return
      }
    }
    leaving.current = true
    queue.suspend()
    queue.persistDrafts()
    broadcastAuth({ type: 'signed-out' })
    window.location.replace('/')
  }

  // ---- sidebar ----

  const toggleSidebar = useCallback(() => {
    setCollapsed(value => {
      const next = !value
      try {
        browserStorage()?.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded')
      } catch {
        // Not remembered on this device; still works now.
      }
      return next
    })
    // If the focused control disappeared with the sidebar, keep focus on the toggle.
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active || active === document.body || active.offsetParent === null) {
        document.querySelector<HTMLElement>('.sidebar-toggle')?.focus()
      }
    })
  }, [])

  // Ctrl/⌘+Shift+\ toggles the sidebar from anywhere (matched by key position: works on any layout).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.code !== 'Backslash') return
      // Not while a dialog (font, styles, link, session) is open: the shortcut belongs to the page.
      if (mobile || sessionEndedRef.current || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [mobile, toggleSidebar])

  useEffect(() => {
    if (listState === 'ready' && !query.trim()) setRecent(notes.slice(0, RAIL_NOTES))
  }, [notes, listState, query])

  // ---- note list ----

  useEffect(() => {
    queryRef.current = query
    // A response for the previous query must not land while the new one waits for its debounce.
    listRequest.current += 1
    const timer = setTimeout(() => void loadList(query), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [query, loadList])

  useEffect(() => {
    for (const note of notes) if (!savedTags.current.has(note.id)) savedTags.current.set(note.id, note.tags.join(' '))
  }, [notes])

  useEffect(() => {
    onSavedRef.current = summary => {
      const tagKey = summary.tags.join(' ')
      if (savedTags.current.get(summary.id) !== tagKey) {
        savedTags.current.set(summary.id, tagKey)
        refreshTags()
      }
      // A saved note may enter or leave the search results, so ask the server again. Same while a
      // list request is in flight (e.g. the search was just cleared): patching the old list would
      // discard that answer.
      if (queryRef.current.trim() || listLoading.current !== null) {
        void loadList(queryRef.current)
        return
      }
      // Keep the title and tags the user is still editing instead of flashing back to the saved ones.
      const unsaved = queue.getUnsaved(summary.id)
      const item = { ...summary, title: unsaved?.title ?? summary.title, tags: unsaved?.tags ?? summary.tags }
      listRequest.current += 1 // a list request sent before this save would bring back the old row
      setNotes(previous => {
        const existing = previous.find(note => note.id === summary.id)
        // Only a real change (a newer edit time) moves the note to the top; otherwise it stays put.
        if (existing && summary.updatedAt <= existing.updatedAt) {
          return previous.map(note => (note.id === summary.id ? item : note))
        }
        return [item, ...previous.filter(note => note.id !== summary.id)]
      })
    }
  }, [loadList, queue, refreshTags])

  // Focus the title only on the first visit to a new note.
  useEffect(() => {
    if (justCreatedId && activeId !== justCreatedId) setJustCreatedId(null)
  }, [activeId, justCreatedId])

  // "/" is home: no note opens by itself (Phase 7), so the logo, a refresh and Back all agree.

  // Opening a note closes the phone drawer; NoteView then takes keyboard focus (focusOnOpen).
  const openedFromDrawer = useRef(false)
  useEffect(() => {
    setDrawerOpen(open => {
      openedFromDrawer.current = open
      return false
    })
  }, [activeId])

  useEffect(() => {
    if (!mobile) setDrawerOpen(false)
  }, [mobile])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    requestAnimationFrame(() => menuButtonRef.current?.focus())
  }, [])

  /** The logo: home, with no note open, the search (and any tag filter) cleared, the drawer closed. */
  const goHome = useCallback(() => {
    setQuery('')
    setDrawerOpen(false)
    navigate('/')
    // After the drawer is gone (no longer inert) and the home view has rendered.
    requestAnimationFrame(() => requestAnimationFrame(() => homeHeadingRef.current?.focus({ preventScroll: true })))
  }, [])

  /** A tag was clicked: toggle `#tag` in the search, and show the list it filters. */
  const toggleTag = useCallback(
    (tag: string) => {
      setQuery(current => toggleTagInQuery(current, tag))
      if (mobile) setDrawerOpen(true)
      else if (collapsed) toggleSidebar()
    },
    [mobile, collapsed, toggleSidebar],
  )

  const activeTags = parseTagQuery(query).tags

  // Protect unsaved edits when the tab is hidden, reloaded or closed.
  useEffect(() => {
    // Hidden usually comes first when a tab closes, so use keepalive there too: small saves then
    // survive the page, and the queue still tracks them so nothing older can land after.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      queue.persistDrafts()
      queue.flushAll({ keepalive: true })
    }
    const onPageHide = () => {
      queue.persistDrafts()
      queue.flushAll({ keepalive: true })
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return
      if (!queue.hasUnsaved() && pendingImageUploads() === 0) return
      queue.persistDrafts()
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [queue])

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const note = await api.createNote()
      listRequest.current += 1 // a list request already in flight would drop the new note
      setQuery('')
      setNotes(previous => [
        { id: note.id, title: note.title, snippet: '', tags: [], updatedAt: note.updatedAt },
        ...previous.filter(item => item.id !== note.id),
      ])
      setJustCreatedId(note.id)
      navigate(notePath(note.id))
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) return
      showNotice(`Couldn't create a note: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this note? This can't be undone.")) return

    // Keep pending edits until the server confirms; if the delete fails they still get saved.
    // A save that lands after the delete just gets a 404, which the queue treats as final.
    try {
      await api.deleteNote(id)
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) return
      if (!(error instanceof ApiError && error.status === 404)) {
        showNotice(`Couldn't delete the note: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    queue.cancel(id)
    listRequest.current += 1 // a list request already in flight would bring the note back

    const index = notes.findIndex(note => note.id === id)
    const remaining = notes.filter(note => note.id !== id)
    setNotes(previous => previous.filter(note => note.id !== id))
    setRecent(previous => previous.filter(note => note.id !== id))
    savedTags.current.delete(id)
    void loadTags()
    const next = remaining[index] ?? remaining[index - 1]
    navigate(next ? notePath(next.id) : '/', { replace: true })
  }

  function handleTitleChange(id: string, title: string) {
    setNotes(previous => previous.map(note => (note.id === id ? { ...note, title } : note)))
  }

  function handleTagsChange(id: string, tags: string[]) {
    setNotes(previous => previous.map(note => (note.id === id ? { ...note, tags } : note)))
  }

  const drawerModal = mobile && drawerOpen

  return (
    <>
      <div
        className={['app', drawerModal && 'is-drawer-open', collapsed && !mobile && 'is-collapsed'].filter(Boolean).join(' ')}
        inert={sessionEnded !== null || formatSheetOpen}
      >
        <header className="app-bar" inert={drawerModal}>
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-button"
            aria-label="Open notes menu"
            aria-expanded={drawerOpen}
            aria-controls="notes-drawer"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={22} aria-hidden="true" />
          </button>
          <a
            href="/"
            className="app-bar-brand"
            aria-label="Margin home"
            aria-current={activeId ? undefined : 'page'}
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
              event.preventDefault()
              goHome()
            }}
          >
            <img src="/favicon.svg" alt="" width={26} height={26} />
            Margin
          </a>
          <button type="button" className="icon-button app-bar-new" aria-label="New note" onClick={handleCreate} disabled={creating}>
            <Plus size={22} aria-hidden="true" />
          </button>
        </header>

        {drawerModal && <div className="scrim" aria-hidden="true" onClick={closeDrawer} />}

        <Sidebar
          notes={notes}
          activeId={activeId}
          listState={listState}
          limited={notes.length >= LIST_LIMIT}
          query={query}
          creating={creating}
          onQueryChange={setQuery}
          onCreate={handleCreate}
          onRetry={() => void loadList(query)}
          mobile={mobile}
          open={drawerOpen}
          onClose={closeDrawer}
          footer={<UserMenu user={user} signingOut={signingOut} onSignOut={() => void handleSignOut()} />}
          railFooter={<UserMenu user={user} signingOut={signingOut} onSignOut={() => void handleSignOut()} compact />}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          recent={recent}
          tags={tagCounts}
          activeTags={activeTags}
          onToggleTag={toggleTag}
          onHome={goHome}
        />

        <div className="main-area" inert={drawerModal}>
          {legacyHint && (
            <div className="banner info legacy-banner" role="status">
              <span>
                Some notes from before accounts are waiting for an owner. On the computer running Margin, run{' '}
                <code>margin-user claim &lt;name&gt;</code>.
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss"
                onClick={() => {
                  setLegacyHint(false)
                  try {
                    browserStorage()?.setItem(legacyKey, '1')
                  } catch {
                    // Not remembered; it shows again next time.
                  }
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {activeId ? (
            <NoteView
              key={activeId}
              id={activeId}
              queue={queue}
              autoFocusTitle={activeId === justCreatedId}
              locked={locked}
              reauthEpoch={reauthEpoch}
              focusOnOpen={openedFromDrawer.current}
              onTitleChange={handleTitleChange}
              onTagsChange={handleTagsChange}
              onDelete={handleDelete}
              allTags={tagCounts.map(item => item.tag)}
              onOpenTag={toggleTag}
            />
          ) : (
            <main className="empty-main">
              {listState === 'ready' && notes.length === 0 && !query.trim() && (
                <div className="empty-state">
                  <EmptyIllustration />
                  <h1 ref={homeHeadingRef} tabIndex={-1}>
                    Your first page is waiting
                  </h1>
                  <p>Notes you write here are yours alone. Start with a blank page.</p>
                  <button type="button" className="button primary" onClick={handleCreate} disabled={creating}>
                    <FilePlus2 size={18} aria-hidden="true" />
                    Create your first note
                  </button>
                </div>
              )}
              {listState === 'error' && (
                <div className="empty-state">
                  <h1 ref={homeHeadingRef} tabIndex={-1}>Couldn't load your notes</h1>
                  <button type="button" className="button" onClick={() => void loadList(query)}>
                    Try again
                  </button>
                </div>
              )}
              {listState === 'ready' && (notes.length > 0 || query.trim() !== '') && (
                <div className="empty-state home">
                  <EmptyIllustration />
                  <h1 ref={homeHeadingRef} tabIndex={-1}>
                    Pick a note, or start a new one
                  </h1>
                  <p>{mobile ? 'Open the menu to see your notes.' : 'Your notes are in the list on the left.'}</p>
                  <div className="home-actions">
                    <button type="button" className="button primary" onClick={handleCreate} disabled={creating}>
                      <FilePlus2 size={18} aria-hidden="true" />
                      New note
                    </button>
                    {mobile && (
                      <button type="button" className="button" onClick={() => setDrawerOpen(true)}>
                        <Menu size={18} aria-hidden="true" />
                        Show my notes
                      </button>
                    )}
                  </div>
                  {tagCounts.length > 0 && (
                    <section className="home-tags" aria-labelledby="home-tags-title">
                      <h2 id="home-tags-title">Tags</h2>
                      <TagList tags={tagCounts} activeTags={activeTags} onToggle={toggleTag} />
                    </section>
                  )}
                </div>
              )}
            </main>
          )}
        </div>
      </div>
      {sessionEnded && (
        <SessionDialog
          username={user.username}
          reason={sessionEnded}
          onSubmit={signInAgain}
          onUseOtherAccount={() => void leaveTo('/')}
        />
      )}
      <Notices />
    </>
  )
}
