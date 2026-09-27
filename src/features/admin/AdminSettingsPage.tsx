import { useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, Mail, ShieldCheck, KeyRound, Check } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { useAdminStore } from '@/store/adminStore'
import {
  adminSignOut, sendAdminPasswordChangeOtp, verifyAdminPasswordChangeOtp, updateAdminPassword,
} from '@/lib/adminSupabase'
import { ADMIN_PATH } from '@/lib/adminPath'

export function AdminSettingsPage() {
  const navigate = useNavigate()
  const { adminEmail, clearAdminSession } = useAdminStore()

  // step: 'idle' → 'code_sent' (waiting for the emailed 6-digit code) →
  // 'verified' (code confirmed, now safe to set the new password) → 'done'
  const [step, setStep] = useState<'idle' | 'code_sent' | 'verified' | 'done'>('idle')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleLogout = async () => {
    await adminSignOut()
    clearAdminSession()
    navigate(`${ADMIN_PATH}/login`, { replace: true })
  }

  const requestCode = async () => {
    setError(''); setBusy(true)
    const { error: err } = await sendAdminPasswordChangeOtp()
    setBusy(false)
    if (err) { setError(err); return }
    setStep('code_sent')
  }

  const confirmCode = async () => {
    if (otp.trim().length < 6) { setError('Enter the 6-digit code from your email'); return }
    setError(''); setBusy(true)
    const { error: err } = await verifyAdminPasswordChangeOtp(otp)
    setBusy(false)
    if (err) { setError(err); return }
    setStep('verified')
  }

  const savePassword = async () => {
    if (newPassword.length < 8) { setError('Password must be at least 8 characters'); return }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return }
    setError(''); setBusy(true)
    const { error: err } = await updateAdminPassword(newPassword)
    setBusy(false)
    if (err) { setError(err); return }
    setStep('done')
    setOtp(''); setNewPassword(''); setConfirmPassword('')
  }

  const resetFlow = () => { setStep('idle'); setOtp(''); setNewPassword(''); setConfirmPassword(''); setError('') }

  const inputStyle: CSSProperties = {
    width: '100%', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
    borderRadius: 14, padding: '11px 12px', color: 'var(--text-primary)', fontSize: 14, outline: 'none',
    boxSizing: 'border-box', marginTop: 8,
  }
  const btnStyle: CSSProperties = {
    width: '100%', marginTop: 12, padding: 16, borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)',
    background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 15,
    opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 14, background: 'color-mix(in srgb, var(--brand) 15%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <ShieldCheck size={20} color="var(--brand)" />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>Admin</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Mail size={12} color="var(--text-secondary)" />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{adminEmail ?? '—'}</span>
            </div>
          </div>
        </div>
      </AdminCard>

      <AdminCard>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          Manage admin access by adding rows to the <code style={{ color: 'var(--text-primary)' }}>admin_users</code> table
          in Supabase. Only whitelisted accounts can sign in here.
        </p>
      </AdminCard>

      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: step === 'done' ? 0 : 4 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: 'color-mix(in srgb, var(--brand) 15%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <KeyRound size={16} color="var(--brand)" />
          </div>
          <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 14.5 }}>Change Password</p>
        </div>

        {step === 'idle' && (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
              We'll email a 6-digit code to {adminEmail ?? 'your account'} to confirm it's you before changing anything.
            </p>
            <button onClick={requestCode} disabled={busy} style={btnStyle}>
              {busy ? 'Sending code…' : 'Send verification code'}
            </button>
          </>
        )}

        {step === 'code_sent' && (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
              Enter the 6-digit code sent to {adminEmail}.
            </p>
            <input
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              style={{ ...inputStyle, letterSpacing: 4, textAlign: 'center', fontSize: 18 }}
            />
            <button onClick={confirmCode} disabled={busy} style={btnStyle}>
              {busy ? 'Verifying…' : 'Verify code'}
            </button>
            <button onClick={requestCode} disabled={busy} style={{
              width: '100%', marginTop: 8, padding: '8px 0', borderRadius: 10, border: 'none',
              background: 'none', color: 'var(--accent-text)', fontSize: 12.5, cursor: 'pointer',
            }}>
              Resend code
            </button>
          </>
        )}

        {step === 'verified' && (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
              Verified. Choose a new password (at least 8 characters).
            </p>
            <input
              type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
              placeholder="New password" style={inputStyle}
            />
            <input
              type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password" style={inputStyle}
            />
            <button onClick={savePassword} disabled={busy} style={btnStyle}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </>
        )}

        {step === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <Check size={16} color="var(--success)" />
            <p style={{ margin: 0, fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>Password updated.</p>
            <button onClick={resetFlow} style={{
              marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent-text)', fontSize: 12.5, cursor: 'pointer',
            }}>Done</button>
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '8px 0 0' }}>{error}</p>}
      </AdminCard>

      <button
        onClick={handleLogout}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
          borderRadius: 20, padding: 14, color: 'var(--danger)', fontWeight: 700, fontSize: 14,
        }}
      >
        <LogOut size={16} /> Sign Out
      </button>
    </div>
  )
}
