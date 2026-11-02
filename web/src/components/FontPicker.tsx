import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { ChevronDown, Search, Star } from 'lucide-react'
import { BUNDLED_FONTS, DEFAULT_FONT, FONT_CATEGORIES, fontFamilyValue, genericFamily } from '../../../shared/fonts.ts'
import type { FontCatalogEntry } from '../../../shared/fonts.ts'
import { ensureFont, ensurePreview, loadCatalog } from '../state/fonts.ts'
import { getFavorites, refreshFavorites, subscribeFavorites, toggleFavorite } from '../state/fontFavorites.ts'
import { runWithEndStyle } from '../editor/endStyle.ts'
import { useDismiss } from './ToolbarParts.tsx'

const ROW_HEIGHT = 32
const LIST_HEIGHT = 320
const OVERSCAN = 4
const PREVIEW_IDLE_MS = 150

type Row =
  | { kind: 'default' }
  | { kind: 'heading'; label: string }
  | { kind: 'font'; entry: FontCatalogEntry; favorite: boolean }

type FontPickerProps = {
  editor: Editor
  /** First family of the selection's font, or null for the page default. */
  current: string | null
  disabled: boolean
}

export function FontPicker({ editor, current, disabled }: FontPickerProps) {
  const [open, setOpen] = useState(false)
  // Escape returns to the document from anywhere in the popover (search box, chips, stars); an
  // outside click leaves focus wherever the user clicked.
  const ref = useDismiss(open, reason => {
    setOpen(false)
    if (reason === 'escape') editor.view.focus()
  })

  return (
    <div className="tool-menu" ref={ref}>
      <button
        type="button"
        className="tool-select font-trigger"
        title="Font"
        aria-label="Font"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => setOpen(value => !value)}
      >
        <span className="font-trigger-label">{current ?? DEFAULT_FONT}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <FontPopover
          editor={editor}
          current={current}
          onClose={() => {
            setOpen(false)
            editor.view.focus()
          }}
        />
      )}
    </div>
  )
}

