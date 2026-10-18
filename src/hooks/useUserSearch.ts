// Pay's recipient search as a hook (PaySendPage and the Business customer
// field use it): partial text filters the people you know; a full username
// ("sunil.arc") is looked up exactly in the directory - no open search.
import { useEffect, useState } from 'react'
import { searchUsersDb, type DbUser } from '@/lib/supabase'
import { isFullUsername, matchPeople, mergeExact } from '@/lib/userSearch'

export function useUserSearch(query: string, people: readonly DbUser[]): { results: DbUser[]; searching: boolean } {
  const [results, setResults] = useState<DbUser[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const raw = query.trim()
    setResults([])
    if (!raw) { setSearching(false); return }
    // Partial: only people you already know - no open directory search.
    if (!isFullUsername(raw)) { setResults(matchPeople(people, raw)); setSearching(false); return }
    // Full username.arc - exact match only (a specific person's handle, so
    // no similarly-named results).
    setSearching(true)
    let live = true
    const timer = setTimeout(async () => {
      try {
        const found = await searchUsersDb(raw) // exact "username = term": 0 or 1 result
        if (!live) return
        setResults(mergeExact(people, found, raw))
      } catch { /* shows as no results */ }
      if (live) setSearching(false)
    }, 220)
    return () => { live = false; clearTimeout(timer) }
  }, [query, people])
  return { results, searching }
}
