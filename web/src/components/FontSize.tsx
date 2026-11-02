import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { Minus, Plus } from 'lucide-react'
import { clampFontSize, FONT_SIZE_PRESETS, setFontSize } from '../fontSize.ts'
import { MOD, useDismiss } from './ToolbarParts.tsx'

type FontSizeProps = {
  editor: Editor
  /** Size at the cursor in pt; null when it can't be shown (em, %, keywords). */
  value: number | null
  disabled: boolean
}

/** Google Docs-style size stepper: [−] [11] [+], with presets when the box is focused. */
export function FontSize({ editor, value, disabled }: FontSizeProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => {
    setOpen(false)
    setDraft(null)
  })
  const shown = draft ?? (value === null ? '' : String(value))

  function apply(size: number) {
    setDraft(null)
    setOpen(false)
    if (Number.isFinite(size) && size > 0) setFontSize(editor, size)
  }

  function step(delta: number) {
    // Step from what's typed in the box, if it's a number, rather than the size at the cursor.
    const typed = draft === null ? NaN : Number(draft)
    const base = Number.isFinite(typed) && typed > 0 ? typed : (value ?? 11)
    apply(clampFontSize(base + delta))
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      apply(Number(shown))
    } else if (event.key === 'Escape') {
      setDraft(null)
      setOpen(false)
      editor.view.focus()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      step(event.key === 'ArrowUp' ? 1 : -1)
    }
  }

  return (
    <div className="font-size tool-menu" ref={ref}>
      <button
        type="button"
        className="tool tool-small"
        title={`Decrease font size (${MOD}+Shift+,)`}
        aria-label="Decrease font size"
        disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => step(-1)}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <input
        className="font-size-input"
        aria-label="Font size"
        title="Font size"
        inputMode="decimal"
        value={shown}
        disabled={disabled}
        onFocus={event => {
          setOpen(true)
          event.currentTarget.select()
        }}
        onChange={event => setDraft(event.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="tool tool-small"
        title={`Increase font size (${MOD}+Shift+.)`}
        aria-label="Increase font size"
        disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => step(1)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <div className="popover size-popover" role="listbox" aria-label="Font sizes">
          {FONT_SIZE_PRESETS.map(size => (
            <button
              key={size}
              type="button"
              role="option"
              aria-selected={size === value}
              className={size === value ? 'size-option is-selected' : 'size-option'}
              onMouseDown={event => event.preventDefault()}
              onClick={() => apply(size)}
            >
              {size}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
