import { AdminToggle } from './AdminToggle'

interface SettingsCardProps {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  badge?: string
}

export function SettingsCard({ label, description, checked, onChange, disabled, badge }: SettingsCardProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
          {badge && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: checked ? 'var(--success)' : 'var(--text-secondary)',
              background: checked ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--text-secondary) 12%, transparent)',
              padding: '2px 8px', borderRadius: 999,
            }}>
              {badge}
            </span>
          )}
        </div>
        {description && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>{description}</p>
        )}
      </div>
      <AdminToggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}
