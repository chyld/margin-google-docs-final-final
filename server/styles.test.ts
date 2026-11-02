import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanStyleName, cleanStyleProps, stylesheetFor, styleNameKey } from '../shared/styleProps.ts'
import { inspectDoc } from '../shared/doc.ts'
import { checkSchema } from '../shared/schema.ts'
import { createApp } from './app.ts'
import { dataPaths, openDatabase, prepareDataDir } from './db.ts'
import { createFontService } from './fonts.ts'
import { createImageStore } from './images.ts'
import { signedInUser } from './testing.ts'
import { createUserStore } from './users.ts'

const HOST = 'localhost:5555'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let dataDir: string
let db: DatabaseSync
let app: Hono

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'margin-styles-'))
  prepareDataDir(dataDir)
  db = openDatabase(':memory:')
  const paths = dataPaths(dataDir)
  app = createApp({
    db,
    hosts: { ports: ['5555'] },
    images: createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash }),
    fonts: createFontService({ db, dir: paths.fonts, catalog: [], prefetchLatin: false }),
  })
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function request(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = { host: HOST, cookie }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.request(`http://${HOST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

describe('style props', () => {
  it('canonicalizes values and key order', () => {
    expect(cleanStyleProps({ bold: true, color: 'RGB(217, 48, 37)', fontSize: '14', highlight: '#FA0' })).toEqual({
      fontSize: '14pt',
      color: '#d93025',
      highlight: '#ffaa00',
      bold: true,
    })
    expect(JSON.stringify(cleanStyleProps({ align: 'center', block: 'h2', italic: true }))).toBe(
      '{"italic":true,"block":"h2","align":"center"}',
    )
    expect(cleanStyleProps({ bold: false, italic: true })).toEqual({ italic: true })
  })

  it('rejects unknown keys, unsafe values and empty styles', () => {
    expect(cleanStyleProps({})).toBeNull()
    expect(cleanStyleProps({ bold: false })).toBeNull()
    expect(cleanStyleProps({ evil: 1 })).toBeNull()
    expect(cleanStyleProps({ color: 'red; background: url(x)' })).toBeNull()
    expect(cleanStyleProps({ color: 'rgba(0,0,0,0.5)' })).toBeNull()
    expect(cleanStyleProps({ fontFamily: 'Lora; } body { display:none' })).toBeNull()
    expect(cleanStyleProps({ fontSize: '9999' })).toBeNull()
    expect(cleanStyleProps({ block: 'h7' })).toBeNull()
    expect(cleanStyleProps({ bold: 'yes' })).toBeNull()
    expect(cleanStyleProps('bold')).toBeNull()
  })

  it('cleans names: control and bidi characters, spaces, length', () => {
    expect(cleanStyleName('  Call‮out\u0007  title ')).toBe('Callout title')
    expect(cleanStyleName('   ')).toBeNull()
    expect(cleanStyleName('x'.repeat(61))).toBeNull()
    expect(styleNameKey('ÄRGER')).toBe(styleNameKey('ärger'))
  })

  it('builds a stylesheet only from valid ids and values', () => {
    const css = stylesheetFor([
      { id: ID(1), props: { fontFamily: '"Lora", serif', color: '#d93025', bold: true, underline: true, strike: true, block: 'h2', align: 'center' } },
      { id: 'not-a-uuid', props: { color: '#000000' } },
      { id: ID(2), props: { color: 'red; } * { display: none' } as never },
    ])
    expect(css).toContain(`.document span[data-style="${ID(1)}"] { font-family: "Lora", serif; color: #d93025; font-weight: 700; text-decoration-line: underline line-through; }`)
    expect(css).toContain(`.document [data-style-id="${ID(1)}"] { font-size: 16pt;`)
    expect(css).toContain('text-align: center')
    // Paragraph rules carry only the heading look and alignment; heading spacing is top-level only;
    // links inside styled text take the style's color.
    expect(css).toContain(`.document [data-style-id="${ID(1)}"] { font-size: 16pt; font-weight: 400; line-height: 1.25; color: #202124; font-style: normal; text-align: center; }`)
    expect(css).toContain(`.document > [data-style-id="${ID(1)}"] { margin: 1.2em 0 0.4em; }`)
    expect(css).toContain(`.document span[data-style="${ID(1)}"] a { color: #d93025; }`)
    expect(css).not.toContain('not-a-uuid')
    expect(css).not.toContain('display')
  })
})

