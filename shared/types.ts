// Shapes shared by the API and the web app. Type-only: import with `import type`.

/** A Tiptap/ProseMirror JSON document. */
export type DocJSON = {
  type: 'doc'
  content?: unknown[]
  [key: string]: unknown
}

/** A full note, as returned by GET /api/notes/:id and POST /api/notes. */
export type Note = {
  id: string
  title: string
  content: DocJSON
  /** Sorted A–Z (shared/tags.ts). */
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** A tag and how many of the user's notes carry it (GET /api/tags). */
export type TagCount = { tag: string; count: number }

/** A row in the notes list, also returned by PATCH /api/notes/:id. */
export type NoteSummary = {
  id: string
  title: string
  snippet: string
  tags: string[]
  updatedAt: number
}

export type CreateNoteBody = {
  title?: string
}

export type UpdateNoteBody = {
  title?: string
  content?: DocJSON
  /** Replaces the note's tags; [] clears them. */
  tags?: string[]
}

export type ApiErrorBody = {
  error: string
}
