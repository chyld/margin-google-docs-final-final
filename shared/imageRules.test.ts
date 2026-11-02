import { describe, expect, it } from 'vitest'
import { IMAGE_ID, IMAGE_NAME, IMAGE_SRC, imageIdsIn, isImageType } from './imageRules.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

// The pattern the image cleanup used before Phase 9. imageIdsIn decides which images are kept, so it
// must find exactly the same ids.
const OLD_REFERENCE = /\/api\/images\/([0-9a-f]{64})\.(?:png|jpg|gif|webp)/g
const oldIds = (text: string) => [...text.matchAll(OLD_REFERENCE)].map(match => match[1])

const NOTE = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: `mentions /api/images/${C}.png in plain text` }] },
    { type: 'image', attrs: { src: `/api/images/${A}.png`, width: 320, align: 'center' } },
    { type: 'details', content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [{ type: 'image', attrs: { src: `/api/images/${B}.webp` } }] }] },
    { type: 'image', attrs: { src: `/api/images/${A}.png` } },
    { type: 'image', attrs: { src: `/api/images/${'d'.repeat(64)}.svg` } },
    { type: 'image', attrs: { src: `/api/images/${'E'.repeat(64)}.png` } },
    { type: 'image', attrs: { src: `/api/images/${'f'.repeat(63)}.jpg` } },
  ],
})

describe('image rules', () => {
  it('finds the same image references as the old cleanup pattern', () => {
    for (const text of [NOTE, '', '{"type":"doc","content":[]}', `/api/images/${A}.jpg/api/images/${B}.gif`, `../api/images/${A}.png?x`]) {
      expect(imageIdsIn(text)).toEqual(oldIds(text))
    }
    expect(imageIdsIn(NOTE)).toEqual([C, A, B, A])
  })

  it('matches ids, file names and srcs', () => {
    expect(IMAGE_ID.test(A)).toBe(true)
    expect(IMAGE_ID.test(A.slice(1))).toBe(false)
    expect(IMAGE_NAME.exec(`${A}.webp`)?.slice(1)).toEqual([A, 'webp'])
    expect(IMAGE_NAME.test(`${A}.jpeg`)).toBe(false)
    expect(IMAGE_SRC.test(`/api/images/${A}.gif`)).toBe(true)
    expect(IMAGE_SRC.test(`/api/images/${A}.gif?x=1`)).toBe(false)
    expect(IMAGE_SRC.test(`https://example.com/api/images/${A}.gif`)).toBe(false)
  })

  it('knows the accepted types', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].every(isImageType)).toBe(true)
    expect(isImageType('image/svg+xml')).toBe(false)
    expect(isImageType('toString')).toBe(false)
  })
})
