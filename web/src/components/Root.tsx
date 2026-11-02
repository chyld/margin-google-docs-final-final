import { useCallback, useEffect, useState } from 'react'
import { Loader2, WifiOff } from 'lucide-react'
import { api, ApiError, bindUser } from '../api.ts'
import type { Me } from '../api.ts'
import { App } from '../App.tsx'
import { broadcastAuth, onAuthBroadcast } from '../session.ts'
import { LoginScreen } from './LoginScreen.tsx'

type RootState =
  | { kind: 'checking' }
  | { kind: 'unreachable' }
  | { kind: 'signedOut'; setupNeeded: boolean }
  | { kind: 'signedIn'; me: Me }

const RETRY_UNREACHABLE_MS = 5000

/** Decides between the sign-in screen and the app. */
export function Root() {
  const [state, setState] = useState<RootState>({ kind: 'checking' })

  const check = useCallback(async () => {
    try {
      const me = await api.me()
      // Bound before the app renders, so its very first requests carry the account.
      bindUser(me.user.id)
      setState({ kind: 'signedIn', me })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        bindUser(null)
        setState({ kind: 'signedOut', setupNeeded: error.body?.setupNeeded === true })
      } else {
        setState(previous => (previous.kind === 'signedIn' ? previous : { kind: 'unreachable' }))
      }
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // Can't reach the server (phone asleep, wrong Wi-Fi, container restarting): keep trying.
  useEffect(() => {
    if (state.kind !== 'unreachable') return
    const timer = setInterval(() => void check(), RETRY_UNREACHABLE_MS)
    return () => clearInterval(timer)
  }, [state.kind, check])

  // Signed in from another tab while this one shows the sign-in screen.
  useEffect(() => {
    if (state.kind !== 'signedOut') return
    return onAuthBroadcast(message => {
      if (message.type === 'signed-in') void check()
    })
  }, [state.kind, check])

  async function signIn(username: string, password: string) {
    const { user } = await api.login(username, password)
    broadcastAuth({ type: 'signed-in', userId: user.id })
    await check()
  }

  switch (state.kind) {
    case 'checking':
      return (
        <div className="splash" aria-busy="true">
          <img src="/favicon.svg" alt="" width={56} height={56} className="splash-logo" />
          <Loader2 size={22} className="spin" aria-label="Loading" />
        </div>
      )
    case 'unreachable':
      return (
        <div className="splash">
          <div className="splash-card" role="alert">
            <WifiOff size={36} aria-hidden="true" />
            <h1>Can't reach Margin</h1>
            <p>Check that this device is on the same network and that Margin is running. Trying again…</p>
            <button type="button" className="button primary" onClick={() => void check()}>
              Try now
            </button>
          </div>
        </div>
      )
    case 'signedOut':
      return <LoginScreen setupNeeded={state.setupNeeded} onSubmit={signIn} />
    case 'signedIn':
      return <App key={state.me.user.id} me={state.me} />
  }
}
