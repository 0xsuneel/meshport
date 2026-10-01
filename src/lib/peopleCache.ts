import type { DbUser } from '@/lib/supabase'

// Last-known people lists (Pay's Recent/Contacts, Chat's Contacts), so those
// screens show them the instant they open and refresh quietly in the
// background, instead of an empty screen while the network catches up.
// Kept in memory and in localStorage (per user), so it also works right
// after a reload. Only public profile fields are stored — email is dropped.
const mem = new Map<string, unknown>()
const storageKey = (scope: string, uid: string) => `meshport_people_${scope}_${uid}`

export function readPeople<T = DbUser>(scope: string, uid: string | null | undefined): T[] | null {
  if (!uid) return null
  const k = storageKey(scope, uid)
  if (mem.has(k)) return mem.get(k) as T[]
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return null
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return null
    mem.set(k, list)
    return list as T[]
  } catch { return null }
}

export function writePeople<T>(scope: string, uid: string | null | undefined, list: T[]) {
  if (!uid) return
  const k = storageKey(scope, uid)
  const safe = list.map(p => {
    if (p && typeof p === 'object' && 'email' in (p as object)) return { ...(p as object), email: '' } as T
    return p
  })
  mem.set(k, safe)
  try { localStorage.setItem(k, JSON.stringify(safe)) } catch { /* storage full or blocked */ }
}
