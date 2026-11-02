import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary, TagCount } from '../../../shared/types.ts'
import { createNoteList } from './noteList.ts'
import type { SavePatch } from './saveQueue.ts'

type Deferred<T> = { resolve: (value: T) => Promise<void>; reject: (error: unknown) => Promise<void> }

const row = (id: string, updatedAt: number, extra: Partial<NoteSummary> = {}): NoteSummary => ({ id, title: id.toUpperCase(), snippet: '', tags: [], updatedAt, ...extra })

let listCalls: Array<{ query: string } & Deferred<NoteSummary[]>>
let tagCalls: Array<Deferred<TagCount[]>>
let unsaved: Map<string, SavePatch>

function deferred<T>(): { promise: Promise<T> } & Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Settling also lets the store's await continue before the test goes on.
  return {
    promise,
    resolve: async value => {
      resolve(value)
      await vi.advanceTimersByTimeAsync(0)
    },
    reject: async error => {
      reject(error)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

function make() {
  const list = createNoteList({
    api: {
      listNotes: query => {
        const d = deferred<NoteSummary[]>()
        listCalls.push({ query, resolve: d.resolve, reject: d.reject })
        return d.promise
      },
      listTags: () => {
        const d = deferred<TagCount[]>()
        tagCalls.push({ resolve: d.resolve, reject: d.reject })
        return d.promise
      },
    },
    queue: { getUnsaved: id => unsaved.get(id) ?? null },
  })
  return list
}

/** Starts the store and answers its first list and counts requests. */
async function started(notes: NoteSummary[], counts: TagCount[] = []) {
  const list = make()
  list.start()
  await vi.advanceTimersByTimeAsync(0)
  await listCalls[0]!.resolve(notes)
  await tagCalls[0]!.resolve(counts)
  return list
}

beforeEach(() => {
  vi.useFakeTimers()
  listCalls = []
  tagCalls = []
  unsaved = new Map()
})
afterEach(() => vi.useRealTimers())

describe('notes list', () => {
  it('loads the list and the tag counts on start, and fills the rail', async () => {
    const list = await started([row('a', 2), row('b', 1)], [{ tag: 'ideas', count: 1 }])
    expect(list.getSnapshot()).toMatchObject({ listState: 'ready', query: '', tagCounts: [{ tag: 'ideas', count: 1 }] })
    expect(list.getSnapshot().recent.map(note => note.id)).toEqual(['a', 'b'])
  })

  it('searches after a pause, and only the newest answer applies', async () => {
    const list = await started([row('a', 2)])
    list.setQuery('x')
    await vi.advanceTimersByTimeAsync(200)
    list.setQuery('xy') // still typing: the first search never goes out
    await vi.advanceTimersByTimeAsync(250)
    expect(listCalls.map(call => call.query)).toEqual(['', 'xy'])
    list.setQuery('xyz')
    await vi.advanceTimersByTimeAsync(250)
    await listCalls[1]!.resolve([row('old', 1)]) // late answer for "xy"
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['a'])
    await listCalls[2]!.resolve([row('new', 1)])
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['new'])
  })

  it('a change of search invalidates the request in flight right away, before its delay', async () => {
    const list = await started([row('a', 2)])
    list.refresh()
    list.setQuery('q')
    await listCalls[1]!.resolve([row('stale', 1)]) // answers while "q" waits for its delay
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['a'])
  })

  it('an unchanged search loads nothing', async () => {
    const list = await started([row('a', 2)])
    list.setQuery('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(listCalls).toHaveLength(1)
  })

  it('freezes the rail while searching, and clearing the search refills it', async () => {
    const list = await started([row('a', 3), row('b', 2), row('c', 1)])
    list.setQuery('b')
    await vi.advanceTimersByTimeAsync(250)
    await listCalls[1]!.resolve([row('b', 2)])
    expect(list.getSnapshot().recent.map(note => note.id)).toEqual(['a', 'b', 'c'])
    list.setQuery('')
    await vi.advanceTimersByTimeAsync(0)
    await listCalls[2]!.resolve([row('a', 3), row('b', 2), row('c', 1)])
    expect(list.getSnapshot().recent.map(note => note.id)).toEqual(['a', 'b', 'c'])
  })

  it('shows unsaved titles and tags over the saved ones, read when the answer arrives', async () => {
    const list = make()
    list.start()
    await vi.advanceTimersByTimeAsync(0)
    unsaved.set('a', { title: 'Typing…', tags: ['new'] })
    await listCalls[0]!.resolve([row('a', 1)])
    expect(list.getSnapshot().notes[0]).toMatchObject({ title: 'Typing…', tags: ['new'] })
  })

  it('reports an error only for the newest request', async () => {
    const list = await started([row('a', 1)])
    list.refresh()
    list.refresh()
    await listCalls[1]!.reject(new Error('old one failed'))
    expect(list.getSnapshot().listState).toBe('ready')
    await listCalls[2]!.reject(new Error('offline'))
    expect(list.getSnapshot().listState).toBe('error')
  })
})

