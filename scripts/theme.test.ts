// The theme's color pairs meet WCAG AA in both themes: text ≥ 4.5:1; control edges, focus rings,
// selection marks and dots ≥ 3:1. Parses the token blocks of app.css, so an edit can't silently
// break contrast. Translucent colors are composited over the background they sit on.
// Lives in scripts/ (Node types) because it reads the stylesheets from disk.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CANDY } from '../web/src/state/candy.ts'

const appCss = readFileSync(new URL('../web/src/styles/app.css', import.meta.url), 'utf8')
const editorCss = readFileSync(new URL('../web/src/styles/editor.css', import.meta.url), 'utf8')

/** The declarations of the first rule whose selector matches, up to its matching closing brace. */
function block(selector: RegExp): Record<string, string> {
  const match = selector.exec(appCss)
  if (!match) throw new Error(`no block ${selector}`)
  const start = match.index + match[0].length
  let depth = 1
  let end = start
  while (depth > 0 && end < appCss.length) {
    const c = appCss[end++]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
  }
  const body = appCss.slice(start, end - 1)
  const tokens: Record<string, string> = {}
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[name!] = value!.trim()
  return tokens
}

const light = block(/:root,\s*\[data-theme=['"]light['"]\]\s*\{/)
const dark = { ...light, ...block(/(?:^|\n)\[data-theme=['"]dark['"]\]\s*\{/) }

type RGBA = [number, number, number, number]

function parse(value: string): RGBA {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim())
  if (hex && [3, 4, 6, 8].includes(hex[1]!.length)) {
    const digits = hex[1]!.length <= 4 ? [...hex[1]!].map(d => d + d).join('') : hex[1]!
    const n = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16)
    return [n(0), n(1), n(2), digits.length === 8 ? n(3) / 255 : 1]
  }
  // rgb()/rgba() in space or comma syntax, alpha as a fraction or a percentage.
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value.trim())
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha]
  }
  throw new Error(`can't parse color ${value}`)
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3]
  return [0, 1, 2].map(i => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as RGBA
}

function luminance([r, g, b]: RGBA): number {
  const [R, G, B] = [r, g, b].map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!
}

function ratio(a: RGBA, b: RGBA): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

/** Contrast of token `fg` on token `bg` (bg itself composited over `base` if translucent). */
function contrast(theme: Record<string, string>, fg: string, bg: string, base = 'surface'): number {
  const resolve = (name: string) => {
    const value = theme[name] ?? name
    if (!value) throw new Error(`no token ${name}`)
    return parse(value)
  }
  const ground = over(resolve(bg), resolve(base))
  return ratio(over(resolve(fg), ground), ground)
}

const TEXT_GROUNDS = ['bg', 'sidebar', 'surface', 'surface-solid', 'surface-sunk', 'canvas']
const TEXT_PAIRS: Array<[string, string]> = [
  ...['text', 'muted', 'faint'].flatMap(fg => TEXT_GROUNDS.map(bg => [fg, bg] as [string, string])),
  ['text', 'accent-soft'],
  ['muted', 'accent-soft'],
  ['faint', 'accent-soft'],
  ['accent-ink', 'accent-soft'],
  ['tool-active-ink', 'tool-active-bg'],
  ['tool-ink', 'surface'],
  ['accent', 'surface'],
  ['accent', 'sidebar'],
  ['accent', 'bg'],
  ['primary-ink', 'primary'],
  ['primary-ink', 'primary-hover'],
  ['danger', 'surface'],
  // Phase 7 tags: the tag on the active note row, chip hover, the tag field's error.
  ['accent-ink', 'surface-solid'],
  ['danger', 'bg'],
  ['danger', 'canvas'],
  ['danger', 'danger-soft'],
  ...CANDY.map(tone => [`${tone}-ink`, `${tone}-fill`] as [string, string]),
]
const UI_PAIRS: Array<[string, string]> = [
  ['control-border', 'surface'],
  ['control-border', 'surface-solid'],
  ['control-border', 'surface-sunk'],
  ['control-border', 'sidebar'],
  ['focus', 'bg'],
  ['focus', 'sidebar'],
  ['focus', 'surface'],
  ['focus', 'surface-solid'],
  // The 2px mark on selected rows, tools and chips.
  ['accent', 'accent-soft'],
  ...CANDY.flatMap(tone => [[tone, 'sidebar'], [tone, 'accent-soft']] as Array<[string, string]>),
]

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, theme) => {
  it.each(TEXT_PAIRS)('text %s on %s ≥ 4.5', (fg, bg) => {
    expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(UI_PAIRS)('ui %s on %s ≥ 3', (fg, bg) => {
    expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(3)
  })
  it.each(['surface', 'surface-solid', 'sidebar', 'bg'])('translucent danger-soft over %s keeps danger text ≥ 4.5', base => {
    expect(contrast(theme, 'danger', 'danger-soft', base)).toBeGreaterThanOrEqual(4.5)
  })
  it('disabled tools look disabled but stay visible (about 3:1)', () => {
    const value = contrast(theme, 'tool-disabled', 'surface')
    expect(value).toBeGreaterThanOrEqual(2.8)
    expect(value).toBeLessThan(4.5)
  })
})

describe('every token used is defined', () => {
  it('each var(--x) in the stylesheets is declared somewhere (or set by a helper class)', () => {
    const css = appCss + editorCss
    const declared = new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]))
    const missing = [...new Set([...css.matchAll(/var\(--([\w-]+)/g)].map(m => m[1]))].filter(name => !declared.has(name))
    expect(missing).toEqual([])
  })
})

