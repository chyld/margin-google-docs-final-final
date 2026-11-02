import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Note, NoteSummary } from '../shared/types.ts'
import { createApp, MAX_BODY_BYTES } from './app.ts'
import { dataPaths, openDatabase, prepareDataDir } from './db.ts'
import { createFontService } from './fonts.ts'
import type { FetchLike } from './fonts.ts'
import { createImageStore } from './images.ts'
import { LIST_LIMIT } from '../shared/constants.ts'
import { signedInUser } from './testing.ts'

const HOST = 'localhost:5555'
const ORIGIN = `http://${HOST}`

let staticDir: string
let dataDir: string
let db: DatabaseSync
let app: Hono
let alice: { id: string; cookie: string }

const TEST_CATALOG = [
  { f: 'Lora', k: 'Serif', w: [400, 700], i: [400, 700] },
  { f: 'Molle', k: 'Handwriting', w: [], i: [400] },
]
// Tests never reach the network: font requests fail unless a test installs its own fetch.
let fetchImpl: FetchLike = async () => {
  throw new Error('network disabled in tests')
}

function buildApp() {
  const paths = dataPaths(dataDir)
  const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash })
  const fonts = createFontService({
    dir: paths.fonts,
    catalog: TEST_CATALOG,
    fetchImpl: (url, init) => fetchImpl(url, init),
    prefetchLatin: false,
  })
  return createApp({ db, hosts: { ports: ['5555'] }, images, fonts, staticDir })
}

beforeAll(() => {
  staticDir = mkdtempSync(join(tmpdir(), 'margin-static-'))
  mkdirSync(join(staticDir, 'assets'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Margin</title>')
  writeFileSync(join(staticDir, 'assets', 'app-abc123.js'), 'console.log("app")')
  writeFileSync(join(staticDir, 'favicon.svg'), '<svg></svg>')
})

afterAll(() => rmSync(staticDir, { recursive: true, force: true }))

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'margin-data-'))
  prepareDataDir(dataDir)
  db = openDatabase(':memory:')
  app = buildApp()
  alice = signedInUser(db)
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

type RequestOptions = { body?: unknown; rawBody?: string; headers?: Record<string, string> }

function request(method: string, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { host: HOST, cookie: alice.cookie, ...options.headers }
  let body: string | undefined = options.rawBody
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] ??= 'application/json'
  }
  return app.request(`http://${HOST}${path}`, { method, headers, body })
}

