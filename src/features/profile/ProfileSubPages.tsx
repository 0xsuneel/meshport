import { PinSheet } from '@/components/ui/PinSheet'
import React, { useState, useRef, useEffect, startTransition } from 'react'

// Kept byte-identical to buildProfileUpdateMessage in api/profile.ts - if
// you edit one, edit both, or profile saves will start failing signature
// verification.
function buildProfileUpdateMessage(
  walletAddress: string, timestamp: number, displayName?: string, avatarUrl?: string | null,
): string {
  return [
    'MeshPort profile update',
    `wallet: ${walletAddress.toLowerCase()}`,
    `timestamp: ${timestamp}`,
    `displayName: ${displayName ?? ''}`,
    `avatarUrl: ${avatarUrl ?? ''}`,
  ].join('\n')
}
import { handBiometricPasscode, handBiometricPending } from '@/lib/biometricHandoff'
import { AUTO_LOCK_OPTIONS, autoLockLabel } from '@/lib/autoLock'
import { useNavigate, useLocation, Navigate } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import {
  ArrowLeft, Shield, ShieldAlert, Fingerprint, Lock, KeyRound, ChevronRight,
  Bell, BellOff, CheckCircle, Mail, Plus, Trash2,
  Copy, Eye, EyeOff, Upload, Key, FileText,
  ShoppingCart, Tag, Wallet, Ban, Clock as ClockIcon, Scale, RefreshCw,
  Check, Sun, Moon, Monitor, X, Palette,
  Store,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { useAuthStore, useNotificationStore, useUIStore, type AppNotification } from '@/store'
import { useFeatureEnabled } from '@/store/settingsStore'
import { useThemeStore, resolveTheme, type ThemeMode } from '@/store/themeStore'
import { switchTheme } from '@/lib/themeTransition'
import { Avatar } from '@/components/ui/Avatar'
import { copySensitiveToClipboard, timeAgo } from '@/lib/utils'
import { biometricLabel, removeBiometric, type PendingBiometricRegistration } from '@/lib/biometric'
import { markP2PNotificationRead, markAllP2PNotificationsReadOnServer, P2P_TYPES } from '@/lib/p2pNotifications'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { WalletSecretFrame } from '@/components/wallet/WalletSecretFrame'

/** Small uppercase heading above a Security page card. */
function SecSectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] font-semibold text-text-secondary px-1 mb-2">{children}</p>
}

/** One Security page row: tinted icon, title + subtitle, optional right side. */
function SecRow({ icon, title, sub, right }: { icon: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary truncate">{title}</p>
        {sub ? <p className="text-xs text-text-secondary truncate mt-0.5">{sub}</p> : null}
      </div>
      {right}
    </div>
  )
}

