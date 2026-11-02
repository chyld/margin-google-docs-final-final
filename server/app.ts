// The HTTP app: security middleware, sessions and body limits in one place (their order matters),
// the routes (server/routes/), the built frontend, and errors. index.ts runs it; tests build it with
// fakes.
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import type { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { createHashQueue, createLoginLimiter, normalizeIp } from './auth.ts'
import type { HashQueue, LoginLimiter } from './auth.ts'
import type { FontService } from './fonts.ts'
import { guard, isImageUpload } from './guard.ts'
import type { HostRules } from './guard.ts'
import { HttpError } from './http.ts'
import type { Env } from './http.ts'
import type { ImageStore } from './images.ts'
import { registerAuthRoutes, USER_HEADER } from './routes/auth.ts'
import type { SessionCookie } from './routes/auth.ts'
import { registerFontRoutes } from './routes/fonts.ts'
import { registerImageRoutes } from './routes/images.ts'
import { registerNoteRoutes } from './routes/notes.ts'
import { registerStyleRoutes } from './routes/styles.ts'
import { createServices } from './services.ts'
import type { Services } from './services.ts'

export { MAX_LOGIN_BODY_BYTES, USER_HEADER } from './routes/auth.ts'
export const MAX_BODY_BYTES = 5 * 1024 * 1024

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

function socketIp(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return normalizeIp(incoming?.socket?.remoteAddress)
}

// Routes that work without a session. Everything else under /api requires one (fail closed).
const PUBLIC_ROUTES = new Set(['GET /health', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me'])

export function createApp(options: AppOptions): Hono {
  const { db, hosts, images, fonts, staticDir } = options
  const secure = options.secureCookies ?? false
  const limiter = options.limiter ?? createLoginLimiter()
  const hashQueue = options.hashQueue ?? createHashQueue()
  const clientIp = options.clientIp ?? socketIp
  const { notes, sessions, users, styles, settings } = options.services ?? createServices(db)
  const app = new Hono()

  const cookie: SessionCookie = {
    name: options.cookieName ?? 'margin_session',
    write(c, token, expiresAt) {
      setCookie(c, cookie.name, token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure,
        maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      })
    },
    clear(c) {
      deleteCookie(c, cookie.name, { path: '/', httpOnly: true, sameSite: 'Lax', secure })
    },
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
    const token = getCookie(c, cookie.name) ?? ''
    const session = token ? sessions.lookup(token) : null
    if (session) {
      c.set('user', session.user)
      if (session.refreshed) cookie.write(c, token, session.expiresAt)
    }
    if (PUBLIC_ROUTES.has(routeKey)) return next()
    if (!session) {
      if (token) cookie.clear(c)
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

  api.get('/health', c => c.json({ ok: true }))
  registerAuthRoutes(api, { users, sessions, limiter, hashQueue, clientIp, cookie })
  registerNoteRoutes(api, { notes })
  registerImageRoutes(api, { images })
  registerFontRoutes(api, { fonts, settings })
  registerStyleRoutes(api, { styles })

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
    // Expected failures (a font Google doesn't have, a style name that's taken) answer as themselves.
    if (error instanceof HttpError) {
      return c.json(error.code === undefined ? { error: error.message } : { error: error.message, code: error.code }, error.status)
    }
    console.error(error)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}
