import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { undo, history } from '@tiptap/pm/history'
import { schema } from '../../../shared/schema.ts'
import { detachOnTypeChange } from '../../../shared/namedStyle.ts'
import type { NamedStyle, StyleProps } from '../../../shared/styleProps.ts'
import { applyStyle, captureProps, clearInlineFormatting, currentStyle, removeStyle } from './styleCommands.ts'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function style(props: StyleProps, id = ID): NamedStyle {
  return { id, name: 'S', props, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 }
}

type Json = Record<string, unknown>
const text = (value: string, marks: Json[] = []) => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) })
const p = (...content: Json[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) })

function stateOf(content: Json[], select?: (doc: ReturnType<typeof schema.nodeFromJSON>) => [number, number]) {
  const doc = schema.nodeFromJSON({ type: 'doc', content })
  const [from, to] = select ? select(doc) : [1, 1]
  return EditorState.create({ doc, schema, plugins: [history(), detachOnTypeChange()], selection: TextSelection.create(doc, from, to) })
}

import type { Transaction } from '@tiptap/pm/state'

function run(state: EditorState, result: ReturnType<typeof applyStyle> | Transaction | null) {
  expect(result).not.toBeNull()
  const tr = result && 'reason' in result ? null : result && 'tr' in result && !('steps' in result) ? result.tr : (result as Transaction)
  expect(tr).not.toBeNull()
  return state.apply(tr as Transaction)
}

const json = (state: EditorState) => state.doc.toJSON() as { content: Array<Json & { attrs?: Json; content?: Array<Json & { marks?: Json[] }> }> }

