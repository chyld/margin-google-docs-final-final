// /api/notes and /api/tags: the signed-in user's notes, search, and tag counts.
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { MAX_TITLE_LENGTH } from '../../shared/constants.ts'
import { inspectDoc } from '../../shared/doc.ts'
import { checkSchema } from '../../shared/schema.ts'
import { isValidTag, MAX_TAGS, normalizeTag, normalizeTags } from '../../shared/tags.ts'
import type { DocJSON } from '../../shared/types.ts'
import { parseBody } from '../http.ts'
import type { Env } from '../http.ts'
import type { NoteChanges, NoteStore } from '../notes.ts'

const idSchema = z.uuid()
const createSchema = z.strictObject({
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
})
const updateSchema = z
  .strictObject({
    title: z.string().max(MAX_TITLE_LENGTH).optional(),
    // Checked by inspectDoc; z.unknown() keeps the whole document instead of stripping it.
    content: z.unknown().optional(),
    // Checked by normalizeTags (shared/tags.ts): replaces the note's tags; [] clears them.
    tags: z.array(z.unknown()).max(MAX_TAGS * 5).optional(),
  })
  .refine(body => body.title !== undefined || body.content !== undefined || body.tags !== undefined, {
    message: 'provide title, content or tags',
  })

export function registerNoteRoutes(api: Hono<Env>, { notes }: { notes: NoteStore }): void {
  const userNotes = (c: Context<Env>) => notes.forUser(c.get('user').id)

  // ?q= matches title or text; each ?tag= must be on the note (the client takes #tags out of the search).
  api.get('/notes', c => {
    const tags = [...new Set((c.req.queries('tag') ?? []).map(normalizeTag))]
    if (tags.length > MAX_TAGS || !tags.every(isValidTag)) return c.json({ error: 'Invalid tag filter' }, 400)
    return c.json(userNotes(c).list(c.req.query('q') ?? '', tags))
  })

  api.get('/tags', c => c.json({ tags: userNotes(c).tagCounts() }))

  api.post('/notes', async c => {
    const body = await parseBody(c, createSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const note = userNotes(c).create(body.value.title)
    if (!note) return c.json({ error: 'Sign in required' }, 401)
    return c.json(note, 201)
  })

  api.get('/notes/:id', c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)
    const note = userNotes(c).get(id)
    if (!note) return c.json({ error: 'Note not found' }, 404)
    return c.json(note)
  })

  api.patch('/notes/:id', async c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)

    const body = await parseBody(c, updateSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)

    const changes: NoteChanges = { title: body.value.title }
    if (body.value.tags !== undefined) {
      const tags = normalizeTags(body.value.tags)
      if (!tags.ok) return c.json({ error: `tags: ${tags.error}` }, 400)
      changes.tags = tags.tags
    }
    if (body.value.content !== undefined) {
      // Store the cleaned copy: unsafe colors and links are stripped instead of failing the save.
      const inspected = inspectDoc(body.value.content)
      if (!inspected.ok) return c.json({ error: `content: ${inspected.error}` }, 400)
      const structure = checkSchema(inspected.doc)
      if (!structure.ok) return c.json({ error: `content: ${structure.error}` }, 400)
      changes.content = inspected.doc as DocJSON
      changes.text = inspected.text
    }

    const summary = userNotes(c).update(id, changes)
    if (!summary) return c.json({ error: 'Note not found' }, 404)
    return c.json(summary)
  })

  api.delete('/notes/:id', c => {
    const id = c.req.param('id')
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Invalid note id' }, 400)
    if (!userNotes(c).delete(id)) return c.json({ error: 'Note not found' }, 404)
    return c.body(null, 204)
  })
}
