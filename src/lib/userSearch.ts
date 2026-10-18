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
export function pickerProblem(query: string, opts: { searching: boolean; found: number; self: boolean }): { text: string; tone: 'danger' | 'muted' } | null {
  const bare = bareHandle(query)
  if (!bare || opts.searching || opts.found > 0) return null
  if (!isFullUsername(query)) return { text: `Type their full username, like ${bare}.arc`, tone: 'muted' }
  return opts.self ? { text: "That's your own username", tone: 'danger' } : { text: `No MeshPort user called ${bare}.arc`, tone: 'danger' }
}

/** The person exactly named by `query` among `results` (a full username typed but not tapped). */
export function exactPick(query: string, results: readonly PersonLite[]): PersonLite | null {
  if (!isFullUsername(query)) return null
  const bare = bareHandle(query)
  return results.find(u => bareHandle(u.username) === bare) ?? null
}
