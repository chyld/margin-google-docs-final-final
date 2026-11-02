// Note tags: lowercase a–z and 0–9 only, shared by the client and the server.

export const MAX_TAG_LENGTH = 32
export const MAX_TAGS = 20
export const TAG_PATTERN = /^[a-z0-9]{1,32}$/
export const TAG_RULE_MESSAGE = 'Tags use only a–z and 0–9'

/** Trims, drops one leading "#", and lowercases. Doesn't validate. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase()
}

export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag)
}

export type TagsResult = { ok: true; tags: string[] } | { ok: false; error: string }

/** Normalizes a list: drops duplicates and sorts A–Z, or reports the first invalid tag (never strips). */
export function normalizeTags(list: readonly unknown[]): TagsResult {
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'string') return { ok: false, error: 'Tags must be strings' }
    const tag = normalizeTag(raw)
    if (!isValidTag(tag)) {
      return { ok: false, error: tag.length > MAX_TAG_LENGTH ? `Tags are at most ${MAX_TAG_LENGTH} characters` : `${TAG_RULE_MESSAGE}: "${raw.trim()}"` }
    }
    seen.add(tag)
  }
  if (seen.size > MAX_TAGS) return { ok: false, error: `A note can have at most ${MAX_TAGS} tags` }
  return { ok: true, tags: [...seen].sort() }
}

/** Splits typed or pasted text into tag candidates (whitespace and commas separate them). */
export function splitTagInput(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean)
}

/** Pulls `#tag` tokens out of a search query; other words stay as text. Invalid `#` tokens stay text. */
export function parseTagQuery(query: string): { tags: string[]; text: string } {
  const tags = new Set<string>()
  const words: string[] = []
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const tag = word.startsWith('#') ? normalizeTag(word) : ''
    if (tag && isValidTag(tag)) tags.add(tag)
    else words.push(word)
  }
  return { tags: [...tags].sort(), text: words.join(' ') }
}

/** The query with `#tag` added, or removed if it's already there (clicking a tag toggles it). */
export function toggleTagInQuery(query: string, tag: string): string {
  const words = query.split(/\s+/).filter(Boolean)
  const has = words.some(word => word.startsWith('#') && normalizeTag(word) === tag)
  const next = has ? words.filter(word => !(word.startsWith('#') && normalizeTag(word) === tag)) : [...words, `#${tag}`]
  return next.join(' ')
}
