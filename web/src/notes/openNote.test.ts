import { describe, expect, it, vi } from 'vitest'
import type { Note, NoteSummary } from '../../../shared/types.ts'
import { restoreForOpen } from './openNote.ts'
import { createSaveQueue } from './saveQueue.ts'

const PREFIX = 'margin:draft:test-user:'
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const note = (over: Partial<Note> = {}): Note => ({ id: 'n1', title: 'Saved', content: doc('saved'), tags: [], createdAt: 1, updatedAt: 100, ...over })

function setup(draft?: Record<string, unknown>) {
  const map = new Map<string, string>()
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) }
  if (draft) map.set(`${PREFIX}n1`, JSON.stringify(draft))
  // Saves never finish: the queue keeps its edits as unsaved.
  const queue = createSaveQueue({ draftPrefix: PREFIX, storage, send: () => new Promise<NoteSummary>(() => {}) })
  const confirm = vi.fn((_message: string) => true)
  return { map, queue, confirm }
}

describe('opening a note', () => {
  it('shows the saved note when there is nothing local', () => {
    const { queue, confirm } = setup()
    expect(restoreForOpen(queue, note(), { confirm })).toEqual({ title: 'Saved', content: doc('saved'), tags: [], notice: null })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('prefers edits still in memory over a draft, without asking', () => {
    const { queue, confirm } = setup({ title: 'From draft', editedAt: 5, baseUpdatedAt: 50 })
    queue.update('n1', { title: 'In memory' })
    expect(restoreForOpen(queue, note(), { confirm }).title).toBe('In memory')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('restores a draft newer than the saved note, without asking', () => {
    const { queue, confirm } = setup({ title: 'Draft title', content: doc('draft'), editedAt: 5, baseUpdatedAt: 100 })
    const shown = restoreForOpen(queue, note(), { confirm })
    expect(shown).toMatchObject({ title: 'Draft title', content: doc('draft'), notice: "Restored changes that hadn't been saved yet." })
    expect(confirm).not.toHaveBeenCalled()
    expect(queue.getUnsaved('n1')).toEqual({ title: 'Draft title', content: doc('draft') })
  })

  it('asks about a draft older than the saved note, and restores it when told to', () => {
    const { queue, confirm } = setup({ title: 'Old draft', editedAt: 5, baseUpdatedAt: 50 })
    expect(restoreForOpen(queue, note(), { confirm }).title).toBe('Old draft')
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toContain('Restore those changes?')
  })

  it('discards an older draft when the user declines', () => {
    const { map, queue, confirm } = setup({ title: 'Old draft', editedAt: 5, baseUpdatedAt: 50 })
    confirm.mockReturnValue(false)
    expect(restoreForOpen(queue, note(), { confirm }).title).toBe('Saved')
    expect(map.has(`${PREFIX}n1`)).toBe(false)
    expect(queue.getUnsaved('n1')).toBeNull()
  })

  it('quietly discards a draft that matches the saved note', () => {
    const { map, queue, confirm } = setup({ title: 'Saved', editedAt: 5, baseUpdatedAt: 50 })
    expect(restoreForOpen(queue, note(), { confirm }).title).toBe('Saved')
    expect(confirm).not.toHaveBeenCalled()
    expect(map.has(`${PREFIX}n1`)).toBe(false)
  })

  it('keeps a draft the editor cannot open, without asking', () => {
    const { map, queue, confirm } = setup({ content: { type: 'doc', content: [{ type: 'futureWidget' }] }, editedAt: 5, baseUpdatedAt: 50 })
    expect(restoreForOpen(queue, note(), { confirm }).content).toEqual(doc('saved'))
    expect(confirm).not.toHaveBeenCalled()
    expect(map.has(`${PREFIX}n1`)).toBe(true)
  })

  it('restores a draft that only changed tags', () => {
    const { queue, confirm } = setup({ tags: ['ideas'], editedAt: 5, baseUpdatedAt: 100 })
    expect(restoreForOpen(queue, note(), { confirm })).toMatchObject({ title: 'Saved', tags: ['ideas'] })
    expect(queue.getUnsaved('n1')).toEqual({ tags: ['ideas'] })
  })
})
