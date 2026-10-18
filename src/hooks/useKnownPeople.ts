// The people you know, recent first: Pay's Recent row (fetchRecentContacts)
// then Pay's Contacts (lib/payPeople), both starting from Pay's cached lists
// so they're there at once. Without you. Used by "who" fields (Business →
// Charge / Bill customer) together with useUserSearch.
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '@/store'
import type { DbUser } from '@/lib/supabase'
import { readPeople } from '@/lib/peopleCache'
import { recentFirst } from '@/lib/userSearch'

type CachedRecipient = { id?: string; display?: string; displayName?: string; walletAddress?: string; avatarUrl?: string | null; isUsername?: boolean }

/** Pay's cached Recent rows (its Recipient shape) → people. */
export function recentsFromPayCache(list: readonly CachedRecipient[] | null | undefined): DbUser[] {
  return (list ?? []).filter(r => r?.id && r.isUsername !== false && r.display).map(r => ({
    id: String(r.id), username: String(r.display).replace(/\.arc$/i, ''), display_name: r.displayName && r.displayName !== 'You' ? r.displayName : String(r.display).replace(/\.arc$/i, ''),
    wallet_address: r.walletAddress ?? '', avatar_url: r.avatarUrl ?? null, created_at: '',
  }))
}

export function useKnownPeople(enabled: boolean): DbUser[] {
  const uid = useAuthStore(s => s.user?.id ?? null)
  const wallet = useAuthStore(s => s.walletAddress)
  const [contacts, setContacts] = useState<DbUser[]>(() => readPeople<DbUser>('pay-contacts', uid) ?? [])
  const [recents, setRecents] = useState<DbUser[]>(() => recentsFromPayCache(readPeople<CachedRecipient>('pay-recent', uid)))
  useEffect(() => {
    if (!enabled || !uid) return
    let live = true
    import('@/lib/payPeople').then(m => m.loadPayContacts()).then(list => { if (live && list) setContacts(list) }).catch(() => {})
    if (wallet) {
      import('@/lib/recentContacts').then(m => m.fetchRecentContacts(wallet, { activityLimit: 20, maxAddresses: 10, resultLimit: 5 })).then(rows => {
        if (!live) return
        setRecents(rows.filter(r => !r.isSelf && r.username).map(r => ({
          id: r.id, username: r.username.replace(/\.arc$/i, ''), display_name: r.display_name || r.username,
          wallet_address: r.wallet_address, avatar_url: r.avatar_url, created_at: '',
        })))
      }).catch(() => {})
    }
    return () => { live = false }
  }, [enabled, uid, wallet])
  return useMemo(() => recentFirst(recents, contacts, uid), [recents, contacts, uid])
}
