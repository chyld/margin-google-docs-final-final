// The Format sidebar's open state (Phase 8). Docked on wide windows (the choice is remembered per
// device); an overlay on medium windows and a bottom sheet on phones, both opened only on request
// and reset whenever the window crosses into another mode.
import { useSyncExternalStore } from 'react'

export type PanelMode = 'docked' | 'overlay' | 'sheet'

const KEY = 'margin:format-panel'
const DOCKED = '(min-width: 1200px)'
const PHONE = '(max-width: 760px)'
/** First use (nothing stored): open when the window is at least this wide. */
const OPEN_BY_DEFAULT = '(min-width: 1280px)'

type Snapshot = {
  mode: PanelMode
  open: boolean
  /** Bumped to ask the toolbar's Styles menu to open. */
  stylesRequest: number
}

const listeners = new Set<() => void>()
let transientOpen = false
/** The docked choice when this browser can't store it (private mode, storage blocked). */
let memoryDocked: boolean | null = null
let stylesRequest = 0
let snapshot: Snapshot | null = null
let watching = false

function media(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false
}

function readStored(): boolean | null {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'open' ? true : value === 'closed' ? false : null
  } catch {
    return null
  }
}

function currentMode(): PanelMode {
  if (media(PHONE)) return 'sheet'
  return media(DOCKED) ? 'docked' : 'overlay'
}

function compute(): Snapshot {
  const mode = currentMode()
  // A choice that couldn't be written wins over whatever storage still says.
  const open = mode === 'docked' ? (memoryDocked ?? readStored() ?? media(OPEN_BY_DEFAULT)) : transientOpen
  return { mode, open, stylesRequest }
}

function emit(): void {
  const next = compute()
  if (snapshot && next.mode !== snapshot.mode) {
    // Crossing into another mode: overlays and sheets start closed again.
    transientOpen = false
    next.open = next.mode === 'docked' ? next.open : false
  }
  if (!snapshot || next.mode !== snapshot.mode || next.open !== snapshot.open || next.stylesRequest !== snapshot.stylesRequest) {
    snapshot = next
    for (const listener of listeners) listener()
  }
}

// Another tab changed the remembered choice.
function onStorage(event: StorageEvent): void {
  if (event.key === KEY) emit()
}
let unwatch: (() => void) | null = null

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  const queries = [DOCKED, PHONE, OPEN_BY_DEFAULT].map(query => window.matchMedia?.(query)).filter(Boolean) as MediaQueryList[]
  for (const query of queries) query.addEventListener?.('change', emit)
  window.addEventListener('storage', onStorage)
  unwatch = () => {
    for (const query of queries) query.removeEventListener?.('change', emit)
    window.removeEventListener('storage', onStorage)
  }
}

export function subscribeFormatPanel(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFormatPanel(): Snapshot {
  snapshot ??= compute()
  return snapshot
}

export function useFormatPanel(): Snapshot {
  return useSyncExternalStore(subscribeFormatPanel, getFormatPanel)
}

export function setFormatPanelOpen(open: boolean): void {
  const { mode } = getFormatPanel()
  if (mode === 'docked') {
    try {
      window.localStorage.setItem(KEY, open ? 'open' : 'closed')
      memoryDocked = null
    } catch {
      // Not remembered on this device; still works now.
      memoryDocked = open
    }
  } else {
    transientOpen = open
  }
  emit()
}

export function toggleFormatPanel(): void {
  setFormatPanelOpen(!getFormatPanel().open)
}

/** Asks the toolbar's Styles menu to open (from the panel's style name). */
export function requestStylesMenu(): void {
  stylesRequest += 1
  emit()
}

/** For tests: forget the cached state. */
export function resetFormatPanelForTesting(): void {
  unwatch?.()
  unwatch = null
  listeners.clear()
  watching = false
  transientOpen = false
  memoryDocked = null
  stylesRequest = 0
  snapshot = null
}
