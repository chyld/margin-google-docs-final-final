import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, MAX_LOGIN_BODY_BYTES } from './app.ts'
import {
  BusyError,
  cleanUserAgent,
  createHashQueue,
  createLoginLimiter,
  createSessionStore,
  hashPassword,
  LIMITS,
  normalizeIp,
  normalizeUsername,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  verifyPassword,
} from './auth.ts'
import { dataPaths, openDatabase, prepareDataDir, SCHEMA_VERSION } from './db.ts'
import { createFontService } from './fonts.ts'
import { hostChecker } from './guard.ts'
import { createImageStore } from './images.ts'
import { insertUser, signedInUser, TEST_COOKIE } from './testing.ts'
import { createUserStore } from './users.ts'
import { createSettingsStore } from './settings.ts'

const HOST = 'localhost:5555'
// Cheap parameters keep the tests fast; production uses SCRYPT_PARAMS.
const FAST = { N: 1024, r: 8, p: 1 }

let dataDir: string
let db: DatabaseSync
let app: Hono
let ip: string

function build() {
  const paths = dataPaths(dataDir)
  const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash })
  const fonts = createFontService({ dir: paths.fonts,
    catalog: [{ f: 'Lora', k: 'Serif', w: [400], i: [] }],
    fetchImpl: async () => {
      throw new Error('offline')
    },
    prefetchLatin: false,
  })
  app = createApp({ db, hosts: { ports: ['5555'] }, images, fonts, clientIp: () => ip })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'margin-auth-'))
  prepareDataDir(dataDir)
  db = openDatabase(':memory:')
  ip = '192.168.1.20'
  build()
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

type Options = { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: RequestInit['body'] }

function request(method: string, path: string, options: Options = {}) {
  const headers: Record<string, string> = { host: HOST, ...options.headers }
  if (options.cookie) headers.cookie = options.cookie
  let body: RequestInit['body'] = options.raw
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] ??= 'application/json'
  }
  return app.request(`http://${HOST}${path}`, { method, headers, body })
}

async function addUser(username: string, password: string): Promise<string> {
  return insertUser(db, username, await hashPassword(password, FAST))
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] as string
}

const login = (username: string, password: string, cookie?: string) =>
  request('POST', '/api/auth/login', { body: { username, password }, cookie })

describe('passwords', () => {
  it('hashes with a salt and verifies', async () => {
    const one = await hashPassword('correct horse', FAST)
    const two = await hashPassword('correct horse', FAST)
    expect(one).not.toBe(two)
    expect(one).toMatch(/^scrypt\$1024\$8\$1\$/)
    expect(await verifyPassword('correct horse', one)).toEqual({ ok: true, needsRehash: true })
    expect((await verifyPassword('wrong horse', one)).ok).toBe(false)
  })

  it('normalizes Unicode so the same password typed differently still matches', async () => {
    const hash = await hashPassword('café-password', FAST)
    expect((await verifyPassword('café-password', hash)).ok).toBe(true)
  })

  it('runs a real check for unknown users and rejects them', async () => {
    expect(await verifyPassword('anything at all', null)).toEqual({ ok: false, needsRehash: false })
  })

  it('normalizes usernames', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice')
    expect(normalizeUsername('a')).toBe('a')
    expect(normalizeUsername('bad name')).toBeNull()
    expect(normalizeUsername('-dash')).toBeNull()
    expect(normalizeUsername('x'.repeat(33))).toBeNull()
  })

  it('cleans user agents and addresses', () => {
    expect(cleanUserAgent('Mozilla\u001b]0;evil\u0007\r\n/5.0')).toBe('Mozilla]0;evil/5.0')
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5')
    // A device can use any address in its IPv6 /64, so they count as one.
    expect(normalizeIp('2001:db8:1:2:aaaa::1')).toBe(normalizeIp('2001:db8:1:2:bbbb:cccc:dddd:eeee'))
    expect(normalizeIp('2001:db8:1:2::1')).not.toBe(normalizeIp('2001:db8:1:3::1'))
    expect(normalizeIp('fe80::1%eth0')).toBe(normalizeIp('fe80::2'))
  })
})

