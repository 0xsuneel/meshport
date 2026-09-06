import { useEffect, useState } from 'react'
import { LifeBuoy, X } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { useAdminStore } from '@/store/adminStore'
import {
  fetchAllSupportTickets, replyToSupportTicket, updateSupportTicketStatus,
  type AdminSupportTicket,
} from '@/lib/adminSupabase'

const TABS: Array<{ key: 'open' | 'in_progress' | 'resolved' | 'all'; label: string }> = [
  { key: 'open',        label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'resolved',    label: 'Resolved' },
  { key: 'all',         label: 'All' },
]

const STATUS_COLOR: Record<AdminSupportTicket['status'], string> = {
  open: 'var(--brand)', in_progress: 'var(--warning)', resolved: 'var(--success)', closed: 'var(--text-secondary)',
}

export function SupportTicketsPage() {
  const { adminEmail } = useAdminStore()
  const [tickets, setTickets] = useState<AdminSupportTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<typeof TABS[number]['key']>('open')
  const [active, setActive] = useState<AdminSupportTicket | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  const load = () => { setLoading(true); fetchAllSupportTickets().then(t => { setTickets(t); setLoading(false) }) }
  useEffect(() => { load() }, [])

  const filtered = tab === 'all' ? tickets : tickets.filter(t => t.status === tab)

  const openTicket = (t: AdminSupportTicket) => {
    setActive(t)
    setReply(t.adminReply || '')
  }

  const handleReply = async (status: 'in_progress' | 'resolved' | 'closed') => {
    if (!active) return
    if (!reply.trim()) return
    setSending(true)
    const res = await replyToSupportTicket({ ticketId: active.id, reply: reply.trim(), status, repliedBy: adminEmail || 'admin' })
    setSending(false)
    if (res.success) { setActive(null); load() }
  }

  if (loading) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading tickets…</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: tab === t.key ? 'var(--brand)' : 'var(--surface)',
              color: tab === t.key ? '#fff' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}>
            {t.label} {t.key !== 'all' && `(${tickets.filter(x => x.status === t.key).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <AdminCard>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 8 }}>
            <LifeBuoy size={28} color="var(--text-secondary)" />
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>No tickets here</p>
          </div>
        </AdminCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(t => (
            <AdminCard key={t.id} padding={14} onClick={() => openTicket(t)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t.subject}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[t.status] }}>{t.status.replace('_', ' ')}</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.message}
              </p>
              <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                {t.username ? `${t.username}` : t.email || t.walletAddress || 'Unknown user'} · {new Date(t.createdAt).toLocaleString()}
              </p>
            </AdminCard>
          ))}
        </div>
      )}

      {active && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
          onClick={() => setActive(null)}>
          <div style={{ width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto', background: 'var(--surface)', borderRadius: '24px 24px 0 0', border: '1px solid var(--border)', padding: 20 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{active.subject}</p>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  {active.username || active.email || active.walletAddress || 'Unknown user'}
                </p>
              </div>
              <button onClick={() => setActive(null)} style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: 'none', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={14} color="var(--text-secondary)" />
              </button>
            </div>

            <div style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 16, padding: 14, marginBottom: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{active.message}</p>
            </div>

            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Reply</p>
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Type your response…"
              rows={4}
              style={{ width: '100%', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)', borderRadius: 14, padding: 12, fontSize: 13, color: 'var(--text-primary)', outline: 'none', resize: 'none', marginBottom: 12 }}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => handleReply('resolved')} disabled={sending}
                style={{ flex: 1, padding: 12, borderRadius: 14, background: 'var(--success)', color: '#fff', fontSize: 13, fontWeight: 600, border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer', opacity: sending ? 0.6 : 1 }}>
                Reply & resolve
              </button>
              <button onClick={() => handleReply('in_progress')} disabled={sending}
                style={{ flex: 1, padding: 12, borderRadius: 14, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, border: '1px solid var(--border)', cursor: 'pointer', opacity: sending ? 0.6 : 1 }}>
                Reply & keep open
              </button>
            </div>
            {active.status !== 'closed' && (
              <button onClick={() => updateSupportTicketStatus(active.id, 'closed').then(() => { setActive(null); load() })}
                style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 14, background: 'none', color: 'var(--text-secondary)', fontSize: 12, border: 'none', cursor: 'pointer' }}>
                Close without replying
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
