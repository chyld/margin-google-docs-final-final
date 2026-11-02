import { EditorState } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { addColumnBefore, addRowAfter, CellSelection, mergeCells, setCellAttr, splitCell } from '@tiptap/pm/tables'
import type { Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { inspectDoc, isSafeFontFamily, isSafeFontSize } from './doc.ts'
import catalog from './font-catalog.json' with { type: 'json' }
import { css2FamilyParam, firstFontFamily, fontFamilyValue, fontSlug } from './fonts.ts'
import type { FontCatalogEntry } from './fonts.ts'
import { normalizeImageSrc } from './image.ts'
import { checkSchema, schema } from './schema.ts'

const SRC = `/api/images/${'a'.repeat(64)}.png`
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) })
const docOf = (...content: unknown[]) => ({ type: 'doc', content })
const cell = (value: string, attrs?: Record<string, unknown>) => ({
  type: 'tableCell',
  ...(attrs ? { attrs } : {}),
  content: [paragraph(text(value))],
})
const table = (rows: string[][]) => ({
  type: 'table',
  content: rows.map(row => ({ type: 'tableRow', content: row.map(value => cell(value)) })),
})

function cleaned(value: unknown) {
  const result = inspectDoc(value)
  if (!result.ok) throw new Error(result.error)
  return result.doc
}

// Every document the editor can produce must pass the cleaner unchanged and fit the schema.
function expectRoundTrip(node: PMNode) {
  const json = node.toJSON()
  expect(cleaned(json)).toEqual(json)
  expect(checkSchema(json)).toEqual({ ok: true })
}

function cellPositions(doc: PMNode): number[] {
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') positions.push(pos)
  })
  return positions
}

function run(state: EditorState, command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) {
  let next = state
  const ok = command(state, tr => (next = state.apply(tr)))
  expect(ok).toBe(true)
  return next
}

describe('round trip of editor output', () => {
  it('keeps tables after merging, splitting, adding columns and resizing', () => {
    let state = EditorState.create({ schema, doc: schema.nodeFromJSON(docOf(table([['a', 'b', 'c'], ['d', 'e', 'f']]))) })
    const select = (anchor: number, head: number) => {
      const cells = cellPositions(state.doc)
      state = state.apply(state.tr.setSelection(CellSelection.create(state.doc, cells[anchor] as number, cells[head] as number)))
    }

    select(0, 1)
    state = run(state, mergeCells) // colspan 2
    expectRoundTrip(state.doc)

    select(0, 0)
    state = run(state, setCellAttr('colwidth', [120.5, 0])) // a dragged width and an unset column
    expectRoundTrip(state.doc)

    state = run(state, addColumnBefore) // prosemirror-tables splices 0 widths into spans
    state = run(state, addRowAfter)
    expectRoundTrip(state.doc)

    const merged = cellPositions(state.doc).find(pos => state.doc.nodeAt(pos)?.attrs.colspan === 2) as number
    state = state.apply(state.tr.setSelection(CellSelection.create(state.doc, merged)))
    state = run(state, splitCell)
    expectRoundTrip(state.doc)
  })

  it('keeps images, sections, headings, fonts and highlights', () => {
    const doc = schema.nodeFromJSON(
      docOf(
        { type: 'heading', attrs: { level: 6, textAlign: 'center' }, content: [text('Six')] },
        { type: 'image', attrs: { src: SRC, alt: null, title: null, width: 320, height: 180, align: 'center' } },
        {
          type: 'details',
          attrs: { open: true },
          content: [
            { type: 'detailsSummary', content: [text('Summary', [{ type: 'bold' }])] },
            { type: 'detailsContent', content: [paragraph(text('Hidden'))] },
          ],
        },
        paragraph(
          text('Styled', [
            { type: 'textStyle', attrs: { color: '#d93025', fontFamily: '"Open Sans", sans-serif', fontSize: '14pt' } },
            { type: 'highlight', attrs: { color: '#e6d5cc' } },
          ]),
        ),
      ),
    )
    expectRoundTrip(doc)
  })
})

