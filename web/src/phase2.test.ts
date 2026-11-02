import { describe, expect, it } from 'vitest'
import { fontsInDoc } from './fonts.ts'
import { clampFontSize, parseFontSize } from './fontSize.ts'
import { countForeignImages, MAX_IMAGE_BYTES, partitionImageFiles, shouldPasteAsFiles } from './imageInput.ts'

const file = (name: string, type: string, size = 1000) => ({ name, type, size })

describe('shouldPasteAsFiles', () => {
  it('uploads a pasted file when there is no HTML', () => {
    expect(shouldPasteAsFiles(1, '')).toBe(true)
  })

  it('uploads when the HTML is only the image (browser "Copy image")', () => {
    expect(shouldPasteAsFiles(1, '<meta charset="utf-8"><img src="https://example.com/cat.png">')).toBe(true)
  })

  it('pastes the table, not the picture, from spreadsheets', () => {
    const excel = '<html><body><table><tr><td>Fruit</td><td>Price</td></tr></table></body></html>'
    expect(shouldPasteAsFiles(1, excel)).toBe(false)
  })

  it('pastes rich text that happens to carry a snapshot image', () => {
    expect(shouldPasteAsFiles(1, '<p>Hello <b>world</b></p><img src="x.png">')).toBe(false)
  })

  it('ignores pastes without files', () => {
    expect(shouldPasteAsFiles(0, '')).toBe(false)
  })
})

describe('partitionImageFiles', () => {
  it('accepts the four image types up to 10 MB and skips the rest', () => {
    const files = [
      file('a.png', 'image/png'),
      file('b.jpg', 'image/jpeg'),
      file('c.gif', 'image/gif'),
      file('d.webp', 'image/webp'),
      file('e.svg', 'image/svg+xml'),
      file('f.pdf', 'application/pdf'),
      file('g.png', 'image/png', MAX_IMAGE_BYTES + 1),
      file('h.png', 'image/png', 0),
    ]
    const { accepted, rejected } = partitionImageFiles(files)
    expect(accepted.map(item => item.name)).toEqual(['a.png', 'b.jpg', 'c.gif', 'd.webp'])
    expect(rejected.map(item => item.name)).toEqual(['e.svg', 'f.pdf', 'g.png', 'h.png'])
  })
})

describe('countForeignImages', () => {
  const origin = 'http://localhost:5555'
  const own = `/api/images/${'a'.repeat(64)}.png`

  it('counts images that are not stored by Margin', () => {
    const html = `<p><img src="${own}"><img src="${origin}${own}"><img src="https://example.com/x.png"><img src='data:image/png;base64,AA'></p>`
    expect(countForeignImages(html, origin)).toBe(2)
  })

  it('is zero for HTML without images', () => {
    expect(countForeignImages('<p>text</p>', origin)).toBe(0)
  })
})

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

describe('fontsInDoc', () => {
  it('collects the first family of every font used, without quotes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'textStyle', attrs: { fontFamily: '"Open Sans", sans-serif' } }] },
            { type: 'text', text: 'b', marks: [{ type: 'textStyle', attrs: { fontFamily: "'Lora', serif" } }] },
            { type: 'text', text: 'c', marks: [{ type: 'textStyle', attrs: { fontFamily: null, color: '#000' } }] },
          ],
        },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'd', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Open Sans' } }] }] }] }] }] },
      ],
    }
    expect([...fontsInDoc(doc)].sort()).toEqual(['Lora', 'Open Sans'])
  })
})
