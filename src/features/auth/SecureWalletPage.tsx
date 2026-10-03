// Google / email wallets (self-custodial): set up a passkey and/or an
// encrypted Recovery QR, and unlock / recover the wallet on another device.
//
//   /auth/secure-wallet   — "Secure Your Wallet": required until the account
//                            has a passkey or a Recovery QR (AppLayout guard);
//                            also opened from Security to manage them.
//   /auth/recover-wallet  — "Unlock your wallet": passkey, or scan / upload
//                            the Recovery QR + password. Decrypts on the device
//                            and checks it's this account's wallet.
//
// No private key or seed phrase is ever shown, copied or exported here.

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { KeyRound, QrCode, Check, ChevronLeft, Camera, Upload, Loader2, ShieldCheck, Download } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'

const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props}
      className={'w-full py-4 bg-brand rounded-2xl text-white font-bold shadow-elevation-2 active:scale-[.98] transition-transform disabled:opacity-60 border border-black/10 ' + (props.className ?? '')} />
  )
}
function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props}
      className={'w-full py-3.5 rounded-2xl font-semibold text-text-primary bg-surface border border-border active:scale-[.98] transition-transform disabled:opacity-60 flex items-center justify-center gap-2 ' + (props.className ?? '')} />
  )
}

// ── Secure Your Wallet ─────────────────────────────────────────────────────
export function SecureWalletPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const manage = params.get('manage') === '1'
  const { showToastMessage } = useUIStore()
  const userId = useAuthStore(s => s.user?.id)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const [passkeys, setPasskeys] = useState<number | null>(null)
  const [qrAt, setQrAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [makingQr, setMakingQr] = useState(false)

  const refresh = async () => {
    if (!userId) return
    const { getWalletSecurityStatus } = await import('@/lib/socialWallet')
    const st = await getWalletSecurityStatus(userId)
    if (st) { setPasskeys(st.passkeys); setQrAt(st.recoveryQrAt) }
  }
  useEffect(() => { refresh() }, [userId])

  // Needs the unlocked wallet (it's what gets locked to the passkey / QR).
  useEffect(() => {
    if (walletAddress && !privateKey) navigate('/auth/recover-wallet', { replace: true })
  }, [walletAddress, privateKey])

  const secured = (passkeys ?? 0) > 0 || !!qrAt

  const setUpPasskey = async () => {
    if (!userId || !walletAddress || !privateKey) return
    setBusy(true)
    try {
      const { registerWalletPasskey } = await import('@/lib/walletPasskey')
      await registerWalletPasskey({ userId, username: username ?? '', walletAddress, privateKey })
      showToastMessage('Passkey set up', 'success')
      await refresh()
    } catch (e: any) {
      showToastMessage(e?.message ?? "Couldn't set up a passkey", 'error')
    } finally {
      setBusy(false)
    }
  }

  if (makingQr) {
    return <RecoveryQrCreator onBack={() => setMakingQr(false)} onDone={async () => {
      setMakingQr(false)
      await refresh()
    }} />
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe overflow-y-auto">
      {manage && (
        <button onClick={() => navigate(-1)} aria-label="Back" className="mt-4 w-10 h-10 -ml-2 flex items-center justify-center rounded-full">
          <ChevronLeft className="w-6 h-6 text-text-primary" />
        </button>
      )}
      <div className="flex-1 flex flex-col justify-center gap-6 py-8">
        <div className="text-center">
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="w-20 h-20 rounded-full flex items-center justify-center bg-brand/15 border border-brand/25 mx-auto mb-4">
            <ShieldCheck className="w-10 h-10 text-brand" />
          </motion.div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary mb-2">Secure Your Wallet</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5] max-w-xs mx-auto">
            Your wallet lives on your device — MeshPort can't open it. Set up at least one way to get it back on a new phone.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 space-y-3">
          <div className="flex items-start gap-3">
            <KeyRound className="w-6 h-6 text-brand flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-text-primary">Passkey</p>
                {(passkeys ?? 0) > 0 && <span className="text-[12px] font-semibold text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Enabled</span>}
              </div>
              <p className="text-[13px] text-text-secondary leading-snug mt-0.5">Use your device passkey (Face ID / fingerprint) for fast and secure access. It syncs with your Apple or Google account.</p>
            </div>
          </div>
          <SecondaryButton onClick={setUpPasskey} disabled={busy || !privateKey}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            {(passkeys ?? 0) > 0 ? 'Add Another Passkey' : 'Set Up Passkey'}
          </SecondaryButton>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 space-y-3">
          <div className="flex items-start gap-3">
            <QrCode className="w-6 h-6 text-brand flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-text-primary">Recovery QR</p>
                {qrAt && <span className="text-[12px] font-semibold text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Backed Up</span>}
              </div>
              <p className="text-[13px] text-text-secondary leading-snug mt-0.5">An encrypted backup that restores your wallet if your passkey is unavailable. Opens only with your recovery password.</p>
            </div>
          </div>
          <SecondaryButton onClick={() => setMakingQr(true)} disabled={!privateKey}>
            <QrCode className="w-4 h-4" /> {qrAt ? 'Create New Recovery QR' : 'Create Recovery QR'}
          </SecondaryButton>
        </div>

        {!manage && (
          <div className="space-y-2">
            <PrimaryButton onClick={() => navigate('/', { replace: true })} disabled={!secured}>Continue</PrimaryButton>
            {!secured && <p className="text-center text-[12px] text-text-secondary">Set up a passkey or a Recovery QR to continue. Both is best.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Recovery QR creator ────────────────────────────────────────────────────
function RecoveryQrCreator({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { showToastMessage } = useUIStore()
  const userId = useAuthStore(s => s.user?.id)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [working, setWorking] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [weak, setWeak] = useState<string | null>(null)

  useEffect(() => {
    import('@/lib/recoveryQr').then(({ checkRecoveryPassword }) => setWeak(pw ? checkRecoveryPassword(pw) : null))
  }, [pw])

  const create = async () => {
    if (!walletAddress || !privateKey || !userId) return
    if (pw !== pw2) { showToastMessage("Passwords don't match", 'error'); return }
    setWorking(true)
    try {
      const { createRecoveryPayload } = await import('@/lib/recoveryQr')
      const payload = await createRecoveryPayload(privateKey, walletAddress, pw)
      setImageUrl(await renderRecoveryImage(payload, username ? `${username}.arc` : '', walletAddress))
      setPw(''); setPw2('')
    } catch (e: any) {
      showToastMessage(e?.message ?? "Couldn't create the Recovery QR", 'error')
    } finally {
      setWorking(false)
    }
  }

  const confirmSaved = async () => {
    if (!userId) return
    const { markRecoveryQrCreated } = await import('@/lib/socialWallet')
    if (!(await markRecoveryQrCreated(userId))) { showToastMessage("Couldn't save — check your connection", 'error'); return }
    setImageUrl(null)
    showToastMessage('Recovery QR backed up', 'success')
    onDone()
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe overflow-y-auto">
      <button onClick={onBack} aria-label="Back" className="mt-4 w-10 h-10 -ml-2 flex items-center justify-center rounded-full">
        <ChevronLeft className="w-6 h-6 text-text-primary" />
      </button>
      <div className="flex-1 flex flex-col gap-5 py-4">
        <div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary mb-1">Recovery QR</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5]">
            Your wallet is encrypted on this device with a recovery password you choose. MeshPort never sees the password and can't reset it.
          </p>
        </div>

        {!imageUrl ? (
          <>
            <label className="block">
              <span className="text-[13px] font-semibold text-text-secondary">Recovery password</span>
              <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-surface px-4 py-3 text-text-primary outline-none focus:border-brand" />
            </label>
            {pw && weak && <p className="text-[12px] text-danger -mt-3">{weak}</p>}
            <label className="block">
              <span className="text-[13px] font-semibold text-text-secondary">Confirm password</span>
              <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-surface px-4 py-3 text-text-primary outline-none focus:border-brand" />
            </label>
            {pw2 && pw !== pw2 && <p className="text-[12px] text-danger -mt-3">Passwords don't match</p>}
            <p className="text-[12px] text-text-secondary leading-snug">
              Use at least 12 characters — a few random words works well. This is not your 6-digit app passcode.
            </p>
            <PrimaryButton onClick={create} disabled={working || !pw || !!weak || pw !== pw2}>
              {working ? 'Encrypting…' : 'Create Recovery QR'}
            </PrimaryButton>
          </>
        ) : (
          <>
            <img src={imageUrl} alt="MeshPort Recovery QR" className="w-full max-w-[300px] mx-auto rounded-2xl border border-border bg-white" />
            <a href={imageUrl} download={`meshport-recovery-${(username || 'wallet')}.png`}
              className="w-full py-3.5 rounded-2xl font-semibold text-text-primary bg-surface border border-border flex items-center justify-center gap-2">
              <Download className="w-4 h-4" /> Save QR Image
            </a>
            <div className="rounded-xl bg-warning/10 border border-warning/30 p-3 text-[12.5px] text-text-primary leading-snug">
              Keep the QR and the password in different places (for example the QR in your photos or printed, the password in your password manager). Anyone with both can open your wallet.
            </div>
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I saved the QR and I remember the password
            </label>
            <PrimaryButton onClick={confirmSaved} disabled={!saved}>Done</PrimaryButton>
          </>
        )}
      </div>
    </div>
  )
}

/** QR + a caption, as a PNG data URL the user saves. The caption has no secrets. */
async function renderRecoveryImage(payload: string, label: string, address: string): Promise<string> {
  const QR = await import('qrcode')
  const qr = document.createElement('canvas')
  await QR.toCanvas(qr, payload, { width: 520, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
  const out = document.createElement('canvas')
  out.width = qr.width; out.height = qr.height + 110
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(qr, 0, 0)
  ctx.fillStyle = '#111111'; ctx.textAlign = 'center'
  ctx.font = 'bold 26px system-ui, sans-serif'
  ctx.fillText('MeshPort Recovery QR', out.width / 2, qr.height + 34)
  ctx.font = '20px system-ui, sans-serif'
  ctx.fillText([label, shortAddr(address)].filter(Boolean).join(' · '), out.width / 2, qr.height + 66)
  ctx.fillStyle = '#666666'; ctx.font = '17px system-ui, sans-serif'
  ctx.fillText('Encrypted — opens only with your recovery password', out.width / 2, qr.height + 96)
  return out.toDataURL('image/png')
}

// ── Unlock / recover on this device ────────────────────────────────────────
export function RecoverWalletPage() {
  const navigate = useNavigate()
  const { showToastMessage } = useUIStore()
  const userId = useAuthStore(s => s.user?.id)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const setWallet = useAuthStore(s => s.setWallet)
  const logout = useAuthStore(s => s.logout)
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'choose' | 'scan' | 'password'>('choose')
  const [qrText, setQrText] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (privateKey) navigate('/', { replace: true }) }, [privateKey])
  useEffect(() => {
    if (!userId) return
    import('@/lib/walletPasskey').then(({ listWalletPasskeys }) => listWalletPasskeys(userId)).then(l => setHasPasskey(l.length > 0)).catch(() => setHasPasskey(false))
  }, [userId])

  const finish = async (key: string, via: 'passkey' | 'qr') => {
    if (!walletAddress) return
    const { saveDeviceCopy } = await import('@/lib/socialWallet')
    await saveDeviceCopy(walletAddress, key)
    setWallet(walletAddress, key, undefined, 'social-auto')
    showToastMessage('Wallet unlocked', 'success')
    // New device restored from the QR: offer a passkey for next time.
    navigate(via === 'qr' ? '/auth/secure-wallet?manage=1' : '/', { replace: true })
  }

  const usePasskey = async () => {
    if (!userId || !walletAddress) return
    setBusy(true); setError('')
    try {
      const { unlockWithPasskey } = await import('@/lib/walletPasskey')
      await finish(await unlockWithPasskey(userId, walletAddress), 'passkey')
    } catch (e: any) {
      setError(e?.message ?? "Couldn't use the passkey")
    } finally { setBusy(false) }
  }

  const gotQr = async (text: string) => {
    const { recoveryPayloadAddress } = await import('@/lib/recoveryQr')
    const addr = recoveryPayloadAddress(text)
    if (!addr) { setError("That isn't a MeshPort Recovery QR"); setMode('choose'); return }
    if (walletAddress && addr.toLowerCase() !== walletAddress.toLowerCase()) {
      setError(`This Recovery QR is for wallet ${shortAddr(addr)}, not this account's ${shortAddr(walletAddress)}`); setMode('choose'); return
    }
    setQrText(text); setError(''); setMode('password')
  }

  const uploadQr = async (file: File) => {
    const text = await decodeQrFromImage(file).catch(() => null)
    if (!text) { setError("Couldn't find a QR code in that image"); return }
    await gotQr(text)
  }

  const decrypt = async () => {
    if (!walletAddress) return
    setBusy(true); setError('')
    try {
      const { openRecoveryPayload } = await import('@/lib/recoveryQr')
      const { privateKey: key } = await openRecoveryPayload(qrText, pw, walletAddress)
      setPw('')
      await finish(key, 'qr')
    } catch (e: any) {
      setError(e?.message ?? "Couldn't open the Recovery QR")
    } finally { setBusy(false) }
  }

  if (mode === 'scan') {
    return <QrScanner onResult={gotQr} onCancel={() => setMode('choose')} />
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe overflow-y-auto">
      <div className="flex-1 flex flex-col justify-center gap-5 py-8">
        <div className="text-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center bg-brand/15 border border-brand/25 mx-auto mb-4">
            <KeyRound className="w-10 h-10 text-brand" />
          </div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary mb-2">Unlock your wallet</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5] max-w-xs mx-auto">
            {username ? `${username}.arc` : 'Your account'} · {shortAddr(walletAddress)}
            <br />Your wallet isn't on this device yet. Use your passkey or your Recovery QR.
          </p>
        </div>

        {mode === 'password' ? (
          <div className="space-y-3">
            <p className="text-[13px] text-success font-semibold flex items-center gap-1.5"><Check className="w-4 h-4" /> Recovery QR for this wallet</p>
            <input type="password" autoComplete="current-password" placeholder="Recovery password" value={pw}
              onChange={e => { setPw(e.target.value); setError('') }} onKeyDown={e => { if (e.key === 'Enter' && pw) decrypt() }}
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-text-primary outline-none focus:border-brand" />
            <PrimaryButton onClick={decrypt} disabled={busy || !pw}>{busy ? 'Decrypting on this device…' : 'Restore Wallet'}</PrimaryButton>
            <SecondaryButton onClick={() => { setMode('choose'); setQrText(''); setPw('') }} disabled={busy}>Use a different QR</SecondaryButton>
          </div>
        ) : (
          <div className="space-y-3">
            {hasPasskey && (
              <PrimaryButton onClick={usePasskey} disabled={busy}>{busy ? 'Waiting for passkey…' : 'Use Passkey'}</PrimaryButton>
            )}
            <SecondaryButton onClick={() => { setError(''); setMode('scan') }} disabled={busy}><Camera className="w-4 h-4" /> Scan Recovery QR</SecondaryButton>
            <SecondaryButton onClick={() => fileRef.current?.click()} disabled={busy}><Upload className="w-4 h-4" /> Upload QR Image</SecondaryButton>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadQr(f) }} />
          </div>
        )}

        {error && <p role="alert" className="text-center text-[13px] text-danger">{error}</p>}

        <button onClick={() => { logout(); navigate('/auth', { replace: true }) }}
          className="text-[13px] text-text-secondary underline mx-auto">Sign out</button>
      </div>
    </div>
  )
}

/** Reads a QR code from a picked image (a saved Recovery QR). */
async function decodeQrFromImage(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url
    })
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const d = ctx.getImageData(0, 0, c.width, c.height)
    const jsQR = (await import('jsqr')).default
    return jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' })?.data ?? null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Camera scanner for the Recovery QR (decoded on the device). */
function QrScanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        const v = videoRef.current
        if (!v || stopped) return
        v.srcObject = stream
        await v.play()
        const jsQR = (await import('jsqr')).default
        const tick = () => {
          if (stopped) return
          if (v.videoWidth) {
            const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight))
            canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale)
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
            const d = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const code = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' })
            if (code?.data) { stopped = true; onResult(code.data); return }
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        setErr("Couldn't open the camera — allow camera access, or upload the QR image instead")
      }
    })()
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()) }
  }, [])
  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex items-center px-4 py-3">
        <button onClick={onCancel} aria-label="Back" className="w-10 h-10 flex items-center justify-center rounded-full">
          <ChevronLeft className="w-6 h-6 text-white" />
        </button>
        <p className="text-white font-semibold ml-1">Scan Recovery QR</p>
      </div>
      <div className="flex-1 relative flex items-center justify-center">
        <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        <div className="relative w-64 h-64 rounded-3xl border-4 border-white/80" />
      </div>
      {err && <p className="text-center text-[13px] text-white bg-danger/80 px-4 py-3">{err}</p>}
    </div>
  )
}