describe('sessions', () => {
  it('slides, caps at the absolute limit, and expires', () => {
    let clock = 1_000_000
    const userId = insertUser(db, 'alice')
    const store = createSessionStore(db, () => clock)
    const created = store.create(userId, 'ua')
    expect(created).not.toBeNull()
    const token = created?.token as string
    expect(store.lookup(token)?.user.username).toBe('alice')

    // Within the hour: no write. After it: refreshed.
    clock += 30 * 60 * 1000
    expect(store.lookup(token)?.refreshed).toBe(false)
    clock += 31 * 60 * 1000
    const refreshed = store.lookup(token)
    expect(refreshed?.refreshed).toBe(true)
    expect(refreshed?.expiresAt).toBe(clock + SESSION_IDLE_MS)

    // Keep using it: it never outlives the absolute cap.
    for (let day = 0; day < 200; day += 1) {
      clock += 24 * 60 * 60 * 1000
      const session = store.lookup(token)
      if (!session) break
      expect(session.expiresAt).toBeLessThanOrEqual(1_000_000 + SESSION_ABSOLUTE_MS)
    }
    expect(store.lookup(token)).toBeNull()
  })

  it('expires after the idle period', () => {
    let clock = 0
    const store = createSessionStore(db, () => clock)
    const token = store.create(insertUser(db, 'bob'))?.token as string
    clock += SESSION_IDLE_MS + 1
    expect(store.lookup(token)).toBeNull()
  })

  it('stores only a hash of the token', () => {
    const token = createSessionStore(db).create(insertUser(db, 'carol'))?.token as string
    const ids = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    expect(ids[0]?.id).toMatch(/^[0-9a-f]{64}$/)
    expect(ids[0]?.id).not.toContain(token)
  })

  it('rejects sessions older than the latest password change', () => {
    const store = createSessionStore(db)
    const id = insertUser(db, 'dave')
    const token = store.create(id)?.token as string
    db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(Date.now() + 1000, id)
    expect(store.lookup(token)).toBeNull()
  })

  it('creates nothing for a deleted user', () => {
    expect(createSessionStore(db).create('no-such-user')).toBeNull()
  })
})

