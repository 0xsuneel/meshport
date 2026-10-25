// src/wallet/PrivyGate.tsx
//
// Loads Privy (PrivyRoot.tsx, its own chunk) only while a Google / email
// account is signed in and Privy is configured. Anonymous sessions (create /
// import wallets) and signed-out visitors never download it.

import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { privyConfigured } from './privy'

const PrivyRoot = lazy(() => import('./PrivyRoot'))

export type SupabaseSessionState = { session: { token: string; anonymous: boolean } | null; loading: boolean }

export function useSupabaseSession(): SupabaseSessionState {
  const [state, setState] = useState<SupabaseSessionState>({ session: null, loading: true })
  useEffect(() => {
    const read = (s: { access_token: string; user: { is_anonymous?: boolean } } | null) =>
      setState({ session: s ? { token: s.access_token, anonymous: s.user.is_anonymous === true } : null, loading: false })
    supabase.auth.getSession().then(({ data }) => read(data.session)).catch(() => setState({ session: null, loading: false }))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => read(s))
    return () => data.subscription.unsubscribe()
  }, [])
  return state
}

export function PrivyGate() {
  const { session } = useSupabaseSession()
  if (!privyConfigured() || !session || session.anonymous) return null
  return <Suspense fallback={null}><PrivyRoot /></Suspense>
}
