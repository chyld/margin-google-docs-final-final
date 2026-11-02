// /api/images: uploads (raw bytes, checked by signature), keeping draft images alive, and serving.
import { readFile } from 'node:fs/promises'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { IMAGE_ID, isImageType, MAX_IMAGE_BYTES } from '../../shared/imageRules.ts'
import { parseBody } from '../http.ts'
import type { Env } from '../http.ts'
import { sniffImageType } from '../images.ts'
import type { ImageStore } from '../images.ts'

const touchSchema = z.strictObject({
  ids: z.array(z.string().regex(IMAGE_ID)).max(500),
})

export function registerImageRoutes(api: Hono<Env>, { images }: { images: ImageStore }): void {
  api.post(
    '/images',
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES,
      onError: c => c.json({ error: 'Images can be up to 10 MB' }, 413),
    }),
    async c => {
      const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!isImageType(type)) return c.json({ error: 'Images must be PNG, JPEG, GIF or WebP' }, 415)
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.byteLength === 0) return c.json({ error: 'The image is empty' }, 400)
      if (sniffImageType(bytes) !== type) {
        return c.json({ error: 'The file is not a valid PNG, JPEG, GIF or WebP image' }, 415)
      }
      return c.json(images.save(bytes, type, c.get('user').id), 201)
    },
  )

  api.post('/images/touch', async c => {
    const body = await parseBody(c, touchSchema)
    if (!body.ok) return c.json({ error: body.error }, 400)
    images.touch(c.get('user').id, body.value.ids)
    return c.body(null, 204)
  })

  api.get('/images/:name', async c => {
    const name = c.req.param('name')
    // Ownership first: resolve() restores trashed files, which only the owner may cause.
    if (!images.canRead(c.get('user').id, name)) return c.json({ error: 'Image not found' }, 404)
    // Revalidated on every view (a cheap 304), so the ownership check always runs.
    const etag = `"${name.split('.')[0]}"`
    const cacheHeaders = { 'Cache-Control': 'private, no-cache', ETag: etag }
    if (c.req.header('if-none-match') === etag) {
      images.resolve(name)
      return c.body(null, 304, cacheHeaders)
    }
    const found = images.resolve(name)
    if (!found) return c.json({ error: 'Image not found' }, 404)
    // A sweep may move the file to the trash while it's being read; resolving again restores it.
    const bytes =
      (await readFile(found.path).catch(() => null)) ??
      (await (async () => {
        const again = images.resolve(name)
        return again ? readFile(again.path).catch(() => null) : null
      })())
    if (!bytes) return c.json({ error: 'Image not found' }, 404)
    return c.body(bytes, 200, { 'Content-Type': found.type, ...cacheHeaders })
  })
}
