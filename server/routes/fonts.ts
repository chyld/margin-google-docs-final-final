// /api/fonts: Google Fonts stylesheets and files through Margin's cache, and the user's favorites.
// A FontError thrown here becomes { error } with its status (app.ts onError).
import { readFile } from 'node:fs/promises'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { FontKind, FontService } from '../fonts.ts'
import { parseBody } from '../http.ts'
import type { Env } from '../http.ts'
import { MAX_FAVORITES } from '../settings.ts'
import type { SettingsStore } from '../settings.ts'

const favoritesSchema = z.strictObject({
  families: z.array(z.string().max(100)).max(MAX_FAVORITES),
})

export function registerFontRoutes(api: Hono<Env>, { fonts, settings }: { fonts: FontService; settings: SettingsStore }): void {
  const stylesheetRoute = (kind: FontKind) => async (c: Context) => {
    const css = await fonts.stylesheet(c.req.query('family') ?? '', kind)
    return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' })
  }
  api.get('/fonts/css', stylesheetRoute('full'))
  api.get('/fonts/preview', stylesheetRoute('preview'))

  api.get('/fonts/file/:slug/:file', async c => {
    const found = await fonts.fontFile(c.req.param('slug'), c.req.param('file'))
    const bytes = await readFile(found.path).catch(() => null)
    if (!bytes) return c.json({ error: 'Unknown font file' }, 404)
    return c.body(bytes, 200, { 'Content-Type': found.type, 'Cache-Control': 'public, max-age=31536000, immutable' })
  })

  api.get('/fonts/favorites', c => c.json({ families: settings.readFavorites(c.get('user').id, fonts.knows) }))

  api.put('/fonts/favorites', async c => {
    const body = await parseBody(c, favoritesSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const result = settings.writeFavorites(c.get('user').id, body.value.families, fonts.knows)
    return result.ok ? c.json({ families: result.families }) : c.json({ error: result.error }, 400)
  })
}
