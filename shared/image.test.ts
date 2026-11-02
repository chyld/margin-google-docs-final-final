import { describe, expect, it } from 'vitest'
import { normalizeImageSrc } from './image.ts'

const SRC = `/api/images/${'a'.repeat(64)}.png`

describe('normalizeImageSrc', () => {
  const origin = 'http://localhost:5555'
  it('keeps Margin images and normalizes same-origin absolute URLs', () => {
    expect(normalizeImageSrc(SRC, origin)).toBe(SRC)
    expect(normalizeImageSrc(`${origin}${SRC}`, origin)).toBe(SRC)
  })
  it.each(['https://example.com/a.png', `http://127.0.0.1:5555${SRC}`, `${SRC}?x=1`, 'data:image/png;base64,AA', '', null])(
    'rejects %s',
    src => expect(normalizeImageSrc(src, origin)).toBeNull(),
  )
})
