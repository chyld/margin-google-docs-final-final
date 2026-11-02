// @vitest-environment happy-dom
// Real Enter and real typing in a mounted editor, so the actual keymap and plugin order run.
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { extensions } from '../../../shared/extensions.ts'
import type { NamedStyle, StyleProps } from '../../../shared/styleProps.ts'
import { applyStyle, effectiveTextProps } from './styleCommands.ts'
import { EndStyleShortcuts } from './endStyle.ts'

const ID = '11111111-1111-4111-8111-111111111111'
type Json = Record<string, any>

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function style(props: StyleProps): NamedStyle {
  return { id: ID, name: 'S', props, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 }
}

function mount(content: Json[]): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({ element, extensions: [...extensions, EndStyleShortcuts], content: { type: 'doc', content } })
  return editor
}

function select(from: number, to = from) {
  editor?.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

function apply(props: StyleProps) {
  const result = applyStyle(editor!.state, style(props))
  if (result && 'tr' in result) editor!.view.dispatch(result.tr)
}

function enter() {
  editor!.commands.keyboardShortcut('Enter')
}

function type(text: string) {
  // Like a keystroke: insert at the cursor with the stored marks.
  const { state } = editor!
  editor!.view.dispatch(state.tr.insertText(text))
}

const blocks = () => (editor!.getJSON().content ?? []) as Json[]
const tagged = (block: Json | undefined) => !!block && (block.content ?? []).every((node: Json) => node.marks?.some((m: Json) => m.type === 'namedStyle' && m.attrs.id === ID))

describe('Enter keeps the style', () => {
  it('in a styled paragraph: the new line is styled, and typed text is tagged', () => {
    mount([{ type: 'paragraph' }, { type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6', bold: true })
    type('First')
    enter()
    type('Second')
    const [first, second] = blocks()
    expect(first).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(second).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(tagged(first) && tagged(second)).toBe(true)
  })

  it('at the end of a styled heading: the new line is the same heading, still styled', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ block: 'h2', color: '#188038' })
    type('Title')
    enter()
    type('Next')
    const [first, second] = blocks()
    expect(first).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: ID } })
    expect(second).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: ID } })
    expect(tagged(first) && tagged(second)).toBe(true)
  })

  it('on the last line too (where another empty line gets added after a heading)', () => {
    mount([{ type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] }, { type: 'paragraph' }])
    select(8)
    apply({ block: 'h1', italic: true })
    type('Styled last line')
    expect(blocks()[1]).toMatchObject({ type: 'heading', attrs: { styleId: ID } })
    expect(tagged(blocks()[1]!)).toBe(true)
  })

  it('on empty styled lines, again and again', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6' })
    enter()
    enter()
    type('Third')
    const all = blocks()
    expect(all).toHaveLength(3)
    expect(all.every(block => block.attrs.styleId === ID)).toBe(true)
    expect(tagged(all[2]!)).toBe(true)
  })

  it('in the middle of a line, both halves stay styled', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6' })
    type('HelloWorld')
    select(6)
    enter()
    const [first, second] = blocks()
    expect(first?.content?.[0].text).toBe('Hello')
    expect(second?.content?.[0].text).toBe('World')
    expect(first?.attrs.styleId).toBe(ID)
    expect(second?.attrs.styleId).toBe(ID)
    expect(tagged(first!) && tagged(second!)).toBe(true)
  })

  it('with words selected, they are replaced (not duplicated)', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6' })
    type('Hello world')
    select(3, 8)
    enter()
    const [first, second] = blocks()
    expect(first?.content?.[0].text).toBe('He')
    expect(second?.content?.[0].text).toBe('orld')
  })

  it('does not carry a link onto the new line', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6' })
    type('go')
    editor!.chain().setTextSelection({ from: 1, to: 3 }).setLink({ href: 'https://example.com' }).run()
    select(3)
    enter()
    type('x')
    const second = blocks()[1]!
    expect(second.content[0].marks.some((m: Json) => m.type === 'link')).toBe(false)
    expect(tagged(second)).toBe(true)
  })
})

