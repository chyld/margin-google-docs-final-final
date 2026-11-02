// What every route shares: the signed-in context, request-body parsing, and errors that map to a
// JSON response (app.ts onError turns an HttpError into { error } or { error, code }).
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import type { SessionUser } from './auth.ts'

/** Routes under /api run with the signed-in user set (public routes may not have one). */
export type Env = { Variables: { user: SessionUser } }

/** An error a route answers with: its status, its message, and (for some) a machine-readable code. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: string | undefined
  constructor(status: ContentfulStatusCode, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The JSON body checked against `schema`, or the first problem as a readable message. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { ok: false, error: 'Request body must be valid JSON' }
  }
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  return { ok: false, error: `${where}${issue?.message ?? 'invalid body'}` }
}
