// Light, dark, or follow the system. Stored per device (the sign-in screen needs it before anyone is
// signed in). public/theme.js applies it before the first paint; this module changes it afterwards.
import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'margin:theme'
const listeners = new Set<() => void>()

function read(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

let choice: ThemeChoice = read()

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function applyTheme(): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark())
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171714' : '#f2f0eb')
}

export function setTheme(next: ThemeChoice): void {
  choice = next
  try {
    if (next === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, next)
  } catch {
    // Storage unavailable: the choice lasts until the page closes.
  }
  applyTheme()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return
    choice = read()
    applyTheme()
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

// Follow the system while set to "system" (theme.js does the same before the app loads).
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (choice === 'system') applyTheme()
})

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice)
}