describe('typing on an empty styled line', () => {
  it('uses the line style even after clicking away and back', () => {
    mount([{ type: 'paragraph', content: [{ type: 'text', text: 'Other' }] }, { type: 'paragraph' }])
    select(8)
    apply({ color: '#9334e6' })
    select(2) // click elsewhere: the formatting held for the next keystroke is gone
    select(8) // and back
    type('Back')
    expect(tagged(blocks()[1]!)).toBe(true)
  })

  it('leaves text typed next to deliberately unstyled words alone', () => {
    const mark = { type: 'namedStyle', attrs: { id: ID } }
    mount([
      {
        type: 'paragraph',
        attrs: { styleId: ID },
        content: [{ type: 'text', text: 'styled ', marks: [mark] }, { type: 'text', text: 'plain' }],
      },
    ])
    select(13)
    type('er')
    const last = blocks()[0]!.content.at(-1)
    expect(last.text).toBe('plainer')
    expect(last.marks).toBeUndefined()
  })

  it('undo of typing on an empty styled line is one step and leaves the line empty and styled', () => {
    mount([{ type: 'paragraph' }])
    select(1)
    apply({ color: '#9334e6' })
    editor!.view.dispatch(closeHistory(editor!.state.tr))
    select(1)
    type('x')
    editor!.commands.undo()
    expect(blocks()[0]).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(blocks()[0]!.content).toBeUndefined()
  })
})

