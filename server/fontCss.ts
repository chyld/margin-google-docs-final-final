// Google Fonts' answers, checked: only fonts.gstatic.com URLs, stylesheets rebuilt from known-safe
// parts, and font files that start like font files. Pure functions (no I/O), so they're easy to
// review on their own; server/fonts.ts does the fetching and caching.
import { createHash } from 'node:crypto'

/** Google's format() names and the extension each is stored under. */
const FORMAT_EXT: Record<string, string> = { woff2: 'woff2', woff: 'woff', truetype: 'ttf' }

/** Only https://fonts.gstatic.com/… with no credentials or port. */
export function isGstaticUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'fonts.gstatic.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export function hasFontSignature(bytes: Uint8Array, ext: string): boolean {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  if (ext === 'woff2') return tag === 'wOF2'
  if (ext === 'woff') return tag === 'wOFF'
  return tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO'
}

export type Rewritten = { css: string; manifest: Record<string, string>; latinFiles: string[] }

// Values Google uses in @font-face; anything else drops the block.
const SAFE_VALUE = {
  style: /^(?:normal|italic|oblique)$/,
  weight: /^\d{1,4}(?: \d{1,4})?$/,
  stretch: /^[\d.]+%(?: [\d.]+%)?$|^[a-z-]+$/,
  range: /^[Uu+0-9A-Fa-f?,\s-]+$/,
}

/**
 * Rebuilds Google's stylesheet from known-safe parts only: one @font-face per block, with the
 * family name we choose, validated style/weight/range values and a local URL for the font file.
 */
export function rewriteFontCss(css: string, slug: string, familyName: string): Rewritten {
  const manifest: Record<string, string> = {}
  const latinFiles: string[] = []
  const blocks: string[] = []
  const BLOCK = /(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g

  for (const match of css.matchAll(BLOCK)) {
    const label = (match[1] ?? '').trim()
    const declarations = new Map<string, string>()
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':')
      if (colon > 0) declarations.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim())
    }

    const src = /^url\(\s*(['"]?)([^'")\s]+)\1\s*\)\s*format\(\s*['"]?([\w-]+)['"]?\s*\)$/.exec(declarations.get('src') ?? '')
    if (!src) continue
    const url = src[2] as string
    const ext = FORMAT_EXT[src[3] as string]
    if (!ext || !isGstaticUrl(url)) continue

    const style = declarations.get('font-style') ?? 'normal'
    const weight = declarations.get('font-weight') ?? '400'
    const stretch = declarations.get('font-stretch')
    const range = declarations.get('unicode-range')
    if (!SAFE_VALUE.style.test(style) || !SAFE_VALUE.weight.test(weight)) continue
    if (stretch !== undefined && !SAFE_VALUE.stretch.test(stretch)) continue
    if (range !== undefined && !SAFE_VALUE.range.test(range)) continue

    const file = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`
    manifest[file] = url
    if (label === 'latin' || label === 'latin-ext') latinFiles.push(file)

    blocks.push(
      [
        label && /^[\w\s[\]-]+$/.test(label) ? `/* ${label} */` : '',
        '@font-face {',
        `  font-family: '${familyName}';`,
        `  font-style: ${style};`,
        `  font-weight: ${weight};`,
        stretch ? `  font-stretch: ${stretch};` : '',
        '  font-display: swap;',
        `  src: url(/api/fonts/file/${slug}/${file}) format('${src[3]}');`,
        range ? `  unicode-range: ${range.replace(/\s+/g, ' ')};` : '',
        '}',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return { css: blocks.length ? `${blocks.join('\n')}\n` : '', manifest, latinFiles }
}
