// A tiny pushState router. Routes: "/" and "/notes/:id".
import { useSyncExternalStore } from 'react'

const NAVIGATE_EVENT = 'margin:navigate'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

export function noteIdFromPath(pathname: string): string | null {
  const match = /^\/notes\/([^/]+)\/?$/.exec(pathname)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    // Malformed escapes like "%E0%A4%A": treat as an unknown note instead of crashing.
    return match[1]
  }
}

export function notePath(id: string): string {
  return `/notes/${encodeURIComponent(id)}`
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return
  if (options.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}
