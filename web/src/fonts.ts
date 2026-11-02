// Loads Google Fonts through Margin's server cache, and keeps the favorites list.
import { BUNDLED_FONTS, firstFontFamily } from '../../shared/fonts.ts'
import type { FontCatalogEntry } from '../../shared/fonts.ts'
import { api, ApiError } from './api.ts'
import { showNotice } from './notices.ts'
import { onReauthenticated } from './session.ts'
import { styleById } from './namedStyles.ts'

// ---- catalog (a separate chunk, fetched on first use) ----

let catalogPromise: Promise<FontCatalogEntry[]> | null = null
let catalogByFamily = new Map<string, FontCatalogEntry>()

export function loadCatalog(): Promise<FontCatalogEntry[]> {
  catalogPromise ??= import('../../shared/font-catalog.json').then(
    module => {
      const list = module.default as FontCatalogEntry[]
      catalogByFamily = new Map(list.map(entry => [entry.f, entry]))
      return list
    },
    (error: unknown) => {
      // Let the next attempt (e.g. reopening the picker) try again.
      catalogPromise = null
      throw error
    },
  )
  return catalogPromise
}

export function catalogEntry(family: string): FontCatalogEntry | undefined {
  return catalogByFamily.get(family)
}

// ---- loading faces ----

type Load = { state: 'loading' | 'ready'; promise: Promise<void> } | { state: 'failed'; at: number }
const RETRY_FONT_AFTER_MS = 60_000
// Previews often fail only because the server is busy (fast scrolling); retry them soon.
const RETRY_PREVIEW_AFTER_MS = 5_000
const fullLoads = new Map<string, Load>()
const previewLoads = new Map<string, Load>()

function addStylesheet(href: string): Promise<HTMLLinkElement> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve(link)
    link.onerror = () => {
      link.remove()
      reject(new Error(`Couldn't load ${href}`))
    }
    document.head.append(link)
  })
}

function load(
  loads: Map<string, Load>,
  key: string,
  href: string,
  face: string,
  sample: string,
  retryAfter: number,
  force: boolean,
  onFail?: () => void,
): Promise<void> {
  const existing = loads.get(key)
  if (existing && existing.state !== 'failed') return existing.promise
  // After a failure, wait before trying again unless the user explicitly asks for the font.
  if (existing && !force && Date.now() - existing.at < retryAfter) return Promise.resolve()

  let link: HTMLLinkElement | null = null
  const promise = addStylesheet(href)
    .then(added => {
      link = added
      // A stylesheet can load while its font files fail. Loading a face for some sample text makes
      // the browser fetch the file; this rejects only if the download fails. (No matching face for
      // the sample is not an error: the subset may simply not cover it.)
      return document.fonts.load(`1em "${face}"`, sample)
    })
    .then(() => {
      loads.set(key, { state: 'ready', promise })
    })
    .catch(() => {
      link?.remove()
      loads.set(key, { state: 'failed', at: Date.now() })
      onFail?.()
    })
  loads.set(key, { state: 'loading', promise })
  return promise
}

/** Forgets failed loads (e.g. they failed only because the session had ended) so they retry now. */
export function forgetFailedFonts(): void {
  for (const loads of [fullLoads, previewLoads]) {
    for (const [key, entry] of loads) if (entry.state === 'failed') loads.delete(key)
  }
}

/** Loads a catalog family for use in documents. `force` retries a recent failure (user action). */
export function ensureFont(family: string, { force = false, quiet = false } = {}): Promise<void> {
  if (BUNDLED_FONTS.has(family)) return Promise.resolve()
  return load(fullLoads, family, `/api/fonts/css?family=${encodeURIComponent(family)}`, family, 'Aa', RETRY_FONT_AFTER_MS, force, () => {
    if (!quiet) showNotice(`Couldn't load the font "${family}", so it shows in a fallback font for now.`)
  })
}

/** Loads a catalog font for a style preview: quietly, and only for families in the catalog. */
export function ensureStyleFont(fontFamily: string | undefined): void {
  const family = firstFontFamily(fontFamily)
  if (!family) return
  void loadCatalog()
    .then(() => {
      if (catalogEntry(family)) void ensureFont(family, { quiet: true })
    })
    .catch(() => undefined)
}

/** Loads the tiny preview face ("<Family> Preview") that only draws the family's own name. */
export function ensurePreview(family: string): void {
  if (BUNDLED_FONTS.has(family)) return
  // The preview subset only covers the letters of the family's name, so test with exactly that.
  void load(previewLoads, family, `/api/fonts/preview?family=${encodeURIComponent(family)}`, `${family} Preview`, family, RETRY_PREVIEW_AFTER_MS, false)
}

