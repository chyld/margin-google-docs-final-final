// App-wide transient messages ("Image upload cancelled", "Couldn't load the font …").
// Kept outside React so editor plugins and async callbacks can post them after their view is gone.

export type Notice = { id: number; message: string }

const AUTO_DISMISS_MS = 8000
let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function showNotice(message: string): void {
  // The same message twice in a row (e.g. several failed previews) shows once.
  if (notices.some(notice => notice.message === message)) return
  const notice = { id: nextId++, message }
  notices = [...notices, notice].slice(-4)
  emit()
  setTimeout(() => dismissNotice(notice.id), AUTO_DISMISS_MS)
}

export function dismissNotice(id: number): void {
  const remaining = notices.filter(notice => notice.id !== id)
  if (remaining.length === notices.length) return
  notices = remaining
  emit()
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNotices(): Notice[] {
  return notices
}
