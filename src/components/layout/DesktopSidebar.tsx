// DesktopSidebar.tsx
// Persistent left nav shown only at desktop widths (see AppLayout's
// isDesktop branch) - reuses BottomNav's exact icon components and active-
// tab logic (getActiveTabId) rather than re-deriving them, so "which tab is
// highlighted" can never drift between the mobile and desktop nav. Does NOT
// import BottomNav's mobile-only concerns (unread realtime subscription,
// Android back-button interception) - those stay exactly where they are.
import { useLocation, useNavigate } from 'react-router-dom'
import { NavIcon, type NavIconName } from './navIcons'
import { ActionIcon, type ActionIconName } from '@/components/ui/ActionIcon'
import { HomeIcon, ChatsIcon, RewardsIcon, ActivityIcon, getActiveTabId } from './BottomNav'
import { useChatUnreadStore, useP2PTradesCountStore } from '@/store'
import { useHubLabel } from '@/lib/merchant'

const items = [
  { id: 'home',             label: 'Home',                path: '/' },
  { id: 'pay-send',             label: 'Pay',                 path: '/pay' },
  { id: 'receive',          label: 'Receive',             path: '/receive' },
  { id: 'swap',             label: 'Swap',                path: '/swap' },
  { id: 'chat',             label: 'Chats',               path: '/chat' },
  { id: 'bulk-payout',      label: 'Bulk Pay',            path: '/bulk-payout' },
  { id: 'multichain',       label: 'Multichain Hub',      path: '/multichain' },
  { id: 'p2p',              label: 'P2P',                 path: '/p2p' },
  { id: 'rewards',          label: 'Rewards',             path: '/rewards' },
  { id: 'activity',         label: 'Activity',            path: '/activity' },
  { id: 'settings',         label: 'Settings',            path: '/profile' },
]

// Home, Chats, Rewards, Activity, Settings: same outline icons as the phone bar (navIcons.tsx).
const sideIcon = (name: NavIconName) => ({ active }: { active: boolean }) =>
  <NavIcon name={name} size={22} color={active ? 'var(--nav-active-fg)' : 'var(--nav-idle)'} />
// Money/feature rows: the same icons as Home's buttons and the More sheet.
const actIcon = (name: ActionIconName) => ({ active }: { active: boolean }) =>
  <ActionIcon name={name} size={22} color={active ? 'var(--nav-active-fg)' : 'var(--nav-idle)'} />
const PayIcon = actIcon('pay')
const ReceiveIcon = actIcon('receive')
const SwapIcon = actIcon('swap')
const BulkPayIcon = actIcon('bulk')
const P2PIcon = actIcon('p2p')
const MultichainHubIcon = actIcon('hub')
const SettingsIcon = sideIcon('settings')
export function DesktopSidebar() {
  const hub = useHubLabel()
  const location = useLocation()
  const navigate = useNavigate()
  const activeId = getActiveTabId(location.pathname, items)
  const unreadChats = useChatUnreadStore(s => s.unreadChats)

  // Ongoing P2P trades count - the red dot on the P2P nav item.
  // BUG FIX (2026-09-22): this used to be its own independent fetch+
  // subscribe effect (duplicated in HomePage and P2PPage too) - THIS was
  // the component whose simultaneous mount with whichever page is active
  // caused the crash: subscribeToMyTrades's channel names are fixed per
  // userId, not unique per caller, so DesktopSidebar (always mounted) and
  // HomePage/P2PPage (also mounted, whichever is active) both tried to
  // subscribe to the identical channel name at the same time. See
  // useP2PTradesCountStore's own comment in store/index.ts for the full
  // writeup. Now just reads the shared store; AppLayout.tsx is the only
  // place that actually fetches/subscribes.
  const ongoingP2PCount = useP2PTradesCountStore(s => s.ongoingCount)

  return (
    <aside style={{
      width: 240, flexShrink: 0, height: '100%',
      background: 'var(--surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      padding: '20px 14px', overflowY: 'auto',
    }}>
      <div
        onClick={() => navigate('/')}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 20px',
          marginBottom: 16, cursor: 'pointer',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <img src="/favicon.svg" alt="MeshPort" style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          boxShadow: 'var(--shadow-1)', objectFit: 'cover',
        }} />
        <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>MeshPort</span>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map(item => {
          const active = activeId === item.id
          const showChatBadge = item.id === 'chat' && unreadChats > 0
          const showP2PBadge = item.id === 'p2p' && ongoingP2PCount > 0
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.path)}
              className={!active ? 'sidebar-nav-item' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', borderRadius: 11, cursor: 'pointer',
                border: 'none',
                background: active ? 'var(--nav-active-bg)' : 'var(--sb-hover-bg, transparent)',
                color: active ? 'var(--nav-active-fg)' : 'var(--nav-idle)',
                fontSize: 14, fontWeight: active ? 700 : 500,
                textAlign: 'left', width: '100%', position: 'relative',
                transition: 'background-color 150ms ease, color 150ms ease',
              }}
            >
              <span style={{ display: 'flex', flexShrink: 0 }}>
                {item.id === 'home'             && <HomeIcon active={active} />}
                {item.id === 'pay-send'             && <PayIcon active={active} />}
                {item.id === 'receive'          && <ReceiveIcon active={active} />}
                {item.id === 'swap'             && <SwapIcon active={active} />}
                {item.id === 'bulk-payout'      && <BulkPayIcon active={active} />}
                {item.id === 'p2p'              && <P2PIcon active={active} />}
                {item.id === 'multichain'       && <MultichainHubIcon active={active} />}
                {item.id === 'chat'             && <ChatsIcon active={active} />}
                {item.id === 'activity'         && <ActivityIcon active={active} />}
                {item.id === 'rewards'          && <RewardsIcon active={active} />}
                {item.id === 'settings'         && <SettingsIcon active={active} />}
              </span>
              {hub(item.label)}
              {showChatBadge && (
                <span style={{
                  marginLeft: 'auto', minWidth: 18, height: 18, borderRadius: 9,
                  background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                }}>
                  {unreadChats > 99 ? '99+' : unreadChats}
                </span>
              )}
              {showP2PBadge && (
                <span style={{
                  marginLeft: 'auto', minWidth: 18, height: 18, borderRadius: 9,
                  background: '#EF4444', color: '#fff', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                }}>
                  {ongoingP2PCount > 99 ? '99+' : ongoingP2PCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
