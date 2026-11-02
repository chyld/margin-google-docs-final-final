// Moving one account's data to another (`margin-user reassign` and `margin-user delete --transfer-to`).
// The expected rows were recorded from the pre-Phase-9 code, so reorganizing who owns which SQL can't
// change what ends up in the database.
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { styleNameKey } from '../shared/styleProps.ts'
import { openDatabase } from './db.ts'
import { createUserStore } from './users.ts'

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SHARED_STYLE = '55555555-5555-4555-8555-555555555555'
const img = (c: string) => c.repeat(64)

/** Two accounts that overlap in every way a transfer has to handle. */
function fixture(): DatabaseSync {
  const db = openDatabase(':memory:')
  const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params)
  run('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, 1, 1)', ALICE, 'alice', 'hash-a')
  run('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, 1, 1)', BOB, 'bob', 'hash-b')
  run("INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ('sa', ?, 2, 2, 9999999999999, 'a')", ALICE)
  run("INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ('sb', ?, 2, 2, 9999999999999, 'b')", BOB)

  let tick = 10
  const note = (id: string, user: string, title: string, tags: string[]) => {
    tick += 1
    run('INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, title, `{"note":"${id}"}`, `text of ${id}`, tick, tick + 100, user)
    for (const tag of tags) run('INSERT INTO note_tags (note_id, user_id, tag) VALUES (?, ?, ?)', id, user, tag)
  }
  note('n-a1', ALICE, 'Alice tagged', ['ideas', 'work'])
  note('n-a2', ALICE, 'Alice plain', [])
  note('n-b1', BOB, 'Bob tagged', ['ideas'])

  for (const [id, ext] of [[img('1'), 'png'], [img('2'), 'jpg']] as const) {
    run('INSERT INTO images (id, ext, bytes, created_at, unreferenced_since) VALUES (?, ?, ?, ?, ?)', id, ext, ext.length * 100, ext.length, ext === 'jpg' ? 77 : null)
  }
  run('INSERT INTO image_owners (image_id, user_id, created_at) VALUES (?, ?, 5)', img('1'), ALICE) // shared with Bob
  run('INSERT INTO image_owners (image_id, user_id, created_at) VALUES (?, ?, 6)', img('1'), BOB)
  run('INSERT INTO image_owners (image_id, user_id, created_at) VALUES (?, ?, 7)', img('2'), ALICE)

  const style = (id: string, user: string, name: string, slot: number | null, deletedAt: number | null) =>
    run(
      'INSERT INTO styles (id, user_id, name, name_key, props, favorite_slot, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      user,
      name,
      styleNameKey(name),
      JSON.stringify({ color: `#${id.slice(0, 6)}` }),
      slot,
      (tick += 1),
      tick + 500,
      deletedAt,
    )
  style('11111111-0000-4000-8000-000000000001', ALICE, 'Callout', 1, null) // clashes with Bob's "CALLOUT"
  style('11111111-0000-4000-8000-000000000002', ALICE, 'Quote', 2, null)
  style('11111111-0000-4000-8000-000000000003', ALICE, 'Callout', null, 50) // deleted: keeps its name
  style(SHARED_STYLE, ALICE, 'Alice copy', null, null) // the same id already at Bob
  style('22222222-0000-4000-8000-000000000001', BOB, 'CALLOUT', 1, null)
  style(SHARED_STYLE, BOB, 'Bob copy', 2, null)

  const setting = (user: string, key: string, value: string) => run('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)', user, key, value)
  setting(ALICE, 'fontFavorites', JSON.stringify(['Lora', 'Not A Real Font', 'Lato', 'Lora']))
  setting(BOB, 'fontFavorites', JSON.stringify(['Lato', 'Roboto']))
  setting(ALICE, 'onlyAlice', 'a')
  setting(ALICE, 'both', 'from alice')
  setting(BOB, 'both', 'from bob')
  return db
}

