import { describe, expect, it } from 'vitest'
import { EMPTY_DOC, inspectDoc, isSafeColor, isSafeLink, makeSnippet, MAX_DEPTH, SNIPPET_LENGTH } from './doc.ts'
import { checkSchema } from './schema.ts'

const paragraph = (text: string, marks?: unknown[]) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
})

const docOf = (...content: unknown[]) => ({ type: 'doc', content })

// The marks on the first text node of the cleaned document.
function cleanedMarks(value: unknown) {
  const result = inspectDoc(value)
  if (!result.ok) throw new Error(result.error)
  const content = result.doc.content as Array<{ content: Array<{ marks?: unknown[] }> }>
  return content[0]?.content[0]?.marks
}

describe('inspectDoc', () => {
  it('accepts the empty document', () => {
    expect(inspectDoc(EMPTY_DOC)).toEqual({ ok: true, text: '', doc: EMPTY_DOC })
  })

  it('extracts text with a line per block', () => {
    const doc = docOf(
      { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [{ type: 'text', text: 'Title' }] },
      paragraph('First line'),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph('one')] },
          { type: 'listItem', content: [paragraph('two')] },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'before' }, { type: 'hardBreak' }, { type: 'text', text: 'after' }],
      },
    )
    const result = inspectDoc(doc)
    expect(result).toMatchObject({ ok: true, text: 'Title\nFirst line\none\ntwo\nbefore\nafter' })
    // Nothing unsafe, so the cleaned copy is identical.
    expect(result.ok && result.doc).toEqual(doc)
  })

  it('keeps every supported mark with safe values', () => {
    const marks = [
      { type: 'bold' },
      { type: 'italic' },
      { type: 'underline' },
      { type: 'strike' },
      { type: 'code' },
      { type: 'textStyle', attrs: { color: '#e03131' } },
      { type: 'highlight', attrs: { color: 'oklch(0.9 0.1 100)' } },
      { type: 'link', attrs: { href: 'https://example.com', target: '_blank' } },
    ]
    expect(cleanedMarks(docOf(paragraph('styled', marks)))).toEqual(marks)
  })

  it('drops colors it cannot vouch for instead of rejecting the document', () => {
    const marks = cleanedMarks(
      docOf(paragraph('x', [
        { type: 'textStyle', attrs: { color: 'red; background: url(x)' } },
        { type: 'highlight', attrs: { color: 'rgb(1,2,3)); x' } },
      ])),
    )
    expect(marks).toEqual([
      { type: 'textStyle', attrs: { color: null } },
      { type: 'highlight', attrs: { color: null } },
    ])
  })

  it('removes unsafe links but keeps their text', () => {
    for (const href of ['javascript:alert(1)', ' java\tscript:alert(1)', 'data:text/html,x', '//evil.example/x', 'file:///etc/passwd']) {
      const result = inspectDoc(docOf(paragraph('click', [{ type: 'bold' }, { type: 'link', attrs: { href } }])))
      expect(result.ok).toBe(true)
      expect(cleanedMarks(docOf(paragraph('click', [{ type: 'bold' }, { type: 'link', attrs: { href } }])))).toEqual([{ type: 'bold' }])
    }
    expect(cleanedMarks(docOf(paragraph('x', [{ type: 'link' }])))).toEqual([])
  })

  it('clears an invalid text alignment', () => {
    const result = inspectDoc(docOf({ type: 'paragraph', attrs: { textAlign: 'center;position:fixed' } }))
    expect(result.ok && result.doc).toEqual(docOf({ type: 'paragraph', attrs: { textAlign: null } }))
  })

  it.each([
    ['a non-object', 'nope'],
    ['a non-doc root', { type: 'paragraph' }],
    ['an unknown node type', docOf({ type: 'image', attrs: { src: 'x.png' } })],
    ['an unknown mark type', docOf(paragraph('x', [{ type: 'superscript' }]))],
    ['a nested doc', docOf({ type: 'doc' })],
    ['non-array content', { type: 'doc', content: { type: 'paragraph' } }],
    ['a text node without text', docOf({ type: 'paragraph', content: [{ type: 'text' }] })],
    ['a heading level the editor does not offer', docOf({ type: 'heading', attrs: { level: 7 } })],
  ])('rejects %s', (_label, value) => {
    expect(inspectDoc(value).ok).toBe(false)
  })

  it('rejects documents nested too deeply', () => {
    let node: Record<string, unknown> = paragraph('deep')
    for (let level = 0; level < MAX_DEPTH + 1; level += 1) node = { type: 'blockquote', content: [node] }
    expect(inspectDoc(docOf(node))).toEqual({ ok: false, error: expect.stringContaining('nested deeper') })
  })
})

describe('isSafeColor', () => {
  it.each(['#fff', '#e03131', '#11223344', 'rgb(34, 34, 34)', 'rgba(0 0 0 / 50%)', 'hsl(210deg 50% 40%)', 'oklch(0.7 0.1 200)', 'lab(50% 40 59.5)', 'color(srgb 1 0 0)', 'var(--fg)', 'color-mix(in srgb, #fff 40%, red)', 'yellow'])(
    'accepts %s',
    color => expect(isSafeColor(color)).toBe(true),
  )

  it.each(['red; x: y', 'url(x)', '"red"', 'rgb(1,2,3))', 'expression(alert(1))', 'var(--a, rgb(1 2 3))', ''])('rejects %s', color =>
    expect(isSafeColor(color)).toBe(false),
  )
})

describe('isSafeLink', () => {
  it.each(['https://a.b', 'http://a.b', 'mailto:a@b.c', 'tel:+1555', '/notes/x', '#top'])('accepts %s', href =>
    expect(isSafeLink(href)).toBe(true),
  )
  it.each(['javascript:x', 'JAVASCRIPT:x', '\njavascript:x', 'data:x', '//evil', 'ftp://x', 'relative.html'])('rejects %s', href =>
    expect(isSafeLink(href)).toBe(false),
  )
})

describe('checkSchema', () => {
  it('accepts documents the editor can open', () => {
    expect(checkSchema(EMPTY_DOC)).toEqual({ ok: true })
    expect(checkSchema(docOf({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('x')] }] }))).toEqual({ ok: true })
  })

  it.each([
    ['text directly under doc', docOf({ type: 'text', text: 'bare' })],
    ['an empty doc', docOf()],
    ['a doc without content', { type: 'doc' }],
    ['a paragraph inside a paragraph', docOf({ type: 'paragraph', content: [{ type: 'paragraph' }] })],
    ['a list item outside a list', docOf({ type: 'listItem', content: [paragraph('x')] })],
  ])('rejects %s', (_label, value) => {
    expect(checkSchema(value).ok).toBe(false)
  })
})

describe('makeSnippet', () => {
  it('collapses whitespace onto one line', () => {
    expect(makeSnippet('  one\n\ntwo\tthree  ')).toBe('one two three')
  })

  it('truncates long text with an ellipsis', () => {
    const snippet = makeSnippet('word '.repeat(100))
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH)
    expect(snippet.endsWith('…')).toBe(true)
  })
})