describe('saves landing', () => {
  it('patches the row in place, moving it to the top only for a newer edit', async () => {
    const list = await started([row('a', 2), row('b', 1)])
    list.noteSaved(row('b', 1, { title: 'Same time' }))
    expect(list.getSnapshot().notes.map(note => [note.id, note.title])).toEqual([['a', 'A'], ['b', 'Same time']])
    list.noteSaved(row('b', 5, { title: 'Edited' }))
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['b', 'a'])
  })

  it('keeps the title still being typed when a save lands', async () => {
    const list = await started([row('a', 1)])
    unsaved.set('a', { title: 'Still typing' })
    list.noteSaved(row('a', 2, { title: 'Saved part' }))
    expect(list.getSnapshot().notes[0]!.title).toBe('Still typing')
  })

  it('asks again instead of patching while a search is active', async () => {
    const list = await started([row('a', 1)])
    list.setQuery('x')
    await vi.advanceTimersByTimeAsync(250)
    await listCalls[1]!.resolve([])
    list.noteSaved(row('a', 2))
    expect(listCalls).toHaveLength(3)
    expect(listCalls[2]!.query).toBe('x')
  })

  it('asks again instead of patching while a list request is in flight, and keeps that answer', async () => {
    const list = await started([row('a', 1)])
    list.refresh()
    list.noteSaved(row('b', 5))
    expect(listCalls).toHaveLength(3)
    await listCalls[2]!.resolve([row('b', 5), row('a', 1)])
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['b', 'a'])
  })

  it('an older answer landing does not hide the newer request still in flight', async () => {
    const list = await started([row('a', 1)])
    list.refresh() // request A
    list.refresh() // request B replaces it
    await listCalls[1]!.resolve([row('a', 1)]) // A answers (ignored)
    list.noteSaved(row('z', 5)) // B is still out: ask again rather than patch
    expect(listCalls).toHaveLength(4)
    await listCalls[3]!.resolve([row('z', 5), row('a', 1)])
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['z', 'a'])
  })

  it('a patched row is not undone by a list request sent before the save', async () => {
    const list = await started([row('a', 1)])
    // A list request goes out, answers, and stays "in flight" no longer; then another one is sent…
    list.refresh()
    await listCalls[1]!.resolve([row('a', 1)])
    list.setQuery('q')
    list.setQuery('') // …a cleared search sends a fresh one after 0ms
    await vi.advanceTimersByTimeAsync(0)
    const before = listCalls.length
    await listCalls[before - 1]!.resolve([row('a', 1)])
    list.noteSaved(row('a', 9, { title: 'Saved' }))
    expect(list.getSnapshot().notes[0]!.title).toBe('Saved')
  })

  it('refreshes the counts once after a burst of tag changes', async () => {
    const list = await started([row('a', 1), row('b', 1)])
    list.noteSaved(row('a', 2, { tags: ['x'] }))
    list.noteSaved(row('b', 2, { tags: ['y'] }))
    list.noteSaved(row('b', 3, { tags: ['y'] })) // tags unchanged
    expect(tagCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(tagCalls).toHaveLength(2)
  })

  it('notices tags changed elsewhere when the list reloads', async () => {
    const list = await started([row('a', 1, { tags: ['x'] })])
    list.refresh()
    await tagCalls[1]!.resolve([])
    await listCalls[1]!.resolve([row('a', 2, { tags: ['y'] })])
    await vi.advanceTimersByTimeAsync(400)
    expect(tagCalls).toHaveLength(3)
  })

  it('only the newest tag-count answer applies', async () => {
    const list = await started([row('a', 1)], [{ tag: 'first', count: 1 }])
    list.refresh()
    list.refresh()
    await tagCalls[2]!.resolve([{ tag: 'newest', count: 1 }])
    await tagCalls[1]!.resolve([{ tag: 'stale', count: 1 }])
    expect(list.getSnapshot().tagCounts).toEqual([{ tag: 'newest', count: 1 }])
  })
})

