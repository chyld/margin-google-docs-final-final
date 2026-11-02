import { describe, expect, it } from 'vitest'
import { MAX_TAGS, normalizeTag, normalizeTags, parseTagQuery, splitTagInput, toggleTagInQuery } from './tags.ts'

describe('tag rules', () => {
  it('normalizes: trim, one leading #, lowercase', () => {
    expect(normalizeTag('  #Work ')).toBe('work')
    expect(normalizeTag('##x')).toBe('#x')
  })

  it('accepts a–z and 0–9 lists, dedupes and sorts', () => {
    expect(normalizeTags(['Work', 'home', 'work', '2026'])).toEqual({ ok: true, tags: ['2026', 'home', 'work'] })
    expect(normalizeTags([])).toEqual({ ok: true, tags: [] })
  })

  it('rejects instead of stripping', () => {
    for (const bad of ['to-do', 'a b', 'café', '', '#', 'x_y', 'a'.repeat(33)]) {
      expect(normalizeTags([bad]).ok, bad).toBe(false)
    }
    expect(normalizeTags([42]).ok).toBe(false)
  })

  it('caps the number of tags', () => {
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)
    expect(normalizeTags(many).ok).toBe(false)
    expect(normalizeTags(many.slice(0, MAX_TAGS)).ok).toBe(true)
  })

  it('splits pasted text on whitespace and commas', () => {
    expect(splitTagInput(' a b,c ,, d\n')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('parses #tag tokens out of a search; invalid ones stay text', () => {
    expect(parseTagQuery('#Work meeting #home notes')).toEqual({ tags: ['home', 'work'], text: 'meeting notes' })
    expect(parseTagQuery('#to-do # plain')).toEqual({ tags: [], text: '#to-do # plain' })
    expect(parseTagQuery('#work')).toEqual({ tags: ['work'], text: '' })
  })

  it('toggles a tag in the search query', () => {
    expect(toggleTagInQuery('', 'work')).toBe('#work')
    expect(toggleTagInQuery('meeting', 'work')).toBe('meeting #work')
    expect(toggleTagInQuery('meeting #Work', 'work')).toBe('meeting')
  })
})
