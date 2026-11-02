// Passwords, sessions and login throttling.
//
// Sessions live only in the database (no cache), so `margin-user passwd/logout/delete` takes effect
// on the very next request. The cookie holds a random token; the database stores only its SHA-256.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// ---- passwords ----

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 1024

type ScryptParams = { N: number; r: number; p: number }
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r (32 MiB at the defaults).
    scryptCallback(
      password.normalize('NFC'),
      salt,
      KEY_LENGTH,
      { ...params, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

/** "scrypt$N$r$p$salt$hash", with base64 salt and hash. */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scrypt(password, salt, params)
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$')
}

type ParsedHash = { params: ScryptParams; salt: Buffer; key: Buffer }

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number]
  if (![N, r, p].every(value => Number.isSafeInteger(value) && value > 0)) return null
  return { params: { N, r, p }, salt: Buffer.from(parts[4] as string, 'base64'), key: Buffer.from(parts[5] as string, 'base64') }
}

// Verifying against this keeps a login for an unknown username as slow as a wrong password.
let dummyHash: Promise<string> | null = null
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}

export type VerifyResult = { ok: boolean; needsRehash: boolean }

/** Checks a password against a stored hash; pass null for an unknown user (runs a dummy check). */
export async function verifyPassword(password: string, stored: string | null): Promise<VerifyResult> {
  const parsed = parseHash(stored ?? (await getDummyHash()))
  if (!parsed) return { ok: false, needsRehash: false }
  const key = await scrypt(password, parsed.salt, parsed.params)
  const ok = stored !== null && key.length === parsed.key.length && timingSafeEqual(key, parsed.key)
  const { N, r, p } = parsed.params
  const needsRehash = ok && (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p)
  return { ok, needsRehash }
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`
  if (password.length > MAX_PASSWORD_LENGTH) return `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters`
  return null
}

// ---- usernames ----

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** Trims and lowercases; returns null when the result isn't a valid username. */
export function normalizeUsername(value: string): string | null {
  const username = value.trim().toLowerCase()
  return USERNAME_PATTERN.test(username) ? username : null
}

// ---- sessions ----

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
export const SESSION_IDLE_MS = 30 * DAY
export const SESSION_ABSOLUTE_MS = 180 * DAY
const REFRESH_EVERY_MS = HOUR

export type SessionUser = { id: string; username: string }
export type Session = { id: string; user: SessionUser; expiresAt: number }

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Strips control characters (terminal escapes) and limits the length. */
export function cleanUserAgent(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200)
}

type SessionRow = {
  id: string
  user_id: string
  username: string
  created_at: number
  last_seen_at: number
  expires_at: number
}

export function createSessionStore(db: DatabaseSync, now: () => number = Date.now) {
  const sql = {
    // One statement, so it's atomic: no password change can land between the check and the insert.
    insert: db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
       SELECT :id, :userId, :now, :now, :expires, :userAgent WHERE EXISTS (
         SELECT 1 FROM users WHERE id = :userId AND (:changedAt IS NULL OR password_changed_at = :changedAt)
       )`,
    ),
    // A session from before the latest password change is never valid.
    lookup: db.prepare(
      `SELECT s.id, s.user_id, u.username, s.created_at, s.last_seen_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.created_at >= u.password_changed_at`,
    ),
    refresh: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
    removeExpired: db.prepare(
      `DELETE FROM sessions WHERE expires_at <= ?
         OR created_at < (SELECT password_changed_at FROM users WHERE users.id = sessions.user_id)
         OR NOT EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id)`,
    ),
  }

  function expiryFor(createdAt: number, time: number): number {
    return Math.min(time + SESSION_IDLE_MS, createdAt + SESSION_ABSOLUTE_MS)
  }

  return {
    /**
     * Creates a session and returns the cookie token, or null if the user no longer exists or (with
     * `passwordChangedAt`) their password changed since it was checked.
     */
    create(userId: string, userAgent?: string, passwordChangedAt?: number): { token: string; expiresAt: number } | null {
      const token = randomBytes(32).toString('base64url')
      const time = now()
      const expiresAt = expiryFor(time, time)
      const result = sql.insert.run({
        id: hashToken(token),
        userId,
        now: time,
        expires: expiresAt,
        userAgent: cleanUserAgent(userAgent),
        changedAt: passwordChangedAt ?? null,
      })
      return result.changes > 0 ? { token, expiresAt } : null
    },

    /**
     * The session for a cookie token, or null. `refreshed` is set when the expiry moved, so the
     * caller re-sends the cookie. Writes happen at most once an hour per session.
     */
    lookup(token: string): (Session & { refreshed: boolean }) | null {
      if (!token || token.length > 100) return null
      const id = hashToken(token)
      const row = sql.lookup.get(id) as SessionRow | undefined
      if (!row) return null
      const time = now()
      if (row.expires_at <= time) {
        try {
          sql.remove.run(id)
        } catch {
          // Cleanup also happens on the timer.
        }
        return null
      }
      let expiresAt = row.expires_at
      let refreshed = false
      if (time - row.last_seen_at >= REFRESH_EVERY_MS) {
        expiresAt = expiryFor(row.created_at, time)
        try {
          sql.refresh.run(time, expiresAt, id)
          refreshed = true
        } catch (error) {
          // A busy database (e.g. margin-user writing) must not fail an otherwise valid request.
          console.warn('Could not refresh a session', error)
          expiresAt = row.expires_at
        }
      }
      return { id, user: { id: row.user_id, username: row.username }, expiresAt, refreshed }
    },

    /** Deletes the session for a cookie token, if any. */
    revoke(token: string): void {
      if (token) sql.remove.run(hashToken(token))
    },

    removeExpired(): number {
      return Number(sql.removeExpired.run(now()).changes)
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>

// ---- login throttling ----

const WINDOW_MS = 15 * 60 * 1000
export const LIMITS = {
  perIpUser: 10,
  perIp: 30,
  /** Failures for one username across all addresses before logins for it get slowed down. */
  userSlowAfter: 20,
  userMaxDelayMs: 2000,
  maxKeys: 10_000,
}

type Counter = { count: number; resetAt: number }

/**
 * One key per client: strips the IPv4-mapped IPv6 prefix, and groups IPv6 addresses by their /64
 * (a single device can pick any address in its /64).
 */
export function normalizeIp(address: string | undefined): string {
  const value = (address ?? 'unknown').toLowerCase().split('%')[0] as string
  if (value.startsWith('::ffff:') && value.includes('.')) return value.slice(7)
  if (!value.includes(':')) return value
  const [head = '', tail = ''] = value.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = value.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  if (groups.length !== 8) return value
  return `${groups.slice(0, 4).map(group => (Number.parseInt(group, 16) || 0).toString(16)).join(':')}::/64`
}

/**
 * Counts login attempts. An attempt is reserved before the password is checked (so a burst of
 * parallel requests can't slip past the limit) and released when it succeeds.
 *
 * Hard limits apply per (address, username) and per address. Failures for one username across all
 * addresses only add a delay: a hostile device on the network can slow the owner down but never
 * lock them out.
 */
export function createLoginLimiter(now: () => number = Date.now) {
  const maps = { ipUser: new Map<string, Counter>(), ip: new Map<string, Counter>(), user: new Map<string, Counter>() }
  // Per-username queue for slowed-down logins, so parallel guesses wait one after another.
  const slowLanes = new Map<string, Promise<void>>()
  // Expired counters go away on their own, so a flood of junk names never pushes out live ones.
  const pruneTimer = setInterval(() => prune(), 60_000)
  pruneTimer.unref?.()

  function current(map: Map<string, Counter>, key: string): number {
    const entry = map.get(key)
    if (!entry || entry.resetAt <= now()) return 0
    return entry.count
  }

  function retryAfter(map: Map<string, Counter>, key: string): number {
    const entry = map.get(key)
    return entry ? Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)) : 1
  }

  function bump(map: Map<string, Counter>, key: string, delta: number): void {
    const time = now()
    let entry = map.get(key)
    if (!entry || entry.resetAt <= time) {
      if (delta < 0) return
      if (map.size >= LIMITS.maxKeys) prune()
      // Still full of live entries: drop the oldest rather than grow without bound.
      if (map.size >= LIMITS.maxKeys) map.delete(map.keys().next().value as string)
      entry = { count: 0, resetAt: time + WINDOW_MS }
      map.set(key, entry)
    }
    entry.count = Math.max(0, entry.count + delta)
  }

  function prune(): void {
    const time = now()
    for (const map of Object.values(maps)) {
      for (const [key, entry] of map) if (entry.resetAt <= time) map.delete(key)
    }
  }

  const ipUserKey = (ip: string, username: string) => `${ip}\u0000${username}`

  return {
    /** Seconds to wait when the attempt is over a hard limit, or 0 when it may proceed. */
    blocked(ip: string, username: string): number {
      const pair = ipUserKey(ip, username)
      if (current(maps.ipUser, pair) >= LIMITS.perIpUser) return retryAfter(maps.ipUser, pair)
      if (current(maps.ip, ip) >= LIMITS.perIp) return retryAfter(maps.ip, ip)
      return 0
    },

    /** Extra delay (ms) for a username that is failing a lot from many places. */
    delayFor(username: string): number {
      const failures = current(maps.user, username) - LIMITS.userSlowAfter
      if (failures <= 0) return 0
      return Math.min(LIMITS.userMaxDelayMs, failures * 100)
    },

    /**
     * Waits out the slowdown for a username under attack. Waits are chained per username, so N
     * parallel attempts take N delays, not one: guessing speed really drops.
     */
    async slowDown(username: string): Promise<void> {
      const delay = this.delayFor(username)
      if (delay <= 0) return
      const previous = slowLanes.get(username) ?? Promise.resolve()
      const mine = previous.then(() => new Promise<void>(resolve => setTimeout(resolve, delay)))
      slowLanes.set(username, mine)
      await mine
      if (slowLanes.get(username) === mine) slowLanes.delete(username)
    },

    /** Counts the attempt as a failure up front; call `succeeded` to take it back. */
    reserve(ip: string, username: string): void {
      bump(maps.ipUser, ipUserKey(ip, username), 1)
      bump(maps.ip, ip, 1)
      bump(maps.user, username, 1)
    },

    /** Takes back one reserved attempt that never ran (e.g. the server was too busy). */
    release(ip: string, username: string): void {
      bump(maps.ipUser, ipUserKey(ip, username), -1)
      bump(maps.ip, ip, -1)
      bump(maps.user, username, -1)
    },

    succeeded(ip: string, username: string): void {
      maps.ipUser.delete(ipUserKey(ip, username))
      bump(maps.ip, ip, -1)
      bump(maps.user, username, -1)
    },

    prune,
    size: () => maps.ipUser.size + maps.ip.size + maps.user.size,
    stop: () => clearInterval(pruneTimer),
  }
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>

// ---- hashing queue ----

export class BusyError extends Error {}

/**
 * Runs at most `concurrency` password checks at once (scrypt uses libuv's 4-thread pool, which file
 * reads share). Extra work waits in a short queue with a deadline; beyond that it fails with BusyError.
 */
export function createHashQueue({ concurrency = 2, maxQueued = 20, maxWaitMs = 10_000 } = {}) {
  let running = 0
  const waiting: Array<{ start: () => void; timer: ReturnType<typeof setTimeout> }> = []

  function next(): void {
    const item = waiting.shift()
    if (!item) return
    clearTimeout(item.timer)
    item.start()
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const execute = async (): Promise<T> => {
        running += 1
        try {
          return await task()
        } finally {
          running -= 1
          next()
        }
      }
      if (running < concurrency) return execute()
      if (waiting.length >= maxQueued) return Promise.reject(new BusyError('Too many sign-ins at once'))
      return new Promise<T>((resolve, reject) => {
        const item = {
          start: () => void execute().then(resolve, reject),
          timer: setTimeout(() => {
            const index = waiting.indexOf(item)
            if (index >= 0) waiting.splice(index, 1)
            reject(new BusyError('Sign-in is busy'))
          }, maxWaitMs),
        }
        waiting.push(item)
      })
    },
    get running() {
      return running
    },
    get queued() {
      return waiting.length
    },
  }
}

export type HashQueue = ReturnType<typeof createHashQueue>