// Every column of every table an account owns (the fixture's values are fixed and distinct).
const TABLES = {
  users: 'SELECT * FROM users ORDER BY id',
  sessions: 'SELECT * FROM sessions ORDER BY id',
  notes: 'SELECT * FROM notes ORDER BY id',
  note_tags: 'SELECT * FROM note_tags ORDER BY note_id, tag',
  images: 'SELECT * FROM images ORDER BY id',
  image_owners: 'SELECT * FROM image_owners ORDER BY image_id, user_id',
  styles: 'SELECT * FROM styles ORDER BY user_id, id',
  user_settings: 'SELECT * FROM user_settings ORDER BY user_id, key',
}

function dump(db: DatabaseSync) {
  return Object.fromEntries(Object.entries(TABLES).map(([table, sql]) => [table, db.prepare(sql).all()]))
}

describe('moving an account to another', () => {
  it('reassign moves everything and keeps the source account', () => {
    const db = fixture()
    const result = createUserStore(db, () => 1000).reassign('alice', 'bob')
    expect({ result, rows: dump(db) }).toMatchSnapshot()
  })

  it('delete --transfer-to moves everything, then removes the source account', () => {
    const db = fixture()
    const result = createUserStore(db, () => 1000).delete('alice', { transferTo: 'bob' })
    expect({ result, rows: dump(db) }).toMatchSnapshot()
  })

  it('delete --purge removes only the source account and its own rows', () => {
    const db = fixture()
    const result = createUserStore(db, () => 1000).delete('alice', { purge: true })
    expect({ result, rows: dump(db) }).toMatchSnapshot()
  })

  it('reports what an account owns (the refusal message uses these)', () => {
    const users = createUserStore(fixture(), () => 1000)
    expect(users.owned('alice')).toMatchSnapshot()
    expect(() => users.delete('alice')).toThrowErrorMatchingSnapshot()
  })

  it('a failure partway through changes nothing', () => {
    for (const operation of ['reassign', 'delete'] as const) {
      const db = fixture()
      const before = dump(db)
      // The style move comes after notes, images and settings have moved: make it fail there.
      db.exec("CREATE TRIGGER fail_style_move BEFORE UPDATE ON styles BEGIN SELECT RAISE(ABORT, 'boom'); END")
      const users = createUserStore(db, () => 1000)
      expect(() => (operation === 'reassign' ? users.reassign('alice', 'bob') : users.delete('alice', { transferTo: 'bob' }))).toThrow('boom')
      expect(dump(db)).toEqual(before)
    }
  })
})

/** Accounts with little to move: only favorites, or none at all. */
function sparseFixture(): DatabaseSync {
  const db = openDatabase(':memory:')
  const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params)
  for (const [id, name] of [[ALICE, 'alice'], [BOB, 'bob'], ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'carol']]) {
    run('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, 1, 1)', id as string, name as string, `hash-${name}`)
  }
  run("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'fontFavorites', ?)", ALICE, JSON.stringify(['Lora', 'Unknown Family']))
  run("INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES ('n-c', 'Carol', '{}', '', 5, 6, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')")
  return db
}

describe('moving an account with little to move', () => {
  it('favorites reach a target that had none; a source without favorites leaves the target alone', () => {
    const db = sparseFixture()
    const users = createUserStore(db, () => 1000)
    expect(users.owned('alice')).toEqual({ notes: 0, images: 0, favorites: 2, styles: 0 })
    expect(() => users.delete('alice')).toThrowErrorMatchingSnapshot()
    const fromAlice = users.reassign('alice', 'bob')
    const fromCarol = users.reassign('carol', 'bob')
    expect({ fromAlice, fromCarol, rows: dump(db) }).toMatchSnapshot()
  })

  it('deleting an account that owns only favorites, with --transfer-to', () => {
    const db = sparseFixture()
    const result = createUserStore(db, () => 1000).delete('alice', { transferTo: 'carol' })
    expect({ result, rows: dump(db) }).toMatchSnapshot()
  })
})
