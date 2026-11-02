// @vitest-environment happy-dom
// The tag field in a mounted React tree: typing, delimiters, paste, invalid text, Backspace.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { TagEditor } from './TagEditor.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement
let current: string[] = []
let lastChange: string[] | null = null
const opened: string[] = []

function Harness({ initial, disabled = false }: { initial: string[]; disabled?: boolean }) {
  const [tags, setTags] = useState(initial)
  current = tags
  return createElement(TagEditor, {
    tags,
    suggestions: ['work', 'home', 'ideas'],
    disabled,
    onChange: next => {
      lastChange = next
      setTags(next)
    },
    onOpenTag: tag => opened.push(tag),
  })
}

async function mount(initial: string[] = [], disabled = false) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Harness, { initial, disabled })))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  opened.length = 0
})

const input = () => container.querySelector<HTMLInputElement>('.tag-input')!

async function type(text: string) {
  const field = input()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, text)
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }))
  })
}

async function key(name: string, target: HTMLElement = input()) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })
}

describe('TagEditor', () => {
  it('commits on Enter, lowercasing; duplicates are ignored', async () => {
    await mount()
    await type('Work')
    await key('Enter')
    expect(current).toEqual(['work'])
    expect(input().value).toBe('')
    await type('work')
    await key('Enter')
    expect(current).toEqual(['work'])
  })

  it('a typed space or comma commits what came before it (phone keyboards)', async () => {
    await mount(['a'])
    await type('one two,')
    expect(current).toEqual(['a', 'one', 'two'])
    await type('thr')
    expect(input().value).toBe('thr')
  })

  it('keeps invalid text in the field with a message', async () => {
    await mount()
    await type('to-do')
    await key('Enter')
    expect(current).toEqual([])
    expect(input().value).toBe('to-do')
    expect(container.querySelector('.tag-error')?.textContent).toContain('a–z and 0–9')
    expect(input().getAttribute('aria-invalid')).toBe('true')
  })

  it('paste splits into tags and keeps every rejected piece', async () => {
    await mount()
    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      event.clipboardData = { getData: () => 'alpha bad-one beta, wh@t' }
      input().dispatchEvent(event)
    })
    expect(current).toEqual(['alpha', 'beta'])
    expect(input().value).toBe('bad-one wh@t')
  })

  it('Backspace in an empty field moves to the last chip; Backspace there removes it', async () => {
    await mount(['one', 'two'])
    await key('Backspace')
    const removeTwo = container.querySelector<HTMLButtonElement>('[aria-label="Remove tag two"]')!
    expect(document.activeElement).toBe(removeTwo)
    await key('Backspace', removeTwo)
    expect(current).toEqual(['one'])
  })

  it('the chip name filters by the tag', async () => {
    await mount(['work'])
    await act(async () => container.querySelector<HTMLButtonElement>('.tag-chip-name')!.click())
    expect(opened).toEqual(['work'])
  })

  it('read-only notes show chips without the field or remove buttons', async () => {
    await mount(['work'], true)
    expect(container.querySelector('.tag-input')).toBeNull()
    expect(container.querySelector('.tag-chip-remove')).toBeNull()
  })

  it('does not commit while an input method is composing', async () => {
    await mount()
    await type('ab')
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    })
    expect(current).toEqual([])
    expect(input().value).toBe('ab')
  })
})

describe('TagEditor (plan review)', () => {
  it('keeps valid typed text when the note closes before the field blurs', async () => {
    await mount(['a'])
    await type('later')
    lastChange = null
    await act(async () => root!.unmount())
    root = null
    // In the app this goes straight to the save queue, which outlives the note view.
    expect(lastChange).toEqual(['a', 'later'])
  })

  it('moving focus to a chip button does not commit (the click lands where aimed)', async () => {
    await mount(['one'])
    await type('two')
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove tag one"]')!
    await act(async () => {
      input().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: remove }))
    })
    expect(current).toEqual(['one'])
    expect(input().value).toBe('two')
  })

  it('a tag that is already there is a quiet no-op', async () => {
    await mount(['work'])
    await type('Work')
    await key('Enter')
    expect(current).toEqual(['work'])
    expect(container.querySelector('.tag-error')).toBeNull()
    expect(container.querySelector('[aria-live]')?.textContent).toBe('Tag already added')
  })
})

describe('TagEditor keeps typed tags without a blur', () => {
  it('when the page is hidden or closed', async () => {
    await mount(['a'])
    await type('typed')
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(current).toEqual(['a', 'typed'])
    expect(input().value).toBe('')
  })

  it('when editing locks (signing out)', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    let lock: (value: boolean) => void = () => undefined
    function Lockable() {
      const [disabled, setDisabled] = useState(false)
      lock = setDisabled
      return createElement(Harness, { initial: [], disabled })
    }
    await act(async () => root!.render(createElement(Lockable)))
    await type('beforelock')
    await act(async () => lock(true))
    expect(lastChange).toEqual(['beforelock'])
  })
})

describe('TagEditor and input methods', () => {
  it('never saves unfinished composition text, even when the page hides', async () => {
    await mount()
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await type('ni')
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(current).toEqual([])
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(current).toEqual(['ni'])
  })
})

describe('TagEditor key repeat', () => {
  it('a held Backspace does not delete every tag', async () => {
    await mount(['a', 'b', 'c'])
    const repeat = async (target: HTMLElement) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: true, bubbles: true, cancelable: true }))
      })
    await repeat(input())
    expect(document.activeElement?.classList.contains('tag-chip-remove')).toBe(false)
    await key('Backspace') // a fresh press moves to the last chip
    const removeC = container.querySelector<HTMLButtonElement>('[aria-label="Remove tag c"]')!
    await repeat(removeC)
    expect(current).toEqual(['a', 'b', 'c'])
    await key('Backspace', removeC)
    expect(current).toEqual(['a', 'b'])
  })
})

describe('TagEditor focus after removing', () => {
  it('removing the last chip puts focus in the field; a middle one moves to the next chip', async () => {
    await mount(['a', 'b', 'c'])
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove tag b"]')!.click())
    await act(async () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove tag c')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove tag c"]')!.click())
    await act(async () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))))
    expect(document.activeElement).toBe(input())
  })
})
