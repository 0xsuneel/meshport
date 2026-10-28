// Two-step login for the admin console (Supabase MFA, authenticator app).
//
// Inside AdminGuard, after the admin check:
//   * 2FA set up, session not yet verified → ask for the 6-digit code
//   * 2FA not set up                        → set it up now (QR + code)
//   * verified (aal2)                       → the console
// The server enforces the same once ADMIN_REQUIRE_MFA=true is set on the
// admin-api function. If the project can't enroll at all (MFA switched off
// in Supabase), the error is shown and the admin can continue - the server
// flag is what makes 2FA mandatory, so this never locks everyone out.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { AdminCard } from '@/components/admin/AdminCard'
import { ActionButton, CopyText, Notice } from '@/components/admin/AdminUi'

type State =
  | { step: 'loading' }
  | { step: 'ok' }
  | { step: 'verify'; factorId: string }
  | { step: 'enroll'; factorId: string; qr: string; secret: string }
  | { step: 'unavailable'; error: string }

export function AdminMfaGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ step: 'loading' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const check = useCallback(async () => {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal2') return setState({ step: 'ok' })
    const { data: factors, error } = await supabase.auth.mfa.listFactors()
    if (error) return setState({ step: 'unavailable', error: error.message })
    const verified = factors.totp.find(f => f.status === 'verified')
    if (verified) return setState({ step: 'verify', factorId: verified.id })
    // Half-finished setups from before would block a new one with the same name.
    for (const f of factors.all.filter(f => f.status === 'unverified')) await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data: en, error: enErr } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'MeshPort admin' })
    if (enErr || !en) return setState({ step: 'unavailable', error: enErr?.message ?? 'Could not start 2FA setup' })
    setState({ step: 'enroll', factorId: en.id, qr: en.totp.qr_code, secret: en.totp.secret })
  }, [])

  useEffect(() => { void check().catch(e => setState({ step: 'unavailable', error: e instanceof Error ? e.message : String(e) })) }, [check])

  const submit = async (factorId: string) => {
    setBusy(true); setErr('')
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false)
    if (error) { setErr(error.message.includes('Invalid') ? 'That code is wrong or expired - try the current one.' : error.message); return }
    setCode('')
    setState({ step: 'ok' })
  }

  if (state.step === 'ok') return <>{children}</>
  if (state.step === 'loading') return null

  const box = (body: ReactNode) => (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--bg)' }}>
      <AdminCard padding={22} style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldCheck size={22} color="var(--brand-text)" />
          <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)' }}>Two-step login</span>
        </div>
        {body}
      </AdminCard>
    </div>
  )

  if (state.step === 'unavailable') {
    return box(<>
      <Notice tone="error">2FA isn't available right now: {state.error}</Notice>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Turn on TOTP multi-factor authentication in Supabase (Authentication → Multi-Factor) and sign in again. You can continue for now.
      </div>
      <ActionButton onClick={() => setState({ step: 'ok' })}>Continue without 2FA</ActionButton>
    </>)
  }

  const codeInput = (
    <form onSubmit={e => { e.preventDefault(); void submit(state.factorId) }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Authenticator code" autoFocus
        style={{ height: 48, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: 20, letterSpacing: 6, textAlign: 'center' }} />
      {err && <Notice tone="error">{err}</Notice>}
      <ActionButton primary onClick={() => void submit(state.factorId)} disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</ActionButton>
    </form>
  )

  if (state.step === 'verify') {
    return box(<>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Enter the code from your authenticator app.</div>
      {codeInput}
    </>)
  }

  return box(<>
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      Admin access needs an authenticator app (Google Authenticator, 1Password, Authy…). Scan this code, then enter the 6 digits it shows.
    </div>
    <img src={state.qr} alt="2FA QR code" width={180} height={180} style={{ alignSelf: 'center', background: '#fff', borderRadius: 12, padding: 8 }} />
    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Can't scan? Key: <CopyText value={state.secret} /></div>
    {codeInput}
  </>)
}