describe('inspectDoc: phase 2 nodes', () => {
  it('extracts text from tables and sections for search', () => {
    const result = inspectDoc(
      docOf(table([['Fruit', 'Price']]), {
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [text('Title')] },
          { type: 'detailsContent', content: [paragraph(text('Body'))] },
        ],
      }),
    )
    expect(result).toMatchObject({ ok: true, text: 'Fruit\nPrice\nTitle\nBody' })
  })

  it.each([
    ['a remote image', 'https://example.com/cat.png'],
    ['a data: image', 'data:image/png;base64,AAAA'],
    ['a path outside the image folder', '/api/images/../margin.db'],
    ['a non-hash name', '/api/images/cat.png'],
    ['an svg', `/api/images/${'a'.repeat(64)}.svg`],
  ])('rejects %s instead of silently dropping it', (_label, src) => {
    expect(inspectDoc(docOf({ type: 'image', attrs: { src } }))).toEqual({ ok: false, error: 'Image source not allowed' })
  })

  it('rejects an image without attributes', () => {
    expect(inspectDoc(docOf({ type: 'image' })).ok).toBe(false)
  })

  it('coerces numeric strings and cleans image attributes', () => {
    const doc = cleaned(
      docOf({ type: 'image', attrs: { src: SRC, width: '300', height: 'auto', alt: 2024, title: 'x'.repeat(2000), align: 'middle' } }),
    )
    expect((doc.content as Array<{ attrs: unknown }>)[0]?.attrs).toEqual({
      src: SRC,
      width: 300,
      height: null,
      alt: '2024',
      title: null,
      align: null,
    })
  })

  it('cleans table cell widths, alignment and spans', () => {
    const withCell = (attrs: Record<string, unknown>) => docOf({ type: 'table', content: [{ type: 'tableRow', content: [cell('x', attrs)] }] })
    const attrsOf = (attrs: Record<string, unknown>) =>
      ((cleaned(withCell(attrs)).content as any[])[0].content[0].content[0] as { attrs: unknown }).attrs

    expect(attrsOf({ colspan: 2, colwidth: [100, null] })).toEqual({ colspan: 2, colwidth: [100, 0] })
    expect(attrsOf({ colspan: 1, colwidth: [100, 50] })).toEqual({ colspan: 1, colwidth: null })
    expect(attrsOf({ colwidth: ['wide'] })).toEqual({ colwidth: null })
    expect(attrsOf({ align: 'justify' })).toEqual({ align: null })
    expect(attrsOf({ colspan: '2' })).toEqual({ colspan: 2 })
    // Odd spans from pasted HTML are clamped, never rejected (that would make the note unsaveable).
    expect(attrsOf({ colspan: 0 })).toEqual({ colspan: 1 })
    expect(attrsOf({ colspan: 150 })).toEqual({ colspan: 100 })
    expect(attrsOf({ rowspan: 1.5 })).toEqual({ rowspan: 1 })
    expect(attrsOf({ rowspan: 'x' })).toEqual({ rowspan: 1 })
  })

  it('cleans a non-boolean open flag', () => {
    const doc = cleaned(
      docOf({
        type: 'details',
        attrs: { open: 'yes' },
        content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [paragraph()] }],
      }),
    )
    expect((doc.content as Array<{ attrs: unknown }>)[0]?.attrs).toEqual({ open: false })
  })

  it('drops unsafe font values but keeps the text', () => {
    const doc = cleaned(
      docOf(
        paragraph(
          text('x', [{ type: 'textStyle', attrs: { fontFamily: 'Arial; background: url(x)', fontSize: 'calc(1px + 1em)' } }]),
        ),
      ),
    )
    expect((doc.content as any[])[0].content[0]).toEqual(
      text('x', [{ type: 'textStyle', attrs: { fontFamily: null, fontSize: null } }]),
    )
  })

  it('keeps only attributes the editor defines', () => {
    const doc = cleaned(
      docOf({
        type: 'paragraph',
        attrs: { textAlign: 'center', onclick: 'alert(1)', style: 'color:red' },
        content: [text('x', [{ type: 'textStyle', attrs: { color: '#000', made_up: 1 } }])],
      }),
    )
    const node = (doc.content as any[])[0]
    expect(node.attrs).toEqual({ textAlign: 'center' })
    expect(node.content[0].marks[0].attrs).toEqual({ color: '#000' })
  })

  it('accepts every heading level from 1 to 6', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(inspectDoc(docOf({ type: 'heading', attrs: { level }, content: [text('h')] })).ok).toBe(true)
    }
  })
})