/** The first family of every font used in a document (Tiptap JSON). */
export function fontsInDoc(doc: unknown): Set<string> {
  const families = new Set<string>()
  const visit = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { marks, content } = node as { marks?: unknown; content?: unknown }
    if (Array.isArray(marks)) {
      for (const mark of marks as Array<{ type?: string; attrs?: { fontFamily?: unknown } }>) {
        if (mark.type !== 'textStyle') continue
        const family = firstFontFamily(mark.attrs?.fontFamily)
        if (family) families.add(family)
      }
    }
    if (Array.isArray(content)) for (const child of content) visit(child)
  }
  visit(doc)
  return families
}

/** Ids of saved styles a document uses (text tags and paragraph links). */
export function styleIdsInDoc(doc: unknown): Set<string> {
  const ids = new Set<string>()
  const visit = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { marks, content, attrs } = node as { marks?: unknown; content?: unknown; attrs?: { styleId?: unknown } }
    if (typeof attrs?.styleId === 'string') ids.add(attrs.styleId)
    if (Array.isArray(marks)) {
      for (const mark of marks as Array<{ type?: string; attrs?: { id?: unknown } }>) {
        if (mark.type === 'namedStyle' && typeof mark.attrs?.id === 'string') ids.add(mark.attrs.id)
      }
    }
    if (Array.isArray(content)) for (const child of content) visit(child)
  }
  visit(doc)
  return ids
}

/** Loads every catalog font a document uses. Unknown families render with system fonts. */
export async function loadDocumentFonts(doc: unknown): Promise<void> {
  const families = fontsInDoc(doc)
  // Fonts that come from saved styles (their look is in the generated stylesheet, not the doc).
  for (const id of styleIdsInDoc(doc)) {
    const family = firstFontFamily(styleById(id)?.props.fontFamily)
    if (family) families.add(family)
  }
  if (families.size === 0) return
  await loadCatalog()
  for (const family of families) if (catalogEntry(family)) void ensureFont(family)
}

// ---- favorites (stored on the server, so they follow you between browsers) ----

let favorites: string[] = []
let favoritesLoaded = false
// Bumped by every local toggle, so a refresh that raced one doesn't undo it.
let favoritesRevision = 0
let loading: Promise<void> | null = null
const favoriteListeners = new Set<() => void>()
let writes: Promise<unknown> = Promise.resolve()

function setFavoritesLocal(next: string[]) {
  favorites = next
  for (const listener of favoriteListeners) listener()
}

function loadFavorites(): Promise<void> {
  loading ??= api.getFontFavorites().then(
    result => {
      favoritesLoaded = true
      setFavoritesLocal(result.families)
    },
    (error: unknown) => {
      loading = null
      throw error
    },
  )
  return loading
}

export function getFavorites(): string[] {
  return favorites
}

export function subscribeFavorites(listener: () => void): () => void {
  favoriteListeners.add(listener)
  void loadFavorites().catch(() => undefined)
  return () => favoriteListeners.delete(listener)
}

/** Re-reads favorites from the server (another tab may have changed them). */
export function refreshFavorites(): void {
  if (!favoritesLoaded) return
  const revision = favoritesRevision
  writes = writes
    .then(() => api.getFontFavorites())
    .then(result => {
      if (revision === favoritesRevision) setFavoritesLocal(result.families)
    })
    .catch(() => undefined)
}

let favoritesWaitingForSignIn = false

onReauthenticated(() => {
  if (!favoritesWaitingForSignIn) return
  favoritesWaitingForSignIn = false
  const revision = favoritesRevision
  writes = writes
    .then(() => api.setFontFavorites(favorites))
    .then(result => {
      if (revision === favoritesRevision) setFavoritesLocal(result.families)
    })
    .catch(() => showNotice("Couldn't save your favorite fonts."))
})

export function toggleFavorite(family: string): void {
  let applied = false
  const apply = () => {
    applied = true
    favoritesRevision += 1
    setFavoritesLocal(favorites.includes(family) ? favorites.filter(item => item !== family) : [...favorites, family])
  }
  // Optimistic when the saved list is known. Otherwise wait for it: toggling an empty local list
  // and saving it would wipe the favorites stored on the server.
  if (favoritesLoaded) apply()
  writes = writes
    .then(async () => {
      // Each toggle is applied exactly once: now if the list is known, else after it loads.
      if (!applied) {
        await loadFavorites()
        apply()
      }
      // One write at a time, each sending the whole current list, so the last write carries every toggle.
      const revision = favoritesRevision
      const result = await api.setFontFavorites(favorites)
      if (revision === favoritesRevision) setFavoritesLocal(result.families)
    })
    .catch(async (error: unknown) => {
      // Signed out meanwhile: keep the toggle and send it once the same user signs in again.
      if (error instanceof ApiError && error.isAuthFailure) {
        favoritesWaitingForSignIn = true
        return
      }
      showNotice("Couldn't save your favorite fonts.")
      // Show what the server has, unless newer toggles are queued: their write sends the whole
      // local list, which retries this change too.
      const revision = favoritesRevision
      const result = await api.getFontFavorites()
      if (revision === favoritesRevision) setFavoritesLocal(result.families)
    })
    .catch(() => undefined)
}
