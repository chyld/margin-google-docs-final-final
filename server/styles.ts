// Saved styles, per user. Text in notes refers to a style by id; the client turns definitions into
// a stylesheet. Deleting keeps the row (deleted_at) so styled text keeps its look.
import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalProps,
  cleanStyleName,
  cleanStyleProps,
  isUuid,
  MAX_STYLE_NAME,
  styleNameKey,
} from '../shared/styleProps.ts'
import type { NamedStyle, StyleProps } from '../shared/styleProps.ts'
import { transaction } from './db.ts'
import { HttpError } from './http.ts'

type StyleRow = {
  id: string
  user_id: string
  name: string
  props: string
  favorite_slot: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** Answers as { error, code } with its status. */
export class StyleError extends HttpError {
  declare readonly status: 400 | 404 | 409
  declare readonly code: string
  constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(status, message, code)
  }
}

function toStyle(row: StyleRow): NamedStyle {
  let props: StyleProps = {}
  try {
    props = cleanStyleProps(JSON.parse(row.props)) ?? {}
  } catch {
    // Stored by this code, so this doesn't happen; an empty style just renders nothing.
  }
  return {
    id: row.id,
    name: row.name,
    props,
    favoriteSlot: row.deleted_at === null ? row.favorite_slot : null,
    deleted: row.deleted_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

export type StyleInput = { id?: unknown; name?: unknown; props?: unknown; favorite?: unknown }

export function createStyleStore(db: DatabaseSync, now: () => number = Date.now) {
  const sql = {
    list: db.prepare('SELECT * FROM styles WHERE user_id = ? ORDER BY name_key, id'),
    get: db.prepare('SELECT * FROM styles WHERE user_id = ? AND id = ?'),
    insert: db.prepare(
      `INSERT INTO styles (id, user_id, name, name_key, props, favorite_slot, created_at, updated_at)
       SELECT :id, :userId, :name, :nameKey, :props, NULL, :now, :now WHERE EXISTS (SELECT 1 FROM users WHERE id = :userId)`,
    ),
    update: db.prepare(
      'UPDATE styles SET name = :name, name_key = :nameKey, props = :props, updated_at = :now WHERE user_id = :userId AND id = :id',
    ),
    usedSlots: db.prepare('SELECT favorite_slot FROM styles WHERE user_id = ? AND favorite_slot IS NOT NULL AND deleted_at IS NULL'),
    setSlot: db.prepare('UPDATE styles SET favorite_slot = ? WHERE user_id = ? AND id = ?'),
    softDelete: db.prepare(
      'UPDATE styles SET deleted_at = :now, favorite_slot = NULL, updated_at = :now WHERE user_id = :userId AND id = :id AND deleted_at IS NULL',
    ),
    nameTaken: db.prepare('SELECT 1 FROM styles WHERE user_id = ? AND name_key = ? AND deleted_at IS NULL AND id <> ?'),
  }

  function lowestFreeSlot(userId: string): number {
    const used = new Set((sql.usedSlots.all(userId) as Array<{ favorite_slot: number }>).map(row => row.favorite_slot))
    let slot = 1
    while (used.has(slot)) slot += 1
    return slot
  }

  function requireLive(userId: string, id: string): StyleRow {
    const row = isUuid(id) ? (sql.get.get(userId, id) as StyleRow | undefined) : undefined
    if (!row || row.deleted_at !== null) throw new StyleError(404, 'not_found', 'Style not found')
    return row
  }

  function name(value: unknown): string {
    const cleaned = cleanStyleName(value)
    if (!cleaned) throw new StyleError(400, 'invalid_name', `Style names need 1–${MAX_STYLE_NAME} characters`)
    return cleaned
  }

  function props(value: unknown): StyleProps {
    const cleaned = cleanStyleProps(value)
    if (!cleaned) throw new StyleError(400, 'invalid_props', 'That formatting can’t be saved as a style')
    return cleaned
  }

  return {
    list(userId: string): NamedStyle[] {
      return (sql.list.all(userId) as StyleRow[]).map(toStyle)
    },

    /**
     * Creates a style with a client-chosen id (so the client can apply it right away). Sending the
     * same id again returns the existing style instead of failing (safe retries).
     */
    create(userId: string, input: StyleInput): { style: NamedStyle; created: boolean } | null {
      if (!isUuid(input.id)) throw new StyleError(400, 'invalid_id', 'A style needs a valid id')
      const id = input.id
      const styleName = name(input.name)
      const styleProps = props(input.props)
      return transaction(db, () => {
        const existing = sql.get.get(userId, id) as StyleRow | undefined
        if (existing) {
          // A retry of the very same request is fine; anything else reusing the id is not.
          const same =
            existing.deleted_at === null && existing.name === styleName && existing.props === JSON.stringify(canonicalProps(styleProps))
          if (!same) throw new StyleError(409, 'id_in_use', 'That style id is already used')
          return { style: toStyle(existing), created: false }
        }
        if (sql.nameTaken.get(userId, styleNameKey(styleName), id)) {
          throw new StyleError(409, 'name_taken', `You already have a style called “${styleName}”`)
        }
        try {
          const result = sql.insert.run({
            id,
            userId,
            name: styleName,
            nameKey: styleNameKey(styleName),
            props: JSON.stringify(canonicalProps(styleProps)),
            now: now(),
          })
          if (result.changes === 0) return null // the user was deleted meanwhile
        } catch (error) {
          if (isUniqueViolation(error)) throw new StyleError(409, 'name_taken', `You already have a style called “${styleName}”`)
          throw error
        }
        return { style: toStyle(sql.get.get(userId, id) as StyleRow), created: true }
      })
    },

    update(userId: string, id: string, input: StyleInput): NamedStyle {
      return transaction(db, () => {
        const row = requireLive(userId, id)
        const styleName = input.name === undefined ? row.name : name(input.name)
        const styleProps = input.props === undefined ? JSON.parse(row.props) : props(input.props)
        if (input.name !== undefined || input.props !== undefined) {
          if (sql.nameTaken.get(userId, styleNameKey(styleName), id)) {
            throw new StyleError(409, 'name_taken', `You already have a style called “${styleName}”`)
          }
          try {
            sql.update.run({
              id,
              userId,
              name: styleName,
              nameKey: styleNameKey(styleName),
              props: JSON.stringify(canonicalProps(styleProps)),
              now: now(),
            })
          } catch (error) {
            if (isUniqueViolation(error)) throw new StyleError(409, 'name_taken', `You already have a style called “${styleName}”`)
            throw error
          }
        }
        if (input.favorite !== undefined) {
          if (typeof input.favorite !== 'boolean') throw new StyleError(400, 'invalid_favorite', 'favorite must be true or false')
          const current = (sql.get.get(userId, id) as StyleRow).favorite_slot
          // Starring takes the lowest free slot; other favorites keep theirs (stable shortcuts).
          if (input.favorite && current === null) sql.setSlot.run(lowestFreeSlot(userId), userId, id)
          if (!input.favorite && current !== null) sql.setSlot.run(null, userId, id)
        }
        return toStyle(sql.get.get(userId, id) as StyleRow)
      })
    },

    delete(userId: string, id: string): void {
      if (!isUuid(id) || sql.softDelete.run({ userId, id, now: now() }).changes === 0) {
        throw new StyleError(404, 'not_found', 'Style not found')
      }
    },
  }
}

export type StyleStore = ReturnType<typeof createStyleStore>

/**
 * An account's saved styles, for moving or deleting the account (server/users.ts). Runs inside the
 * caller's transaction.
 */
export function styleOwnership(db: DatabaseSync) {
  const sql = {
    countLive: db.prepare('SELECT COUNT(*) AS n FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    deleteAll: db.prepare('DELETE FROM styles WHERE user_id = ?'),
    stylesOf: db.prepare('SELECT id, name, favorite_slot, deleted_at FROM styles WHERE user_id = ? ORDER BY favorite_slot, created_at'),
    liveNameKeys: db.prepare('SELECT name_key FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    maxSlot: db.prepare('SELECT MAX(favorite_slot) AS n FROM styles WHERE user_id = ? AND deleted_at IS NULL'),
    moveStyle: db.prepare(
      'UPDATE styles SET user_id = :to, name = :name, name_key = :nameKey, favorite_slot = :slot WHERE user_id = :from AND id = :id',
    ),
    dropStyle: db.prepare('DELETE FROM styles WHERE user_id = ? AND id = ?'),
    styleExists: db.prepare('SELECT 1 FROM styles WHERE user_id = ? AND id = ?'),
  }
  return {
    /** Styles that aren't deleted. */
    countOwned(userId: string): number {
      return Number((sql.countLive.get(userId) as { n: number }).n)
    },
    /**
     * Moves every style from one user to another, keeping ids (so styled text stays linked). Name
     * clashes get " (2)", " (3)"…; favorites go after the target's own. Returns how many live styles moved.
     */
    transferOwned(fromId: string, toId: string): number {
      const taken = new Set((sql.liveNameKeys.all(toId) as Array<{ name_key: string }>).map(row => row.name_key))
      let slot = Number((sql.maxSlot.get(toId) as { n: number | null }).n ?? 0)
      const rows = sql.stylesOf.all(fromId) as Array<{ id: string; name: string; favorite_slot: number | null; deleted_at: number | null }>
      let moved = 0
      for (const row of rows) {
        // The same id already at the target (e.g. moved there before): keep the target's copy.
        if (sql.styleExists.get(toId, row.id)) {
          sql.dropStyle.run(fromId, row.id)
          continue
        }
        let name = row.name
        if (row.deleted_at === null) {
          for (let n = 2; taken.has(styleNameKey(name)); n += 1) {
            const suffix = ` (${n})`
            name = [...row.name].slice(0, MAX_STYLE_NAME - suffix.length).join('').trimEnd() + suffix
          }
          taken.add(styleNameKey(name))
        }
        const newSlot = row.deleted_at === null && row.favorite_slot !== null ? ++slot : null
        sql.moveStyle.run({ from: fromId, to: toId, id: row.id, name, nameKey: styleNameKey(name), slot: newSlot })
        if (row.deleted_at === null) moved += 1
      }
      return moved
    },
    deleteOwned(userId: string): void {
      sql.deleteAll.run(userId)
    },
  }
}