// ── Security page section (Google / email accounts) ───────────────────────
/**
 * Linked login methods, passkeys, Recovery QR status and the wallet address.
 * Shown on the Security page for Google / email accounts. No private key or
 * export option — by design.
 */
export function WalletSecuritySection() {
  const navigate = useNavigate()
  const { showToastMessage } = useUIStore()
  const userId = useAuthStore(s => s.user?.id)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [methods, setMethods] = useState<Array<{ provider: string; email: string | null }>>([])
  const [passkeys, setPasskeys] = useState<Array<{ id: string; label: string | null; createdAt: string }>>([])
  const [qrAt, setQrAt] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    if (!userId) return
    const [{ linkedLoginMethods, getWalletSecurityStatus }, { listWalletPasskeys }] = await Promise.all([
      import('@/lib/socialWallet'), import('@/lib/walletPasskey'),
    ])
    const [m, p, st] = await Promise.all([linkedLoginMethods(), listWalletPasskeys(userId), getWalletSecurityStatus(userId)])
    setMethods(m); setPasskeys(p); setQrAt(st?.recoveryQrAt ?? null); setLoaded(true)
  }
  useEffect(() => { load() }, [userId])

  const remove = async (id: string) => {
    // Never leave the wallet without a way back.
    if (passkeys.length <= 1 && !qrAt) { showToastMessage('Create a Recovery QR before removing your only passkey', 'error'); return }
    const { removeWalletPasskey } = await import('@/lib/walletPasskey')
    if (await removeWalletPasskey(id)) { showToastMessage('Passkey removed'); load() }
    else showToastMessage("Couldn't remove the passkey", 'error')
  }

  const providerName = (p: string) => p === 'google' ? 'Google' : p === 'apple' ? 'Apple' : p === 'email' ? 'Email code' : p
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="rounded-2xl border border-border bg-surface divide-y divide-border">
      <div className="p-4">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary mb-2">Wallet</p>
        <p className="text-[13px] font-mono text-text-primary break-all">{walletAddress}</p>
      </div>
      <div className="p-4">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary mb-2">Login methods</p>
        {methods.length === 0 && loaded && <p className="text-[13px] text-text-secondary">—</p>}
        {methods.map((m, i) => (
          <p key={i} className="text-[13px] text-text-primary flex items-center gap-2">
            <Check className="w-3.5 h-3.5 text-success" /> {providerName(m.provider)}{m.email ? <span className="text-text-secondary">· {m.email}</span> : null}
          </p>
        ))}
      </div>
      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">Passkeys</p>
          <span className={'text-[12px] font-semibold ' + (passkeys.length ? 'text-success' : 'text-text-secondary')}>{passkeys.length ? '✓ Enabled' : 'Not set up'}</span>
        </div>
        {passkeys.map(p => (
          <div key={p.id} className="flex items-center justify-between gap-2">
            <p className="text-[13px] text-text-primary">{p.label || 'Passkey'} <span className="text-text-secondary">· added {fmt(p.createdAt)}</span></p>
            <button onClick={() => remove(p.id)} className="text-[12px] text-danger font-semibold">Remove</button>
          </div>
        ))}
      </div>
      <div className="p-4 flex items-center justify-between">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">Recovery QR</p>
        <span className={'text-[12px] font-semibold ' + (qrAt ? 'text-success' : 'text-text-secondary')}>{qrAt ? `✓ Backed Up · ${fmt(qrAt)}` : 'Not set up'}</span>
      </div>
      <div className="p-3">
        <button onClick={() => navigate('/auth/secure-wallet?manage=1')}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-brand active:scale-95 transition-transform">
          <ShieldCheck className="w-4 h-4" /> Manage Passkeys & Recovery QR
        </button>
      </div>
    </div>
  )
}
