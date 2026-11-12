import { CONTROL_MOTION } from '@/lib/motion'
import { useEffect, useRef } from 'react'
import { prewarmCamera } from '@/lib/scannerPrewarm'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuthStore, useChatUnreadStore } from '@/store'
import { NavIcon, type NavIconName } from './navIcons'
import { Store } from 'lucide-react'
import { useBusinessTab } from '@/lib/merchant'
import { useAccountLock, isLockedPath } from '@/lib/accountLock'
import { backLayerPop } from '@/lib/backLayers'
import { LOCAL_CHAT_EVENT } from '@/lib/localChat'

// Icons (navIcons.tsx, Phosphor): outline when idle. `filled` (the phone
// bottom bar) shows the selected tab as the solid version in white on a
// brand-teal pill. The desktop sidebar keeps the outline icons on its
// brand-teal row.
type NavIconProps = { active: boolean; filled?: boolean }
const colorOf = (active: boolean, _filled?: boolean) =>
  active ? 'var(--nav-active-fg)' : 'var(--nav-idle)' // selected: white on the brand-teal pill / row
const navIcon = (name: NavIconName) => ({ active, filled }: NavIconProps) =>
  <NavIcon name={name} filled={active && !!filled} size={filled === undefined ? 22 : 24} color={colorOf(active, filled)} />

export const HomeIcon = navIcon('home')
export const ChatsIcon = navIcon('chat')
export const RewardsIcon = navIcon('rewards')
export const ActivityIcon = navIcon('activity')
export const BusinessIcon = ({ active, filled }: NavIconProps) =>
  <Store size={filled === undefined ? 22 : 24} strokeWidth={active ? 2.3 : 1.8} color={colorOf(active, filled)} />
// Option A (8 Nov): a scan-frame mark (four corners and a line) - reads as
// "scan" at a glance, lighter than the dense QR glyph it replaces.
const ScannerIcon = () => (
  <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M7 12h10" />
  </svg>
)

const tabs = [
  { id: 'home',     label: 'Home',     path: '/' },
  { id: 'chat',     label: 'Chats',    path: '/chat' },
  { id: 'scanner',  label: 'Scan',     path: '/scanner' },
  { id: 'rewards',  label: 'Rewards',  path: '/rewards' },
  { id: 'activity', label: 'Activity', path: '/activity' },
]
// Merchants: Business takes Rewards' place. Everyone else keeps Rewards.
const businessTabs = tabs.map(t => t.id === 'rewards' ? { id: 'business', label: 'Business', path: '/business' } : t)

// Same "which tab is active" expression BottomNav always used, just given a
// name so DesktopSidebar can share it exactly instead of hand-copying it.
export function getActiveTabId(pathname: string, tabList: { id: string; path: string }[]) {
  return tabList.find(t => {
    if (t.path === '/') return pathname === '/'
    return pathname.startsWith(t.path)
  })?.id ?? 'home'
}

