import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'
import { cacheSessionPrivateKey, clearSessionPrivateKey } from '@/lib/security'

// ─── Storage key helpers ───────────────────────────────────────────────────────
function walletKey(addr: string | null) {
  return addr ? `meshport-wallet-v2-${addr.toLowerCase()}` : null
}
function notifKey(addr: string | null) {
  return addr ? `meshport-notifications-v3-${addr.toLowerCase()}` : null
}
// Permanent record of notification ids ever shown, kept even after the
// notification itself is marked read / cleared. Without this, catch-up
// listeners (which re-scan recent server rows on every mount) would treat a
// cleared notification as "new" again the moment it's no longer present in
// the live `notifications` array, causing it to keep reappearing.
function seenKey(addr: string | null) {
  return addr ? `meshport-notifications-seen-v1-${addr.toLowerCase()}` : null
}

function saveWalletSlot(addr: string | null, balance: number) {
  const k = walletKey(addr)
  if (!k) return
  try { localStorage.setItem(k, JSON.stringify({ balance })) } catch {}
}

function loadWalletSlot(addr: string | null): { balance: number } {
  const k = walletKey(addr)
  if (!k) return { balance: 0 }
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return { balance: 0 }
    const p = JSON.parse(raw)
    const state = p?.state ?? p
    return { balance: typeof state?.balance === 'number' ? state.balance : 0 }
  } catch { return { balance: 0 } }
}

function saveNotifSlot(addr: string | null, notifications: AppNotification[]) {
  const k = notifKey(addr)
  if (!k) return
  try { localStorage.setItem(k, JSON.stringify({ notifications })) } catch {}
}

function loadNotifSlot(addr: string | null): AppNotification[] {
  const k = notifKey(addr)
  if (!k) return []
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return []
    const p = JSON.parse(raw)
    return Array.isArray(p?.notifications) ? p.notifications : []
  } catch { return [] }
}

function loadSeenIds(addr: string | null): Set<string> {
  const k = seenKey(addr)
  if (!k) return new Set()
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}

function addSeenId(addr: string | null, id: string) {
  const k = seenKey(addr)
  if (!k) return
  try {
    const ids = loadSeenIds(addr)
    ids.add(id)
    // Cap so this never grows unbounded — only the most recent ids matter
    // for de-duping catch-up scans, which only look back a limited window.
    // Was 500: an active account could push a cleared/already-seen id out
    // of that window, and the next catch-up scan (which re-checks recent
    // rows on every mount) would then treat it as never-before-seen and
    // show it again — a cleared notification silently coming back. 5000
    // gives enough headroom that eviction essentially never happens for
    // realistic usage, while still bounding storage.
    const capped = Array.from(ids).slice(-5000)
    localStorage.setItem(k, JSON.stringify(capped))
  } catch {}
}

function clearSeenIds(addr: string | null) {
  const k = seenKey(addr)
  if (!k) return
  try { localStorage.removeItem(k) } catch {}
}

// ─── Auth Store ────────────────────────────────────────────────────────────────
interface AuthStore {
  user: User | null
  isAuthenticated: boolean
  isLocked: boolean
  lastActivityAt: number
  walletAddress: string | null
  privateKey: string | null
  mnemonic: string | null
  walletSource: 'create' | 'import-seed' | 'import-privkey' | 'social-auto' | null
  username: string | null
  loginType: 'social' | 'wallet' | null
  backupEmail: string | null
  passcode: string | null
  biometricEnabled: boolean
  passcodeLockEnabled: boolean

  setUser: (user: User) => void
  updateAvatar: (avatarUrl: string | null) => void
  updateDisplayName: (name: string) => void
  setWallet: (address: string, privateKey: string, mnemonic?: string, source?: 'create' | 'import-seed' | 'import-privkey' | 'social-auto') => void
  setUsername: (username: string) => void
  setLoginType: (type: 'social' | 'wallet') => void
  setBackupEmail: (email: string | null) => void
  setPasscode: (code: string) => void
  setBiometricEnabled: (enabled: boolean) => void
  setPasscodeLockEnabled: (enabled: boolean) => void
  logout: () => void
  lock: () => void
  unlock: () => void
  touchActivity: () => void
}

