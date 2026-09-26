// Tracks explicitly removed contacts per wallet address
// Removed contacts are excluded from recents and contact lists
// They re-appear only when: a NEW payment is made/received *after* the removal,
// or the contact is manually re-added.
//
// Stored as { [userId]: removedAtISOString } rather than a bare id list so
// callers can tell whether a payment happened before or after the removal.
// Without the timestamp, any code that "re-allows a contact because they once
// paid us" (see HomePage's incoming-payment handling) ends up re-allowing
// EVERY removed contact who has ever transacted with you at all — which
// silently undid "Remove contact" the next time the app scanned payment
// history, since almost everyone you'd remove has a past payment on record.

const key = (walletAddr: string | null) =>
  `meshport_removed_contacts_${(walletAddr || 'anon').toLowerCase()}`

function getMap(myWallet: string | null): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key(myWallet)) || '{}')
    // Back-compat: earlier versions stored a plain array of ids with no timestamp.
    if (Array.isArray(raw)) {
      const migrated: Record<string, string> = {}
      const nowIso = new Date().toISOString() // treat legacy removals as "just now" so old history doesn't instantly re-allow them
      for (const id of raw) migrated[id] = nowIso
      return migrated
    }
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function setMap(myWallet: string | null, m: Record<string, string>) {
  localStorage.setItem(key(myWallet), JSON.stringify(m))
}

export function getRemovedContacts(myWallet: string | null): Set<string> {
  return new Set(Object.keys(getMap(myWallet)))
}

/** When was this contact removed? null if they aren't currently removed. */
export function getRemovedAt(myWallet: string | null, userId: string): string | null {
  return getMap(myWallet)[userId] ?? null
}

export function addRemovedContact(myWallet: string | null, removedUserId: string) {
  try {
    const m = getMap(myWallet)
    m[removedUserId] = new Date().toISOString()
    setMap(myWallet, m)
  } catch {}
}

export function removeFromRemovedContacts(myWallet: string | null, userId: string) {
  try {
    const m = getMap(myWallet)
    delete m[userId]
    setMap(myWallet, m)
  } catch {}
}

/**
 * Un-block a contact only if something genuinely new happened with them
 * after they were removed. `activityAtISO` is the timestamp of the payment
 * (or other activity) that would justify re-allowing them. If the contact
 * isn't currently removed, or the activity predates the removal, this is a
 * no-op — so scanning old history never resurrects an intentional removal.
 */
export function unblockIfNewerActivity(myWallet: string | null, userId: string, activityAtISO: string | null | undefined) {
  try {
    const m = getMap(myWallet)
    const removedAt = m[userId]
    if (!removedAt) return
    if (!activityAtISO) return
    if (new Date(activityAtISO).getTime() > new Date(removedAt).getTime()) {
      delete m[userId]
      setMap(myWallet, m)
    }
  } catch {}
}

export function clearRemovedContacts(myWallet: string | null) {
  try { localStorage.removeItem(key(myWallet)) } catch {}
}
