import { describe, expect, it } from 'vitest'
import { fontsInDoc } from './fonts.ts'

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
