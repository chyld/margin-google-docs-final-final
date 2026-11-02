import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react'
import type { SelectionBookmark } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { MoreHorizontal, Plus, Search, Star, X } from 'lucide-react'
import { firstFontFamily } from '../../../shared/fonts.ts'
import { BLOCK_TYPOGRAPHY } from '../../../shared/styleProps.ts'
import type { NamedStyle, StyleProps } from '../../../shared/styleProps.ts'
import { ensureStyleFont } from '../state/fonts.ts'
import {
  createStyle,
  deleteStyle,
  loadStyles,
  newStyleId,
  sortedLiveStyles,
  styleById,
  styleErrorMessage,
  updateStyle,
  useNamedStyles,
} from '../state/namedStyles.ts'
import { showNotice } from '../state/notices.ts'
import { applyFailureMessage, applyStyle, captureProps, removeStyle } from '../editor/styleCommands.ts'
import type { CurrentStyle } from '../editor/styleCommands.ts'
import { blockLabel } from '../editor/labels.ts'
import { ToolMenuButton } from './ToolbarParts.tsx'

const SEARCH_AFTER = 8
const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘⌥⇧' : 'Ctrl+Alt+Shift+'

/** Inline CSS for a preview of the style (size kept readable in the menu). */
export function previewStyle(props: StyleProps): CSSProperties {
  const style: CSSProperties = {}
  if (props.block) {
    const look = BLOCK_TYPOGRAPHY[props.block]
    style.fontWeight = look.fontWeight
    style.fontStyle = look.fontStyle
    style.color = look.color
    style.fontSize = look.fontSize
  }
  if (props.fontFamily) style.fontFamily = props.fontFamily
  if (props.fontSize) style.fontSize = props.fontSize
  const size = Number.parseFloat(String(style.fontSize ?? '11pt'))
  style.fontSize = `${Math.min(18, Math.max(10, size))}pt`
  if (props.color) style.color = props.color
  if (props.highlight) style.backgroundColor = props.highlight
  if (props.bold) style.fontWeight = 700
  if (props.italic) style.fontStyle = 'italic'
  const lines = [props.underline && 'underline', props.strike && 'line-through'].filter(Boolean)
  if (lines.length) style.textDecorationLine = lines.join(' ')
  return style
}

function caption(props: StyleProps): string {
  const parts: string[] = []
  const family = firstFontFamily(props.fontFamily)
  if (family) parts.push(family)
  if (props.fontSize) parts.push(props.fontSize.replace('pt', ''))
  if (props.block) parts.push(blockLabel(props.block))
  if (props.align) parts.push(props.align[0]?.toUpperCase() + props.align.slice(1))
  return parts.join(' · ')
}

type StylesMenuProps = {
  editor: Editor
  current: CurrentStyle
  disabled: boolean
  /** Changing this number opens the menu (the Format sidebar's style name). */
  openRequest?: number
}

export function StylesMenu({ editor, current, disabled, openRequest }: StylesMenuProps) {
  const { styles } = useNamedStyles()
  const style = current.kind === 'style' ? styles.find(item => item.id === current.id) : undefined
  const label = current.kind === 'mixed' ? 'Mixed' : style && !style.deleted ? style.name : 'Styles'
  return (
    <ToolMenuButton
      label={style && !style.deleted ? `Style: ${style.name}` : 'Styles'}
      text={label}
      className="styles-trigger"
      popoverClassName="styles-popover"
      kind="dialog"
      disabled={disabled}
      openRequest={openRequest}
      onRestoreFocus={() => editor.view.focus()}
    >
      {close => <StylesPanel editor={editor} current={current} close={close} />}
    </ToolMenuButton>
  )
}

type FormState =
  | { mode: 'create'; bookmark: SelectionBookmark; props: StyleProps; name: string; id: string }
  | { mode: 'update'; style: NamedStyle; props: StyleProps; name: string; bookmark: SelectionBookmark }
  | { mode: 'rename'; style: NamedStyle; name: string }