// Extracted as a standalone, exported function (rather than inlined in the
// persist() config below) so it's directly unit-testable without dragging in
// the whole store's dependency graph — mirrors the pattern already used for
// ChatPage.tsx's formatPaymentMessagePreview. Called by Zustand's persist
// middleware exactly once per browser, the first time a user with an
// existing lower-versioned localStorage blob loads a build carrying this
// version bump — see zustand's own `persist` docs for that "runs only when
// versions differ" contract.
export function migrateAuthStore(persisted: any): any {
  // Clear all avatar cache — DB is source of truth
  delete persisted.persistedAvatarUrl
  delete persisted.persistedAvatars
  // SECURITY FIX (v5): the raw BIP-39 mnemonic used to be persisted in
  // plain text right here — see partialize below, and security.ts's
  // encryptMnemonic/storeEncryptedMnemonic for the full reasoning and
  // the new, properly-encrypted replacement. This scrubs any
  // already-written plaintext copy sitting in an existing user's
  // localStorage from before this fix shipped — persist's `migrate`
  // is the correct, one-time hook for that; a `partialize` change
  // alone only stops FUTURE writes; it does nothing about a value
  // already on disk from a previous version.
  delete persisted.mnemonic
  return persisted
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLocked: false,
      lastActivityAt: Date.now(),
      walletAddress: null,
      privateKey: null,
      mnemonic: null,
      walletSource: null,
      username: null,
      loginType: null,
      backupEmail: null,
      passcode: null,
      biometricEnabled: false,
      passcodeLockEnabled: true,


      setUser: (user) => {
        set({ user, isAuthenticated: true })
        // Ensure Supabase has an auth session for DB writes (wallet users have no OTP session)
        import('@/lib/supabase').then(({ ensureAnonSession }) => ensureAnonSession()).catch(() => {})
      },
      updateAvatar: (avatarUrl) => set((s) => ({
        user: s.user ? { ...s.user, avatar: avatarUrl } : null,
      })),
      updateDisplayName: (name) => set((s) => ({ user: s.user ? { ...s.user, displayName: name } : null })),
      setWallet: (address, privateKey, mnemonic, source) => {
        set((s) => ({
          walletAddress: address,
          privateKey,
          mnemonic: mnemonic !== undefined ? mnemonic : s.mnemonic,
          walletSource: source !== undefined ? source : (s.walletSource || 'create'),
        }))
        // Mirror the decrypted key into sessionStorage — this is what lets a
        // plain refresh skip the passcode prompt (see cacheSessionPrivateKey's
        // own comment in lib/security.ts for the tradeoff). Widened (was
        // import-privkey ONLY) to cover create/import-seed too: those wallet
        // types used to get this same "instant refresh" property for free by
        // persisting the raw mnemonic in plain text and re-deriving the key
        // from it on every load — see the SECURITY FIX in this file's persist
        // `migrate` above. Now that the mnemonic is no longer persisted in
        // plaintext, this sessionStorage cache is what preserves the exact
        // same "no passcode needed on a plain refresh, but a real gap —
        // tab/browser close, offline — asks again" UX those wallets already
        // had, using the identical, already-reviewed mechanism import-privkey
        // wallets have relied on for this all along. social-auto is still
        // deliberately excluded — see this function's own header comment
        // and security.ts for why that wallet type never caches its key
        // locally in ANY form.
        const effectiveSource = source !== undefined ? source : get().walletSource
        if (privateKey && effectiveSource !== 'social-auto') {
          cacheSessionPrivateKey(address, privateKey)
        }
        // A real key means recovery is no longer needed — no matter which
        // of the several paths got us here (mnemonic derive, local
        // passcode-decrypt, the social-auto server-side vault fetch, or a
        // fresh login/import). This is the single choke point every one of
        // those funnels through.
        //
        // Previously walletRecoveryNeeded was only ever cleared inside
        // restoreWallet.ts's OWN success path. That left a real gap: an
        // early restorePrivateKey() call (e.g. fired on app mount, before
        // Supabase's session had finished hydrating) could fail and flip
        // the banner on, and the key could then become available a moment
        // later through a DIFFERENT path that never calls
        // restorePrivateKey() at all (e.g. PasscodeSetup unlocking
        // directly) — nothing ever told the banner the wallet was fine
        // after that. That's exactly the "couldn't restore your wallet"
        // banner sitting on top of an already-working wallet (balance
        // loaded, address showing, everything functional).
        if (privateKey) {
          useUIStore.getState().setWalletRecoveryNeeded(false)
        }
      },
      setUsername: (username) =>
        set((s) => ({
          username,
          user: s.user ? { ...s.user, username: username + '.arc' } : s.user,
        })),
      setLoginType: (type) => set({ loginType: type }),
      setBackupEmail: (email) => set({ backupEmail: email }),
      setPasscode: (code) => set({ passcode: code }),
      setBiometricEnabled: (enabled) => set({ biometricEnabled: enabled }),
      setPasscodeLockEnabled: (enabled) => set({ passcodeLockEnabled: enabled }),

      logout: () => {
        const currentAddr = get().walletAddress

        // Clear any registered biometric credential for this wallet —
        // logging out should mean a genuinely fresh start: no lingering
        // Face ID/fingerprint unlock left bound to an account the user
        // explicitly signed out of. Fire-and-forget (dynamic import,
        // not awaited) for the same reason the rest of this function
        // doesn't block on anything — local state should clear instantly.
        if (currentAddr) {
          import('@/lib/biometric').then(({ removeBiometric, clearBiometricOfferSkip }) => {
            removeBiometric(currentAddr)
            // A logout is a genuine fresh start — don't let a stale "user
            // skipped this before logging out" cooldown from the PREVIOUS
            // session silently suppress the auto-offer for up to 24h into
            // the NEXT login/re-import. If they skip again this session,
            // recordBiometricOfferSkip sets a brand-new cooldown as normal.
            clearBiometricOfferSkip(currentAddr)
          }).catch(() => {})
        }

        // Persist balance before clearing
        const ws = useWalletStore.getState()
        saveWalletSlot(currentAddr, ws.balance)

        useWalletStore.getState()._reset()

        // Clear notification store
        useNotificationStore.getState()._resetForAddress(currentAddr)

        // Clear this wallet's session-cached decrypted key (import-privkey) —
        // logging out should mean the next login for ANY account on this
        // browser starts from a real passcode prompt, not a leftover cache.
        clearSessionPrivateKey(currentAddr)

        // Clear ALL wallet-specific localStorage keys so next account starts clean
        try {
          // Activity cache (wallet-specific key)
          // Clear all meshport activity/swap cache keys (no longer used but clean up legacy)
          if (currentAddr) {
            localStorage.removeItem(`meshport_activity_${currentAddr.toLowerCase()}`)
            localStorage.removeItem(`meshport_swap_history_${currentAddr.toLowerCase()}`)
          }
        } catch {}

        // IMPORTANT: this used to only clear MeshPort's own local state —
        // it never actually revoked the underlying Supabase Auth session.
        // That meant "logging out" was cosmetic: the Supabase JWT stayed
        // fully valid, and (for Google logins) the browser's Google session
        // cookie was untouched too — so re-authenticating could skip
        // straight through with no real prompt, since there was nothing to
        // actually re-authenticate. Fire-and-forget (not awaited) so the
        // local state clear above still happens instantly, same UX as
        // before — this just also does the part that was silently missing.
        import('@/lib/supabase').then(({ supabase }) => {
          supabase.auth.signOut().catch((e) => console.warn('[logout] supabase.auth.signOut failed:', e))
        }).catch(() => {})

        // Clear auth state
        set(() => ({
          user: null, isAuthenticated: false, walletAddress: null,
          privateKey: null, mnemonic: null, username: null,
          loginType: null, backupEmail: null, isLocked: false, walletSource: null,
          biometricEnabled: false,
        }))
      },
      lock:   () => set({ isLocked: true }),
      unlock: () => set({ isLocked: false, lastActivityAt: Date.now() }),
      touchActivity: () => set({ lastActivityAt: Date.now() }),
    }),
    {
      name: 'meshport-auth-v4',
      migrate: migrateAuthStore,
      version: 5,
      partialize: (state) => ({
        user:               state.user,
        isAuthenticated:    state.isAuthenticated,
        walletAddress:      state.walletAddress,
        walletSource:       state.walletSource,
        username:           state.username,
        loginType:          state.loginType,
        backupEmail:        state.backupEmail,
        passcode:            state.passcode,
        biometricEnabled:    state.biometricEnabled,
        passcodeLockEnabled: state.passcodeLockEnabled,
        isLocked:            state.isLocked,
        lastActivityAt:      state.lastActivityAt,

      }),
    }
  )
)

