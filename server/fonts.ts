// Google Fonts, cached in DATA_DIR/fonts so the browser never talks to Google.
//
// Outbound requests only ever go to fonts.googleapis.com (URLs built from the committed catalog)
// and fonts.gstatic.com (exact host check, no redirects). Each family has two independent
// stylesheets, the full one and a tiny "preview" one that only covers the family's own name, and
// each stylesheet has its own manifest, so nothing is ever read-modify-written.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { css2FamilyParam, fontSlug } from '../shared/fonts.ts'
import type { FontCatalogEntry } from '../shared/fonts.ts'
import { hasFontSignature, isGstaticUrl, rewriteFontCss } from './fontCss.ts'
import { HttpError } from './http.ts'

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
// css2 picks the font format from the User-Agent; a current desktop Chrome gets woff2.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const SLUG = /^[a-z0-9-]+$/
export const FONT_FILE = /^[0-9a-f]{16}\.(woff2|woff|ttf)$/
const FONT_TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' }

/** Answers as { error } with its status (no code). */
export class FontError extends HttpError {
  declare readonly status: 400 | 404 | 502 | 503
  /** Google's HTTP status, when Google answered with an error. */
  readonly upstreamStatus: number | undefined

  constructor(status: 400 | 404 | 502 | 503, message: string, upstreamStatus?: number) {
    super(status, message)
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

export type FontServiceOptions = {
  dir: string
  catalog: FontCatalogEntry[]
  fetchImpl?: FetchLike
  /** False disables every outbound request; cached fonts still work. */
  downloads?: boolean
  /** Download the Latin files right after a family's stylesheet is cached, so it works offline. */
  prefetchLatin?: boolean
}

export function createFontService({
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

  /** Whether the catalog has this family (favorites may only name these). */
  function knows(family: string): boolean {
    return families.has(family)
  }

  return { stylesheet, fontFile, knows }
}

export type FontService = ReturnType<typeof createFontService>
