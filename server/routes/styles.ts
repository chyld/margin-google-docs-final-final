// /api/styles: the user's saved styles. A StyleError thrown here becomes { error, code } with its
// status (app.ts onError).
import type { Hono } from 'hono'
import { z } from 'zod'
import { parseBody } from '../http.ts'
import type { Env } from '../http.ts'
import type { StyleStore } from '../styles.ts'

const createStyleSchema = z.strictObject({
  id: z.string().max(64),
  name: z.string().max(400),
  props: z.unknown(),
})
const updateStyleSchema = z
  .strictObject({
    name: z.string().max(400).optional(),
    props: z.unknown().optional(),
    favorite: z.boolean().optional(),
  })
  .refine(body => body.name !== undefined || body.props !== undefined || body.favorite !== undefined, {
    message: 'provide name, props or favorite',
  })

export function registerStyleRoutes(api: Hono<Env>, { styles }: { styles: StyleStore }): void {
  api.get('/styles', c => c.json({ styles: styles.list(c.get('user').id) }))

  api.post('/styles', async c => {
    const body = await parseBody(c, createStyleSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const result = styles.create(c.get('user').id, body.value)
    if (!result) return c.json({ error: 'Sign in required' }, 401)
    return c.json(result.style, result.created ? 201 : 200)
  })

  api.patch('/styles/:id', async c => {
    const body = await parseBody(c, updateStyleSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    return c.json(styles.update(c.get('user').id, c.req.param('id'), body.value))
  })

  api.delete('/styles/:id', c => {
    styles.delete(c.get('user').id, c.req.param('id'))
    return c.body(null, 204)
  })
}
