// Pay's Contacts list - saved contacts + conversation partners, merged A-Z,
// without removed ones, your own profile pinned first - shared by Pay and the
// Business customer field (both keep it in peopleCache as 'pay-contacts').
import { useAuthStore } from '@/store'
import { fetchContactsDbStrict, fetchConversations, type DbUser } from './supabase'
import { readPeople, writePeople } from './peopleCache'

/** The fresh list (also saved to the cache), or null when the server couldn't
 *  be reached and a cached list exists (keep showing that one). */
export async function loadPayContacts(): Promise<DbUser[] | null> {
  const { user: u, walletAddress: wa } = useAuthStore.getState()
  const { getRemovedContacts } = await import('./removedContacts')
  const removed = getRemovedContacts(wa)
  const contactsP = u?.id && !u.id.startsWith('usr_')
    ? fetchContactsDbStrict(u.id).then(rows => ({ ok: true as const, rows }), () => ({ ok: false as const, rows: [] as DbUser[] }))
    : Promise.resolve({ ok: true as const, rows: [] as DbUser[] })
  const convsP = u?.id
    ? fetchConversations(u.id).catch(() => [] as any[])
    : Promise.resolve([] as any[])
  const [savedRes, convs] = await Promise.all([contactsP, convsP])
  // Couldn't reach the server: keep the cached list that's showing.
  if (!savedRes.ok && readPeople('pay-contacts', u?.id)) return null
  const merged = new Map<string, DbUser>()
  // Exclude your own id here - self is handled separately below as a
  // single pinned synthetic entry. Without this, a self-conversation
  // (created when you pay yourself by username - see PaySendPage's
  // chat block, which creates a conversation between user.id and
  // otherUser.id even when they're the same id) makes fetchConversations
  // return YOU as your own "other_user", merging you into this list a
  // second time - then the explicit `self` entry gets prepended on top
  // of that, producing two "(You)" rows.
  for (const c of savedRes.rows) if (!removed.has(c.id) && c.id !== u?.id) merged.set(c.id, c)
  for (const conv of convs) {
    const other = conv.other_user
    if (other && other.id !== u?.id && !removed.has(other.id) && !merged.has(other.id)) merged.set(other.id, other)
  }
  const sorted = Array.from(merged.values()).sort((a, b) =>
    (a.display_name || a.username).localeCompare(b.display_name || b.username)
  )
  // Self-transfer: pin your own profile at the top of Contacts, as a
  // synthetic entry - never written to `user_contacts`, purely a UI
  // convenience so "pay yourself" is always one tap away without
  // requiring you to add yourself as a contact first. isSelf-tagged
  // rendering (the "(You)" label) happens where this list is shown; this
  // only builds the row's data.
  const self: DbUser | null = u?.id
    ? {
        id: u.id,
        username: u.username,
        display_name: u.displayName || u.username,
        email: u.email,
        wallet_address: wa || u.walletAddress,
        avatar_url: u.avatar || null,
        created_at: u.createdAt,
      }
    : null
  const list = self ? [self, ...sorted] : sorted
  writePeople('pay-contacts', u?.id, list)
  return list
}
