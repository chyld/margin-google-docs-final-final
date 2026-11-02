import { describe, expect, it } from 'vitest'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { schema } from '../../../shared/schema.ts'
import type { NamedStyle, StyleProps } from '../../../shared/styleProps.ts'
import { inspectFormatting } from './formatInfo.ts'
import type { StylesStatus } from './styleIndex.ts'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const GHOST = '33333333-3333-4333-8333-333333333333'
type Json = Record<string, unknown>

const byId = new Map<string, NamedStyle>()
function define(id: string, name: string, props: StyleProps, deleted = false) {
  byId.set(id, { id, name, props, favoriteSlot: null, deleted, createdAt: 0, updatedAt: 0 })
}
define(ID, 'Callout', { color: '#9334e6', bold: true, fontFamily: '"Lora", serif', fontSize: '14pt', block: 'h2', align: 'center' })
define(OTHER, 'Old', { italic: true }, true)
const loaded = { status: 'loaded' as StylesStatus, byId }

function at(content: Json[], from: number, to = from) {
  const doc = schema.nodeFromJSON({ type: 'doc', content })
  return EditorState.create({ doc, schema, selection: TextSelection.create(doc, from, to) })
}
const inspect = (state: EditorState, styles = loaded) => inspectFormatting(state, styles)
const p = (text: string, marks: Json[] = [], attrs: Json = {}) => ({ type: 'paragraph', attrs, content: text ? [{ type: 'text', text, marks }] : undefined })
const tag = (id = ID) => ({ type: 'namedStyle', attrs: { id } })

