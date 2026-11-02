import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { serveStatic } from '@hono/node-server/serve-static'
import type { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { inspectDoc } from '../shared/doc.ts'
import { IMAGE_ID, isImageType, MAX_IMAGE_BYTES } from '../shared/imageRules.ts'
import { checkSchema } from '../shared/schema.ts'
import { isValidTag, MAX_TAGS, normalizeTag, normalizeTags } from '../shared/tags.ts'
import { MAX_TITLE_LENGTH } from '../shared/constants.ts'
import type { DocJSON } from '../shared/types.ts'
import {
  BusyError,
  createHashQueue,
  createLoginLimiter,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  normalizeIp,
  normalizeUsername,
  verifyPassword,
} from './auth.ts'
import type { HashQueue, LoginLimiter, SessionUser } from './auth.ts'
import { FontError, MAX_FAVORITES } from './fonts.ts'
import type { FontKind, FontService } from './fonts.ts'
import { guard, isImageUpload } from './guard.ts'
import type { HostRules } from './guard.ts'
import { sniffImageType } from './images.ts'
import type { ImageStore } from './images.ts'
import type { NoteChanges } from './notes.ts'
import { createServices } from './services.ts'
import type { Services } from './services.ts'
import { StyleError } from './styles.ts'

export const MAX_BODY_BYTES = 5 * 1024 * 1024
export const MAX_LOGIN_BODY_BYTES = 4 * 1024
/** Sent by the app on every signed-in request; a different signed-in user gets 409 instead. */
export const USER_HEADER = 'x-margin-user'

export type AppOptions = {
  db: DatabaseSync
  hosts: HostRules
  images: ImageStore
  fonts: FontService
  /** Folder with the built frontend. Static serving is skipped when missing. */
  staticDir?: string
  /** Cookies ignore ports, so the name includes Margin's public port. */
  cookieName?: string
  /** Adds Secure to the cookie (only for HTTPS setups; it would never be sent over plain HTTP). */
  secureCookies?: boolean
  limiter?: LoginLimiter
  hashQueue?: HashQueue
  /** The client's address; defaults to the socket's remote address. */
  clientIp?: (c: Context) => string
  /** The data stores; built from `db` when not given (index.ts shares them with its maintenance loop). */
  services?: Services
}

type Env = { Variables: { user: SessionUser } }

const idSchema = z.uuid()
const createSchema = z.strictObject({
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
})
const touchSchema = z.strictObject({
  ids: z.array(z.string().regex(IMAGE_ID)).max(500),
})
const loginSchema = z.strictObject({
  username: z.string().max(200),
  // Longer passwords can't exist; they get the same answer as a wrong one (checked below).
  password: z.string(),
})
const createStyleSchema = z.strictObject({
  id: z.string().max(64),
  name: z.string().max(400),
  props: z.unknown(),
})
const updateStyleSchema = z
  .strictObject({
    name: z.string().max(400).optional(),
    props: z.unknown().optional(),
    favorite: z.boolean().optional(),
  })
  .refine(body => body.name !== undefined || body.props !== undefined || body.favorite !== undefined, {
    message: 'provide name, props or favorite',
  })
const favoritesSchema = z.strictObject({
  families: z.array(z.string().max(100)).max(MAX_FAVORITES),
})
const updateSchema = z
  .strictObject({
    title: z.string().max(MAX_TITLE_LENGTH).optional(),
    // Checked by inspectDoc; z.unknown() keeps the whole document instead of stripping it.
    content: z.unknown().optional(),
    // Checked by normalizeTags (shared/tags.ts): replaces the note's tags; [] clears them.
    tags: z.array(z.unknown()).max(MAX_TAGS * 5).optional(),
  })
  .refine(body => body.title !== undefined || body.content !== undefined || body.tags !== undefined, {
    message: 'provide title, content or tags',
  })

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { ok: false, error: 'Request body must be valid JSON' }
  }
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  return { ok: false, error: `${where}${issue?.message ?? 'invalid body'}` }
}

