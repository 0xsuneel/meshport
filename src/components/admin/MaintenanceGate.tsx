import { AlertTriangle } from 'lucide-react'
import { useMaintenanceMode } from '@/store/settingsStore'
import { useAdminStore } from '@/store/adminStore'

export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const { enabled, message } = useMaintenanceMode()
  // Same flag ModeToggle uses to decide whether to show the Admin/Normal
  // switch at all — true only after a real email+OTP admin login in this
  // browser (see AdminLoginPage / useAdminStore). Bypassing maintenance
  // for admins is what actually lets them explore and test the live app
  // while it's down for everyone else, instead of just seeing the same
  // "we'll be right back" screen as regular users.
  const isAdmin = useAdminStore(s => s.isAdminAuthenticated)
  if (!enabled || isAdmin) return <>{children}</>

  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--bg)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center',
    }}>
      <div>
        <div style={{
          width: 64, height: 64, borderRadius: 20, background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px',
        }}>
          <AlertTriangle size={30} color="var(--warning)" />
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text-primary)', margin: 0 }}>We'll be right back</h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 10, maxWidth: 320 }}>{message}</p>
      </div>
    </div>
  )
}