describe('inspectFormatting: sources', () => {
  it('plain text: everything is the page default', () => {
    const info = inspect(at([p('Hello')], 3))
    expect(info.text.fontFamily).toEqual({ value: 'IBM Plex Sans', source: 'default' })
    expect(info.text.fontSize).toEqual({ value: 11, source: 'default' })
    expect(info.text.color).toEqual({ value: '#202124', source: 'default' })
    expect(info.text.bold).toEqual({ value: false, source: 'default' })
    expect(info.text.highlight).toEqual({ value: null, source: 'default' })
    expect(info.block).toEqual({ value: 'paragraph', source: 'default' })
    expect(info.align).toEqual({ value: 'left', source: 'default' })
    expect(info.styles).toEqual({ text: { kind: 'none' }, paragraph: { kind: 'none' } })
    expect(info.typingHere).toBe(true)
  })

  it('direct marks win; colors are canonical; px sizes convert', () => {
    const marks = [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#D93025', fontFamily: '"Inter", sans-serif', fontSize: '24px' } }]
    const info = inspect(at([p('Hello', marks)], 1, 6))
    expect(info.text.bold).toEqual({ value: true, source: 'direct' })
    expect(info.text.color).toEqual({ value: '#d93025', source: 'direct' })
    expect(info.text.fontFamily).toEqual({ value: 'Inter', source: 'direct' })
    expect(info.text.fontSize).toEqual({ value: 18, source: 'direct' })
  })

  it('a text style supplies its parts, naming the style', () => {
    const info = inspect(at([p('Hello', [tag()])], 1, 6))
    expect(info.text.color).toEqual({ value: '#9334e6', source: 'style', styleId: ID })
    expect(info.text.bold).toEqual({ value: true, source: 'style', styleId: ID })
    expect(info.text.fontFamily).toEqual({ value: 'Lora', source: 'style', styleId: ID })
    expect(info.text.italic).toEqual({ value: false, source: 'default' })
    expect(info.styles.text).toMatchObject({ kind: 'style', id: ID, name: 'Callout', deleted: false })
  })

  it('a direct mark over a style wins for that part only', () => {
    const marks = [tag(), { type: 'textStyle', attrs: { color: '#188038', fontFamily: null, fontSize: null } }]
    const info = inspect(at([p('Hi', marks)], 1, 3))
    expect(info.text.color).toEqual({ value: '#188038', source: 'direct' })
    expect(info.text.fontSize).toEqual({ value: 14, source: 'style', styleId: ID })
  })

  it('a paragraph style: type and alignment from it; untagged words keep the default text look', () => {
    const info = inspect(at([p('Words', [], { styleId: ID })], 3))
    expect(info.styles.paragraph).toMatchObject({ kind: 'style', name: 'Callout' })
    expect(info.styles.text).toEqual({ kind: 'none' })
    expect(info.block).toEqual({ value: 'h2', source: 'style', styleId: ID })
    expect(info.align).toEqual({ value: 'center', source: 'style', styleId: ID })
    expect(info.text.color.source).toBe('default')
    expect(info.text.fontSize).toEqual({ value: 16, source: 'default' })
  })

  it('an empty linked line: typing there takes the style', () => {
    const info = inspect(at([p('', [], { styleId: ID })], 1))
    expect(info.text.color).toEqual({ value: '#9334e6', source: 'style', styleId: ID })
    expect(info.text.bold).toEqual({ value: true, source: 'style', styleId: ID })
  })

  it('stored marks count at a cursor, and an explicit empty set wins over the text', () => {
    const state = at([p('Hello', [{ type: 'bold' }])], 6)
    expect(inspect(state).text.bold.source).toBe('direct')
    const cleared = state.apply(state.tr.setStoredMarks([]))
    expect(inspect(cleared).text.bold).toEqual({ value: false, source: 'default' })
  })
})

describe('inspectFormatting: elements, headings, context', () => {
  it('links draw blue and underlined; code draws monospace', () => {
    const info = inspect(at([p('go', [{ type: 'link', attrs: { href: 'https://example.com' } }])], 1, 3))
    expect(info.text.link).toEqual({ value: 'https://example.com', source: 'direct' })
    expect(info.text.color).toEqual({ value: '#1a73e8', source: 'element', label: 'Link' })
    expect(info.text.underline).toEqual({ value: true, source: 'element', label: 'Link' })
    const code = inspect(at([p('x', [{ type: 'code' }])], 1, 2))
    expect(code.text.code).toEqual({ value: true, source: 'direct' })
    expect(code.text.fontFamily).toEqual({ value: 'Monospace', source: 'element', label: 'Code' })
  })

  it('quotes are grey; table headers and collapsible titles are bold', () => {
    expect(inspect(at([{ type: 'blockquote', content: [p('q')] }], 2)).text.color).toEqual({ value: '#5f6368', source: 'element', label: 'Quote' })
    const table = {
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p('H')] }, { type: 'tableCell', content: [p('c')] }] }],
    }
    expect(inspect(at([table], 4)).text.bold).toEqual({ value: true, source: 'element', label: 'Table header' })
    expect(inspect(at([table], 4)).context).toEqual(['Table'])
  })

  it('heading defaults: h4 bold, h3 grey, h6 italic', () => {
    const h = (level: number) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'Head' }] })
    expect(inspect(at([h(4)], 2)).text.bold).toEqual({ value: true, source: 'default' })
    expect(inspect(at([h(3)], 2)).text.color).toEqual({ value: '#434343', source: 'default' })
    expect(inspect(at([h(6)], 2)).text.italic).toEqual({ value: true, source: 'default' })
    expect(inspect(at([h(1)], 2)).block).toEqual({ value: 'h1', source: 'direct' })
  })

  it('context: list, quote, code block', () => {
    expect(inspect(at([{ type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }] }], 3)).context).toEqual(['Bulleted list'])
    const info = inspect(at([{ type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] }], 2))
    expect(info.codeBlock).toBe(true)
    expect(info.context).toEqual(['Code block'])
  })

  it('a selected image', () => {
    const doc = schema.nodeFromJSON({ type: 'doc', content: [p('a'), { type: 'image', attrs: { src: '/api/images/' + 'a'.repeat(64) + '.png', align: 'center' } }, p('b')] })
    const state = EditorState.create({ doc, schema, selection: NodeSelection.create(doc, 3) })
    expect(inspect(state).image).toEqual({ align: 'center' })
  })
})

