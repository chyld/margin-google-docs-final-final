import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../shared/types.ts'
import { createSaveQueue, DRAFT_DELAY_MS, isRetryable, KEEPALIVE_LIMIT_BYTES } from './saveQueue.ts'
import type { SavePatch } from './saveQueue.ts'
import { decideDraft } from './drafts.ts'
import type { Draft } from './drafts.ts'

const DRAFT_PREFIX = 'margin:draft:test-user:'

type Call = {
  id: string
  patch: SavePatch
  keepalive: boolean
  resolve: (summary?: Partial<NoteSummary>) => Promise<void>
  reject: (error: unknown) => Promise<void>
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

let calls: Call[]
let storage: ReturnType<typeof memoryStorage>
let saved: NoteSummary[]
let clock: number

function makeQueue() {
  return createSaveQueue({
    draftPrefix: DRAFT_PREFIX,
    storage,
    now: () => clock,
    onSaved: summary => saved.push(summary),
    send: (id, patch, init) =>
      new Promise<NoteSummary>((resolvePromise, rejectPromise) => {
        calls.push({
          id,
          patch,
          keepalive: init?.keepalive ?? false,
          resolve: async summary => {
            resolvePromise({ id, title: patch.title ?? '', snippet: '', updatedAt: clock, ...summary, tags: summary?.tags ?? patch.tags ?? [] })
            await vi.advanceTimersByTimeAsync(0)
          },
          reject: async error => {
            rejectPromise(error)
            await vi.advanceTimersByTimeAsync(0)
          },
        })
      }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  storage = memoryStorage()
  saved = []
  clock = 1000
})

afterEach(() => vi.useRealTimers())

describe('saveQueue', () => {
  it('debounces edits into one save', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'T' })
    await vi.advanceTimersByTimeAsync(500)
    queue.update('a', { title: 'Ti' })
    await vi.advanceTimersByTimeAsync(500)
    queue.update('a', { title: 'Tit' })
    expect(calls).toHaveLength(0)
    expect(queue.getState('a').status).toBe('pending')

    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch).toEqual({ title: 'Tit' })
    expect(queue.getState('a').status).toBe('saving')

    await calls[0]?.resolve()
    expect(queue.getState('a').status).toBe('saved')
    expect(saved).toHaveLength(1)
  })

  it('saves at least every 5 seconds during continuous typing', async () => {
    const queue = makeQueue()
    for (let step = 0; step < 12; step += 1) {
      queue.update('a', { content: doc(`v${step}`) })
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch.content).toEqual(doc('v9'))
  })

  it('merges title and content edits into one patch', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'Hello' })
    queue.update('a', { content: doc('body') })
    await vi.advanceTimersByTimeAsync(800)
    expect(calls[0]?.patch).toEqual({ title: 'Hello', content: doc('body') })
  })

  it('never has two requests in flight and sends one follow-up with the latest edits', async () => {
    const queue = makeQueue()
    queue.update('a', { content: doc('one') })
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toHaveLength(1)

    queue.update('a', { content: doc('two') })
    queue.update('a', { title: 'New title' })
    queue.update('a', { content: doc('three') })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(1)
    expect(queue.getUnsaved('a')).toEqual({ content: doc('three'), title: 'New title' })

    await calls[0]?.resolve()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.patch).toEqual({ content: doc('three'), title: 'New title' })
    await calls[1]?.resolve()
    expect(queue.getState('a').status).toBe('saved')
    expect(queue.getUnsaved('a')).toBeNull()
  })

  it('keeps notes independent', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'A' })
    queue.update('b', { title: 'B' })
    await vi.advanceTimersByTimeAsync(800)
    expect(calls.map(call => [call.id, call.patch.title])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ])
  })

  it('retries network and server errors with backoff, keeping newer edits', async () => {
    const queue = makeQueue()
    queue.update('a', { content: doc('one') })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.reject(new TypeError('Failed to fetch'))
    expect(queue.getState('a')).toEqual({ status: 'retrying', error: 'Failed to fetch' })

    queue.update('a', { title: 'typed while offline' })
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.patch).toEqual({ content: doc('one'), title: 'typed while offline' })

    await calls[1]?.reject(new HttpError(503, 'Service unavailable'))
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(3)

    await calls[2]?.resolve()
    expect(queue.getState('a').status).toBe('saved')
  })

  it('caps the retry delay at 30 seconds', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await calls.at(-1)?.reject(new TypeError('offline'))
      await vi.advanceTimersByTimeAsync(30_000)
    }
    const before = calls.length
    await calls.at(-1)?.reject(new TypeError('offline'))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(before + 1)
  })

  it('stops retrying on client errors and keeps the edits', async () => {
    const queue = makeQueue()
    queue.update('a', { content: doc('one') })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.reject(new HttpError(400, 'content: unsupported node type "image"'))

    expect(queue.getState('a')).toEqual({ status: 'error', error: 'content: unsupported node type "image"' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    expect(queue.getUnsaved('a')).toEqual({ content: doc('one') })
    expect(queue.hasUnsaved()).toBe(true)
  })

  it('tries again after a permanent error when the user edits', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.reject(new HttpError(413, 'too large'))
    queue.update('a', { title: 'y' })
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toHaveLength(2)
  })

  it('flush saves immediately and resolves when everything is saved', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    const flushed = queue.flush('a')
    expect(calls).toHaveLength(1)
    let result: boolean | undefined
    void flushed.then(value => (result = value))
    await calls[0]?.resolve()
    expect(result).toBe(true)
    expect(await queue.flush('a')).toBe(true)
  })

  it('flush waits for the in-flight request and its follow-up', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    queue.update('a', { title: 'xy' })
    let result: boolean | undefined
    void queue.flush('a').then(value => (result = value))

    await calls[0]?.resolve()
    expect(result).toBeUndefined()
    await calls[1]?.resolve()
    expect(result).toBe(true)
  })

  it('flush resolves false when the save fails', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    const flushed = queue.flush('a')
    await calls[0]?.reject(new TypeError('offline'))
    expect(await flushed).toBe(false)
  })

  it('cancel drops pending edits, ignores the in-flight result and clears the draft', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    queue.update('a', { title: 'xy' })
    expect(storage.map.has(`${DRAFT_PREFIX}a`)).toBe(true)

    queue.cancel('a')
    expect(storage.map.has(`${DRAFT_PREFIX}a`)).toBe(false)
    await calls[0]?.reject(new HttpError(404, 'gone'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    expect(queue.getState('a').status).toBe('idle')
    expect(queue.hasUnsaved()).toBe(false)
  })

  it('writes a draft when saving and clears it once the server confirms', async () => {
    const queue = makeQueue()
    queue.open('a', 500)
    clock = 2000
    queue.update('a', { title: 'draft title' })
    await vi.advanceTimersByTimeAsync(800)

    const draft = JSON.parse(storage.map.get(`${DRAFT_PREFIX}a`) ?? 'null') as Draft
    expect(draft).toEqual({ title: 'draft title', editedAt: 2000, baseUpdatedAt: 500 })
    expect(queue.readDraft('a')).toEqual(draft)

    await calls[0]?.resolve({ updatedAt: 2100 })
    expect(storage.map.has(`${DRAFT_PREFIX}a`)).toBe(false)
  })

  it('persists unsent edits on demand, e.g. when the page is hidden', () => {
    const queue = makeQueue()
    queue.update('a', { content: doc('not sent yet') })
    expect(storage.map.size).toBe(0)
    queue.persistDrafts()
    expect(queue.readDraft('a')?.content).toEqual(doc('not sent yet'))
  })

  it('keeps the draft after a failed save', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.reject(new HttpError(400, 'bad'))
    expect(queue.readDraft('a')?.title).toBe('x')
  })

  it('flushAll with keepalive sends small saves as keepalive, large ones normally, and tracks both', async () => {
    const queue = makeQueue()
    queue.update('small', { title: 'small' })
    queue.update('large', { content: doc('x'.repeat(KEEPALIVE_LIMIT_BYTES)) })
    queue.update('busy', { title: 'busy' })
    void queue.flush('busy') // leaves a request in flight
    queue.update('busy', { title: 'busy 2' })
    calls.length = 0

    queue.flushAll({ keepalive: true })
    expect(calls.map(call => [call.id, call.keepalive])).toEqual([
      ['small', true],
      ['large', false],
    ])
    // Tracked like any save: no second request while these are in flight.
    queue.flushAll({ keepalive: true })
    expect(calls).toHaveLength(2)
    await calls[0]?.resolve()
    expect(queue.getState('small').status).toBe('saved')
  })

  it('writes a draft shortly after every edit, even while a request is in flight', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'one' })
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS)
    expect(queue.readDraft('a')?.title).toBe('one')

    await vi.advanceTimersByTimeAsync(800) // request now in flight
    queue.update('a', { title: 'two' })
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS)
    expect(queue.readDraft('a')?.title).toBe('two')
  })

  it('remembers confirmed edits so a server copy older than the last save is not trusted', async () => {
    const queue = makeQueue()
    queue.update('a', { content: doc('saved') })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.resolve({ updatedAt: 2000 })
    expect(queue.getUnsaved('a')).toBeNull()

    // A GET that read the note before the PATCH landed.
    expect(queue.getLocalChanges('a', 1500)).toEqual({ content: doc('saved') })
    // A copy at least as new as the save already has it.
    expect(queue.getLocalChanges('a', 2000)).toBeNull()
    expect(queue.getLocalChanges('unknown', 0)).toBeNull()
  })

  it('never moves the draft base back when an older copy is opened', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    await calls[0]?.resolve({ updatedAt: 2100 })
    queue.open('a', 500)
    queue.update('a', { title: 'y' })
    queue.persistDrafts()
    expect(queue.readDraft('a')?.baseUpdatedAt).toBe(2100)
  })

  it('treats 404 as final: drops the edits and the draft so closing the tab does not warn', async () => {
    const queue = makeQueue()
    queue.update('a', { title: 'x' })
    await vi.advanceTimersByTimeAsync(800)
    expect(queue.readDraft('a')).not.toBeNull()
    await calls[0]?.reject(new HttpError(404, 'Note not found'))
    expect(queue.hasUnsaved()).toBe(false)
    expect(queue.readDraft('a')).toBeNull()
    expect(queue.getState('a')).toEqual({ status: 'error', error: 'This note was deleted' })
  })

  it('notifies subscribers when the state changes', async () => {
    const queue = makeQueue()
    const listener = vi.fn()
    const unsubscribe = queue.subscribe(listener)
    queue.update('a', { title: 'x' })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    await vi.advanceTimersByTimeAsync(800)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('isRetryable', () => {
  it.each([
    [new TypeError('Failed to fetch'), true],
    [new HttpError(500, 'x'), true],
    [new HttpError(503, 'x'), true],
    [new HttpError(429, 'x'), true],
    [new HttpError(400, 'x'), false],
    [new HttpError(404, 'x'), false],
    [new HttpError(413, 'x'), false],
  ])('%s → %s', (error, expected) => {
    expect(isRetryable(error)).toBe(expected)
  })
})

describe('decideDraft', () => {
  const note = { title: 'Saved', content: doc('saved'), updatedAt: 1000 }

  it('does nothing without a draft', () => {
    expect(decideDraft(null, note)).toBe('none')
  })

  it('discards a draft that matches the saved note', () => {
    expect(decideDraft({ title: 'Saved', content: doc('saved'), editedAt: 900, baseUpdatedAt: 800 }, note)).toBe('discard')
  })

  it('restores a draft when nothing was saved since its base', () => {
    expect(decideDraft({ content: doc('newer'), editedAt: 1200, baseUpdatedAt: 1000 }, note)).toBe('restore')
  })

  it('asks when the note changed on the server after the draft was based', () => {
    expect(decideDraft({ content: doc('older?'), editedAt: 900, baseUpdatedAt: 800 }, note)).toBe('ask')
    expect(decideDraft({ content: doc('unknown base'), editedAt: 900, baseUpdatedAt: null }, note)).toBe('ask')
  })
})

describe('accounts: pause, resume, suspend, drain', () => {
  function queueWith(options: Partial<Parameters<typeof createSaveQueue>[0]> = {}) {
    return createSaveQueue({
      draftPrefix: DRAFT_PREFIX,
      storage,
      now: () => clock,
      send: (id, patch) =>
        new Promise<NoteSummary>((resolvePromise, rejectPromise) => {
          calls.push({
            id,
            patch,
            keepalive: false,
            resolve: async summary => {
              resolvePromise({ id, title: patch.title ?? '', snippet: '', updatedAt: clock, ...summary, tags: summary?.tags ?? patch.tags ?? [] })
              await vi.advanceTimersByTimeAsync(0)
            },
            reject: async error => {
              rejectPromise(error)
              await vi.advanceTimersByTimeAsync(0)
            },
          })
        }),
      ...options,
    })
  }

  it('pauses on 401 without retrying or losing the edit, then resumes', async () => {
    const queue = queueWith()
    queue.update('n1', { title: 'Hello' })
    await vi.advanceTimersByTimeAsync(1000)
    await calls[0]?.reject(new HttpError(401, 'Sign in required'))
    expect(queue.getState('n1').status).toBe('paused')

    // No background retries while signed out, and new edits just wait.
    queue.update('n1', { title: 'Hello again' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(1)
    expect(queue.getState('n1').status).toBe('paused')
    expect(queue.hasUnsaved()).toBe(true)

    queue.resume()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.patch).toEqual({ title: 'Hello again' })
    await calls[1]?.resolve()
    expect(queue.getState('n1').status).toBe('saved')
  })

  it('pauses on 409 (another account) and never discards the draft', async () => {
    const queue = queueWith({ draftPrefix: 'margin:draft:user-a:' })
    queue.update('n1', { title: 'Mine' })
    await vi.advanceTimersByTimeAsync(1000)
    await calls[0]?.reject(Object.assign(new HttpError(409, 'someone else'), { body: { code: 'user_mismatch' } }))
    expect(queue.getState('n1').status).toBe('paused')
    expect(storage.map.has('margin:draft:user-a:n1')).toBe(true)
    expect(storage.map.has(`${DRAFT_PREFIX}n1`)).toBe(false)
  })

  it('sends nothing at all once suspended, not even flushes on unmount', async () => {
    const queue = queueWith()
    queue.update('n1', { title: 'Late edit' })
    queue.suspend()
    expect(await queue.flush('n1')).toBe(false)
    queue.flushAll({ keepalive: true })
    queue.resume()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(0)
    expect(queue.persistDrafts()).toBe(true)
    expect(JSON.parse(storage.map.get(`${DRAFT_PREFIX}n1`) as string)).toMatchObject({ title: 'Late edit' })
  })

  it('drains: waits for in-flight saves and their follow-ups, with a deadline', async () => {
    const queue = queueWith()
    queue.update('n1', { title: 'One' })
    await vi.advanceTimersByTimeAsync(1000)
    queue.update('n1', { title: 'Two' })
    const drained = queue.drain(5000)
    await calls[0]?.resolve()
    expect(calls[1]?.patch).toEqual({ title: 'Two' })
    await calls[1]?.resolve()
    expect(await drained).toBe(true)

    queue.update('n2', { title: 'Stuck' })
    const stuck = queue.drain(5000)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await stuck).toBe(false)
  })

  it('reports when drafts could not be stored', () => {
    const queue = createSaveQueue({
      draftPrefix: DRAFT_PREFIX,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => {},
      },
      send: () => new Promise(() => {}),
    })
    queue.update('n1', { title: 'x' })
    expect(queue.persistDrafts()).toBe(false)
  })
})

describe('tags in the save queue', () => {
  it('sends tag-only edits, and merges tags with content without losing either', async () => {
    const queue = makeQueue()
    queue.update('a', { tags: ['work'] })
    queue.update('a', { content: doc('body') })
    queue.update('a', { tags: ['home', 'work'] })
    await vi.advanceTimersByTimeAsync(800)
    expect(calls[0]?.patch).toEqual({ tags: ['home', 'work'], content: doc('body') })
    await calls[0]?.resolve()
    expect(queue.getState('a').status).toBe('saved')
  })

  it('a failed save puts tags back under newer edits', async () => {
    const queue = makeQueue()
    queue.update('a', { tags: ['x'] })
    await vi.advanceTimersByTimeAsync(800)
    queue.update('a', { title: 'newer' })
    await calls[0]?.reject(new HttpError(503, 'down'))
    expect(queue.getUnsaved('a')).toEqual({ tags: ['x'], title: 'newer' })
  })

  it('keeps tags in drafts and in local changes', async () => {
    const queue = makeQueue()
    queue.update('a', { tags: ['draft'] })
    queue.persistDrafts()
    expect(queue.readDraft('a')?.tags).toEqual(['draft'])
    expect(queue.getLocalChanges('a', 0)).toEqual({ tags: ['draft'] })
  })

  it('drops invalid tags from a stored draft, keeping the rest of it', () => {
    const queue = makeQueue()
    storage.setItem(`${DRAFT_PREFIX}a`, JSON.stringify({ title: 'T', tags: ['To-Do'], editedAt: 1, baseUpdatedAt: null }))
    expect(queue.readDraft('a')).toEqual({ title: 'T', editedAt: 1, baseUpdatedAt: null })
    storage.setItem(`${DRAFT_PREFIX}b`, JSON.stringify({ tags: ['B', 'a'], editedAt: 1, baseUpdatedAt: null }))
    expect(queue.readDraft('b')?.tags).toEqual(['a', 'b'])
    storage.setItem(`${DRAFT_PREFIX}c`, JSON.stringify({ tags: 'nope', editedAt: 1, baseUpdatedAt: null }))
    expect(queue.readDraft('c')?.tags).toBeUndefined()
  })

  it('decideDraft compares tags; a draft from before tags means unchanged', () => {
    const note = { title: 'T', content: doc('c'), tags: ['a'], updatedAt: 1000 }
    expect(decideDraft({ title: 'T', editedAt: 900, baseUpdatedAt: 800 }, note)).toBe('discard')
    expect(decideDraft({ tags: ['a'], editedAt: 900, baseUpdatedAt: 800 }, note)).toBe('discard')
    expect(decideDraft({ tags: ['a', 'b'], editedAt: 1200, baseUpdatedAt: 1000 }, note)).toBe('restore')
    expect(decideDraft({ tags: [], editedAt: 900, baseUpdatedAt: 800 }, note)).toBe('ask')
  })
})

describe('deleted notes take no more edits', () => {
  it('an edit after cancel (the note was deleted) is ignored', async () => {
    const queue = makeQueue()
    queue.cancel('a')
    queue.update('a', { tags: ['late'] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(0)
    expect(queue.hasUnsaved()).toBe(false)
    expect(queue.readDraft('a')).toBeNull()
  })
})
