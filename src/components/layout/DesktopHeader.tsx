// DesktopHeader.tsx
// Sticky top bar shown only at desktop widths, alongside DesktopSidebar.
// The search box is a real, live input owned entirely by this component —
// typing here searches people + services and shows results in a dropdown
// anchored directly under this same box. It used to just navigate to
// `/?search=1` and open a second search panel on Home's own page instead,
// which put results in a different box than the one you typed into (and
// didn't work at all from any page other than Home). Notification bell
// reuses the exact same useNotificationStore fields PageHeader.tsx already
// reads.
import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Bell, HelpCircle, Loader2, Sun, Moon } from 'lucide-react'
import { useAuthStore, useNotificationStore, useUIStore } from '@/store'
import { useThemeStore, resolveTheme } from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { searchUsersDb, getOrCreateConversation, fetchContactsDb, type DbUser } from '@/lib/supabase'
import { getRemovedContacts } from '@/lib/removedContacts'
import { filterServices } from '@/lib/searchServices'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

// Loaded on demand — the notifications popup's own content (list rendering,
// P2P read-state sync, etc.) already lives in NotificationsPage; lazy so the
// header's own chunk doesn't pull all of that in until someone actually
// opens the bell.
const NotificationsPage = lazy(() =>
  import('@/features/profile/ProfileSubPages').then(m => ({ default: m.NotificationsPage }))
)

// Same lazy + embedded-dialog treatment as the notifications bell above —
// Help & Support now opens as a popup over whatever page the person is on
// (desktop only) instead of navigating away to /help-support.
const HelpSupportPage = lazy(() =>
  import('@/features/profile/HelpSupportPage').then(m => ({ default: m.HelpSupportPage }))
)

function copyText(text: string) { try { navigator.clipboard.writeText(text) } catch {} }

function highlightMatch(text: string, query: string) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1 || !query) return text
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: 'var(--brand)' }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