// Paths like /notes/123 are app routes; paths like /logo.png are files.
function looksLikeFile(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  return lastSegment.includes('.')
}

// serveStatic returns the Response when it finds a file; its onFound hook runs too late to add headers.
function withCacheControl(value: string, handler: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const response = await handler(c, next)
    if (response instanceof Response) response.headers.set('Cache-Control', value)
    return response
  }
}

function fontErrorResponse(c: Context, error: unknown) {
  if (error instanceof FontError) return c.json({ error: error.message }, error.status)
  throw error
}

function socketIp(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return normalizeIp(incoming?.socket?.remoteAddress)
}

// Routes that work without a session. Everything else under /api requires one (fail closed).
const PUBLIC_ROUTES = new Set(['GET /health', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me'])

export function createApp(options: AppOptions): Hono {
  const { db, hosts, images, fonts, staticDir } = options
  const cookieName = options.cookieName ?? 'margin_session'
  const secure = options.secureCookies ?? false
  const limiter = options.limiter ?? createLoginLimiter()
  const hashQueue = options.hashQueue ?? createHashQueue()
  const clientIp = options.clientIp ?? socketIp
  const { notes, sessions, users, styles } = options.services ?? createServices(db)
  const app = new Hono()

  function writeCookie(c: Context, token: string, expiresAt: number): void {
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure,
      maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
    })
  }

  function clearCookie(c: Context): void {
    deleteCookie(c, cookieName, { path: '/', httpOnly: true, sameSite: 'Lax', secure })
  }

  app.use('*', guard(hosts, { allowHttpsOrigin: secure }))
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Tiptap injects a <style> tag and ProseMirror sets inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'same-origin',
      crossOriginEmbedderPolicy: false,
      // Plain HTTP on localhost: HSTS would only break other local servers if ever served over HTTPS.
      strictTransportSecurity: false,
    }),
  )

  const api = new Hono<Env>()

  // Responses from the API are private and current; images and fonts set their own policy.
  api.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store')
  })

  // Sessions. Public routes skip the check; every other route needs a valid session.
  api.use('*', async (c, next) => {
    const routeKey = `${c.req.method} ${c.req.path.replace(/^\/api/, '')}`
    const token = getCookie(c, cookieName) ?? ''
    const session = token ? sessions.lookup(token) : null
    if (session) {
      c.set('user', session.user)
      if (session.refreshed) writeCookie(c, token, session.expiresAt)
    }
    if (PUBLIC_ROUTES.has(routeKey)) return next()
    if (!session) {
      if (token) clearCookie(c)
      return c.json({ error: 'Sign in required' }, 401)
    }
    // A tab still showing another account (someone signed in as a different user in another tab)
    // must never act on this one.
    const expected = c.req.header(USER_HEADER)
    if (expected !== undefined && expected !== session.user.id) {
      return c.json({ error: 'You are signed in as someone else in another tab', code: 'user_mismatch' }, 409)
    }
    return next()
  })

  // Exactly one body limit applies to each request: images and sign-in get their own below. It runs
  // after the session check, because a body without Content-Length is read (up to the limit) here:
  // signed-out clients never get that far, and sign-in only ever reads 4 KB.
  const jsonBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: c => c.json({ error: 'Request body is too large (limit 5 MB)' }, 413),
  })
  api.use('*', (c, next) => {
    const isLogin = c.req.method === 'POST' && c.req.path === '/api/auth/login'
    return isImageUpload(c.req.method, c.req.path) || isLogin ? next() : jsonBodyLimit(c, next)
  })

  const userNotes = (c: Context<Env>) => notes.forUser(c.get('user').id)

  api.get('/health', c => c.json({ ok: true }))

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
      const previous = getCookie(c, cookieName)
      if (previous) sessions.revoke(previous)
      const created = sessions.create(fresh.id, c.req.header('user-agent'), fresh.password_changed_at)
      if (!created) return wrong()
      writeCookie(c, created.token, created.expiresAt)
      return c.json({ user: { id: fresh.id, username: fresh.username } })
    },
  )

  api.post('/auth/logout', c => {
    const token = getCookie(c, cookieName)
    // A stale tab must not sign out the account another tab signed in to since.
    const expected = c.req.header(USER_HEADER)
    const current = c.get('user')
    if (expected !== undefined && current && current.id !== expected) {
      return c.json({ error: 'You are signed in as someone else in another tab', code: 'user_mismatch' }, 409)
    }
    if (token) sessions.revoke(token)
    clearCookie(c)
    // Best effort (browsers only honor it on secure origins such as localhost): drop cached images.
    c.header('Clear-Site-Data', '"cache"')
    return c.body(null, 204)
  })

  api.get('/auth/me', c => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in required', setupNeeded: users.count() === 0 }, 401)
    return c.json({ user })
  })

  // ?q= matches title or text; each ?tag= must be on the note (the client takes #tags out of the search).
  api.get('/notes', c => {
    const tags = [...new Set((c.req.queries('tag') ?? []).map(normalizeTag))]
    if (tags.length > MAX_TAGS || !tags.every(isValidTag)) return c.json({ error: 'Invalid tag filter' }, 400)
    return c.json(userNotes(c).list(c.req.query('q') ?? '', tags))
  })

  api.get('/tags', c => c.json({ tags: userNotes(c).tagCounts() }))

  api.post('/notes', async c => {
    const body = await parseBody(c, createSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const note = userNotes(c).create(body.value.title)
    if (!note) return c.json({ error: 'Sign in required' }, 401)
    return c.json(note, 201)
  })

  api.get('/notes/:id', c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)
    const note = userNotes(c).get(id)
    if (!note) return c.json({ error: 'Note not found' }, 404)
    return c.json(note)
  })

  api.patch('/notes/:id', async c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)

    const body = await parseBody(c, updateSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)

    const changes: NoteChanges = { title: body.value.title }
    if (body.value.tags !== undefined) {
      const tags = normalizeTags(body.value.tags)
      if (!tags.ok) return c.json({ error: `tags: ${tags.error}` }, 400)
      changes.tags = tags.tags
    }
    if (body.value.content !== undefined) {
      // Store the cleaned copy: unsafe colors and links are stripped instead of failing the save.
      const inspected = inspectDoc(body.value.content)
      if (!inspected.ok) return c.json({ error: `content: ${inspected.error}` }, 400)
      const structure = checkSchema(inspected.doc)
      if (!structure.ok) return c.json({ error: `content: ${structure.error}` }, 400)
      changes.content = inspected.doc as DocJSON
      changes.text = inspected.text
    }

    const summary = userNotes(c).update(id, changes)
    if (!summary) return c.json({ error: 'Note not found' }, 404)
    return c.json(summary)
  })

  api.delete('/notes/:id', c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)
    if (!userNotes(c).delete(id)) return c.json({ error: 'Note not found' }, 404)
    return c.body(null, 204)
  })

  api.post(
    '/images',
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES,
      onError: c => c.json({ error: 'Images can be up to 10 MB' }, 413),
    }),
    async c => {
      const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!isImageType(type)) return c.json({ error: 'Images must be PNG, JPEG, GIF or WebP' }, 415)
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.byteLength === 0) return c.json({ error: 'The image is empty' }, 400)
      if (sniffImageType(bytes) !== type) {
        return c.json({ error: 'The file is not a valid PNG, JPEG, GIF or WebP image' }, 415)
      }
      return c.json(images.save(bytes, type, c.get('user').id), 201)
    },
  )

  api.post('/images/touch', async c => {
    const body = await parseBody(c, touchSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    images.touch(c.get('user').id, body.value.ids)
    return c.body(null, 204)
  })

  api.get('/images/:name', async c => {
    const name = c.req.param('name')
    // Ownership first: resolve() restores trashed files, which only the owner may cause.
    if (!images.canRead(c.get('user').id, name)) return c.json({ error: 'Image not found' }, 404)
    // Revalidated on every view (a cheap 304), so the ownership check always runs.
    const etag = `"${name.split('.')[0]}"`
    const cacheHeaders = { 'Cache-Control': 'private, no-cache', ETag: etag }
    if (c.req.header('if-none-match') === etag) {
      images.resolve(name)
      return c.body(null, 304, cacheHeaders)
    }
    const found = images.resolve(name)
    if (!found) return c.json({ error: 'Image not found' }, 404)
    // A sweep may move the file to the trash while it's being read; resolving again restores it.
    const bytes =
      (await readFile(found.path).catch(() => null)) ??
      (await (async () => {
        const again = images.resolve(name)
        return again ? readFile(again.path).catch(() => null) : null
      })())
    if (!bytes) return c.json({ error: 'Image not found' }, 404)
    return c.body(bytes, 200, { 'Content-Type': found.type, ...cacheHeaders })
  })

  const stylesheetRoute = (kind: FontKind) => async (c: Context) => {
    const family = c.req.query('family') ?? ''
    try {
      const css = await fonts.stylesheet(family, kind)
      return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' })
    } catch (error) {
      return fontErrorResponse(c, error)
    }
  }
  api.get('/fonts/css', stylesheetRoute('full'))
  api.get('/fonts/preview', stylesheetRoute('preview'))

  api.get('/fonts/file/:slug/:file', async c => {
    try {
      const found = await fonts.fontFile(c.req.param('slug'), c.req.param('file'))
      const bytes = await readFile(found.path).catch(() => null)
      if (!bytes) return c.json({ error: 'Unknown font file' }, 404)
      return c.body(bytes, 200, { 'Content-Type': found.type, 'Cache-Control': 'public, max-age=31536000, immutable' })
    } catch (error) {
      return fontErrorResponse(c, error)
    }
  })

  api.get('/fonts/favorites', c => c.json({ families: fonts.getFavorites(c.get('user').id) }))

  api.put('/fonts/favorites', async c => {
    const body = await parseBody(c, favoritesSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    try {
      return c.json({ families: fonts.setFavorites(c.get('user').id, body.value.families) })
    } catch (error) {
      return fontErrorResponse(c, error)
    }
  })

  const styleErrorResponse = (c: Context, error: unknown) => {
    if (error instanceof StyleError) return c.json({ error: error.message, code: error.code }, error.status)
    throw error
  }

  api.get('/styles', c => c.json({ styles: styles.list(c.get('user').id) }))

  api.post('/styles', async c => {
    const body = await parseBody(c, createStyleSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    try {
      const result = styles.create(c.get('user').id, body.value)
      if (!result) return c.json({ error: 'Sign in required' }, 401)
      return c.json(result.style, result.created ? 201 : 200)
    } catch (error) {
      return styleErrorResponse(c, error)
    }
  })

  api.patch('/styles/:id', async c => {
    const body = await parseBody(c, updateStyleSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    try {
      return c.json(styles.update(c.get('user').id, c.req.param('id'), body.value))
    } catch (error) {
      return styleErrorResponse(c, error)
    }
  })

  api.delete('/styles/:id', c => {
    try {
      styles.delete(c.get('user').id, c.req.param('id'))
      return c.body(null, 204)
    } catch (error) {
      return styleErrorResponse(c, error)
    }
  })

  app.route('/api', api)
  // Unknown API paths get JSON, never the HTML app shell.
  app.all('/api', c => c.json({ error: 'Not found' }, 404))
  app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

  if (staticDir && existsSync(staticDir)) {
    // Vite fingerprints everything under /assets, so it can be cached forever.
    app.use('/assets/*', withCacheControl('public, max-age=31536000, immutable', serveStatic({ root: staticDir })))
    app.use('*', withCacheControl('no-cache', serveStatic({ root: staticDir })))

    // SPA fallback: app routes get index.html; missing files get a real 404.
    const serveIndex = withCacheControl('no-cache', serveStatic({ root: staticDir, path: 'index.html' }))
    app.get('*', async (c, next) => {
      if (looksLikeFile(c.req.path)) return next()
      return serveIndex(c, next)
    })
  }

  app.notFound(c => c.text('Not found', 404))
  app.onError((error, c) => {
    console.error(error)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}
