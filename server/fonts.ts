// Google Fonts, cached in DATA_DIR/fonts so the browser never talks to Google.
//
// Outbound requests only ever go to fonts.googleapis.com (URLs built from the committed catalog)
// and fonts.gstatic.com (exact host check, no redirects). Each family has two independent
// stylesheets, the full one and a tiny "preview" one that only covers the family's own name, and
// each stylesheet has its own manifest, so nothing is ever read-modify-written.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { css2FamilyParam, fontSlug } from '../shared/fonts.ts'
import type { FontCatalogEntry } from '../shared/fonts.ts'

export type FontKind = 'full' | 'preview'
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const CSS_LIMIT = 512 * 1024
const FILE_LIMIT = 5 * 1024 * 1024
const TIMEOUT_MS = 10_000
const MAX_CONCURRENT_DOWNLOADS = 4
// Previews (the picker's list) yield to fonts a document uses, and are dropped rather than queued
// forever when the user scrolls through hundreds of rows.
const MAX_QUEUED_PREVIEWS = 24
const PREVIEW_QUEUE_TIMEOUT_MS = 15_000
const STALE_TEMP_MS = 24 * 60 * 60 * 1000
export const MAX_FAVORITES = 200
// css2 picks the font format from the User-Agent; a current desktop Chrome gets woff2.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const SLUG = /^[a-z0-9-]+$/
export const FONT_FILE = /^[0-9a-f]{16}\.(woff2|woff|ttf)$/
const FONT_TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' }
const FORMAT_EXT: Record<string, string> = { woff2: 'woff2', woff: 'woff', truetype: 'ttf' }

export class FontError extends Error {
  readonly status: 400 | 404 | 502 | 503
  /** Google's HTTP status, when Google answered with an error. */
  readonly upstreamStatus: number | undefined

  constructor(status: 400 | 404 | 502 | 503, message: string, upstreamStatus?: number) {
    super(message)
    this.status = status
    this.upstreamStatus = upstreamStatus
  }
}

export function loadFontCatalog(path: URL | string = new URL('../shared/font-catalog.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8')) as FontCatalogEntry[]
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

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

function hasFontSignature(bytes: Uint8Array, ext: string): boolean {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  if (ext === 'woff2') return tag === 'wOF2'
  if (ext === 'woff') return tag === 'wOFF'
  return tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO'
}

type Rewritten = { css: string; manifest: Record<string, string>; latinFiles: string[] }

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

export type FontServiceOptions = {
  db: DatabaseSync
  dir: string
  catalog: FontCatalogEntry[]
  fetchImpl?: FetchLike
  /** False disables every outbound request; cached fonts still work. */
  downloads?: boolean
  /** Download the Latin files right after a family's stylesheet is cached, so it works offline. */
  prefetchLatin?: boolean
}