export function DesktopHeader() {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const { unreadCount, badgeLabel } = useNotificationStore()
  const { showToastMessage } = useUIStore()
  // Same store ProfileSubPages' Appearance settings and LandingNav's own
  // header toggle already use — clicking here just flips light/dark
  // directly (bypassing "system"), matching LandingNav's toggle exactly.
  // Appearance settings remains the only place to pick "System".
  const mode = useThemeStore(s => s.mode)
  const setMode = useThemeStore(s => s.setMode)
  const isDark = resolveTheme(mode) === 'dark'

  // Same faucet logic as HomePage's Assets-card Faucet button: opens
  // Circle's public faucet (faucet.circle.com) rather than calling their
  // /v1/faucet/drips API directly, since that endpoint's daily limit is
  // scoped to the whole shared server-side API key, not per wallet. The
  // wallet address is copied first so the user can paste it on the page.
  const handleFaucet = () => {
    if (walletAddress) {
      copyText(walletAddress)
      showToastMessage('Address copied — paste it on the faucet page', 'success')
    }
    window.open('https://faucet.circle.com/', '_blank', 'noopener,noreferrer')
  }

  const displayName = user?.displayName || username || (user?.username || '').replace(/\.arc$/, '') || 'User'
  const arcHandle = (username || '').replace(/\.arc$/, '') + '.arc'

  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [savedContacts, setSavedContacts] = useState<DbUser[] | null>(null)
  const [people, setPeople] = useState<DbUser[]>([])
  const [searching, setSearching] = useState(false)
  const [navigatingId, setNavigatingId] = useState<string | null>(null)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const services = filterServices(query)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Fetch known people once, lazily, the first time the dropdown opens —
  // merges explicit saved contacts with people from recent send/receive
  // activity, same source+reasoning as Home's own mobile search (see
  // HomePage.tsx) — kept as a separate fetch here rather than shared state
  // since this dropdown's lifecycle spans every route, not just Home.
  useEffect(() => {
    if (!open || savedContacts !== null || !user?.id || !walletAddress) return

    const loadKnownPeople = async () => {
      const [explicitContacts, recentPeople] = await Promise.all([
        fetchContactsDb(user.id!).catch(() => []),
        (async () => {
          try {
            const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
            const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
            const headers = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
            const myAddr = walletAddress.toLowerCase()
            const [sentRes, recvRes] = await Promise.all([
              fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.send&order=created_at.desc&limit=20&select=counterparty_address`, { headers }),
              fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.receive&order=created_at.desc&limit=20&select=counterparty_address`, { headers }),
            ])
            const [sentRows, recvRows] = await Promise.all([sentRes.json(), recvRes.json()])
            const addrs = [...new Set(
              [...(Array.isArray(sentRows) ? sentRows : []), ...(Array.isArray(recvRows) ? recvRows : [])]
                .map((r: any) => (r.counterparty_address || '').toLowerCase())
                .filter((a: string) => a && a !== myAddr)
            )]
            if (!addrs.length) return []
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase.from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').or(addrs.map(a => `wallet_address.ilike.${a}`).join(','))
            return (data || []) as DbUser[]
          } catch { return [] }
        })(),
      ])

      const removed = getRemovedContacts(walletAddress)
      const merged = new Map<string, DbUser>()
      for (const u of [...explicitContacts, ...recentPeople]) {
        if (!removed.has(u.id)) merged.set(u.id, u)
      }
      setSavedContacts([...merged.values()])
    }
    loadKnownPeople()
  }, [open, user?.id, walletAddress])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setPeople([]); setSearching(false); return }

    const ql = q.toLowerCase().replace(/^@/, '')
    const contactMatches = (savedContacts ?? []).filter(c =>
      (c.display_name || '').toLowerCase().includes(ql) ||
      (c.username || '').toLowerCase().includes(ql)
    )

    // Full .arc handle typed? Also check for a NEW (not-already-known) user.
    const isFullHandle = ql.endsWith('.arc')
    if (!isFullHandle) {
      setPeople(contactMatches.slice(0, 6))
      setSearching(false)
      return
    }

    setPeople(contactMatches.slice(0, 6))
    setSearching(true)
    const timer = setTimeout(() => {
      searchUsersDb(q, user?.id)
        .then(exact => {
          const removed = getRemovedContacts(walletAddress)
          const contactIds = new Set(contactMatches.map(c => c.id))
          const newOnes = exact.filter(u => !contactIds.has(u.id) && !removed.has(u.id))
          setPeople([...contactMatches, ...newOnes].slice(0, 6))
        })
        .catch(() => {})
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [query, savedContacts, user?.id, walletAddress])

  const closeSearch = () => { setOpen(false); setQuery('') }

  const openChatWithUser = async (otherUser: DbUser) => {
    if (!user?.id || navigatingId) return
    setNavigatingId(otherUser.id)
    try {
      const { id: convId, error } = await getOrCreateConversation(user.id, otherUser.id)
      if (error || !convId) return
      const { cacheOtherUser } = await import('@/features/chat/ChatPage')
      cacheOtherUser(convId, otherUser)
      closeSearch()
      navigate(`/chat/${convId}`)
    } finally {
      setNavigatingId(null)
    }
  }

  return (
    <>
    <header style={{
      height: 68, flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '0 28px', borderBottom: '1px solid var(--border)',
      background: 'color-mix(in srgb, var(--bg) 95%, transparent)',
      backdropFilter: 'blur(12px)',
      boxShadow: 'var(--shadow-1)',
      position: 'relative', zIndex: 5,
    }}>
      <div ref={boxRef} style={{ position: 'relative', width: 340, flexShrink: 0 }}>
        {/* One continuous box, not an input plus a separate floating
            dropdown card below it — when results are showing, THIS same
            element grows taller and wider (absolutely positioned so it
            overlays instead of pushing the rest of the header) rather
            than opening a second, visually distinct box underneath. */}
        <div
          className="desktop-header-btn"
          style={{
            position: open ? 'absolute' : 'static',
            top: 0, left: 0,
            width: open ? 420 : '100%',
            background: 'var(--surface)',
            border: `1px solid ${open ? 'color-mix(in srgb, var(--brand) 25%, transparent)' : 'var(--dh-hover-border, var(--border))'}`,
            borderRadius: 16,
            boxShadow: open ? 'var(--shadow-3)' : 'none',
            zIndex: 50,
            overflow: 'hidden',
            transition: 'border-color 150ms ease',
          }}
        >
          <div
            onClick={() => { setOpen(true); inputRef.current?.focus() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px',
              color: 'var(--text-secondary)', fontSize: 13.5, cursor: 'text',
            }}
          >
            <Search size={16} style={{ flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true) }}
              onFocus={() => setOpen(true)}
              placeholder="Search people, services…"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13.5 }}
            />
            {query && (
              <button
                onClick={(e) => { e.stopPropagation(); closeSearch() }}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
              >
                Cancel
              </button>
            )}
          </div>

          {open && query.trim() && (
            <div style={{ borderTop: '1px solid var(--border)', padding: '4px 10px 10px', maxHeight: '55vh', overflowY: 'auto' }}>
              {searching && people.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>Searching...</p>
              )}

              {people.length > 0 && (
                <>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '12px 0 4px 6px' }}>People</div>
                  {people.map(p => (
                    <div key={p.id} onClick={() => openChatWithUser(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderRadius: 12, cursor: 'pointer', opacity: navigatingId === p.id ? 0.5 : 1 }}>
                      <Avatar name={p.display_name || p.username || 'U'} src={p.avatar_url} size="sm" />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{highlightMatch(p.display_name || p.username || '', query.trim())}</div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{(p.username || '').replace(/\.arc$/, '')}.arc</div>
                      </div>
                      {navigatingId === p.id && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }} />}
                    </div>
                  ))}
                </>
              )}

              {services.length > 0 && (
                <>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '12px 0 4px 6px' }}>Services</div>
                  {services.map(s => (
                    <div key={s.path} onClick={() => { closeSearch(); navigate(s.path) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderRadius: 12, cursor: 'pointer' }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/></svg>
                      </div>
                      <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{highlightMatch(s.label, query.trim())}</div>
                    </div>
                  ))}
                </>
              )}

              {!searching && people.length === 0 && services.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
                  {query.trim().toLowerCase().endsWith('.arc')
                    ? `No results for "${query.trim()}"`
                    : 'No saved contact matches — enter the full username.arc to find someone new'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <motion.button
        onClick={() => setMode(isDark ? 'light' : 'dark')}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        whileHover={{ scale: 1.06, boxShadow: 'var(--shadow-2)' }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        style={{
          width: 38, height: 38, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        {isDark ? <Sun size={17} /> : <Moon size={17} />}
      </motion.button>

      <motion.button
        onClick={handleFaucet}
        whileHover={{ scale: 1.04, boxShadow: 'var(--shadow-2)' }}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 16px', borderRadius: 999,
          // Matches the "Arc Testnet" pill right next to it (same green
          // background/border/text treatment) instead of the previous
          // plain surface/border styling -- desktop header only, per
          // request; HomePage's/MultichainPage's own Faucet buttons are
          // untouched.
          background: 'color-mix(in srgb, var(--success) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
          cursor: 'pointer', fontSize: 13.5, fontWeight: 600, color: 'var(--success)', flexShrink: 0,
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path d="M12 3s6 6.5 6 10.5a6 6 0 01-12 0C6 9.5 12 3 12 3z" stroke="var(--success)" strokeWidth="1.8" strokeLinejoin="round"/>
        </svg>
        Faucet
      </motion.button>

      <span style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '8px 16px', borderRadius: 999,
        background: 'color-mix(in srgb, var(--success) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
        fontSize: 13.5, fontWeight: 600, color: 'var(--success)', flexShrink: 0,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
        Arc Testnet
      </span>

      <motion.button
        onClick={() => setShowNotifications(true)}
        whileHover={{ scale: 1.06, boxShadow: 'var(--shadow-2)' }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        style={{
          position: 'relative', width: 38, height: 38, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        <Bell size={17} />
        {unreadCount > 0 && (
          <motion.span
            key={badgeLabel}
            initial={{ scale: 0.6 }} animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
            style={{
              position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: 8,
              background: 'var(--danger)', color: '#fff', fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {badgeLabel}
          </motion.span>
        )}
      </motion.button>

      <motion.button
        onClick={() => setShowHelp(true)}
        whileHover={{ scale: 1.06, boxShadow: 'var(--shadow-2)' }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        style={{
          width: 38, height: 38, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        <HelpCircle size={17} />
      </motion.button>

      <motion.button
        onClick={() => navigate('/profile')}
        whileHover={{ boxShadow: 'var(--shadow-2)' }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '5px 12px 5px 5px', borderRadius: 999,
          background: 'var(--surface)', border: '1px solid var(--border)',
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        <Avatar name={displayName} src={user?.avatar} size="sm" />
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.25 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName}</span>
          <span style={{ fontSize: 11, color: 'var(--link)' }}>{arcHandle}</span>
        </span>
      </motion.button>
    </header>

    {/* Notifications — a popup dialog rather than navigating to /notifications
        as a separate page, so checking notifications never leaves whatever
        the person was doing underneath. */}
    <AnimatePresence>
      {showNotifications && (
        <DesktopDialogFrame onClose={() => setShowNotifications(false)} maxWidth={420}>
          <Suspense fallback={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          }>
            <NotificationsPage embedded onClose={() => setShowNotifications(false)} />
          </Suspense>
        </DesktopDialogFrame>
      )}
    </AnimatePresence>

    {/* Help & Support — same popup-dialog treatment as Notifications above,
        desktop only (this header itself is desktop-only). Mobile keeps
        navigating to the real /help-support route via ProfilePage's own
        menu item, untouched. */}
    <AnimatePresence>
      {showHelp && (
        <DesktopDialogFrame onClose={() => setShowHelp(false)} maxWidth={480}>
          <Suspense fallback={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          }>
            <HelpSupportPage embedded onClose={() => setShowHelp(false)} />
          </Suspense>
        </DesktopDialogFrame>
      )}
    </AnimatePresence>
    </>
  )
}
