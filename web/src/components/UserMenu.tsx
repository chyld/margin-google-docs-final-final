import { useId, useRef, useState } from 'react'
import { ChevronUp, LogOut } from 'lucide-react'
import type { User } from '../api.ts'
import { candyFor } from '../candy.ts'
import { ThemeSwitch } from './ThemeSwitch.tsx'
import { firstGrapheme } from '../format.ts'
import { useDismiss } from './ToolbarParts.tsx'

type UserMenuProps = {
  user: User
  signingOut: boolean
  onSignOut: () => void
  /** The slim sidebar rail: just the avatar, and the menu opens to the right. */
  compact?: boolean
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className={`avatar candy-${candyFor(name)}`} style={{ width: size, height: size }} aria-hidden="true">
      {firstGrapheme(name)}
    </span>
  )
}

/** The account chip at the bottom of the sidebar: theme and sign out. */
export function UserMenu({ user, signingOut, onSignOut, compact = false }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const ref = useDismiss(open, reason => {
    setOpen(false)
    if (reason === 'escape') buttonRef.current?.focus()
  })

  return (
    <div className={compact ? 'user-menu is-compact' : 'user-menu'} ref={ref}>
      {open && (
        <div className="user-popover" id={menuId} role="group" aria-label="Account">
          <div className="user-popover-head">
            <Avatar name={user.username} size={36} />
            <div>
              <div className="user-popover-name">{user.username}</div>
              <div className="user-popover-hint">Signed in</div>
            </div>
          </div>
          <div className="user-popover-section">
            <span className="user-popover-label">Theme</span>
            <ThemeSwitch autoFocus />
          </div>
          <button type="button" className="menu-item sign-out" onClick={onSignOut} disabled={signingOut}>
            <LogOut size={16} aria-hidden="true" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="user-chip"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={compact ? `Account: ${user.username}` : undefined}
        title={compact ? user.username : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <Avatar name={user.username} />
        {!compact && <span className="user-chip-name">{user.username}</span>}
        {!compact && <ChevronUp size={16} aria-hidden="true" className={open ? 'chevron is-open' : 'chevron'} />}
      </button>
    </div>
  )
}