export function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const { unreadChats, setUnreadChats } = useChatUnreadStore()
  const businessTab = useBusinessTab()
  // Business not approved yet: only Home, Business and Activity.
  const { locked } = useAccountLock()
  const tabList = (businessTab ? businessTabs : tabs).filter(t => !locked || !isLockedPath(t.path))

  useEffect(() => {
    if (!user?.id) return
    // Single count query across all of this user's conversations, instead of
    // one round-trip per conversation - faster resync, which matters because
    // it's now called on every relevant insert/update (see below).
    const fetchUnread = async () => {
      try {
        // Message requests (Chat privacy → "Contacts only") and people I
        // blocked arrive without an alert, so they don't count here either -
        // the Chats list leaves them out of All / Unread the same way.
        // (The server answers no requests unless "Contacts only" is on, so a
        // device that hasn't loaded the setting yet still gets it right.)
        const { fetchMyRequestIds, fetchBlocked } = await import('@/lib/privacy')
        const [requestIds, blocked] = await Promise.all([
          fetchMyRequestIds().catch(() => new Set<string>()),
          fetchBlocked(user.id).catch(() => []),
        ])
        const blockedIds = new Set(blocked.map(b => b.id))
        const { supabase } = await import('@/lib/supabase')
        const { data: convs } = await supabase
          .from('conversations').select('id, participant_a, participant_b')
          .or(`participant_a.eq.${user.id},participant_b.eq.${user.id}`)
        const convIds = (convs || [])
          .filter((c: any) => c.participant_a !== c.participant_b) // a chat with myself is never unread
          .filter((c: any) => !requestIds.has(c.id) && !blockedIds.has(c.participant_a === user.id ? c.participant_b : c.participant_a))
          .map((c: any) => c.id)
        if (!convIds.length) { setUnreadChats(0); return }
        // Device-only chat: unread chat messages are counted on this phone
        // (lib/localChat.ts); the server only for payment cards.
        const [{ count }, local] = await Promise.all([
          supabase.from('messages').select('*', { count: 'exact', head: true })
            .in('conversation_id', convIds).in('type', ['payment_sent', 'payment_received'])
            .eq('is_read', false).neq('sender_id', user.id),
          import('@/lib/localChat').then(l => l.summaries(user.id, [user.id])).catch(() => new Map()),
        ])
        let localUnread = 0
        for (const id of convIds) localUnread += local.get(id)?.unread ?? 0
        setUnreadChats((count || 0) + localUnread)
      } catch {}
    }
    fetchUnread()
    // BUG FIX: this used to open a bare `supabase.channel(...).subscribe()`
    // directly, with no reconnect logic of its own - unlike every other
    // realtime subscription in this app (ChatListPage, the open-thread
    // channel, P2P's list subscriptions), which all go through
    // subscribeWithRetry specifically because a dropped websocket
    // (backgrounded tab for a while, a brief network blip) otherwise just
    // dies silently with nothing to bring it back. Since this one lives in
    // BottomNav - mounted app-wide, for the whole session - a drop here
    // meant the unread badge could go stale indefinitely, on every screen,
    // until a full app reload. Routing through the same proven helper gives
    // it the same backoff-and-retry plus tab-visibility/network-regain
    // resync every other chat/P2P subscription already relies on.
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    Promise.all([import('@/lib/supabase'), import('@/lib/chatService')]).then(([{ supabase: sb }, { subscribeWithRetry }]) => {
      if (cancelled) return
      unsubscribe = subscribeWithRetry(sb, 'nav-unread-' + (user?.id?.slice(0, 12) || 'anon'), channel => channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload: any) => {
          // Chat text and receipts are counted once saved on this phone (LOCAL_CHAT_EVENT).
          const t = payload?.new?.type
          if (t !== 'payment_sent' && t !== 'payment_received') return
          import('@/lib/supabase').then(({ invalidateConversationsCache }) => invalidateConversationsCache())
          fetchUnread()
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => {
          import('@/lib/supabase').then(({ invalidateConversationsCache }) => invalidateConversationsCache())
          fetchUnread()
        }),
        { onReconnect: fetchUnread },
      )
    })
    window.addEventListener('meshport:session-bound', fetchUnread)
    // This phone's chat store changed (a message saved, or read).
    let localTimer: ReturnType<typeof setTimeout> | null = null
    const onLocal = () => { if (localTimer) clearTimeout(localTimer); localTimer = setTimeout(fetchUnread, 200) }
    window.addEventListener(LOCAL_CHAT_EVENT, onLocal)
    // Blocking, unblocking or accepting someone changes what counts.
    window.addEventListener('meshport:chat-count-changed', fetchUnread)
    return () => {
      cancelled = true; unsubscribe?.()
      window.removeEventListener('meshport:session-bound', fetchUnread)
      window.removeEventListener('meshport:chat-count-changed', fetchUnread)
      window.removeEventListener(LOCAL_CHAT_EVENT, onLocal)
      if (localTimer) clearTimeout(localTimer)
    }
  }, [user?.id, setUnreadChats])

  // Tab root paths - back button on any of these goes to Home (or exits if already Home)
  const TAB_ROOTS = ['/', '/chat', '/scanner', '/rewards', '/business', '/activity']

  useEffect(() => {
    const isTabRoot = TAB_ROOTS.includes(location.pathname)
    if (!isTabRoot) return

    // Push a dummy state so we can intercept the back press
    window.history.pushState({ meshportTab: true }, '')

    const handlePop = () => {
      // Back closed a screen or sheet open on this tab (Business): stay here.
      if (backLayerPop()) return
      if (location.pathname === '/') {
        // Already on Home - let browser handle (exit app)
        return
      }
      // On any other tab - go to Home with replace
      navigate('/', { replace: true })
      // Re-push dummy state so next back press is also intercepted
      window.history.pushState({ meshportTab: true }, '')
    }

    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [location.pathname])

  const activeTab = getActiveTabId(location.pathname, tabList)
  // The pill opens out only when the tab changes - not on the app's first draw.
  const firstTab = useRef(activeTab)
  const pillReveal = activeTab !== firstTab.current
  useEffect(() => { if (activeTab !== firstTab.current) firstTab.current = '' }, [activeTab])

  return (
    <div data-bottom-nav="" style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
      background: 'transparent',
      maxWidth: 680, margin: '0 auto',
      boxSizing: 'border-box',
    }}>
      {/* Standard bottom nav bar - flush to the screen edges/bottom */}
      <div data-frost="bg" className="mp-frost mp-frost-bottom" style={{
        // Frosted (index.css, "Frosted bars"): what scrolls behind it turns
        // into a soft blur of colour (Home's content runs under the bar).
        // Same page-colour glass as Home's header, so both bars match and
        // the bar runs seamlessly into the phone's gesture-bar strip below
        // it (drawn in the page colour) - a white tint left a visible band.
        ['--frost-tint' as string]: 'var(--bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-around',
        height: 65,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        position: 'relative',
        overflow: 'visible',
      }}>
        {tabList.map(tab => {
          const isActive = activeTab === tab.id
          const isScanner = tab.id === 'scanner'
          const isChat = tab.id === 'chat'
          const badgeCount = isChat ? unreadChats : 0

          return (
            <div key={tab.id}
              onClick={() => { if (tab.id === 'scanner' && activeTab !== 'scanner') prewarmCamera(); navigate(tab.path, { replace: true }) }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: 4, cursor: 'pointer', flex: 1,
              }}>
              {isScanner ? (
                /* Option A (8 Nov): a brand circle floating above the bar,
                   ringed in the page colour so it reads as cut out of the
                   bar (not outlined in grey), a soft brand shadow, and a
                   "Scan" label like the other tabs. */
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginTop: -26 }}>
                  <motion.div
                    whileTap={{ scale: 0.92 }}
                    aria-label="Scan"
                    style={{
                      width: 56, height: 56, borderRadius: '50%', boxSizing: 'border-box',
                      background: 'var(--brand)',
                      border: '4px solid var(--bg)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 6px 16px rgb(var(--brand-rgb) / 0.32)',
                      flexShrink: 0,
                    }}>
                    <ScannerIcon />
                  </motion.div>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--brand-text)',
                    lineHeight: 1, fontFamily: 'var(--font-sans)',
                  }}>
                    {tab.label}
                  </span>
                </div>
              ) : (
                <>
                  <div style={{
                    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 48, height: 32, borderRadius: 16,
                  }}>
                    {/* Selected tab: solid brand-teal pill. It doesn't travel
                        between tabs (Material 3 / WhatsApp): the old one goes at
                        once and the new one opens out from its centre
                        (index.css .mp-nav-pill-in) - same size and shape, only
                        revealed. Not on the first draw of the app. */}
                    {isActive && (
                      <div className={pillReveal ? 'mp-nav-pill-in' : undefined}
                        style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--brand)' }}
                      />
                    )}
                    <motion.div
                      animate={{ scale: isActive ? 1.04 : 1 }}
                      transition={CONTROL_MOTION}
                      style={{ position: 'relative', display: 'flex' }}
                    >
                      {tab.id === 'home'     && <HomeIcon active={isActive} filled />}
                      {tab.id === 'chat'     && <ChatsIcon active={isActive} filled />}
                      {tab.id === 'rewards'  && <RewardsIcon active={isActive} filled />}
                      {tab.id === 'business' && <BusinessIcon active={isActive} filled />}
                      {tab.id === 'activity' && <ActivityIcon active={isActive} filled />}
                    </motion.div>
                    {badgeCount > 0 && (
                      <motion.span
                        key={badgeCount}
                        initial={{ scale: 0.6 }}
                        animate={{ scale: 1 }}
                        transition={CONTROL_MOTION}
                        style={{
                          position: 'absolute', top: -4, right: -6,
                          minWidth: 16, height: 16, background: 'var(--danger)',
                          borderRadius: 8, fontSize: 11, fontWeight: 700,
                          color: '#fff', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', padding: '0 3px',
                        }}>
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </motion.span>
                    )}
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: isActive ? 700 : 500,
                    color: isActive ? 'var(--brand-text)' : 'var(--nav-idle)',
                    lineHeight: 1, fontFamily: 'var(--font-sans)',
                    transition: 'color 0.15s',
                  }}>
                    {tab.label}
                  </span>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
