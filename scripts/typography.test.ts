// The page's typography is written twice: as CSS (web/src/styles/editor.css, what the page draws)
// and as data (shared/styleProps.ts, what saved styles generate and what the toolbar and the Format
// sidebar report). This keeps them equal. Lives in scripts/ (Node types) because it reads the file.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BLOCK_TYPOGRAPHY, ELEMENT_COLORS } from '../shared/styleProps.ts'

const css = readFileSync(new URL('../web/src/styles/editor.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Every top-level rule: selector list → declarations (later rules for the same selector merge in). */
const rules = new Map<string, Record<string, string>>()
for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const declarations: Record<string, string> = {}
  for (const [, name, value] of body!.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) declarations[name!] = value!.trim()
  for (const selector of selectors!.split(',').map(part => part.trim().replace(/\s+/g, ' '))) {
    rules.set(selector, { ...rules.get(selector), ...declarations })
  }
}
const rule = (selector: string) => rules.get(selector) ?? {}

/** #abc → #aabbcc, lowercase. */
function hex(value: string | undefined): string | undefined {
  if (!value) return value
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  return (short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : value).toLowerCase()
}

describe('page typography', () => {
  const page = rule('.document')

  it('normal text matches its table entry', () => {
    const look = BLOCK_TYPOGRAPHY.paragraph
    expect(page['font-size']).toBe(look.fontSize)
    expect(page['line-height']).toBe(look.lineHeight)
    expect(hex(page.color)).toBe(look.color)
    expect(rule('.document p').margin).toBe(look.margin)
  })

  it.each([1, 2, 3, 4, 5, 6] as const)('heading %i matches its table entry', level => {
    const look = BLOCK_TYPOGRAPHY[`h${level}`]
    // The shared heading rule, then the level's own (a heading without a color inherits the page's).
    const drawn: Record<string, string | undefined> = { 'font-style': 'normal', color: page.color, ...rule(`.document h${level}`) }
    expect(drawn['font-size']).toBe(look.fontSize)
    expect(Number(drawn['font-weight'])).toBe(look.fontWeight)
    expect(drawn['line-height']).toBe(look.lineHeight)
    expect(drawn.margin).toBe(look.margin)
    expect(drawn['font-style']).toBe(look.fontStyle)
    expect(hex(drawn.color)).toBe(look.color)
  })

  it('element colors match the page', () => {
    expect(hex(rule('.document a').color)).toBe(ELEMENT_COLORS.link)
    expect(hex(rule('.document blockquote').color)).toBe(ELEMENT_COLORS.quote)
    expect(hex(rule(".document ul[data-type='taskList'] li[data-checked='true'] > div").color)).toBe(ELEMENT_COLORS.checked)
    expect(hex(rule('.document mark')['background-color'])).toBe(ELEMENT_COLORS.highlight)
    expect(rule('.document code')['font-family']).toMatch(/\bmonospace\b/)
  })
})