// ─── Wallet Store — NO Zustand persist (eliminates async rehydration race) ────
// All persistence is done manually and synchronously via saveWalletSlot /
// loadWalletSlot so that data is never written to or read from the wrong key.

interface WalletStore {
  balance: number
  _currentAddr: string | null
  setBalance:   (balance: number) => void
  switchWallet: (walletAddress: string | null) => void
  _reset:       () => void
}

export const useWalletStore = create<WalletStore>()((set, get) => ({
  balance:      0,
  _currentAddr: null,

  setBalance: (balance) => {
    set({ balance })
    saveWalletSlot(get()._currentAddr, balance)
  },

  switchWallet: (walletAddress) => {
    const prev = get()._currentAddr
    if (prev === walletAddress) return
    if (prev !== null) saveWalletSlot(prev, get().balance)
    const { balance } = loadWalletSlot(walletAddress)
    set({ balance, _currentAddr: walletAddress })
  },

  _reset: () => {
    set({ balance: 0, _currentAddr: null })
  },
}))

// ─── Notifications Store — per-wallet, no Zustand persist ─────────────────────
export type NotificationType =
  | 'payment_received' | 'reward_earned' | 'security_alert' | 'admin_broadcast' | 'swap_complete'
  // P2P marketplace events — sourced from Supabase `notifications` (see
  // src/lib/p2pNotifications.ts), not created directly by this store.
  // Server-driven (supabase/migrations/20260730160000_p2p_notifications_system.sql)
  // so they arrive for BOTH parties to a trade, on any device, even if the
  // recipient's tab wasn't open when the event happened.
  | 'buy_order_placed' | 'sell_order_placed' | 'payment_marked_completed' | 'funds_released'
  | 'trade_cancelled' | 'trade_expired' | 'dispute_opened' | 'dispute_resolved' | 'refund_completed'

