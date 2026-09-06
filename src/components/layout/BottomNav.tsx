import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuthStore, useChatUnreadStore } from '@/store'

export const HomeIcon = ({ active }: { active: boolean }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    <path d="M3 10.5L12 3l9 7.5V21a1 1 0 01-1 1H4a1 1 0 01-1-1V10.5z"
      stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.8" strokeLinejoin="round"/>
    <path d="M9 22V15h6v7"
      stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.8" strokeLinejoin="round"/>
  </svg>
)

export const ChatsIcon = ({ active }: { active: boolean }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const ScannerIcon = () => (
  <svg width="27" height="27" viewBox="0 0 28 28" fill="none">
    <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="white" strokeWidth="1.8"/>
    <rect x="5.5" y="5.5" width="3" height="3" fill="white"/>
    <rect x="17" y="3" width="8" height="8" rx="1.5" stroke="white" strokeWidth="1.8"/>
    <rect x="19.5" y="5.5" width="3" height="3" fill="white"/>
    <rect x="3" y="17" width="8" height="8" rx="1.5" stroke="white" strokeWidth="1.8"/>
    <rect x="5.5" y="19.5" width="3" height="3" fill="white"/>
    <rect x="17" y="17" width="3" height="3" rx="0.5" fill="white"/>
    <rect x="22" y="17" width="3" height="3" rx="0.5" fill="white"/>
    <rect x="17" y="22" width="3" height="3" rx="0.5" fill="white"/>
    <rect x="22" y="22" width="3" height="3" rx="0.5" fill="white"/>
  </svg>
)

export const RewardsIcon = ({ active }: { active: boolean }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    {/* box body */}
    <rect x="3" y="12" width="18" height="9" rx="1.5" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.6"/>
    {/* vertical ribbon on box */}
    <line x1="12" y1="12" x2="12" y2="21" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.6"/>
    {/* lid */}
    <rect x="2" y="8.5" width="20" height="3.5" rx="1" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.6"/>
    {/* vertical ribbon on lid */}
    <line x1="12" y1="8.5" x2="12" y2="12" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.6"/>
    {/* bow left */}
    <path d="M12 8.5 C10.5 7 8 5.5 7.5 4.5 C7 3.5 9 3.5 10 4.5 C11 5.5 12 8.5 12 8.5Z"
      stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.4" strokeLinejoin="round"/>
    {/* bow right */}
    <path d="M12 8.5 C13.5 7 16 5.5 16.5 4.5 C17 3.5 15 3.5 14 4.5 C13 5.5 12 8.5 12 8.5Z"
      stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.4" strokeLinejoin="round"/>
    {/* bow knot */}
    <circle cx="12" cy="8.5" r="1" fill={active ? 'var(--brand)' : 'var(--text-secondary)'}/>
  </svg>
)

export const ActivityIcon = ({ active }: { active: boolean }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.7"/>
    <path d="M12 7v5l3 3" stroke={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

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
    // one round-trip per conversation — faster resync, which matters because
    // it's now called on every relevant insert/update (see below).
    const fetchUnread = async () => {
      try {
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
    // directly, with no reconnect logic of its own — unlike every other
    // realtime subscription in this app (ChatListPage, the open-thread
    // channel, P2P's list subscriptions), which all go through
    // subscribeWithRetry specifically because a dropped websocket
    // (backgrounded tab for a while, a brief network blip) otherwise just
    // dies silently with nothing to bring it back. Since this one lives in
    // BottomNav — mounted app-wide, for the whole session — a drop here
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
    return () => { cancelled = true; unsubscribe?.() }
  }, [user?.id])

  // Tab root paths — back button on any of these goes to Home (or exits if already Home)
  const TAB_ROOTS = ['/', '/chat', '/scanner', '/rewards', '/activity']

  useEffect(() => {
    const isTabRoot = TAB_ROOTS.includes(location.pathname)
    if (!isTabRoot) return

    // Push a dummy state so we can intercept the back press
    window.history.pushState({ meshportTab: true }, '')

    const handlePop = () => {
      if (location.pathname === '/') {
        // Already on Home — let browser handle (exit app)
        return
      }
      // On any other tab — go to Home with replace
      navigate('/', { replace: true })
      // Re-push dummy state so next back press is also intercepted
      window.history.pushState({ meshportTab: true }, '')
    }

    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [location.pathname])

  const activeTab = getActiveTabId(location.pathname, tabs)

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
      background: 'transparent',
      maxWidth: 680, margin: '0 auto',
      boxSizing: 'border-box',
    }}>
      {/* Standard bottom nav bar — flush to the screen edges/bottom */}
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
              onClick={() => navigate(tab.path, { replace: true })}
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
                    width: 36, height: 36, borderRadius: 14,
                  }}>
                    {isActive && (
                      <motion.div
                        layoutId="bottom-nav-active"
                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                        style={{
                          position: 'absolute', inset: 0, borderRadius: 14,
                          background: 'color-mix(in srgb, var(--brand) 14%, transparent)',
                        }}
                      />
                    )}
                    <motion.div
                      animate={{ scale: isActive ? 1.08 : 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                      style={{ position: 'relative', display: 'flex' }}
                    >
                      {tab.id === 'home'     && <HomeIcon active={isActive} />}
                      {tab.id === 'chat'     && <ChatsIcon active={isActive} />}
                      {tab.id === 'rewards'  && <RewardsIcon active={isActive} />}
                      {tab.id === 'activity' && <ActivityIcon active={isActive} />}
                    </motion.div>
                    {badgeCount > 0 && (
                      <motion.span
                        key={badgeCount}
                        initial={{ scale: 0.6 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 15 }}
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
                    color: isActive ? 'var(--brand)' : 'var(--text-secondary)',
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
