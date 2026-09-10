// DesktopSidebar.tsx
// Persistent left nav shown only at desktop widths (see AppLayout's
// isDesktop branch) — reuses BottomNav's exact icon components and active-
// tab logic (getActiveTabId) rather than re-deriving them, so "which tab is
// highlighted" can never drift between the mobile and desktop nav. Does NOT
// import BottomNav's mobile-only concerns (unread realtime subscription,
// Android back-button interception) — those stay exactly where they are.
import { useLocation, useNavigate } from 'react-router-dom'
import { Settings, Users } from 'lucide-react'
import { HomeIcon, ChatsIcon, RewardsIcon, ActivityIcon, getActiveTabId } from './BottomNav'
import { useChatUnreadStore } from '@/store'

const items = [
  { id: 'home',             label: 'Home',                path: '/' },
  { id: 'pay-send',             label: 'Pay',                 path: '/pay-send' },
  { id: 'receive',          label: 'Receive',             path: '/receive' },
  { id: 'swap',             label: 'Swap',                path: '/swap' },
  { id: 'chat',             label: 'Chats',               path: '/chat' },
  { id: 'bulk-payout',      label: 'Bulk Pay',            path: '/bulk-payout' },
  { id: 'multichain-claim', label: 'Multichain Claim',    path: '/multichain-claim' },
  { id: 'multichain-transfer',  label: 'Multichain Transfer', path: '/multichain-transfer' },
  { id: 'p2p',              label: 'P2P',                 path: '/p2p' },
  { id: 'rewards',          label: 'Rewards',             path: '/rewards' },
  { id: 'activity',         label: 'Activity',            path: '/activity' },
  { id: 'settings',         label: 'Settings',            path: '/profile' },
]

// Icon shapes adapted from HomePage's MoreSheet (same actions, same glyphs)
// so the sidebar's icon language matches what mobile users already know —
// just re-colored per active state like BottomNav's own icons.
// Same glyphs as HomePage's own Pay/Receive quick-action icons.
function PayIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M7 17L17 7M17 7H9M17 7V15" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function ReceiveIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M17 7L7 17M7 17H15M7 17V9" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function SwapIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h13M4 7l3-3M4 7l3 3" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M20 17H7M20 17l-3 3M20 17l-3-3" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function BulkPayIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6" width="18" height="13" rx="2" stroke={c} strokeWidth="1.7"/>
      <path d="M3 10h18M7 14h2M11 14h2" stroke={c} strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}
// Plain two-person glyph (same lucide set already used for Settings above)
// — crisp at every size, unlike the previous raster-mask trace which
// needed real work to stop looking blurry at nav size.
function P2PIcon({ active }: { active: boolean }) {
  return <Users size={20} color={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth={1.8} />
}
function MultichainTransferIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.7"/>
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9s1.3-6.5 3.8-9z" stroke={c} strokeWidth="1.5"/>
    </svg>
  )
}
function MultichainClaimIcon({ active }: { active: boolean }) {
  const c = active ? 'var(--brand)' : 'var(--text-secondary)'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 4v11M12 15l-4-4M12 15l4-4" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke={c} strokeWidth="1.7" strokeLinecap="round"/>
    </svg>
  )
}

export function DesktopSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeId = getActiveTabId(location.pathname, items)
  const unreadChats = useChatUnreadStore(s => s.unreadChats)

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
          const showBadge = item.id === 'chat' && unreadChats > 0
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.path)}
              className={!active ? 'sidebar-nav-item' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', borderRadius: 11, cursor: 'pointer',
                border: 'none',
                background: active ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'var(--sb-hover-bg, transparent)',
                color: active ? 'var(--brand)' : 'var(--text-secondary)',
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
                {item.id === 'multichain-transfer'  && <MultichainTransferIcon active={active} />}
                {item.id === 'multichain-claim' && <MultichainClaimIcon active={active} />}
                {item.id === 'chat'             && <ChatsIcon active={active} />}
                {item.id === 'activity'         && <ActivityIcon active={active} />}
                {item.id === 'rewards'          && <RewardsIcon active={active} />}
                {item.id === 'settings'         && <Settings size={22} color={active ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth={1.8} />}
              </span>
              {item.label}
              {showBadge && (
                <span style={{
                  marginLeft: 'auto', minWidth: 18, height: 18, borderRadius: 9,
                  background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                }}>
                  {unreadChats > 99 ? '99+' : unreadChats}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
