// Finding MeshPort people by name or username - the rules Pay's recipient
// search uses, shared with every other "who" field (Business → Charge / Bill
// customer). Partial text only matches people you already know (recent +
// contacts); the full username ("sunil.arc") is looked up exactly - there is
// no open directory search.

/** The fields a person row needs (DbUser and RecentContact both fit). */
export interface PersonLite {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
  wallet_address?: string | null
}

/** "@Priya.arc " → "priya". */
export const bareHandle = (v: string): string => v.trim().replace(/^@/, '').replace(/\.arc$/i, '').trim().toLowerCase()

/** "priya" / "priya.arc" → "priya.arc". */
export const arcHandle = (username: string): string => `${username.trim().replace(/^@/, '').replace(/\.arc$/i, '')}.arc`

/** A full username was typed ("priya.arc") - the only text looked up in the directory. */
export const isFullUsername = (raw: string): boolean => /\.arc$/i.test(raw.trim()) && bareHandle(raw) !== ''

/** People you know whose name or username contains what was typed (case-insensitive). */
export function matchPeople<T extends PersonLite>(people: readonly T[], raw: string): T[] {
  const term = bareHandle(raw)
  if (!term) return []
  return people.filter(c =>
    (c.display_name || '').toLowerCase().includes(term) ||
    (c.username || '').toLowerCase().replace(/\.arc$/i, '').includes(term))
}

/** A full-username lookup: the known person with exactly that username, then
 *  directory results that aren't already listed. */
export function mergeExact<T extends PersonLite>(known: readonly T[], found: readonly T[], raw: string): T[] {
  const term = bareHandle(raw)
  const exact = known.filter(c => (c.username || '').toLowerCase().replace(/\.arc$/i, '') === term)
  const ids = new Set(exact.map(c => c.id))
  return [...exact, ...found.filter(u => !ids.has(u.id))]
}

/** Recent people first, then contacts; one row per person, without `excludeId` (you). */
export function recentFirst<T extends PersonLite>(recents: readonly T[], contacts: readonly T[], excludeId?: string | null): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of [...recents, ...contacts]) {
    if (!p?.id || !p.username || p.id === excludeId || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/** What the picker says under a typed name nobody was picked for (null: nothing). */
export function pickerProblem(query: string, opts: { searching: boolean; found: number; self: boolean; allowAddress?: boolean }): { text: string; tone: 'danger' | 'muted' } | null {
  const raw = query.trim().replace(/^@/, '')
  const bare = bareHandle(query)
  if (!bare || opts.searching || opts.found > 0) return null
  if (opts.allowAddress && /^0x/i.test(raw)) {
    return /^0x[0-9a-f]{40}$/i.test(raw) ? null : { text: 'A wallet address is 0x and 40 more characters - check it', tone: 'muted' }
  }
  if (!isFullUsername(query)) {
    // "ravi.acd", "ravi.com": a wrong ending (still typing ".a" / ".ar" is fine).
    const dot = raw.lastIndexOf('.')
    const ending = dot > 0 ? raw.slice(dot + 1).toLowerCase() : null
    if (ending !== null && !'arc'.startsWith(ending)) {
      return { text: `Usernames end in .arc - did you mean ${bareHandle(raw.slice(0, dot))}.arc?`, tone: 'danger' }
    }
    const base = dot > 0 ? bareHandle(raw.slice(0, dot)) : bare
    return { text: `Type the full username, like ${base}.arc`, tone: 'muted' }
  }
  return opts.self ? { text: "That's your own username", tone: 'danger' } : { text: `User not found - no MeshPort user is called ${bare}.arc`, tone: 'danger' }
}

/** The person exactly named by `query` among `results` (a full username typed but not tapped). */
export function exactPick(query: string, results: readonly PersonLite[]): PersonLite | null {
  if (!isFullUsername(query)) return null
  const bare = bareHandle(query)
  return results.find(u => bareHandle(u.username) === bare) ?? null
}
