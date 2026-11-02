// Google Fonts helpers shared by the server proxy and the font picker.

/** One family in shared/font-catalog.json. */
export type FontCatalogEntry = {
  /** Family name, e.g. "Open Sans". */
  f: string
  /** Google's category: Sans Serif, Serif, Display, Handwriting or Monospace. */
  k: string
  /** Available upright weights, ascending. */
  w: number[]
  /** Available italic weights, ascending. */
  i: number[]
}

export const FONT_CATEGORIES = ['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace'] as const

const GENERIC_FAMILY: Record<string, string> = {
  'Sans Serif': 'sans-serif',
  Serif: 'serif',
  Display: 'sans-serif',
  Handwriting: 'cursive',
  Monospace: 'monospace',
}

/** The page's own font, used when a run has no font family set (editor.css `.document`). */
export const DEFAULT_FONT = 'IBM Plex Sans'

/** Families bundled with the app (fontsource, main.tsx): never fetched through the font proxy, so
 *  the proxy can't add a second set of faces under the same name. */
export const BUNDLED_FONTS: ReadonlySet<string> = new Set(['IBM Plex Sans'])

/** URL- and filesystem-safe name for a family: "Open Sans" → "open-sans". */
export function fontSlug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** The CSS generic family for a catalog category (Handwriting → cursive). */
export function genericFamily(category: string): string {
  return GENERIC_FAMILY[category] ?? 'sans-serif'
}

/** The value stored in the textStyle mark, with a generic fallback: `"Open Sans", sans-serif`. */
export function fontFamilyValue(entry: FontCatalogEntry): string {
  return `"${entry.f}", ${genericFamily(entry.k)}`
}

/** The first family named in a CSS font-family value, without quotes. */
export function firstFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const first = value.split(',')[0]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  return first ? first : null
}

function closestTo400(weights: number[]): number | undefined {
  let best: number | undefined
  for (const weight of weights) {
    const distance = Math.abs(weight - 400)
    const bestDistance = best === undefined ? Infinity : Math.abs(best - 400)
    // On a tie prefer the heavier weight, which reads better as body text.
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && weight > best)) best = weight
  }
  return best
}

/**
 * The `family=` value for Google's css2 API: regular and bold, upright and italic, limited to the
 * weights the family really has. css2 answers 400 when none of the requested tuples exist, so a
 * family without a 400 weight gets its closest weight instead.
 */
export function css2FamilyParam(entry: FontCatalogEntry, kind: 'full' | 'preview' = 'full'): string {
  const upright = new Set<number>()
  const italic = new Set<number>()

  const base = entry.w.includes(400) ? 400 : closestTo400(entry.w)
  if (base !== undefined) upright.add(base)
  if (entry.w.includes(700)) upright.add(700)

  for (const weight of [400, 700]) if (entry.i.includes(weight)) italic.add(weight)
  if (upright.size === 0 && italic.size === 0) {
    const italicBase = closestTo400(entry.i)
    if (italicBase !== undefined) italic.add(italicBase)
  }

  const name = entry.f.replace(/ /g, '+')
  // A preview only needs one face to draw the family's name.
  if (kind === 'preview') {
    const [first] = [...upright].sort((a, b) => a - b)
    if (first !== undefined) return `${name}:wght@${first}`
    return `${name}:ital,wght@1,${[...italic].sort((a, b) => a - b)[0]}`
  }
  const byWeight = (a: number, b: number) => a - b
  if (italic.size === 0) return `${name}:wght@${[...upright].sort(byWeight).join(';')}`
  const tuples = [
    ...[...upright].sort(byWeight).map(weight => `0,${weight}`),
    ...[...italic].sort(byWeight).map(weight => `1,${weight}`),
  ]
  return `${name}:ital,wght@${tuples.join(';')}`
}