export interface AppNotification {
  id: string
  type: NotificationType | string
  title: string
  body: string
  isRead: boolean
  timestamp: string
  // Present only for P2P notifications — lets the notification center link
  // straight to `/p2p/trade/:tradeId` instead of just showing text.
  tradeId?: string
}

interface NotificationStore {
  notifications: AppNotification[]
  unreadCount:  number
  badgeLabel:   string
  markRead:     (id: string) => void
  markAllRead:  () => void
  addNotification: (n: Omit<AppNotification, 'id' | 'timestamp'> & { id?: string; timestamp?: string }) => void
  clearAll:     () => void
  switchToAddress: (addr: string | null) => void
  _resetForAddress: (addr: string | null) => void
  _currentAddr: string | null
}

function computeBadge(notifications: AppNotification[]) {
  const count = notifications.filter(n => !n.isRead).length
  return { unreadCount: count, badgeLabel: count === 0 ? '' : count > 99 ? '99+' : String(count) }
}

export const useNotificationStore = create<NotificationStore>()((set, get) => ({
  notifications: [],
  unreadCount:  0,
  badgeLabel:   '',
  _currentAddr: null,

  markRead: (id) =>
    set((s) => {
      const notifications = s.notifications.map(n => n.id === id ? { ...n, isRead: true } : n)
      saveNotifSlot(s._currentAddr, notifications)
      return { notifications, ...computeBadge(notifications) }
    }),

  markAllRead: () =>
    set((s) => {
      const notifications = s.notifications.map(n => ({ ...n, isRead: true }))
      saveNotifSlot(s._currentAddr, notifications)
      return { notifications, unreadCount: 0, badgeLabel: '' }
    }),

  addNotification: (notif) =>
    set((s) => {
      // Date.now() alone isn't unique enough here — sending several
      // payments back-to-back can easily produce two notifications in the
      // same millisecond (e.g. the reward-points notification for a fast
      // second send). Since addNotification dedupes by id just below, an
      // ID collision meant the second notification was silently dropped
      // even though the underlying event (points awarded) was real and
      // distinct. Adding a random suffix makes collisions effectively
      // impossible without changing anything for callers that already pass
      // their own explicit, meaningful id (e.g. `payment_recv_msg_<id>`).
      const id = notif.id || 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      // Dedupe against the live list (e.g. re-synced broadcast) AND against
      // the permanent seen-id record, so a notification that was already
      // shown and then marked read / cleared doesn't get re-added by a
      // catch-up scan that re-discovers the same underlying event.
      if (s.notifications.some(n => n.id === id)) return s
      if (loadSeenIds(s._currentAddr).has(id)) return s
      const notifications = [
        { ...notif, id, timestamp: notif.timestamp || new Date().toISOString() },
        ...s.notifications,
      ].slice(0, 100)
      saveNotifSlot(s._currentAddr, notifications)
      addSeenId(s._currentAddr, id)
      return { notifications, ...computeBadge(notifications) }
    }),

  clearAll: () =>
    set((s) => {
      saveNotifSlot(s._currentAddr, [])
      // Only clears the visible list — deliberately NOT the seen-ids
      // ledger. A prior version of this wiped both, on the reasoning that
      // "Clear" should mean gone forever, everywhere. In practice that
      // broke something more important: HomePage's payment catch-up scan
      // runs on every single mount (not just once) and depends entirely on
      // this ledger's dedup to know which payments it's already shown —
      // that's explicitly what makes it safe to re-run constantly instead
      // of flooding. Wiping the ledger meant the very next Home mount had
      // no memory of anything, and re-notified for the last 20 payment
      // messages per conversation all at once, all timestamped "just now."
      // That's a strictly worse outcome than the original tradeoff this
      // was meant to close (a genuinely rediscovered event reappearing
      // once), so keeping the ledger intact here is the right call.
      //
      // But the ledger is still only local storage — clearing browser
      // history wipes it exactly the same as this action does, and at
      // that point the app has no memory of "already cleared" left
      // ANYWHERE. So this now also persists the clear moment server-side
      // (users.notifications_cleared_at) — every catch-up scan checks that
      // watermark too, so even a fully wiped browser correctly shows
      // nothing from before the last real Clear tap, because the boundary
      // itself no longer depends on local storage surviving.
      const userId = useAuthStore.getState().user?.id
      if (userId) {
        import('@/lib/supabase').then(({ supabase }) => {
          supabase.from('users').update({ notifications_cleared_at: new Date().toISOString() }).eq('id', userId)
            .then(({ error }) => { if (error) console.warn('[notifications] failed to persist clear watermark:', error.message) })
        }).catch(() => {})
      }
      return { notifications: [], unreadCount: 0, badgeLabel: '' }
    }),

  switchToAddress: (addr) => {
    // Save current slot before switching
    const curr = get()._currentAddr
    if (curr !== null) saveNotifSlot(curr, get().notifications)
    // Restore this address's slot. This used to always start empty here
    // (on every app entry, not just after a real logout) to stop old
    // notifications from reappearing — but that also wiped a perfectly
    // normal page refresh or app reopen while STILL logged in, which
    // should show real history, not a blank list. The actual fix belongs
    // at logout: _resetForAddress already clears both the visible list
    // AND this address's localStorage slot when the user explicitly logs
    // out (see below) — so by the time someone logs back in, this slot is
    // already empty and correctly restores nothing. A plain revisit never
    // touched the slot, so it correctly restores what was really there.
    const notifications = loadNotifSlot(addr)
    set({ notifications, _currentAddr: addr, ...computeBadge(notifications) })
  },

  _resetForAddress: (addr) => {
    // Hides the visible notification list on logout — re-logging in starts
    // with an empty list, never showing old notification cards sitting
    // around from a previous session.
    //
    // Deliberately does NOT wipe the seen-ids ledger. That ledger exists
    // so catch-up mechanisms (claim-recovery-scan, the missed-payment
    // catch-up scan, etc.) know "a notification for this exact event was
    // already generated once" and don't fire a second one. Wiping it here
    // meant every one of those scans treated the account's entire history
    // as never-before-seen the moment you logged back in — regenerating
    // fresh "funds received" notifications for transactions that happened
    // in a previous session and were already seen and dismissed. Logout
    // should clear what's showing, not make the app forget what it's
    // already told you about.
    const k = notifKey(addr)
    if (k) try { localStorage.removeItem(k) } catch {}
    set({ notifications: [], unreadCount: 0, badgeLabel: '' })
  },
}))

