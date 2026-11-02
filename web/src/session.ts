// Signals for the "session ended, signed in again" cycle, shared by the upload code, fonts and the
// editor. Signing in as a different user reloads the page instead, so none of this crosses accounts.

const listeners = new Set<() => void>()

/** Runs `listener` every time the same user signs in again after their session ended. */
export function onReauthenticated(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyReauthenticated(): void {
  for (const listener of [...listeners]) listener()
}

/** Resolves at the next re-authentication; rejects if `signal` aborts first. */
export function waitForReauth(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const stop = onReauthenticated(() => {
      stop()
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    const onAbort = () => {
      stop()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---- other tabs ----
// Tabs share one cookie, so a sign-in or sign-out in one tab affects all of them. They tell each
// other right away; tabs also re-check when they become visible, in case a message was missed.

export type AuthMessage = { type: 'signed-in'; userId: string } | { type: 'signed-out' }

let channel: BroadcastChannel | null | undefined

function getChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('margin-auth')
  }
  return channel
}

export function broadcastAuth(message: AuthMessage): void {
  try {
    getChannel()?.postMessage(message)
  } catch {
    // Best effort.
  }
}

export function onAuthBroadcast(listener: (message: AuthMessage) => void): () => void {
  const current = getChannel()
  if (!current) return () => {}
  const handler = (event: MessageEvent) => listener(event.data as AuthMessage)
  current.addEventListener('message', handler)
  return () => current.removeEventListener('message', handler)
}