describe('applyStyle', () => {
  it('tags only the selected words, resetting just the formatting the style defines', () => {
    // "Hello world" with color + font on everything; select "world".
    const marks = [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Lora', fontSize: '14pt' } }, { type: 'bold' }]
    const state = stateOf([p(text('Hello world', marks))], () => [7, 12])
    const next = run(state, applyStyle(state, style({ color: '#188038', italic: true })))
    const [first, second] = json(next).content[0]?.content ?? []
    expect(first).toMatchObject({ text: 'Hello ', marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Lora' } }, { type: 'bold' }] })
    // Color cleared (the style's comes through), font and size kept, bold kept, tag added.
    expect(second?.text).toBe('world')
    expect(second?.marks).toEqual([
      { type: 'namedStyle', attrs: { id: ID } },
      { type: 'textStyle', attrs: { color: null, fontFamily: 'Lora', fontSize: '14pt' } },
      { type: 'bold' },
    ])
  })

  it('drops textStyle entirely when the style defines all of it', () => {
    const state = stateOf([p(text('Hi', [{ type: 'textStyle', attrs: { color: '#ff0000' } }]))], () => [1, 3])
    const next = run(state, applyStyle(state, style({ color: '#188038' })))
    expect(json(next).content[0]?.content?.[0]?.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
  })

  it('applies paragraph parts with a collapsed cursor, and inline parts to the whole block', () => {
    const state = stateOf([p(text('Title here')), p(text('Body'))], () => [3, 3])
    const next = run(state, applyStyle(state, style({ block: 'h2', align: 'center', bold: true })))
    const [first, second] = json(next).content
    expect(first).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: ID, textAlign: null } })
    expect(first?.content?.[0]?.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    expect(second).toMatchObject({ type: 'paragraph', attrs: { styleId: null } })
  })

  it('applies paragraph parts to the paragraph of a partial selection, text parts to the selection', () => {
    const state = stateOf([p(text('Title here'))], () => [1, 6])
    const next = run(state, applyStyle(state, style({ block: 'h1', bold: true })))
    expect(json(next).content[0]).toMatchObject({ type: 'heading', attrs: { level: 1, styleId: ID } })
    const [first, second] = json(next).content[0]?.content ?? []
    expect(first).toMatchObject({ text: 'Title', marks: [{ type: 'namedStyle', attrs: { id: ID } }] })
    expect(second).toEqual({ type: 'text', text: ' here' })
  })

  it('a paragraph-only style on a few words styles their whole paragraph', () => {
    const state = stateOf([p(text('Title here')), p(text('Other'))], () => [2, 4])
    const next = run(state, applyStyle(state, style({ align: 'center' })))
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: ID } })
    expect(json(next).content[1]).toMatchObject({ attrs: { styleId: null } })
  })

  it('does not count a paragraph the selection merely ends at the start of', () => {
    const state = stateOf([p(text('One')), p(text('Two'))], () => [1, 6])
    const next = run(state, applyStyle(state, style({ align: 'right' })))
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: ID } })
    expect(json(next).content[1]).toMatchObject({ attrs: { styleId: null } })
  })

  it("keeps a list item's first line a paragraph but still links it", () => {
    const state = stateOf([{ type: 'bulletList', content: [{ type: 'listItem', content: [p(text('Item'))] }] }], () => [4, 4])
    const next = run(state, applyStyle(state, style({ block: 'h3' })))
    const item = (next.doc.toJSON() as any).content[0].content[0].content[0]
    expect(item).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(() => next.doc.check()).not.toThrow()
  })

  it('skips inline code and code blocks', () => {
    const state = stateOf(
      [p(text('a '), text('code', [{ type: 'code' }]), text(' b')), { type: 'codeBlock', content: [text('x = 1')] }],
      doc => [1, doc.content.size - 1],
    )
    const next = run(state, applyStyle(state, style({ color: '#188038' })))
    const out = next.doc.toJSON() as any
    expect(out.content[0].content[1]).toEqual({ type: 'text', text: 'code', marks: [{ type: 'code' }] })
    expect(out.content[0].content[0].marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    expect(out.content[1].content[0].marks).toBeUndefined()
    expect(() => next.doc.check()).not.toThrow()
  })

  it('does not strip direct formatting from inline code it cannot style', () => {
    const red = { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: null, fontSize: null } }
    const state = stateOf([p(text('a '), text('code', [{ type: 'code' }, red]))], doc => [1, doc.content.size - 1])
    const next = run(state, applyStyle(state, style({ color: '#188038' })))
    expect((next.doc.toJSON() as any).content[0].content[1].marks).toContainEqual(red)
  })

  it('makes typing in an empty paragraph continue in the style', () => {
    const state = stateOf([p()], () => [1, 1])
    const next = run(state, applyStyle(state, style({ color: '#188038', block: 'h2' })))
    expect(json(next).content[0]).toMatchObject({ type: 'heading', attrs: { styleId: ID } })
    const typed = next.apply(next.tr.insertText('x'))
    expect((typed.doc.toJSON() as any).content[0].content[0].marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
  })

  it('clears a direct color at the cursor that the style defines, so typing shows the style', () => {
    const red = { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Lora' } }
    const state = stateOf([p(text('Red', [red]))], () => [4, 4])
    const next = run(state, applyStyle(state, style({ color: '#1a73e8' })))
    const typed = next.apply(next.tr.insertText('!'))
    const marks = (typed.doc.toJSON() as any).content[0].content.at(-1).marks
    expect(marks).toContainEqual({ type: 'namedStyle', attrs: { id: ID } })
    expect(marks.find((mark: Json) => mark.type === 'textStyle')?.attrs).toMatchObject({ color: null, fontFamily: 'Lora' })
  })

  it('keeps a valid document when applied with the cursor inside inline code', () => {
    const state = stateOf([p(text('a '), text('code', [{ type: 'code' }]))], () => [5, 5])
    const result = applyStyle(state, style({ color: '#1a73e8', block: 'h2' }))
    const next = 'tr' in result ? state.apply(result.tr) : state
    const typed = next.apply(next.tr.insertText('x'))
    expect(() => typed.doc.check()).not.toThrow()
    expect((typed.doc.toJSON() as any).content[0].content.at(-1).marks).toEqual([{ type: 'code' }])
  })

  it('links whole paragraphs even for styles without paragraph parts (for parts added later)', () => {
    const state = stateOf([p(text('Line'))], () => [2, 2])
    const next = run(state, applyStyle(state, style({ color: '#1a73e8' })))
    expect(json(next).content[0]).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
  })

  it('replaces another style and is one undo step', () => {
    const state = stateOf([p(text('Hi', [{ type: 'namedStyle', attrs: { id: ID2 } }]))], () => [1, 3])
    const next = run(state, applyStyle(state, style({ bold: true })))
    expect(json(next).content[0]?.content?.[0]?.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    let undone: EditorState | null = null
    undo(next, tr => (undone = next.apply(tr)))
    expect((undone as unknown as EditorState).doc.eq(state.doc)).toBe(true)
  })

  it('refuses deleted styles', () => {
    const state = stateOf([p(text('Hi'))], () => [1, 3])
    expect(applyStyle(state, { ...style({ bold: true }), deleted: true })).toEqual({ reason: 'deleted' })
    const code = stateOf([{ type: 'codeBlock', content: [text('x = 1')] }], () => [2, 2])
    expect(applyStyle(code, style({ color: '#188038' }))).toEqual({ reason: 'code' })
  })
})

describe('manual paragraph-type changes unlink paragraph styles', () => {
  it('unlinks when the type changes outside a style apply (e.g. Ctrl+Alt+3 or "## ")', () => {
    const state = stateOf([{ type: 'heading', attrs: { level: 1, styleId: ID }, content: [text('Title')] }], () => [2, 2])
    const next = state.apply(state.tr.setBlockType(1, 6, schema.nodes.heading as any, { level: 3, styleId: ID }))
    expect(json(next).content[0]).toMatchObject({ type: 'heading', attrs: { level: 3, styleId: null } })
  })

  it('keeps the link for ordinary typing and for the style apply itself', () => {
    const state = stateOf([p(text('Line'))], () => [2, 2])
    const linked = run(state, applyStyle(state, style({ block: 'h2' })))
    expect(json(linked).content[0]).toMatchObject({ type: 'heading', attrs: { styleId: ID } })
    const typed = linked.apply(linked.tr.insertText('!'))
    expect(json(typed).content[0]).toMatchObject({ attrs: { styleId: ID } })
  })

  it('Enter in a styled paragraph keeps the style on both halves', () => {
    const state = stateOf([p(text('Hello world'))], () => [3, 3])
    const linked = run(state, applyStyle(state, style({ color: '#1a73e8', align: 'center' })))
    const split = linked.apply(linked.tr.split(6))
    const [first, second] = json(split).content
    expect(first).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(second).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
  })

  it('Enter at the end of a styled heading starts an unlinked paragraph', () => {
    const state = stateOf([{ type: 'heading', attrs: { level: 2, styleId: ID }, content: [text('Title')] }], () => [6, 6])
    const split = state.apply(state.tr.split(6, 1, [{ type: schema.nodes.paragraph as any, attrs: { styleId: ID } }]))
    const [first, second] = json(split).content
    expect(first).toMatchObject({ type: 'heading', attrs: { styleId: ID } })
    expect(second).toMatchObject({ type: 'paragraph', attrs: { styleId: null } })
  })

  it('tags the text of whole paragraphs even for paragraph-only styles', () => {
    const state = stateOf([p(text('Line'))], () => [2, 2])
    const next = run(state, applyStyle(state, style({ align: 'center' })))
    expect(json(next).content[0]?.content?.[0]?.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
  })

  it('a few selected words lose their tag; the paragraph keeps its link', () => {
    const tagged = [{ type: 'namedStyle', attrs: { id: ID } }]
    const state = stateOf([{ type: 'paragraph', attrs: { styleId: ID }, content: [text('one two', tagged)] }], () => [1, 4])
    const next = run(state, removeStyle(state))
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: ID } })
    expect(json(next).content[0]?.content?.[0]).toEqual({ type: 'text', text: 'one' })
  })
})