function FontPopover({ editor, current, onClose }: { editor: Editor; current: string | null; onClose: () => void }) {
  const [catalog, setCatalog] = useState<FontCatalogEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const favorites = useSyncExternalStore(subscribeFavorites, getFavorites)

  // Pick up favorites changed in another tab.
  useEffect(() => refreshFavorites(), [])

  useEffect(() => {
    let cancelled = false
    loadCatalog()
      .then(list => !cancelled && setCatalog(list))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo<Row[]>(() => {
    if (!catalog) return []
    const needle = query.trim().toLowerCase()
    const matches = (entry: FontCatalogEntry) =>
      (!needle || entry.f.toLowerCase().includes(needle)) && (!category || entry.k === category)
    const favoriteSet = new Set(favorites)
    const result: Row[] = []
    if (!needle && !category) result.push({ kind: 'default' })
    const favoriteRows = catalog
      .filter(entry => favoriteSet.has(entry.f) && matches(entry))
      .sort((a, b) => a.f.localeCompare(b.f))
      .map(entry => ({ kind: 'font' as const, entry, favorite: true }))
    if (favoriteRows.length > 0) result.push({ kind: 'heading', label: 'Favorites' }, ...favoriteRows)
    const all = catalog.filter(matches).map(entry => ({ kind: 'font' as const, entry, favorite: favoriteSet.has(entry.f) }))
    if (all.length > 0) result.push({ kind: 'heading', label: needle || category ? 'Matching fonts' : 'All fonts' }, ...all)
    return result
  }, [catalog, favorites, query, category])

  const selectable = useMemo(() => rows.flatMap((row, index) => (row.kind === 'heading' ? [] : [index])), [rows])
  const activeRow = selectable[Math.min(active, selectable.length - 1)] ?? -1

  // Reset the highlight and scroll position when the filter changes.
  useEffect(() => {
    setActive(0)
    setScrollTop(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }, [query, category])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN)

  // Previews for visible rows load once scrolling pauses, so a fast scroll doesn't fetch hundreds.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const row of rows.slice(first, last)) if (row.kind === 'font') ensurePreview(row.entry.f)
    }, PREVIEW_IDLE_MS)
    return () => clearTimeout(timer)
  }, [rows, first, last])

  function apply(row: Row | undefined) {
    if (!row || row.kind === 'heading') return
    if (row.kind === 'default') runWithEndStyle(editor, c => c.unsetFontFamily())
    else {
      void ensureFont(row.entry.f, { force: true })
      runWithEndStyle(editor, c => c.setFontFamily(fontFamilyValue(row.entry)))
    }
    onClose()
  }

  function scrollIntoView(rowIndex: number) {
    const list = listRef.current
    if (!list) return
    const top = rowIndex * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + LIST_HEIGHT) list.scrollTop = top + ROW_HEIGHT - LIST_HEIGHT
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(selectable.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      scrollIntoView(selectable[next] ?? 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      apply(rows[activeRow])
    }
  }

  return (
    <div className="popover font-popover" role="dialog" aria-label="Choose a font">
      <div className="styles-head font-head">
        <span className="styles-current">{current ?? `${DEFAULT_FONT} (default)`}</span>
        <button
          type="button"
          className={current && favorites.includes(current) ? 'font-star is-favorite' : 'font-star'}
          disabled={!current}
          aria-label={
            current ? (favorites.includes(current) ? `Remove ${current} from favorites` : `Add ${current} to favorites`) : 'The default font can’t be a favorite'
          }
          title={current ? 'Favorite this font' : undefined}
          onClick={() => current && toggleFavorite(current)}
        >
          <Star size={16} aria-hidden="true" />
        </button>
      </div>
      <label className="font-search">
        <Search size={15} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder="Search fonts"
          aria-label="Search fonts"
          role="combobox"
          aria-expanded="true"
          aria-controls="font-list"
          aria-activedescendant={activeRow >= 0 ? `font-row-${activeRow}` : undefined}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="font-categories" role="group" aria-label="Category">
        {[null, ...FONT_CATEGORIES].map(value => (
          <button
            key={value ?? 'all'}
            type="button"
            className={category === value ? 'chip is-active' : 'chip'}
            aria-pressed={category === value}
            // Keep focus in the search box so ↑/↓/Enter keep working.
            onMouseDown={event => event.preventDefault()}
            onClick={() => setCategory(value)}
          >
            {value ?? 'All'}
          </button>
        ))}
      </div>

      {failed && <p className="font-empty">Couldn't load the font list.</p>}
      {!failed && !catalog && <p className="font-empty">Loading fonts…</p>}
      {catalog && rows.length === 0 && <p className="font-empty">No fonts match “{query}”.</p>}
      {catalog && rows.length > 0 && (
        <div
          id="font-list"
          ref={listRef}
          className="font-list"
          role="listbox"
          aria-label="Fonts"
          style={{ height: Math.min(LIST_HEIGHT, rows.length * ROW_HEIGHT) }}
          onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {rows.slice(first, last).map((row, offset) => {
              const index = first + offset
              const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT }
              if (row.kind === 'heading') {
                return (
                  <div key={`heading-${row.label}`} className="font-heading" style={style} role="presentation">
                    {row.label}
                  </div>
                )
              }
              const family = row.kind === 'font' ? row.entry.f : null
              const selected = family === current || (row.kind === 'default' && current === null)
              const className = ['font-row', index === activeRow && 'is-active', selected && 'is-selected']
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={row.kind === 'font' ? `${row.favorite ? 'fav' : 'all'}-${row.entry.f}-${index}` : 'default'}
                  id={`font-row-${index}`}
                  className={className}
                  style={style}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={event => event.preventDefault()}
                  onMouseEnter={() => setActive(selectable.indexOf(index))}
                  onClick={() => apply(row)}
                >
                  {row.kind === 'default' ? (
                    <span className="font-name" style={{ fontFamily: `"${DEFAULT_FONT}", sans-serif` }}>
                      {DEFAULT_FONT} <span className="font-note">(default)</span>
                    </span>
                  ) : (
                    <>
                      <span
                        className="font-name"
                        style={{
                          // Bundled families have no preview face; they're always loaded.
                          fontFamily: BUNDLED_FONTS.has(row.entry.f)
                            ? `"${row.entry.f}", ${genericFamily(row.entry.k)}`
                            : `"${row.entry.f} Preview", ${genericFamily(row.entry.k)}`,
                        }}
                      >
                        {row.entry.f}
                      </span>
                      <button
                        type="button"
                        className={row.favorite ? 'font-star is-favorite' : 'font-star'}
                        aria-label={row.favorite ? `Remove ${row.entry.f} from favorites` : `Add ${row.entry.f} to favorites`}
                        title={row.favorite ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={event => {
                          event.stopPropagation()
                          toggleFavorite(row.entry.f)
                        }}
                      >
                        <Star size={15} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