describe('inspectFormatting: selections', () => {
  it('a mixed range: per part', () => {
    const info = inspect(at([{ type: 'paragraph', content: [{ type: 'text', text: 'ab', marks: [{ type: 'bold' }] }, { type: 'text', text: 'cd' }] }], 1, 5))
    expect(info.text.bold).toEqual({ value: null, source: 'mixed' })
    expect(info.text.color).toEqual({ value: '#202124', source: 'default' })
    expect(info.typingHere).toBe(false)
  })

  it('the same value from different places is "mixed sources"', () => {
    const content = [{ type: 'paragraph', content: [{ type: 'text', text: 'ab', marks: [{ type: 'bold' }] }, { type: 'text', text: 'cd', marks: [tag()] }] }]
    expect(inspect(at(content, 1, 5)).text.bold).toEqual({ value: true, source: 'mixed-sources' })
  })

  it('a selection that only reaches the start of the next line does not count it', () => {
    const content = [p('one', [], { styleId: ID }), { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'two' }] }]
    const info = inspect(at(content, 1, 6))
    expect(info.block).toEqual({ value: 'h2', source: 'style', styleId: ID })
    expect(info.styles.paragraph).toMatchObject({ kind: 'style', id: ID })
  })

  it('empty selected lines count for the paragraph parts', () => {
    const info = inspect(at([p('a'), p(''), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'b' }] }], 1, 7))
    expect(info.block.source).toBe('mixed')
  })

  it('a table cell selection looks only at the selected cells', () => {
    const cell = (text: string, bold: boolean) => ({ type: 'tableCell', content: [p(text, bold ? [{ type: 'bold' }] : [])] })
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('A', true), cell('B', false)] }, { type: 'tableRow', content: [cell('C', true), cell('D', false)] }] }],
    })
    // Cells A and C (the first column) are bold; B and D aren't.
    // Positions just before each cell: the table opens at 0, its first row at 1.
    const firstRow = doc.child(0).child(0)
    const cellA = 2
    const cellC = 1 + firstRow.nodeSize + 1
    const state = EditorState.create({ doc, schema, selection: CellSelection.create(doc, cellA, cellC) })
    expect(inspect(state).text.bold).toEqual({ value: true, source: 'direct' })
  })

  it('a uniform large selection stays uniform (no cap), a mixed one stops early', () => {
    const content = Array.from({ length: 6000 }, (_, index) => p(`line ${index}`, [{ type: 'bold' }]))
    const doc = schema.nodeFromJSON({ type: 'doc', content })
    const state = EditorState.create({ doc, schema, selection: TextSelection.create(doc, 1, doc.content.size - 1) })
    expect(inspect(state).text.bold).toEqual({ value: true, source: 'direct' })
  })
})

describe('inspectFormatting: styles', () => {
  it('mixed, deleted, unresolved (loading or unknown)', () => {
    const content = [{ type: 'paragraph', content: [{ type: 'text', text: 'ab', marks: [tag()] }, { type: 'text', text: 'cd' }] }]
    expect(inspect(at(content, 1, 5)).styles.text).toEqual({ kind: 'mixed', ids: [ID], total: 1 })
    expect(inspect(at([p('x', [tag(OTHER)])], 1, 2)).styles.text).toMatchObject({ kind: 'style', name: 'Old', deleted: true })
    expect(inspect(at([p('x', [tag(GHOST)])], 1, 2)).styles.text).toEqual({ kind: 'unresolved', id: GHOST, status: 'loaded' })
    expect(inspect(at([p('x', [tag(GHOST)])], 1, 2), { status: 'loading', byId }).styles.text).toEqual({ kind: 'unresolved', id: GHOST, status: 'loading' })
  })

  it("an unresolved style never claims 'Default' for the parts it might set", () => {
    const info = inspect(at([p('x', [tag(GHOST)])], 1, 2), { status: 'loading', byId })
    expect(info.text.color).toEqual({ value: null, source: 'unresolved' })
    expect(info.text.fontFamily).toEqual({ value: null, source: 'unresolved' })
    expect(info.text.code).toEqual({ value: false, source: 'default' })
  })
})

describe('inspectFormatting: grok plan review', () => {
  it("a style's color beats the link blue", () => {
    const info = inspect(at([p('go', [tag(), { type: 'link', attrs: { href: 'https://example.com' } }])], 1, 3))
    expect(info.text.color).toEqual({ value: '#9334e6', source: 'style', styleId: ID })
  })

  it('a quote greys normal text and big headings, not small headings', () => {
    const quote = (block: Json) => [{ type: 'blockquote', content: [block] }]
    expect(inspect(at(quote({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] }), 2)).text.color.source).toBe('element')
    expect(inspect(at(quote({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'H' }] }), 2)).text.color).toEqual({ value: '#434343', source: 'default' })
  })

  it('a checked checklist line is grey and struck through', () => {
    const list = [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }] }]
    const info = inspect(at(list, 4))
    expect(info.text.strike).toEqual({ value: true, source: 'element', label: 'Checked item' })
    expect(info.text.color).toEqual({ value: '#5f6368', source: 'element', label: 'Checked item' })
    expect(info.context).toEqual(['Checklist'])
  })
})

