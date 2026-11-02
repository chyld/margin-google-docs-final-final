import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type { EditorState } from '@tiptap/pm/state'
import { RemoveFormatting, X } from 'lucide-react'
import { firstFontFamily } from '../../../shared/fonts.ts'
import type { StyleProps } from '../../../shared/styleProps.ts'
import { formatInfoFor } from '../editor/formatInfo.ts'
import type { Field, FormatInfo, StyleRef } from '../editor/formatInfo.ts'
import { stylesStatus } from '../editor/styleIndex.ts'
import type { PanelMode } from '../state/formatPanel.ts'
import { styleById, useNamedStyles } from '../state/namedStyles.ts'
import { clearFormatting } from '../editor/commands.ts'
import { ALIGN_NAMES, blockLabel } from '../editor/labels.ts'
import { trapTab } from '../focusTrap.ts'

type FormatPanelProps = {
  editor: Editor
  mode: PanelMode
  /** No changes possible (read-only, signing out): actions are off. */
  off: boolean
  /** The note itself is read-only (shown as a tag). */
  readOnlyNote: boolean
  /** Close it. `restoreFocus`: put focus back on the toggle (not when opening the Styles menu). */
  onClose: (options?: { restoreFocus?: boolean }) => void
  /** Opens the toolbar's Styles menu (the style name is a button). */
  onOpenStyles: () => void
}


