// The user's favorite fonts: stored on the server, so they follow you between browsers. Toggles are
// optimistic, written one at a time, and kept (then sent) across a sign-in.
import { api, ApiError } from '../api.ts'
import { showNotice } from './notices.ts'
import { onReauthenticated } from './session.ts'

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