describe('font value checks', () => {
  it.each([
    '"Open Sans", sans-serif',
    "'Times New Roman', Times, serif",
    'Arial',
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
    'system-ui',
  ])('accepts family %s', value => expect(isSafeFontFamily(value)).toBe(true))

  it.each([
    'Arial; color: red',
    '"Open Sans, sans-serif',
    "Lora'",
    'url(x)',
    'a:b',
    '',
    'a,'.repeat(25) + 'a',
  ])('rejects family %s', value => expect(isSafeFontFamily(value)).toBe(false))

  it('accepts the stored value of every catalog family', () => {
    for (const entry of catalog as FontCatalogEntry[]) expect(isSafeFontFamily(fontFamilyValue(entry)), entry.f).toBe(true)
  })

  it.each(['11pt', '14.5px', '14.666666666666666px', '1.2em', '120%', '2rem', 'large', 'x-small'])('accepts size %s', value =>
    expect(isSafeFontSize(value)).toBe(true),
  )
  it.each(['0pt', '500px', '12', 'calc(1px)', '1e3px', 'big', '-1pt'])('rejects size %s', value =>
    expect(isSafeFontSize(value)).toBe(false),
  )
})

describe('fonts helpers', () => {
  const entry = (f: string) => (catalog as FontCatalogEntry[]).find(item => item.f === f) as FontCatalogEntry

  it.each([
    ['Lora', 'Lora:ital,wght@0,400;0,700;1,400;1,700', 'Lora:wght@400'],
    ['Buda', 'Buda:wght@300', 'Buda:wght@300'],
    ['Molle', 'Molle:ital,wght@1,400', 'Molle:ital,wght@1,400'],
    ['Sunflower', 'Sunflower:wght@500;700', 'Sunflower:wght@500'],
    ['UnifrakturCook', 'UnifrakturCook:wght@700', 'UnifrakturCook:wght@700'],
    ['Pacifico', 'Pacifico:wght@400', 'Pacifico:wght@400'],
    ['Open Sans', 'Open+Sans:ital,wght@0,400;0,700;1,400;1,700', 'Open+Sans:wght@400'],
  ])('builds css2 parameters for %s', (family, full, preview) => {
    expect(css2FamilyParam(entry(family))).toBe(full)
    expect(css2FamilyParam(entry(family), 'preview')).toBe(preview)
  })

  it('has unique slugs and sane entries', () => {
    const list = catalog as FontCatalogEntry[]
    expect(list.length).toBeGreaterThan(1500)
    expect(new Set(list.map(item => fontSlug(item.f))).size).toBe(list.length)
    for (const item of list) {
      expect(item.w.length + item.i.length, item.f).toBeGreaterThan(0)
      expect(['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace']).toContain(item.k)
    }
  })

  it('reads the first family without quotes', () => {
    expect(firstFontFamily('"Open Sans", sans-serif')).toBe('Open Sans')
    expect(firstFontFamily("'Lora'")).toBe('Lora')
    expect(firstFontFamily('Arial')).toBe('Arial')
    expect(firstFontFamily('')).toBeNull()
    expect(firstFontFamily(null)).toBeNull()
  })
})

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
