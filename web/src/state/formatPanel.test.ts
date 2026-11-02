// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFormatPanel, resetFormatPanelForTesting, setFormatPanelOpen, subscribeFormatPanel, toggleFormatPanel } from './formatPanel.ts'

let width = 1400
const listeners = new Set<() => void>()
const realMatchMedia = window.matchMedia
afterAll(() => {
  window.matchMedia = realMatchMedia
  resetFormatPanelForTesting()
})
function setWidth(next: number) {
  width = next
  for (const listener of listeners) listener()
}

beforeEach(() => {
  window.localStorage.clear()
  resetFormatPanelForTesting()
  width = 1400
  window.matchMedia = ((query: string) => {
    const min = /min-width: (\d+)px/.exec(query)
    const max = /max-width: (\d+)px/.exec(query)
    return {
      get matches() {
        return min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }
  }) as unknown as typeof window.matchMedia
})
afterEach(() => listeners.clear())

describe('Format sidebar state', () => {
  it('first use: open on wide windows, closed on narrower docked ones', () => {
    expect(getFormatPanel()).toMatchObject({ mode: 'docked', open: true })
    resetFormatPanelForTesting()
    width = 1250
    expect(getFormatPanel()).toMatchObject({ mode: 'docked', open: false })
  })

  it('the docked choice is remembered per device', () => {
    toggleFormatPanel()
    expect(getFormatPanel().open).toBe(false)
    expect(window.localStorage.getItem('margin:format-panel')).toBe('closed')
    resetFormatPanelForTesting()
    expect(getFormatPanel().open).toBe(false)
  })

  it('medium windows and phones start closed whatever is stored, and do not change it', () => {
    window.localStorage.setItem('margin:format-panel', 'open')
    width = 1000
    expect(getFormatPanel()).toMatchObject({ mode: 'overlay', open: false })
    setFormatPanelOpen(true)
    expect(getFormatPanel().open).toBe(true)
    setFormatPanelOpen(false)
    expect(window.localStorage.getItem('margin:format-panel')).toBe('open')
    resetFormatPanelForTesting()
    width = 400
    expect(getFormatPanel()).toMatchObject({ mode: 'sheet', open: false })
  })

  it('crossing into another mode closes an overlay or sheet', () => {
    width = 1000
    const stop = subscribeFormatPanel(() => undefined)
    getFormatPanel()
    setFormatPanelOpen(true)
    setWidth(500)
    expect(getFormatPanel()).toMatchObject({ mode: 'sheet', open: false })
    setWidth(1400)
    expect(getFormatPanel()).toMatchObject({ mode: 'docked', open: true })
    stop()
  })

})

describe('Format sidebar without storage', () => {
  it('the toggle still works when the browser blocks storage', () => {
    const original = Storage.prototype.setItem
    const get = Storage.prototype.getItem
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(getFormatPanel().open).toBe(true)
      toggleFormatPanel()
      expect(getFormatPanel().open).toBe(false)
      toggleFormatPanel()
      expect(getFormatPanel().open).toBe(true)
    } finally {
      Storage.prototype.setItem = original
      Storage.prototype.getItem = get
    }
  })
})

describe('Format sidebar with read-only storage', () => {
  it('a choice that could not be written wins over the stored one', () => {
    window.localStorage.setItem('margin:format-panel', 'closed')
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(getFormatPanel().open).toBe(false)
      toggleFormatPanel()
      expect(getFormatPanel().open).toBe(true)
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
