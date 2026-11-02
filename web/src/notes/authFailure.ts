/**
 * The session ended (401), or this browser is signed in to another account now (409 with code
 * user_mismatch). Other 409s, like a taken style name, are ordinary errors. Takes anything thrown,
 * not just ApiErrors (the save queue gets whatever its request threw).
 */
export function isAuthFailure(error: unknown): boolean {
  const candidate = error as { status?: unknown; body?: { code?: unknown } | null } | null
  if (!candidate || typeof candidate.status !== 'number') return false
  return candidate.status === 401 || (candidate.status === 409 && candidate.body?.code === 'user_mismatch')
}
