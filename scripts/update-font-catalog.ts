// Regenerates shared/font-catalog.json from Google Fonts' public metadata.
// Run by hand (`npm run fonts:catalog`); the app itself never calls this endpoint.
import { writeFileSync } from 'node:fs'
import type { FontCatalogEntry } from '../shared/fonts.ts'

const METADATA_URL = 'https://fonts.google.com/metadata/fonts'
const OUTPUT = new URL('../shared/font-catalog.json', import.meta.url)

type Family = {
  family: string
  category: string
  popularity: number
  fonts: Record<string, unknown>
}

const response = await fetch(METADATA_URL)
if (!response.ok) throw new Error(`metadata request failed: ${response.status}`)
// The endpoint has historically been prefixed with an XSSI guard; strip it if present.
const text = (await response.text()).replace(/^\)\]\}'?\s*/, '')
const families = (JSON.parse(text) as { familyMetadataList: Family[] }).familyMetadataList

const entries: FontCatalogEntry[] = families
  .filter(family => /^[A-Za-z0-9 ]+$/.test(family.family))
  .sort((a, b) => a.popularity - b.popularity || a.family.localeCompare(b.family))
  .map(family => {
    const normal: number[] = []
    const italic: number[] = []
    for (const key of Object.keys(family.fonts)) {
      const match = /^(\d+)(i?)$/.exec(key)
      if (!match) continue
      ;(match[2] ? italic : normal).push(Number(match[1]))
    }
    return {
      f: family.family,
      k: family.category,
      w: normal.sort((a, b) => a - b),
      i: italic.sort((a, b) => a - b),
    }
  })
  .filter(entry => entry.w.length + entry.i.length > 0)

// One family per line keeps diffs readable when the catalog is refreshed.
writeFileSync(OUTPUT, `[\n${entries.map(entry => JSON.stringify(entry)).join(',\n')}\n]\n`)
console.log(`wrote ${entries.length} families to ${OUTPUT.pathname}`)
