// @vitest-environment happy-dom
// What the formatting toolbar shows, case by case. Written against the toolbar as it was before
// Phase 9 (literal expected values), so moving the toolbar onto the Format sidebar's reading can't
// change anything silently: every expectation that changes is a deliberate, listed change.
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { extensions } from '../../shared/extensions.ts'
import { selectState } from './components/Toolbar.tsx'
import { setStylesForTesting } from './namedStyles.ts'

const BOLD = '11111111-1111-4111-8111-111111111111'
const BOLD2 = '22222222-2222-4222-8222-222222222222'
const H2 = '33333333-3333-4333-8333-333333333333'
const UNDERLINE = '44444444-4444-4444-8444-444444444444'
const MISSING = '99999999-9999-4999-8999-999999999999'
const style = (id: string, name: string, props: Record<string, unknown>) => ({ id, name, props, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 })
setStylesForTesting([
  style(BOLD, 'Bold red', { bold: true, color: '#d93025', fontFamily: '"Lora", serif', fontSize: '14pt' }),
  style(BOLD2, 'Bold green', { bold: true, color: '#188038' }),
  style(H2, 'Section', { block: 'h2', align: 'center' }),
  style(UNDERLINE, 'Underlined', { underline: true }),
])

type Json = Record<string, unknown>
let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

const text = (value: string, marks: Json[] = []) => ({ type: 'text', text: value, marks })
const p = (content: Json[], attrs: Json = {}) => ({ type: 'paragraph', attrs, content })
const named = (id: string) => ({ type: 'namedStyle', attrs: { id } })
const textStyle = (attrs: Json) => ({ type: 'textStyle', attrs: { color: null, fontFamily: null, fontSize: null, ...attrs } })

function open(content: Json[]) {
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({ element, extensions, content: { type: 'doc', content } })
  return editor
}

/** The display fields of the toolbar for a selection from..to. */
function shown(content: Json[], from: number, to = from, setup?: (editor: Editor) => void) {
  const current = open(content)
  current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, from, to)))
  setup?.(current)
  const state = selectState({ editor: current as never })!
  return {
    block: state.block,
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    strike: state.strike,
    code: state.code,
    color: state.color,
    highlight: state.highlight,
    link: state.link,
    align: state.align,
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
  }
}

describe('toolbar display', () => {
  it('uniform direct formatting', () => {
    expect(
      shown([p([text('Hello', [{ type: 'bold' }, { type: 'underline' }, textStyle({ color: '#d93025', fontFamily: '"Inter", sans-serif', fontSize: '18pt' })])])], 1, 6),
    ).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": true,
        "code": false,
        "color": "#d93025",
        "fontFamily": "Inter",
        "fontSize": 18,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": true,
      }
    `)
  })

  it('two different bold styles', () => {
    expect(shown([p([text('one ', [named(BOLD)]), text('two', [named(BOLD2)])])], 1, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": true,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('direct bold next to style bold', () => {
    expect(shown([p([text('one ', [{ type: 'bold' }]), text('two', [named(BOLD2)])])], 1, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": true,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('direct bold next to a table header (bold by default)', () => {
    const table = {
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p([text('one ', [{ type: 'bold' }]), text('two')])] }] }],
    }
    expect(shown([table], 4, 11)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('stored marks at a collapsed cursor', () => {
    expect(shown([p([text('Hello')])], 3, 3, current => current.commands.toggleBold())).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": true,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a collapsed cursor after clearing formatting inside colored text', () => {
    expect(
      shown([p([text('Hello', [textStyle({ color: '#d93025', fontSize: '18pt' }), { type: 'bold' }])])], 3, 3, current =>
        current.view.dispatch(current.state.tr.setStoredMarks([])),
      ),
    ).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": "#d93025",
        "fontFamily": null,
        "fontSize": 18,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a link', () => {
    expect(shown([p([text('site', [{ type: 'link', attrs: { href: 'https://example.com' } }])])], 1, 5)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": true,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a link whose style underlines', () => {
    expect(shown([p([text('site', [{ type: 'link', attrs: { href: 'https://example.com' } }, named(UNDERLINE)])])], 1, 5)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": true,
        "strike": false,
        "underline": true,
      }
    `)
  })

  it('inline code', () => {
    expect(shown([p([text('x = 1', [{ type: 'code' }])])], 1, 6)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": true,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a quote', () => {
    expect(shown([{ type: 'blockquote', content: [p([text('quoted')])] }], 3, 6)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a checked item', () => {
    const list = { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p([text('done')])] }] }
    expect(shown([list], 4, 6)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a plain heading 3', () => {
    expect(shown([{ type: 'heading', attrs: { level: 3 }, content: [text('Head')] }], 2)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "h3",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 14,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a paragraph linked to a heading style', () => {
    expect(shown([p([text('Section')], { styleId: H2 })], 2)).toMatchInlineSnapshot(`
      {
        "align": "center",
        "block": "h2",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 16,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a heading whose paragraph style is missing', () => {
    expect(shown([{ type: 'heading', attrs: { level: 2, styleId: MISSING }, content: [text('Head')] }], 2)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "h2",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 16,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a highlight with no color', () => {
    expect(shown([p([text('marked', [{ type: 'highlight', attrs: { color: null } }])])], 1, 7)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('pasted colors that are not hex', () => {
    expect(shown([p([text('red', [textStyle({ color: 'red' })])])], 1, 4)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": "red",
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
    editor?.destroy()
    expect(shown([p([text('rgb', [textStyle({ color: 'rgb(24, 128, 56)' })])])], 1, 4)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": "rgb(24, 128, 56)",
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('mixed colors, sizes and fonts', () => {
    expect(
      shown(
        [
          p([
            text('one ', [textStyle({ color: '#d93025', fontFamily: '"Lora", serif', fontSize: '18pt' })]),
            text('two', [textStyle({ color: '#188038', fontFamily: '"Inter", sans-serif', fontSize: '24pt' })]),
          ]),
        ],
        1,
        8,
      ),
    ).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": "#d93025",
        "fontFamily": "Lora",
        "fontSize": 18,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('mixed alignments', () => {
    expect(shown([p([text('one')], { textAlign: 'center' }), p([text('two')], { textAlign: 'right' })], 2, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('mixed paragraph types', () => {
    expect(shown([p([text('one')]), { type: 'heading', attrs: { level: 2 }, content: [text('two')] }], 2, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "other",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": 11,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  it('a selected image', () => {
    const current = open([
      p([text('a')]),
      { type: 'image', attrs: { src: '/api/images/' + 'a'.repeat(64) + '.png', align: 'center' } },
      p([text('b')]),
    ])
    current.view.dispatch(current.state.tr.setSelection(NodeSelection.create(current.state.doc, 3)))
    const state = selectState({ editor: current as never })!
    expect({ imageSelected: state.imageSelected, imageAlign: state.imageAlign, align: state.align }).toMatchInlineSnapshot(`
      {
        "align": "left",
        "imageAlign": "center",
        "imageSelected": true,
      }
    `)
  })
})
