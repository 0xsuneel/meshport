// Admin Panel → Logs: every admin trail in one list, newest first -
// admin console actions (admin_audit_log), feature/setting changes
// (settings_logs), Stuck Funds recovery actions (admin_recovery_log) and
// admin moves on P2P trades (p2p_trade_audit_log). Read through admin-api;
// until that is deployed the page shows setting changes as before.
import { useCallback, useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { Pill, Chips, Notice, mono } from '@/components/admin/AdminUi'
import { fetchSettingsLogs } from '@/lib/adminSupabase'
import { adminLogs, type LogItem, type LogSource } from '@/lib/adminApi'

const SOURCES: { key: LogSource | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'admin', label: 'Admin actions' },
  { key: 'settings', label: 'Settings' },
  { key: 'recovery', label: 'Recovery' },
  { key: 'p2p', label: 'P2P' },
]
const SOURCE_TONE: Record<LogSource, string> = {
  admin: 'var(--brand-text)', settings: 'var(--text-secondary)', recovery: 'var(--warning-text)', p2p: '#6C8CFF',
}

function prettify(s: string) {
  return s.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
const show = (v: unknown) => (v == null ? '-' : typeof v === 'string' ? v : JSON.stringify(v))

export function LogsPage() {
  const [source, setSource] = useState<LogSource | 'all'>('all')
  const [items, setItems] = useState<LogItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fallback, setFallback] = useState('')

  const load = useCallback(async (before: string | null = null) => {
    setLoading(true)
    try {
      const res = await adminLogs(source, before)
      setItems(prev => (before ? [...prev, ...res.items] : res.items))
      setNext(res.next)
      setFallback('')
    } catch (e) {
      // admin-api not live yet: the settings trail, read directly as before.
      const logs = await fetchSettingsLogs(100)
      setItems(logs.map(l => ({ at: l.created_at, source: 'settings' as const, who: l.changed_by, action: `setting ${l.feature}`, target: l.feature, before: l.old_value, after: l.new_value })))
      setNext(null)
      setFallback(e instanceof Error ? e.message : 'Admin logs unavailable')
    }
    setLoading(false)
  }, [source])

  useEffect(() => { void load() }, [load])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Chips items={SOURCES} value={source} onChange={setSource} />
      {fallback && <Notice>Showing setting changes only - {fallback}</Notice>}

      {!loading && items.length === 0 && (
        <AdminCard>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 8 }}>
            <ScrollText size={28} color="var(--text-secondary)" />
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>Nothing logged yet</p>
          </div>
        </AdminCard>
      )}

      {items.map((l, i) => (
        <AdminCard key={`${l.source}-${l.at}-${i}`} padding={14}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill color={SOURCE_TONE[l.source]}>{SOURCES.find(s => s.key === l.source)?.label ?? l.source}</Pill>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{prettify(l.action)}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{new Date(l.at).toLocaleString()}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {l.who && <span>by {l.who}{l.role ? ` (${l.role})` : ''}</span>}
            {l.target && <span>{l.who ? ' · ' : ''}<span style={mono}>{l.target}</span></span>}
          </div>
          {(l.before !== undefined || l.after !== undefined) && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
              {l.before !== undefined && <>{show(l.before)} → </>}
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{show(l.after)}</span>
            </div>
          )}
          {l.reason && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-primary)' }}>Reason: {l.reason}</div>}
        </AdminCard>
      ))}

      {next && (
        <button onClick={() => void load(next)} disabled={loading}
          style={{ alignSelf: 'center', padding: '9px 18px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