// ─── Wire wallet switching across all stores ───────────────────────────────────
// Runs synchronously whenever walletAddress changes in the auth store.
useAuthStore.subscribe((state, prevState) => {
  if (state.walletAddress !== prevState.walletAddress) {
    useWalletStore.getState().switchWallet(state.walletAddress)
    useNotificationStore.getState().switchToAddress(state.walletAddress)
  }
})

// ─── Bootstrap on app startup ─────────────────────────────────────────────────
// Auth store has already rehydrated synchronously from 'meshport-auth-v2' by the
// time this module-level code runs (Zustand persist with localStorage is sync).
// Load the correct wallet slot immediately — no race possible.
;(() => {
  const addr = useAuthStore.getState().walletAddress
  useWalletStore.getState().switchWallet(addr)
  useNotificationStore.getState().switchToAddress(addr)
})()

// ─── UI Store ──────────────────────────────────────────────────────────────────
type ToastType = 'success' | 'error' | 'info' | 'warning'
interface UIStore {
  toast: { message: string; type: ToastType } | null
  sendRecipient: string | null
  // Set by restoreWallet.ts when every automatic recovery path has been
  // exhausted for the current wallet (no local key, no server-side backup
  // backup reachable). Drives a persistent, app-wide banner (see
  // WalletRecoveryBanner.tsx) pointing the user at manually re-entering
  // their recovery phrase — instead of each of the 13+ call sites of
  // restorePrivateKey() individually deciding what to do about a failure,
  // which previously meant most of them just failed silently or showed a
  // one-off toast with no path forward for the user.
  walletRecoveryNeeded: boolean
  showToastMessage: (message: string, type?: ToastType) => void
  clearToast: () => void
  setSendRecipient: (recipient: string | null) => void
  setWalletRecoveryNeeded: (needed: boolean) => void
}

