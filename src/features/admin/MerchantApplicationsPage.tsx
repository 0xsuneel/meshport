// Admin → Merchants. Review merchant applications: approve, reject (with a
// reason the user sees), or revoke an approved merchant. Applicant identity
// (user, wallet, username) is filled by the database and can't be edited.
import { useEffect, useState } from 'react'
import { Store, X } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { useAdminStore } from '@/store/adminStore'
import { adminListMerchantApplications, adminReviewMerchant, type MerchantApplication } from '@/lib/merchant'

const TABS: Array<{ key: 'pending' | 'approved' | 'rejected' | 'all'; label: string }> = [
  { key: 'pending',  label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all',      label: 'All' },
]

const STATUS_COLOR: Record<MerchantApplication['status'], string> = {
  pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)', revoked: 'var(--text-secondary)',
}

export function MerchantApplicationsPage() {
  const { adminEmail } = useAdminStore()
  const [apps, setApps] = useState<MerchantApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<typeof TABS[number]['key']>('pending')
  const [active, setActive] = useState<MerchantApplication | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoading(true)
    adminListMerchantApplications()
      .then(a => { setApps(a); setError(null) })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const inTab = (a: MerchantApplication) =>
    tab === 'all' ? true : tab === 'rejected' ? (a.status === 'rejected' || a.status === 'revoked') : a.status === tab
  const filtered = apps.filter(inTab)
  const count = (k: typeof TABS[number]['key']) => apps.filter(a =>
    k === 'all' ? true : k === 'rejected' ? (a.status === 'rejected' || a.status === 'revoked') : a.status === k).length

  const decide = async (status: 'approved' | 'rejected' | 'revoked') => {
    if (!active) return
    if (status !== 'approved' && !note.trim()) { setError('Add a short reason — the user will see it.'); return }
    setBusy(true)
    try {
      await adminReviewMerchant(active.id, status, note, adminEmail || 'admin')
      setActive(null); setNote(''); load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  if (loading && apps.length === 0) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading applications…</p>

  const row = (label: string, value: string | null) => value ? (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  ) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <AdminCard><p style={{ margin: 0, fontSize: 13, color: 'var(--danger)' }}>{error}</p></AdminCard>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: tab === t.key ? 'var(--brand)' : 'var(--surface)',
              color: tab === t.key ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)',
            }}>
            {t.label} ({count(t.key)})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <AdminCard>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 8 }}>
            <Store size={28} color="var(--text-secondary)" />
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>No applications here</p>
          </div>
        </AdminCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(a => (
            <AdminCard key={a.id} padding={14} onClick={() => { setActive(a); setNote(a.reviewNote ?? ''); setError(null) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{a.businessName}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[a.status], textTransform: 'capitalize' }}>{a.status}</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                {a.username ? `${a.username}` : 'Unknown user'}{a.businessType ? ` · ${a.businessType}` : ''} · {new Date(a.createdAt).toLocaleString()}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{active.businessName}</p>
                <p style={{ fontSize: 12, color: STATUS_COLOR[active.status], margin: '4px 0 0', fontWeight: 600, textTransform: 'capitalize' }}>{active.status}</p>
              </div>
              <button onClick={() => setActive(null)} style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: 'none', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={14} color="var(--text-secondary)" />
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              {row('Username', active.username)}
              {row('Wallet', active.walletAddress)}
              {row('Business type', active.businessType)}
              {row('Contact', active.contact)}
              {row('Applied', new Date(active.createdAt).toLocaleString())}
              {row('Reviewed', active.reviewedAt ? new Date(active.reviewedAt).toLocaleString() : null)}
            </div>
            {active.description && (
              <div style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 16, padding: 14, marginBottom: 14 }}>
                <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{active.description}</p>
              </div>
            )}

            {active.status !== 'rejected' && active.status !== 'revoked' && (
              <>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {active.status === 'approved' ? 'Reason for removing merchant access' : 'Note to the user (required to reject)'}
                </p>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Shown to the user in their notification"
                  style={{ width: '100%', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)', borderRadius: 14, padding: 12, fontSize: 13, color: 'var(--text-primary)', outline: 'none', resize: 'none', marginBottom: 12, boxSizing: 'border-box' }} />
              </>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              {active.status === 'pending' && (
                <>
                  <button onClick={() => decide('approved')} disabled={busy}
                    style={{ flex: 1, padding: 12, borderRadius: 14, background: 'var(--success)', color: '#fff', fontSize: 13, fontWeight: 600, border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                    Approve
                  </button>
                  <button onClick={() => decide('rejected')} disabled={busy}
                    style={{ flex: 1, padding: 12, borderRadius: 14, background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 600, border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                    Reject
                  </button>
                </>
              )}
              {active.status === 'approved' && (
                <button onClick={() => decide('revoked')} disabled={busy}
                  style={{ flex: 1, padding: 12, borderRadius: 14, background: 'transparent', color: 'var(--danger)', fontSize: 13, fontWeight: 600, border: '1px solid var(--danger)', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                  Remove merchant access
                </button>
              )}
            </div>
            {(active.status === 'rejected' || active.status === 'revoked') && active.reviewNote && (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 0' }}>Reason: {active.reviewNote}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
