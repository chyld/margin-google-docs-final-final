import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { dataPaths, openDatabase, prepareDataDir, SCHEMA_VERSION } from './db.ts'
import { createFontService, rewriteFontCss } from './fonts.ts'
import type { FetchLike } from './fonts.ts'
import { createImageStore, TRASH_RETENTION_MS, UNREFERENCED_GRACE_MS } from './images.ts'
import type { ImageStore } from './images.ts'
import { signedInUser } from './testing.ts'

const HOST = 'localhost:5555'
const DAY = 24 * 60 * 60 * 1000
const TEST_CATALOG = [
  { f: 'Lora', k: 'Serif', w: [400, 700], i: [400, 700] },
  { f: 'Molle', k: 'Handwriting', w: [], i: [400] },
  ...['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(name => ({ f: `Font ${name}`, k: 'Sans Serif', w: [400], i: [] })),
]

let dataDir: string
let db: DatabaseSync
let images: ImageStore
let app: Hono
let alice: { id: string; cookie: string }
let clock: number
let fetchCalls: Array<{ url: string; init: RequestInit }>
let fetchHandler: (url: string) => Response | Promise<Response>

function build({ downloads = true } = {}) {
  const paths = dataPaths(dataDir)
  images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash, now: () => clock })
  const fetchImpl: FetchLike = async (url, init) => {
    fetchCalls.push({ url, init })
    return fetchHandler(url)
  }
  const fonts = createFontService({ db, dir: paths.fonts, catalog: TEST_CATALOG, fetchImpl, downloads, prefetchLatin: false })
  app = createApp({ db, hosts: { ports: ['5555'] }, images, fonts })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'margin-media-'))
  prepareDataDir(dataDir)
  db = openDatabase(':memory:')
  clock = Date.UTC(2026, 0, 1)
  fetchCalls = []
  fetchHandler = () => {
    throw new Error('unexpected fetch')
  }
  alice = signedInUser(db)
  build()
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function request(method: string, path: string, init: { body?: RequestInit["body"]; headers?: Record<string, string> } = {}) {
  return app.request(`http://${HOST}${path}`, { method, headers: { host: HOST, cookie: alice.cookie, ...init.headers }, body: init.body })
}

const PNG = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, extra])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const GIF = new Uint8Array([...new TextEncoder().encode('GIF89a'), 1, 2])
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'), 1])

async function upload(bytes: Uint8Array, type = 'image/png') {
  return request('POST', '/api/images', { body: bytes, headers: { 'content-type': type } })
}

async function uploadSrc(bytes: Uint8Array, type = 'image/png'): Promise<string> {
  const response = await upload(bytes, type)
  expect(response.status).toBe(201)
  return ((await response.json()) as { src: string }).src
}

function imageDoc(src: string) {
  return JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src } }] })
}

function insertNote(content: string) {
  db.prepare("INSERT INTO notes (id, title, content, text, created_at, updated_at) VALUES (?, '', ?, '', 0, 0)").run(
    crypto.randomUUID(),
    content,
  )
}

const fileName = (src: string) => src.slice('/api/images/'.length)
const liveFile = (src: string) => join(dataPaths(dataDir).images, fileName(src))
const trashFile = (src: string) => join(dataPaths(dataDir).imageTrash, fileName(src))

