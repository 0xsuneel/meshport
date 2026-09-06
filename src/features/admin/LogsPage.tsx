import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { fetchSettingsLogs, type SettingsLog } from '@/lib/adminSupabase'

export function LogsPage() {
  const [logs, setLogs] = useState<SettingsLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchSettingsLogs().then((l) => { setLogs(l); setLoading(false) }) }, [])

  if (loading) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading logs…</p>

  if (logs.length === 0) {
    return (
      <AdminCard>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 8 }}>
          <ScrollText size={28} color="var(--text-secondary)" />
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>No changes logged yet</p>
        </div>
      </AdminCard>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {logs.map((log) => (
        <AdminCard key={log.id} padding={14}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{prettify(log.feature)}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{new Date(log.created_at).toLocaleString()}</span>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
            {log.old_value} → <span style={{ color: log.new_value === 'true' ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{log.new_value}</span>
            {log.changed_by ? ` · by ${log.changed_by}` : ''}
          </p>
        </AdminCard>
      ))}
    </div>
  )
}

function prettify(feature: string) {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
