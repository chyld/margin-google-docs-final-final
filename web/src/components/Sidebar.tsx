import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus, Search, X } from 'lucide-react'
import type { NoteSummary, TagCount } from '../../../shared/types.ts'
import { candyFor } from '../state/candy.ts'
import { displayTitle, firstGrapheme, formatEdited } from '../format.ts'
import { navigate, notePath } from '../router.ts'
import { trapTab } from '../focusTrap.ts'
import type { ListState } from '../notes/noteList.ts'

type SidebarProps = {
  notes: NoteSummary[]
  activeId: string | null
  listState: ListState
  /** The server returned its maximum number of notes; older ones are only reachable by search. */
  limited: boolean
  query: string
  creating: boolean
  onQueryChange: (query: string) => void
  onCreate: () => void
  onRetry: () => void
  /** Phones: the sidebar is a drawer (a modal dialog while open). */
  mobile: boolean
  open: boolean
  onClose: () => void
  footer: ReactNode
  /** Desktop/tablet: shown as a slim rail. Ignored on phones. */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Newest notes regardless of the search box, for the rail. */
  recent: NoteSummary[]
  /** Account menu for the rail (avatar only, opens to the right). */
  railFooter: ReactNode
  /** Every tag the user has, with counts. */
  tags: TagCount[]
  /** Tags the search currently filters by. */
  activeTags: string[]
  onToggleTag: (tag: string) => void
  /** The logo: home, no note open. */
  onHome: () => void
}

const TAGS_SHOWN = 12

/** Tags with counts; each toggles `#tag` in the search. Used in the sidebar and on home. */
export function TagList({
  tags,
  activeTags,
  onToggle,
  limit,
}: {
  tags: TagCount[]
  activeTags: string[]
  onToggle: (tag: string) => void
  limit?: number
}) {
  const [showAll, setShowAll] = useState(false)
  // Tags clicked here stay visible past the limit, so turning one off doesn't pull it (and the
  // keyboard focus on it) out from under the pointer.
  const [clicked, setClicked] = useState<string[]>([])
  // Active tags always show, even past the limit.
  const visible =
    limit && !showAll
      ? tags.filter((item, index) => index < limit || activeTags.includes(item.tag) || clicked.includes(item.tag))
      : tags
  return (
    <div className="tag-list">
      {visible.map(({ tag, count }) => {
        const active = activeTags.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            className={active ? 'tag-pill is-active' : 'tag-pill'}
            aria-pressed={active}
            title={active ? `Stop filtering by #${tag}` : `Show notes tagged #${tag}`}
            onClick={() => {
              setClicked(previous => (previous.includes(tag) ? previous : [...previous, tag]))
              onToggle(tag)
            }}
          >
            <span className="tag-pill-name">#{tag}</span>
            <span className="tag-pill-count" aria-label={`${count} ${count === 1 ? 'note' : 'notes'}`}>
              {count}
            </span>
          </button>
        )
      })}
      {limit !== undefined && tags.length > limit && (
        <button type="button" className="link-button tag-list-more" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>
          {showAll ? 'Show fewer' : `Show all (${tags.length})`}
        </button>
      )}
    </div>
  )
}

const ROW_TAGS = 3

