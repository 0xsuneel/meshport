// Profile photos for a list of MeshPort usernames (Business → payments,
// customers): one query for the ones not asked yet, kept for the session.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

const known = new Map<string, string | null>() // username → photo (null: none)
const asking = new Map<string, Promise<void>>()

const norm = (u: string) => u.toLowerCase().replace(/\.arc$/, '').trim()

async function fetchAvatars(names: string[]): Promise<void> {
  const todo = names.filter(n => n && !known.has(n) && !asking.has(n))
  if (!todo.length) { await Promise.all(names.map(n => asking.get(n)).filter(Boolean)); return }
  const run = (async () => {
    for (let i = 0; i < todo.length; i += 100) {
      const part = todo.slice(i, i + 100)
      const { data, error } = await supabase.from('users').select('username, avatar_url').in('username', part)
      if (error) return // not stored: asked again next time
      const got = new Map((data ?? []).map((r: any) => [norm(String(r.username)), r.avatar_url ?? null] as const))
      for (const n of part) known.set(n, got.get(n) ?? null)
    }
  })().finally(() => { for (const n of todo) asking.delete(n) })
  for (const n of todo) asking.set(n, run)
  await run
}

/** The photo kept for this username, if it has been looked up. */
export function avatarOf(username: string | null | undefined): string | null {
  return username ? known.get(norm(username)) ?? null : null
}

/**
 * Photos for these usernames (by plain username, no .arc). Returns a map that
 * fills in once looked up; a username with no photo maps to null.
 */
export function useUserAvatars(usernames: (string | null | undefined)[]): Map<string, string | null> {
  const names = [...new Set(usernames.filter((u): u is string => !!u).map(norm))].sort()
  const key = names.join(',')
  const [version, bump] = useState(0)
  useEffect(() => {
    if (!names.length || names.every(n => known.has(n))) return
    let live = true
    void fetchAvatars(names).then(() => { if (live) bump(x => x + 1) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the joined names
  }, [key])
  // The same map until a lookup lands, so screens can memo on it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the joined names
  return useMemo(() => new Map(names.map(n => [n, known.get(n) ?? null])), [key, version])
}