describe('Enter still works as before where it should', () => {
  it('leaves a quote from an empty styled line', () => {
    mount([{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }, { type: 'paragraph', attrs: { styleId: ID } }] }])
    select(9)
    enter()
    const all = blocks()
    expect(all[0]?.type).toBe('blockquote')
    expect(all[1]).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
  })

  it('makes a new list item from a styled first line (keeping the style)', () => {
    mount([{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'One' }] }] }] }])
    select(6)
    enter()
    const list = blocks()[0]!
    expect(list.content).toHaveLength(2)
    expect(list.content[1].content[0].attrs.styleId).toBe(ID)
  })

  it('unstyled lines are untouched (heading → paragraph as usual)', () => {
    mount([{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plain' }] }])
    select(6)
    enter()
    expect(blocks()[1]?.type).toBe('paragraph')
  })
})

describe('any formatting-bar change ends the style (the text keeps its look)', () => {
  const styles: Record<string, StyleProps> = { [ID]: { color: '#9334e6', bold: true, align: 'center' } }
  const lookup = (id: string) => styles[id]

  function styledLine(text: string) {
    mount([{ type: 'paragraph' }])
    select(1)
    apply(styles[ID]!)
    type(text)
  }

  it('Bold at the end of a styled line: earlier text keeps the style, new text is plain-but-same-look minus bold', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Styled')
    runWithEndStyle(editor!, c => c.toggleBold(), { lookup, focus: false })
    type(' after')
    const block = blocks()[0]!
    expect(block.attrs.styleId).toBeNull()
    expect(block.attrs.textAlign).toBe('center') // the style's alignment became the paragraph's own
    const [first, second] = block.content
    expect(first.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    // New text: no tag, the style's color as its own, and bold switched off (it was the style's).
    expect(second.marks.some((m: Json) => m.type === 'namedStyle')).toBe(false)
    expect(second.marks).toContainEqual({ type: 'textStyle', attrs: expect.objectContaining({ color: '#9334e6' }) })
    expect(second.marks.some((m: Json) => m.type === 'bold')).toBe(false)
    // And Enter no longer continues the style.
    enter()
    type('next')
    expect(blocks()[1]!.attrs.styleId).toBeNull()
  })

  it('a color on selected styled words: they leave the style and keep the rest of its look', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Hello world')
    select(1, 6)
    runWithEndStyle(editor!, c => c.setColor('#188038'), { lookup, focus: false })
    const [first, second] = blocks()[0]!.content
    expect(first.text).toBe('Hello')
    expect(first.marks.some((m: Json) => m.type === 'namedStyle')).toBe(false)
    expect(first.marks).toContainEqual({ type: 'bold' })
    expect(first.marks).toContainEqual({ type: 'textStyle', attrs: expect.objectContaining({ color: '#188038' }) })
    expect(second.marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    expect(blocks()[0]!.attrs.styleId).toBe(ID) // only part of the paragraph was selected
  })

  it('alignment at the cursor keeps the look for the next typed text', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Styled')
    runWithEndStyle(editor!, c => c.setTextAlign('right'), { lookup, focus: false })
    type('!')
    const last = blocks()[0]!.content.at(-1)
    expect(last.marks.some((m: Json) => m.type === 'namedStyle')).toBe(false)
    expect(last.marks).toContainEqual({ type: 'bold' })
    expect(blocks()[0]!.attrs.textAlign).toBe('right')
  })

  it('ending the style and the action are one undo step', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Hello')
    editor!.view.dispatch(closeHistory(editor!.state.tr))
    select(1, 6)
    runWithEndStyle(editor!, c => c.setColor('#188038'), { lookup, focus: false })
    editor!.commands.undo()
    expect(blocks()[0]!.content[0].marks).toEqual([{ type: 'namedStyle', attrs: { id: ID } }])
    expect(blocks()[0]!.attrs.styleId).toBe(ID)
  })

  it('unlinks each fully selected paragraph, even when the next one is only partly selected', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    const mark = [{ type: 'namedStyle', attrs: { id: ID } }]
    mount([
      { type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'One', marks: mark }] },
      { type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'Two', marks: mark }] },
    ])
    select(1, 7)
    runWithEndStyle(editor!, c => c.toggleItalic(), { lookup, focus: false })
    expect(blocks()[0]!.attrs.styleId).toBeNull()
    expect(blocks()[1]!.attrs.styleId).toBe(ID)
  })

  it('a change in deliberately unstyled words of a linked paragraph keeps the paragraph linked', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    mount([
      {
        type: 'paragraph',
        attrs: { styleId: ID },
        content: [{ type: 'text', text: 'styled ', marks: [{ type: 'namedStyle', attrs: { id: ID } }] }, { type: 'text', text: 'plain' }],
      },
    ])
    select(11)
    runWithEndStyle(editor!, c => c.toggleBold(), { lookup, focus: false })
    expect(blocks()[0]!.attrs.styleId).toBe(ID)
  })

  it('turning the last styled line into a heading ends the style for good (the added empty line does not bring it back)', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Last')
    runWithEndStyle(editor!, c => c.setHeading({ level: 2 }), { lookup, focus: false })
    type('!')
    const heading = blocks()[0]!
    expect(heading.type).toBe('heading')
    expect(heading.attrs.styleId).toBeNull()
    expect(heading.content.at(-1).marks?.some((m: Json) => m.type === 'namedStyle') ?? false).toBe(false)
  })

  it('clear formatting at the cursor types plain, even over direct bold and color', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    const { clearInlineFormatting } = await import('./styleCommands.ts')
    const marks = [{ type: 'namedStyle', attrs: { id: ID } }, { type: 'bold' }, { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: null, fontSize: null } }]
    mount([{ type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'Hi', marks }] }])
    select(3)
    runWithEndStyle(
      editor!,
      c => c.command(({ tr }) => {
        clearInlineFormatting(tr)
        return true
      }).clearNodes(),
      { lookup, focus: false, materialize: false },
    )
    type('x')
    expect(blocks()[0]!.content.at(-1)).toEqual({ type: 'text', text: 'x' })
  })

  it('shows Bold for text whose different styles are both bold', () => {
    const other = '22222222-2222-4222-8222-222222222222'
    mount([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'aa', marks: [{ type: 'namedStyle', attrs: { id: ID } }] },
          { type: 'text', text: 'bb', marks: [{ type: 'namedStyle', attrs: { id: other } }] },
        ],
      },
    ])
    select(1, 5)
    const table: Record<string, StyleProps> = { [ID]: { bold: true, color: '#111111' }, [other]: { bold: true, color: '#222222' } }
    const props = effectiveTextProps(editor!.state, id => table[id])
    expect(props?.bold).toBe(true)
    expect(props?.color).toBeUndefined()
  })

  it('clear formatting at the cursor types plain even with no style (direct bold only)', async () => {
    const { clearFormatting } = await import('../components/Toolbar.tsx').catch(() => ({ clearFormatting: null }))
    const { runWithEndStyle } = await import('./endStyle.ts')
    const { clearInlineFormatting } = await import('./styleCommands.ts')
    mount([{ type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] }])
    select(5)
    const clear = clearFormatting
      ? () => clearFormatting(editor! as never)
      : () =>
          runWithEndStyle(editor!, c => c.command(({ tr }) => (clearInlineFormatting(tr), true)).clearNodes(), { lookup, focus: false, materialize: false })
    clear()
    type('X')
    expect(blocks()[0]!.content.at(-1)).toEqual({ type: 'text', text: 'X' })
  })

  it('a real Ctrl+B keypress ends the style once (bold off, color kept)', () => {
    styledLine('Key')
    const event = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true })
    editor!.view.dom.dispatchEvent(event)
    type('!')
    const last = blocks()[0]!.content.at(-1)
    // With no styles loaded in this test, the style can't be resolved: it is left alone, never dropped.
    expect(last.marks.some((m: Json) => m.type === 'namedStyle') || last.marks.some((m: Json) => m.type === 'bold')).toBe(true)
  })

  it('changing the paragraph type of partly selected styled lines keeps the style alignment', async () => {
    const { runWithEndStyle, changeParagraphType } = await import('./endStyle.ts')
    const mark = [{ type: 'namedStyle', attrs: { id: ID } }]
    mount([
      { type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'One', marks: mark }] },
      { type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'Two', marks: mark }] },
    ])
    select(2, 7)
    runWithEndStyle(editor!, c => changeParagraphType(c, chain => chain.setHeading({ level: 1 }), lookup), { lookup, focus: false })
    const headings = blocks().filter(block => block.type === 'heading')
    expect(headings).toHaveLength(2)
    for (const block of headings) expect(block).toMatchObject({ attrs: { styleId: null, textAlign: 'center' } })
  })

  it('never drops a style it cannot resolve (styles not loaded yet)', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    styledLine('Hello')
    select(1, 6)
    runWithEndStyle(editor!, c => c.toggleItalic(), { lookup: () => undefined, focus: false })
    const marks = blocks()[0]!.content[0].marks
    expect(marks).toContainEqual({ type: 'namedStyle', attrs: { id: ID } })
    expect(marks).toContainEqual({ type: 'italic' })
  })

  it('clear formatting at the cursor ends the style without keeping its look', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    const { clearInlineFormatting } = await import('./styleCommands.ts')
    styledLine('Hello')
    runWithEndStyle(
      editor!,
      c => c.command(({ tr }) => {
        clearInlineFormatting(tr)
        return true
      }).clearNodes(),
      { lookup, focus: false, materialize: false },
    )
    type('x')
    const last = blocks()[0]!.content.at(-1)
    expect(last).toEqual({ type: 'text', text: 'x' })
    expect(blocks()[0]!.attrs.styleId).toBeNull()
  })
})

