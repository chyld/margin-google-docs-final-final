// /api/auth: signing in (rate-limited, one scrypt at a time), signing out, and who is signed in.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { BusyError, hashPassword, MAX_PASSWORD_LENGTH, normalizeUsername, verifyPassword } from '../auth.ts'
import type { HashQueue, LoginLimiter, SessionStore } from '../auth.ts'
import { parseBody } from '../http.ts'
import type { Env } from '../http.ts'
import type { UserStore } from '../users.ts'

export const MAX_LOGIN_BODY_BYTES = 4 * 1024
/** Sent by the app on every signed-in request; a different signed-in user gets 409 instead. */
export const USER_HEADER = 'x-margin-user'

const loginSchema = z.strictObject({
  username: z.string().max(200),
  // Longer passwords can't exist; they get the same answer as a wrong one (checked below).
  password: z.string(),
})

export type SessionCookie = {
  name: string
  write: (c: Context, token: string, expiresAt: number) => void
  clear: (c: Context) => void
}

type AuthDeps = {
  users: UserStore
  sessions: SessionStore
  limiter: LoginLimiter
  hashQueue: HashQueue
  clientIp: (c: Context) => string
  cookie: SessionCookie
}

export function registerAuthRoutes(api: Hono<Env>, { users, sessions, limiter, hashQueue, clientIp, cookie }: AuthDeps): void {
  api.post(
    '/auth/login',
    bodyLimit({ maxSize: MAX_LOGIN_BODY_BYTES, onError: c => c.json({ error: 'Request body is too large' }, 413) }),
    async c => {
      const body = await parseBody(c, loginSchema)
      if (!body.ok) return c.json({ error: body.error }, 400)
      const wrong = () => c.json({ error: 'Wrong username or password' }, 401)
      const username = normalizeUsername(body.value.username)
      const password = body.value.password
      if (!username || !password || password.length > MAX_PASSWORD_LENGTH) return wrong()

      const ip = clientIp(c)
      const wait = limiter.blocked(ip, username)
      if (wait > 0) {
        c.header('Retry-After', String(wait))
        return c.json({ error: 'Too many attempts', retryAfter: wait }, 429)
      }
      // Counted before checking, so parallel attempts can't slip past the limit.
      limiter.reserve(ip, username)
      await limiter.slowDown(username)

      let user: ReturnType<typeof users.find>
      let result: Awaited<ReturnType<typeof verifyPassword>>
      try {
        ;({ user, result } = await hashQueue.run(async () => {
          const found = users.find(username)
          return { user: found, result: await verifyPassword(password, found?.password_hash ?? null) }
        }))
      } catch (error) {
        if (!(error instanceof BusyError)) throw error
        limiter.release(ip, username) // not the user's fault: give back just this attempt
        c.header('Retry-After', '5')
        return c.json({ error: 'Margin is busy. Try again in a few seconds.', retryAfter: 5 }, 503)
      }
      if (!user || !result.ok) return wrong()

      // The password may have changed (or the user been deleted) while scrypt ran. Compared by
      // change time, not hash: a background re-hash of this same password is not a change.
      const fresh = users.byId(user.id)
      if (!fresh || fresh.password_changed_at !== user.password_changed_at) return wrong()
      limiter.succeeded(ip, username)

      if (result.needsRehash) {
        const oldHash = user.password_hash
        void hashQueue
          .run(() => hashPassword(password))
          .then(newHash => users.upgradeHash(fresh.id, oldHash, newHash))
          .catch(() => undefined)
      }

      // Replaces only this browser's session; other devices stay signed in.
      const previous = getCookie(c, cookie.name)
      if (previous) sessions.revoke(previous)
      const created = sessions.create(fresh.id, c.req.header('user-agent'), fresh.password_changed_at)
      if (!created) return wrong()
      cookie.write(c, created.token, created.expiresAt)
      return c.json({ user: { id: fresh.id, username: fresh.username } })
    },
  )

  api.post('/auth/logout', c => {
    const token = getCookie(c, cookie.name)
    // A stale tab must not sign out the account another tab signed in to since.
    const expected = c.req.header(USER_HEADER)
    const current = c.get('user')
    if (expected !== undefined && current && current.id !== expected) {
      return c.json({ error: 'You are signed in as someone else in another tab', code: 'user_mismatch' }, 409)
    }
    if (token) sessions.revoke(token)
    cookie.clear(c)
    // Best effort (browsers only honor it on secure origins such as localhost): drop cached images.
    c.header('Clear-Site-Data', '"cache"')
    return c.body(null, 204)
  })

  api.get('/auth/me', c => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in required', setupNeeded: users.count() === 0 }, 401)
    return c.json({ user })
  })
}
