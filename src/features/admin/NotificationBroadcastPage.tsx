import { useEffect, useState } from 'react'
import { Send, Bell, Users, CheckCircle, XCircle } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { supabase } from '@/lib/supabase'

interface BroadcastRecord {
  id: string
  title: string
  body: string
  sent_count: number
  failed_count: number
  created_by: string | null
  created_at: string
}

export function NotificationBroadcastPage() {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<BroadcastRecord[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)

  const loadHistory = async () => {
    setLoadingHistory(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { setLoadingHistory(false); return }
    try {
      const r = await fetch('/api/push?action=broadcast', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await r.json()
      setHistory(json?.data || [])
    } catch {}
    setLoadingHistory(false)
  }

  useEffect(() => { loadHistory() }, [])

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) { setError('Enter both a subject and a message'); return }
    setSending(true); setError(null); setResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Your admin session expired — sign in again.'); setSending(false); return }

      const r = await fetch('/api/push?action=broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      })
      const json = await r.json()
      if (!r.ok) { setError(json?.error || 'Failed to send'); setSending(false); return }

      setResult({ sent: json.sent, failed: json.failed })
      setTitle(''); setBody('')
      loadHistory()
    } catch (e: any) {
      setError(e?.message || 'Failed to send')
    }
    setSending(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12, background: 'color-mix(in srgb, var(--brand) 15%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bell size={18} color="var(--brand)" />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>MeshPort Notification</p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>Sends a push notification to every user instantly</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Subject</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. New feature: Bulk Pay is live!"
              maxLength={80}
              style={{
                width: '100%', marginTop: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
                borderRadius: 14, padding: '12px 14px', color: 'var(--text-primary)', fontSize: 14,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What's new, what changed, or what users should know."
              rows={3}
              maxLength={200}
              style={{
                width: '100%', marginTop: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
                borderRadius: 14, padding: '12px 14px', color: 'var(--text-primary)', fontSize: 14, resize: 'vertical', fontFamily: 'inherit',
              }}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', textAlign: 'right' }}>{body.length}/200</p>
          </div>

          {error && (
            <div style={{
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
              borderRadius: 12, padding: '10px 12px', color: 'var(--danger)', fontSize: 13,
            }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{
              background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
              borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <CheckCircle size={15} color="var(--success)" />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--success)' }}>
                Sent to {result.sent} device{result.sent === 1 ? '' : 's'}
                {result.failed > 0 ? ` · ${result.failed} failed` : ''}
              </p>
            </div>
          )}

          <button
            onClick={handleSend}
            disabled={sending || !title.trim() || !body.trim()}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: 14, borderRadius: 20, border: 'none', background: 'var(--brand)',
              color: '#fff', fontWeight: 700, fontSize: 14,
              opacity: (sending || !title.trim() || !body.trim()) ? 0.5 : 1,
            }}
          >
            <Send size={16} /> {sending ? 'Sending…' : 'Send to All Users'}
          </button>
        </div>
      </AdminCard>

      <div>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 10px 4px' }}>
          Recent Broadcasts
        </p>
        {loadingHistory ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        ) : history.length === 0 ? (
          <AdminCard>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0', gap: 8 }}>
              <Users size={26} color="var(--text-secondary)" />
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>No broadcasts sent yet</p>
            </div>
          </AdminCard>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.map((h) => (
              <AdminCard key={h.id} padding={14}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{h.title}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>{h.body}</p>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {new Date(h.created_at).toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--success)' }}>
                    <CheckCircle size={13} /> {h.sent_count} sent
                  </span>
                  {h.failed_count > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--danger)' }}>
                      <XCircle size={13} /> {h.failed_count} failed
                    </span>
                  )}
                  {h.created_by && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>by {h.created_by}</span>}
                </div>
              </AdminCard>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
