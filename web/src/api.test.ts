import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, bindUser, setAuthFailureHandler, StaleSessionError } from './api.ts'

type Pending = { url: string; init: RequestInit; respond: (status: number, body?: unknown) => void }

function stubFetch() {
  const pending: Pending[] = []
  vi.stubGlobal(
    'fetch',
    (url: string, init: RequestInit) =>
      new Promise<Response>(resolve => {
        pending.push({
          url,
          init,
          respond: (status, body = {}) =>
            resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
        })
      }),
  )
  return pending
}

afterEach(() => {
  vi.unstubAllGlobals()
  setAuthFailureHandler(null)
  bindUser(null)
})

describe('api: accounts', () => {
  it('names the expected account on every signed-in request, but not on sign-in', async () => {
    const pending = stubFetch()
    bindUser('user-1')
    const list = api.listNotes('')
    expect(new Headers(pending[0]?.init.headers).get('X-Margin-User')).toBe('user-1')
    pending[0]?.respond(200, [])
    await list
    const login = api.login('a', 'b')
    expect(new Headers(pending[1]?.init.headers).get('X-Margin-User')).toBeNull()
    pending[1]?.respond(200, { user: { id: 'user-1', username: 'a' } })
    await login
  })

  it('reports a 401 for the current session, and ignores one for a session a sign-in replaced', async () => {
    const pending = stubFetch()
    const failures: number[] = []
    setAuthFailureHandler(failure => failures.push(failure.status))

    // In flight with the old cookie while the user signs in again.
    const save = api.updateNote('n1', { title: 'x' })
    const login = api.login('alice', 'pw')
    pending[1]?.respond(200, { user: { id: 'u', username: 'alice' } })
    await login
    pending[0]?.respond(401, { error: 'Sign in required' })
    const error = await save.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StaleSessionError)
    // No status: the save queue retries it like a network error.
    expect((error as { status?: unknown }).status).toBeUndefined()
    expect(failures).toEqual([])

    // A request sent after the sign-in that gets 401 really means signed out.
    const later = api.updateNote('n1', { title: 'y' })
    pending[2]?.respond(401, { error: 'Sign in required' })
    expect(await later.catch((caught: unknown) => caught)).toBeInstanceOf(ApiError)
    expect(failures).toEqual([401])
  })

  it('treats only a user_mismatch 409 as an account problem', async () => {
    const pending = stubFetch()
    const failures: number[] = []
    setAuthFailureHandler(failure => failures.push(failure.status))
    const taken = api.listNotes('')
    pending[0]?.respond(409, { error: 'You already have a style called “A”', code: 'name_taken' })
    const error = (await taken.catch((caught: unknown) => caught)) as ApiError
    expect(error.isAuthFailure).toBe(false)
    expect(failures).toEqual([])
    const switched = api.listNotes('')
    pending[1]?.respond(409, { error: 'someone else', code: 'user_mismatch' })
    expect(((await switched.catch((caught: unknown) => caught)) as ApiError).isAuthFailure).toBe(true)
    expect(failures).toEqual([409])
  })

  it('carries Retry-After and the error body', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'Too many attempts', retryAfter: 120 }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      }),
    )
    const error = (await api.login('a', 'b').catch((caught: unknown) => caught)) as ApiError
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe(120)
    expect(error.body).toMatchObject({ retryAfter: 120 })
  })
})
