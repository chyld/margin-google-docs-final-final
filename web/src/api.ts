import type { ApiErrorBody, CreateNoteBody, Note, NoteSummary, TagCount, UpdateNoteBody } from '../../shared/types.ts'
import type { NamedStyle, StyleProps } from '../../shared/styleProps.ts'
import { MAX_TAGS, parseTagQuery } from '../../shared/tags.ts'
import { isAuthFailure } from './notes/authFailure.ts'

export class ApiError extends Error {
  status: number
  /** The parsed JSON error body, when there was one. */
  body: Record<string, unknown> | null
  /** Seconds from a Retry-After header (429/503), if any. */
  retryAfter: number | null

  constructor(status: number, message: string, body: Record<string, unknown> | null = null, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }

  /** The session ended or belongs to another account now (see notes/authFailure.ts). */
  get isAuthFailure(): boolean {
    return isAuthFailure(this)
  }
}

export type User = { id: string; username: string }
export type Me = { user: User }

// ---- account binding ----
// Every signed-in request names the account this page belongs to. If the browser's session is now
// someone else's (another tab signed in as a different user), the server answers 409 instead of
// acting on the wrong account.
let expectedUserId: string | null = null
type AuthFailure = { status: 401 | 409 }
let onAuthFailure: ((failure: AuthFailure) => void) | null = null

// Bumped by every successful sign-in. A request sent before it went out with the old (now revoked)
// cookie; its 401/409 says nothing about the new session and must not end it again.
let authEpoch = 0

/** A request failed only because it was sent with the session that a new sign-in replaced. Retry it. */
export class StaleSessionError extends Error {
  constructor() {
    super('The session changed while this was being sent; trying again')
    this.name = 'StaleSessionError'
  }
}

export function bindUser(id: string | null): void {
  expectedUserId = id
}

/** Called on 401 (session ended) or 409 (another account), except for the auth routes themselves. */
export function setAuthFailureHandler(handler: ((failure: AuthFailure) => void) | null): void {
  onAuthFailure = handler
}

const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me'])

type RequestOptions = {
  body?: unknown
  /** Sent as-is with its own type instead of as JSON (image uploads). */
  file?: Blob
  keepalive?: boolean
  signal?: AbortSignal
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (options.file) {
    headers['Content-Type'] = options.file.type
    body = options.file
  } else if (hasBody) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const isAuthPath = AUTH_PATHS.has(path)
  const sentInEpoch = authEpoch
  if (expectedUserId && !isAuthPath) headers['X-Margin-User'] = expectedUserId
  const response = await fetch(path, {
    method,
    headers,
    body,
    keepalive: options.keepalive,
    signal: options.signal,
  })

  if (!response.ok) {
    let message = response.statusText || `Request failed (${response.status})`
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = (await response.json()) as Record<string, unknown>
      const error = (parsed as Partial<ApiErrorBody>).error
      if (typeof error === 'string' && error) message = error
    } catch {
      // Not JSON; keep the status text.
    }
    const retryHeader = Number(response.headers.get('retry-after'))
    const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null
    const error = new ApiError(response.status, message, parsed, retryAfter)
    if (!isAuthPath && error.isAuthFailure) {
      // No status on purpose: the save queue retries it like a network error, with the new cookie.
      if (sentInEpoch !== authEpoch) throw new StaleSessionError()
      onAuthFailure?.({ status: response.status as 401 | 409 })
    }
    throw error
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  me(): Promise<Me> {
    return request('GET', '/api/auth/me')
  },

  async login(username: string, password: string): Promise<{ user: User }> {
    const result = await request<{ user: User }>('POST', '/api/auth/login', { body: { username, password } })
    authEpoch += 1
    return result
  },

  logout(): Promise<void> {
    return request('POST', '/api/auth/logout', { body: {} })
  },

  /** `#tag` words in the query become tag filters (all must match); the rest is text search. */
  listNotes(query: string): Promise<NoteSummary[]> {
    const { tags, text } = parseTagQuery(query)
    // No note carries more than MAX_TAGS tags, so a filter asking for more matches nothing.
    if (tags.length > MAX_TAGS) return Promise.resolve([])
    const params = new URLSearchParams()
    if (text) params.set('q', text)
    for (const tag of tags) params.append('tag', tag)
    const search = params.toString()
    return request('GET', `/api/notes${search ? `?${search}` : ''}`)
  },

  /** Every tag the user has, with counts (most used first). */
  async listTags(): Promise<TagCount[]> {
    return ((await request('GET', '/api/tags')) as { tags: TagCount[] }).tags
  },

  getNote(id: string, signal?: AbortSignal): Promise<Note> {
    return request('GET', `/api/notes/${encodeURIComponent(id)}`, { signal })
  },

  createNote(body: CreateNoteBody = {}): Promise<Note> {
    return request('POST', '/api/notes', { body })
  },

  updateNote(id: string, patch: UpdateNoteBody, init?: { keepalive?: boolean }): Promise<NoteSummary> {
    return request('PATCH', `/api/notes/${encodeURIComponent(id)}`, { body: patch, keepalive: init?.keepalive })
  },

  deleteNote(id: string): Promise<void> {
    return request('DELETE', `/api/notes/${encodeURIComponent(id)}`)
  },

  uploadImage(file: Blob, signal?: AbortSignal): Promise<{ src: string }> {
    return request('POST', '/api/images', { file, signal })
  },

  /** Tells the server these images are still wanted (they're referenced by local drafts). */
  touchImages(ids: string[]): Promise<void> {
    return request('POST', '/api/images/touch', { body: { ids } })
  },

  listStyles(): Promise<{ styles: NamedStyle[] }> {
    return request('GET', '/api/styles')
  },

  createStyle(style: { id: string; name: string; props: StyleProps }): Promise<NamedStyle> {
    return request('POST', '/api/styles', { body: style })
  },

  updateStyle(id: string, patch: { name?: string; props?: StyleProps; favorite?: boolean }): Promise<NamedStyle> {
    return request('PATCH', `/api/styles/${encodeURIComponent(id)}`, { body: patch })
  },

  deleteStyle(id: string): Promise<void> {
    return request('DELETE', `/api/styles/${encodeURIComponent(id)}`)
  },

  getFontFavorites(): Promise<{ families: string[] }> {
    return request('GET', '/api/fonts/favorites')
  },

  setFontFavorites(families: string[]): Promise<{ families: string[] }> {
    return request('PUT', '/api/fonts/favorites', { body: { families } })
  },
}
