// Admin Panel → Admins (owners only): who has admin access, their role,
// whether they set up 2FA, and when they last signed in. A role change needs
// a reason and is written to the admin audit log (see Logs).
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { Pill, Notice, ActionButton, ago } from '@/components/admin/AdminUi'
import { adminList, adminSetRole, type AdminAccount, type AdminRole } from '@/lib/adminApi'
import { useAdminStore } from '@/store/adminStore'

export const ROLE_INFO: Record<AdminRole, string> = {
  owner: 'Everything, including managing admins',
  operations: 'Money and settings: treasury, stuck funds, businesses, features',
  support: 'Users, transactions and support tickets (no money, no settings)',
  viewer: 'Read-only',
}
const ROLES = Object.keys(ROLE_INFO) as AdminRole[]

function Row({ a, onSaved }: { a: AdminAccount; onSaved: () => void }) {
  const [role, setRole] = useState<AdminRole>(a.role)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const me = useAdminStore(s => s.adminEmail) === a.email
  const changed = role !== a.role

  const save = async () => {
    setBusy(true); setErr('')
    try { await adminSetRole(a.id, role, reason.trim()); setReason(''); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    setBusy(false)
  }

  return (
    <AdminCard padding={16} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{a.email ?? a.id}{me ? ' (you)' : ''}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {a.lastSignInAt ? `Last sign-in ${ago(a.lastSignInAt)}` : 'Never signed in'}
          </div>
        </div>
        {a.twoFactor
          ? <Pill color="var(--success-text)"><ShieldCheck size={11} style={{ verticalAlign: -1 }} /> 2FA on</Pill>
          : <Pill color="var(--danger-text)"><ShieldAlert size={11} style={{ verticalAlign: -1 }} /> No 2FA</Pill>}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
        Role
        <select value={role} onChange={e => setRole(e.target.value as AdminRole)}
          style={{ height: 40, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', padding: '0 10px', fontSize: 14 }}>
          {ROLES.map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)} - {ROLE_INFO[r]}</option>)}
        </select>
      </label>
      {changed && (
        <>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for this change (required)"
            style={{ height: 40, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', padding: '0 12px', fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionButton onClick={() => { setRole(a.role); setReason('') }} disabled={busy}>Cancel</ActionButton>
            <ActionButton primary onClick={() => void save()} disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : 'Save role'}</ActionButton>
          </div>
        </>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </AdminCard>
  )
}

export function AdminsPage() {
  const [admins, setAdmins] = useState<AdminAccount[] | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    adminList().then(r => { setAdmins(r.admins); setErr('') }).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load'))
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Notice>New admins are added in Supabase (admin_users) and start as Viewer. Change roles here; every change is logged with its reason.</Notice>
      {err && <Notice tone="error">{err}</Notice>}
      {admins?.map(a => <Row key={`${a.id}-${a.role}`} a={a} onSaved={load} />)}
    </div>
  )
}
