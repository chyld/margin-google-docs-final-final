// Signs the e2e scripts in: Node's fetch gets the session cookie, and so does the browser context.
// The unpatched fetch: a later sign-in must not send an earlier session's cookie (the server would
// treat it as the same browser signing in again and end that session).
const plainFetch = globalThis.__marginPlainFetch ?? (globalThis.__marginPlainFetch = globalThis.fetch)

export async function signIn(base, context, username = process.env.MARGIN_USER ?? 'e2e', password = process.env.MARGIN_PASS ?? 'e2e-password-123') {
  const response = await plainFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`)
  const [pair] = (response.headers.get('set-cookie') ?? '').split(';')
  const [name, value] = pair.split('=')
  const original = plainFetch
  globalThis.fetch = (url, init = {}) => {
    const headers = new Headers(init.headers)
    if (String(url).startsWith(base)) headers.set('cookie', pair)
    return original(url, { ...init, headers })
  }
  const { hostname } = new URL(base)
  if (context) await context.addCookies([{ name, value, domain: hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
  return { name, value, user: (await response.json()).user }
}
