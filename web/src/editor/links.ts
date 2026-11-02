import { isSafeLink } from '../../../shared/safe.ts'

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i
const HOST_AND_PORT = /^[^\s/:@]+:\d+(?:[/?#]|$)/
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/

/** Turns what the user typed into a link: adds https:// to "example.com" and "localhost:3000". */
export function normalizeUrl(input: string): string {
  const url = input.trim()
  if (url.startsWith('/') || url.startsWith('#')) return url
  if (HOST_AND_PORT.test(url)) return `https://${url}`
  if (HAS_SCHEME.test(url)) return url
  if (EMAIL.test(url)) return `mailto:${url}`
  return `https://${url}`
}

/** The same rule the server applies to stored links. */
export const isSafeHref = isSafeLink