describe('creating and deleting', () => {
  it('a new note goes on top and survives a list request in flight', async () => {
    const list = await started([row('a', 1)])
    list.refresh()
    list.noteCreated({ id: 'new', title: '', updatedAt: 5 })
    await listCalls[1]!.resolve([row('a', 1)])
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['new', 'a'])
  })

  it('creating clears the search and loads the full list', async () => {
    const list = await started([row('a', 1)])
    list.setQuery('x')
    await vi.advanceTimersByTimeAsync(250)
    await listCalls[1]!.resolve([])
    list.noteCreated({ id: 'new', title: '', updatedAt: 5 })
    expect(list.getSnapshot().query).toBe('')
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls.at(-1)!.query).toBe('')
  })

  it('a deleted note leaves the list and the rail, and a list in flight does not bring it back', async () => {
    const list = await started([row('a', 3), row('b', 2), row('c', 1)])
    const before = list.getSnapshot().notes
    list.refresh()
    const next = list.noteDeleted('b', before)
    expect(next?.id).toBe('c')
    expect(list.getSnapshot().recent.map(note => note.id)).toEqual(['a', 'c'])
    await listCalls[1]!.resolve([row('a', 3), row('b', 2), row('c', 1)])
    expect(list.getSnapshot().notes.map(note => note.id)).toEqual(['a', 'c'])
    expect(tagCalls).toHaveLength(3) // refresh(), then the delete's immediate reload
  })

  it('opens the previous note after deleting the last one, from the list when the delete began', async () => {
    const list = await started([row('a', 2), row('b', 1)])
    const before = list.getSnapshot().notes
    list.noteSaved(row('b', 9)) // reorders the live list while the delete is on its way
    expect(list.noteDeleted('b', before)?.id).toBe('a')
    expect(list.noteDeleted('a', [row('a', 2)])).toBeUndefined()
  })

  it('follows local title and tag edits without counting them as saved tags', async () => {
    const list = await started([row('a', 1, { tags: ['x'] })])
    list.localTitle('a', 'New title')
    list.localTags('a', ['y'])
    expect(list.getSnapshot().notes[0]).toMatchObject({ title: 'New title', tags: ['y'] })
    // The server still has "x": a save confirming "y" is a tag change.
    list.noteSaved(row('a', 2, { tags: ['y'] }))
    await vi.advanceTimersByTimeAsync(400)
    expect(tagCalls).toHaveLength(2)
  })
})

describe('lifecycle', () => {
  it('ignores answers after dispose, and starts again cleanly (StrictMode)', async () => {
    const list = make()
    list.start()
    list.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls).toHaveLength(0) // the first search was cancelled with its timer
    list.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls).toHaveLength(1)
    expect(tagCalls).toHaveLength(2)
    list.dispose()
    await listCalls[0]!.resolve([row('a', 1)])
    await tagCalls[1]!.resolve([{ tag: 'x', count: 1 }])
    expect(list.getSnapshot()).toMatchObject({ notes: [], listState: 'loading', tagCounts: [] })
  })

  it('cancels a pending count refresh on dispose', async () => {
    const list = await started([row('a', 1)])
    list.noteSaved(row('a', 2, { tags: ['x'] }))
    list.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(tagCalls).toHaveLength(1)
  })

  it('keeps the same snapshot object until something changes', async () => {
    const list = await started([row('a', 1)])
    const first = list.getSnapshot()
    expect(list.getSnapshot()).toBe(first)
    list.localTitle('a', 'x')
    expect(list.getSnapshot()).not.toBe(first)
  })
})
