/**
 * Clears all legacy localStorage keys that may contain mock/fake data.
 * Runs once on app startup. Safe to call multiple times.
 */
const CLEARED_KEY = 'meshport_legacy_cleared_v3'

export function clearLegacyData(): void {
  if (typeof window === 'undefined') return
  if (localStorage.getItem(CLEARED_KEY)) return // Already cleared

  const keysToRemove = [
    // Old persist keys that may contain mock data
    'meshport-auth',
    'meshport-wallet',
    'meshport-notifications',
    'meshport-contacts',          // Old contacts with mock data
    'meshport-contacts-v2',       // May also have mock contacts
    'meshport-contacts-v3',       // Old global (non-wallet-scoped) contacts store
    // The generic wallet fallback key — data written here by the old async
    // rehydration race. Safe to remove: per-wallet keys are meshport-wallet-v2-<addr>
    'meshport-wallet-v2',
    // Wallet-specific transaction stores — transactions now come from ArcScan
    // These keys follow pattern meshport-wallet-v2-0x<addr> — cleared on startup
    // (dynamic keys can't be listed here; we scan and clear them below)
    // Old global notification key (replaced by per-wallet meshport-notifications-v3-<addr>)
    'meshport-notifications-v3',
    // Old global hidden chats key (replaced by meshport_hidden_chats_<addr>)
    'meshport_hidden_chats',
    // Old registry caches with demo users
    'meshport_username_registry',
    'meshport_user_cache_v1',
    'meshport_registry_v2',
    'meshport_registry_v3',
    'meshport_registry_seeded_v1',
    'meshport_registry_bin_id',
    'meshport_shared_bin_id',
    // Old passcode salt (superseded by embedded-salt format)
    'meshport_passcode_salt',
  ]

  let cleared = 0
  keysToRemove.forEach(key => {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key)
      cleared++
    }
  })

  if (cleared > 0) {
  }

  // Clear all wallet-specific transaction slots (meshport-wallet-v2-0x...)
  // Transactions are now read from ArcScan, not localStorage
  const keysToScan = Object.keys(localStorage)
  keysToScan.forEach(key => {
    if (key.startsWith('meshport-wallet-v2-0x')) {
      localStorage.removeItem(key)
      cleared++
    }
  })

  localStorage.setItem(CLEARED_KEY, '1')
}