describe('removeStyle, clear formatting, current style', () => {
  it('removes tags and paragraph links but keeps other formatting', () => {
    const state = stateOf(
      [{ type: 'paragraph', attrs: { styleId: ID }, content: [text('Hi', [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'bold' }])] }],
      () => [2, 2],
    )
    const next = run(state, removeStyle(state))
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: null }, content: [{ text: 'Hi', marks: [{ type: 'bold' }] }] })
  })

  it('clears marks, tags and the paragraph link of a fully selected block', () => {
    const doc = [{ type: 'paragraph', attrs: { styleId: ID }, content: [text('Hi', [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'italic' }])] }]
    const state = stateOf(doc, () => [1, 3])
    const tr = state.tr
    clearInlineFormatting(tr)
    const next = state.apply(tr)
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: null }, content: [{ text: 'Hi' }] })
    expect(json(next).content[0]?.content?.[0]?.marks).toBeUndefined()
  })

  it('with a collapsed cursor, only the next typed text is plain', () => {
    const marks = [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'italic' }]
    const state = stateOf([{ type: 'paragraph', attrs: { styleId: ID }, content: [text('Hi', marks)] }], () => [3, 3])
    const tr = state.tr
    clearInlineFormatting(tr)
    const next = state.apply(tr)
    expect(json(next).content[0]).toMatchObject({ attrs: { styleId: ID }, content: [{ text: 'Hi', marks }] })
    const typed = next.apply(next.tr.insertText('!'))
    expect((typed.doc.toJSON() as any).content[0].content[1]).toEqual({ type: 'text', text: '!' })
  })

  it('reports the text style first, then the paragraph, and mixed selections', () => {
    const tagged = (id: string) => [{ type: 'namedStyle', attrs: { id } }]
    const state = stateOf(
      [{ type: 'paragraph', attrs: { styleId: ID2 }, content: [text('aa', tagged(ID)), text('bb')] }],
      () => [2, 2],
    )
    expect(currentStyle(state)).toEqual({ kind: 'style', id: ID, source: 'text' })
    const inPlain = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4, 4)))
    expect(currentStyle(inPlain)).toEqual({ kind: 'style', id: ID2, source: 'paragraph' })
    const mixed = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 5)))
    expect(currentStyle(mixed)).toEqual({ kind: 'mixed' })
  })
})