describe('login limiter', () => {
  it('blocks per address and username, and per address', () => {
    let clock = 0
    const limiter = createLoginLimiter(() => clock)
    for (let index = 0; index < LIMITS.perIpUser; index += 1) limiter.reserve('1.1.1.1', 'alice')
    expect(limiter.blocked('1.1.1.1', 'alice')).toBeGreaterThan(0)
    // Another device can still try.
    expect(limiter.blocked('2.2.2.2', 'alice')).toBe(0)
    for (let index = 0; index < LIMITS.perIp; index += 1) limiter.reserve('3.3.3.3', `user${index}`)
    expect(limiter.blocked('3.3.3.3', 'someone-new')).toBeGreaterThan(0)
    clock += 15 * 60 * 1000
    expect(limiter.blocked('1.1.1.1', 'alice')).toBe(0)
  })

  it('only slows down a username attacked from many addresses, never blocks it', () => {
    const limiter = createLoginLimiter()
    for (let index = 0; index < 200; index += 1) limiter.reserve(`10.0.${index >> 8}.${index & 255}`, 'owner')
    expect(limiter.blocked('192.168.1.2', 'owner')).toBe(0)
    expect(limiter.delayFor('owner')).toBe(LIMITS.userMaxDelayMs)
  })

  it('gives back only the one attempt when the server was too busy', () => {
    const limiter = createLoginLimiter()
    for (let index = 0; index < LIMITS.perIpUser; index += 1) limiter.reserve('1.1.1.1', 'alice')
    limiter.release('1.1.1.1', 'alice')
    expect(limiter.blocked('1.1.1.1', 'alice')).toBe(0)
    limiter.reserve('1.1.1.1', 'alice')
    expect(limiter.blocked('1.1.1.1', 'alice')).toBeGreaterThan(0)
    limiter.stop()
  })

  it('queues slowed-down attempts one after another', async () => {
    vi.useFakeTimers()
    try {
      const limiter = createLoginLimiter()
      for (let index = 0; index < LIMITS.userSlowAfter + 100; index += 1) limiter.reserve(`10.0.0.${index % 250}`, 'owner')
      let done = 0
      const waits = [1, 2, 3].map(() => limiter.slowDown('owner').then(() => (done += 1)))
      await vi.advanceTimersByTimeAsync(LIMITS.userMaxDelayMs + 1)
      expect(done).toBe(1)
      await vi.advanceTimersByTimeAsync(2 * LIMITS.userMaxDelayMs)
      await Promise.all(waits)
      expect(done).toBe(3)
      limiter.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the attempt back on success', () => {
    const limiter = createLoginLimiter()
    for (let index = 0; index < LIMITS.perIpUser - 1; index += 1) limiter.reserve('1.1.1.1', 'alice')
    limiter.reserve('1.1.1.1', 'alice')
    limiter.succeeded('1.1.1.1', 'alice')
    expect(limiter.blocked('1.1.1.1', 'alice')).toBe(0)
  })

  it('stays bounded with many junk usernames', () => {
    const limiter = createLoginLimiter()
    for (let index = 0; index < LIMITS.maxKeys + 500; index += 1) limiter.reserve(`ip${index}`, `u${index}`)
    expect(limiter.size()).toBeLessThanOrEqual(LIMITS.maxKeys * 3)
  })
})

describe('hash queue', () => {
  it('limits concurrency and rejects when full or after the deadline', async () => {
    vi.useFakeTimers()
    try {
      const queue = createHashQueue({ concurrency: 1, maxQueued: 1, maxWaitMs: 1000 })
      let release: () => void = () => {}
      const first = queue.run(() => new Promise<void>(resolve => (release = resolve)))
      const second = queue.run(async () => 'second')
      await expect(queue.run(async () => 'third')).rejects.toBeInstanceOf(BusyError)
      expect(queue.running).toBe(1)
      expect(queue.queued).toBe(1)
      release()
      await first
      expect(await second).toBe('second')

      let releaseAgain: () => void = () => {}
      const blocking = queue.run(() => new Promise<void>(resolve => (releaseAgain = resolve)))
      const late = queue.run(async () => 'late')
      vi.advanceTimersByTime(1001)
      await expect(late).rejects.toBeInstanceOf(BusyError)
      releaseAgain()
      await blocking
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('host rule', () => {
  const allowed = hostChecker({ ports: ['5555'], extraHosts: ['mybox.local', 'other.lan:8080'] })
  it.each([
    ['localhost:5555', true],
    ['LocalHost:5555', true],
    ['192.168.1.5:5555', true],
    ['[::1]:5555', true],
    ['mybox.local:5555', true],
    ['other.lan:8080', true],
    ['evil.example:5555', false],
    ['1.2.3.4.evil.example:5555', false],
    ['localhost', false],
    ['localhost.:5555', false],
    ['127.1:5555', false],
    ['0x7f000001:5555', false],
    ['2130706433:5555', false],
    ['[fe80::1%25eth0]:5555', false],
    ['192.168.1.5:80', false],
    ['256.1.1.1:5555', false],
    ['other.lan:5555', false],
  ])('%s → %s', (host, expected) => {
    expect(allowed(host)).toBe(expected)
  })
})

describe('auth API', () => {
  it('requires a session on every non-public API route', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/notes'],
      ['POST', '/api/notes'],
      ['GET', '/api/notes/00000000-0000-4000-8000-000000000000'],
      ['PATCH', '/api/notes/00000000-0000-4000-8000-000000000000'],
      ['DELETE', '/api/notes/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/images/touch'],
      ['GET', `/api/images/${'a'.repeat(64)}.png`],
      ['GET', '/api/fonts/css?family=Lora'],
      ['GET', '/api/fonts/preview?family=Lora'],
      ['GET', '/api/fonts/file/lora/x.woff2'],
      ['GET', '/api/fonts/favorites'],
      ['PUT', '/api/fonts/favorites'],
      ['GET', '/api/does-not-exist'],
    ]
    for (const [method, path] of routes) {
      const response = await request(method, path, method === 'GET' || method === 'DELETE' ? {} : { body: {} })
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const upload = await request('POST', '/api/images', { raw: new Uint8Array([1]), headers: { 'content-type': 'image/png' } })
    expect(upload.status).toBe(401)
    expect((await request('GET', '/api/health')).status).toBe(200)
  })

  it('signs in, sets a strict cookie, and signs out', async () => {
    await addUser('alice', 'correct horse battery')
    const response = await login('Alice ', 'correct horse battery')
    expect(response.status).toBe(200)
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`^${TEST_COOKIE}=`))
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    // 30 days, give or take the millisecond the request took.
    expect(setCookie).toMatch(/Max-Age=259(1999|2000)/)
    expect(setCookie).not.toContain('Secure')
    const cookie = cookieFrom(response)

    const me = await request('GET', '/api/auth/me', { cookie })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe('alice')
    expect((await request('GET', '/api/notes', { cookie })).status).toBe(200)

    const logout = await request('POST', '/api/auth/logout', { cookie, body: {} })
    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await request('GET', '/api/notes', { cookie })).status).toBe(401)
  })

  it('gives one message for unknown users and wrong passwords', async () => {
    await addUser('alice', 'correct horse battery')
    const wrong = await login('alice', 'nope nope nope')
    const unknown = await login('mallory', 'nope nope nope')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await wrong.json()).toEqual(await unknown.json())
  })

  it('reports whether any account exists when signed out', async () => {
    expect(await (await request('GET', '/api/auth/me')).json()).toMatchObject({ setupNeeded: true })
    insertUser(db, 'alice')
    expect(await (await request('GET', '/api/auth/me')).json()).toMatchObject({ setupNeeded: false })
  })

  it('rate limits with Retry-After, and lets the right password in from elsewhere', async () => {
    await addUser('alice', 'correct horse battery')
    for (let index = 0; index < LIMITS.perIpUser; index += 1) {
      expect((await login('alice', `wrong ${index} password`)).status).toBe(401)
    }
    const limited = await login('alice', 'correct horse battery')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    ip = '192.168.1.99'
    expect((await login('alice', 'correct horse battery')).status).toBe(200)
  })

  it('counts parallel attempts before checking them', async () => {
    await addUser('alice', 'correct horse battery')
    const responses = await Promise.all(
      Array.from({ length: LIMITS.perIpUser + 5 }, (_, index) => login('alice', `wrong ${index} password`)),
    )
    const statuses = responses.map(response => response.status)
    expect(statuses.filter(status => status === 401)).toHaveLength(LIMITS.perIpUser)
    expect(statuses.filter(status => status === 429)).toHaveLength(5)
  })

  it('answers a too-long password like a wrong one', async () => {
    await addUser('alice', 'correct horse battery')
    const response = await login('alice', 'x'.repeat(2000))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Wrong username or password' })
  })

  it('never lets a stale tab sign out the account another tab signed in to', async () => {
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    const stale = await request('POST', '/api/auth/logout', { body: {}, cookie: bob.cookie, headers: { 'x-margin-user': alice.id } })
    expect(stale.status).toBe(409)
    expect((await request('GET', '/api/notes', { cookie: bob.cookie })).status).toBe(200)
    const own = await request('POST', '/api/auth/logout', { body: {}, cookie: bob.cookie, headers: { 'x-margin-user': bob.id } })
    expect(own.status).toBe(204)
    expect((await request('GET', '/api/notes', { cookie: bob.cookie })).status).toBe(401)
  })

  it('accepts https origins only when Margin is set up behind HTTPS', async () => {
    const alice = signedInUser(db)
    const https = { body: {}, cookie: alice.cookie, headers: { origin: `https://${HOST}` } }
    expect((await request('POST', '/api/notes', https)).status).toBe(403)
  })

  it('answers /auth/me with the signed-in user only', async () => {
    const alice = signedInUser(db)
    const me = (await (await request('GET', '/api/auth/me', { cookie: alice.cookie })).json()) as Record<string, unknown>
    expect(Object.keys(me)).toEqual(['user'])
  })

  it('rejects oversized login bodies before hashing', async () => {
    const response = await request('POST', '/api/auth/login', {
      raw: JSON.stringify({ username: 'a', password: 'x'.repeat(MAX_LOGIN_BODY_BYTES) }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(413)
  })

  it('never reads a large streamed body for signed-out clients or sign-in', async () => {
    let pulled = 0
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1
          if (pulled > 200) controller.close()
          else controller.enqueue(new Uint8Array(64 * 1024))
        },
      })
    const send = (path: string) =>
      app.request(`http://${HOST}${path}`, {
        method: 'POST',
        headers: { host: HOST, 'content-type': 'application/json' },
        body: stream(),
        duplex: 'half',
      } as RequestInit)
    expect((await send('/api/notes')).status).toBe(401)
    expect(pulled).toBeLessThan(5)
    pulled = 0
    expect((await send('/api/auth/login')).status).toBe(413)
    expect(pulled).toBeLessThan(5)
  })

  it('replaces only the session of the browser that signs in', async () => {
    await addUser('alice', 'correct horse battery')
    const laptop = cookieFrom(await login('alice', 'correct horse battery'))
    const phone = cookieFrom(await login('alice', 'correct horse battery'))
    const laptopAgain = cookieFrom(await login('alice', 'correct horse battery', laptop))
    expect((await request('GET', '/api/notes', { cookie: laptop })).status).toBe(401)
    expect((await request('GET', '/api/notes', { cookie: phone })).status).toBe(200)
    expect((await request('GET', '/api/notes', { cookie: laptopAgain })).status).toBe(200)
  })

  it('refuses a login whose password changed while it was being checked', async () => {
    await addUser('alice', 'correct horse battery')
    const paths = dataPaths(dataDir)
    const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash })
    const fonts = createFontService({ dir: paths.fonts, catalog: [], prefetchLatin: false })
    // `margin-user passwd` lands right after scrypt accepted the old password.
    const users = createUserStore(db)
    app = createApp({
      db,
      hosts: { ports: ['5555'] },
      images,
      fonts,
      clientIp: () => ip,
      hashQueue: {
        run: async <T,>(task: () => Promise<T>) => {
          const result = await task()
          users.setPassword('alice', 'changed')
          return result
        },
        running: 0,
        queued: 0,
      },
    })
    expect((await login('alice', 'correct horse battery')).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })

  it('does not fail a second login while the first one upgrades the hash', async () => {
    await addUser('alice', 'correct horse battery')
    const results = await Promise.all([1, 2, 3].map(() => login('alice', 'correct horse battery')))
    expect(results.map(response => response.status)).toEqual([200, 200, 200])
  })

  it('upgrades old hash parameters after a successful login', async () => {
    await addUser('alice', 'correct horse battery')
    expect((await login('alice', 'correct horse battery')).status).toBe(200)
    await vi.waitFor(() => {
      const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string }
      expect(row.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/)
    })
    expect((await login('alice', 'correct horse battery')).status).toBe(200)
  })

  it('answers 409 when the request is for a different signed-in user', async () => {
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    const response = await request('POST', '/api/notes', { body: {}, cookie: bob.cookie, headers: { 'x-margin-user': alice.id } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'user_mismatch' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 })
    const ok = await request('POST', '/api/notes', { body: {}, cookie: bob.cookie, headers: { 'x-margin-user': bob.id } })
    expect(ok.status).toBe(201)
  })

  it('rejects writes whose Origin is not the Host', async () => {
    const alice = signedInUser(db)
    const foreign = await request('POST', '/api/notes', { body: {}, cookie: alice.cookie, headers: { origin: 'http://192.168.1.5:5555' } })
    expect(foreign.status).toBe(403)
    const same = await request('POST', '/api/notes', { body: {}, cookie: alice.cookie, headers: { origin: `http://${HOST}` } })
    expect(same.status).toBe(201)
  })
})

