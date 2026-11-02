// Uploaded images: content-addressed files in DATA_DIR/images, plus a row per image.
//
// Note content is the only source of truth for which images are in use. A periodic sweep moves
// images that no note has referenced for 30 days into images/.trash, and deletes them for good
// after another 30 days. Anything that asks for a trashed image (a page load, a restored draft, a
// save that references it again) brings it back.
//
// Every method here is synchronous, so in Node's single thread an upload, a restore and a sweep
// can never interleave halfway through.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { IMAGE_NAME, IMAGE_TYPES, imageIdsIn } from '../shared/imageRules.ts'
import type { ImageType } from '../shared/imageRules.ts'
import { transaction } from './db.ts'

export const CONTENT_TYPES: Record<string, ImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}


const DAY = 24 * 60 * 60 * 1000
export const UNREFERENCED_GRACE_MS = 30 * DAY
export const TRASH_RETENTION_MS = 30 * DAY
const STALE_TEMP_MS = DAY

/** The image type the bytes really are, from their signature. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const startsWith = (signature: number[], offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

type ImageRow = {
  id: string
  ext: string
  bytes: number
  created_at: number
  unreferenced_since: number | null
  trashed_at: number | null
}

export type SweepResult = { marked: number; trashed: number; purged: number; restored: number; healed: number }

export type ImageStoreOptions = {
  db: DatabaseSync
  dir: string
  trashDir: string
  now?: () => number
}

export function createImageStore({ db, dir, trashDir, now = Date.now }: ImageStoreOptions) {
  const sql = {
    upsert: db.prepare(
      `INSERT INTO images (id, ext, bytes, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET unreferenced_since = NULL, trashed_at = NULL`,
    ),
    insertFound: db.prepare('INSERT OR IGNORE INTO images (id, ext, bytes, created_at) VALUES (?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM images WHERE id = ?'),
    all: db.prepare('SELECT * FROM images'),
    clear: db.prepare('UPDATE images SET unreferenced_since = NULL, trashed_at = NULL WHERE id = ?'),
    markUnreferenced: db.prepare('UPDATE images SET unreferenced_since = ? WHERE id = ?'),
    markTrashed: db.prepare('UPDATE images SET trashed_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM images WHERE id = ?'),
    removeOwners: db.prepare('DELETE FROM image_owners WHERE image_id = ?'),
    // Nothing is written for a user deleted (by margin-user) while their upload was running.
    addOwner: db.prepare(
      `INSERT OR IGNORE INTO image_owners (image_id, user_id, created_at)
       SELECT ?, id, ? FROM users WHERE id = ?`,
    ),
    owns: db.prepare(
      `SELECT 1 FROM image_owners o JOIN images i ON i.id = o.image_id
       WHERE o.image_id = ? AND o.user_id = ? AND i.ext = ?`,
    ),
    // Only notes that contain an image link; the regex below does the exact match.
    noteContents: db.prepare("SELECT content FROM notes WHERE content LIKE '%/api/images/%'"),
  }

  const livePath = (id: string, ext: string) => join(dir, `${id}.${ext}`)
  const trashPath = (id: string, ext: string) => join(trashDir, `${id}.${ext}`)

  /** Brings a trashed image back and resets its unused clock. */
  function restore(row: ImageRow): boolean {
    let restored = false
    const trashed = trashPath(row.id, row.ext)
    if (existsSync(trashed)) {
      renameSync(trashed, livePath(row.id, row.ext))
      restored = true
    }
    if (row.unreferenced_since !== null || row.trashed_at !== null) sql.clear.run(row.id)
    return restored
  }

  /** Removes an image row and its owners together. */
  function removeRow(id: string): void {
    transaction(db, () => {
      sql.remove.run(id)
      sql.removeOwners.run(id)
    })
  }

  /**
   * Whether this user may read the image with this file name. Checked before resolve(), which has
   * side effects (restoring from the trash): someone else's request must never keep an image alive.
   */
  function canRead(userId: string, name: string): boolean {
    const match = IMAGE_NAME.exec(name)
    if (!match) return false
    return sql.owns.get(match[1] as string, userId, match[2] as string) !== undefined
  }

  /** Stores an image whose type has already been checked, owned by `userId`. Returns its src. */
  function save(bytes: Uint8Array, type: ImageType, userId: string): { src: string } {
    const ext = IMAGE_TYPES[type]
    const id = createHash('sha256').update(bytes).digest('hex')
    const target = livePath(id, ext)
    if (!existsSync(target)) {
      const trashed = trashPath(id, ext)
      if (existsSync(trashed)) {
        renameSync(trashed, target)
      } else {
        const temp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`)
        writeFileSync(temp, bytes)
        renameSync(temp, target)
      }
    }
    // The row and its owner are written together, so an upload never leaves an image nobody can read.
    const time = now()
    transaction(db, () => {
      sql.upsert.run(id, ext, bytes.byteLength, time)
      sql.addOwner.run(id, time, userId)
    })
    return { src: `/api/images/${id}.${ext}` }
  }

  /** The file to serve for a name like "<sha256>.png", restoring it from the trash if needed. */
  function resolve(name: string): { path: string; type: ImageType } | null {
    const match = IMAGE_NAME.exec(name)
    if (!match) return null
    const [, id, ext] = match as unknown as [string, string, string]
    const type = CONTENT_TYPES[ext] as ImageType
    const live = livePath(id, ext)
    const row = sql.get.get(id) as ImageRow | undefined
    if (existsSync(live)) {
      // Something still shows this image; restart its unused clock.
      if (row && (row.trashed_at !== null || row.unreferenced_since !== null)) sql.clear.run(id)
      return { path: live, type }
    }
    if (!existsSync(trashPath(id, ext))) return null
    if (row) restore(row)
    else {
      renameSync(trashPath(id, ext), live)
      sql.insertFound.run(id, ext, statSync(live).size, now())
    }
    return { path: live, type }
  }

  /** Marks this user's images as still wanted, e.g. because a local draft references them. */
  function touch(userId: string, ids: Iterable<string>): void {
    for (const id of ids) {
      const row = sql.get.get(id) as ImageRow | undefined
      if (row && canRead(userId, `${row.id}.${row.ext}`)) restore(row)
    }
  }

  function referencedIds(): Set<string> {
    const ids = new Set<string>()
    for (const { content } of sql.noteContents.all() as Array<{ content: string }>) {
      for (const id of imageIdsIn(content)) ids.add(id)
    }
    return ids
  }

  // Repairs drift between files and rows, e.g. after a crash between writing a file and its row.
  function heal(time: number): number {
    let healed = 0
    for (const [folder, inTrash] of [
      [dir, false],
      [trashDir, true],
    ] as const) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const path = join(folder, entry.name)
        if (entry.name.startsWith('.tmp-')) {
          if (time - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true })
          continue
        }
        const match = IMAGE_NAME.exec(entry.name)
        if (!match) continue
        const stat = statSync(path)
        const inserted = sql.insertFound.run(match[1] as string, match[2] as string, stat.size, Math.round(stat.mtimeMs))
        if (inserted.changes > 0) {
          healed += 1
          // A file found in the trash gets a full trash period from now.
          if (inTrash) sql.markTrashed.run(time, match[1] as string)
        }
      }
    }
    for (const row of sql.all.all() as ImageRow[]) {
      if (!existsSync(livePath(row.id, row.ext)) && !existsSync(trashPath(row.id, row.ext))) {
        removeRow(row.id)
        healed += 1
      }
    }
    return healed
  }

  function sweep(): SweepResult {
    const time = now()
    const result: SweepResult = { marked: 0, trashed: 0, purged: 0, restored: 0, healed: heal(time) }
    const referenced = referencedIds()

    for (const row of sql.all.all() as ImageRow[]) {
      if (referenced.has(row.id)) {
        if (restore(row)) result.restored += 1
        continue
      }
      if (row.trashed_at !== null) {
        if (time - row.trashed_at >= TRASH_RETENTION_MS) {
          rmSync(trashPath(row.id, row.ext), { force: true })
          // A live copy means something restored it in the meantime; keep it.
          if (existsSync(livePath(row.id, row.ext))) sql.clear.run(row.id)
          else {
            removeRow(row.id)
            result.purged += 1
          }
        }
        continue
      }
      if (row.unreferenced_since === null) {
        sql.markUnreferenced.run(time, row.id)
        result.marked += 1
        continue
      }
      if (time - row.unreferenced_since >= UNREFERENCED_GRACE_MS) {
        const live = livePath(row.id, row.ext)
        if (existsSync(live)) renameSync(live, trashPath(row.id, row.ext))
        sql.markTrashed.run(time, row.id)
        result.trashed += 1
      }
    }
    return result
  }

  return { save, canRead, resolve, touch, sweep }
}

export type ImageStore = ReturnType<typeof createImageStore>
