// @vitest-environment happy-dom
// The toolbar and the Format sidebar can't disagree: for uniform selections, what the toolbar shows
// equals the sidebar's values (the toolbar shows "nothing" where the sidebar says Default).
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { extensions } from '../../../shared/extensions.ts'
import { selectState } from '../components/Toolbar.tsx'
import { formatInfoFor } from './formatInfo.ts'
import { setStylesForTesting, getStylesSnapshot } from '../state/namedStyles.ts'

const ID = '11111111-1111-4111-8111-111111111111'
type Json = Record<string, unknown>
let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

setStylesForTesting([
  { id: ID, name: 'Callout', props: { color: '#9334e6', bold: true, italic: true, fontFamily: '"Lora", serif', fontSize: '14pt', align: 'center' }, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 },
])

function check(content: Json[], from: number, to = from) {
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({ element, extensions, content: { type: 'doc', content } })
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
  const toolbar = selectState({ editor: editor as never })!
  const { styles } = getStylesSnapshot()
  const info = formatInfoFor(editor.state, styles, 'loaded')
  const shown = <T,>(field: { value: T | null; source: string }) => (field.source === 'default' ? null : field.value)
  const flag = (field: { value: boolean | null; source: string }) => field.value === true && field.source !== 'default'
  expect({
    bold: toolbar.bold,
    italic: toolbar.italic,
    underline: toolbar.underline,
    strike: toolbar.strike,
    color: toolbar.color,
    fontFamily: toolbar.fontFamily,
    fontSize: toolbar.fontSize,
    align: toolbar.align,
  }).toEqual({
    bold: flag(info.text.bold),
    italic: flag(info.text.italic),
    underline: flag(info.text.underline),
    strike: flag(info.text.strike),
    color: shown(info.text.color),
    fontFamily: shown(info.text.fontFamily),
    fontSize: info.text.fontSize.value,
    align: info.align.value,
  })
}

const p = (text: string, marks: Json[] = [], attrs: Json = {}) => ({ type: 'paragraph', attrs, content: [{ type: 'text', text, marks }] })

describe('toolbar and Format sidebar agree', () => {
  it('plain text', () => check([p('Hello')], 2, 4))
  it('direct marks', () =>
    check([p('Hello', [{ type: 'bold' }, { type: 'underline' }, { type: 'textStyle', attrs: { color: '#d93025', fontFamily: '"Inter", sans-serif', fontSize: '18pt' } }])], 1, 6))
  it('a text style', () => check([p('Hello', [{ type: 'namedStyle', attrs: { id: ID } }])], 1, 6))
  it('a cursor inside styled text', () => check([p('Hello', [{ type: 'namedStyle', attrs: { id: ID } }])], 3))
  it('a direct mark over a style', () =>
    check([p('Hi', [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'textStyle', attrs: { color: '#188038', fontFamily: null, fontSize: null } }])], 1, 3))
  it('a centered paragraph', () => check([p('Hi', [], { textAlign: 'center' })], 2))
  it('a heading 3', () => check([{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Head' }] }], 2))
})