async function createNote(title?: string): Promise<Note> {
  const response = await request('POST', '/api/notes', { body: title === undefined ? {} : { title } })
  expect(response.status).toBe(201)
  return (await response.json()) as Note
}

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('notes API', () => {
  it('creates a note with an empty document, returned as an object', async () => {
    const note = await createNote('Groceries')
    expect(note.title).toBe('Groceries')
    expect(note.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(note.createdAt).toBe(note.updatedAt)
  })

  it('round-trips content exactly and derives the snippet on the server', async () => {
    const note = await createNote()
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Buy milk', marks: [{ type: 'bold' }, { type: 'highlight', attrs: { color: '#fff3bf' } }] }],
        },
      ],
    }
    const patch = await request('PATCH', `/api/notes/${note.id}`, { body: { content } })
    expect(patch.status).toBe(200)
    const summary = (await patch.json()) as NoteSummary
    expect(summary).toMatchObject({ id: note.id, snippet: 'Plan Buy milk' })
    expect(summary.updatedAt).toBeGreaterThanOrEqual(note.updatedAt)

    const fetched = (await (await request('GET', `/api/notes/${note.id}`)).json()) as Note
    expect(fetched.content).toEqual(content)
  })

  it('updates the title without touching the content', async () => {
    const note = await createNote()
    await request('PATCH', `/api/notes/${note.id}`, { body: { content: doc('body text') } })
    const patch = await request('PATCH', `/api/notes/${note.id}`, { body: { title: 'Renamed' } })
    expect(await patch.json()).toMatchObject({ title: 'Renamed', snippet: 'body text' })
  })

  it('lists notes newest first', async () => {
    const first = await createNote('first')
    const second = await createNote('second')
    await new Promise(resolve => setTimeout(resolve, 5))
    await request('PATCH', `/api/notes/${first.id}`, { body: { title: 'first, edited' } })

    const list = (await (await request('GET', '/api/notes')).json()) as NoteSummary[]
    expect(list.map(item => item.id)).toEqual([first.id, second.id])
  })

  it(`caps the list at ${LIST_LIMIT} notes`, async () => {
    const insert = db.prepare(
      "INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES (?, '', '{}', '', 1, 1, ?)",
    )
    for (let index = 0; index < LIST_LIMIT + 5; index += 1) insert.run(crypto.randomUUID(), alice.id)
    const list = (await (await request('GET', '/api/notes')).json()) as NoteSummary[]
    expect(list).toHaveLength(LIST_LIMIT)
  })

  it('searches titles and text, treating %, _ and \\ literally', async () => {
    const percent = await createNote('100% done')
    const underscore = await createNote('snake_case')
    const backslash = await createNote('C:\\temp')
    const plain = await createNote('Plain')
    await request('PATCH', `/api/notes/${plain.id}`, { body: { content: doc('mentions Groceries in the body') } })

    const search = async (q: string) => {
      const response = await request('GET', `/api/notes?q=${encodeURIComponent(q)}`)
      return ((await response.json()) as NoteSummary[]).map(item => item.id)
    }

    expect(await search('%')).toEqual([percent.id])
    expect(await search('_')).toEqual([underscore.id])
    expect(await search('\\')).toEqual([backslash.id])
    expect(await search('groceries')).toEqual([plain.id])
    expect(await search('PLAIN')).toEqual([plain.id])
    expect(await search('   ')).toHaveLength(4)
  })

  it('deletes a note', async () => {
    const note = await createNote()
    expect((await request('DELETE', `/api/notes/${note.id}`)).status).toBe(204)
    expect((await request('GET', `/api/notes/${note.id}`)).status).toBe(404)
    expect((await request('DELETE', `/api/notes/${note.id}`)).status).toBe(404)
  })

  it('returns 404 for a missing note and 400 for a malformed id', async () => {
    const missing = crypto.randomUUID()
    expect((await request('GET', `/api/notes/${missing}`)).status).toBe(404)
    expect((await request('PATCH', `/api/notes/${missing}`, { body: { title: 'x' } })).status).toBe(404)
    expect((await request('GET', '/api/notes/not-a-uuid')).status).toBe(400)
  })

  it.each([
    ['an unknown key', { title: 'x', text: 'client text' }],
    ['an empty patch', {}],
    ['a non-string title', { title: 42 }],
    ['a title that is too long', { title: 'x'.repeat(501) }],
    ['content that is not a doc', { content: { type: 'paragraph' } }],
    ['content with an unknown node', { content: { type: 'doc', content: [{ type: 'image' }] } }],
    ['content with text directly under doc', { content: { type: 'doc', content: [{ type: 'text', text: 'bare' }] } }],
    ['an empty document', { content: { type: 'doc', content: [] } }],
    ['a paragraph inside a paragraph', { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] } }],
  ])('rejects a patch with %s', async (_label, body) => {
    const note = await createNote()
    const response = await request('PATCH', `/api/notes/${note.id}`, { body })
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error')
  })

  it('strips unsafe links and colors, keeps modern colors, and stores the cleaned document', async () => {
    const note = await createNote()
    const text = (value: string, marks: unknown[]) => ({ type: 'text', text: value, marks })
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center;position:fixed' },
          content: [
            text('evil', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
            text(' pasted', [{ type: 'textStyle', attrs: { color: 'oklch(0.7 0.1 200)' } }]),
            text(' broken', [{ type: 'highlight', attrs: { color: 'red;background:url(x)' } }]),
          ],
        },
      ],
    }
    const patch = await request('PATCH', `/api/notes/${note.id}`, { body: { content } })
    expect(patch.status).toBe(200)

    const stored = (await (await request('GET', `/api/notes/${note.id}`)).json()) as Note
    expect(stored.content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            text('evil', []),
            text(' pasted', [{ type: 'textStyle', attrs: { color: 'oklch(0.7 0.1 200)' } }]),
            text(' broken', [{ type: 'highlight', attrs: { color: null } }]),
          ],
        },
      ],
    })
  })

  it('rejects malformed JSON with 400', async () => {
    const response = await request('POST', '/api/notes', { rawBody: '{nope', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(400)
  })

  it('rejects bodies over the size limit with 413', async () => {
    const note = await createNote()
    const huge = 'x'.repeat(MAX_BODY_BYTES + 1)
    const response = await request('PATCH', `/api/notes/${note.id}`, { body: { content: doc(huge) } })
    expect(response.status).toBe(413)
  })

  it('returns JSON 404 for unknown API paths', async () => {
    for (const path of ['/api', '/api/nope', '/api/notes/x/y']) {
      const response = await request('GET', path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
    }
  })
})

describe('guard', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const response = await app.request('http://evil.example:5555/api/notes', { headers: { host: 'evil.example:5555' } })
    expect(response.status).toBe(403)
  })

  it('rejects writes from another origin', async () => {
    const response = await request('POST', '/api/notes', { body: {}, headers: { origin: 'http://localhost:3000' } })
    expect(response.status).toBe(403)
  })

  it('rejects writes marked cross-site or same-site by the browser', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await request('POST', '/api/notes', { body: {}, headers: { 'sec-fetch-site': site } })
      expect(response.status).toBe(403)
    }
  })

  it('accepts same-origin writes', async () => {
    const response = await request('POST', '/api/notes', {
      body: {},
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    })
    expect(response.status).toBe(201)
  })

  it('requires a JSON content type on writes with a body', async () => {
    const response = await request('POST', '/api/notes', { rawBody: '{}', headers: { 'content-type': 'text/plain' } })
    expect(response.status).toBe(415)
  })

  it('sets security headers and no CORS headers', async () => {
    const response = await request('GET', '/api/notes')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })
})

