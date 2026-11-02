import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu, Plus } from 'lucide-react'
import { LIST_LIMIT } from '../../shared/constants.ts'
import { parseTagQuery, toggleTagInQuery } from '../../shared/tags.ts'
import { api, ApiError } from './api.ts'
import type { Me } from './api.ts'
import { Home } from './components/Home.tsx'
import { SessionDialog } from './components/LoginScreen.tsx'
import { Notices } from './components/Notices.tsx'
import { NoteView } from './components/NoteView.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { UserMenu } from './components/UserMenu.tsx'
import { browserStorage, draftPrefixFor, touchDraftImages } from './notes/drafts.ts'
import { createNoteList, useNoteList } from './notes/noteList.ts'
import type { NoteList } from './notes/noteList.ts'
import { createSaveQueue } from './notes/saveQueue.ts'
import { useSession } from './notes/useSession.ts'
import { navigate, noteIdFromPath, notePath, usePathname } from './router.ts'
import { setFormatPanelOpen, useFormatPanel } from './state/formatPanel.ts'
import { showNotice } from './state/notices.ts'
import { useMediaQuery } from './useMediaQuery.ts'

const SIDEBAR_KEY = 'margin:sidebar'

/**
 * The signed-in page: the notes list and the open note, laid out for wide windows (sidebar or rail)
 * and phones (drawer). The save queue, the notes list (notes/noteList.ts) and the session
 * (notes/useSession.ts) do the work; this component composes them.
 */
export function App({ me }: { me: Me }) {
  const user = me.user
  const activeId = noteIdFromPath(usePathname())
  const [creating, setCreating] = useState(false)
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mobile = useMediaQuery('(max-width: 760px)')
  const [collapsed, setCollapsed] = useState(() => browserStorage()?.getItem(SIDEBAR_KEY) === 'collapsed')
  const homeHeadingRef = useRef<HTMLHeadingElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  // The Format sidebar's phone sheet is modal: the app behind it is inert.
  const formatPanel = useFormatPanel()
  const formatSheetOpen = formatPanel.mode === 'sheet' && formatPanel.open && activeId !== null
  const draftPrefix = draftPrefixFor(user.id)

  // One save queue and one notes list per signed-in page. A confirmed save updates the list.
  const listRef = useRef<NoteList | null>(null)
  const [queue] = useState(() =>
    createSaveQueue({
      send: api.updateNote,
      storage: browserStorage(),
      draftPrefix,
      onSaved: summary => listRef.current?.noteSaved(summary),
    }),
  )
  const [list] = useState(() => createNoteList({ api: { listNotes: query => api.listNotes(query), listTags: () => api.listTags() }, queue }))
  listRef.current = list
  useEffect(() => {
    list.start()
    return () => list.dispose()
  }, [list])
  const { notes, recent, listState, query, tagCounts } = useNoteList(list)

  const session = useSession({ queue, user, onResumed: () => list.refresh() })
  const { sessionEnded, isSessionEnded } = session

  useEffect(() => {
    touchDraftImages(browserStorage(), draftPrefix, ids => api.touchImages(ids))
  }, [draftPrefix])

  // The session ending closes the Format sheet (its dialog would sit under the session dialog).
  useEffect(() => {
    if (sessionEnded && formatPanel.mode === 'sheet' && formatPanel.open) setFormatPanelOpen(false)
  }, [sessionEnded, formatPanel.mode, formatPanel.open])

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
      if (mobile || isSessionEnded() || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [mobile, toggleSidebar, isSessionEnded])

  // Focus the title only on the first visit to a new note.
  useEffect(() => {
    if (justCreatedId && activeId !== justCreatedId) setJustCreatedId(null)
  }, [activeId, justCreatedId])

  // "/" is home: no note opens by itself, so the logo, a refresh and Back all agree.

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
    list.setQuery('')
    setDrawerOpen(false)
    navigate('/')
    // After the drawer is gone (no longer inert) and the home view has rendered.
    requestAnimationFrame(() => requestAnimationFrame(() => homeHeadingRef.current?.focus({ preventScroll: true })))
  }, [list])

  /** A tag was clicked: toggle `#tag` in the search, and show the list it filters. */
  const toggleTag = useCallback(
    (tag: string) => {
      list.setQuery(toggleTagInQuery(list.getSnapshot().query, tag))
      if (mobile) setDrawerOpen(true)
      else if (collapsed) toggleSidebar()
    },
    [list, mobile, collapsed, toggleSidebar],
  )

  const activeTags = parseTagQuery(query).tags

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const note = await api.createNote()
      list.noteCreated(note)
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
    // The next note to open comes from the list as it is now.
    const listAtStart = notes

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
    const next = list.noteDeleted(id, listAtStart)
    navigate(next ? notePath(next.id) : '/', { replace: true })
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
          onQueryChange={list.setQuery}
          onCreate={handleCreate}
          onRetry={list.retryList}
          mobile={mobile}
          open={drawerOpen}
          onClose={closeDrawer}
          footer={<UserMenu user={user} signingOut={session.signingOut} onSignOut={() => void session.signOut()} />}
          railFooter={<UserMenu user={user} signingOut={session.signingOut} onSignOut={() => void session.signOut()} compact />}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          recent={recent}
          tags={tagCounts}
          activeTags={activeTags}
          onToggleTag={toggleTag}
          onHome={goHome}
        />

        <div className="main-area" inert={drawerModal}>
          {activeId ? (
            <NoteView
              key={activeId}
              id={activeId}
              queue={queue}
              autoFocusTitle={activeId === justCreatedId}
              locked={session.locked}
              reauthEpoch={session.reauthEpoch}
              focusOnOpen={openedFromDrawer.current}
              onTitleChange={list.localTitle}
              onTagsChange={list.localTags}
              onDelete={handleDelete}
              allTags={tagCounts.map(item => item.tag)}
              onOpenTag={toggleTag}
            />
          ) : (
            <Home
              listState={listState}
              hasNotes={notes.length > 0}
              searching={query.trim() !== ''}
              creating={creating}
              mobile={mobile}
              tags={tagCounts}
              activeTags={activeTags}
              headingRef={homeHeadingRef}
              onCreate={handleCreate}
              onRetry={list.retryList}
              onShowNotes={() => setDrawerOpen(true)}
              onToggleTag={toggleTag}
            />
          )}
        </div>
      </div>
      {sessionEnded && (
        <SessionDialog
          username={user.username}
          reason={sessionEnded}
          onSubmit={session.signInAgain}
          onUseOtherAccount={() => void session.leaveTo('/')}
        />
      )}
      <Notices />
    </>
  )
}
