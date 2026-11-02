// @vitest-environment happy-dom
// What the formatting toolbar shows, case by case (literal expected values). Recorded from the
// toolbar before Phase 9; the toolbar now reads the Format sidebar's derivation, and every value that
// changed then is a deliberate change listed in PLAN-PHASE9.md §9 (marked "changed" below).
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { extensions } from '../../../shared/extensions.ts'
import { getStylesSnapshot, setStylesForTesting } from '../state/namedStyles.ts'
import { stylesStatus } from './styleIndex.ts'
import { selectState } from './toolbarState.ts'

const BOLD = '11111111-1111-4111-8111-111111111111'
const BOLD2 = '22222222-2222-4222-8222-222222222222'
const H2 = '33333333-3333-4333-8333-333333333333'
const UNDERLINE = '44444444-4444-4444-8444-444444444444'
const STRIKE = '55555555-5555-4555-8555-555555555555'
const MISSING = '99999999-9999-4999-8999-999999999999'
const style = (id: string, name: string, props: Record<string, unknown>) => ({ id, name, props, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 })
setStylesForTesting([
  style(BOLD, 'Bold red', { bold: true, color: '#d93025', fontFamily: '"Lora", serif', fontSize: '14pt' }),
  style(BOLD2, 'Bold green', { bold: true, color: '#188038' }),
  style(H2, 'Section', { block: 'h2', align: 'center' }),
  style(UNDERLINE, 'Underlined', { underline: true }),
  style(STRIKE, 'Struck', { strike: true }),
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

const read = (current: Editor) => {
  const snapshot = getStylesSnapshot()
  return selectState(current as never, snapshot.styles, stylesStatus(snapshot))!
}

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
  const state = read(current)
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

  // Bold stays on (both styles bold). Changed: the sizes differ (14pt and 11pt), so the size box is blank.
  it('two different bold styles', () => {
    expect(shown([p([text('one ', [named(BOLD)]), text('two', [named(BOLD2)])])], 1, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "paragraph",
        "bold": true,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": null,
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

  // Changed: the boxes show what typing here gets (nothing), not the cleared text's color and size.
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

  // Changed: the link draws the underline, so Underline is off, as for every link.
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
        "underline": false,
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

  // Changed: it shows the yellow the page paints it with.
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
        "highlight": "#fff475",
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  // Named colors are shown as written. Changed: rgb() colors show as their hex value.
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
        "color": "#188038",
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

  // Changed: blank when the selection mixes values (before: the first piece's value).
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
        "color": null,
        "fontFamily": null,
        "fontSize": null,
        "highlight": null,
        "italic": false,
        "link": false,
        "strike": false,
        "underline": false,
      }
    `)
  })

  // Changed: blank (before: "left" whenever the paragraphs had their own alignment).
  it('mixed alignments', () => {
    expect(shown([p([text('one')], { textAlign: 'center' }), p([text('two')], { textAlign: 'right' })], 2, 8)).toMatchInlineSnapshot(`
      {
        "align": null,
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

  // Changed: the sizes differ, so the size box is blank.
  it('mixed paragraph types', () => {
    expect(shown([p([text('one')]), { type: 'heading', attrs: { level: 2 }, content: [text('two')] }], 2, 8)).toMatchInlineSnapshot(`
      {
        "align": "left",
        "block": "other",
        "bold": false,
        "code": false,
        "color": null,
        "fontFamily": null,
        "fontSize": null,
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
    const state = read(current)
    // The size box shows normal text's size (it's disabled here).
    expect({ imageSelected: state.imageSelected, imageAlign: state.imageAlign, align: state.align, fontSize: state.fontSize }).toEqual({
      imageSelected: true,
      imageAlign: 'center',
      align: 'left',
      fontSize: 11,
    })
  })

  // Added after the step 0-2 code review (values checked against the pre-Phase-9 toolbar).
  it('highlight colors that are not hex are shown as written', () => {
    expect(shown([p([text('marked', [{ type: 'highlight', attrs: { color: 'yellow' } }])])], 1, 7).highlight).toBe('yellow')
    editor?.destroy()
    expect(shown([p([text('marked', [{ type: 'highlight', attrs: { color: 'oklch(0.9 0.1 100)' } }])])], 1, 7).highlight).toBe('oklch(0.9 0.1 100)')
  })

  it('a centered paragraph whose style is missing still shows centered', () => {
    expect(shown([p([text('Hi')], { textAlign: 'center', styleId: MISSING })], 2).align).toBe('center')
  })

  // Changed: like a link's underline, a checked item draws the strikethrough, so it shows off.
  it('a checked item whose style strikes through', () => {
    const list = { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p([text('done', [named(STRIKE)])])] }] }
    expect(shown([list], 4, 6).strike).toBe(false)
  })

  // Changed: code's font is the page's monospace, so the font box is blank (before: the style's font).
  it('inline code inside a style that sets a font', () => {
    expect(shown([p([text('x = 1', [{ type: 'code' }, named(BOLD)])])], 1, 6).fontFamily).toBeNull()
  })

  // Changed: paragraphs of different types show "—" (before: the first one's style type).
  it('a selection from a styled heading into a plain paragraph', () => {
    expect(shown([p([text('one')], { styleId: H2 }), p([text('two')])], 2, 8).block).toBe('other')
  })
})

describe('stepping the size', () => {
  it('steps a mixed-size selection from its first size', async () => {
    const { stepBaseSize } = await import('./fontSize.ts')
    const current = open([p([text('one ', [textStyle({ fontSize: '18pt' })]), text('two', [textStyle({ fontSize: '24pt' })])])])
    current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, 1, 8)))
    expect(stepBaseSize(current)).toBe(18)
  })

  it('steps a single size from that size, and plain text from 11', async () => {
    const { stepBaseSize } = await import('./fontSize.ts')
    const current = open([p([text('one', [textStyle({ fontSize: '14pt' })])]), p([text('two')])])
    current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, 1, 4)))
    expect(stepBaseSize(current)).toBe(14)
    current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, 7)))
    expect(stepBaseSize(current)).toBe(11)
  })
})
