import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { LIST_LIMIT, MAX_QUERY_LENGTH } from '../shared/constants.ts'
import { EMPTY_DOC, makeSnippet } from '../shared/doc.ts'
import type { DocJSON, Note, NoteSummary, TagCount } from '../shared/types.ts'
import { transaction } from './db.ts'

type NoteRow = {
  id: string
  title: string
  content: string
  created_at: number
  updated_at: number
}

type SummaryRow = {
  id: string
  title: string
  text: string
  updated_at: number
}

export type NoteChanges = {
  title?: string
  content?: DocJSON
  text?: string
  /** Already normalized (shared/tags.ts normalizeTags): replaces the note's tags. */
  tags?: string[]
}


// Escape LIKE wildcards; pairs with `ESCAPE '\'` in the query.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function toNote(row: NoteRow, tags: string[]): Note {
  return {
    id: row.id,
    title: row.title,
    content: JSON.parse(row.content) as DocJSON,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSummary(row: SummaryRow, tags: string[]): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    snippet: makeSnippet(row.text),
    tags,
    updatedAt: row.updated_at,
  }
}

/**
 * Note queries for one user. Every statement is scoped by user_id, so a note id from another
 * account behaves exactly like a missing note.
 */
export function createNoteStore(db: DatabaseSync) {
  // Only the start of the text is needed for a snippet.
  const listAll = db.prepare(`
    SELECT id, title, substr(text, 1, 400) AS text, updated_at
    FROM notes
    WHERE user_id = :userId
    ORDER BY updated_at DESC, id DESC
    LIMIT ${LIST_LIMIT}
  `)
  const getOne = db.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = :id AND user_id = :userId',
  )
  // Inserts nothing if the user was deleted (e.g. by margin-user) after the request was authenticated.
  const insert = db.prepare(`
    INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id)
    SELECT :id, :title, :content, '', :now, :now, :userId WHERE EXISTS (SELECT 1 FROM users WHERE id = :userId)
  `)
  const remove = db.prepare('DELETE FROM notes WHERE id = :id AND user_id = :userId')
  const returning = 'RETURNING id, title, substr(text, 1, 400) AS text, updated_at'
  const scope = 'WHERE id = :id AND user_id = :userId'
  const updateTitle = db.prepare(`UPDATE notes SET title = :title, updated_at = :now ${scope} ${returning}`)
  const updateContent = db.prepare(
    `UPDATE notes SET content = :content, text = :text, updated_at = :now ${scope} ${returning}`,
  )
  const updateBoth = db.prepare(
    `UPDATE notes SET title = :title, content = :content, text = :text, updated_at = :now ${scope} ${returning}`,
  )
  const touch = db.prepare(`UPDATE notes SET updated_at = :now ${scope} ${returning}`)
  const summaryOf = db.prepare(`SELECT id, title, substr(text, 1, 400) AS text, updated_at FROM notes ${scope}`)

  // Tags. Rows carry the owner's user_id; every statement is scoped by it.
  const tagsOf = db.prepare('SELECT tag FROM note_tags WHERE note_id = :id AND user_id = :userId ORDER BY tag')
  const tagsOfMany = db.prepare(`
    SELECT note_id, tag FROM note_tags
    WHERE user_id = :userId AND note_id IN (SELECT value FROM json_each(:ids))
    ORDER BY tag
  `)
  const clearTags = db.prepare('DELETE FROM note_tags WHERE note_id = :id AND user_id = :userId')
  const addTag = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, user_id, tag) VALUES (:id, :userId, :tag)')
  const tagCounts = db.prepare(
    'SELECT tag, COUNT(*) AS count FROM note_tags WHERE user_id = :userId GROUP BY tag ORDER BY count DESC, tag',
  )

  // The list, optionally narrowed by text and by tags (all of them). Cached per shape.
  const listStatements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  function listStatement(text: boolean, tagCount: number) {
    const key = `${text}:${tagCount}`
    let statement = listStatements.get(key)
    if (!statement) {
      const conditions = ['user_id = :userId']
      // The parentheses matter: without them the OR would escape the user filter.
      if (text) conditions.push(`(title LIKE :pattern ESCAPE '\\' OR text LIKE :pattern ESCAPE '\\')`)
      for (let index = 0; index < tagCount; index += 1) {
        conditions.push(
          `EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = notes.id AND t.user_id = :userId AND t.tag = :tag${index})`,
        )
      }
      statement = db.prepare(`
        SELECT id, title, substr(text, 1, 400) AS text, updated_at
        FROM notes
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC, id DESC
        LIMIT ${LIST_LIMIT}
      `)
      listStatements.set(key, statement)
    }
    return statement
  }

  return {
    forUser(userId: string) {
      function tagsFor(id: string): string[] {
        return (tagsOf.all({ id, userId }) as Array<{ tag: string }>).map(row => row.tag)
      }

      function summaries(rows: SummaryRow[]): NoteSummary[] {
        const byNote = new Map<string, string[]>()
        if (rows.length > 0) {
          for (const row of tagsOfMany.all({ userId, ids: JSON.stringify(rows.map(r => r.id)) }) as Array<{ note_id: string; tag: string }>) {
            const list = byNote.get(row.note_id)
            if (list) list.push(row.tag)
            else byNote.set(row.note_id, [row.tag])
          }
        }
        return rows.map(row => toSummary(row, byNote.get(row.id) ?? []))
      }

      function get(id: string): Note | null {
        const row = getOne.get({ id, userId }) as NoteRow | undefined
        return row ? toNote(row, tagsFor(id)) : null
      }

      return {
        get,

        /** Newest first; `query` matches title or text, and every tag in `tags` must be on the note. */
        list(query = '', tags: readonly string[] = []): NoteSummary[] {
          const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
          if (!trimmed && tags.length === 0) return summaries(listAll.all({ userId }) as SummaryRow[])
          const params: Record<string, string> = { userId }
          if (trimmed) params.pattern = `%${escapeLike(trimmed)}%`
          tags.forEach((tag, index) => {
            params[`tag${index}`] = tag
          })
          return summaries(listStatement(Boolean(trimmed), tags.length).all(params) as SummaryRow[])
        },

        /** Every tag the user has, with how many notes carry it (most used first). */
        tagCounts(): TagCount[] {
          return (tagCounts.all({ userId }) as Array<{ tag: string; count: number }>).map(row => ({
            tag: row.tag,
            count: Number(row.count),
          }))
        },

        /** Creates a note, or returns null when the user no longer exists. */
        create(title = ''): Note | null {
          const id = randomUUID()
          const result = insert.run({ id, title, content: JSON.stringify(EMPTY_DOC), now: Date.now(), userId })
          return result.changes > 0 ? get(id) : null
        },

        /** Applies the changes and returns the updated summary, or null when the note doesn't exist. */
        update(id: string, changes: NoteChanges): NoteSummary | null {
          const hasTitle = changes.title !== undefined
          const hasContent = changes.content !== undefined
          const hasTags = changes.tags !== undefined
          if (!hasTitle && !hasContent && !hasTags) return null

          // One transaction: the ownership check, the tag rows and the note row change together.
          return transaction(db, () => {
            const now = Date.now()
            const base = { id, userId, now }
            // Checked first, so a foreign or missing note id never gets tag rows.
            if (!summaryOf.get({ id, userId })) return null
            let tagsChanged = false
            if (hasTags) {
              const next = changes.tags as string[]
              const current = tagsFor(id)
              tagsChanged = current.length !== next.length || current.some((tag, index) => tag !== next[index])
              if (tagsChanged) {
                clearTags.run({ id, userId })
                for (const tag of next) addTag.run({ id, userId, tag })
              }
            }
            let row: unknown
            if (hasTitle && hasContent) {
              row = updateBoth.get({ ...base, title: changes.title as string, content: JSON.stringify(changes.content), text: changes.text ?? '' })
            } else if (hasTitle) {
              row = updateTitle.get({ ...base, title: changes.title as string })
            } else if (hasContent) {
              row = updateContent.get({ ...base, content: JSON.stringify(changes.content), text: changes.text ?? '' })
            } else {
              // Tags only: a real change counts as an edit; an identical set changes nothing.
              row = tagsChanged ? touch.get(base) : summaryOf.get({ id, userId })
            }
            return row ? toSummary(row as SummaryRow, tagsFor(id)) : null
          })
        },

        delete(id: string): boolean {
          return transaction(db, () => {
            clearTags.run({ id, userId })
            return remove.run({ id, userId }).changes > 0
          })
        },
      }
    },
  }
}

export type NoteStore = ReturnType<typeof createNoteStore>
export type UserNotes = ReturnType<NoteStore['forUser']>

/**
 * An account's notes (and their tags), for moving or deleting the account (server/users.ts). Plain
 * statements: they run inside the caller's transaction and never open one.
 */
export function noteOwnership(db: DatabaseSync) {
  const sql = {
    count: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?'),
    moveNotes: db.prepare('UPDATE notes SET user_id = ? WHERE user_id = ?'),
    moveTags: db.prepare('UPDATE note_tags SET user_id = ? WHERE user_id = ?'),
    deleteTags: db.prepare('DELETE FROM note_tags WHERE user_id = ?'),
    deleteNotes: db.prepare('DELETE FROM notes WHERE user_id = ?'),
  }
  return {
    countOwned(userId: string): number {
      return Number((sql.count.get(userId) as { n: number }).n)
    },
    /** Returns how many notes moved. */
    transferOwned(fromId: string, toId: string): number {
      const moved = Number(sql.moveNotes.run(toId, fromId).changes)
      sql.moveTags.run(toId, fromId)
      return moved
    },
    deleteOwned(userId: string): void {
      sql.deleteTags.run(userId)
      sql.deleteNotes.run(userId)
    },
  }
}
