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

export function useSupabaseSession(): SupabaseSessionState {
  const [state, setState] = useState<SupabaseSessionState>({ session: null, loading: true })
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = (event: string, s: AuthSession) => { if (!stopped) setState(prev => nextSessionState(prev, event, s)) }
    const read = (attempt: number) => {
      supabase.auth.getSession().then(({ data, error }) => {
        if (stopped) return
        if (!data.session && error) {
          apply('INITIAL_SESSION', null)
          timer = setTimeout(() => read(attempt + 1), READ_RETRY_MS[Math.min(attempt, READ_RETRY_MS.length - 1)])
          return
        }
        apply('INITIAL_SESSION', data.session)
      }).catch(() => { if (!stopped) apply('INITIAL_SESSION', null) })
    }
    read(0)
    const { data } = supabase.auth.onAuthStateChange((e, s) => { clearTimeout(timer); apply(e, s) })
    const onOnline = () => { clearTimeout(timer); read(0) }
    window.addEventListener('online', onOnline)
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', onOnline); data.subscription.unsubscribe() }
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
