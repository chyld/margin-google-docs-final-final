// Accounts: creating, renaming, deleting, and moving one account's data to another.
// Used by the margin-user command (server/cli.ts) and by login.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db.ts'
import { MAX_STYLE_NAME, styleNameKey } from '../shared/styleProps.ts'

export type UserRow = {
  id: string
  username: string
  password_hash: string
  created_at: number
  password_changed_at: number
}

export class UserError extends Error {
  /** 'usage' | 'not-found' | 'conflict' */
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

export function createUserStore(db: DatabaseSync, now: () => number = Date.now) {
  const sql = {
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insert: db.prepare(
      'INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)',
    ),
    list: db.prepare(`
      SELECT u.id, u.username, u.created_at,
        (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS notes,
        (SELECT COUNT(*) FROM image_owners o WHERE o.user_id = u.id) AS images,
        (SELECT COUNT(*) FROM styles st WHERE st.user_id = u.id AND st.deleted_at IS NULL) AS styles,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > :now
           AND s.created_at >= u.password_changed_at) AS sessions,
        (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
      FROM users u ORDER BY u.username`),
    sessions: db.prepare(
      `SELECT s.created_at, s.last_seen_at, s.expires_at, s.user_agent FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? AND s.expires_at > ? AND s.created_at >= u.password_changed_at ORDER BY s.last_seen_at DESC`,
    ),
    // Conditional, so a password changed while a login was checking the old one is never overwritten.
    setHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?'),
    rename: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
    deleteSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    countNotes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?'),
    countImages: db.prepare('SELECT COUNT(*) AS n FROM image_owners WHERE user_id = ?'),
    getFavorites: db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'fontFavorites'"),
    putFavorites: db.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'fontFavorites', ?)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
    ),
    moveNotes: db.prepare('UPDATE notes SET user_id = ? WHERE user_id = ?'),
    moveNoteTags: db.prepare('UPDATE note_tags SET user_id = ? WHERE user_id = ?'),
    copyImageOwners: db.prepare(
      `INSERT OR IGNORE INTO image_owners (image_id, user_id, created_at)
       SELECT image_id, ?, created_at FROM image_owners WHERE user_id = ?`,
    ),
    // Other settings: the target's own value wins. Favorites are merged separately.
    moveSettings: db.prepare(
      `INSERT INTO user_settings (user_id, key, value) SELECT ?, key, value FROM user_settings
       WHERE user_id = ? AND key <> 'fontFavorites'
       ON CONFLICT (user_id, key) DO NOTHING`,
    ),
    deleteNotes: db.prepare('DELETE FROM notes WHERE user_id = ?'),
    deleteNoteTags: db.prepare('DELETE FROM note_tags WHERE user_id = ?'),
    deleteImageOwners: db.prepare('DELETE FROM image_owners WHERE user_id = ?'),
    deleteSettings: db.prepare('DELETE FROM user_settings WHERE user_id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    countStyles: db.prepare('SELECT COUNT(*) AS n FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    deleteStyles: db.prepare('DELETE FROM styles WHERE user_id = ?'),
    stylesOf: db.prepare('SELECT id, name, favorite_slot, deleted_at FROM styles WHERE user_id = ? ORDER BY favorite_slot, created_at'),
    liveNameKeys: db.prepare('SELECT name_key FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    maxSlot: db.prepare('SELECT MAX(favorite_slot) AS n FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    moveStyle: db.prepare(
      'UPDATE styles SET user_id = :to, name = :name, name_key = :nameKey, favorite_slot = :slot WHERE user_id = :from AND id = :id',
    ),
    dropStyle: db.prepare('DELETE FROM styles WHERE user_id = ? AND id = ?'),
    styleExists: db.prepare('SELECT 1 FROM styles WHERE user_id = ? AND id = ?'),
  }

  function find(username: string): UserRow | null {
    return (sql.byName.get(username) as UserRow | undefined) ?? null
  }

  function require(username: string): UserRow {
    const user = find(username)
    if (!user) throw new UserError('not-found', `There is no user named "${username}"`)
    return user
  }

  function parseList(value: string | undefined): string[] {
    if (value === undefined) return []
    try {
      const list = JSON.parse(value) as unknown
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  /** Adds favorites to a user's list (their own first, then new ones, no duplicates). Inside a transaction. */
  function mergeFavorites(userId: string, extra: string[]): void {
    if (extra.length === 0) return
    const own = parseList((sql.getFavorites.get(userId) as { value: string } | undefined)?.value)
    sql.putFavorites.run(userId, JSON.stringify([...new Set([...own, ...extra])]))
  }

  function favoritesOf(userId: string): string[] {
    return parseList((sql.getFavorites.get(userId) as { value: string } | undefined)?.value)
  }

  /**
   * Moves every style from one user to another, keeping ids (so styled text stays linked). Name
   * clashes get " (2)", " (3)"…; favorites go after the target's own. Inside a transaction.
   */
  function moveStyles(fromId: string, toId: string): number {
    const taken = new Set((sql.liveNameKeys.all(toId) as Array<{ name_key: string }>).map(row => row.name_key))
    let slot = Number((sql.maxSlot.get(toId) as { n: number | null }).n ?? 0)
    const rows = sql.stylesOf.all(fromId) as Array<{ id: string; name: string; favorite_slot: number | null; deleted_at: number | null }>
    let moved = 0
    for (const row of rows) {
      // The same id already at the target (e.g. moved there before): keep the target's copy.
      if (sql.styleExists.get(toId, row.id)) {
        sql.dropStyle.run(fromId, row.id)
        continue
      }
      let name = row.name
      if (row.deleted_at === null) {
        for (let n = 2; taken.has(styleNameKey(name)); n += 1) {
          const suffix = ` (${n})`
          name = [...row.name].slice(0, MAX_STYLE_NAME - suffix.length).join('').trimEnd() + suffix
        }
        taken.add(styleNameKey(name))
      }
      const newSlot = row.deleted_at === null && row.favorite_slot !== null ? ++slot : null
      sql.moveStyle.run({ from: fromId, to: toId, id: row.id, name, nameKey: styleNameKey(name), slot: newSlot })
      if (row.deleted_at === null) moved += 1
    }
    return moved
  }

  return {
    find,
    require,
    byId(id: string): UserRow | null {
      return (sql.byId.get(id) as UserRow | undefined) ?? null
    },
    count(): number {
      return Number((sql.count.get() as { n: number }).n)
    },

    create(username: string, passwordHash: string): UserRow {
      return transaction(db, () => {
        if (find(username)) throw new UserError('conflict', `A user named "${username}" already exists`)
        const time = now()
        const id = randomUUID()
        sql.insert.run(id, username, passwordHash, time, time)
        return sql.byId.get(id) as UserRow
      })
    },

    /** Moves everything one user owns to another (e.g. the first account got the wrong name). */
    reassign(from: string, to: string): { notes: number; images: number; styles: number } {
      return transaction(db, () => {
        const source = require(from)
        const target = require(to)
        if (source.id === target.id) throw new UserError('usage', 'Pick two different users')
        const notes = Number(sql.moveNotes.run(target.id, source.id).changes)
        sql.moveNoteTags.run(target.id, source.id)
        const images = Number(sql.copyImageOwners.run(target.id, source.id).changes)
        sql.deleteImageOwners.run(source.id)
        mergeFavorites(target.id, favoritesOf(source.id))
        sql.moveSettings.run(target.id, source.id)
        sql.deleteSettings.run(source.id)
        const styles = moveStyles(source.id, target.id)
        return { notes, images, styles }
      })
    },

    /** Re-hashes after a login with old parameters, unless the password changed meanwhile. */
    upgradeHash(id: string, oldHash: string, newHash: string): void {
      sql.setHash.run(newHash, id, oldHash)
    },

    /** Sets a new password and signs the user out everywhere. */
    setPassword(username: string, passwordHash: string): void {
      transaction(db, () => {
        const user = require(username)
        // +1 so a session created in this same millisecond is also invalid.
        sql.setPassword.run(passwordHash, Math.max(now(), user.password_changed_at + 1), user.id)
        sql.deleteSessions.run(user.id)
      })
    },

    rename(from: string, to: string): void {
      transaction(db, () => {
        const user = require(from)
        const existing = find(to)
        if (existing && existing.id !== user.id) throw new UserError('conflict', `A user named "${to}" already exists`)
        sql.rename.run(to, user.id)
      })
    },

    logout(username: string): number {
      return transaction(db, () => Number(sql.deleteSessions.run(require(username).id).changes))
    },

    owned(username: string): { notes: number; images: number; favorites: number; styles: number } {
      const user = require(username)
      return {
        notes: Number((sql.countNotes.get(user.id) as { n: number }).n),
        images: Number((sql.countImages.get(user.id) as { n: number }).n),
        favorites: favoritesOf(user.id).length,
        styles: Number((sql.countStyles.get(user.id) as { n: number }).n),
      }
    },

    /**
     * Deletes a user. Refuses when they own notes or images unless the caller chose to transfer
     * them (`transferTo`) or to purge them.
     */
    delete(username: string, options: { transferTo?: string; purge?: boolean } = {}): { notes: number; images: number; styles: number } {
      return transaction(db, () => {
        const user = require(username)
        let notes = Number((sql.countNotes.get(user.id) as { n: number }).n)
        let images = Number((sql.countImages.get(user.id) as { n: number }).n)
        const favorites = favoritesOf(user.id).length
        const styles = Number((sql.countStyles.get(user.id) as { n: number }).n)
        let movedStyles = styles
        if (options.transferTo !== undefined) {
          const target = require(options.transferTo)
          if (target.id === user.id) throw new UserError('usage', 'Pick a different user to transfer to')
          notes = Number(sql.moveNotes.run(target.id, user.id).changes)
          sql.moveNoteTags.run(target.id, user.id)
          images = Number(sql.copyImageOwners.run(target.id, user.id).changes)
          mergeFavorites(target.id, favoritesOf(user.id))
          sql.moveSettings.run(target.id, user.id)
          movedStyles = moveStyles(user.id, target.id)
        } else if (notes + images + favorites + styles > 0 && !options.purge) {
          throw new UserError(
            'conflict',
            `"${username}" owns ${notes} note(s), ${images} image(s), ${styles} style(s) and ${favorites} favorite font(s). ` +
              'Use --transfer-to <user> or --purge',
          )
        }
        sql.deleteNoteTags.run(user.id)
        sql.deleteNotes.run(user.id)
        sql.deleteImageOwners.run(user.id)
        sql.deleteSettings.run(user.id)
        sql.deleteStyles.run(user.id)
        sql.deleteSessions.run(user.id)
        sql.deleteUser.run(user.id)
        return { notes, images, styles: movedStyles }
      })
    },

    list(): Array<{ username: string; createdAt: number; notes: number; images: number; styles: number; sessions: number; lastSeen: number | null }> {
      return (sql.list.all({ now: now() }) as Array<Record<string, number | string | null>>).map(row => ({
        username: row.username as string,
        createdAt: Number(row.created_at),
        notes: Number(row.notes),
        images: Number(row.images),
        styles: Number(row.styles),
        sessions: Number(row.sessions),
        lastSeen: row.last_seen === null ? null : Number(row.last_seen),
      }))
    },

    sessions(username: string): Array<{ createdAt: number; lastSeen: number; expiresAt: number; userAgent: string }> {
      const user = require(username)
      return (sql.sessions.all(user.id, now()) as Array<Record<string, number | string>>).map(row => ({
        createdAt: Number(row.created_at),
        lastSeen: Number(row.last_seen_at),
        expiresAt: Number(row.expires_at),
        userAgent: String(row.user_agent),
      }))
    },
  }
}

export type UserStore = ReturnType<typeof createUserStore>
