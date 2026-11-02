// @vitest-environment happy-dom
// The Format sidebar mounted: read-only behaviour, Escape, the phone sheet's Tab trap, the Styles
// menu request.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { extensions } from '../../../shared/extensions.ts'
import { FormatPanel } from './FormatPanel.tsx'
import { getFormatPanel, resetFormatPanelForTesting } from '../state/formatPanel.ts'
import { setStylesForTesting } from '../state/namedStyles.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = '11111111-1111-4111-8111-111111111111'
let root: Root | null = null
let container: HTMLDivElement
let editor: Editor
let closed: Array<{ restoreFocus?: boolean } | undefined>

beforeEach(() => {
  resetFormatPanelForTesting()
  setStylesForTesting([{ id: ID, name: 'Callout', props: { bold: true }, favoriteSlot: null, deleted: false, createdAt: 0, updatedAt: 0 }])
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({
    element,
    extensions,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello', marks: [{ type: 'namedStyle', attrs: { id: ID } }] }] }] },
  })
  editor.commands.setTextSelection(3)
  closed = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  editor.destroy()
})

async function mount(mode: 'docked' | 'overlay' | 'sheet', off = false) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(createElement(FormatPanel, { editor: editor as never, mode, off, readOnlyNote: off, onClose: options => closed.push(options) })),
  )
}

const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
  })

describe('FormatPanel', () => {
  it('names the style and opens the Styles menu from it', async () => {
    await mount('docked')
    const name = container.querySelector<HTMLButtonElement>('.format-style-name.is-button')!
    expect(name.textContent).toBe('Callout')
    const before = getFormatPanel().stylesRequest
    await act(async () => name.click())
    expect(getFormatPanel().stylesRequest).toBe(before + 1)
  })

  it('read-only: the style name is plain text, Clear formatting is off, the tag shows', async () => {
    await mount('docked', true)
    expect(container.querySelector('.format-style-name.is-button')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.format-foot button')!.disabled).toBe(true)
    expect(container.querySelector('.format-tag')?.textContent).toBe('Read-only')
  })

  it('Escape closes an overlay, but not when something inside already handled it, and never a docked panel', async () => {
    await mount('overlay')
    const aside = container.querySelector('aside')!
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      event.preventDefault()
      aside.dispatchEvent(event)
    })
    expect(closed).toHaveLength(0)
    await key(aside, 'Escape')
    expect(closed).toHaveLength(1)
    await act(async () => root!.unmount())
    root = null
    await mount('docked')
    await key(container.querySelector('aside')!, 'Escape')
    expect(closed).toHaveLength(1)
  })

  it('the phone sheet is a modal dialog: focus moves in and Tab stays inside', async () => {
    await mount('sheet')
    const aside = container.querySelector('aside')!
    expect(aside.getAttribute('role')).toBe('dialog')
    expect(document.activeElement?.classList.contains('format-close')).toBe(true)
    const clear = container.querySelector<HTMLButtonElement>('.format-foot button')!
    clear.focus()
    await key(clear, 'Tab')
    expect(document.activeElement?.classList.contains('format-close')).toBe(true)
  })
})