function StylesPanel({ editor, current, close }: { editor: Editor; current: CurrentStyle; close: () => void }) {
  const { styles, loaded, failed } = useNamedStyles()
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [form, setForm] = useState<FormState | null>(null)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const { favorites, others } = useMemo(() => sortedLiveStyles(styles), [styles])
  const needle = query.trim().toLocaleLowerCase()
  const matches = (style: NamedStyle) => !needle || style.name.toLocaleLowerCase().includes(needle)
  const favoriteRows = favorites.filter(matches)
  const otherRows = others.filter(matches)
  const rows = [...favoriteRows, ...otherRows]
  const showSearch = favorites.length + others.length > SEARCH_AFTER
  const currentStyle = current.kind === 'style' ? styleById(current.id) : undefined

  useEffect(() => setActive(0), [query])

  // Focus the search box, or the list, when the panel opens or returns from a form.
  useEffect(() => {
    if (form) return
    // Fallback: the panel itself, so typing never goes into the note behind the open menu.
    const target = panelRef.current?.querySelector<HTMLElement>('.styles-search input, .styles-list') ?? panelRef.current
    target?.focus()
  }, [form, loaded])

  // Opening the menu retries a failed load.
  useEffect(() => {
    if (failed) void loadStyles().catch(() => undefined)
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (form) return <StyleForm editor={editor} form={form} onDone={() => setForm(null)} onClose={close} />

  function apply(style: NamedStyle | undefined) {
    if (!style) return
    const result = applyStyle(editor.state, style)
    if ('tr' in result) editor.view.dispatch(result.tr)
    else showNotice(applyFailureMessage(result.reason, style.name))
    ensureStyleFont(style.props.fontFamily)
    close()
  }

  function startCreate() {
    setForm({
      mode: 'create',
      bookmark: editor.state.selection.getBookmark(),
      props: captureProps(editor.state, id => styleById(id)?.props),
      name: '',
      id: newStyleId(),
    })
  }

  async function toggleFavorite(style: NamedStyle) {
    try {
      await updateStyle(style.id, { favorite: style.favoriteSlot === null })
    } catch (error) {
      showNotice(styleErrorMessage(error))
    }
  }

  async function remove(style: NamedStyle) {
    setActionsFor(null)
    if (!window.confirm(`Delete “${style.name}”? Text that uses it keeps its look.`)) return
    try {
      await deleteStyle(style.id)
    } catch (error) {
      showNotice(styleErrorMessage(error))
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Keys on a row's own buttons (★, ⋯, actions) belong to those buttons.
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(rows.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      apply(rows[active])
    }
  }

  const renderRow = (style: NamedStyle, index: number) => (
    <StyleRow
      key={style.id}
      style={style}
      index={index}
      listId={listId}
      active={index === active}
      selected={currentStyle?.id === style.id}
      actionsOpen={actionsFor === style.id}
      onHover={() => setActive(index)}
      onApply={() => apply(style)}
      onToggleFavorite={() => void toggleFavorite(style)}
      onToggleActions={() => setActionsFor(value => (value === style.id ? null : style.id))}
      onUpdate={() => {
        setActionsFor(null)
        // The style's parts (kept unless unticked) plus the selection's look on top.
        const captured = captureProps(editor.state, id => styleById(id)?.props)
        setForm({
          mode: 'update',
          style,
          props: { ...style.props, ...captured },
          name: style.name,
          bookmark: editor.state.selection.getBookmark(),
        })
      }}
      onRename={() => {
        setActionsFor(null)
        setForm({ mode: 'rename', style, name: style.name })
      }}
      onDelete={() => void remove(style)}
    />
  )

  return (
    <div className="styles-panel" ref={panelRef} tabIndex={-1}>
      <div className="styles-head">
        <span className="styles-current">
          {current.kind === 'mixed'
            ? 'Mixed styles'
            : currentStyle
              ? currentStyle.deleted
                ? `${currentStyle.name} (deleted)`
                : currentStyle.name
              : 'No style'}
        </span>
        <button
          type="button"
          className={currentStyle?.favoriteSlot != null ? 'font-star is-favorite' : 'font-star'}
          disabled={!currentStyle || currentStyle.deleted}
          aria-label={
            currentStyle && !currentStyle.deleted
              ? currentStyle.favoriteSlot != null
                ? `Remove ${currentStyle.name} from favorites`
                : `Add ${currentStyle.name} to favorites`
              : 'No style to favorite'
          }
          title="Favorite this style"
          onClick={() => currentStyle && void toggleFavorite(currentStyle)}
        >
          <Star size={16} aria-hidden="true" />
        </button>
      </div>

      <button type="button" className="menu-item with-icon styles-save" onClick={startCreate}>
        <span className="menu-item-icon" aria-hidden="true">
          <Plus size={16} />
        </span>
        <span className="menu-item-label">Save selection as a style…</span>
      </button>

      {showSearch && (
        <label className="font-search styles-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            placeholder="Search styles"
            aria-label="Search styles"
            role="combobox"
            aria-expanded="true"
            aria-controls={rows.length > 0 ? listId : undefined}
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onListKeyDown}
          />
        </label>
      )}

      {!loaded && !failed && <p className="font-empty">Loading styles…</p>}
      {!loaded && failed && (
        <p className="font-empty">
          Couldn't load your styles.{' '}
          <button type="button" className="link-button" onClick={() => void loadStyles().catch(() => undefined)}>
            Try again
          </button>
        </p>
      )}
      {loaded && rows.length === 0 && (
        <p className="font-empty">
          {needle ? `No styles match “${query}”.` : 'No styles yet. Format some text, then save it as a style.'}
        </p>
      )}
      {rows.length > 0 && (
        <div
          ref={listRef}
          id={listId}
          className="styles-list"
          role="listbox"
          aria-label="Styles"
          tabIndex={showSearch ? -1 : 0}
          aria-activedescendant={!showSearch && rows[active] ? `${listId}-${active}` : undefined}
          onKeyDown={showSearch ? undefined : onListKeyDown}
        >
          {favoriteRows.length > 0 && (
            <div className="font-heading styles-heading" role="presentation">
              Favorites
            </div>
          )}
          {favoriteRows.map((style, index) => renderRow(style, index))}
          {otherRows.length > 0 && (
            <div className="font-heading styles-heading" role="presentation">
              {favoriteRows.length > 0 ? 'All styles' : 'Styles'}
            </div>
          )}
          {otherRows.map((style, index) => renderRow(style, favoriteRows.length + index))}
        </div>
      )}

      {currentStyle && (
        <button
          type="button"
          className="menu-item with-icon styles-remove"
          onClick={() => {
            const tr = removeStyle(editor.state)
            if (tr) editor.view.dispatch(tr)
            close()
          }}
        >
          <span className="menu-item-icon" aria-hidden="true">
            <X size={16} />
          </span>
          <span className="menu-item-label">Remove style from selection</span>
        </button>
      )}
    </div>
  )
}

type StyleRowProps = {
  style: NamedStyle
  index: number
  listId: string
  active: boolean
  selected: boolean
  actionsOpen: boolean
  onHover: () => void
  onApply: () => void
  onToggleFavorite: () => void
  onToggleActions: () => void
  onUpdate: () => void
  onRename: () => void
  onDelete: () => void
}

function StyleRow(props: StyleRowProps) {
  const { style, index, listId, active, selected, actionsOpen } = props
  const ref = useRef<HTMLDivElement>(null)

  // Load the row's font only once it's on screen.
  useEffect(() => {
    const element = ref.current
    if (!element || !style.props.fontFamily) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        ensureStyleFont(style.props.fontFamily)
        observer.disconnect()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [style.props.fontFamily])

  const slot = style.favoriteSlot
  return (
    <div className="style-row-wrap" role="none">
      <div
        ref={ref}
        data-index={index}
        className={['style-row', active && 'is-active', selected && 'is-selected'].filter(Boolean).join(' ')}
        role="none"
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={props.onHover}
        onClick={props.onApply}
      >
        {/* The option is just the name; the star and ⋯ are separate buttons beside it. */}
        <span className="style-row-text" id={`${listId}-${index}`} role="option" aria-selected={selected}>
          <span className="style-preview" style={previewStyle(style.props)}>
            {style.name}
          </span>
          {caption(style.props) && <span className="style-caption">{caption(style.props)}</span>}
          {slot !== null && slot <= 9 && <span className="visually-hidden">{`, shortcut ${SHORTCUT}${slot}`}</span>}
        </span>
        {slot !== null && slot <= 9 && (
          <span className="menu-item-shortcut" aria-hidden="true">{`${SHORTCUT}${slot}`}</span>
        )}
        <button
          type="button"
          className={slot !== null ? 'font-star is-favorite' : 'font-star'}
          aria-label={slot !== null ? `Remove ${style.name} from favorites` : `Add ${style.name} to favorites`}
          title={slot !== null ? 'Remove from favorites' : 'Add to favorites'}
          onClick={event => {
            event.stopPropagation()
            props.onToggleFavorite()
          }}
        >
          <Star size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="font-star style-more"
          aria-label={`More actions for ${style.name}`}
          aria-expanded={actionsOpen}
          onClick={event => {
            event.stopPropagation()
            props.onToggleActions()
          }}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </div>
      {actionsOpen && (
        <div className="style-actions" role="group" aria-label={`Actions for ${style.name}`}>
          <button type="button" className="menu-item" onClick={props.onUpdate}>
            Update to match selection
          </button>
          <button type="button" className="menu-item" onClick={props.onRename}>
            Rename
          </button>
          <button type="button" className="menu-item danger" onClick={props.onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

type Part = { key: keyof StyleProps; label: string; value: StyleProps[keyof StyleProps]; swatch?: string }

/** The parts a style could save from the captured formatting (unset paragraph parts start unchecked). */
function availableParts(props: StyleProps, editor: Editor): Array<Part & { checked: boolean }> {
  const parts: Array<Part & { checked: boolean }> = []
  const family = firstFontFamily(props.fontFamily)
  if (props.fontFamily) parts.push({ key: 'fontFamily', label: `Font: ${family ?? props.fontFamily}`, value: props.fontFamily, checked: true })
  if (props.fontSize) parts.push({ key: 'fontSize', label: `Size: ${props.fontSize.replace('pt', '')}`, value: props.fontSize, checked: true })
  if (props.color) parts.push({ key: 'color', label: 'Text color', value: props.color, swatch: props.color, checked: true })
  if (props.highlight) parts.push({ key: 'highlight', label: 'Highlight', value: props.highlight, swatch: props.highlight, checked: true })
  if (props.bold) parts.push({ key: 'bold', label: 'Bold', value: true, checked: true })
  if (props.italic) parts.push({ key: 'italic', label: 'Italic', value: true, checked: true })
  if (props.underline) parts.push({ key: 'underline', label: 'Underline', value: true, checked: true })
  if (props.strike) parts.push({ key: 'strike', label: 'Strikethrough', value: true, checked: true })
  const parent = editor.state.selection.$from.parent
  const block = props.block ?? (parent.type.name === 'heading' ? `h${parent.attrs.level as number}` : 'paragraph')
  parts.push({ key: 'block', label: `Paragraph: ${blockLabel(block)}`, value: block, checked: props.block !== undefined })
  const align = props.align ?? 'left'
  parts.push({ key: 'align', label: `Alignment: ${align[0]?.toUpperCase()}${align.slice(1)}`, value: align, checked: props.align !== undefined })
  return parts
}

function StyleForm({ editor, form, onDone, onClose }: { editor: Editor; form: FormState; onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState(form.name)
  const [parts, setParts] = useState(() => (form.mode === 'rename' ? [] : availableParts(form.props, editor)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = { name: useId(), error: useId() }
  // The source selection, kept up to date with edits made while the form is open or saving.
  const bookmark = useRef(form.mode === 'create' || form.mode === 'update' ? form.bookmark : null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      if (bookmark.current && transaction.docChanged) bookmark.current = bookmark.current.map(transaction.mapping)
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor])

  const chosen = (): StyleProps => {
    const props: Record<string, unknown> = {}
    for (const part of parts) if (part.checked) props[part.key] = part.value
    return props as StyleProps
  }
  const canSave = name.trim().length > 0 && (form.mode === 'rename' || parts.some(part => part.checked))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave || busy) return
    setBusy(true)
    setError(null)
    try {
      if (form.mode === 'create') {
        const style = await createStyle(name, chosen(), form.id)
        // Link the text the style was made from, at the selection it had when the form opened.
        if (!editor.isDestroyed && bookmark.current) {
          // The bookmark followed any edits made while the form was open or the request ran.
          editor.view.dispatch(editor.state.tr.setSelection(bookmark.current.resolve(editor.state.doc)))
          const result = applyStyle(editor.state, style)
          if ('tr' in result) editor.view.dispatch(result.tr)
          else showNotice(applyFailureMessage(result.reason, style.name))
        }
        onClose()
      } else if (form.mode === 'update') {
        const style = await updateStyle(form.style.id, { name, props: chosen() })
        // Like Word: the selection the style was updated from uses the style again (its tweaks may
        // have ended the style there).
        if (!editor.isDestroyed && bookmark.current) {
          editor.view.dispatch(editor.state.tr.setSelection(bookmark.current.resolve(editor.state.doc)))
          const result = applyStyle(editor.state, style)
          if ('tr' in result) editor.view.dispatch(result.tr)
          else showNotice(applyFailureMessage(result.reason, style.name))
        }
        onClose()
      } else {
        await updateStyle(form.style.id, { name })
        onDone()
      }
    } catch (caught) {
      setError(styleErrorMessage(caught))
      nameRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const title = form.mode === 'create' ? 'Save as a new style' : form.mode === 'update' ? `Update “${form.style.name}”` : `Rename “${form.style.name}”`
  return (
    <form className="style-form" onSubmit={submit} onKeyDown={event => event.key === 'Escape' && (event.stopPropagation(), onDone())}>
      <div className="style-form-title">{title}</div>
      <label className="style-form-label" htmlFor={ids.name}>
        Name
      </label>
      <input
        ref={nameRef}
        id={ids.name}
        className="style-form-name"
        value={name}
        maxLength={60}
        placeholder="e.g. Callout"
        aria-describedby={error ? ids.error : undefined}
        onChange={event => setName(event.target.value)}
      />
      {form.mode !== 'rename' && (
        <fieldset className="style-parts">
          <legend>Include</legend>
          {parts.map((part, index) => (
            <label key={part.key} className="style-part">
              <input
                type="checkbox"
                checked={part.checked}
                onChange={event => setParts(list => list.map((item, i) => (i === index ? { ...item, checked: event.target.checked } : item)))}
              />
              {part.swatch && <span className="style-swatch" style={{ background: part.swatch }} aria-hidden="true" />}
              {part.label}
            </label>
          ))}
          {form.mode === 'update' && <p className="style-form-note">Every place that uses this style updates.</p>}
        </fieldset>
      )}
      <p id={ids.error} className="popover-error" role="alert">
        {error}
      </p>
      <div className="style-form-actions">
        <button type="button" className="button small" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button small primary" disabled={!canSave || busy}>
          {form.mode === 'create' ? 'Save style' : 'Save'}
        </button>
      </div>
    </form>
  )
}
