import { describe, expect, it } from 'vitest'
import { ALIGN_NAMES, BLOCK_OPTIONS, blockLabel } from './labels.ts'

// The names on screen. The toolbar's alignment buttons say "Justify" (an action, Toolbar.tsx); the
// Format sidebar reports the value "Justified". Each stays as it is.
describe('labels', () => {
  it('names paragraph types', () => {
    expect(BLOCK_OPTIONS.map(option => option.label)).toEqual(['Normal text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'])
    expect(blockLabel('h3')).toBe('Heading 3')
    expect(blockLabel('other')).toBe('Other')
  })

  it('names alignments as values', () => {
    expect(ALIGN_NAMES).toEqual({ left: 'Left', center: 'Center', right: 'Right', justify: 'Justified' })
  })
})
