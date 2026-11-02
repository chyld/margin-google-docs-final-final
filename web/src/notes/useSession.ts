// The signed-in session as the page lives it: noticing when it ends (expired, or another account
// signed in elsewhere in this browser), signing in again, signing out, and leaving the page, all
// without losing unsaved edits. Every path pauses or suspends the save queue before the session
// changes hands, so nothing of this account is ever sent under another one.
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, ApiError, setAuthFailureHandler } from '../api.ts'
import type { User } from '../api.ts'
import { pendingImageUploads, subscribePendingUploads } from '../editor/imageInput.ts'
import { forgetFailedFonts } from '../state/fonts.ts'
import { showNotice } from '../state/notices.ts'
import { broadcastAuth, notifyReauthenticated, onAuthBroadcast } from '../state/session.ts'
import type { SaveQueue } from './saveQueue.ts'

const SIGN_OUT_WAIT_MS = 5000
const UPLOAD_WAIT_MS = 15_000

export type SessionEnded = null | 'expired' | 'switched'

function waitForUploads(timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (pendingImageUploads() === 0) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    const unsubscribe = subscribePendingUploads(() => {
      if (pendingImageUploads() !== 0) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}

type SessionOptions = {
  queue: SaveQueue
  user: User
  /** Signed in again as the same user: reload what may have been missed meanwhile. */
  onResumed: () => void
}

export function useSession({ queue, user, onResumed }: SessionOptions) {
  const [sessionEnded, setSessionEnded] = useState<SessionEnded>(null)
  // Bumped when the same user signs in again: an open note retries a load that failed meanwhile.
  const [reauthEpoch, setReauthEpoch] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  // Not editable while the last saves go out before signing out.
  const [locked, setLocked] = useState(false)
  // Set while Margin itself is leaving the page (sign out, switching accounts): no unload prompt.
  const leaving = useRef(false)
  const resumed = useRef(onResumed)
  resumed.current = onResumed

  const sessionEndedRef = useRef(sessionEnded)
  useEffect(() => {
    sessionEndedRef.current = sessionEnded
  }, [sessionEnded])
  /** For listeners that mustn't re-subscribe on every change (keyboard shortcuts). */
  const isSessionEnded = useCallback(() => sessionEndedRef.current !== null, [])

  // Bumped on every sign-in, so an older account check answering late can't undo it.
  const authGeneration = useRef(0)
  // What had focus when the session ended, to give it back afterwards.
  const focusBeforeDialog = useRef<HTMLElement | null>(null)

  const endSession = useCallback(
    (reason: 'expired' | 'switched') => {
      if (leaving.current) return
      queue.pause()
      queue.persistDrafts()
      if (!focusBeforeDialog.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        // The Format sheet closes when the session ends: come back to its toggle instead.
        focusBeforeDialog.current = document.activeElement.closest('#format-panel')
          ? document.querySelector<HTMLElement>('.format-toggle')
          : document.activeElement
      }
      // A different account wins over "expired": its message tells the user what really happened.
      setSessionEnded(current => (current === 'switched' ? current : reason))
    },
    [queue],
  )

  const resumeSession = useCallback(() => {
    authGeneration.current += 1
    setSessionEnded(null)
    const previous = focusBeforeDialog.current
    focusBeforeDialog.current = null
    requestAnimationFrame(() => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    })
    queue.resume()
    forgetFailedFonts()
    notifyReauthenticated()
    setReauthEpoch(value => value + 1)
    resumed.current()
  }, [queue])

  /**
   * Leaves the page for good: no more saves from this tab, drafts kept for next time. If the browser
   * can't keep the unsaved edits, asks first (returns false when the user stays).
   */
  const leaveTo = useCallback(
    (url: string, { confirmed = false } = {}) => {
      if (!confirmed && !queue.persistDrafts() && queue.hasUnsaved()) {
        const ok = window.confirm(
          "Some changes haven't reached the server, and this browser couldn't keep a copy. Leaving now loses them.\n\nLeave anyway?",
        )
        if (!ok) return false
      }
      leaving.current = true
      queue.suspend()
      queue.persistDrafts()
      window.location.assign(url)
      return true
    },
    [queue],
  )

  // Any request that finds the session gone (401) or owned by someone else (409).
  useEffect(() => {
    setAuthFailureHandler(failure => endSession(failure.status === 409 ? 'switched' : 'expired'))
    return () => setAuthFailureHandler(null)
  }, [endSession])

  const recheck = useCallback(async () => {
    if (leaving.current) return
    const generation = authGeneration.current
    try {
      const current = await api.me()
      if (generation !== authGeneration.current) return
      if (current.user.id !== user.id) endSession('switched')
      else if (sessionEndedRef.current) resumeSession()
    } catch (error) {
      if (generation !== authGeneration.current) return
      if (error instanceof ApiError && error.status === 401) endSession('expired')
    }
  }, [user.id, endSession, resumeSession])

  useEffect(
    () =>
      onAuthBroadcast(message => {
        if (message.type === 'signed-out') endSession('expired')
        else if (message.userId !== user.id) endSession('switched')
        else void recheck()
      }),
    [user.id, endSession, recheck],
  )

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [recheck])

  // Protect unsaved edits when the tab is hidden, reloaded or closed.
  useEffect(() => {
    // Hidden usually comes first when a tab closes, so use keepalive there too: small saves then
    // survive the page, and the queue still tracks them so nothing older can land after.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      queue.persistDrafts()
      queue.flushAll({ keepalive: true })
    }
    const onPageHide = () => {
      queue.persistDrafts()
      queue.flushAll({ keepalive: true })
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return
      if (!queue.hasUnsaved() && pendingImageUploads() === 0) return
      queue.persistDrafts()
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [queue])

  async function signInAgain(username: string, password: string) {
    const sameUser = username.trim().toLowerCase() === user.username
    // Before the cookie changes hands: nothing of this account may be sent under another one, and
    // unsaved edits must be safe in this browser (or the user must accept losing them).
    let confirmedLoss = false
    if (!sameUser) {
      queue.pause()
      if (!queue.persistDrafts() && queue.hasUnsaved()) {
        confirmedLoss = window.confirm(
          `Some of ${user.username}'s changes haven't reached the server, and this browser couldn't keep a copy. ` +
            'Signing in as someone else loses them.\n\nContinue?',
        )
        if (!confirmedLoss) return
      }
    }
    const result = await api.login(username, password)
    broadcastAuth({ type: 'signed-in', userId: result.user.id })
    if (result.user.id !== user.id) {
      leaveTo('/', { confirmed: true })
      return
    }
    resumeSession()
  }

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    const uploadsDone = await waitForUploads(UPLOAD_WAIT_MS)
    // Not editable while the last saves go out (uploads, if any, keep running until confirmed).
    // Synchronous, so fields that commit on lock (a typed tag) queue their edit before the drain.
    flushSync(() => setLocked(true))
    const saved = await queue.drain(SIGN_OUT_WAIT_MS)
    const stored = queue.persistDrafts()
    const stayed = () => {
      setLocked(false)
      setSigningOut(false)
    }
    if (!saved || !uploadsDone) {
      const problems: string[] = []
      if (!uploadsDone) problems.push('An image is still uploading and will be lost.')
      if (!saved) {
        problems.push(
          stored
            ? "Some changes haven't reached the server yet. They stay in this browser and come back when you open the note after signing in again."
            : "Some changes haven't reached the server yet, and this browser couldn't keep a copy, so they will be lost.",
        )
      }
      if (!window.confirm(`${problems.join('\n\n')}\n\nSign out anyway?`)) {
        stayed()
        return
      }
    }
    // Paused (not suspended) until the server confirms, so a failed sign-out can carry on normally.
    queue.pause()
    try {
      await api.logout()
    } catch (error) {
      // 401: already signed out. 409: this browser is now someone else's; either way, leave.
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        queue.resume()
        stayed()
        showNotice("Couldn't sign out. Check your connection and try again.")
        return
      }
    }
    leaving.current = true
    queue.suspend()
    queue.persistDrafts()
    broadcastAuth({ type: 'signed-out' })
    window.location.replace('/')
  }

  return {
    sessionEnded,
    isSessionEnded,
    reauthEpoch,
    locked,
    signingOut,
    signInAgain,
    signOut,
    leaveTo,
  }
}