describe('documents with styles', () => {
  const doc = (markId: unknown, blockId: unknown) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { styleId: blockId },
        content: [{ type: 'text', text: 'Styled', marks: [{ type: 'namedStyle', attrs: { id: markId } }, { type: 'bold' }] }],
      },
    ],
  })

  it('keeps valid tags and passes the schema', () => {
    const result = inspectDoc(doc(ID(1), ID(2)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(checkSchema(result.doc).ok).toBe(true)
    expect(JSON.stringify(result.doc)).toContain(ID(1))
    expect(JSON.stringify(result.doc)).toContain(ID(2))
  })

  it('drops malformed tags but keeps the text and other marks', () => {
    const result = inspectDoc(doc('"><script>', 'nope'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paragraph = (result.doc.content as Array<Record<string, any>>)[0] as Record<string, any>
    expect(paragraph.attrs.styleId).toBeNull()
    expect(paragraph.content[0].marks).toEqual([{ type: 'bold' }])
    expect(result.text).toBe('Styled')
  })
})

describe('styles API', () => {
  it('creates, lists, renames, edits, favorites and deletes (keeping a tombstone)', async () => {
    const alice = signedInUser(db, 'alice')
    const created = await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: ' Callout ', props: { color: '#D93025', bold: true } })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ id: ID(1), name: 'Callout', props: { color: '#d93025', bold: true }, favoriteSlot: null, deleted: false })

    // Retrying the same request is harmless; reusing the id for something else is not.
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'Callout', props: { color: '#d93025', bold: true } })).status).toBe(200)
    const reused = await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'Other', props: { bold: true } })
    expect(reused.status).toBe(409)
    expect(await reused.json()).toMatchObject({ code: 'id_in_use' })

    const patched = await request('PATCH', `/api/styles/${ID(1)}`, alice.cookie, { name: 'Warning', props: { color: '#188038' } })
    expect(await patched.json()).toMatchObject({ name: 'Warning', props: { color: '#188038' } })

    const starred = await request('PATCH', `/api/styles/${ID(1)}`, alice.cookie, { favorite: true })
    expect(await starred.json()).toMatchObject({ favoriteSlot: 1 })

    expect((await request('DELETE', `/api/styles/${ID(1)}`, alice.cookie)).status).toBe(204)
    const list = (await (await request('GET', '/api/styles', alice.cookie)).json()) as { styles: Array<Record<string, unknown>> }
    expect(list.styles).toEqual([expect.objectContaining({ id: ID(1), deleted: true, favoriteSlot: null })])
    // Deleted styles can't be edited, and the name is free again.
    expect((await request('PATCH', `/api/styles/${ID(1)}`, alice.cookie, { name: 'x' })).status).toBe(404)
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(2), name: 'warning', props: { italic: true } })).status).toBe(201)
    // A deleted style's id can't come back through create.
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'Warning', props: { color: '#188038' } })).status).toBe(409)
  })

  it('rejects control characters in font names (they would break the stylesheet)', () => {
    expect(cleanStyleProps({ fontFamily: '"a\nb", serif' })).toBeNull()
    expect(cleanStyleProps({ fontFamily: '"Lora", serif' })).toEqual({ fontFamily: '"Lora", serif' })
  })

  it('puts text parts only on tagged text, never on whole paragraph boxes', () => {
    const css = stylesheetFor([{ id: ID(5), props: { highlight: '#fff475', underline: true, color: '#188038' } }])
    expect(css).toContain(`.document span[data-style="${ID(5)}"] { color: #188038; background-color: #fff475; text-decoration-line: underline; }`)
    expect(css).not.toContain(`[data-style-id="${ID(5)}"] {`)
  })

  it('keeps the page spacing for a Normal text paragraph style', () => {
    const css = stylesheetFor([{ id: ID(6), props: { block: 'paragraph', align: 'right' } }])
    expect(css).not.toContain('margin: 0;')
    expect(css).toContain('text-align: right')
  })

  it('reports name clashes (any case, any language) as name_taken, never as a session problem', async () => {
    const alice = signedInUser(db, 'alice')
    await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'Ärger', props: { bold: true } })
    const clash = await request('POST', '/api/styles', alice.cookie, { id: ID(2), name: 'ärger', props: { bold: true } })
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({ code: 'name_taken' })
    await request('POST', '/api/styles', alice.cookie, { id: ID(3), name: 'Other', props: { bold: true } })
    const rename = await request('PATCH', `/api/styles/${ID(3)}`, alice.cookie, { name: 'ÄRGER' })
    expect(rename.status).toBe(409)
    expect(await rename.json()).toMatchObject({ code: 'name_taken' })
  })

  it('validates input', async () => {
    const alice = signedInUser(db, 'alice')
    expect((await request('POST', '/api/styles', alice.cookie, { id: 'x', name: 'A', props: { bold: true } })).status).toBe(400)
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: '', props: { bold: true } })).status).toBe(400)
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'A', props: {} })).status).toBe(400)
    expect((await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'A', props: { color: 'url(x)' } })).status).toBe(400)
    expect((await request('PATCH', `/api/styles/${ID(9)}`, alice.cookie, { favorite: true })).status).toBe(404)
  })

  it('keeps favorite slots stable when others are starred or unstarred', async () => {
    const alice = signedInUser(db, 'alice')
    for (const n of [1, 2, 3]) await request('POST', '/api/styles', alice.cookie, { id: ID(n), name: `S${n}`, props: { bold: true } })
    const star = async (n: number, favorite: boolean) =>
      ((await (await request('PATCH', `/api/styles/${ID(n)}`, alice.cookie, { favorite })).json()) as { favoriteSlot: number | null }).favoriteSlot
    expect(await star(1, true)).toBe(1)
    expect(await star(2, true)).toBe(2)
    expect(await star(3, true)).toBe(3)
    expect(await star(1, false)).toBeNull()
    // S2 and S3 keep 2 and 3; the next star takes the free slot 1.
    expect(await star(1, true)).toBe(1)
    const list = (await (await request('GET', '/api/styles', alice.cookie)).json()) as { styles: Array<{ id: string; favoriteSlot: number }> }
    expect(Object.fromEntries(list.styles.map(style => [style.id, style.favoriteSlot]))).toEqual({ [ID(1)]: 1, [ID(2)]: 2, [ID(3)]: 3 })
  })

  it('keeps styles private', async () => {
    const alice = signedInUser(db, 'alice')
    const bob = signedInUser(db, 'bob')
    await request('POST', '/api/styles', alice.cookie, { id: ID(1), name: 'Mine', props: { bold: true } })
    expect(await (await request('GET', '/api/styles', bob.cookie)).json()).toEqual({ styles: [] })
    expect((await request('PATCH', `/api/styles/${ID(1)}`, bob.cookie, { name: 'Stolen' })).status).toBe(404)
    expect((await request('DELETE', `/api/styles/${ID(1)}`, bob.cookie)).status).toBe(404)
    // Bob may use the same id for his own style: ids are per user.
    expect((await request('POST', '/api/styles', bob.cookie, { id: ID(1), name: 'Mine', props: { italic: true } })).status).toBe(201)
    const aliceList = (await (await request('GET', '/api/styles', alice.cookie)).json()) as { styles: Array<{ props: unknown }> }
    expect(aliceList.styles[0]?.props).toEqual({ bold: true })
  })

  it('needs a session', async () => {
    expect((await request('GET', '/api/styles', '')).status).toBe(401)
    expect((await request('POST', '/api/styles', '', { id: ID(1), name: 'A', props: { bold: true } })).status).toBe(401)
  })
})