describe('isolation between users', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
  const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  async function createNote(cookie: string, title: string, body: string): Promise<string> {
    const created = (await (await request('POST', '/api/notes', { cookie, body: { title } })).json()) as { id: string }
    await request('PATCH', `/api/notes/${created.id}`, { cookie, body: { content: doc(body) } })
    return created.id
  }

  it('keeps notes, search and favorites private', async () => {
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    const secret = await createNote(alice.cookie, 'Secret plans', 'zebra in the body')
    await createNote(bob.cookie, 'Bob list', 'nothing here')

    const bobList = (await (await request('GET', '/api/notes', { cookie: bob.cookie })).json()) as Array<{ id: string }>
    expect(bobList.map(note => note.id)).not.toContain(secret)
    for (const q of ['Secret', 'zebra']) {
      const found = (await (await request('GET', `/api/notes?q=${q}`, { cookie: bob.cookie })).json()) as unknown[]
      expect(found, q).toHaveLength(0)
      const own = (await (await request('GET', `/api/notes?q=${q}`, { cookie: alice.cookie })).json()) as unknown[]
      expect(own, q).toHaveLength(1)
    }
    expect((await request('GET', `/api/notes/${secret}`, { cookie: bob.cookie })).status).toBe(404)
    expect((await request('PATCH', `/api/notes/${secret}`, { cookie: bob.cookie, body: { title: 'x' } })).status).toBe(404)
    expect((await request('DELETE', `/api/notes/${secret}`, { cookie: bob.cookie })).status).toBe(404)
    expect((await request('GET', `/api/notes/${secret}`, { cookie: alice.cookie })).status).toBe(200)

    await request('PUT', '/api/fonts/favorites', { cookie: alice.cookie, body: { families: ['Lora'] } })
    expect(await (await request('GET', '/api/fonts/favorites', { cookie: bob.cookie })).json()).toEqual({ families: [] })
    expect(await (await request('GET', '/api/fonts/favorites', { cookie: alice.cookie })).json()).toEqual({ families: ['Lora'] })
  })

  it('serves images only to their owners, and both owners of the same bytes', async () => {
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    const carol = signedInUser(db, 'carol')
    const upload = (cookie: string) =>
      request('POST', '/api/images', { cookie, raw: PNG, headers: { 'content-type': 'image/png' } })
    const { src } = (await (await upload(alice.cookie)).json()) as { src: string }

    const aliceGet = await request('GET', src, { cookie: alice.cookie })
    expect(aliceGet.status).toBe(200)
    expect(aliceGet.headers.get('cache-control')).toBe('private, no-cache')
    const etag = aliceGet.headers.get('etag') as string
    expect((await request('GET', src, { cookie: alice.cookie, headers: { 'if-none-match': etag } })).status).toBe(304)
    expect((await request('GET', src, { cookie: bob.cookie })).status).toBe(404)
    expect((await request('GET', src, { cookie: bob.cookie, headers: { 'if-none-match': etag } })).status).toBe(404)

    await upload(bob.cookie)
    expect((await request('GET', src, { cookie: bob.cookie })).status).toBe(200)
    expect((await request('GET', src, { cookie: carol.cookie })).status).toBe(404)
  })

  it("never lets a non-owner restore someone's trashed image", async () => {
    let clock = Date.UTC(2026, 0, 1)
    const paths = dataPaths(dataDir)
    const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash, now: () => clock })
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    const { src } = images.save(PNG, 'image/png', alice.id)
    const id = src.slice('/api/images/'.length, -'.png'.length)
    images.sweep()
    clock += 31 * 24 * 60 * 60 * 1000
    images.sweep()
    const trashed = () => (db.prepare('SELECT trashed_at FROM images WHERE id = ?').get(id) as { trashed_at: number | null }).trashed_at
    expect(trashed()).not.toBeNull()

    images.touch(bob.id, [id])
    expect(trashed()).not.toBeNull()
    expect(images.canRead(bob.id, `${id}.png`)).toBe(false)
    expect((await request('GET', src, { cookie: bob.cookie })).status).toBe(404)
    expect(trashed()).not.toBeNull()

    images.touch(alice.id, [id])
    expect(trashed()).toBeNull()
  })

  it('removes owner rows when an image is purged', () => {
    let clock = Date.UTC(2026, 0, 1)
    const paths = dataPaths(dataDir)
    const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash, now: () => clock })
    const alice = signedInUser(db, 'alice')
    images.save(PNG, 'image/png', alice.id)
    for (let step = 0; step < 4; step += 1) {
      images.sweep()
      clock += 31 * 24 * 60 * 60 * 1000
    }
    images.sweep()
    expect(db.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM image_owners').get()).toEqual({ n: 0 })
  })
})

