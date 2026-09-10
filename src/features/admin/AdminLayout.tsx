import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { AdminHeader } from '@/components/admin/AdminHeader'
import { ModeToggle } from '@/components/admin/ModeToggle'
import { useAdminStore } from '@/store/adminStore'
import { ADMIN_PATH } from '@/lib/adminPath'
import { adminSignOut } from '@/lib/adminSupabase'

const titles: Record<string, string> = {
  [`${ADMIN_PATH}/dashboard`]:   'Dashboard',
  [`${ADMIN_PATH}/features`]:    'Features',
  [`${ADMIN_PATH}/coins`]:       'Coins',
  [`${ADMIN_PATH}/chains`]:      'Chains',
  [`${ADMIN_PATH}/treasury`]:    'Treasury',
  [`${ADMIN_PATH}/analytics`]:   'Analytics',
  [`${ADMIN_PATH}/notifications`]: 'Notifications',
  [`${ADMIN_PATH}/maintenance`]: 'Maintenance',
  [`${ADMIN_PATH}/logs`]:        'Logs',
  [`${ADMIN_PATH}/support`]:     'Support Tickets',
  [`${ADMIN_PATH}/settings`]:    'Settings',
}

export function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { adminEmail, clearAdminSession } = useAdminStore()

  const title = titles[location.pathname] || 'Admin'

  const handleLogout = async () => {
    await adminSignOut()
    clearAdminSession()
    navigate(`${ADMIN_PATH}/login`, { replace: true })
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)' }}>
      <AdminSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="admin-content" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <AdminHeader
          title={title}
          onMenuClick={() => setSidebarOpen(true)}
          adminEmail={adminEmail}
          onLogout={handleLogout}
        />
        <main className="admin-main" style={{ flex: 1, width: '100%', boxSizing: 'border-box' }}>
          <Outlet />
        </main>
      </div>

      <ModeToggle />

      <style>{`
        .admin-main { padding: 16px 16px 40px; max-width: 720px; margin: 0 auto; }
        @media (min-width: 980px) {
          .admin-content { margin-left: 260px; }
          .admin-main { max-width: 1280px; padding: 28px 32px 40px; }
          /* Sidebar is already always open at this width (see
             AdminSidebar.tsx's own 1024px rule) — the hamburger that opens
             it on mobile would just be a redundant, decorative button here. */
          .admin-hamburger { display: none; }
        }
      `}</style>
    </div>
  )
}