describe('styles and accounts', () => {
  function addStyle(userId: string, n: number, name: string, slot: number | null = null, deleted = false) {
    db.prepare(
      `INSERT INTO styles (id, user_id, name, name_key, props, favorite_slot, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, '{"bold":true}', ?, ?, 0, ?)`,
    ).run(ID(n), userId, name, styleNameKey(name), slot, n, deleted ? 1 : null)
  }
  const stylesOf = (userId: string) =>
    db.prepare('SELECT id, name, favorite_slot AS slot, deleted_at IS NOT NULL AS deleted FROM styles WHERE user_id = ? ORDER BY id').all(userId)

  it('refuses to delete a user who owns only styles, and purges them on request', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    addStyle(alice.id, 1, 'Callout')
    expect(users.owned('alice').styles).toBe(1)
    expect(() => users.delete('alice')).toThrow(/style/)
    users.delete('alice', { purge: true })
    expect(stylesOf(alice.id)).toEqual([])
  })

  it('moves styles on transfer, keeping ids and renaming clashes', () => {
    const users = createUserStore(db)
    const alice = users.create('alice', 'hash')
    const bob = users.create('bob', 'hash')
    addStyle(bob.id, 1, 'Callout', 1)
    addStyle(bob.id, 2, 'Callout (2)')
    addStyle(alice.id, 3, 'callout', 1)
    addStyle(alice.id, 4, 'x'.repeat(60))
    addStyle(alice.id, 5, 'Gone', null, true)
    addStyle(bob.id, 6, 'x'.repeat(60))
    expect(users.reassign('alice', 'bob').styles).toBe(2)
    expect(stylesOf(alice.id)).toEqual([])
    const moved = Object.fromEntries((stylesOf(bob.id) as Array<{ id: string; name: string; slot: number | null }>).map(row => [row.id, row]))
    expect(moved[ID(3)]).toMatchObject({ name: 'callout (3)', slot: 2 })
    expect(moved[ID(4)]?.name).toBe(`${'x'.repeat(56)} (2)`)
    expect(moved[ID(5)]).toMatchObject({ name: 'Gone', deleted: 1 })
  })
})