describe('image upload', () => {
  it.each([
    ['image/png', PNG(), 'png'],
    ['image/jpeg', JPEG, 'jpg'],
    ['image/gif', GIF, 'gif'],
    ['image/webp', WEBP, 'webp'],
  ])('stores %s under the hash of its bytes', async (type, bytes, ext) => {
    const src = await uploadSrc(bytes, type)
    expect(src).toMatch(new RegExp(`^/api/images/[0-9a-f]{64}\\.${ext}$`))

    const response = await request('GET', src)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('returns the same src for the same bytes', async () => {
    expect(await uploadSrc(PNG(7))).toBe(await uploadSrc(PNG(7)))
    expect(readdirSync(dataPaths(dataDir).images).filter(name => name.endsWith('.png'))).toHaveLength(1)
  })

  it('rejects bytes that do not match the declared type', async () => {
    expect((await upload(PNG(), 'image/jpeg')).status).toBe(415)
    expect((await upload(new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png')).status).toBe(415)
  })

  it('rejects other content types, including SVG and JSON', async () => {
    expect((await upload(PNG(), 'image/svg+xml')).status).toBe(415)
    expect((await upload(PNG(), 'application/json')).status).toBe(415)
  })

  it('accepts images over the 5 MB JSON limit and rejects them over 10 MB', async () => {
    const big = new Uint8Array(6 * 1024 * 1024)
    big.set(PNG())
    expect((await upload(big)).status).toBe(201)

    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1)
    tooBig.set(PNG())
    expect((await upload(tooBig)).status).toBe(413)
  })

  it('enforces the limit on streamed bodies without a Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    chunk.set(PNG())
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 11) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const response = await app.request(`http://${HOST}/api/images`, {
      method: 'POST',
      headers: { host: HOST, cookie: alice.cookie, 'content-type': 'image/png' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(413)
  })

  it('blocks cross-site uploads', async () => {
    const response = await request('POST', '/api/images', {
      body: PNG(),
      headers: { 'content-type': 'image/png', 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
  })

  it('404s for unknown or malformed names', async () => {
    expect((await request('GET', `/api/images/${'a'.repeat(64)}.png`)).status).toBe(404)
    expect((await request('GET', '/api/images/..%2Fmargin.db')).status).toBe(404)
    expect((await request('GET', '/api/images/abc.png')).status).toBe(404)
  })
})

describe('image cleanup', () => {
  it('trashes images no note references after 30 days and purges them 30 days later', async () => {
    const kept = await uploadSrc(PNG(1))
    const unused = await uploadSrc(PNG(2))
    insertNote(imageDoc(kept))

    images.sweep()
    clock += UNREFERENCED_GRACE_MS - 1
    images.sweep()
    expect(existsSync(liveFile(unused))).toBe(true)

    clock += 1
    expect(images.sweep().trashed).toBe(1)
    expect(existsSync(liveFile(unused))).toBe(false)
    expect(existsSync(trashFile(unused))).toBe(true)
    expect(existsSync(liveFile(kept))).toBe(true)

    clock += TRASH_RETENTION_MS
    expect(images.sweep().purged).toBe(1)
    expect(existsSync(trashFile(unused))).toBe(false)
    expect((await request('GET', unused)).status).toBe(404)
    expect((await request('GET', kept)).status).toBe(200)
  })

  it('restores a trashed image when it is requested', async () => {
    const src = await uploadSrc(PNG(3))
    images.sweep()
    clock += UNREFERENCED_GRACE_MS
    images.sweep()
    expect(existsSync(trashFile(src))).toBe(true)

    const response = await request('GET', src)
    expect(response.status).toBe(200)
    expect(existsSync(liveFile(src))).toBe(true)
    // Its clock restarts: another full grace period before it is trashed again.
    images.sweep()
    clock += UNREFERENCED_GRACE_MS - 1
    expect(images.sweep().trashed).toBe(0)
  })

  it('restores a trashed image that a note references again', async () => {
    const src = await uploadSrc(PNG(4))
    images.sweep()
    clock += UNREFERENCED_GRACE_MS
    images.sweep()
    insertNote(imageDoc(src))
    expect(images.sweep().restored).toBe(1)
    expect(existsSync(liveFile(src))).toBe(true)
  })

  it('restores images that local drafts still reference (touch)', async () => {
    const src = await uploadSrc(PNG(5))
    images.sweep()
    clock += UNREFERENCED_GRACE_MS
    images.sweep()
    const id = fileName(src).slice(0, 64)
    const response = await request('POST', '/api/images/touch', {
      body: JSON.stringify({ ids: [id] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(204)
    expect(existsSync(liveFile(src))).toBe(true)
  })

  it('re-uploading a trashed image brings it back', async () => {
    const src = await uploadSrc(PNG(6))
    images.sweep()
    clock += UNREFERENCED_GRACE_MS
    images.sweep()
    expect(await uploadSrc(PNG(6))).toBe(src)
    expect(existsSync(liveFile(src))).toBe(true)
    expect(existsSync(trashFile(src))).toBe(false)
  })

  it('heals files without rows, rows without files and stale temp files', () => {
    const paths = dataPaths(dataDir)
    const orphan = `${'b'.repeat(64)}.png`
    writeFileSync(join(paths.images, orphan), PNG())
    const temp = join(paths.images, '.tmp-old')
    writeFileSync(temp, 'partial')
    utimesSync(temp, new Date(clock - 2 * DAY), new Date(clock - 2 * DAY))
    db.prepare("INSERT INTO images (id, ext, bytes, created_at) VALUES (?, 'png', 1, 0)").run('c'.repeat(64))

    const result = images.sweep()
    expect(result.healed).toBe(2)
    expect(db.prepare('SELECT id FROM images ORDER BY id').all()).toEqual([{ id: 'b'.repeat(64) }])
    expect(existsSync(temp)).toBe(false)
  })
})

const GOOGLE_CSS = `/* cyrillic */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lora/v35/cyrillic.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F;
}
/* latin */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lora/v35/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
/* evil */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com.evil.example/x.woff2) format('woff2');
}
`
const WOFF2 = new Uint8Array([...new TextEncoder().encode('wOF2'), 0, 1, 2, 3])

const cssResponse = (body = GOOGLE_CSS) => new Response(body, { headers: { 'content-type': 'text/css; charset=utf-8' } })

describe('font proxy', () => {
  it('rewrites Google CSS to local URLs and drops blocks from other hosts', () => {
    const result = rewriteFontCss(GOOGLE_CSS, 'lora', 'Lora')
    expect(Object.values(result.manifest)).toEqual([
      'https://fonts.gstatic.com/s/lora/v35/cyrillic.woff2',
      'https://fonts.gstatic.com/s/lora/v35/latin.woff2',
    ])
    expect(result.css).not.toContain('gstatic')
    expect(result.css).not.toContain('evil')
    expect(result.css.match(/@font-face/g)).toHaveLength(2)
    expect(result.css).toMatch(/src: url\(\/api\/fonts\/file\/lora\/[0-9a-f]{16}\.woff2\) format\('woff2'\)/)
    expect(result.latinFiles).toHaveLength(1)
  })

  it('serves a cached stylesheet as text/css, fetching Google only once', async () => {
    fetchHandler = () => cssResponse()
    const first = await request('GET', '/api/fonts/css?family=Lora')
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('text/css; charset=utf-8')
    const css = await first.text()
    expect(css).toContain("font-family: 'Lora'")

    const second = await request('GET', '/api/fonts/css?family=Lora')
    expect(await second.text()).toBe(css)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400;1,700&display=swap')
    expect(fetchCalls[0]?.init.redirect).toBe('error')
  })

  it('builds requests from the weights a family really has', async () => {
    fetchHandler = () => cssResponse()
    await request('GET', '/api/fonts/css?family=Molle')
    expect(fetchCalls[0]?.url).toContain('family=Molle:ital,wght@1,400&')
  })

  it('never caches an error page', async () => {
    fetchHandler = () => new Response('<html>400</html>', { status: 400, headers: { 'content-type': 'text/html' } })
    expect((await request('GET', '/api/fonts/css?family=Lora')).status).toBe(503)
    fetchHandler = () => new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } })
    expect((await request('GET', '/api/fonts/css?family=Lora')).status).toBe(503)
    fetchHandler = () => cssResponse()
    expect((await request('GET', '/api/fonts/css?family=Lora')).status).toBe(200)
    expect(fetchCalls).toHaveLength(3)
  })

  it('answers 503 when Google is unreachable', async () => {
    fetchHandler = () => {
      throw new TypeError('fetch failed')
    }
    expect((await request('GET', '/api/fonts/css?family=Lora')).status).toBe(503)
  })

  it('404s for families outside the catalog without fetching anything', async () => {
    expect((await request('GET', '/api/fonts/css?family=Comic%20Sans')).status).toBe(404)
    expect((await request('GET', '/api/fonts/css')).status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })

  it('downloads a font file named in the manifest once, then serves it from disk', async () => {
    fetchHandler = url => (url.includes('googleapis') ? cssResponse() : new Response(WOFF2))
    const css = await (await request('GET', '/api/fonts/css?family=Lora')).text()
    const fileUrl = /url\((\/api\/fonts\/file\/[^)]+)\)/.exec(css)?.[1] as string

    const first = await request('GET', fileUrl)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('font/woff2')
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(WOFF2)

    await request('GET', fileUrl)
    expect(fetchCalls).toHaveLength(2)
  })

  it('rejects font files that are not fonts', async () => {
    fetchHandler = url => (url.includes('googleapis') ? cssResponse() : new Response('<html>'))
    const css = await (await request('GET', '/api/fonts/css?family=Lora')).text()
    const fileUrl = /url\((\/api\/fonts\/file\/[^)]+)\)/.exec(css)?.[1] as string
    expect((await request('GET', fileUrl)).status).toBe(502)
  })

  it('refetches the stylesheet after Google retires a file URL', async () => {
    fetchHandler = url => (url.includes('googleapis') ? cssResponse() : new Response('gone', { status: 404 }))
    const css = await (await request('GET', '/api/fonts/css?family=Lora')).text()
    const fileUrl = /url\((\/api\/fonts\/file\/[^)]+)\)/.exec(css)?.[1] as string
    expect((await request('GET', fileUrl)).status).toBe(503)
    await request('GET', '/api/fonts/css?family=Lora')
    expect(fetchCalls.filter(call => call.url.includes('googleapis'))).toHaveLength(2)
  })

  it('404s for unknown files and path tricks', async () => {
    for (const path of [
      '/api/fonts/file/lora/0123456789abcdef.woff2',
      '/api/fonts/file/lora/..%2F..%2Fmargin.db',
      '/api/fonts/file/..%2Fimages/0123456789abcdef.woff2',
      '/api/fonts/file/arial/0123456789abcdef.woff2',
    ]) {
      expect((await request('GET', path)).status, path).toBe(404)
    }
    expect(fetchCalls).toHaveLength(0)
  })

  it('keeps preview and full stylesheets independent, in either order', async () => {
    fetchHandler = () => cssResponse()
    const preview = await (await request('GET', '/api/fonts/preview?family=Lora')).text()
    const full = await (await request('GET', '/api/fonts/css?family=Lora')).text()
    expect(preview).toContain("font-family: 'Lora Preview'")
    expect(fetchCalls[0]?.url).toContain('&text=Lora')
    expect(fetchCalls[0]?.url).toContain('family=Lora:wght@400&')

    fetchHandler = () => new Response(WOFF2)
    for (const css of [preview, full]) {
      const fileUrl = /url\((\/api\/fonts\/file\/[^)]+)\)/.exec(css)?.[1] as string
      expect((await request('GET', fileUrl)).status).toBe(200)
    }
  })

  it('shares one Google request between concurrent requests', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    fetchHandler = async () => {
      await gate
      return cssResponse()
    }
    const pending = [request('GET', '/api/fonts/css?family=Lora'), request('GET', '/api/fonts/css?family=Lora')]
    release()
    const responses = await Promise.all(pending)
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(fetchCalls).toHaveLength(1)
  })

  it('lets a font the document uses jump ahead of queued previews', async () => {
    let held = true
    const gates: Array<() => void> = []
    fetchHandler = async () => {
      if (held) await new Promise<void>(resolve => gates.push(resolve))
      return cssResponse()
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    const previews = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(name =>
      request('GET', `/api/fonts/preview?family=Font%20${name}`),
    )
    await tick()
    expect(fetchCalls).toHaveLength(4) // the concurrency cap; two previews wait
    const picked = request('GET', '/api/fonts/css?family=Lora')
    await tick()

    gates.shift()?.() // one slot frees up: the document font gets it, not a waiting preview
    await tick()
    expect(fetchCalls[4]?.url).toContain('family=Lora:ital')

    held = false
    for (const release of gates.splice(0)) release()
    expect((await picked).status).toBe(200)
    expect((await Promise.all(previews)).map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200])
  })

  it('makes no requests when downloads are off, but still serves the cache', async () => {
    fetchHandler = () => cssResponse()
    await request('GET', '/api/fonts/css?family=Lora')
    build({ downloads: false })
    expect((await request('GET', '/api/fonts/css?family=Lora')).status).toBe(200)
    expect((await request('GET', '/api/fonts/css?family=Molle')).status).toBe(503)
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('font favorites', () => {
  const put = (families: unknown) =>
    request('PUT', '/api/fonts/favorites', {
      body: JSON.stringify({ families }),
      headers: { 'content-type': 'application/json' },
    })

  it('stores a deduplicated list of catalog families', async () => {
    expect(await (await request('GET', '/api/fonts/favorites')).json()).toEqual({ families: [] })
    const response = await put(['Molle', 'Lora', 'Molle'])
    expect(await response.json()).toEqual({ families: ['Molle', 'Lora'] })
    expect(await (await request('GET', '/api/fonts/favorites')).json()).toEqual({ families: ['Molle', 'Lora'] })
  })

  it('rejects families outside the catalog', async () => {
    expect((await put(['Lora', 'Comic Sans'])).status).toBe(400)
    expect((await put('Lora')).status).toBe(400)
  })
})

describe('guard', () => {
  it('blocks cross-site and same-site API reads, but not the app shell', async () => {
    for (const site of ['cross-site', 'same-site']) {
      expect((await request('GET', '/api/notes', { headers: { 'sec-fetch-site': site } })).status).toBe(403)
    }
    expect((await request('GET', '/api/notes', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    expect((await request('GET', '/api/notes')).status).toBe(200)
  })
})

describe('migration 2', () => {
  it('upgrades a version 1 database without touching its notes', () => {
    const path = join(dataDir, 'v1.db')
    const v1 = new DatabaseSync(path)
    v1.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX notes_updated_at ON notes (updated_at DESC, id DESC);
      INSERT INTO notes VALUES ('n1', 'Kept', '{"type":"doc","content":[{"type":"paragraph"}]}', 'hello', 1, 2);
      PRAGMA user_version = 1;
    `)
    v1.close()

    const upgraded = openDatabase(path)
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(upgraded.prepare('SELECT id, title, text, updated_at FROM notes').all()).toEqual([
      { id: 'n1', title: 'Kept', text: 'hello', updated_at: 2 },
    ])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 })
    upgraded.close()
  })
})
