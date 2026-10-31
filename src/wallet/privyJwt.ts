// src/wallet/privyJwt.ts
//
// The Supabase access token handed to Privy (custom auth), and when Privy's
// sync with it should be started again. No React, no Privy: tested on its own.
//
// Why this exists. Privy's JWT sync (useSubscribeToJwtAuthWithFlag) LOGS THE
// USER OUT of Privy in three cases, and never tries again by itself:
//   1. the app's token getter returns nothing while Privy is signed in;
//   2. any error while authenticating with the token (a dropped request);
//   3. (re-run only when Privy's own signed-in flag or the app's
//      isAuthenticated / isLoading flip)
// The old getter was `(await supabase.auth.getSession()).data.session?.access_token`.
// getSession() answers `session: null` WITH an error when the stored token has
// expired and the refresh request fails (a phone resuming offline, a weak
// connection), so a resume or a Privy rebuild on a bad connection signed Privy
// out - and with Privy signed out nothing started it again until a reload.

/** What supabase.auth.getSession() returns (only what is used here). */
export interface SessionResult {
  data: { session: { access_token: string } | null }
  error: unknown
}

export interface JwtProviderDeps {
  getSession(): Promise<SessionResult>
  /** Resolves after `ms`, or sooner when `wake` fires (the connection came back, the app came to the screen). */
  wait(ms: number, wake: (fn: () => void) => () => void): Promise<void>
  now(): number
  /** Subscribe to "worth trying now" signals; returns the unsubscribe. */
  onWake(fn: () => void): () => void
}

/** Seconds-epoch `exp` of a JWT, or null. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }
    return typeof json.exp === 'number' ? json.exp : null
  } catch { return null }
}

const REUSE_MARGIN_MS = 15_000
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

/**
 * `get()` resolves with a usable access token, or with undefined ONLY when the
 * person is really signed out of MeshPort (no session and no error). While the
 * session exists but cannot be refreshed right now it waits and retries
 * instead of answering "no token" - that answer signs Privy out.
 * After `abort()` it never settles: a Privy that was replaced (rebuilt) must
 * not finish its sync and log out the session its replacement now shares.
 */
export function createJwtProvider(deps: JwtProviderDeps) {
  let lastGood: string | undefined
  let aborted = false

  const usable = (token: string | undefined): token is string => {
    if (!token) return false
    const exp = jwtExpiry(token)
    return exp === null || exp * 1000 - deps.now() > REUSE_MARGIN_MS
  }

  async function get(): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      if (aborted) return new Promise<never>(() => {})
      let res: SessionResult
      try { res = await deps.getSession() } catch (error) { res = { data: { session: null }, error } }
      if (aborted) return new Promise<never>(() => {})
      const token = res.data.session?.access_token
      if (token) { lastGood = token; return token }
      // No session and nothing went wrong: signed out for real.
      if (!res.error) return undefined
      // The session exists but couldn't be read/refreshed. The token Privy
      // was last given is still good for a while: the same token is a no-op
      // for Privy, not a sign-out.
      if (usable(lastGood)) return lastGood
      await deps.wait(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)], deps.onWake)
    }
  }

  return {
    get,
    abort() { aborted = true },
    /** Undo abort() (React StrictMode mounts, unmounts and mounts again). */
    resume() { aborted = false },
    /** The last token handed out (diagnostics / tests). */
    last: () => lastGood,
  }
}

/** Browser wiring for createJwtProvider: timers plus the online / visible signals. */
export function browserWait(ms: number, onWake: (fn: () => void) => () => void): Promise<void> {
  return new Promise(resolve => {
    let off: () => void = () => {}
    const done = () => { clearTimeout(timer); off(); resolve() }
    const timer = setTimeout(done, ms)
    off = onWake(done)
  })
}

export function browserWake(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const visible = () => { if (document.visibilityState === 'visible') fn() }
  window.addEventListener('online', fn)
  document.addEventListener('visibilitychange', visible)
  return () => { window.removeEventListener('online', fn); document.removeEventListener('visibilitychange', visible) }
}

// ── When to start Privy's sync again ────────────────────────────────────────

/** Delays before each retry of a failed / signed-out Privy sync; the last one repeats. */
export const RESYNC_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]
/** After this many failed re-syncs Privy is rebuilt (a fresh client and iframe). */
export const RESYNC_BEFORE_REBUILD = 3

export interface ResyncInput {
  /** MeshPort has a real (non-anonymous) session. */
  signedIn: boolean
  ready: boolean
  authenticated: boolean
  /** Privy's JWT flow status. */
  status: 'initial' | 'loading' | 'not-enabled' | 'done' | 'error'
}

/**
 * Privy is up and MeshPort is signed in, but Privy isn't: its sync ended in an
 * error, or it logged itself out, and nothing will start it again. Pure.
 */
export function needsResync(s: ResyncInput): boolean {
  return s.signedIn && s.ready && !s.authenticated && s.status !== 'loading'
}

/** Delay before re-sync number `attempt` (0-based). Pure. */
export function resyncDelayMs(attempt: number): number {
  return RESYNC_DELAYS_MS[Math.min(attempt, RESYNC_DELAYS_MS.length - 1)]
}

// ── The MeshPort session as the Privy gate sees it ───────────────────────────

export type SupabaseSessionState = { session: { token: string; anonymous: boolean } | null; loading: boolean }

export type AuthSession = { access_token: string; user: { is_anonymous?: boolean } } | null

/**
 * The session state after a Supabase auth event. A `null` session that is not
 * a real sign-out (SIGNED_OUT) keeps what was there: Supabase reports one while
 * a token refresh is failing on a weak connection, and treating it as "signed
 * out" unmounted Privy (PrivyRoot) and signed it out. Pure - tested.
 */
export function nextSessionState(prev: SupabaseSessionState, event: string, s: AuthSession): SupabaseSessionState {
  if (!s && event !== 'SIGNED_OUT' && prev.session) return prev
  const session = s ? { token: s.access_token, anonymous: s.user.is_anonymous === true } : null
  // Same session again (a token refresh keeps the user): no new object, no re-render of everything below.
  if (prev.session && session && prev.session.token === session.token && prev.session.anonymous === session.anonymous && !prev.loading) return prev
  return { session, loading: false }
}