describe('captureProps', () => {
  it('captures only explicit formatting, canonicalized', () => {
    const marks = [
      { type: 'textStyle', attrs: { color: 'rgb(217, 48, 37)', fontFamily: '"Lora", serif', fontSize: '14pt' } },
      { type: 'highlight', attrs: { color: '#FFF475' } },
      { type: 'bold' },
      { type: 'underline' },
    ]
    const state = stateOf([{ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [text('Hi', marks)] }], () => [1, 3])
    expect(captureProps(state, () => undefined)).toEqual({
      fontFamily: '"Lora", serif',
      fontSize: '14pt',
      color: '#d93025',
      highlight: '#fff475',
      bold: true,
      underline: true,
      block: 'h2',
      align: 'center',
    })
  })

  it("keeps a linked paragraph's style type, not the node's older type", () => {
    const state = stateOf([{ type: 'heading', attrs: { level: 2, styleId: ID }, content: [text('Hi')] }], () => [1, 3])
    expect(captureProps(state, id => (id === ID ? { block: 'h3', color: '#188038' } : undefined))).toMatchObject({ block: 'h3' })
  })

  it('invents nothing for plain text, and merges an existing style underneath', () => {
    const plain = stateOf([p(text('Hi'))], () => [1, 3])
    expect(captureProps(plain, () => undefined)).toEqual({})
    const styled = stateOf([p(text('Hi', [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'italic' }]))], () => [1, 3])
    expect(captureProps(styled, id => (id === ID ? { color: '#188038', bold: true } : undefined))).toEqual({
      color: '#188038',
      bold: true,
      italic: true,
    })
  })
})
