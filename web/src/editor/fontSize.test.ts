import { describe, expect, it } from 'vitest'
import { clampFontSize, parseFontSize } from './fontSize.ts'

describe('font sizes', () => {
  it.each([
    ['11pt', 11],
    ['14.5pt', 14.5],
    ['16px', 12],
    ['13.333px', 10],
    ['1.2em', null],
    ['large', null],
    [null, null],
  ])('parses %s as %s pt', (value, expected) => {
    expect(parseFontSize(value)).toBe(expected)
  })

  it('clamps to 1–400 in half points', () => {
    expect(clampFontSize(0)).toBe(1)
    expect(clampFontSize(999)).toBe(400)
    expect(clampFontSize(11.3)).toBe(11.5)
  })
})