export const useUIStore = create<UIStore>()((set) => ({
  toast: null,
  sendRecipient: null,
  walletRecoveryNeeded: false,
  showToastMessage: (message, type = 'info') => {
    set({ toast: { message, type } })
    setTimeout(() => set({ toast: null }), 3500)
  },
  clearToast: () => set({ toast: null }),
  setSendRecipient: (recipient) => set({ sendRecipient: recipient }),
  setWalletRecoveryNeeded: (needed) => set({ walletRecoveryNeeded: needed }),
}))

// ─── Chat unread badge (shared by BottomNav + ChatListPage) ────────────────────
// A single source of truth for the total unread-chats count, so opening a
// conversation and marking it read can push an instant update to the bottom
// nav badge without waiting on the nav's own realtime round trip (DB write →
// postgres_changes event → re-fetch). The nav still resyncs from the DB on
// its own schedule to correct any drift — this only makes the common case
// (you open a chat, its unread count clears) feel instant.
interface ChatUnreadStore {
  unreadChats: number
  setUnreadChats: (n: number) => void
  decrementBy: (n: number) => void
}

export const useChatUnreadStore = create<ChatUnreadStore>()((set) => ({
  unreadChats: 0,
  setUnreadChats: (n) => set({ unreadChats: Math.max(0, n) }),
  decrementBy: (n) => set((s) => ({ unreadChats: Math.max(0, s.unreadChats - n) })),
}))

// ─── Username helpers ──────────────────────────────────────────────────────────
export async function checkUsernameAvailability(username: string): Promise<{ available: boolean; error: string | null }> {
  if (username.length < 3)  return { available: false, error: 'Minimum 3 characters' }
  if (username.length > 20) return { available: false, error: 'Maximum 20 characters' }
  if (!/^[a-z0-9_]+$/.test(username)) return { available: false, error: 'Only a-z, 0-9, and _ allowed' }
  const { isUsernameTakenDb } = await import('../lib/supabase')
  const taken = await isUsernameTakenDb(username)
  if (taken) return { available: false, error: 'Username already taken' }
  return { available: true, error: null }
}

export async function reserveUsername(username: string, walletAddress?: string, displayName?: string): Promise<void> {
  if (!walletAddress) return
  const { registerUsername } = await import('../lib/usernameRegistry')
  await registerUsername({ username, walletAddress, displayName: displayName || username })
}