describe('the formatting shortcuts end the style (real key presses)', () => {
  const styleProps: StyleProps = { color: '#9334e6', bold: true, align: 'center' }

  async function prepared(text: string) {
    const { setStylesForTesting } = await import('../state/namedStyles.ts')
    setStylesForTesting([style(styleProps)])
    mount([{ type: 'paragraph' }])
    select(1)
    apply(styleProps)
    type(text)
  }

  function press(key: string, code: string, keyCode: number, modifiers: { shift?: boolean; alt?: boolean } = {}) {
    const event = new KeyboardEvent('keydown', {
      key,
      code,
      keyCode,
      ctrlKey: true,
      shiftKey: Boolean(modifiers.shift),
      altKey: Boolean(modifiers.alt),
      bubbles: true,
      cancelable: true,
    } as KeyboardEventInit)
    editor!.view.dom.dispatchEvent(event)
  }

  const lastMarks = () => (blocks()[0]!.content.at(-1).marks ?? []) as Json[]

  it('Ctrl+Shift+S (strikethrough)', async () => {
    await prepared('Strike')
    press('S', 'KeyS', 83, { shift: true })
    type('!')
    expect(lastMarks().some(m => m.type === 'namedStyle')).toBe(false)
    expect(lastMarks()).toContainEqual({ type: 'strike' })
    expect(lastMarks()).toContainEqual({ type: 'bold' })
  })

  it('Ctrl+Shift+R (align right)', async () => {
    await prepared('Right')
    press('R', 'KeyR', 82, { shift: true })
    type('!')
    expect(blocks()[0]!.attrs).toMatchObject({ styleId: null, textAlign: 'right' })
    expect(lastMarks().some(m => m.type === 'namedStyle')).toBe(false)
  })

  it('Ctrl+Alt+2 (heading 2)', async () => {
    await prepared('Head')
    press('2', 'Digit2', 50, { alt: true })
    type('!')
    const heading = blocks()[0]!
    expect(heading).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: null, textAlign: 'center' } })
    expect(lastMarks().some(m => m.type === 'namedStyle')).toBe(false)
  })

  it('an action that cannot apply does not end the style', async () => {
    const { runWithEndStyle } = await import('./endStyle.ts')
    await prepared('Stay')
    const ran = runWithEndStyle(editor!, c => c.command(() => false), { focus: false })
    expect(ran).toBe(false)
    expect(blocks()[0]!.attrs.styleId).toBe(ID)
  })
})


