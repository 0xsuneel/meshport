import type { LucideIcon } from 'lucide-react'
import { AdminCard } from './AdminCard'

interface StatCardProps {
  label: string
  value: string | number
  icon?: LucideIcon
  accent?: string
  hint?: string
}

export function StatCard({ label, value, icon: Icon, accent = 'var(--brand)', hint }: StatCardProps) {
  return (
    <AdminCard style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.2 }}>{label}</span>
        {Icon && (
          <div style={{
            width: 30, height: 30, borderRadius: 10, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in srgb, ${accent} 13%, transparent)`,
          }}>
            <Icon size={16} color={accent} />
          </div>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, wordBreak: 'break-word' }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>{hint}</div>}
    </AdminCard>
  )
}
