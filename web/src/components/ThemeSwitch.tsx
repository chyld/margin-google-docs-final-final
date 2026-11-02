import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { setTheme, useTheme } from '../theme.ts'
import type { ThemeChoice } from '../theme.ts'

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

/** System / Light / Dark as a segmented control (radio buttons for screen readers). */
export function ThemeSwitch({ compact = false, autoFocus = false }: { compact?: boolean; autoFocus?: boolean }) {
  const theme = useTheme()
  const groupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [autoFocus])

  // One Tab stop; arrow keys move between the options (the ARIA radio group pattern).
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    const index = OPTIONS.findIndex(option => option.value === theme)
    let next: number | null = step === undefined ? null : (index + step + OPTIONS.length) % OPTIONS.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = OPTIONS.length - 1
    if (next === null) return
    event.preventDefault()
    setTheme((OPTIONS[next] as (typeof OPTIONS)[number]).value)
    requestAnimationFrame(() => groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }

  return (
    <div
      ref={groupRef}
      className={compact ? 'theme-switch is-compact' : 'theme-switch'}
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={handleKeyDown}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          tabIndex={theme === value ? 0 : -1}
          aria-label={compact ? `${label} theme` : undefined}
          title={compact ? `${label} theme` : undefined}
          className={theme === value ? 'theme-option is-active' : 'theme-option'}
          onClick={() => setTheme(value)}
        >
          <Icon size={15} aria-hidden="true" />
          {!compact && <span>{label}</span>}
        </button>
      ))}
    </div>
  )
}
