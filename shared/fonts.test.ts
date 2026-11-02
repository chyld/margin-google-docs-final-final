import { describe, expect, it } from 'vitest'
import { isSafeFontFamily, isSafeFontSize } from './doc.ts'
import catalog from './font-catalog.json' with { type: 'json' }
import { css2FamilyParam, firstFontFamily, fontFamilyValue, fontSlug } from './fonts.ts'
import type { FontCatalogEntry } from './fonts.ts'

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