describe('the page (always white)', () => {
  const white: RGBA = [255, 255, 255, 1]
  // The rule whose full selector (at the start of a line) is `selector`.
  const rule = (selector: string, prop: string) => {
    const at = editorCss.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`))
    expect(at, selector).toBeGreaterThanOrEqual(0)
    const body = editorCss.slice(at, editorCss.indexOf('}', at))
    const value = new RegExp(`\\n\\s*${prop}:\\s*([^;]+);`).exec(body)?.[1]
    expect(value, `${selector} ${prop}`).toBeDefined()
    return value!.trim()
  }
  it('the page edge shows against the canvas around it, in both themes', () => {
    const edge = /border: 1px solid (#[0-9a-f]{6})/i.exec(editorCss.slice(editorCss.indexOf('.page {')))![1]!
    for (const theme of [light, dark]) expect(ratio(parse(edge), parse(theme.canvas!))).toBeGreaterThanOrEqual(3)
    expect(ratio(parse(edge), white)).toBeGreaterThanOrEqual(3)
  })
  it('keyboard focus on the page uses the page accent, visible on white', () => {
    expect(rule('.page :focus-visible', 'outline-color')).toBe('var(--page-accent)')
    expect(ratio(parse(rule('.page', '--page-accent')), white)).toBeGreaterThanOrEqual(3)
  })
  it('editor placeholders and completed tasks are readable', () => {
    for (const selector of [
      '.document p.is-editor-empty:first-child::before',
      ".document ul[data-type='taskList'] li[data-checked='true'] > div",
      '.document summary.is-empty::before',
    ]) {
      const value = rule(selector, 'color')
      expect(ratio(parse(value), white), selector).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('the image upload placeholder edge is visible on white', () => {
    const edge = /border: 1px dashed (#[0-9a-f]{6})/i.exec(editorCss.slice(editorCss.indexOf('.image-upload-placeholder {')))![1]!
    expect(ratio(parse(edge), white)).toBeGreaterThanOrEqual(3)
  })
  it('selected text (links included) stays readable', () => {
    const background = rule('.document ::selection', 'background')
    const color = rule('.document ::selection', 'color')
    expect(ratio(parse(color), parse(background))).toBeGreaterThanOrEqual(4.5)
  })
})
