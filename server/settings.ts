// Per-user settings (the user_settings table). Today the only one is the font favorites list.
// The font service decides which families exist; this module stores the list.
import type { DatabaseSync } from 'node:sqlite'

export const MAX_FAVORITES = 200

export type FavoritesWrite = { ok: true; families: string[] } | { ok: false; error: string }

/** A stored JSON list: its strings, or nothing when it's missing or unreadable. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return []
  try {
    const list = JSON.parse(value) as unknown
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function createSettingsStore(db: DatabaseSync) {
  const sql = {
    getFavorites: db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'fontFavorites'"),
    // Writes nothing for a user who no longer exists (a request racing their deletion).
    putFavorites: db.prepare(
      `INSERT INTO user_settings (user_id, key, value) SELECT id, 'fontFavorites', ? FROM users WHERE id = ?
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
    ),
    // Other settings move too; the target's own value wins. (Favorites are merged instead.)
    moveOthers: db.prepare(
      `INSERT INTO user_settings (user_id, key, value) SELECT ?, key, value FROM user_settings
       WHERE user_id = ? AND key <> 'fontFavorites'
       ON CONFLICT (user_id, key) DO NOTHING`,
    ),
    deleteAll: db.prepare('DELETE FROM user_settings WHERE user_id = ?'),
  }

  /** The stored list as it is (unknown families included: they may come back to the catalog). */
  function favoritesOf(userId: string): string[] {
    return parseList((sql.getFavorites.get(userId) as { value: string } | undefined)?.value)
  }

  return {
    favoritesOf,

    /** The favorites to show: the stored list, without families the catalog doesn't have. */
    readFavorites(userId: string, isKnown: (family: string) => boolean): string[] {
      return favoritesOf(userId).filter(isKnown)
    },

    /** Replaces the list (the API): no duplicates, known families only, at most MAX_FAVORITES. */
    writeFavorites(userId: string, list: readonly string[], isKnown: (family: string) => boolean): FavoritesWrite {
      const unique = [...new Set(list)]
      const unknown = unique.find(family => !isKnown(family))
      if (unknown !== undefined) return { ok: false, error: `Unknown font family "${unknown}"` }
      if (unique.length > MAX_FAVORITES) return { ok: false, error: `At most ${MAX_FAVORITES} favorites` }
      sql.putFavorites.run(JSON.stringify(unique), userId)
      return { ok: true, families: unique }
    },

    /**
     * Moves one account's settings to another (inside the caller's transaction): favorites are merged
     * (the target's first, then new ones, no duplicates), other settings move where the target has
     * none, and the source's rows go.
     */
    transferOwned(fromId: string, toId: string): void {
      const extra = favoritesOf(fromId)
      if (extra.length > 0) sql.putFavorites.run(JSON.stringify([...new Set([...favoritesOf(toId), ...extra])]), toId)
      sql.moveOthers.run(toId, fromId)
      sql.deleteAll.run(fromId)
    },

    /** Deletes an account's settings (inside the caller's transaction). */
    deleteOwned(userId: string): void {
      sql.deleteAll.run(userId)
    },
  }
}

export type SettingsStore = ReturnType<typeof createSettingsStore>