describe('migration 3 (accounts)', () => {
  function legacyDatabase(): string {
    const path = join(dataDir, 'v2.db')
    const v2 = new DatabaseSync(path)
    v2.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX notes_updated_at ON notes (updated_at DESC, id DESC);
      CREATE TABLE images (id TEXT PRIMARY KEY, ext TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
        unreferenced_since INTEGER, trashed_at INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO notes VALUES ('n1', 'One', '{"type":"doc","content":[{"type":"paragraph"}]}', 'one', 1, 2);
      INSERT INTO notes VALUES ('n2', 'Two', '{"type":"doc","content":[{"type":"paragraph"}]}', 'two', 1, 3);
      INSERT INTO images VALUES ('${'a'.repeat(64)}', 'png', 10, 5, NULL, NULL);
      INSERT INTO settings VALUES ('fontFavorites', '["Lora"]');
      PRAGMA user_version = 2;
    `)
    v2.close()
    return path
  }

  it('still upgrades a database from before accounts, keeping its notes unowned (hidden)', () => {
    const upgraded = openDatabase(legacyDatabase())
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(upgraded.prepare('SELECT id, user_id FROM notes ORDER BY id').all()).toEqual([
      { id: 'n1', user_id: null },
      { id: 'n2', user_id: null },
    ])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM image_owners').get()).toEqual({ n: 0 })
  })

  it('migrates safely when two processes open the database at once', async () => {
    const path = legacyDatabase()
    const { spawn } = await import('node:child_process')
    const script = `import('${join(process.cwd(), 'server/db.ts')}').then(m => { m.openDatabase(process.argv[1]).close() })`
    const run = () =>
      new Promise<number>(resolve => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: 'inherit' })
        child.on('exit', code => resolve(code ?? 1))
      })
    expect(await Promise.all([run(), run(), run()])).toEqual([0, 0, 0])
    const check = openDatabase(path)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    check.close()
  })
})

describe('user management', () => {
  it('merges favorites when moving them to someone who already has some', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    const bob = users.create('bob', 'hash')
    const put = db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'fontFavorites', ?)")
    put.run(alice.id, '["Roboto","Lora"]')
    put.run(bob.id, '["Lato","Lora"]')
    users.reassign('alice', 'bob')
    const favorites = (id: string) => db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'fontFavorites'").get(id)
    expect(favorites(bob.id)).toEqual({ value: '["Lato","Lora","Roboto"]' })
    expect(favorites(alice.id)).toBeUndefined()
  })

  it('treats favorites as something a user owns when deleting', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'fontFavorites', '[\"Lora\"]')").run(alice.id)
    expect(() => users.delete('alice')).toThrow(/favorite/)
  })

  it('refuses a session for a password that changed since it was checked', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    users.setPassword('alice', 'new-hash')
    expect(createSessionStore(db).create(alice.id, 'ua', alice.password_changed_at)).toBeNull()
    const fresh = users.byId(alice.id)
    expect(createSessionStore(db).create(alice.id, 'ua', fresh?.password_changed_at)).not.toBeNull()
  })

  it('writes no image ownership or favorites for a user who no longer exists', () => {
    const paths = dataPaths(dataDir)
    const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash })
    images.save(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), 'image/png', 'ghost')
    expect(db.prepare('SELECT COUNT(*) AS n FROM image_owners').get()).toEqual({ n: 0 })
    expect(createSettingsStore(db).writeFavorites('ghost', ['Lora'], family => family === 'Lora')).toEqual({ ok: true, families: ['Lora'] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get()).toEqual({ n: 0 })
  })

  it('refuses to delete a user with notes unless told what to do with them', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    const bob = users.create('bob', 'hash')
    db.prepare("INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES ('n', '', '{}', '', 0, 0, ?)").run(alice.id)
    expect(() => users.delete('alice')).toThrow(/--transfer-to/)
    expect(users.delete('alice', { transferTo: 'bob' })).toMatchObject({ notes: 1, images: 0 })
    expect(db.prepare('SELECT user_id FROM notes').get()).toEqual({ user_id: bob.id })
    expect(users.delete('bob', { purge: true }).notes).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 })
  })

  it('reassigns everything, renames, and signs out on password change', () => {
    const users = createUserStore(db)
    const typo = users.create('chlyd', 'hash')
    users.create('chyld', 'hash')
    db.prepare("INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES ('n', '', '{}', '', 0, 0, ?)").run(typo.id)
    expect(users.reassign('chlyd', 'chyld').notes).toBe(1)
    expect(() => users.rename('chlyd', 'chyld')).toThrow(/already exists/)
    users.rename('chlyd', 'spare')
    expect(users.find('spare')?.id).toBe(typo.id)

    const store = createSessionStore(db)
    const token = store.create(typo.id)?.token as string
    users.setPassword('spare', 'new-hash')
    expect(store.lookup(token)).toBeNull()
  })

  it('does not create notes for a user deleted mid-request', async () => {
    const alice = signedInUser(db, 'alice')
    db.prepare('DELETE FROM users').run()
    const response = await request('POST', '/api/notes', { cookie: alice.cookie, body: {} })
    expect(response.status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 })
  })
})
