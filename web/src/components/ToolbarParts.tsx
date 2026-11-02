// Small building blocks shared by the toolbar and its popovers.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

type ToolButtonProps = {
  label: string
  shortcut?: string
  icon: LucideIcon
  active?: boolean
  disabled?: boolean
  expanded?: boolean
  onClick: () => void
}

export function ToolButton({ label, shortcut, icon: Icon, active, disabled, expanded, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={active ? 'tool is-active' : 'tool'}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      disabled={disabled}
      // Keep focus (and the selection) in the editor.
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  )
}

export function Separator() {
  return <span className="tool-separator" aria-hidden="true" />
}

export function Group({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="tool-group" role="group" aria-label={label}>
      {children}
    </div>
  )
}

export type DismissReason = 'escape' | 'outside'

/** Closes a popover on outside clicks and Escape. */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onDismiss: (reason: DismissReason) => void,
) {
  const ref = useRef<T>(null)
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  })
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismiss.current('outside')
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss.current('escape')
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return ref
}

const MENU_ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

type ToolMenuButtonProps = {
  label: string
  /** What the trigger shows: an icon, optionally followed by text. */
  icon?: LucideIcon
  text?: ReactNode
  active?: boolean
  disabled?: boolean
  className?: string
  /** Replaces the icon/text trigger content (e.g. an icon with a color bar). */
  trigger?: ReactNode
  popoverClassName?: string
  /** 'menu' gets arrow-key navigation; 'dialog' manages its own focus (search fields, forms). */
  kind?: 'menu' | 'dialog'
  /** Where focus goes when the menu closes with Escape or after an action (the editor). */
  onRestoreFocus: () => void
  /** Told about every open and close (outside clicks and the trigger included). */
  onOpenChange?: (open: boolean) => void
  /** Changing this number opens the menu, as if from the keyboard (ignored while disabled). */
  openRequest?: number
  children: (close: () => void) => ReactNode
}

/**
 * A toolbar dropdown. Opening it focuses the first item; arrows, Home and End move; Escape closes it
 * and returns to the document. Menus that would run off the right edge align to the trigger's right.
 */
export function ToolMenuButton(props: ToolMenuButtonProps) {
  const { label, icon: Icon, text, active, disabled, className, trigger, popoverClassName, kind = 'menu', onRestoreFocus, onOpenChange, openRequest, children } = props
  const [open, setOpen] = useState(false)
  const [alignEnd, setAlignEnd] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Opened from the keyboard: focus moves into the menu. Opened with the mouse: focus stays in the
  // document (as in Google Docs), so typing right after a menu action is never lost.
  const fromKeyboard = useRef(false)
  const ref = useDismiss(open, reason => {
    setOpen(false)
    if (reason === 'escape') onRestoreFocus()
  })

  const close = () => {
    setOpen(false)
    onRestoreFocus()
  }

  // Opened from elsewhere (the Format sidebar's style name): the first request at mount is not one.
  const lastRequest = useRef(openRequest)
  useEffect(() => {
    if (openRequest === lastRequest.current) return
    lastRequest.current = openRequest
    if (disabled) return
    fromKeyboard.current = true
    setOpen(true)
  }, [openRequest, disabled])

  const openChange = useRef(onOpenChange)
  useEffect(() => {
    openChange.current = onOpenChange
  })
  useEffect(() => {
    openChange.current?.(open)
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setAlignEnd(false)
      return
    }
    const box = popoverRef.current?.getBoundingClientRect()
    if (box && box.right > window.innerWidth - 8) setAlignEnd(true)
    if (kind === 'menu' && fromKeyboard.current) popoverRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus()
  }, [open, kind])

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (kind !== 'menu') return
    const items = [...(popoverRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') {
      // Tab leaves the menu (back to the document), like other toolbar menus.
      event.preventDefault()
      close()
      return
    }
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className="tool-menu" ref={ref}>
      <button
        type="button"
        className={[trigger ? 'tool' : text ? 'tool-select tool-trigger' : 'tool tool-dropdown', active && 'is-active', className].filter(Boolean).join(' ')}
        title={label}
        aria-label={label}
        aria-haspopup={kind === 'menu' ? 'menu' : 'dialog'}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          fromKeyboard.current = event.detail === 0
          setOpen(value => !value)
        }}
      >
        {trigger ?? (
          <>
            {Icon && <Icon size={18} aria-hidden="true" />}
            {text && <span className="tool-trigger-label">{text}</span>}
            <ChevronDown size={13} aria-hidden="true" className="tool-chevron" />
          </>
        )}
      </button>
      {open && !disabled && (
        <div
          ref={popoverRef}
          className={['popover', kind === 'menu' ? 'menu-popover' : '', alignEnd ? 'align-end' : '', popoverClassName].filter(Boolean).join(' ')}
          role={kind}
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

type MenuItemProps = {
  label: string
  icon?: LucideIcon
  shortcut?: string
  /** Present for toggles (checkbox items). */
  checked?: boolean
  /** One choice out of several (alignment): a radio item. */
  radio?: boolean
  /** Opens a second panel: ArrowRight activates it too. */
  submenu?: boolean
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export function MenuItem({ label, icon: Icon, shortcut, checked, radio, submenu, disabled, danger, onSelect }: MenuItemProps) {
  return (
    <button
      aria-haspopup={submenu ? 'dialog' : undefined}
      onKeyDown={event => {
        if (submenu && event.key === 'ArrowRight') {
          event.preventDefault()
          onSelect()
        }
      }}
      type="button"
      role={checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={['menu-item', 'with-icon', danger && 'danger', checked && 'is-checked'].filter(Boolean).join(' ')}
      disabled={disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={onSelect}
    >
      <span className="menu-item-icon" aria-hidden="true">
        {Icon ? <Icon size={16} /> : checked ? <Check size={16} /> : null}
      </span>
      <span className="menu-item-label">{label}</span>
      {checked && Icon && <Check size={15} aria-hidden="true" className="menu-item-check" />}
      {shortcut && <span className="menu-item-shortcut">{shortcut}</span>}
    </button>
  )
}