describe('code review fixes (grok)', () => {
  const props: StyleProps = { color: '#9334e6', block: 'h2' }
  const tag = { type: 'namedStyle', attrs: { id: ID } }
  const section = (lines: Json[]) => [
    { type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Sum' }] }, { type: 'detailsContent', content: lines }] },
  ]
  const emptyStyled = { type: 'paragraph', attrs: { styleId: ID } }

  async function withStyle() {
    const { setStylesForTesting } = await import('../state/namedStyles.ts')
    setStylesForTesting([style(props)])
  }

  it('Enter on an empty styled last line of a section leaves the section, keeping the style', () => {
    mount(section([{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }, emptyStyled]))
    select(14)
    enter()
    type('After')
    const [details, after] = blocks()
    expect(details!.content[1].content).toHaveLength(1)
    expect(details!.content[1].content[0].content[0].text).toBe('Body')
    expect(after).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
    expect(after!.content[0].text).toBe('After')
    expect(tagged(after)).toBe(true)
  })

  it('Enter on an only, empty styled line of a section leaves it too (the section keeps a plain line)', () => {
    mount(section([emptyStyled]))
    select(8)
    enter()
    const [details, after] = blocks()
    expect(details!.content[1].content).toEqual([{ type: 'paragraph', attrs: { textAlign: null, styleId: null } }])
    expect(after).toMatchObject({ type: 'paragraph', attrs: { styleId: ID } })
  })

  it('an empty styled line in the middle of a section adds a line there (only the last line exits)', () => {
    mount(section([emptyStyled, { type: 'paragraph', content: [{ type: 'text', text: 'Below' }] }]))
    select(8)
    enter()
    const lines = blocks()[0]!.content[1].content
    expect(lines).toHaveLength(3)
    expect(lines[2].content[0].text).toBe('Below')
  })

  it('paragraph type on a styled list item first line unlinks it without lifting it out of the list', async () => {
    const { runWithEndStyle, setParagraphType } = await import('./endStyle.ts')
    await withStyle()
    mount([{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'One', marks: [tag] }] }] }] }])
    select(6)
    const ran = runWithEndStyle(editor!, c => setParagraphType(c, { type: 'heading', level: 1 }), { focus: false })
    expect(ran).toBe(true)
    const list = blocks()[0]!
    expect(list.type).toBe('bulletList')
    const line = list.content[0].content[0]
    expect(line).toMatchObject({ type: 'paragraph', attrs: { styleId: null } })
    type('!')
    const typed = blocks()[0]!.content[0].content[0].content.at(-1)
    expect(typed.marks?.some((m: Json) => m.type === 'namedStyle') ?? false).toBe(false)
  })

  it('Ctrl+Alt+1 on a styled list item first line unlinks it too (and stays in the list)', async () => {
    await withStyle()
    mount([{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'One', marks: [tag] }] }] }] }])
    select(4)
    editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', keyCode: 49, ctrlKey: true, altKey: true, bubbles: true, cancelable: true } as KeyboardEventInit))
    const list = blocks()[0]!
    expect(list.type).toBe('bulletList')
    expect(list.content[0].content[0]).toMatchObject({ type: 'paragraph', attrs: { styleId: null } })
  })

  it('Normal text on an already-paragraph styled line ends the style', async () => {
    const { runWithEndStyle, setParagraphType } = await import('./endStyle.ts')
    const { setStylesForTesting } = await import('../state/namedStyles.ts')
    setStylesForTesting([style({ color: '#9334e6', align: 'center' })])
    mount([{ type: 'paragraph', attrs: { styleId: ID }, content: [{ type: 'text', text: 'Hi', marks: [tag] }] }])
    select(3)
    expect(runWithEndStyle(editor!, c => setParagraphType(c, { type: 'paragraph' }), { focus: false })).toBe(true)
    type('!')
    const line = blocks()[0]!
    expect(line).toMatchObject({ type: 'paragraph', attrs: { styleId: null, textAlign: 'center' } })
    expect(line.content.at(-1).marks.some((m: Json) => m.type === 'namedStyle')).toBe(false)
  })

  it('Normal text on an unstyled paragraph changes nothing and is not applicable', async () => {
    const { runWithEndStyle, setParagraphType } = await import('./endStyle.ts')
    mount([{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }])
    select(2)
    const before = JSON.stringify(blocks())
    expect(runWithEndStyle(editor!, c => setParagraphType(c, { type: 'paragraph' }), { focus: false })).toBe(false)
    expect(JSON.stringify(blocks())).toBe(before)
  })

  it('heading shortcuts still toggle: Ctrl+Alt+2 on an H2 makes it normal text', async () => {
    mount([{ type: 'heading', attrs: { level: 2, textAlign: 'right' }, content: [{ type: 'text', text: 'H' }] }])
    select(2)
    editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', keyCode: 50, ctrlKey: true, altKey: true, bubbles: true, cancelable: true } as KeyboardEventInit))
    expect(blocks()[0]).toMatchObject({ type: 'paragraph', attrs: { textAlign: 'right' } })
  })

  it('changing several lines to a heading keeps each line alignment', async () => {
    const { runWithEndStyle, setParagraphType } = await import('./endStyle.ts')
    mount([
      { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'A' }] },
      { type: 'paragraph', attrs: { textAlign: 'right' }, content: [{ type: 'text', text: 'B' }] },
    ])
    select(1, 5)
    runWithEndStyle(editor!, c => setParagraphType(c, { type: 'heading', level: 3 }), { focus: false })
    expect(blocks().slice(0, 2).map(b => [b.type, b.attrs.level, b.attrs.textAlign])).toEqual([['heading', 3, 'center'], ['heading', 3, 'right']])
  })
})
