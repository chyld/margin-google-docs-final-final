import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { ApiError } from '../api.ts'
import { ThemeSwitch } from './ThemeSwitch.tsx'

export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Wrong username or password.'
    if (error.status === 429) {
      const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60))
      return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    }
    if (error.status === 503) return 'Margin is busy. Try again in a few seconds.'
    return error.message
  }
  return "Can't reach Margin. Check your connection and try again."
}

type LoginFormProps = {
  /** Prefilled username. With `usernameLocked`, it can't be edited until "Not you?" is clicked. */
  initialUsername?: string
  usernameLocked?: boolean
  submitLabel?: string
  onSubmit: (username: string, password: string) => Promise<void>
  /** Called when the user unlocks the username field ("Not you?"). */
  onUnlockUsername?: () => void
  extra?: ReactNode
}

export function LoginForm({
  initialUsername = '',
  usernameLocked = false,
  submitLabel = 'Sign in',
  onSubmit,
  onUnlockUsername,
  extra,
}: LoginFormProps) {
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState('')
  const [locked, setLocked] = useState(usernameLocked)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(0)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const ids = { user: useId(), password: useId(), error: useId() }

  useEffect(() => {
    if (initialUsername) passwordRef.current?.focus()
    else usernameRef.current?.focus()
  }, [initialUsername])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      setShake(value => value + 1)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(username.trim(), password)
    } catch (caught) {
      setError(loginErrorMessage(caught))
      setShake(value => value + 1)
      setPassword('')
      passwordRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor={ids.user}>Username</label>
        <div className="field-row">
          <input
            ref={usernameRef}
            id={ids.user}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            readOnly={locked}
            onChange={event => setUsername(event.target.value)}
            aria-describedby={error ? ids.error : undefined}
          />
          {locked && (
            <button
              type="button"
              className="link-button field-action"
              onClick={() => {
                setLocked(false)
                setUsername('')
                onUnlockUsername?.()
                requestAnimationFrame(() => usernameRef.current?.focus())
              }}
            >
              Not you?
            </button>
          )}
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.password}>Password</label>
        <div className="field-row">
          <input
            ref={passwordRef}
            id={ids.password}
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            aria-describedby={error ? ids.error : undefined}
          />
          <button
            type="button"
            className="icon-button field-action"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword(value => !value)}
          >
            {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <p id={ids.error} className="login-error" role="alert" aria-live="assertive" key={shake} data-shake={shake > 0 || undefined}>
        {error}
      </p>
      <button type="submit" className="button primary login-submit" disabled={busy}>
        {busy && <Loader2 size={17} className="spin" aria-hidden="true" />}
        {busy ? 'Signing in…' : submitLabel}
      </button>
      {extra}
    </form>
  )
}

type LoginScreenProps = {
  setupNeeded: boolean
  onSubmit: (username: string, password: string) => Promise<void>
}

/** The full-page sign-in screen. */
export function LoginScreen({ setupNeeded, onSubmit }: LoginScreenProps) {
  return (
    <div className="login-screen">
      <div className="login-corner">
        <ThemeSwitch compact />
      </div>
      <main className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width={44} height={44} />
          <span>Margin</span>
        </div>
        <h1 id="login-title">Welcome back</h1>
        <p className="login-subtitle">Sign in to your notes.</p>
        {setupNeeded && (
          <div className="setup-hint">
            <strong>No accounts yet.</strong> On the computer running Margin, create one:
            <code>docker compose exec margin margin-user add yourname</code>
          </div>
        )}
        <LoginForm onSubmit={onSubmit} />
      </main>
    </div>
  )
}

type SessionDialogProps = {
  username: string
  reason: 'expired' | 'switched'
  onSubmit: (username: string, password: string) => Promise<void>
  onUseOtherAccount: () => void
}

/** Shown over the app when the session ends mid-use. The editor stays put underneath; nothing is lost. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside `container` (for modal dialogs). */
export function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.offsetParent !== null)
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

export function SessionDialog({ username, reason, onSubmit, onUseOtherAccount }: SessionDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  return (
    <div className="session-overlay">
      <div
        ref={dialogRef}
        className="session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={event => trapTab(event, dialogRef.current)}
      >
        <h2 id={titleId}>{reason === 'switched' ? 'Another account signed in' : 'Your session ended'}</h2>
        <p>
          {reason === 'switched'
            ? `Someone signed in as a different user in another tab. Sign in as ${username} again to keep saving here.`
            : 'Sign in again to keep saving. Your changes are safe in the meantime.'}
        </p>
        <LoginForm
          initialUsername={username}
          usernameLocked
          submitLabel="Sign in again"
          onSubmit={onSubmit}
          extra={
            reason === 'switched' ? (
              <button type="button" className="link-button session-other" onClick={onUseOtherAccount}>
                Switch to the other account instead
              </button>
            ) : null
          }
        />
      </div>
    </div>
  )
}