// Re-render periodically so "5 minutes ago" stays accurate.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function Sidebar(props: SidebarProps) {
  const { notes, activeId, listState, limited, query, creating, onQueryChange, onCreate, onRetry, mobile, open, onClose, footer } = props
  const { collapsed: wantsCollapsed, onToggleCollapsed, recent, railFooter, tags, activeTags, onToggleTag, onHome } = props
  const now = useNow(60_000)
  const ref = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const modal = mobile && open
  const collapsed = wantsCollapsed && !mobile
  const focusSearchAfterExpand = useRef(false)

  // The rail's search button expands the sidebar, then puts the cursor in the search box.
  useEffect(() => {
    if (!collapsed && focusSearchAfterExpand.current) {
      focusSearchAfterExpand.current = false
      searchRef.current?.focus()
    }
  }, [collapsed])

  // The open drawer takes focus, and gives it back when it closes (App returns it to the menu button).
  useEffect(() => {
    if (!modal) return
    ref.current?.querySelector<HTMLElement>('.drawer-close')?.focus()
    // Escape works wherever focus is (e.g. after tapping plain text in the drawer).
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [modal, onClose])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    // The phone drawer is modal: Tab stays inside it.
    if (modal) trapTab(event, ref.current)
  }

  function handleHome(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onHome()
  }

  function handleOpen(event: MouseEvent<HTMLAnchorElement>, id: string) {
    // Let modified clicks open a new tab as usual.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    navigate(notePath(id))
  }

  return (
    <aside
      ref={ref}
      id="notes-drawer"
      className={['sidebar', open && 'is-open', collapsed && 'is-collapsed'].filter(Boolean).join(' ')}
      role={mobile ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      aria-label={mobile ? 'Notes' : undefined}
      inert={mobile && !open}
      onKeyDown={handleKeyDown}
    >
      <div className="sidebar-top">
        {/* One toggle in the same place in both states, so keyboard focus stays on it. */}
        {!mobile && (
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+Shift+\\)`}
            aria-expanded={!collapsed}
            aria-controls="notes-drawer"
            onClick={onToggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={20} aria-hidden="true" /> : <PanelLeftClose size={20} aria-hidden="true" />}
          </button>
        )}
        {!collapsed && (
          <div className="brand">
            <a
              href="/"
              className="brand-link"
              aria-label="Margin home"
              aria-current={activeId ? undefined : 'page'}
              onClick={handleHome}
            >
              <img src="/favicon.svg" alt="" width={30} height={30} />
              <span>Margin</span>
            </a>
            {mobile && (
              <button type="button" className="icon-button drawer-close" aria-label="Close notes menu" onClick={onClose}>
                <X size={20} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {collapsed && (
        <div className="rail">
          <a
            href="/"
            className="rail-logo"
            aria-label="Margin home"
            title="Home"
            aria-current={activeId ? undefined : 'page'}
            onClick={handleHome}
          >
            <img src="/favicon.svg" alt="" width={30} height={30} />
          </a>
          <button type="button" className="rail-button rail-new" aria-label="New note" title="New note" onClick={onCreate} disabled={creating}>
            <Plus size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rail-button"
            aria-label="Search notes"
            title="Search notes"
            onClick={() => {
              focusSearchAfterExpand.current = true
              onToggleCollapsed()
            }}
          >
            <Search size={19} aria-hidden="true" />
          </button>
          <nav className="rail-notes" aria-label="Recent notes">
            {recent.map(note => {
              const title = displayTitle(note.title)
              const active = note.id === activeId
              return (
                <a
                  key={note.id}
                  href={notePath(note.id)}
                  className={`rail-note candy-${candyFor(note.id)}${active ? ' is-active' : ''}`}
                  aria-label={title}
                  aria-current={active ? 'page' : undefined}
                  data-tooltip={title}
                  onClick={event => handleOpen(event, note.id)}
                >
                  <span aria-hidden="true">{firstGrapheme(title) || '·'}</span>
                </a>
              )
            })}
          </nav>
          <div className="rail-footer">{railFooter}</div>
        </div>
      )}

      {!collapsed && (
      <>
      <div className="sidebar-header">
        <button type="button" className="button primary new-note" onClick={onCreate} disabled={creating}>
          <Plus size={18} aria-hidden="true" />
          New note
        </button>
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
          />
        </label>
        {tags.length > 0 && (
          <section className="sidebar-tags" aria-label="Tags">
            <TagList tags={tags} activeTags={activeTags} onToggle={onToggleTag} limit={TAGS_SHOWN} />
          </section>
        )}
      </div>

      <nav className="note-list" aria-label="Notes">
        {listState === 'error' && (
          <div className="list-message">
            Couldn't load notes.{' '}
            <button type="button" className="link-button" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {listState === 'ready' && notes.length === 0 && (
          <div className="list-message">{query.trim() ? 'No notes match your search.' : 'No notes yet.'}</div>
        )}
        <ul>
          {notes.map(note => {
            const active = note.id === activeId
            return (
              <li key={note.id}>
                <a
                  href={notePath(note.id)}
                  className={`note-item candy-${candyFor(note.id)}${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={event => handleOpen(event, note.id)}
                >
                  <span className="note-item-title">
                    <span className="note-dot" aria-hidden="true" />
                    {displayTitle(note.title)}
                  </span>
                  {note.snippet && <span className="note-item-snippet">{note.snippet}</span>}
                  {note.tags.length > 0 && (
                    <span className="note-item-tags">
                      {note.tags.slice(0, ROW_TAGS).map(tag => (
                        <span key={tag} className="note-item-tag">
                          #{tag}
                        </span>
                      ))}
                      {note.tags.length > ROW_TAGS && <span className="note-item-tag is-more">+{note.tags.length - ROW_TAGS}</span>}
                    </span>
                  )}
                  <time className="note-item-time" dateTime={new Date(note.updatedAt).toISOString()}>
                    {formatEdited(note.updatedAt, now)}
                  </time>
                </a>
              </li>
            )
          })}
        </ul>
        {limited && (
          <div className="list-message list-limit">
            Showing the {notes.length} most recent notes. Search to find older ones.
          </div>
        )}
      </nav>
      <div className="sidebar-footer">{footer}</div>
      </>
      )}
    </aside>
  )
}
