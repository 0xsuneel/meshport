import { useEffect } from 'react'
import { prewarmCamera } from '@/lib/scannerPrewarm'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuthStore, useChatUnreadStore } from '@/store'
import { NavIcon, type NavIconName } from './navIcons'

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
const ScannerIcon = () => <NavIcon name="scan" size={28} color="#fff" />

const tabs = [
  { id: 'home',     label: 'Home',     path: '/' },
  { id: 'chat',     label: 'Chats',    path: '/chat' },
  { id: 'scanner',  label: '',         path: '/scanner' },
  { id: 'rewards',  label: 'Rewards',  path: '/rewards' },
  { id: 'activity', label: 'Activity', path: '/activity' },
]

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

  useEffect(() => {
    if (!user?.id) return
    // Single count query across all of this user's conversations, instead of
    // one round-trip per conversation - faster resync, which matters because
    // it's now called on every relevant insert/update (see below).
    const fetchUnread = async () => {
      try {
        // App start: the count comes from the one startup call (lib/homeBootstrap.ts).
        const { bootPart } = await import('@/lib/homeBootstrap')
        const bootCount = await bootPart('unread_chats', 'bottomnav', { userId: user.id })
        if (typeof bootCount === 'number') { setUnreadChats(bootCount); return }
        const { supabase } = await import('@/lib/supabase')
        const { data: convs } = await supabase
          .from('conversations').select('id')
          .or(`participant_a.eq.${user.id},participant_b.eq.${user.id}`)
        const convIds = (convs || []).map((c: any) => c.id)
        if (!convIds.length) { setUnreadChats(0); return }
        const { count } = await supabase
          .from('messages').select('*', { count: 'exact', head: true })
          .in('conversation_id', convIds).eq('is_read', false).neq('sender_id', user.id)
        setUnreadChats(count || 0)
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
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
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
    return () => { cancelled = true; unsubscribe?.(); window.removeEventListener('meshport:session-bound', fetchUnread) }
  }, [user?.id])

  // Tab root paths - back button on any of these goes to Home (or exits if already Home)
  const TAB_ROOTS = ['/', '/chat', '/scanner', '/rewards', '/activity']

  useEffect(() => {
    const isTabRoot = TAB_ROOTS.includes(location.pathname)
    if (!isTabRoot) return

    // Push a dummy state so we can intercept the back press
    window.history.pushState({ meshportTab: true }, '')

    const handlePop = () => {
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
  }, [location.pathname])

  const activeTab = getActiveTabId(location.pathname, tabs)

  return (
    <div data-bottom-nav="" style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
      background: 'transparent',
      maxWidth: 680, margin: '0 auto',
      boxSizing: 'border-box',
    }}>
      {/* Standard bottom nav bar - flush to the screen edges/bottom */}
      <div style={{
        background: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-around',
        height: 65,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        position: 'relative',
        overflow: 'visible',
      }}>
        {tabs.map(tab => {
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
                /* Brand-color circle floating above the pill */
                <motion.div
                  whileTap={{ scale: 0.92 }}
                  style={{
                    width: 58, height: 58, borderRadius: '50%',
                    background: 'var(--brand)',
                    border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginTop: -28,
                    boxShadow: 'var(--shadow-2)',
                    flexShrink: 0,
                  }}>
                  <ScannerIcon />
                </motion.div>
              ) : (
                <>
                  <div style={{
                    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 48, height: 32, borderRadius: 16,
                  }}>
                    {/* Selected tab: solid brand-teal pill, slides between tabs */}
                    {isActive && (
                      <motion.div
                        layoutId="bottom-nav-pill"
                        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                        style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--brand)' }}
                      />
                    )}
                    <motion.div
                      animate={{ scale: isActive ? 1.04 : 1 }}
                      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                      style={{ position: 'relative', display: 'flex' }}
                    >
                      {tab.id === 'home'     && <HomeIcon active={isActive} filled />}
                      {tab.id === 'chat'     && <ChatsIcon active={isActive} filled />}
                      {tab.id === 'rewards'  && <RewardsIcon active={isActive} filled />}
                      {tab.id === 'activity' && <ActivityIcon active={isActive} filled />}
                    </motion.div>
                    {badgeCount > 0 && (
                      <motion.span
                        key={badgeCount}
                        initial={{ scale: 0.6 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
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
                    lineHeight: 1, fontFamily: '-apple-system,sans-serif',
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
