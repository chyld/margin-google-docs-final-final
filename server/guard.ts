import { isIPv6 } from 'node:net'
import type { MiddlewareHandler } from 'hono'
import { IMAGE_TYPES } from '../shared/imageRules.ts'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])
// "none" means the user started the request themselves (e.g. typed the URL).
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])
// The one route that takes a raw (non-JSON) body. Like JSON, these types aren't CORS-safelisted and
// HTML forms can't send them, so a cross-origin page still can't post here without a preflight.
const IMAGE_UPLOAD_PATH = '/api/images'
// The content type may carry parameters (image/png; charset=binary).
const IMAGE_UPLOAD_TYPES = new RegExp(`^(?:${Object.keys(IMAGE_TYPES).join('|')})\\s*(?:;|$)`, 'i')

export function isImageUpload(method: string, path: string): boolean {
  return method === 'POST' && path === IMAGE_UPLOAD_PATH
}

export type HostRules = {
  /** Ports the browser may use to reach Margin (PUBLIC_PORT and PORT). */
  ports: string[]
  /** Extra names from ALLOWED_HOSTS, as "name" or "name:port". Added to the defaults. */
  extraHosts?: string[]
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** Splits "name:port" or "[v6]:port". Returns null for anything else (no port, zone ids, junk). */
function splitHost(value: string): { name: string; port: string; ip: boolean } | null {
  const host = value.trim().toLowerCase()
  const bracketed = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/.exec(host)
  if (bracketed) {
    const [, address, port] = bracketed as unknown as [string, string, string]
    return isIPv6(address) ? { name: `[${address}]`, port, ip: true } : null
  }
  const plain = /^([a-z0-9.-]+):(\d{1,5})$/.exec(host)
  if (!plain) return null
  const [, name, port] = plain as unknown as [string, string, string]
  if (IPV4.test(name)) return { name, port, ip: true }
  // Rejects shorthand/hex IPv4 like 127.1 or 0x7f000001, which browsers would turn into an address.
  if (/^[\d.]+$/.test(name) || /^0x/.test(name) || !NAME.test(name)) return null
  return { name, port, ip: false }
}

/**
 * Builds the Host check. Allowed: localhost, any IP address literal (typed by the user, e.g. the
 * laptop's LAN address from a phone), and names from ALLOWED_HOSTS, always on one of Margin's ports.
 *
 * IP literals are safe against DNS rebinding: in that attack the Host header is the attacker's own
 * domain name, never an address.
 */
export function hostChecker({ ports, extraHosts = [] }: HostRules): (host: string | undefined) => boolean {
  const allowedPorts = new Set(ports.map(String))
  const names = new Set<string>(['localhost'])
  const namedPorts = new Set<string>()
  for (const entry of extraHosts) {
    const value = entry.trim().toLowerCase()
    if (!value) continue
    const parsed = splitHost(value)
    if (parsed) namedPorts.add(`${parsed.name}:${parsed.port}`)
    else if (NAME.test(value)) names.add(value)
  }
  return host => {
    if (!host) return false
    const parsed = splitHost(host)
    if (!parsed) return false
    if (namedPorts.has(`${parsed.name}:${parsed.port}`)) return true
    if (!allowedPorts.has(parsed.port)) return false
    return parsed.ip || names.has(parsed.name)
  }
}

/**
 * Blocks requests that a hostile web page in the user's browser could make: DNS rebinding (foreign
 * Host header), cross-site API calls of any kind (including GETs, which could otherwise make the
 * server download fonts) and cross-site writes. Login CSRF is covered by the same rules.
 */
export function guard(rules: HostRules, { allowHttpsOrigin = false } = {}): MiddlewareHandler {
  const allowedHost = hostChecker(rules)

  return async (c, next) => {
    const host = c.req.header('host')
    if (!allowedHost(host)) {
      return c.json({ error: 'Forbidden host' }, 403)
    }

    const method = c.req.method
    const path = c.req.path
    const isApi = path === '/api' || path.startsWith('/api/')
    // Only API requests: following a link to Margin from another site must still open the app.
    if (isApi || WRITE_METHODS.has(method)) {
      const fetchSite = c.req.header('sec-fetch-site')
      if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
        return c.json({ error: 'Cross-site request blocked' }, 403)
      }
    }

    // Same origin means the page's origin matches the host it is talking to. Non-browser clients
    // send no Origin; browsers always send it on these methods.
    if (WRITE_METHODS.has(method)) {
      const origin = c.req.header('origin')?.toLowerCase()
      const lowerHost = (host as string).trim().toLowerCase()
      // https only when Margin is configured to sit behind HTTPS (COOKIE_SECURE=on).
      const sameOrigin = origin === `http://${lowerHost}` || (allowHttpsOrigin && origin === `https://${lowerHost}`)
      if (origin !== undefined && !sameOrigin) {
        return c.json({ error: 'Cross-origin request blocked' }, 403)
      }
    }

    // A JSON content type forces a CORS preflight, which cross-origin pages can't pass.
    if (BODY_METHODS.has(method)) {
      const contentType = c.req.header('content-type') ?? ''
      if (isImageUpload(method, path)) {
        if (!IMAGE_UPLOAD_TYPES.test(contentType)) {
          return c.json({ error: 'Images must be PNG, JPEG, GIF or WebP' }, 415)
        }
      } else if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
        return c.json({ error: 'Content-Type must be application/json' }, 415)
      }
    }

    await next()
  }
}
