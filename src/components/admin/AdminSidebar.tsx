import { NavLink } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { SHEET_BACKDROP, SHEET_DIM, PUSH_OPEN_MS, PUSH_BACK_MS, PUSH_EASE_CSS, DESKTOP_QUERY } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useBackLayer } from '@/lib/backLayers'
import { ADMIN_PATH } from '@/lib/adminPath'
import {
  LayoutDashboard, ToggleLeft, Coins, Link2, Landmark,
  BarChart3, AlertTriangle, ScrollText, Settings, Bell, X, LifeBuoy, Handshake, Wrench,
  Store, Newspaper, ReceiptText, ArrowLeftRight, Activity, Users,
} from 'lucide-react'
import { useAdminStore } from '@/store/adminStore'

const navItems = [
  { to: `${ADMIN_PATH}/dashboard`,    label: 'Dashboard',    icon: LayoutDashboard },
  { to: `${ADMIN_PATH}/transactions`, label: 'Transactions', icon: ArrowLeftRight },
  { to: `${ADMIN_PATH}/features`,     label: 'Features',     icon: ToggleLeft },
  { to: `${ADMIN_PATH}/coins`,        label: 'Coins',         icon: Coins },
  { to: `${ADMIN_PATH}/chains`,       label: 'Chains',        icon: Link2 },
  // BUG FIX: P2P Admin (P2PAdminPage.tsx, route `${ADMIN_PATH}/p2p`) has existed
  // in the router since this admin panel was built, but was never added to
  // this nav list - it was only reachable by typing the URL directly. It's
  // the console for freezing/cancelling trades, resolving buyer/seller
  // disputes, and banning marketplace users, so it belongs alongside the
  // other moderation pages.
  { to: `${ADMIN_PATH}/p2p`,          label: 'P2P Trades',    icon: Handshake },
  { to: `${ADMIN_PATH}/treasury`,     label: 'Treasury',      icon: Landmark },
  { to: `${ADMIN_PATH}/analytics`,    label: 'Analytics',     icon: BarChart3 },
  { to: `${ADMIN_PATH}/notifications`, label: 'Notifications', icon: Bell },
  { to: `${ADMIN_PATH}/news`,         label: 'Updates',        icon: Newspaper },
  { to: `${ADMIN_PATH}/maintenance`,  label: 'Maintenance',   icon: AlertTriangle },
  { to: `${ADMIN_PATH}/system`,       label: 'System',         icon: Activity },
  { to: `${ADMIN_PATH}/logs`,         label: 'Logs',           icon: ScrollText },
  { to: `${ADMIN_PATH}/stuck-funds`,  label: 'Stuck Funds',    icon: Wrench },
  { to: `${ADMIN_PATH}/merchants`,    label: 'Businesses',      icon: Store },
  { to: `${ADMIN_PATH}/orders`,       label: 'Orders',         icon: ReceiptText },
  { to: `${ADMIN_PATH}/support`,      label: 'Support Tickets', icon: LifeBuoy },
  { to: `${ADMIN_PATH}/admins`,       label: 'Admins',        icon: Users, ownerOnly: true },
  { to: `${ADMIN_PATH}/settings`,     label: 'Settings',      icon: Settings },
]

interface AdminSidebarProps {
  open: boolean
  onClose: () => void
}

export function AdminSidebar({ open, onClose }: AdminSidebarProps) {
  // Phone / browser Back closes the drawer (it's always shown on desktop).
  const desktop = useMediaQuery(DESKTOP_QUERY)
  useBackLayer(open && !desktop, onClose)
  const role = useAdminStore(s => s.adminRole)
  const items = navItems.filter(i => !('ownerOnly' in i && i.ownerOnly) || role === 'owner')
  return (
    <>
      {/* Overlay - mobile only. The sheet dim and its fade, in and out. */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="admin-sidebar-dim"
            {...SHEET_BACKDROP}
            onClick={onClose}
            style={{
              position: 'fixed', inset: 0, background: SHEET_DIM, zIndex: 40, willChange: 'opacity',
            }}
            className="admin-sidebar-overlay"
          />
        )}
      </AnimatePresence>

      <aside
        style={{
          position: 'fixed',
          top: 0, bottom: 0, left: 0,
          width: 260,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          // The app's push timing: opens on PUSH_OPEN_MS, closes on PUSH_BACK_MS.
          transition: `transform ${open ? PUSH_OPEN_MS : PUSH_BACK_MS}ms ${PUSH_EASE_CSS}`,
          display: 'flex',
          flexDirection: 'column',
          padding: 16,
        }}
        className="admin-sidebar"
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10, background: 'var(--brand)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#fff',
            }}>A</div>
            <div>
              <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: 15, lineHeight: 1.1 }}>MeshPort</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Admin Control Panel</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="admin-sidebar-close"
            style={{ width: 30, height: 30, borderRadius: 8, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={16} color="var(--text-secondary)" />
          </button>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', overflowX: 'hidden' }}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', borderRadius: 14,
                color: isActive ? '#fff' : 'var(--text-secondary)',
                background: isActive ? 'var(--brand)' : 'transparent',
                fontWeight: isActive ? 700 : 500,
                fontSize: 14,
                textDecoration: 'none',
                transition: 'background 0.15s, color 0.15s',
              })}
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <style>{`
        @media (min-width: 980px) {
          .admin-sidebar { transform: translateX(0) !important; }
          .admin-sidebar-overlay { display: none !important; }
          .admin-sidebar-close { display: none !important; }
        }
      `}</style>
    </>
  )
}