describe('inspectFormatting: sol code review', () => {
  it('a heading inside a table header keeps its own weight', () => {
    const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] }] }] }] }
    expect(inspect(at([table], 4)).text.bold).toEqual({ value: false, source: 'default' })
  })

  it('a paragraph style with a type inside a quote keeps its own color', () => {
    define(GHOST, 'Body', { block: 'paragraph' })
    try {
      const info = inspect(at([{ type: 'blockquote', content: [p('q', [], { styleId: GHOST })] }], 2))
      expect(info.text.color).toEqual({ value: '#202124', source: 'default' })
    } finally {
      byId.delete(GHOST)
    }
  })

  it('a highlight without a color is the page yellow', () => {
    expect(inspect(at([p('x', [{ type: 'highlight', attrs: { color: null } }])], 1, 2)).text.highlight).toEqual({ value: '#fff475', source: 'direct' })
  })
})

describe('inspectFormatting: Sonnet code review', () => {
  it('several words with the same unloaded style show the dash, not Mixed', () => {
    const content = [{ type: 'paragraph', content: [{ type: 'text', text: 'ab', marks: [tag(GHOST)] }, { type: 'text', text: ' ', marks: [] }, { type: 'text', text: 'cd', marks: [tag(GHOST)] }] }]
    const state = at(content, 1, 3)
    const both = EditorState.create({ doc: state.doc, schema, selection: TextSelection.create(state.doc, 1, 6) })
    const info = inspect(both, { status: 'loading', byId })
    // The space between has no style: that part is honestly mixed.
    expect(info.text.color.source).toBe('mixed')
    const sameOnly = inspect(at([p('abcd', [tag(GHOST)])], 1, 5), { status: 'loading', byId })
    expect(sameOnly.text.color).toMatchObject({ value: null, source: 'unresolved' })
  })
})

describe('inspectFormatting: muse code review', () => {
  it('empty lines inside a range do not make uniform text "Mixed"', () => {
    const content = [p('ab', [tag()]), p(''), p('cd', [tag()])]
    const info = inspect(at(content, 1, 9))
    expect(info.styles.text).toMatchObject({ kind: 'style', id: ID })
    expect(info.text.bold).toEqual({ value: true, source: 'style', styleId: ID })
    expect(info.text.color).toEqual({ value: '#9334e6', source: 'style', styleId: ID })
  })

  it('a selection of only empty lines still describes them', () => {
    expect(inspect(at([p(''), p('')], 1, 3)).text.bold).toEqual({ value: false, source: 'default' })
  })

  it('an unchecked item nested inside a checked one is drawn checked', () => {
    const inner = { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('inner')] }] }
    const list = [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('outer'), inner] }] }]
    const doc = schema.nodeFromJSON({ type: 'doc', content: list })
    let innerPos = 0
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'inner') innerPos = pos + 1
    })
    const info = inspect(EditorState.create({ doc, schema, selection: TextSelection.create(doc, innerPos) }))
    expect(info.text.strike).toEqual({ value: true, source: 'element', label: 'Checked item' })
  })

  it("an unloaded paragraph style leaves the block's defaults unknown", () => {
    const info = inspect(at([p('text', [], { styleId: GHOST })], 3), { status: 'loading', byId })
    expect(info.text.fontSize).toMatchObject({ value: null, source: 'unresolved' })
    expect(info.text.color).toMatchObject({ value: null, source: 'unresolved' })
    expect(info.text.bold).toMatchObject({ value: null, source: 'unresolved' })
    expect(info.text.underline).toEqual({ value: false, source: 'default' })
  })

  it('a selected horizontal line has no text formatting', () => {
    const doc = schema.nodeFromJSON({ type: 'doc', content: [p('a'), { type: 'horizontalRule' }, p('b')] })
    const info = inspect(EditorState.create({ doc, schema, selection: NodeSelection.create(doc, 3) }))
    expect(info.node).toBe('Horizontal line')
    expect(info.image).toBeNull()
  })
})

describe('inspectFormatting: grok code review', () => {
  it('two different unloaded paragraph styles are Mixed, not one dash', () => {
    const other = '55555555-5555-4555-8555-555555555555'
    const info = inspect(at([p('a', [], { styleId: GHOST }), p('b', [], { styleId: other })], 1, 5), { status: 'loading', byId })
    expect(info.block.source).toBe('mixed')
    expect(info.align.source).toBe('mixed')
  })

  it('an unloaded paragraph style inside a quote shows the dash for color, not the quote grey', () => {
    const info = inspect(at([{ type: 'blockquote', content: [p('q', [], { styleId: GHOST })] }], 2), { status: 'loading', byId })
    expect(info.text.color).toMatchObject({ value: null, source: 'unresolved' })
  })
})
