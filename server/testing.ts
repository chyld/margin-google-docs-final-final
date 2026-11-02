// Test helpers: accounts and sessions without running scrypt (which is slow by design).
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createSessionStore } from './auth.ts'

export const TEST_COOKIE = 'margin_session'

/** Inserts a user with an unusable password hash. Returns its id. */
export function insertUser(db: DatabaseSync, username: string, passwordHash = 'scrypt$1$1$1$AA==$AA=='): string {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, 0, 0)').run(
    id,
    username,
    passwordHash,
  )
  return id
}

/** Creates a user and a session; returns the user id and a Cookie header value. */
export function signedInUser(db: DatabaseSync, username = 'alice'): { id: string; cookie: string } {
  const id = insertUser(db, username)
  const session = createSessionStore(db).create(id, 'vitest')
  if (!session) throw new Error('could not create a session')
  return { id, cookie: `${TEST_COOKIE}=${session.token}` }
}