/** What a style itself sets, for the "Includes" line. */
function includes(props: StyleProps): string {
  const parts: string[] = []
  const family = firstFontFamily(props.fontFamily)
  if (family) parts.push(family)
  if (props.fontSize) parts.push(props.fontSize)
  if (props.block) parts.push(blockLabel(props.block))
  if (props.align) parts.push(ALIGN_NAMES[props.align] ?? props.align)
  for (const [key, name] of [['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['strike', 'Strikethrough']] as const) {
    if (props[key]) parts.push(name)
  }
  if (props.color) parts.push(`Color ${props.color}`)
  if (props.highlight) parts.push(`Highlight ${props.highlight}`)
  return parts.join(' · ')
}

function Swatch({ color }: { color: string }) {
  return <span className="format-swatch" style={{ background: color }} aria-hidden="true" />
}

/** The small "where it comes from" chip after a value. */
function SourceChip({ field }: { field: Field<unknown> }) {
  switch (field.source) {
    case 'direct':
      return <span className="format-source is-direct">Direct</span>
    case 'style': {
      const name = styleById(field.styleId)?.name
      return <span className="format-source is-style">{name ?? 'Style'}</span>
    }
    case 'element':
      return <span className="format-source is-element">{field.label}</span>
    case 'default':
      return <span className="format-source is-default">Default</span>
    case 'mixed-sources':
      return <span className="format-source is-default">Mixed sources</span>
    default:
      return null
  }
}

function Row<T>({ label, field, show }: { label: string; field: Field<T>; show: (value: T) => ReactNode }) {
  let value: ReactNode
  if (field.source === 'mixed') value = <span className="format-mixed">Mixed</span>
  else if (field.source === 'unresolved') value = <span className="format-mixed" title="The style hasn't loaded">—</span>
  else value = show(field.value as T)
  return (
    <div className="format-row">
      <dt>{label}</dt>
      <dd>
        <span className="format-value">{value}</span>
        <SourceChip field={field as Field<unknown>} />
      </dd>
    </div>
  )
}

function StyleRow({ label, value, off, onOpen }: { label: string; value: StyleRef; off: boolean; onOpen: () => void }) {
  let content: ReactNode
  let detail: string | null = null
  switch (value.kind) {
    case 'none':
      content = <span className="format-muted">No style</span>
      break
    case 'mixed': {
      const names = value.ids.map(id => styleById(id)?.name ?? 'Unknown').join(', ')
      content = (
        <span className="format-mixed" title={value.total > value.ids.length ? `${names}…` : names}>
          Mixed
        </span>
      )
      break
    }
    case 'unresolved':
      content = (
        <span className="format-muted">
          {value.status === 'loading' ? 'Loading…' : value.status === 'failed' ? "Couldn't load styles" : 'Unknown style'}
        </span>
      )
      break
    case 'style': {
      const name = value.deleted ? `${value.name} (deleted)` : value.name
      // Read-only: the Styles menu can't open, so the name is plain text.
      content = off ? (
        <span className="format-style-name">{name}</span>
      ) : (
        <button
          type="button"
          className="format-style-name is-button"
          title="Open the Styles menu"
          onMouseDown={event => event.preventDefault()}
          onClick={onOpen}
        >
          {name}
        </button>
      )
      detail = includes(value.props) || null
      break
    }
  }
  return (
    <div className="format-row is-style">
      <dt>{label}</dt>
      <dd>
        {content}
        {detail && <span className="format-includes">Includes: {detail}</span>}
      </dd>
    </div>
  )
}

function onOff(value: boolean) {
  return value ? 'On' : 'Off'
}

function TextSection({ info }: { info: FormatInfo }) {
  const t = info.text
  return (
    <section className="format-section" aria-labelledby="format-text-title">
      <h3 id="format-text-title">
        Text{info.typingHere && <span className="format-caption"> · typing here</span>}
      </h3>
      {info.codeBlock ? (
        <p className="format-muted">Code block · monospace</p>
      ) : (
        <dl>
          <Row label="Font" field={t.fontFamily} show={value => value} />
          <Row label="Size" field={t.fontSize} show={value => (value === null ? 'Custom' : `${value}pt`)} />
          <Row label="Bold" field={t.bold} show={onOff} />
          <Row label="Italic" field={t.italic} show={onOff} />
          <Row label="Underline" field={t.underline} show={onOff} />
          <Row label="Strikethrough" field={t.strike} show={onOff} />
          <Row label="Code" field={t.code} show={onOff} />
          <Row
            label="Color"
            field={t.color}
            show={value => (
              <>
                <Swatch color={value} />
                {value}
              </>
            )}
          />
          <Row
            label="Highlight"
            field={t.highlight}
            show={value =>
              value ? (
                <>
                  <Swatch color={value} />
                  {value}
                </>
              ) : (
                'None'
              )
            }
          />
          <Row
            label="Link"
            field={t.link}
            show={value =>
              value ? (
                <span className="format-link" title={value}>
                  {value}
                </span>
              ) : (
                'None'
              )
            }
          />
        </dl>
      )}
    </section>
  )
}

/**
 * The Format sidebar: the formatting at the cursor or selection, where each part comes from, and the
 * styles involved. Reads the same derivation as the rest of the app (formatInfoFor).
 */
export function FormatPanel({ editor, mode, off, readOnlyNote, onClose, onOpenStyles }: FormatPanelProps) {
  // The editor state itself (compared by identity: the derivation is cached per state).
  const state = useEditorState<EditorState | null>({
    editor,
    selector: ({ editor: current }) => current?.state ?? null,
    equalityFn: (a, b) => a === b,
  })
  // Saved styles changing (or loading) changes names and looks without an editor transaction.
  const { styles, loaded, failed } = useNamedStyles()
  const status = stylesStatus({ loaded, failed })
  const ref = useRef<HTMLElement>(null)
  const sheet = mode === 'sheet'

  // The phone sheet is modal: focus moves into it.
  useEffect(() => {
    if (sheet) ref.current?.querySelector<HTMLElement>('.format-close')?.focus()
  }, [sheet])

  if (!state) return null
  const info = formatInfoFor(state, styles, status)

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && mode !== 'docked' && !event.defaultPrevented) {
      event.preventDefault()
      onClose()
      return
    }
    // The phone sheet is modal: Tab stays inside it.
    if (sheet) trapTab(event, ref.current)
  }

  function openStyles() {
    // The sheet closes first (without handing focus back), then the Styles menu opens on top.
    if (sheet) onClose({ restoreFocus: false })
    onOpenStyles()
  }

  return (
    <aside
      ref={ref}
      id="format-panel"
      className={`format-panel is-${mode}`}
      aria-labelledby="format-panel-title"
      role={sheet ? 'dialog' : undefined}
      aria-modal={sheet || undefined}
      // Focusable, so a click on plain text inside keeps focus here (Escape and the Tab trap still work).
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <header className="format-head">
        <h2 id="format-panel-title">Format</h2>
        {readOnlyNote && <span className="format-tag">Read-only</span>}
        <button type="button" className="icon-button format-close" aria-label="Close format sidebar" title="Close" onClick={() => onClose()}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      {/* Focusable so keyboard users can scroll it when it has no buttons (read-only, no styles). */}
      <div className="format-body" tabIndex={0} role="region" aria-label="Formatting details">
        {!info.image && !info.node && (
          <section className="format-section" aria-labelledby="format-styles-title">
            <h3 id="format-styles-title">Styles</h3>
            <dl>
              <StyleRow label="Text style" value={info.styles.text} off={off} onOpen={openStyles} />
              <StyleRow label="Paragraph style" value={info.styles.paragraph} off={off} onOpen={openStyles} />
            </dl>
          </section>
        )}

        {info.node ? (
          <section className="format-section" aria-labelledby="format-node-title">
            <h3 id="format-node-title">Selected</h3>
            <p className="format-muted">{info.node} · no text formatting</p>
          </section>
        ) : info.image ? (
          <section className="format-section" aria-labelledby="format-image-title">
            <h3 id="format-image-title">Image</h3>
            <dl>
              <div className="format-row">
                <dt>Alignment</dt>
                <dd>
                  <span className="format-value">{ALIGN_NAMES[info.image.align] ?? info.image.align}</span>
                </dd>
              </div>
            </dl>
          </section>
        ) : (
          <>
            <section className="format-section" aria-labelledby="format-paragraph-title">
              <h3 id="format-paragraph-title">Paragraph</h3>
              {!info.codeBlock && (
                <dl>
                  <Row label="Type" field={info.block} show={value => blockLabel(value)} />
                  <Row label="Alignment" field={info.align} show={value => ALIGN_NAMES[value] ?? value} />
                </dl>
              )}
              {info.context.length > 0 && (
                <ul className="format-context" aria-label="Inside">
                  {info.context.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
            <TextSection info={info} />
          </>
        )}
      </div>

      <footer className="format-foot">
        <button
          type="button"
          className="button small"
          disabled={off}
          onMouseDown={event => event.preventDefault()}
          onClick={event => {
            if (sheet && event.detail !== 0) {
              // A tap: the sheet's background is inert, so clear first, close, then focus the text
              // once the app is live again. From the keyboard the sheet stays open (below).
              clearFormatting(editor, { focus: false })
              onClose({ restoreFocus: false })
              requestAnimationFrame(() => requestAnimationFrame(() => editor.view.focus()))
              return
            }
            // From the keyboard, focus stays in the panel; with the mouse, back to the text.
            clearFormatting(editor, { focus: event.detail !== 0 })
          }}
        >
          <RemoveFormatting size={15} aria-hidden="true" />
          Clear formatting
        </button>
      </footer>
    </aside>
  )
}
