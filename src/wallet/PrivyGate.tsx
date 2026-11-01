// src/wallet/PrivyGate.tsx
//
// Loads Privy (PrivyRoot.tsx, its own chunk) only while a Google / email
// account is signed in and Privy is configured. Anonymous sessions (create /
// import wallets) and signed-out visitors never download it.

import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store'
import { privyConfigured } from './privy'
import { nextSessionState, type AuthSession, type SupabaseSessionState } from './privyJwt'

const loadPrivyRoot = () => import('./PrivyRoot')
const PrivyRoot = lazy(loadPrivyRoot)

export type { SupabaseSessionState }

// A session that exists but couldn't be read (the token expired and the
// refresh failed: a phone waking up offline) is read again, not given up on.
const READ_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

/**
 * Reads the session, and reads it again (READ_RETRY_MS) while it can't be
 * read. A failed read and a REJECTED one (supabase-js can throw - e.g. its
 * storage lock timing out) are the same: no session yet, read again. The
 * rejection used to apply "no session" with no retry, so Privy (rendered only
 * with a session) never loaded until some unrelated auth event - the wallet
 * "didn't open". Returns: read again now (the connection is back), stop.
 */
export function startSessionReads(
  getSession: () => Promise<{ data: { session: AuthSession }; error: unknown }>,
  apply: (event: string, s: AuthSession) => void,
): { again: () => void; cancel: () => void; stop: () => void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (attempt: number) => {
    const retry = () => {
      apply('INITIAL_SESSION', null)
      timer = setTimeout(() => read(attempt + 1), READ_RETRY_MS[Math.min(attempt, READ_RETRY_MS.length - 1)])
    }
    getSession().then(({ data, error }) => {
      if (stopped) return
      if (!data.session && error) { retry(); return }
      apply('INITIAL_SESSION', data.session)
    }).catch(() => { if (!stopped) retry() })
  }
  read(0)
  return {
    again: () => { clearTimeout(timer); if (!stopped) read(0) },
    cancel: () => clearTimeout(timer), // the pending retry only
    stop: () => { stopped = true; clearTimeout(timer) },
  }
}

export function useSupabaseSession(): SupabaseSessionState {
  const [state, setState] = useState<SupabaseSessionState>({ session: null, loading: true })
  useEffect(() => {
    let stopped = false
    const apply = (event: string, s: AuthSession) => { if (!stopped) setState(prev => nextSessionState(prev, event, s)) }
    const reads = startSessionReads(() => supabase.auth.getSession() as any, apply)
    // An auth event settles it: the pending retry is dropped (as before).
    const { data } = supabase.auth.onAuthStateChange((e, s) => { reads.cancel(); apply(e, s) })
    const onOnline = () => reads.again()
    window.addEventListener('online', onOnline)
    return () => { stopped = true; reads.stop(); window.removeEventListener('online', onOnline); data.subscription.unsubscribe() }
  }, [])
  return state
}

export function PrivyGate() {
  // A Google / email account on this device: start loading Privy's code now,
  // alongside the session read, instead of after it.
  const isPrivy = useAuthStore(s => s.walletSource === 'privy')
  useEffect(() => { if (isPrivy && privyConfigured()) void loadPrivyRoot().catch(() => {}) }, [isPrivy])
  const { session } = useSupabaseSession()
  if (!privyConfigured() || !session || session.anonymous) return null
  return <Suspense fallback={null}><PrivyRoot /></Suspense>
}
