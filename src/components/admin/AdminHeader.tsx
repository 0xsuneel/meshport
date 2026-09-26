import { Menu, LogOut } from 'lucide-react'

interface AdminHeaderProps {
  title: string
  onMenuClick: () => void
  adminEmail?: string | null
  onLogout: () => void
}

export function AdminHeader({ title, onMenuClick, adminEmail, onLogout }: AdminHeaderProps) {
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px',
        background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <button
          onClick={onMenuClick}
          className="admin-hamburger"
          style={{
            width: 36, height: 36, borderRadius: 12, border: '1px solid var(--border)',
            background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
          aria-label="Open menu"
        >
          <Menu size={18} color="var(--text-primary)" />
        </button>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text-primary)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </h1>
      </div>

      <button
        onClick={onLogout}
        title={adminEmail ?? 'Logout'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
          borderRadius: 12, padding: '8px 10px', flexShrink: 0,
        }}
      >
        <LogOut size={15} color="var(--danger)" />
      </button>
    </header>
  )
}
