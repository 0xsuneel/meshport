import React, { useState, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import {
  ArrowLeft, Shield, Fingerprint, Lock, KeyRound,
  Bell, BellOff, CheckCircle, Mail, Plus, Trash2,
  Copy, Eye, EyeOff, Upload, Key, FileText,
  ShoppingCart, Tag, Wallet, Ban, Clock as ClockIcon, Scale, RefreshCw,
  Check, Sun, Moon, Monitor, X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { useAuthStore, useNotificationStore, useUIStore, type AppNotification } from '@/store'
import { useFeatureEnabled } from '@/store/settingsStore'
import { useThemeStore, resolveTheme, type ThemeMode } from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { copySensitiveToClipboard } from '@/lib/utils'
import { biometricLabel, removeBiometric } from '@/lib/biometric'
import { markP2PNotificationRead, markAllP2PNotificationsReadOnServer, P2P_TYPES } from '@/lib/p2pNotifications'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

// ─── Security (same for all users) ────────────────────────────────────────────
export function SecurityPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const location = useLocation()
  const { showToastMessage } = useUIStore()
  const passcodeLockEnabled = useAuthStore(s => s.passcodeLockEnabled)
  const setPasscodeLockEnabled = useAuthStore(s => s.setPasscodeLockEnabled)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const setBiometricEnabled = useAuthStore(s => s.setBiometricEnabled)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const lock = useAuthStore(s => s.lock)
  // Admin Panel → Features → Security. When an admin turns this off, App.tsx
  // (global effect) forces biometricEnabled to false for every session
  // immediately — this local gate additionally locks the toggle itself so
  // the user can't turn it back on until an admin re-enables it.
  const biometricAdminEnabled = useFeatureEnabled('biometric_login_enabled', true)
  const label = biometricLabel()

  // Enabling needs the RAW passcode to encrypt for storage — the store only
  // ever holds the hash (by design, see security.ts). Disabling doesn't
  // need this at all, so only the enable path shows this sheet.
  const [confirmSheet, setConfirmSheet] = useState(false)
  const [confirmPass, setConfirmPass] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [registering, setRegistering] = useState(false)

  const handleToggle = async () => {
    if (biometricEnabled) {
      // Disabling — no passcode needed, just clear the stored credential.
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
    // Two reasons: (1) consistency — one single place in the app that
    // actually asks "enable biometric?", not two separately-built flows
    // that could drift apart; (2) this call used to fire the native
    // credential prompt in the same tick as the passcode sheet's last
    // keystroke completing, which is very likely what was actually causing
    // the reported flicker — a full route transition guarantees a clean,
    // already-settled screen exists before any native modal ever appears.
    setConfirmSheet(false)
    navigate('/auth/enable-biometric', { state: { next: location.pathname, rawPasscode: confirmPass } })
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Security</h1>
      </div>
      <div className="px-4 space-y-4">
        <Card className="p-4 flex items-center gap-3 bg-success/10 border-success/30">
          <Shield className="w-6 h-6 text-success" />
          <div>
            <p className="text-sm font-bold text-success">Account Secured</p>
            <p className="text-xs text-text-secondary">Your wallet is protected</p>
          </div>
        </Card>
        <Card className="divide-y divide-border">
          <ToggleItem icon={<Fingerprint className="w-5 h-5 text-brand" />} label={`${label} Login`}
            description={biometricAdminEnabled ? "Optional — uses passcode as fallback" : "Disabled by admin"}
            enabled={biometricAdminEnabled && biometricEnabled}
            disabled={!biometricAdminEnabled}
            onToggle={handleToggle} />
          <ToggleItem icon={<Lock className="w-5 h-5 text-accent-text" />} label="Passcode Lock"
            description="Auto-locks instantly when offline or the browser is closed" enabled={passcodeLockEnabled}
            onToggle={() => { setPasscodeLockEnabled(!passcodeLockEnabled); showToastMessage(`Auto-lock ${!passcodeLockEnabled ? 'enabled' : 'disabled'}`) }} />
        </Card>

        <button onClick={() => { lock(); navigate('/auth/lock', { replace: true }) }}
          className="w-full flex items-center justify-center gap-2 py-3 bg-surface border border-border rounded-2xl text-sm font-semibold text-text-primary active:scale-95 transition-transform">
          <Lock className="w-4 h-4" /> Lock Now
        </button>

        <button onClick={() => navigate('/security/change-passcode')}
          className="w-full flex items-center justify-center gap-2 py-3 bg-surface border border-border rounded-2xl text-sm font-semibold text-text-primary active:scale-95 transition-transform">
          <KeyRound className="w-4 h-4" /> Change Passcode
        </button>
      </div>

      {confirmSheet && (() => {
        const closeConfirm = () => !registering && setConfirmSheet(false)
        const confirmContent = (
          <>
            <h3 className="text-lg font-bold text-text-primary text-center mb-1">Confirm Passcode</h3>
            <p className="text-sm text-text-secondary text-center mb-5">Enter your passcode to set up {label}</p>
            <PinKeypad
              value={confirmPass}
              onChange={v => { setConfirmPass(v); setConfirmError('') }}
              length={6}
              error={!!confirmError}
              biometricAvailable={false}
              onComplete={handleConfirmAndRegister}
            />
            {confirmError && <p className="text-xs text-danger text-center mt-3">{confirmError}</p>}
            {registering && <p className="text-xs text-text-secondary text-center mt-3">Verifying…</p>}
          </>
        )
        return isDesktop ? (
          <DesktopDialogFrame onClose={closeConfirm} maxWidth={400}>
            <div className="p-6">{confirmContent}</div>
          </DesktopDialogFrame>
        ) : (
          <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={closeConfirm}>
            <div className="w-full bg-surface rounded-t-3xl p-6 pb-8" onClick={e => e.stopPropagation()}>
              <div className="w-9 h-1 rounded-full bg-[rgb(var(--text-primary-rgb)/0.15)] mx-auto mb-5" />
              {confirmContent}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Appearance — System / Light / Dark theme picker ───────────────────────────
const APPEARANCE_OPTIONS: { mode: ThemeMode; label: string; description: string; icon: React.ReactNode }[] = [
  { mode: 'system', label: 'System', description: 'Match your device setting', icon: <Monitor className="w-5 h-5" /> },
  { mode: 'light',  label: 'Light',  description: 'Always use the light theme', icon: <Sun className="w-5 h-5" /> },
  { mode: 'dark',   label: 'Dark',   description: 'Always use the dark theme', icon: <Moon className="w-5 h-5" /> },
]

// Fixed (non-CSS-var) palette swatches so the desktop preview panel can show
// what light/dark actually look like regardless of the page's own current
// theme — pulled straight from the light/dark blocks in index.css.
const PREVIEW_PALETTE: Record<'light' | 'dark', { bg: string; surface: string; border: string; text: string; textSecondary: string; brand: string }> = {
  light: { bg: '#F5F6F8', surface: '#FFFFFF', border: '#D8DBE0', text: '#1A1A1A', textSecondary: '#666B73', brand: '#0F5C57' },
  dark:  { bg: '#0B0E11', surface: '#181A20', border: '#2B3139', text: '#EAECEF', textSecondary: '#9CA3AE', brand: '#12665F' },
}

// Desktop-only: a live mock of the app chrome so picking a theme shows what
// it actually looks like instead of leaving the page mostly empty next to
// the options card. Purely decorative — no interactivity.
function AppearancePreview({ mode }: { mode: ThemeMode }) {
  const resolved = resolveTheme(mode)
  const p = PREVIEW_PALETTE[resolved]
  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <p className="text-sm font-semibold text-text-primary mb-1">Preview</p>
      <p className="text-xs text-text-secondary mb-4">
        {mode === 'system' ? `Following your device — currently ${resolved}.` : `How MeshPort looks in ${resolved} mode.`}
      </p>
      <div className="rounded-2xl overflow-hidden border" style={{ borderColor: p.border, background: p.bg }}>
        {/* Mock header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ background: p.surface, borderBottom: `1px solid ${p.border}` }}>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-bold" style={{ background: p.brand }}>M</div>
            <span className="text-xs font-bold" style={{ color: p.text }}>MeshPort</span>
          </div>
          <div className="w-6 h-6 rounded-full" style={{ background: p.border }} />
        </div>
        {/* Mock balance card */}
        <div className="p-4 space-y-3">
          <div className="rounded-xl p-4" style={{ background: p.brand }}>
            <p className="text-[10px] mb-1" style={{ color: 'rgba(255,255,255,0.75)' }}>Total Balance</p>
            <p className="text-lg font-bold text-white">1,240.00 USDC</p>
          </div>
          <div className="flex gap-2">
            {['Pay', 'Receive', 'Swap'].map(label => (
              <div key={label} className="flex-1 rounded-lg py-2 text-center text-[10px] font-semibold" style={{ background: p.surface, border: `1px solid ${p.border}`, color: p.text }}>
                {label}
              </div>
            ))}
          </div>
          <div className="rounded-lg p-3 flex items-center justify-between" style={{ background: p.surface, border: `1px solid ${p.border}` }}>
            <div>
              <p className="text-[11px] font-semibold" style={{ color: p.text }}>sunil.arc</p>
              <p className="text-[10px]" style={{ color: p.textSecondary }}>Sent 25.00 USDC</p>
            </div>
            <span className="text-[10px] font-semibold" style={{ color: p.textSecondary }}>2m ago</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppearancePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const mode = useThemeStore(s => s.mode)
  const setMode = useThemeStore(s => s.setMode)

  const optionsCard = (
    <Card className="divide-y divide-border">
      {APPEARANCE_OPTIONS.map(opt => {
        const selected = mode === opt.mode
        return (
          <button key={opt.mode} onClick={() => setMode(opt.mode)}
            className="flex items-center gap-3 px-4 py-4 w-full text-left first:rounded-t-3xl last:rounded-b-3xl">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${selected ? 'bg-brand/15 text-brand' : 'bg-surface text-text-secondary'}`}>
              {opt.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-text-primary">{opt.label}</p>
              <p className="text-xs text-text-secondary">{opt.description}</p>
            </div>
            {selected && (
              <div className="w-6 h-6 rounded-full bg-brand flex items-center justify-center flex-shrink-0">
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
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
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
            <p className="text-xs text-text-secondary px-1">Choose how MeshPort looks on this device.</p>
            {optionsCard}
          </div>
          <AppearancePreview mode={mode} />
        </div>
      ) : (
        <div className="px-4 space-y-3">
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
    // If no passcode set — treat as setting one fresh (no old passcode needed)
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
      const { hashPasscode, encryptPrivateKey, storeEncryptedKey, getEncryptedMnemonic, decryptMnemonic, encryptMnemonic, storeEncryptedMnemonic } = await import('@/lib/security')
      const hashed = await hashPasscode(newPass)

      // Keep every local secret that's derived from the passcode in sync
      // with the NEW passcode — otherwise a self-custodial wallet's
      // locally-encrypted private key, and any registered biometric
      // unlock, would silently stay tied to the OLD passcode and start
      // failing with "wrong passcode" the next time they're used (biometric
      // unlock, or signing a transaction). Never a separate/new passcode —
      // both are just re-encrypted copies of this same new value.
      const { walletAddress, privateKey, walletSource, biometricEnabled } = useAuthStore.getState()
      if (walletAddress && privateKey && walletSource !== 'social-auto') {
        // create / import-seed / import-privkey wallets only — social-auto
        // wallets have no local encrypted key (server-side vault instead).
        const reEncrypted = await encryptPrivateKey(privateKey, newPass)
        storeEncryptedKey(walletAddress, reEncrypted)
      }
      // SECURITY FIX: same passcode-rotation problem the private key already
      // solved above, now closed for the mnemonic too — otherwise the
      // locally-encrypted recovery phrase would silently stay decryptable
      // only under the OLD passcode, and BackupRecoveryPhrasePage's reveal
      // flow (which authenticates with the CURRENT passcode) would start
      // failing to decrypt it. Deliberately decrypts-then-re-encrypts from
      // STORAGE with the just-verified `oldPass` (not from in-memory
      // `mnemonic` state, the way the private key does above) — the
      // mnemonic is no longer guaranteed to be sitting in memory the way
      // privateKey is (see store/index.ts's persist `migrate`), so this is
      // the one path that reliably has it regardless of what triggered this
      // passcode change.
      if (walletAddress && walletSource !== 'social-auto') {
        try {
          const encMnemonic = getEncryptedMnemonic(walletAddress)
          if (encMnemonic) {
            const plainMnemonic = await decryptMnemonic(encMnemonic, storedPasscode ? oldPass : newPass)
            if (plainMnemonic) {
              const reEncryptedMnemonic = await encryptMnemonic(plainMnemonic, newPass)
              storeEncryptedMnemonic(walletAddress, reEncryptedMnemonic)
            }
          }
        } catch (e) { console.warn('[ChangePasscode] mnemonic re-encryption failed (non-fatal):', e) }
      }
      if (walletAddress && biometricEnabled) {
        const { updateBiometricPasscode } = await import('@/lib/biometric')
        await updateBiometricPasscode(walletAddress, newPass)
      }

      setPasscode(hashed)
      // Show success immediately — local passcode (and its dependents) are already updated
      showToastMessage('Passcode updated successfully', 'success')
      navigate(-1)
      // Fire-and-forget Supabase sync — does not block success
      const { user } = useAuthStore.getState()
      if (walletAddress || user?.id) {
        import('@/lib/supabase').then(({ supabase }) => {
          supabase.from('users').update({ passcode_hash: hashed })
            .eq(user?.id ? 'id' : 'wallet_address',
                user?.id ?? walletAddress!.toLowerCase())
            .then(() => {}, () => {})
        })
      }
    } catch {
      setError('Failed to update passcode')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
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
            Works across all wallet types — generated, imported seed phrase, imported private key, and social login.
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
                    <div className="text-[10px] font-semibold" style={{ color: activeField === s.key ? 'var(--brand)' : s.done ? 'var(--success)' : 'var(--text-muted)' }}>{s.label}</div>
                    <div className="h-0.5 w-16 rounded-full" style={{ background: activeField === s.key ? 'var(--brand)' : s.done ? 'var(--success)' : 'var(--border)' }} />
                  </div>
                ))}
              </div>
              <PinKeypad
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
          <div className="p-3 bg-danger/10 border border-danger/20 rounded-2xl">
            <p className="text-sm text-danger text-center">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Backup — routes based on loginType and walletSource ───────────────────────
// Route map:
//   social login             → BackupEmailPage
//   create (generated seed)  → BackupRecoveryPhrasePage  (Seed + Private Key tabs)
//   import-seed              → BackupRecoveryPhrasePage  (Seed + Private Key tabs)
//   import-privkey           → BackupPrivateKeyOnlyPage  (Private Key only — no seed)
export function BackupPage() {
  const loginType = useAuthStore(s => s.loginType)
  const walletSource = useAuthStore(s => s.walletSource)
  if (loginType === 'social') return <BackupEmailPage />
  if (walletSource === 'import-privkey') return <BackupPrivateKeyOnlyPage />
  // 'create' and 'import-seed' both use BackupRecoveryPhrasePage with both tabs visible
  return <BackupRecoveryPhrasePage />
}

// ─── Backup Email (Social Login Users only) ────────────────────────────────────
function BackupEmailPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const backupEmail = useAuthStore(s => s.backupEmail)
  const setBackupEmail = useAuthStore(s => s.setBackupEmail)
  const { showToastMessage } = useUIStore()
  const [showAddForm, setShowAddForm] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newEmailError, setNewEmailError] = useState('')
  const [loading, setLoading] = useState(false)
  const [verifyStep, setVerifyStep] = useState(false)
  const [otp, setOtp] = useState('')

  const handleSendCode = async () => {
    if (!newEmail.includes('@')) { setNewEmailError('Enter a valid email address'); return }
    if (newEmail === user?.email) { setNewEmailError('This is already your primary email'); return }
    setLoading(true); setNewEmailError('')
    await new Promise(r => setTimeout(r, 1000))
    setLoading(false); setVerifyStep(true)
    showToastMessage('Verification code sent to ' + newEmail, 'success')
  }

  const handleVerify = async () => {
    if (otp.length < 6) return
    setLoading(true)
    await new Promise(r => setTimeout(r, 800))
    setBackupEmail(newEmail)
    setLoading(false); setShowAddForm(false); setVerifyStep(false); setNewEmail(''); setOtp('')
    showToastMessage('Backup email added!', 'success')
  }

  const handleRemove = async () => {
    setLoading(true)
    await new Promise(r => setTimeout(r, 400))
    setBackupEmail(null)
    setLoading(false)
    showToastMessage('Backup email removed', 'info')
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Backup Email</h1>
      </div>
      <div className="px-4 space-y-4">
        <div className="p-4 bg-brand/10 border border-brand/30 rounded-2xl">
          <p className="text-sm text-text-secondary">Add a backup email to recover your account if you lose access to your primary email.</p>
        </div>

        {/* Primary */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Primary Email</p>
          <Card className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 bg-brand/20 rounded-xl flex items-center justify-center flex-shrink-0">
              <Mail className="w-5 h-5 text-brand" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-text-primary truncate">{user?.email || 'Not set'}</p>
              <p className="text-xs text-success">Primary · Verified</p>
            </div>
          </Card>
        </div>

        {/* Backup */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Backup Email</p>
          {backupEmail ? (
            <Card className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-success/20 rounded-xl flex items-center justify-center flex-shrink-0">
                <Mail className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary truncate">{backupEmail}</p>
                <p className="text-xs text-success">Backup · Verified</p>
              </div>
              <button onClick={handleRemove} className="p-2 text-danger hover:bg-danger/10 rounded-xl flex-shrink-0">
                <Trash2 className="w-4 h-4" />
              </button>
            </Card>
          ) : !showAddForm ? (
            <button onClick={() => setShowAddForm(true)}
              className="w-full flex items-center justify-center gap-2 p-4 border-2 border-dashed border-border rounded-2xl text-text-secondary hover:border-brand/50 hover:text-brand transition-colors">
              <Plus className="w-5 h-5" /><span>Add Backup Email</span>
            </button>
          ) : null}

          {showAddForm && !backupEmail && (
            <Card className="p-4 space-y-3">
              {!verifyStep ? (
                <>
                  <p className="text-sm font-semibold text-text-primary">Add Backup Email</p>
                  <Input type="email" placeholder="backup@example.com" value={newEmail}
                    onChange={e => { setNewEmail(e.target.value); setNewEmailError('') }}
                    error={newEmailError} leftIcon={<Mail className="w-4 h-4" />} />
                  <div className="flex gap-2">
                    <Button fullWidth variant="secondary" onClick={() => { setShowAddForm(false); setNewEmail('') }}>Cancel</Button>
                    <Button fullWidth loading={loading} onClick={handleSendCode}>Send Code</Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-text-primary">Verify Email</p>
                  <p className="text-xs text-text-secondary">6-digit code sent to <span className="text-text-primary">{newEmail}</span></p>
                  <Input placeholder="000000" value={otp} maxLength={6} inputMode="numeric"
                    onChange={e => setOtp(e.target.value.replace(/\D/g, ''))} />
                  <Button fullWidth loading={loading} disabled={otp.length < 6} onClick={handleVerify}>
                    Verify & Save
                  </Button>
                </>
              )}
            </Card>
          )}
        </div>

        {backupEmail && (
          <button onClick={() => { setBackupEmail(null); setShowAddForm(true) }}
            className="w-full py-3 text-sm text-brand font-medium text-center">
            Change Backup Email
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Backup Private Key Only (Import Private Key Users only) ───────────────────
function BackupPrivateKeyOnlyPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const inMemoryKey = useAuthStore(s => s.privateKey)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [passcodeError, setPasscodeError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [decryptedKey, setDecryptedKey] = useState<string | null>(null)

  const handleReveal = async () => {
    if (passcode.length < 6) { setPasscodeError('Enter your 6-digit passcode'); return }
    setVerifying(true); setPasscodeError('')
    try {
      const { verifyPasscode } = await import('@/lib/security')
      let correct = false
      if (storedPasscode) {
        correct = await verifyPasscode(passcode, storedPasscode)
      }
      if (correct) {
        // Try in-memory key first, then restore from cloud/encrypted store
        let key = inMemoryKey
        if (!key) {
          const { stashRawPasscode, clearRawPasscode, restorePrivateKey } = await import('@/lib/restoreWallet')
          try {
            stashRawPasscode(passcode)
            const restored = await restorePrivateKey(passcode)
            if (restored) key = useAuthStore.getState().privateKey
          } catch (restoreErr) {
          } finally {
            clearRawPasscode()
          }
        }
        setDecryptedKey(key)
        if (key) {
          setRevealed(true)
        } else {
          setPasscodeError('Could not retrieve private key. Go to Home to unlock your wallet first, then try again.')
        }
      } else {
        setPasscodeError('Incorrect passcode. Try again.')
      }
    } catch (e) {
      console.error('[Backup] Decrypt failed:', e)
      setPasscodeError('Failed to retrieve private key. Try again.')
    }
    setVerifying(false)
  }

  const handleCopy = async () => {
    if (decryptedKey) {
      const ok = await copySensitiveToClipboard(decryptedKey)
      setCopied(true); showToastMessage(ok ? 'Private key copied' : 'Could not copy key', ok ? 'success' : 'error'); setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Backup Private Key</h1>
      </div>
      <div className="px-4 space-y-4">
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl">
          <p className="text-sm text-warning">⚠️ Never share your private key. Anyone with it controls your wallet. Avoid taking a screenshot — write it down instead.</p>
        </div>

        <Card className="p-5 space-y-4">
          <h3 className="font-bold text-text-primary">Private Key (Hex Format)</h3>

          {!revealed ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">Enter your passcode to view your private key</p>
              <PinKeypad
                value={passcode}
                onChange={v => { setPasscode(v); setPasscodeError('') }}
                length={6}
                error={!!passcodeError}
                onComplete={() => handleReveal()}
              />
              {passcodeError && <p className="text-xs text-danger text-center">{passcodeError}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {decryptedKey ? (
                <>
                  <div className="bg-surface rounded-xl p-4 font-mono text-xs break-all">
                    <span className="text-text-primary">{decryptedKey}</span>
                  </div>
                  <button onClick={handleCopy}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-surface rounded-2xl text-sm font-medium text-text-primary border border-border">
                    {copied ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                    {copied ? 'Copied!' : 'Copy Private Key'}
                  </button>
                </>
              ) : (
                <div className="p-4 bg-surface rounded-2xl text-center">
                  <p className="text-sm text-text-secondary">Could not retrieve private key</p>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="p-4 bg-brand/10 border-brand/30">
          <p className="text-sm text-text-secondary">💡 This wallet was imported using a private key. The recovery seed phrase is not available.</p>
        </Card>
      </div>
    </div>
  )
}

// ─── Backup Recovery Phrase (Self-Custody Users only) ─────────────────────────
function BackupRecoveryPhrasePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const mnemonic = useAuthStore(s => s.mnemonic)
  const inMemoryKey = useAuthStore(s => s.privateKey)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const walletSource = useAuthStore(s => s.walletSource)
  const { showToastMessage } = useUIStore()
  const [revealed, setRevealed] = useState(false)
  const [verified, setVerified] = useState(false)
  const [copiedSeed, setCopiedSeed] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [passcodeError, setPasscodeError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [decryptedKey, setDecryptedKey] = useState<string | null>(null)
  // SECURITY FIX: mnemonic is no longer persisted in plain text (see
  // store/index.ts's persist `migrate` / security.ts's encryptMnemonic), so
  // it's typically NOT in the store's in-memory `mnemonic` field after a
  // reload — this holds the value once handleReveal decrypts it on demand,
  // exactly mirroring decryptedKey's existing role for the private key.
  const [decryptedMnemonic, setDecryptedMnemonic] = useState<string | null>(null)
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
      let correct = false
      if (storedPasscode) {
        correct = await verifyPasscode(passcode, storedPasscode)
      }
      if (correct) {
        // Retrieve the private key — try in-memory first, then derive from mnemonic, then restore
        let key = inMemoryKey
        if (!key && mnemonic) {
          try {
            const { importFromMnemonic } = await import('@/lib/arc')
            const w = await importFromMnemonic(mnemonic)
            if (w?.privateKey) key = w.privateKey
          } catch {}
        }
        if (!key) {
          const { stashRawPasscode, clearRawPasscode, restorePrivateKey } = await import('@/lib/restoreWallet')
          try {
            stashRawPasscode(passcode)
            const restored = await restorePrivateKey(passcode)
            if (restored) key = useAuthStore.getState().privateKey
          } catch (restoreErr) {
          } finally {
            clearRawPasscode()
          }
        }
        // Retrieve the mnemonic the same way — try in-memory first (only
        // ever populated within the same session that created/imported the
        // wallet, see restoreWallet.ts), then decrypt from local storage
        // using the passcode just verified above. Best-effort: a private-
        // key-only import (walletSource 'import-privkey') has no mnemonic
        // at all, so getEncryptedMnemonic correctly returns null there and
        // this silently no-ops — the UI already hides the Seed tab for that
        // wallet type (showPrivateKeyTab / the router-level guard mentioned
        // above).
        let revealedMnemonic = mnemonic
        if (!revealedMnemonic && walletAddress) {
          try {
            const { getEncryptedMnemonic, decryptMnemonic } = await import('@/lib/security')
            const encMnemonic = getEncryptedMnemonic(walletAddress)
            if (encMnemonic) revealedMnemonic = await decryptMnemonic(encMnemonic, passcode)
          } catch {}
        }
        if (key) {
          setDecryptedKey(key)
          if (revealedMnemonic) setDecryptedMnemonic(revealedMnemonic)
          setRevealed(true)
        } else {
          setPasscodeError('Could not retrieve private key. Go to Home to unlock your wallet first, then try again.')
        }
      } else {
        setPasscodeError('Incorrect passcode. Try again.')
      }
    } catch (e) {
      console.error('[Backup] Verification failed:', e)
      setPasscodeError('Verification failed. Please try again.')
    }
    setVerifying(false)
  }

  const handleCopySeed = async () => {
    const seed = mnemonic || decryptedMnemonic
    if (seed) {
      const ok = await copySensitiveToClipboard(seed)
      setCopiedSeed(true); showToastMessage(ok ? 'Recovery phrase copied' : 'Could not copy phrase', ok ? 'success' : 'error'); setTimeout(() => setCopiedSeed(false), 2000)
    }
  }
  const handleCopyKey = async () => {
    if (decryptedKey) {
      const ok = await copySensitiveToClipboard(decryptedKey)
      setCopiedKey(true); showToastMessage(ok ? 'Private key copied' : 'Could not copy key', ok ? 'success' : 'error'); setTimeout(() => setCopiedKey(false), 2000)
    }
  }

  const words = (mnemonic || decryptedMnemonic) ? (mnemonic || decryptedMnemonic)!.split(' ') : []

  return (
    <div className="flex-1 overflow-y-auto pb-6 lg:max-w-[950px] lg:mx-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
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
            <p className="text-sm font-bold text-success">Backup Verified ✓</p>
          </Card>
        )}
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl">
          <p className="text-sm text-warning">⚠️ Never share your recovery phrase or private key. Anyone with them controls your wallet. Avoid taking a screenshot — write it down instead.</p>
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
            {passcodeError && <p className="text-xs text-danger text-center">{passcodeError}</p>}
          </Card>
        ) : (
          <>
            {/* Tab selector — Seed Phrase / Private Key (hidden for seed-imported wallets) */}
            {showPrivateKeyTab && (
              <div className="flex bg-surface rounded-2xl p-1 border border-border">
                <button onClick={() => setActiveTab('seed')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${activeTab === 'seed' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                  <FileText className="w-4 h-4" /> Seed Phrase
                </button>
                <button onClick={() => setActiveTab('key')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${activeTab === 'key' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                  <Key className="w-4 h-4" /> Private Key
                </button>
              </div>
            )}

            {/* Seed Phrase section */}
            {activeTab === 'seed' && (
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-text-primary">Recovery Phrase</h3>
                  <button onClick={() => setRevealed(false)} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary">
                    <EyeOff className="w-3.5 h-3.5" /> Hide
                  </button>
                </div>
                {(mnemonic || decryptedMnemonic) ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {words.map((word, i) => (
                        <div key={i} className="bg-surface rounded-xl px-3 py-2.5 flex items-center gap-1.5">
                          <span className="text-text-secondary text-xs w-4 flex-shrink-0">{i + 1}.</span>
                          <span className="text-sm font-semibold text-text-primary">{word}</span>
                        </div>
                      ))}
                    </div>
                    <button onClick={handleCopySeed}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-surface rounded-2xl text-sm font-medium text-text-primary border border-border">
                      {copiedSeed ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                      {copiedSeed ? 'Copied!' : 'Backup Recovery Phrase'}
                    </button>
                  </>
                ) : (
                  <div className="p-4 bg-surface rounded-2xl text-center">
                    <p className="text-sm text-text-secondary">Recovery phrase not available</p>
                  </div>
                )}
              </Card>
            )}

            {/* Private Key section — hidden for seed-imported wallets */}
            {showPrivateKeyTab && activeTab === 'key' && (
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-text-primary">Private Key</h3>
                  <button onClick={() => setRevealed(false)} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary">
                    <EyeOff className="w-3.5 h-3.5" /> Hide
                  </button>
                </div>
                {decryptedKey ? (
                  <>
                    <div className="bg-surface rounded-xl p-4 font-mono text-xs break-all">
                      <span className="text-text-primary">{decryptedKey}</span>
                    </div>
                    <button onClick={handleCopyKey}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-surface rounded-2xl text-sm font-medium text-text-primary border border-border">
                      {copiedKey ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                      {copiedKey ? 'Copied!' : 'Backup Private Key'}
                    </button>
                  </>
                ) : (
                  <div className="p-4 bg-surface rounded-2xl text-center">
                    <p className="text-sm text-text-secondary">Private key not available</p>
                    <p className="text-xs text-text-secondary mt-1">Go to Home screen first to unlock, then return here</p>
                  </div>
                )}
              </Card>
            )}

            {!verified && (
              <Card className="p-4 space-y-3">
                <h3 className="font-bold text-text-primary">Verify Backup</h3>
                <p className="text-sm text-text-secondary">Confirm you have saved your recovery phrase and private key securely.</p>
                <Button fullWidth variant="secondary" onClick={() => { setVerified(true); showToastMessage('Backup verified!', 'success') }}>
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
// edge at maxDim px and re-encodes as JPEG at the given quality — this keeps
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
    return file // any decode error — just upload the original
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
      const { walletAddress: wa } = useAuthStore.getState()

      // Use server-side API to bypass RLS (wallet users have no Supabase Auth session)
      // Save CLEAN url to DB (no ?t= cache-buster) so other users get stable URL
      const cleanAvatarUrl = avatarUrl ? avatarUrl.split('?')[0] : avatarUrl
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:           user.id,
          walletAddress: wa ?? '',
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
          <Avatar name={displayName || 'User'} src={avatarUrl} size="xl" showRing />
          {uploading && (
            <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          className="mt-3 text-sm text-brand font-medium disabled:opacity-50">
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
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md gap-3 px-5 pt-header pb-header">
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
          <div className="bg-surface border border-border rounded-3xl" style={{ padding: '32px 24px 28px' }}>
            <h2 className="text-lg font-bold text-text-primary text-center mb-2">Edit Profile</h2>
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

  // P2P notifications (server-driven — see lib/p2pNotifications.ts) need
  // their `read` state synced back to Supabase, not just flipped locally,
  // since that table (not localStorage) is their real source of truth
  // across devices. Other notification types stay purely local, as before.
  const handleNotifTap = (n: AppNotification) => {
    if (P2P_TYPES.has(n.type)) {
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
      bg: 'bg-brand/20 text-brand',
      dot: 'bg-brand',
    },
    swap_complete: {
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>,
      bg: 'bg-accent/20 text-accent-text',
      dot: 'bg-accent',
    },
    // ── P2P marketplace — server-driven, see lib/p2pNotifications.ts ────────
    buy_order_placed: { icon: <ShoppingCart className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    sell_order_placed: { icon: <Tag className="w-4 h-4" />, bg: 'bg-brand/20 text-brand', dot: 'bg-brand' },
    payment_marked_completed: { icon: <CheckCircle className="w-4 h-4" />, bg: 'bg-warning/20 text-warning', dot: 'bg-warning' },
    funds_released: { icon: <Wallet className="w-4 h-4" />, bg: 'bg-success/20 text-success', dot: 'bg-success' },
    trade_cancelled: { icon: <Ban className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    trade_expired: { icon: <ClockIcon className="w-4 h-4" />, bg: 'bg-text-secondary/20 text-text-secondary', dot: 'bg-text-secondary' },
    dispute_opened: { icon: <Scale className="w-4 h-4" />, bg: 'bg-danger/20 text-danger', dot: 'bg-danger' },
    dispute_resolved: { icon: <Scale className="w-4 h-4" />, bg: 'bg-brand/20 text-brand', dot: 'bg-brand' },
    refund_completed: { icon: <RefreshCw className="w-4 h-4" />, bg: 'bg-accent/20 text-accent-text', dot: 'bg-accent' },
  }

  const defaultConfig = {
    icon: <Bell className="w-4 h-4" />,
    bg: 'bg-brand/20 text-brand',
    dot: 'bg-accent',
  }

  const relTime = (ts: string) => {
    const date = new Date(ts)
    const diff = Date.now() - date.getTime()
    const secs = Math.floor(diff / 1000)
    const mins = Math.floor(diff / 60000)
    const hrs  = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    if (secs < 60)  return 'Just now'
    if (mins < 60)  return `${mins}m ago`
    if (hrs  < 24)  return `${hrs}h ago`
    if (days === 1) return `Yesterday ${date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`
    if (days < 7)   return date.toLocaleDateString([], {weekday:'short'}) + ' ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
    if (days < 365) return date.toLocaleDateString([], {month:'short',day:'numeric'}) + ', ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
    return date.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) + ', ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
  }

  return (
    <div className={embedded ? 'bg-bg' : 'flex-1 overflow-y-auto bg-bg pb-6 lg:max-w-[950px] lg:mx-auto'}>
      {/* Header */}
      <div className={embedded
        ? 'flex items-center justify-between px-5 pt-5 pb-4 border-b border-border'
        : 'header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header'}>
        <div className="flex items-center gap-3">
          {!embedded && !isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-bold text-text-primary">Notifications</h1>
            {unreadCount > 0 && (
              <p className="text-xs text-brand">{unreadCount} unread</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button onClick={handleMarkAllRead}
              className="text-xs font-medium text-brand bg-brand/10 border border-brand/20 rounded-lg px-3 py-1.5 hover:bg-brand/15 transition-colors">
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
              className={`w-full p-4 rounded-2xl border text-left transition-all active:scale-[.98] ${
                n.isRead
                  ? 'bg-surface border-border hover:border-border'
                  : 'bg-brand/5 border-brand/20 hover:border-brand/35'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
                  {cfg.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${n.isRead ? 'text-text-secondary' : 'text-text-primary'}`}>{n.title}</p>
                    <span className="text-[10px] text-text-muted flex-shrink-0">{relTime(n.timestamp)}</span>
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
    <div className={`flex items-center gap-3 px-4 py-4 ${disabled ? 'opacity-50' : ''}`}>
      <div className="w-10 h-10 bg-surface rounded-xl flex items-center justify-center flex-shrink-0">{icon}</div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
      <button onClick={disabled ? undefined : onToggle} disabled={disabled}
        className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${enabled ? 'bg-brand' : 'bg-[rgb(var(--text-primary-rgb)/0.12)]'} ${disabled ? 'cursor-not-allowed' : ''}`}>
        <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}