// ─── Security (same for all users) ────────────────────────────────────────────
export function SecurityPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const location = useLocation()
  const { showToastMessage } = useUIStore()
  const passcodeLockEnabled = useAuthStore(s => s.passcodeLockEnabled)
  const setPasscodeLockEnabled = useAuthStore(s => s.setPasscodeLockEnabled)
  const autoLockMinutes = useAuthStore(s => s.autoLockMinutes)
  const setAutoLockMinutes = useAuthStore(s => s.setAutoLockMinutes)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const setBiometricEnabled = useAuthStore(s => s.setBiometricEnabled)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const lock = useAuthStore(s => s.lock)
  // Admin Panel → Features → Security. When an admin turns this off, App.tsx
  // (global effect) forces biometricEnabled to false for every session
  // immediately - this local gate additionally locks the toggle itself so
  // the user can't turn it back on until an admin re-enables it.
  const biometricAdminEnabled = useFeatureEnabled('biometric_login_enabled', true)
  const label = biometricLabel()

  // Enabling needs the RAW passcode to encrypt for storage - the store only
  // ever holds the hash (by design, see security.ts). Disabling doesn't
  // need this at all, so only the enable path shows this sheet.
  const [confirmSheet, setConfirmSheet] = useState(false)
  const [confirmPass, setConfirmPass] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [registering, setRegistering] = useState(false)

  const handleToggle = async () => {
    if (biometricEnabled) {
      // Disabling - no passcode needed, just clear the stored credential.
      if (walletAddress) removeBiometric(walletAddress)
      setBiometricEnabled(false)
      showToastMessage(`${label} disabled`)
      return
    }
    setConfirmPass(''); setConfirmError(''); setConfirmSheet(true)
  }

  const handleConfirmAndRegister = async () => {
    if (confirmPass.length < 6 || !walletAddress || !storedPasscode) return
    setRegistering(true); setConfirmError('')
    const { verifyPasscode } = await import('@/lib/security')
    let correct = false
    try { correct = await verifyPasscode(confirmPass, storedPasscode) } catch {}
    setRegistering(false)
    if (!correct) {
      setConfirmError('Incorrect passcode. Try again.')
      setConfirmPass('')
      return
    }
    // Close the sheet and hand off to the same Enable/Skip screen used at
    // signup, rather than firing the native OS prompt directly from here.
    // Two reasons: (1) consistency - one single place in the app that
    // actually asks "enable biometric?", not two separately-built flows
    // that could drift apart; (2) this call used to fire the native
    // credential prompt in the same tick as the passcode sheet's last
    // keystroke completing, which is very likely what was actually causing
    // the reported flicker - a full route transition guarantees a clean,
    // already-settled screen exists before any native modal ever appears.
    setConfirmSheet(false)
    handBiometricPasscode(confirmPass); navigate('/auth/enable-biometric', { state: { next: location.pathname } })
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Security</h1>
      </div>
      <div className="px-4 space-y-5">
        {/* Status */}
        <div className="rounded-2xl p-4 flex items-center gap-3.5 border bg-success/10 border-success/25">
          <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 bg-success/15">
            <Shield className="w-6 h-6 text-success" />
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-bold" style={{ color: 'var(--success-text)' }}>Account secured</p>
            <p className="text-xs text-text-secondary mt-0.5">Your passcode keeps your wallet safe</p>
          </div>
        </div>

        <div>
          <SecSectionLabel>App lock</SecSectionLabel>
          <Card className="divide-y divide-border">
            <ToggleItem icon={<Fingerprint className="w-5 h-5 text-accent-text" />} label={`${label} Login`}
              description={biometricAdminEnabled ? "Optional - uses passcode as fallback" : "Disabled by admin"}
              enabled={biometricAdminEnabled && biometricEnabled}
              disabled={!biometricAdminEnabled}
              onToggle={handleToggle} />
            <ToggleItem icon={<Lock className="w-5 h-5 text-accent-text" />} label="Passcode Lock"
              description="Locks when offline or the browser is closed" enabled={passcodeLockEnabled}
              onToggle={() => { setPasscodeLockEnabled(!passcodeLockEnabled); showToastMessage(`Auto-lock ${!passcodeLockEnabled ? 'enabled' : 'disabled'}`) }} />
            {passcodeLockEnabled && (
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
                  <ClockIcon className="w-5 h-5 text-accent-text" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-primary">Lock after</p>
                  <p className="text-xs text-text-secondary mt-0.5">Unused or in the background</p>
                  <div role="radiogroup" aria-label="Lock after" className="flex flex-wrap gap-1.5 mt-2">
                    {AUTO_LOCK_OPTIONS.map(m => (
                      <button key={m} role="radio" aria-checked={autoLockMinutes === m}
                        onClick={() => { if (m !== autoLockMinutes) { setAutoLockMinutes(m); showToastMessage(`Locks after ${autoLockLabel(m)}`) } }}
                        className={`h-8 px-3 rounded-full text-xs font-semibold border active:scale-[.97] transition-transform ${autoLockMinutes === m ? 'bg-brand text-white border-black/10' : 'bg-transparent text-text-secondary border-border'}`}>
                        {autoLockLabel(m)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <button onClick={() => navigate('/security/change-passcode')} className="w-full text-left active:opacity-70">
              <SecRow icon={<KeyRound className="w-5 h-5 text-accent-text" />} title="Change Passcode" sub="Update your 6-digit passcode"
                right={<ChevronRight className="w-4 h-4 text-text-secondary" />} />
            </button>
          </Card>
        </div>

        {/* In a transition: the app tree would otherwise empty out (the lock
            guard renders nothing) until the lock screen's code had loaded. */}
        <button onClick={() => { startTransition(() => { lock(); navigate('/auth/lock', { replace: true }) }) }}
          className="w-full flex items-center justify-center gap-2 h-12 bg-brand rounded-2xl text-sm font-semibold text-white active:scale-[0.98] transition-transform">
          <Lock className="w-4 h-4" /> Lock Now
        </button>
      </div>

      <PinSheet open={confirmSheet} onClose={() => !registering && setConfirmSheet(false)} id="biometric-confirm"
        title="Confirm Passcode" subtitle={`Enter your passcode to set up ${label}`}
        value={confirmPass} onChange={v => { setConfirmPass(v); setConfirmError('') }}
        onComplete={handleConfirmAndRegister} error={confirmError || undefined}
        biometricAvailable={false} autoBiometric={false} locked={registering}
        footer={registering ? <p className="text-xs text-text-secondary text-center mt-3">Verifying…</p> : undefined} />
    </div>
  )
}

// ─── Appearance - System / Light / Dark theme picker ───────────────────────────
const APPEARANCE_OPTIONS: { mode: ThemeMode; label: string; description: string; icon: React.ReactNode }[] = [
  { mode: 'system', label: 'System', description: 'Match your device setting', icon: <Monitor className="w-5 h-5" /> },
  { mode: 'light',  label: 'Light',  description: 'Always use the light theme', icon: <Sun className="w-5 h-5" /> },
  { mode: 'dark',   label: 'Dark',   description: 'Always use the dark theme', icon: <Moon className="w-5 h-5" /> },
]

// Fixed (non-CSS-var) palette swatches so the desktop preview panel can show
// what light/dark actually look like regardless of the page's own current
// theme - pulled straight from the light/dark blocks in index.css.
const PREVIEW_PALETTE: Record<'light' | 'dark', { bg: string; surface: string; border: string; text: string; textSecondary: string; brand: string }> = {
  light: { bg: '#F5F4F0', surface: '#FFFFFF', border: '#E6E6E6', text: '#1B1D1F', textSecondary: '#45494D', brand: '#12665F' },
  dark:  { bg: '#000000', surface: '#111111', border: '#1F1F1F', text: '#FFFFFF', textSecondary: '#B4B4B4', brand: '#12665F' },
}

// Desktop-only: a live mock of the app chrome so picking a theme shows what
// it actually looks like instead of leaving the page mostly empty next to
// the options card. Purely decorative - no interactivity.
function AppearancePreview({ mode }: { mode: ThemeMode }) {
  const resolved = resolveTheme(mode)
  const p = PREVIEW_PALETTE[resolved]
  return (
    <div className="rounded-3xl soft-card bg-card p-5">
      <p className="text-sm font-semibold text-text-primary mb-1">Preview</p>
      <p className="text-xs text-text-secondary mb-4">
        {mode === 'system' ? `Following your device - currently ${resolved}.` : `How MeshPort looks in ${resolved} mode.`}
      </p>
      <div className="rounded-2xl overflow-hidden border" style={{ borderColor: p.border, background: p.bg }}>
        {/* Mock header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ background: p.surface, borderBottom: `1px solid ${p.border}` }}>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-[11px] font-bold" style={{ background: p.brand }}>M</div>
            <span className="text-xs font-bold" style={{ color: p.text }}>MeshPort</span>
          </div>
          <div className="w-6 h-6 rounded-full" style={{ background: p.border }} />
        </div>
        {/* Mock balance card */}
        <div className="p-4 space-y-3">
          <div className="rounded-xl p-4" style={{ background: p.brand }}>
            <p className="text-[11px] mb-1" style={{ color: 'rgba(255,255,255,0.75)' }}>Total Balance</p>
            <p className="text-lg font-bold text-white">1,240.00 USDC</p>
          </div>
          <div className="flex gap-2">
            {['Pay', 'Receive', 'Swap'].map(label => (
              <div key={label} className="flex-1 rounded-lg py-2 text-center text-[11px] font-semibold" style={{ background: p.surface, border: `1px solid ${p.border}`, color: p.text }}>
                {label}
              </div>
            ))}
          </div>
          <div className="rounded-lg p-3 flex items-center justify-between" style={{ background: p.surface, border: `1px solid ${p.border}` }}>
            <div>
              <p className="text-[11px] font-semibold" style={{ color: p.text }}>sunil.arc</p>
              <p className="text-[11px]" style={{ color: p.textSecondary }}>Sent 25.00 USDC</p>
            </div>
            <span className="text-[11px] font-semibold" style={{ color: p.textSecondary }}>2m ago</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// Top of Appearance: what the page does, with two little phones (light and
// dark) and a quick light/dark switch.
function AppearanceBanner({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  const phone = (bg: string, line: string, style: React.CSSProperties) => (
    <div aria-hidden style={{ position: 'absolute', width: 48, height: 86, borderRadius: 11, background: bg, border: '2px solid rgba(255,255,255,0.55)',
      boxShadow: '0 8px 18px rgba(0,0,0,0.25)', padding: 6, boxSizing: 'border-box', ...style }}>
      <div style={{ height: 18, borderRadius: 5, background: 'var(--brand)' }} />
      <div style={{ height: 4, borderRadius: 2, background: line, marginTop: 6 }} />
      <div style={{ height: 4, borderRadius: 2, background: line, marginTop: 4, width: '70%' }} />
      <div style={{ height: 12, borderRadius: 4, background: line, marginTop: 6 }} />
    </div>
  )
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 20, padding: 16, minHeight: 128, color: '#fff',
      background: 'color-mix(in srgb, var(--brand) 78%, #000)' }}>
      <div aria-hidden style={{ position: 'absolute', right: -50, top: -30, width: 180, height: 180, borderRadius: '50%', background: 'rgba(143,233,203,0.08)' }} />
      <div style={{ position: 'relative', maxWidth: '58%' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(140,225,205,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Palette className="w-5 h-5" />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.2px', marginTop: 10 }}>Make MeshPort yours</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.82)', marginTop: 2, lineHeight: 1.35 }}>Light, dark, or match your phone.</div>
      </div>
      {phone('#F5F4F0', 'rgba(0,0,0,0.12)', { right: 74, top: 14, transform: 'rotate(-8deg)' })}
      {phone('#0B0B0B', 'rgba(255,255,255,0.2)', { right: 30, top: 18, transform: 'rotate(8deg)' })}
      <button type="button" role="switch" aria-checked={dark} aria-label="Dark theme" onClick={onToggle}
        style={{ position: 'absolute', right: 14, bottom: 14, width: 60, height: 32, borderRadius: 16, padding: 0, cursor: 'pointer',
          background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)' }}>
        <span style={{ position: 'absolute', top: 3, left: 3, width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: dark ? '#0D1F1D' : '#fff', transform: dark ? 'translateX(28px)' : 'none', transition: 'transform .35s cubic-bezier(.3,1.4,.5,1), background-color .35s' }}>
          {dark ? <Moon className="w-3.5 h-3.5" style={{ color: '#8FE9CB' }} /> : <Sun className="w-3.5 h-3.5" style={{ color: 'var(--brand)' }} />}
        </span>
      </button>
    </div>
  )
}

export function AppearancePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const mode = useThemeStore(s => s.mode)
  const dark = resolveTheme(mode) === 'dark'
  // The tick and icon animate on the option just chosen here - not when the
  // page opens, and not on the old choice (it's in the curtain's snapshot).
  const [chosen, setChosen] = useState<ThemeMode | null>(null)
  const choose = (m: ThemeMode) => { setChosen(m); switchTheme(m) }

  const banner = <AppearanceBanner dark={dark} onToggle={() => choose(dark ? 'light' : 'dark')} />
  const optionsCard = (
    <Card className="divide-y divide-border">
      {APPEARANCE_OPTIONS.map(opt => {
        const selected = mode === opt.mode
        const animate = selected && chosen === opt.mode
        return (
          <button key={opt.mode} onClick={() => choose(opt.mode)}
            className="flex items-center gap-3 px-4 py-4 w-full text-left first:rounded-t-3xl last:rounded-b-3xl">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${selected ? 'bg-brand/15 text-brand-text' : 'bg-surface text-text-secondary'} ${animate ? 'mp-icon-spin' : ''}`}
              key={selected ? 'on' : 'off'}>
              {opt.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-text-primary">{opt.label}</p>
              <p className="text-xs text-text-secondary">{opt.description}</p>
            </div>
            {selected && (
              <div className={`w-6 h-6 rounded-full bg-brand flex items-center justify-center flex-shrink-0 ${animate ? 'mp-tick-pop' : ''}`}>
                <Check className="w-3.5 h-3.5 text-white" />
              </div>
            )}
          </button>
        )
      })}
    </Card>
  )

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Appearance</h1>
      </div>
      {isDesktop ? (
        <div className="px-4 grid grid-cols-2 gap-4 items-start">
          <div className="space-y-3">
            {banner}
            <p className="text-xs text-text-secondary px-1">Choose how MeshPort looks on this device.</p>
            {optionsCard}
          </div>
          <AppearancePreview mode={mode} />
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {banner}
          <p className="text-xs text-text-secondary px-1">Choose how MeshPort looks on this device.</p>
          {optionsCard}
        </div>
      )}
    </div>
  )
}

// ─── Change Passcode ──────────────────────────────────────────────────────────
export function ChangePasscodePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const storedPasscode = useAuthStore(s => s.passcode)
  const setPasscode = useAuthStore(s => s.setPasscode)
  const { showToastMessage } = useUIStore()
  const [oldPass,     setOldPass]     = useState('')
  const [newPass,     setNewPass]     = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [error,       setError]       = useState('')
  const [saving,      setSaving]      = useState(false)

  const handleChange = async () => {
    setError('')
    // If no passcode set - treat as setting one fresh (no old passcode needed)
    if (storedPasscode) {
      if (oldPass.length < 6) { setError('Enter your current passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      const ok = await verifyPasscode(oldPass, storedPasscode)
      if (!ok) { setError('Current passcode is incorrect'); return }
    }
    if (newPass.length < 6) { setError('New passcode must be 6 digits'); return }
    if (!/^\d{6}$/.test(newPass)) { setError('Passcode must be 6 digits'); return }
    if (newPass !== confirmPass) { setError('New passcodes do not match'); return }
    setSaving(true)
    try {
      const { hashPasscode } = await import('@/lib/security')
      const hashed = await hashPasscode(newPass)

      // Keep every local secret that's derived from the passcode in sync
      // with the NEW passcode - otherwise a self-custodial wallet's
      // locally-encrypted private key, and any registered biometric
      // unlock, would silently stay tied to the OLD passcode and start
      // failing with "wrong passcode" the next time they're used (biometric
      // unlock, or signing a transaction). Never a separate/new passcode -
      // both are just re-encrypted copies of this same new value.
      const { walletAddress, signer, walletSource, biometricEnabled } = useAuthStore.getState()
      const { setWalletPasscode, keyInWalletFrame } = await import('@/wallet')
      let inFrame = false
      if (walletAddress && signer && walletSource !== 'social-auto' && keyInWalletFrame(walletSource)) {
        // create / import-seed / import-privkey wallets only - social-auto
        // wallets are never encrypted with the passcode, and Privy / Circle
        // wallets have no key in the frame (it failed for them). The wallet
        // frame re-encrypts the key AND the recovery phrase (opened with the
        // just-verified old passcode) under the new one.
        await setWalletPasscode(walletAddress, newPass, storedPasscode ? oldPass : newPass)
        inFrame = true
      }
      let resealPending: PendingBiometricRegistration | null = null
      if (walletAddress && biometricEnabled) {
        const { updateBiometricPasscode } = await import('@/lib/biometric')
        // One fingerprint scan re-seals it for the new passcode; never kept
        // in a weaker form. Off until it's sealed for the new passcode.
        const r = await updateBiometricPasscode(walletAddress, newPass)
        if (r.status !== 'ok') useAuthStore.getState().setBiometricEnabled(false)
        // Cancelled, or refused for want of a fresh tap (Safari, after the
        // hashing above): one tap on the next screen finishes it.
        if (r.status === 'needs-confirm') resealPending = r.pending
        else if (r.status === 'failed') showToastMessage('Fingerprint / Face unlock was turned off - turn it on again in Settings', 'info')
      } else if (walletAddress) {
        // Setting off: a leftover record would still hold the OLD passcode.
        (await import('@/lib/biometric')).removeBiometric(walletAddress)
      }

      // A frame wallet's passcode is checked by the frame - no hash kept here
      // (security.ts FRAME_PASSCODE).
      const { FRAME_PASSCODE } = await import('@/lib/security')
      setPasscode(inFrame ? FRAME_PASSCODE : hashed)
      // Show success immediately - local passcode (and its dependents) are already updated
      showToastMessage('Passcode updated successfully', 'success')
      if (resealPending) {
        handBiometricPending(resealPending)
        navigate('/auth/enable-biometric', { replace: true, state: { next: '/security' } })
      } else {
        navigate(-1)
      }
      // The passcode (even hashed) never leaves this device: a 6-digit PIN's
      // hash can be reversed in seconds by anyone who could read it.
    } catch {
      setError('Failed to update passcode')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Change Passcode</h1>
      </div>
      <div className="px-4 space-y-3">
        <div className="p-4 bg-brand/10 border border-brand/30 rounded-2xl">
          <p className="text-sm text-text-secondary">
            Works across all wallet types - generated, imported seed phrase, imported private key, and social login.
          </p>
        </div>

        {/* Step tabs */}
        {(() => {
          const activeField = storedPasscode
            ? (oldPass.length < 6 ? 'old' : newPass.length < 6 ? 'new' : 'confirm')
            : (newPass.length < 6 ? 'new' : 'confirm')
          const steps = [
            ...(storedPasscode ? [{ key: 'old',     label: 'Current Passcode', value: oldPass,     done: oldPass.length === 6 }] : []),
            { key: 'new',     label: 'New Passcode',     value: newPass,     done: newPass.length === 6 },
            { key: 'confirm', label: 'Confirm Passcode', value: confirmPass, done: confirmPass.length === 6 },
          ]
          return (
            <>
              {/* Step indicators */}
              <div className="flex gap-2 justify-center mb-1">
                {steps.map(s => (
                  <div key={s.key} className="flex flex-col items-center gap-1">
                    <div className="text-[11px] font-semibold" style={{ color: activeField === s.key ? 'var(--brand-text)' : s.done ? 'var(--success-text)' : 'var(--text-muted)' }}>{s.label}</div>
                    <div className="h-0.5 w-16 rounded-full" style={{ background: activeField === s.key ? 'var(--brand)' : s.done ? 'var(--success)' : 'var(--border)' }} />
                  </div>
                ))}
              </div>
              <PinKeypad
                autoBiometric={false} // choosing a new passcode - not a check of the current one
                // The fingerprint key fills in the CURRENT passcode, so only on that step.
                biometricAvailable={activeField === 'old'}
                value={activeField === 'old' ? oldPass : activeField === 'new' ? newPass : confirmPass}
                onChange={v => {
                  setError('')
                  if (activeField === 'old') setOldPass(v)
                  else if (activeField === 'new') setNewPass(v)
                  else setConfirmPass(v)
                }}
                length={6}
                error={!!error}
                onComplete={() => {
                  // Auto-submit when the last field (confirm) is complete
                  if (activeField === 'confirm') handleChange()
                }}
              />
            </>
          )
        })()}

        {error && (
          <div role="alert" className="p-3 bg-danger/10 border border-danger/20 rounded-2xl">
            <p className="text-sm text-danger text-center">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Backup - routes based on loginType and walletSource ───────────────────────
// Route map:
//   social login             → nothing to back up: the wallet comes back with the sign-in
//   create (generated seed)  → BackupRecoveryPhrasePage  (Seed + Private Key tabs)
//   import-seed              → BackupRecoveryPhrasePage  (Seed + Private Key tabs)
//   import-privkey           → BackupPrivateKeyOnlyPage  (Private Key only - no seed)
export function BackupPage() {
  const loginType = useAuthStore(s => s.loginType)
  const walletSource = useAuthStore(s => s.walletSource)
  if (loginType === 'social') return <Navigate to="/security" replace />
  if (walletSource === 'import-privkey') return <BackupPrivateKeyOnlyPage />
  // 'create' and 'import-seed' both use BackupRecoveryPhrasePage with both tabs visible
  return <BackupRecoveryPhrasePage />
}

// ─── Backup Private Key Only (Import Private Key Users only) ───────────────────
function BackupPrivateKeyOnlyPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const [revealed, setRevealed] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [passcodeError, setPasscodeError] = useState('')
  const [verifying, setVerifying] = useState(false)

  const handleReveal = async () => {
    if (passcode.length < 6) { setPasscodeError('Enter your 6-digit passcode'); return }
    setVerifying(true); setPasscodeError('')
    try {
      const { verifyPasscode } = await import('@/lib/security')
      const correct = !!storedPasscode && await verifyPasscode(passcode, storedPasscode)
      if (!correct) setPasscodeError('Incorrect passcode. Try again.')
      else if (await openForReveal(passcode)) setRevealed(true)
      else setPasscodeError('Could not open your wallet. Go to Home to unlock it first, then try again.')
    } catch (e) {
      console.error('[Backup] Reveal failed:', e)
      setPasscodeError('Failed to open your wallet. Try again.')
    }
    setPasscode('')
    setVerifying(false)
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Backup Private Key</h1>
      </div>
      <div className="px-4 space-y-4">
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl">
          <p className="text-sm text-warning">Never share your private key. Anyone with it controls your wallet. Avoid taking a screenshot - write it down instead.</p>
        </div>

        <Card className="p-5 space-y-4">
          <h3 className="font-bold text-text-primary">Private Key (Hex Format)</h3>

          {!revealed || !walletAddress ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">Enter your passcode to view your private key</p>
              <PinKeypad
                value={passcode}
                onChange={v => { setPasscode(v); setPasscodeError('') }}
                length={6}
                error={!!passcodeError}
                onComplete={() => handleReveal()}
              />
              {passcodeError && <p role="alert" className="text-xs text-danger text-center">{passcodeError}</p>}
              {verifying && <p className="text-xs text-text-secondary text-center">Opening…</p>}
            </div>
          ) : (
            <WalletSecretFrame address={walletAddress} what="privateKey" />
          )}
        </Card>

        <Card className="p-4 bg-brand/10 border-brand/30">
          <p className="text-sm text-text-secondary">This wallet was imported using a private key. The recovery seed phrase is not available.</p>
        </Card>
      </div>
    </div>
  )
}

// Opens the wallet in the wallet frame (if it isn't already) after the
// passcode was verified - the secret itself is then shown by the frame
// (WalletSecretFrame); this page never holds it.
async function openForReveal(passcode: string): Promise<boolean> {
  if (useAuthStore.getState().signer) return true
  const { stashRawPasscode, clearRawPasscode, restorePrivateKey } = await import('@/lib/restoreWallet')
  try {
    stashRawPasscode(passcode)
    return await restorePrivateKey(passcode)
  } catch { return false } finally { clearRawPasscode() }
}

// ─── Backup Recovery Phrase (Self-Custody Users only) ─────────────────────────
function BackupRecoveryPhrasePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [revealed, setRevealed] = useState(false)
  const [verified, setVerified] = useState(false)
  const [passcode, setPasscode] = useState('')
  // The verified passcode, kept only while the backup is shown: the wallet
  // frame needs it to open the passcode-encrypted recovery phrase.
  const [revealPasscode, setRevealPasscode] = useState('')
  const [passcodeError, setPasscodeError] = useState('')
  const [verifying, setVerifying] = useState(false)
  // Both 'create' and 'import-seed' wallets expose both Seed + Private Key tabs.
  // The router already guarantees this component only renders for non-import-privkey wallets.
  const showPrivateKeyTab = true
  // Support deep-linking to the private key tab via ?tab=key
  const searchParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const [activeTab, setActiveTab] = useState<'seed' | 'key'>(
    searchParams.get('tab') === 'key' ? 'key' : 'seed'
  )

  const handleReveal = async () => {
    if (passcode.length < 6) { setPasscodeError('Enter your 6-digit passcode'); return }
    setVerifying(true); setPasscodeError('')
    try {
      const { verifyPasscode } = await import('@/lib/security')
      const correct = !!storedPasscode && await verifyPasscode(passcode, storedPasscode)
      if (!correct) setPasscodeError('Incorrect passcode. Try again.')
      else if (await openForReveal(passcode)) { setRevealPasscode(passcode); setRevealed(true) }
      else setPasscodeError('Could not open your wallet. Go to Home to unlock it first, then try again.')
    } catch (e) {
      console.error('[Backup] Verification failed:', e)
      setPasscodeError('Verification failed. Please try again.')
    }
    setPasscode('')
    setVerifying(false)
  }
  const hide = () => { setRevealed(false); setRevealPasscode('') }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Backup & Recovery</h1>
      </div>
      <div className="px-4 space-y-4">
        {verified && (
          <Card className="p-4 flex items-center gap-3 bg-success/10 border-success/30">
            <CheckCircle className="w-5 h-5 text-success flex-shrink-0" />
            <p className="text-sm font-bold text-success">Backup verified</p>
          </Card>
        )}
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl">
          <p className="text-sm text-warning">Never share your recovery phrase or private key. Anyone with them controls your wallet. Avoid taking a screenshot - write it down instead.</p>
        </div>

        {!revealed ? (
          <Card className="p-5 space-y-3">
            <h3 className="font-bold text-text-primary">View Backup</h3>
            <p className="text-sm text-text-secondary">Enter your passcode to view your recovery phrase and private key</p>
            <PinKeypad
              value={passcode}
              onChange={v => { setPasscode(v); setPasscodeError('') }}
              length={6}
              error={!!passcodeError}
              onComplete={() => handleReveal()}
            />
            {passcodeError && <p role="alert" className="text-xs text-danger text-center">{passcodeError}</p>}
          </Card>
        ) : (
          <>
            {/* Tab selector - Seed Phrase / Private Key (hidden for seed-imported wallets) */}
            {showPrivateKeyTab && (
              <div className="flex bg-surface rounded-2xl p-1 border border-border">
                <button onClick={() => setActiveTab('seed')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold ${activeTab === 'seed' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                  <FileText className="w-4 h-4" /> Seed Phrase
                </button>
                <button onClick={() => setActiveTab('key')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold ${activeTab === 'key' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                  <Key className="w-4 h-4" /> Private Key
                </button>
              </div>
            )}

            {/* Seed Phrase section */}
            {activeTab === 'seed' && (
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-text-primary">Recovery Phrase</h3>
                  <button onClick={hide} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary">
                    <EyeOff className="w-3.5 h-3.5" /> Hide
                  </button>
                </div>
                {walletAddress && <WalletSecretFrame address={walletAddress} what="mnemonic" passcode={revealPasscode} />}
              </Card>
            )}

            {/* Private Key section - hidden for seed-imported wallets */}
            {showPrivateKeyTab && activeTab === 'key' && (
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-text-primary">Private Key</h3>
                  <button onClick={hide} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary">
                    <EyeOff className="w-3.5 h-3.5" /> Hide
                  </button>
                </div>
                {walletAddress && <WalletSecretFrame address={walletAddress} what="privateKey" />}
              </Card>
            )}

            {!verified && (
              <Card className="p-4 space-y-3">
                <h3 className="font-bold text-text-primary">Verify Backup</h3>
                <p className="text-sm text-text-secondary">Confirm you have saved your recovery phrase and private key securely.</p>
                <Button fullWidth variant="secondary" onClick={() => { setVerified(true); if (walletAddress) import('@/lib/security').then(({ markWalletBackedUp }) => markWalletBackedUp(walletAddress)).catch(() => {}); showToastMessage('Backup verified!', 'success') }}>
                  <CheckCircle className="w-4 h-4" /> Mark as Verified
                </Button>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Resize + compress an image client-side before upload. Keeps the longest
// edge at maxDim px and re-encodes as JPEG at the given quality - this keeps
// avatar uploads small and fast regardless of how large the original photo is.
async function compressImage(file: File, maxDim = 512, quality = 0.85): Promise<File> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = objectUrl
    })

    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const width = Math.round(img.width * scale)
    const height = Math.round(img.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file // fall back to original if canvas isn't available
    ctx.drawImage(img, 0, 0, width, height)

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) return file // fall back to original if encoding failed

    const baseName = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file // any decode error - just upload the original
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

// ─── Edit Profile ──────────────────────────────────────────────────────────────
export function EditProfilePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const updateAvatar = useAuthStore(s => s.updateAvatar)
  const updateDisplayName = useAuthStore(s => s.updateDisplayName)
  const { showToastMessage } = useUIStore()
  const [displayName, setDisplayName] = useState(user?.displayName || '')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar || null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!user) return null

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Raw upper bound on the original file before we even try to compress it.
    if (file.size > 15 * 1024 * 1024) { showToastMessage('Image too large. Max 15MB.', 'error'); return }
    setUploading(true)
    try {
      const { supabase } = await import('@/lib/supabase')
      const compressed = await compressImage(file)
      const fileName = `avatars/${user.id}_${Date.now()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('attachments')
        .upload(fileName, compressed, { cacheControl: '3600', upsert: true, contentType: 'image/jpeg' })
      if (upErr) { showToastMessage('Upload failed: ' + upErr.message, 'error'); return }
      const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(fileName)
      // Add cache-buster so browsers always fetch the new image, not a cached old one
      const freshUrl = urlData.publicUrl + '?t=' + Date.now()
      setAvatarUrl(freshUrl)
      showToastMessage('Photo updated! Tap Save to apply.', 'success')
    } catch (e: any) {
      showToastMessage('Upload failed', 'error')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) { showToastMessage('Display name cannot be empty', 'error'); return }
    setSaving(true)
    try {
      const { walletAddress: wa, signer } = useAuthStore.getState()
      if (!wa || !signer) {
        showToastMessage('Wallet not unlocked - please unlock your wallet and try again', 'error')
        return
      }

      // 2026-09-19 SECURITY FIX: api/profile.ts now requires a signature
      // proving ownership of the wallet before it will write anything (it
      // previously accepted any { id, walletAddress } with no proof at
      // all). buildProfileUpdateMessage's fields/order must stay identical
      // to the copy in api/profile.ts or the server's check will reject a
      // legitimate request.

      // Use server-side API to bypass RLS (wallet users have no Supabase Auth session)
      // Save CLEAN url to DB (no ?t= cache-buster) so other users get stable URL
      const cleanAvatarUrl = avatarUrl ? avatarUrl.split('?')[0] : avatarUrl
      const timestamp = Date.now()
      const message = buildProfileUpdateMessage(wa, timestamp, displayName.trim(), cleanAvatarUrl)
      const signature = await signer.signMessage({ message })

      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: wa,
          timestamp,
          signature,
          displayName:  displayName.trim(),
          avatarUrl:    cleanAvatarUrl,
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        showToastMessage('Save failed: ' + (json.error || res.status), 'error')
        return
      }

      // Update local Zustand store immediately
      updateDisplayName(displayName.trim())
      // Add cache-buster to force browser to load fresh image everywhere
      const freshUrl = avatarUrl
        ? (avatarUrl.includes('?') ? avatarUrl.split('?')[0] : avatarUrl)  // clean URL saved to DB
        : avatarUrl
      updateAvatar(freshUrl)
      showToastMessage('Profile updated!', 'success')
      navigate(-1)
    } catch (e: any) {
      console.error('[EditProfile] Save error:', e)
      showToastMessage('Save failed: ' + e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const formFields = (
    <>
      <div className="flex flex-col items-center py-4">
        <div className="relative">
          {/* Your own avatar: the photo, or your initials on the brand teal (as on Profile). */}
          {avatarUrl
            ? <Avatar name={displayName || 'User'} src={avatarUrl} size="xl" />
            : <div style={{ width: 84, height: 84, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 26, fontWeight: 700 }}>
                {(displayName || 'User').trim().split(/\s+/).map(w => w.charAt(0)).join('').slice(0, 2).toUpperCase()}
              </div>}
          {uploading && (
            <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          className="mt-3 text-sm text-brand-text font-medium disabled:opacity-50">
          {uploading ? 'Uploading...' : 'Change Photo'}
        </button>
      </div>
      <Input label="Display Name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
      <Input label="Username" value={user.username} disabled className="opacity-60" />
      <Button fullWidth onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </>
  )

  return (
    <div className={isDesktop ? "flex-1 overflow-y-auto pb-6" : "flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto"}>
      <div className="header-row sticky top-0 z-20 bg-bg gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Edit Profile</h1>
      </div>
      {isDesktop ? (
        // Full-bleed card (no maxWidth cap on the page) filling the whole
        // available content width, matching Swap's desktop spacing. Fields
        // themselves stay a comfortable readable width, centered inside it.
        <div style={{ padding: '20px 24px 14px' }}>
          <div className="bg-surface soft-card rounded-3xl" style={{ padding: '32px 24px 28px' }}>
            <div className="space-y-5" style={{ maxWidth: 420, margin: '0 auto' }}>
              {formFields}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-5">
          {formFields}
        </div>
      )}
    </div>
  )
}

// ─── Notifications ─────────────────────────────────────────────────────────────
export function NotificationsPage({ embedded, onClose }: { embedded?: boolean; onClose?: () => void } = {}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const userId = useAuthStore(s => s.user?.id)
  const { notifications, markAllRead, unreadCount, clearAll } = useNotificationStore()
  // Re-render every minute so "Just now" / "5m ago" stay current while open.
  const [, setNowTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setNowTick(x => x + 1), 60_000); return () => clearInterval(t) }, [])

  // P2P notifications (server-driven - see lib/p2pNotifications.ts) need
  // their `read` state synced back to Supabase, not just flipped locally,
  // since that table (not localStorage) is their real source of truth
  // across devices. Other notification types stay purely local, as before.
  const handleNotifTap = (n: AppNotification) => {
    if (n.source === 'server' || P2P_TYPES.has(n.type)) {
      // Server-backed row (P2P or merchant): persist read on the server too.
      markP2PNotificationRead(n.id)
      if (n.tradeId) { onClose?.(); navigate(`/p2p/trade/${n.tradeId}`) }
    } else {
      useNotificationStore.getState().markRead(n.id)
    }
  }

  const handleMarkAllRead = () => {
    markAllRead()
    if (userId) markAllP2PNotificationsReadOnServer(userId)
  }

  const typeConfig: Record<string, { icon: React.ReactNode; bg: string; dot: string }> = {
    payment_received: {
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>,
      bg: 'bg-success/20 text-success',
      dot: 'bg-success',
    },
    reward_earned: {
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
      bg: 'bg-warning/20 text-warning',
      dot: 'bg-warning',
    },
    security_alert: {
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
      bg: 'bg-danger/20 text-danger',
      dot: 'bg-danger',
    },
    admin_broadcast: {
      icon: <Bell className="w-4 h-4" />,
      bg: 'bg-brand/20 text-brand-text',
      dot: 'bg-brand',
    },
    swap_complete: {
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>,
      bg: 'bg-accent/20 text-accent-text',
      dot: 'bg-accent',
    },
    // ── P2P marketplace - server-driven, see lib/p2pNotifications.ts ────────
    buy_order_placed: { icon: <ShoppingCart className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    sell_order_placed: { icon: <Tag className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
    payment_marked_completed: { icon: <CheckCircle className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    funds_released: { icon: <Wallet className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    release_failed: { icon: <RefreshCw className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    trade_cancelled: { icon: <Ban className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    trade_expired: { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-text-secondary/20 text-text-secondary', dot: 'bg-text-secondary' },
    dispute_opened: { icon: <Scale className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    dispute_resolved: { icon: <Scale className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
    refund_completed: { icon: <RefreshCw className="w-4 h-4" />, bg: 'bg-accent/20 text-accent-text', dot: 'bg-accent' },
    // ── Merchant account decisions ──────────────────────────────────────
    merchant_approved: { icon: <Store className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_rejected: { icon: <Store className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    merchant_revoked:  { icon: <Store className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    merchant_payment_received: { icon: <Wallet className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_payment_arriving: { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_payment_review:   { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_payment_partial:  { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_order_paid:       { icon: <Wallet className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_order_completed:  { icon: <Store className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_ledger_credited:  { icon: <Wallet className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
    merchant_chain_payment:    { icon: <Wallet className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_funds_moved:      { icon: <Wallet className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
    merchant_ledger_moving:    { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
    merchant_refund:           { icon: <RefreshCw className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    merchant_refund_sent:      { icon: <RefreshCw className="w-4 h-4" />, bg: 'bg-accent/20 text-accent-text', dot: 'bg-accent' },
    business_payout_due:       { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_bill_reminder:    { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_payment_late:     { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    merchant_payment_screened: { icon: <Ban className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    business_staff_invite:     { icon: <Store className="w-4 h-4" />, bg: 'bg-brand/20 text-brand-text', dot: 'bg-brand' },
  }

  const defaultConfig = {
    icon: <Bell className="w-4 h-4" />,
    bg: 'bg-brand/20 text-brand-text',
    dot: 'bg-accent',
  }

  // Same rules as everywhere else (utils.timeAgo): local calendar days for
  // "Yesterday", '' for an unparseable timestamp.
  const relTime = (ts: string) => timeAgo(ts)


  return (
    <div className={embedded ? 'bg-bg' : 'flex-1 overflow-y-auto bg-bg pb-6 lg:max-w-[950px] lg:mx-auto'}>
      {/* Header */}
      <div className={embedded
        ? 'flex items-center justify-between px-5 pt-5 pb-4 border-b border-border'
        : 'header-row sticky top-0 z-20 bg-bg justify-between px-5 pt-header pb-header'}>
        <div className="flex items-center gap-3">
          {!embedded && !isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-bold text-text-primary">Notifications</h1>
            {unreadCount > 0 && (
              <p className="text-xs text-brand-text">{unreadCount} unread</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button onClick={handleMarkAllRead}
              className="text-xs font-medium text-brand-text bg-brand/10 border border-brand/20 rounded-lg px-3 py-1.5 hover:bg-brand/15 transition-colors">
              Mark all read
            </button>
          )}
          {notifications.length > 0 && (
            <button onClick={clearAll}
              className="text-xs font-medium text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-1.5 hover:bg-danger/15 transition-colors">
              Clear
            </button>
          )}
          {embedded && (
            <button onClick={onClose} aria-label="Close"
              className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 hover:bg-[rgb(var(--text-primary-rgb)/0.08)] transition-colors">
              <X className="w-4 h-4 text-text-secondary" />
            </button>
          )}
        </div>
      </div>

      {/* Notification list */}
      <div className={embedded ? 'px-4 py-3 space-y-2 max-h-[60vh] overflow-y-auto' : 'px-4 space-y-2'}>
        {notifications.map(n => {
          const cfg = typeConfig[n.type] || defaultConfig
          return (
            <button key={n.id} onClick={() => handleNotifTap(n)}
              className={`w-full p-4 rounded-2xl border text-left transition active:scale-[.98] ${
                n.isRead
                  ? 'bg-surface soft-card'
                  : 'bg-brand/5 border-brand/20 hover:border-brand/35'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
                  {cfg.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${n.isRead ? 'text-text-secondary' : 'text-text-primary'}`}>{n.title}</p>
                    <span className="text-[11px] text-text-muted flex-shrink-0">{relTime(n.timestamp)}</span>
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{n.body}</p>
                </div>
                {!n.isRead && (
                  <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${cfg.dot}`} />
                )}
              </div>
            </button>
          )
        })}

        {notifications.length === 0 && (
          <div className="text-center py-20 text-text-secondary">
            <div className="w-16 h-16 bg-surface border border-border rounded-2xl flex items-center justify-center mx-auto mb-4">
              <BellOff className="w-8 h-8 text-text-muted" />
            </div>
            <p className="text-sm font-medium text-text-secondary">No notifications yet</p>
            <p className="text-xs text-text-muted mt-1">Received payments and rewards will appear here</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Toggle Item ───────────────────────────────────────────────────────────────
function ToggleItem({ icon, label, description, enabled, onToggle, disabled }: {
  icon: React.ReactNode; label: string; description: string; enabled: boolean; onToggle: () => void; disabled?: boolean
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${disabled ? 'opacity-50' : ''}`}>
      <div className="w-10 h-10 bg-accent/10 rounded-xl flex items-center justify-center flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        <p className="text-xs text-text-secondary mt-0.5">{description}</p>
      </div>
      <button onClick={disabled ? undefined : onToggle} disabled={disabled}
        className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${enabled ? 'bg-brand' : 'bg-[rgb(var(--text-primary-rgb)/0.12)]'} ${disabled ? 'cursor-not-allowed' : ''}`}>
        <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}
