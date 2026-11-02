// The signed-in user's saved styles: the list, and the stylesheet that gives styled text its look.
// Changes reach documents only through that stylesheet (notes are never rewritten), and only after
// the server confirms them.
import { useSyncExternalStore } from 'react'
import { stylesheetFor } from '../../../shared/styleProps.ts'
import type { NamedStyle, StyleProps } from '../../../shared/styleProps.ts'
import { api, ApiError } from '../api.ts'
import { onReauthenticated } from './session.ts'

type Snapshot = { styles: NamedStyle[]; loaded: boolean; failed: boolean }

let snapshot: Snapshot = { styles: [], loaded: false, failed: false }
let loading: Promise<void> | null = null
// Bumped by every confirmed change. A list fetched before a change is older than what we show, so
// it is dropped (and fetched again) instead of reverting the change.
let mutations = 0
const listeners = new Set<() => void>()

function setFailed(failed: boolean): void {
  if (snapshot.failed === failed) return
  snapshot = { ...snapshot, failed }
  for (const listener of listeners) listener()
}

function publish(styles: NamedStyle[]): void {
  snapshot = { styles, loaded: true, failed: false }
  writeStylesheet(styles)
  for (const listener of listeners) listener()
}

function writeStylesheet(styles: NamedStyle[]): void {
  if (typeof document === 'undefined') return
  let element = document.getElementById('margin-named-styles') as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = 'margin-named-styles'
    document.head.append(element)
  }
  // Deleted styles keep their rules, so text that uses them keeps its look.
  element.textContent = stylesheetFor(styles)
}

/** Loads (or reloads) the list from the server. Failures leave the current list untouched. */
export function loadStyles(): Promise<void> {
  if (loading) return loading
  const startedAt = mutations
  const request: Promise<void> = api
    .listStyles()
    .then(
      result => {
        if (startedAt === mutations) publish(result.styles)
      },
      (error: unknown) => {
        setFailed(true)
        throw error
      },
    )
    .finally(() => {
      if (loading === request) loading = null
    })
    // Fetched before a confirmed change: it's stale, so fetch again rather than revert the change.
    .then(() => (startedAt === mutations ? undefined : loadStyles()))
  loading = request
  return request
}

/** Tests only: install a style list as if it had been loaded. */
export function setStylesForTesting(styles: NamedStyle[]): void {
  publish(styles)
}

export function subscribeStyles(listener: () => void): () => void {
  listeners.add(listener)
  if (!snapshot.loaded) void loadStyles().catch(() => undefined)
  return () => listeners.delete(listener)
}

export function getStylesSnapshot(): Snapshot {
  return snapshot
}

export function useNamedStyles(): Snapshot {
  return useSyncExternalStore(subscribeStyles, getStylesSnapshot)
}

export function styleById(id: string | null | undefined): NamedStyle | undefined {
  return id ? snapshot.styles.find(style => style.id === id) : undefined
}

/** Live (not deleted) styles: favorites by slot first, then the rest alphabetically. */
export function sortedLiveStyles(styles: NamedStyle[]): { favorites: NamedStyle[]; others: NamedStyle[] } {
  const live = styles.filter(style => !style.deleted)
  const byName = (a: NamedStyle, b: NamedStyle) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return {
    favorites: live.filter(style => style.favoriteSlot !== null).sort((a, b) => (a.favoriteSlot ?? 0) - (b.favoriteSlot ?? 0)),
    others: live.filter(style => style.favoriteSlot === null).sort(byName),
  }
}

export function favoriteInSlot(slot: number): NamedStyle | undefined {
  return snapshot.styles.find(style => !style.deleted && style.favoriteSlot === slot)
}

function replace(style: NamedStyle): void {
  mutations += 1
  const others = snapshot.styles.filter(item => item.id !== style.id)
  publish([...others, style])
}

/** A random v4 uuid. crypto.randomUUID needs a secure context, which a LAN address isn't. */
export function newStyleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `id` is chosen once per save form, so retrying after a lost response finds the same style. */
export async function createStyle(name: string, props: StyleProps, id: string = newStyleId()): Promise<NamedStyle> {
  const style = await api.createStyle({ id, name, props })
  replace(style)
  return style
}

// Changes to one style run one at a time, so their responses can't arrive out of order (a late
// favorite response must not bring back a style deleted after it).
const styleQueues = new Map<string, Promise<unknown>>()
function inOrder<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = styleQueues.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  styleQueues.set(id, next)
  void next.finally(() => {
    if (styleQueues.get(id) === next) styleQueues.delete(id)
  }).catch(() => undefined)
  return next
}

export function updateStyle(id: string, patch: { name?: string; props?: StyleProps; favorite?: boolean }): Promise<NamedStyle> {
  return inOrder(id, async () => {
    const style = await api.updateStyle(id, patch)
    replace(style)
    return style
  })
}

export function deleteStyle(id: string): Promise<void> {
  return inOrder(id, async () => {
    await api.deleteStyle(id)
    const style = styleById(id)
    if (style) replace({ ...style, deleted: true, favoriteSlot: null })
  })
}

/** A friendly message for a failed style request. */
export function styleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return "Couldn't reach Margin. Try again."
}

// Another tab may have changed the styles; signing in again may have missed changes.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    if (snapshot.loaded || snapshot.failed) void loadStyles().catch(() => undefined)
  })
  onReauthenticated(() => void loadStyles().catch(() => undefined))
}
