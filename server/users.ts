// Accounts: creating, renaming, deleting, and moving one account's data to another.
// Used by the margin-user command (server/cli.ts) and by login.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db.ts'
import { imageOwnership } from './images.ts'
import { noteOwnership } from './notes.ts'
import { createSettingsStore } from './settings.ts'
import { styleOwnership } from './styles.ts'

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
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  }

  function find(username: string): UserRow | null {
    return (sql.byName.get(username) as UserRow | undefined) ?? null
  }

  function require(username: string): UserRow {
    const user = find(username)
    if (!user) throw new UserError('not-found', `There is no user named "${username}"`)
    return user
  }

  // What an account owns lives in other tables; each module moves and deletes its own rows, all
  // inside the one transaction of the account operation.
  const notes = noteOwnership(db)
  const images = imageOwnership(db)
  const styles = styleOwnership(db)
  const settings = createSettingsStore(db)

  /** Moves everything one account owns to another. Inside a transaction. */
  function transferOwnedData(fromId: string, toId: string): { notes: number; images: number; styles: number } {
    const movedNotes = notes.transferOwned(fromId, toId)
    const movedImages = images.transferOwned(fromId, toId)
    settings.transferOwned(fromId, toId)
    const movedStyles = styles.transferOwned(fromId, toId)
    return { notes: movedNotes, images: movedImages, styles: movedStyles }
  }

  /** Deletes everything an account owns (images themselves stay for the sweep). Inside a transaction. */
  function deleteOwnedData(userId: string): void {
    notes.deleteOwned(userId)
    images.deleteOwned(userId)
    settings.deleteOwned(userId)
    styles.deleteOwned(userId)
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
        return transferOwnedData(source.id, target.id)
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
        notes: notes.countOwned(user.id),
        images: images.countOwned(user.id),
        favorites: settings.favoritesOf(user.id).length,
        styles: styles.countOwned(user.id),
      }
    },

    /**
     * Deletes a user. Refuses when they own notes or images unless the caller chose to transfer
     * them (`transferTo`) or to purge them.
     */
    delete(username: string, options: { transferTo?: string; purge?: boolean } = {}): { notes: number; images: number; styles: number } {
      return transaction(db, () => {
        const user = require(username)
        let result = {
          notes: notes.countOwned(user.id),
          images: images.countOwned(user.id),
          styles: styles.countOwned(user.id),
        }
        const favorites = settings.favoritesOf(user.id).length
        if (options.transferTo !== undefined) {
          const target = require(options.transferTo)
          if (target.id === user.id) throw new UserError('usage', 'Pick a different user to transfer to')
          result = transferOwnedData(user.id, target.id)
        } else if (result.notes + result.images + favorites + result.styles > 0 && !options.purge) {
          throw new UserError(
            'conflict',
            `"${username}" owns ${result.notes} note(s), ${result.images} image(s), ${result.styles} style(s) and ${favorites} favorite font(s). ` +
              'Use --transfer-to <user> or --purge',
          )
        }
        deleteOwnedData(user.id)
        sql.deleteSessions.run(user.id)
        sql.deleteUser.run(user.id)
        return result
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