describe('static files and SPA fallback', () => {
  it('serves index.html for app routes, uncached', async () => {
    for (const path of ['/', `/notes/${crypto.randomUUID()}`]) {
      const response = await request('GET', path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    }
  })

  it('serves hashed assets with a long cache lifetime', async () => {
    const response = await request('GET', '/assets/app-abc123.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
  })

  it('serves other public files', async () => {
    expect((await request('GET', '/favicon.svg')).status).toBe(200)
  })

  it('returns 404, not HTML, for missing files', async () => {
    for (const path of ['/assets/missing.js', '/missing.png']) {
      const response = await request('GET', path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type') ?? '').not.toContain('text/html')
    }
  })
})

describe('note tags', () => {
  const patch = (id: string, body: unknown) => request('PATCH', `/api/notes/${id}`, { body })
  const list = async (query = '') => (await (await request('GET', `/api/notes${query}`)).json()) as NoteSummary[]
  const counts = async () => ((await (await request('GET', '/api/tags')).json()) as { tags: Array<{ tag: string; count: number }> }).tags

  it('saves tags alone (normalized, sorted) and returns them everywhere', async () => {
    const note = await createNote('Plan')
    const response = await patch(note.id, { tags: ['Work', '#home', 'work'] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as NoteSummary).tags).toEqual(['home', 'work'])
    expect(((await (await request('GET', `/api/notes/${note.id}`)).json()) as Note).tags).toEqual(['home', 'work'])
    expect((await list())[0]!.tags).toEqual(['home', 'work'])
    expect(note.tags).toEqual([])
  })

  it('rejects invalid tags and too many, changing nothing', async () => {
    const note = await createNote()
    await patch(note.id, { tags: ['keep'] })
    for (const tags of [['to-do'], ['a b'], [''], [7], Array.from({ length: 21 }, (_, i) => `t${i}`), 'nope']) {
      const response = await patch(note.id, { tags, title: 'changed' })
      expect(response.status, JSON.stringify(tags)).toBe(400)
    }
    const after = (await (await request('GET', `/api/notes/${note.id}`)).json()) as Note
    expect(after.tags).toEqual(['keep'])
    expect(after.title).toBe('')
  })

  it('a real tag change counts as an edit; the same set changes nothing', async () => {
    const first = await createNote('first')
    const second = await createNote('second')
    await new Promise(resolve => setTimeout(resolve, 5))
    const changed = (await (await patch(first.id, { tags: ['a'] })).json()) as NoteSummary
    expect(changed.updatedAt).toBeGreaterThan(first.updatedAt)
    expect((await list())[0]!.id).toBe(first.id)
    await new Promise(resolve => setTimeout(resolve, 5))
    const same = (await (await patch(first.id, { tags: ['A'] })).json()) as NoteSummary
    expect(same.updatedAt).toBe(changed.updatedAt)
    expect(second.tags).toEqual([])
  })

  it('saves tags and content together', async () => {
    const note = await createNote()
    const summary = (await (await patch(note.id, { content: doc('hello'), tags: ['x'] })).json()) as NoteSummary
    expect(summary).toMatchObject({ snippet: 'hello', tags: ['x'] })
  })

  it('filters by tags (all of them) together with text, beyond the list limit for counts', async () => {
    const a = await createNote('alpha meeting')
    const b = await createNote('beta meeting')
    const c = await createNote('gamma')
    await patch(a.id, { tags: ['work', 'urgent'] })
    await patch(b.id, { tags: ['work'] })
    await patch(c.id, { tags: ['urgent'] })
    expect((await list('?tag=work')).map(n => n.id).sort()).toEqual([a.id, b.id].sort())
    expect((await list('?tag=work&tag=urgent')).map(n => n.id)).toEqual([a.id])
    expect((await list('?tag=urgent&q=gamma')).map(n => n.id)).toEqual([c.id])
    expect((await list('?tag=nothing')).length).toBe(0)
    expect((await request('GET', '/api/notes?tag=to-do')).status).toBe(400)
    expect(await counts()).toEqual([
      { tag: 'urgent', count: 2 },
      { tag: 'work', count: 2 },
    ])
  })

  it('a tag filter combined with text keeps %, _ and \\ literal', async () => {
    const a = await createNote('100% done')
    const b = await createNote('1000 done')
    await patch(a.id, { tags: ['x'] })
    await patch(b.id, { tags: ['x'] })
    expect((await list('?tag=x&q=' + encodeURIComponent('100%'))).map(n => n.id)).toEqual([a.id])
    expect((await list('?tag=x&q=' + encodeURIComponent('_'))).length).toBe(0)
  })

  it('migration 5 creates note_tags', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_tags'").get()).toEqual({ name: 'note_tags' })
  })

  it('counts every note, not just the newest LIST_LIMIT', async () => {
    const ids: string[] = []
    for (let index = 0; index < LIST_LIMIT + 3; index += 1) ids.push((await createNote(`n${index}`)).id)
    for (const id of ids) await patch(id, { tags: ['bulk'] })
    expect(await counts()).toEqual([{ tag: 'bulk', count: LIST_LIMIT + 3 }])
  })

  it('keeps tags private and never writes rows for a foreign note', async () => {
    const note = await createNote()
    await patch(note.id, { tags: ['secret'] })
    const bob = signedInUser(db, 'bob')
    const asBob = (method: string, path: string, body?: unknown) =>
      app.request(`http://${HOST}${path}`, {
        method,
        headers: { host: HOST, cookie: bob.cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    expect((await asBob('PATCH', `/api/notes/${note.id}`, { tags: ['mine'] })).status).toBe(404)
    expect((await asBob('PATCH', '/api/notes/00000000-0000-4000-8000-000000000000', { tags: ['ghost'] })).status).toBe(404)
    expect(((await (await asBob('GET', '/api/tags')).json()) as { tags: unknown[] }).tags).toEqual([])
    expect(((await (await asBob('GET', '/api/notes?tag=secret')).json()) as unknown[]).length).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_tags').get()).toEqual({ n: 1 })
  })

  it('deleting a note removes its tags', async () => {
    const note = await createNote()
    await patch(note.id, { tags: ['gone'] })
    expect((await request('DELETE', `/api/notes/${note.id}`)).status).toBe(204)
    expect(await counts()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_tags').get()).toEqual({ n: 0 })
  })

  it('margin-user transfer and reassign move tags; purge deletes them', async () => {
    const { createUserStore } = await import('./users.ts')
    const users = createUserStore(db)
    const note = await createNote()
    await patch(note.id, { tags: ['moved'] })
    signedInUser(db, 'bob')
    users.reassign('alice', 'bob')
    expect(db.prepare('SELECT user_id FROM note_tags').all()).toEqual([{ user_id: users.find('bob')!.id }])
    signedInUser(db, 'carol')
    users.delete('bob', { transferTo: 'carol' })
    expect(db.prepare('SELECT user_id FROM note_tags').all()).toEqual([{ user_id: users.find('carol')!.id }])
    users.delete('carol', { purge: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_tags').get()).toEqual({ n: 0 })
  })
})