export function createFontService({
  db,
  dir,
  catalog,
  fetchImpl = fetch,
  downloads = true,
  prefetchLatin = true,
}: FontServiceOptions) {
  const families = new Map<string, FontCatalogEntry>()
  const slugs = new Map<string, string>() // family → slug
  const bySlug = new Map<string, string>() // slug → family
  for (const entry of catalog) {
    // Names end up in Google URLs and in CSS strings; the generator only writes plain names, but
    // don't trust a hand-edited catalog file.
    if (!/^[A-Za-z0-9 ]{1,100}$/.test(entry.f)) continue
    let slug = fontSlug(entry.f)
    // None collide today; if a future catalog adds one, keep both reachable.
    for (let n = 2; bySlug.has(slug); n += 1) slug = `${fontSlug(entry.f)}-${n}`
    families.set(entry.f, entry)
    slugs.set(entry.f, slug)
    bySlug.set(slug, entry.f)
  }

  const inflight = new Map<string, Promise<unknown>>()
  function dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key)
    if (existing) return existing as Promise<T>
    const promise = task().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  // At most MAX_CONCURRENT_DOWNLOADS requests to Google at a time. A finishing request hands its
  // slot straight to the next waiter, document fonts first.
  type Priority = 'high' | 'low'
  let active = 0
  const waiting: Record<Priority, Array<() => void>> = { high: [], low: [] }

  function acquire(priority: Priority): Promise<void> {
    if (active < MAX_CONCURRENT_DOWNLOADS) {
      active += 1
      return Promise.resolve()
    }
    if (priority === 'low' && waiting.low.length >= MAX_QUEUED_PREVIEWS) {
      return Promise.reject(new FontError(503, 'Too many font previews requested at once'))
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer =
        priority === 'low'
          ? setTimeout(() => {
              const queue = waiting.low
              const index = queue.indexOf(grant)
              if (index >= 0) queue.splice(index, 1)
              reject(new FontError(503, 'Font preview timed out'))
            }, PREVIEW_QUEUE_TIMEOUT_MS)
          : undefined
      waiting[priority].push(grant)
    })
  }

  function release() {
    const next = waiting.high.shift() ?? waiting.low.shift()
    if (next) next()
    else active -= 1
  }

  async function limited<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    await acquire(priority)
    try {
      return await task()
    } finally {
      release()
    }
  }

  async function download(
    url: string,
    maxBytes: number,
    priority: Priority,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return limited(priority, async () => {
      let response: Response
      try {
        response = await fetchImpl(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'user-agent': USER_AGENT },
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new FontError(503, `Couldn't reach Google Fonts (${reason})`)
      }
      if (!response.ok) throw new FontError(503, `Google Fonts answered ${response.status}`, response.status)
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        throw new FontError(502, 'Google Fonts sent more data than expected')
      }

      const chunks: Uint8Array[] = []
      let total = 0
      const reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel()
            throw new FontError(502, 'Google Fonts sent more data than expected')
          }
          chunks.push(value)
        }
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { bytes, contentType: response.headers.get('content-type') ?? '' }
    })
  }

  const stylesheetPaths = (slug: string, kind: FontKind) => ({
    folder: join(dir, slug),
    css: join(dir, slug, `${kind}.css`),
    manifest: join(dir, slug, `${kind}.json`),
  })

  // A damaged or missing manifest reads as empty, so the stylesheet is simply fetched again.
  function readManifest(slug: string, kind: FontKind): Record<string, string> | null {
    try {
      const value = JSON.parse(readFileSync(stylesheetPaths(slug, kind).manifest, 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null
    } catch {
      return null
    }
  }

  // A stylesheet counts as cached only together with a readable manifest (written first).
  function cachedStylesheet(slug: string, kind: FontKind): string | null {
    if (!readManifest(slug, kind)) return null
    try {
      return readFileSync(stylesheetPaths(slug, kind).css, 'utf8')
    } catch {
      return null
    }
  }

  function manifestEntry(slug: string, file: string): { url: string; kind: FontKind } | null {
    for (const kind of ['full', 'preview'] as const) {
      const url = readManifest(slug, kind)?.[file]
      if (typeof url === 'string') return { url, kind }
    }
    return null
  }

  // Interrupted writes leave *.tmp-* files behind; clear old ones on startup.
  try {
    for (const folder of readdirSync(dir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      for (const name of readdirSync(join(dir, folder.name))) {
        const path = join(dir, folder.name, name)
        if (name.includes('.tmp-') && Date.now() - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true })
      }
    }
  } catch {
    // A missing or unreadable fonts folder is reported when it's first written to.
  }

  /** The stylesheet for a catalog family, downloading and caching it on first use. */
  async function stylesheet(family: string, kind: FontKind): Promise<string> {
    const entry = families.get(family)
    const slug = slugs.get(family)
    if (!entry || !slug) throw new FontError(404, 'Unknown font family')
    const cached = cachedStylesheet(slug, kind)
    if (cached !== null) return cached
    if (!downloads) throw new FontError(503, 'Font downloads are turned off')

    return dedupe(`css:${kind}:${slug}`, async () => {
      const again = cachedStylesheet(slug, kind)
      if (again !== null) return again

      let url = `https://fonts.googleapis.com/css2?family=${css2FamilyParam(entry, kind)}&display=swap`
      if (kind === 'preview') url += `&text=${encodeURIComponent(entry.f)}`
      const { bytes, contentType } = await download(url, CSS_LIMIT, kind === 'full' ? 'high' : 'low')
      // Google answers an HTML error page for impossible requests; never cache that.
      if (!/^text\/css\b/i.test(contentType)) throw new FontError(503, 'Google Fonts did not return a stylesheet')

      const familyName = kind === 'preview' ? `${entry.f} Preview` : entry.f
      const rewritten = rewriteFontCss(new TextDecoder().decode(bytes), slug, familyName)
      if (Object.keys(rewritten.manifest).length === 0) throw new FontError(503, 'Google Fonts returned no usable fonts')

      const paths = stylesheetPaths(slug, kind)
      mkdirSync(paths.folder, { recursive: true })
      writeAtomic(paths.manifest, JSON.stringify(rewritten.manifest))
      writeAtomic(paths.css, rewritten.css)

      if (kind === 'full' && prefetchLatin) {
        for (const file of rewritten.latinFiles) void fontFile(slug, file).catch(() => undefined)
      }
      return rewritten.css
    })
  }

  /** A font file named in one of the family's manifests, downloading it on first use. */
  async function fontFile(slug: string, file: string): Promise<{ path: string; type: string }> {
    const match = FONT_FILE.exec(file)
    if (!SLUG.test(slug) || !bySlug.has(slug) || !match) throw new FontError(404, 'Unknown font file')
    const ext = match[1] as string
    const type = FONT_TYPES[ext] as string
    const target = join(dir, slug, file)
    if (existsSync(target)) return { path: target, type }

    const entry = manifestEntry(slug, file)
    if (!entry || !isGstaticUrl(entry.url)) throw new FontError(404, 'Unknown font file')
    if (!downloads) throw new FontError(503, 'Font downloads are turned off')

    return dedupe(`file:${slug}/${file}`, async () => {
      if (existsSync(target)) return { path: target, type }
      const { bytes } = await download(entry.url, FILE_LIMIT, entry.kind === 'full' ? 'high' : 'low').catch(
        (error: unknown) => {
          // Google retired this file's URL: drop the cached stylesheet so the next request fetches
          // a fresh one with current URLs, instead of failing on the dead link forever.
          if (error instanceof FontError && (error.upstreamStatus === 404 || error.upstreamStatus === 410)) {
            const paths = stylesheetPaths(slug, entry.kind)
            rmSync(paths.css, { force: true })
            rmSync(paths.manifest, { force: true })
          }
          throw error
        },
      )
      if (!hasFontSignature(bytes, ext)) throw new FontError(502, 'Google Fonts sent an unexpected file')
      writeAtomic(target, bytes)
      return { path: target, type }
    })
  }

  // Each user has their own favorites. The font files themselves are shared (public Google fonts).
  const readFavorites = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'fontFavorites'")
  const writeFavorites = db.prepare(
    `INSERT INTO user_settings (user_id, key, value) SELECT id, 'fontFavorites', ? FROM users WHERE id = ?
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  )

  function getFavorites(userId: string): string[] {
    const row = readFavorites.get(userId) as { value: string } | undefined
    if (!row) return []
    try {
      const value = JSON.parse(row.value) as unknown
      return Array.isArray(value) ? value.filter((family): family is string => families.has(family as string)) : []
    } catch {
      return []
    }
  }

  function setFavorites(userId: string, list: string[]): string[] {
    const unique = [...new Set(list)]
    const unknown = unique.find(family => !families.has(family))
    if (unknown !== undefined) throw new FontError(400, `Unknown font family "${unknown}"`)
    if (unique.length > MAX_FAVORITES) throw new FontError(400, `At most ${MAX_FAVORITES} favorites`)
    writeFavorites.run(JSON.stringify(unique), userId)
    return unique
  }

  return { stylesheet, fontFile, getFavorites, setFavorites }
}

export type FontService = ReturnType<typeof createFontService>
