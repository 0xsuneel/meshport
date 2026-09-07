import {useEffect, useMemo, useRef, useState, type RefObject} from 'react'
import { useNavigate, useSearchParams, type NavigateFunction } from 'react-router-dom'
import { Copy, Check, Users, Download, Share2, DollarSign, X, Fingerprint, ScanFace } from 'lucide-react'
import { useMotionValue, animate, motion } from 'framer-motion'
import { parseUnits } from 'viem'
import { ARC } from '@/blockchain/chains'
import { useAuthStore, useWalletStore, useNotificationStore, useUIStore } from '@/store'
import { formatAmount, copyToClipboard, timeAgo, trimTrailingZeros } from '@/lib/utils'
import { readArcBalance, readExternalTotal } from '@/blockchain/BlockchainManager'
import { notifyPaymentReceived, notifyPaymentReceivedFromAddress, notifyBulkPaymentReceived } from '@/lib/notifications'
import { markP2PNotificationRead } from '@/lib/p2pNotifications'
import { deriveAddressFromPrivateKey } from '@/lib/arc'
import { getRemovedContacts, unblockIfNewerActivity } from '@/lib/removedContacts'
import { searchUsersDb, getOrCreateConversation, fetchContactsDb, type DbUser } from '@/lib/supabase'
import { filterServices } from '@/lib/searchServices'
import { fetchRecentContacts, recentInitial, recentShortName, recentSendTarget, RECENT_AVATAR_COLORS, type RecentContact } from '@/lib/recentContacts'
import { useSettingsStore } from '@/store/settingsStore'
import { activityLabel, activitySign, type ActivityType, type ActivityRecord } from '@/lib/ActivityService'
// Reused so the desktop "Recent Activity" panel shows the exact same
// title wording as the Activity page itself (Paid to / Received from /
// Claimed from / Transfer to / P2P Sell Order Cancelled, including
// self-transfer "Self" labeling) instead of a second, drifting copy of
// the same logic via the older activityLabel() map.
import { deriveActivityRow, DetailSheet } from '@/features/activity/ActivityPage'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useVisibleViewportHeight } from '@/hooks/useVisibleViewportHeight'
import { useIsStandalone } from '@/hooks/useIsStandalone'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { biometricLabel } from '@/lib/biometric'

function copyText(text: string) { try { navigator.clipboard.writeText(text) } catch {} }

// ── Insights bucketing — pure, real-data only ───────────────────────────────
// Builds the full ordered list of time buckets covering `spanDays` ending
// "now" (so empty buckets show as zero rather than being skipped), then
// aggregates real ActivityRecords into them. Shared by the Insights "Total
// Volume" trend line and the Activity bar chart — one bucketing pass, two
// different fields (volume vs count) read off the same buckets.
type InsightsGranularity = 'daily' | 'weekly' | 'monthly'
interface ActivityBucket { key: string; label: string; start: number; end: number; count: number; volume: number }

function makeBuckets(spanDays: number, granularity: InsightsGranularity, endDate: Date): Omit<ActivityBucket, 'count' | 'volume'>[] {
  const buckets: Omit<ActivityBucket, 'count' | 'volume'>[] = []
  if (granularity === 'daily') {
    for (let i = spanDays - 1; i >= 0; i--) {
      const d = new Date(endDate); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0)
      const start = d.getTime()
      buckets.push({ key: d.toDateString(), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start, end: start + 86400000 })
    }
  } else if (granularity === 'weekly') {
    const weeks = Math.max(1, Math.ceil(spanDays / 7))
    for (let i = weeks - 1; i >= 0; i--) {
      const end = new Date(endDate); end.setDate(end.getDate() - i * 7); end.setHours(23, 59, 59, 999)
      const start = end.getTime() - 6 * 86400000
      buckets.push({ key: `w${i}`, label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start, end: end.getTime() })
    }
  } else {
    const months = Math.max(1, Math.ceil(spanDays / 30))
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(endDate); d.setDate(1); d.setMonth(d.getMonth() - i)
      const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
      buckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-US', { month: 'short' }), start, end })
    }
  }
  return buckets
}

function aggregateBuckets(records: ActivityRecord[], spanDays: number, granularity: InsightsGranularity, endDate: Date): ActivityBucket[] {
  const shells = makeBuckets(spanDays, granularity, endDate)
  return shells.map(b => {
    const inBucket = records.filter(r => { const t = new Date(r.createdAt).getTime(); return t >= b.start && t < b.end })
    return { ...b, count: inBucket.length, volume: inBucket.reduce((s, r) => s + r.amount, 0) }
  })
}

// ── My QR — Home screen card, below Assets ──────────────────────────────────
// Same qrcode lib + encoding choice as ReceivePage.tsx: encodes the raw
// wallet address (not the pay link) so external wallets that scan it treat
// it as "send to this address" rather than opening a browser link.
const APP_URL = 'https://meshport.xyz'

function MyQrCard({ walletAddress, username, scrollContainerRef, assetsCardRef }: { walletAddress: string | null; username: string | null; scrollContainerRef: RefObject<HTMLDivElement>; assetsCardRef: RefObject<HTMLDivElement> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [qrReady, setQrReady] = useState(false)
  const [qrError, setQrError] = useState(false)
  const scale = useMotionValue(0.4)
  const opacity = useMotionValue(0)
  const { showToastMessage } = useUIStore()

  // ── Collect USDC — request a specific amount ──────────────────────────
  // Tapping "Collect USDC" opens an inline amount field. Once an amount is
  // set, the QR switches from the raw wallet address to this user's pay
  // link with `?amount=` baked in (PayPage/PaySendPage already read that
  // param and prefill it), so whoever scans the code lands straight on a
  // payment pre-filled with the amount — they never have to type it in.
  const [collecting, setCollecting] = useState(false)
  const [amountInput, setAmountInput] = useState('')
  const [activeAmount, setActiveAmount] = useState<string | null>(null)

  // ── QR payload ─────────────────────────────────────────────────────────
  // No amount: the plain wallet address — already the universally-
  // understood format every wallet's scanner (MetaMask, Rabby, Coinbase
  // Wallet, OKX, Binance, MeshPort itself) recognizes as "pay this address".
  //
  // With an amount: EIP-681 (`ethereum:<address>@<chainId>?value=<wei>`),
  // NOT a MeshPort web link. A meshport.xyz/pay/... URL only means anything
  // to MeshPort's own app — every other wallet either can't parse it at all
  // or just opens it as a plain webpage, silently losing the amount (and
  // sometimes the recipient too). EIP-681 is the actual cross-wallet
  // standard for "pay this address this amount" — MetaMask, Rabby, Coinbase
  // Wallet, Trust, and OKX all prefill both fields from it directly.
  // Native USDC on Arc is 18-decimal (see NATIVE_DECIMALS in arcService.ts/
  // claim-recovery-scan), so `value` is amount × 10^18, computed with
  // viem's parseUnits rather than floating-point math to avoid precision
  // loss on larger amounts.
  //
  // MeshPort's OWN scanner (ScannerPage.tsx) also parses this exact format
  // now, and independently resolves the recipient's username via a wallet-
  // address lookup — so switching off the meshport.xyz URL loses nothing
  // for MeshPort-to-MeshPort scans, only gains everyone else.
  const qrData = (() => {
    if (!activeAmount || !walletAddress) return walletAddress
    try {
      const wei = parseUnits(activeAmount, 18)
      return `ethereum:${walletAddress}@${ARC.chainId}?value=${wei.toString()}`
    } catch {
      return walletAddress
    }
  })()

  // Auto-hide the Collect QR after 30s of inactivity if the person never
  // taps the ✕ themselves — a requested-amount QR left on screen (or in a
  // screenshot) indefinitely is easy to accidentally reuse for a different
  // amount later, so it reverts back to the plain address QR on its own.
  // Restarts whenever a fresh amount is generated.
  useEffect(() => {
    if (!activeAmount) return
    const timer = setTimeout(() => setActiveAmount(null), 30000)
    return () => clearTimeout(timer)
  }, [activeAmount])

  // Continuous scroll-linked reveal based on how much of the QR card's
  // NATURAL (full, unscaled) height already fits in the visible gap below
  // the Assets card — not on closeness to the bottom of the page. This
  // means if there's already empty space below Assets at rest (before any
  // scrolling), a proportional peek of the card shows immediately, then
  // grows smoothly to full size as more of that space opens up while
  // scrolling. `card.offsetHeight` is used for the natural height because
  // offsetHeight is a layout measurement unaffected by the CSS `scale`
  // transform we apply below — reading it doesn't create a feedback loop
  // with our own animation. `assetsCard`'s position is likewise untouched
  // by our card's transform, since transforms never affect sibling layout.
  useEffect(() => {
    const container = scrollContainerRef.current
    const assetsCard = assetsCardRef.current
    const card = cardRef.current
    if (!container || !assetsCard || !card) return

    const updateProgress = () => {
      const containerRect = container.getBoundingClientRect()
      const assetsRect = assetsCard.getBoundingClientRect()
      const naturalHeight = card.offsetHeight || 1
      const visibleAmount = Math.min(naturalHeight, Math.max(0, containerRect.bottom - assetsRect.bottom))
      const progress = visibleAmount / naturalHeight
      scale.set(0.4 + progress * 0.6)
      opacity.set(progress > 0 ? 1 : 0)
    }

    updateProgress()
    container.addEventListener('scroll', updateProgress, { passive: true })
    window.addEventListener('resize', updateProgress)
    return () => {
      container.removeEventListener('scroll', updateProgress)
      window.removeEventListener('resize', updateProgress)
    }
  }, [scrollContainerRef, assetsCardRef, scale, opacity, qrReady])

  useEffect(() => {
    if (!qrData || !canvasRef.current) return
    setQrReady(false)
    setQrError(false)
    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current!, qrData, {
        width: 236,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      }, (err) => {
        if (err) { setQrError(true); return }
        setQrReady(true)
      })
    }).catch(() => setQrError(true))
  }, [qrData])

  const handleDownload = () => {
    if (!canvasRef.current) return
    try {
      const link = document.createElement('a')
      // Filename reflects the requested amount when there is one, so a
      // saved/shared file is self-explanatory on its own (e.g. in a
      // downloads folder or chat attachment list) instead of every QR
      // looking identical regardless of what it actually requests.
      link.download = activeAmount
        ? `meshport-qr-${walletAddress?.slice(0, 8)}-$${activeAmount}.png`
        : `meshport-qr-${walletAddress?.slice(0, 8)}.png`
      link.href = canvasRef.current.toDataURL('image/png')
      link.click()
    } catch {
      showToastMessage('Could not download QR', 'error')
    }
  }

  const handleShare = async () => {
    if (!canvasRef.current || !qrData || !walletAddress) return
    try {
      canvasRef.current.toBlob(async (blob) => {
        if (!blob) { showToastMessage('Could not share QR', 'error'); return }
        const file = new File([blob], 'meshport-qr.png', { type: 'image/png' })
        // Shareable link — same /pay/:username?amount= format ReceivePage
        // already builds, and the one PayPage already reads back (see
        // requestedAmount above). Previously this fell back to the raw
        // wallet address even when an amount was set, which meant sharing
        // a "Collect $20" QR to someone without MeshPort's scanner handy
        // (e.g. a chat preview, or anyone on desktop) gave them nothing
        // but a bare address — no amount, no one-tap link. A pay link
        // carries the amount as a real query param the recipient's own
        // browser/app resolves, not just something printed in the caption.
        const cleanUsername = (username || '').replace(/\.arc$/, '')
        const paymentLink = (cleanUsername
          ? `${APP_URL}/pay/${cleanUsername}`
          : `${APP_URL}/pay/${walletAddress}`
        ) + (activeAmount ? `?amount=${encodeURIComponent(activeAmount)}` : '')
        const shareText = activeAmount
          ? `Pay me $${activeAmount} USDC on MeshPort — ${paymentLink}`
          : `Pay me on MeshPort — ${paymentLink}`
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My QR', text: shareText })
        } else if (navigator.share) {
          await navigator.share({ title: 'My QR', text: shareText })
        } else {
          // Same reasoning as shareText above: copy something a human (or
          // another wallet's "paste address" field) can actually use, not
          // the raw EIP-681 URI qrData now carries when an amount is set.
          await navigator.clipboard.writeText(shareText)
          showToastMessage('Copied to clipboard', 'success')
        }
      }, 'image/png')
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToastMessage('Could not share QR', 'error')
    }
  }

  const startCollecting = () => {
    setAmountInput(activeAmount || '')
    setCollecting(true)
  }

  const confirmAmount = () => {
    const value = amountInput.trim()
    const numeric = Number(value)
    if (!value || !(numeric > 0)) {
      showToastMessage('Enter a valid amount', 'error')
      return
    }
    setActiveAmount(numeric.toString())
    setCollecting(false)
  }

  const resetToAddress = () => {
    setActiveAmount(null)
    setAmountInput('')
    setCollecting(false)
  }

  if (!walletAddress) return null

  return (
    <motion.div
      ref={cardRef}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
        padding: '16px', boxShadow: 'var(--shadow-1)', width: '95%', margin: '0 auto', boxSizing: 'border-box',
        scale, opacity, transformOrigin: 'top center',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {activeAmount ? `Collect $${activeAmount}` : 'My QR'}
        </span>
        {activeAmount && (
          <button
            onClick={resetToAddress}
            aria-label="Back to My QR"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 2, cursor: 'pointer' }}>
            <X size={14} style={{ color: 'var(--text-secondary)' }} />
          </button>
        )}
      </div>
      <div style={{
        width: 242, height: 242, borderRadius: 12, background: '#DEE6E8',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {qrError ? (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', padding: 8, textAlign: 'center' }}>Couldn't load QR</span>
        ) : (
          <canvas ref={canvasRef} style={{ display: qrReady ? 'block' : 'none', width: 236, height: 236, borderRadius: 10 }} />
        )}
      </div>

      {/* Collect USDC — amount entry / trigger */}
      {collecting ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, width: '100%', boxSizing: 'border-box',
            border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px',
          }}>
            <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              autoFocus
              placeholder="0.00"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAmount() }}
              style={{
                width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
                fontSize: 15, color: 'var(--text-primary)',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%', boxSizing: 'border-box' }}>
            <button
              onClick={() => setCollecting(false)}
              style={{
                flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              Cancel
            </button>
            <button
              onClick={confirmAmount}
              style={{
                flex: 1, minWidth: 0, padding: '8px 14px', borderRadius: 10, border: 'none',
                background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              Generate
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startCollecting}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 10,
            padding: '8px 14px', cursor: 'pointer', color: 'var(--text-primary)',
          }}>
          <DollarSign size={14} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {activeAmount ? 'Change amount' : 'Collect USDC'}
          </span>
        </button>
      )}

      {/* Divider + Download/Share row — same layout as the UPI-app reference */}
      <div style={{ width: '100%', height: 1, background: 'var(--border)', margin: '6px 0 2px' }} />
      <div style={{ display: 'flex', width: '100%', alignItems: 'stretch' }}>
        <button
          onClick={handleDownload}
          disabled={!qrReady}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'transparent', border: 'none', padding: '12px 8px',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 14, fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Download size={17} />
          Download QR
        </button>
        <div style={{ width: 1, background: 'var(--border)' }} />
        <button
          onClick={handleShare}
          disabled={!qrReady}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'transparent', border: 'none', padding: '12px 8px',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 14, fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Share2 size={17} />
          Share QR
        </button>
      </div>
    </motion.div>
  )
}





// ── Biometric footer row — below QR (mobile) / below Assets (desktop) ──────
// Same enable flow Settings→Security already uses (see SecurityPage's
// handleConfirmAndRegister): registering a credential needs the RAW
// passcode to encrypt it, which the store never holds (only its hash — see
// security.ts), so tapping Enable first collects it in a small confirm
// sheet, then hands off to the shared EnableBiometricPage for the actual
// native prompt. One flow, reused from both entry points, instead of two
// that could drift apart.
//
// Shown on every device — including ones with no biometric hardware at
// all — per spec. On an unsupported device the native prompt just can't
// succeed; EnableBiometricPage already handles that case today (bounces
// straight back to `next` once its own support check resolves false), so
// tapping Enable there is a no-op rather than a broken screen, no extra
// gating needed here.
//
// `biometricEnabled` is the same store flag Settings reads/writes, so
// enabling from either place stays in sync automatically. Once enabled,
// this row only ever shows the read-only "Enabled" pill — turning it back
// off is deliberately Settings-only, never from here.
function BiometricFooterRow({ isDesktop }: { isDesktop: boolean }) {
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const storedPasscode = useAuthStore(s => s.passcode)
  const label = biometricLabel()
  // Same device check EnableBiometricPage already uses for this icon —
  // biometricLabel() returns 'Face ID' only on iPhone/iPad/iPod, so this
  // stays in sync with it rather than re-detecting the platform separately.
  const BiometricIcon = label === 'Face ID' ? ScanFace : Fingerprint

  const [confirmSheet, setConfirmSheet] = useState(false)
  const [confirmPass, setConfirmPass] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [registering, setRegistering] = useState(false)

  if (!walletAddress) return null

  const openConfirm = () => { setConfirmPass(''); setConfirmError(''); setConfirmSheet(true) }

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
    setConfirmSheet(false)
    navigate('/auth/enable-biometric', { state: { next: '/', rawPasscode: confirmPass } })
  }

  const closeConfirm = () => !registering && setConfirmSheet(false)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, width: isDesktop ? '100%' : '95%',
      margin: '10px auto 0', boxSizing: 'border-box',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16,
      padding: '12px 14px', boxShadow: isDesktop ? 'var(--shadow-1)' : undefined,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
        background: 'var(--bg-accent, rgba(59,130,246,0.12))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <BiometricIcon size={18} style={{ color: 'var(--brand)' }} />
      </div>
      <p style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', margin: 0, lineHeight: 1.35 }}>
        Unlock MeshPort and approve payments faster with biometrics
      </p>
      {biometricEnabled ? (
        <span style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 12px', borderRadius: 10, fontSize: 12, fontWeight: 600,
          color: 'var(--success)', background: 'rgba(34,197,94,0.12)',
        }}>
          <Check size={13} /> Enabled
        </span>
      ) : (
        <button
          onClick={openConfirm}
          style={{
            flexShrink: 0, padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>
          Enable
        </button>
      )}

      {confirmSheet && (() => {
        const confirmContent = (
          <>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center', margin: '0 0 4px' }}>Confirm Passcode</h3>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', textAlign: 'center', margin: '0 0 20px' }}>Enter your passcode to set up {label}</p>
            <PinKeypad
              value={confirmPass}
              onChange={v => { setConfirmPass(v); setConfirmError('') }}
              length={6}
              error={!!confirmError}
              biometricAvailable={false}
              onComplete={handleConfirmAndRegister}
            />
            {confirmError && <p style={{ fontSize: 12, color: 'var(--danger)', textAlign: 'center', marginTop: 12 }}>{confirmError}</p>}
            {registering && <p style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 12 }}>Verifying…</p>}
          </>
        )
        return isDesktop ? (
          <DesktopDialogFrame onClose={closeConfirm} maxWidth={400}>
            <div style={{ padding: 24 }}>{confirmContent}</div>
          </DesktopDialogFrame>
        ) : (
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', background: 'rgba(0,0,0,0.5)' }} onClick={closeConfirm}>
            <div style={{ width: '100%', background: 'var(--surface)', borderRadius: '24px 24px 0 0', padding: '24px 24px 32px' }} onClick={e => e.stopPropagation()}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 20px' }} />
              {confirmContent}
            </div>
          </div>
        )
      })()}
    </div>
  )
}


// ── More Actions Sheet ────────────────────────────────────────────────────────
function MoreSheet({ onClose, navigate }: { onClose: () => void; navigate: (p: string) => void }) {
  const actions = [
    {
      label: 'Pay', path: '/pay-send',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M17 7H9M17 7V15" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    },
    {
      label: 'Receive', path: '/receive',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M17 7L7 17M7 17H15M7 17V9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    },
    {
      label: 'Swap', path: '/swap',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h13M4 7l3-3M4 7l3 3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 17H7M20 17l-3 3M20 17l-3-3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    },
    {
      label: 'Bulk Pay', path: '/bulk-payout',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="#fff" strokeWidth="1.7"/><path d="M3 10h18M7 14h2M11 14h2" stroke="#fff" strokeWidth="1.4" strokeLinecap="round"/></svg>,
    },
    {
      label: 'Rewards', path: '/rewards',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2l2.4 5.5H20l-4.5 3.5 1.7 5.5L12 13 6.8 16.5l1.7-5.5L4 7.5h5.6L12 2z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round"/></svg>,
    },
    {
      label: 'P2P', path: '/p2p',
      icon: <Users size={22} color="#fff" strokeWidth={1.8} />,
    },
    {
      label: 'Multichain Transfer', path: '/multichain-transfer',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.7"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9s1.3-6.5 3.8-9z" stroke="#fff" strokeWidth="1.5"/></svg>,
    },
    {
      label: 'Multichain Claim', path: '/multichain-claim',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 4v11M12 15l-4-4M12 15l4-4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round"/></svg>,
    },
    {
      label: 'Insights', path: '/insights',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 19h16M4 15l4-4 4 2 4-6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    },
  ]
  const isDesktop = useMediaQuery('(min-width: 980px)')
  // See useVisibleViewportHeight's own comment — this sheet's backdrop
  // used a plain inset:0 (sized against the full layout viewport), which
  // on iPhone Chrome/Safari can extend past what's actually visible,
  // pushing this align-items:'flex-end' sheet's bottom (the Close button)
  // down under the browser's own address bar / tab bar chrome instead of
  // sitting above it.
  const visibleHeight = useVisibleViewportHeight()
  // See Sheet.tsx's identical use of this — visualViewport doesn't
  // reliably track the browser's own persistent toolbar on iOS, so add a
  // fixed safety buffer, only when running in a real (non-installed)
  // browser tab that could actually have that chrome on-screen.
  const isStandalone = useIsStandalone()
  const chromeBuffer = isStandalone ? 0 : 56
  const content = (
    <>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Actions</div>
      {/* 3-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0 }}>
        {actions.map(a => (
          <div key={a.label}
            onClick={() => { onClose(); navigate(a.path) }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 4px', cursor: 'pointer' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--brand)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {a.icon}
            </div>
            <span style={{
              fontSize: a.label.length > 10 ? 10.5 : 12, color: 'var(--text-primary)', fontWeight: 400, textAlign: 'center',
              lineHeight: 1.25, width: '100%', wordBreak: 'break-word',
            }}>{a.label}</span>
          </div>
        ))}
      </div>
      <button onClick={onClose} style={{
        width: '100%', padding: 14, borderRadius: 14, fontSize: 15, fontWeight: 500,
        background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-primary)',
        border: '1px solid var(--border)', cursor: 'pointer',
        marginTop: 8, fontFamily: '-apple-system,sans-serif',
      }}>Close</button>
    </>
  )

  if (isDesktop) {
    return (
      <DesktopDialogFrame onClose={onClose} maxWidth={420}>
        <div style={{ padding: '24px 20px 28px' }}>{content}</div>
      </DesktopDialogFrame>
    )
  }
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: 0, height: visibleHeight ?? '100%',
      background: 'rgba(0,0,0,0.6)',
      zIndex: 100, display: 'flex', alignItems: 'flex-end',
    }} onClick={onClose}>
      <div style={{
        width: '100%', maxWidth: '100%', margin: '0 auto',
        background: 'var(--surface)', borderRadius: '24px 24px 0 0',
        border: '1px solid var(--border)', borderBottom: 'none',
        padding: '24px 20px 44px',
        paddingBottom: `calc(44px + env(safe-area-inset-bottom) + ${chromeBuffer}px)`,
        maxHeight: '85%', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        {/* Handle */}
        <div style={{ width: 36, height: 4, background: 'color-mix(in srgb, var(--text-primary) 15%, transparent)', borderRadius: 2, margin: '0 auto 20px' }}/>
        {content}
      </div>
    </div>
  )
}

// ── Asset History Sheet ───────────────────────────────────────────────────────
function AssetSheet({ token, history, onClose }: { token: string; history: any[]; onClose: () => void }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const headerRow = (
    <div style={{ padding: '16px 20px', borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
      <span style={{ fontSize: 17, fontWeight: 700 }}>{token} History</span>
      <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%',
        background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: 'none', color: 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
    </div>
  )
  const listBody = (
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {history.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>No {token} transactions yet</div>
          ) : history.map((item: any, i: number) => {
            const type: ActivityType = item.activityType
            const meta = item.metadata || {}
            const direction = meta.direction as string | undefined

            // Swaps are stored as ONE activity row tagged with the INPUT
            // side's token/amount (amount = amountIn, tokenSymbol = tokenIn;
            // see ActivityService.saveActivity.swap). This sheet shows one
            // token's history at a time, so a swap needs to be re-signed and
            // re-amounted per which side `token` (the sheet's asset) was:
            // the side sent (tokenIn, so '-' and amountIn) or the side
            // received (tokenOut, so '+' and amountOut). Without this,
            // every swap row showed a neutral gray sign and always the
            // input-side amount — wrong number entirely when viewing the
            // output token's sheet (e.g. opening EURC's history for a
            // USDC->EURC swap showed "10.00 EURC" instead of "+9.40 EURC").
            let sign: '+' | '-' | '↔' = activitySign(type, direction)
            let displayAmount = item.amount
            if (type === 'swap') {
              if (token === meta.tokenOut) {
                sign = '+'
                displayAmount = meta.amountOut ?? item.amount
              } else {
                sign = '-'
                displayAmount = meta.amountIn ?? item.amount
              }
            }
            const isSent = sign === '-'
            const color = sign === '+' ? 'var(--success)' : sign === '-' ? 'var(--danger)' : 'var(--text-secondary)'

            const formatAddr = (addr?: string) => addr ? addr.slice(0, 6) + '...' + addr.slice(-6) : ''
            const formatChain = (c?: string) => c ? c.replace(/_/g, ' ') : ''

            // Title/subtitle — reuse the exact same derivation as the
            // Activity page (Paid to / Received from / Claimed from /
            // Transfer to / P2P Sell Order Cancelled, including self-
            // transfer "Self") for every type it models, so this sheet can
            // never drift from the Activity page's wording again.
            // 'deposit' isn't modeled by deriveActivityRow (a pre-existing
            // gap on the Activity page itself, not something introduced
            // here) — kept on its prior wording below so this change
            // doesn't regress a type nobody asked to change. Any other
            // genuinely unhandled type falls back the same way it already
            // did before this change.
            const derived = deriveActivityRow(item)
            let title = derived.title
            let subtitle = derived.subtitle
            if (type === 'deposit') {
              title = activityLabel(type)
              subtitle = `From ${formatChain(item.sourceChain)}`
            } else if (!['send','receive','swap','bulk','bridge','claim','p2p_sell_order','p2p_refund','p2p_purchase'].includes(type)) {
              title = activityLabel(type)
              subtitle = formatAddr(item.counterpartyAddress) || type
            }

            const rawDate = item.createdAt || item.updatedAt
            const d = rawDate ? new Date(rawDate) : null
            const dateStr = d && !isNaN(d.getTime())
              ? `${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''

            // BUG FIX: cirBTC amounts are often tiny fractions (e.g.
            // 0.000067), and so can USDC/EURC ones on this testnet
            // (chat-pay/dust amounts) — the default 2-decimal formatAmount()
            // rounds any of these straight to "0.00" (then "0" once
            // trimmed), hiding a real, nonzero amount. Apply the same
            // magnitude-based precision tiers regardless of token, not just
            // for cirBTC.
            const amtNum = Number(displayAmount) || 0
            const amtAbs = Math.abs(amtNum)
            const amountStr = amtAbs !== 0 && amtAbs < 0.01
              ? trimTrailingZeros(amtAbs < 0.0001 ? amtNum.toFixed(8) : amtNum.toFixed(6))
              : formatAmount(amtNum)

            return (
              <div key={item.id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 20px',
                borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: isSent ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : 'color-mix(in srgb, var(--success) 10%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    {isSent
                      ? <><path d="M2 12L12 2" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round"/><path d="M12 2H6M12 2V8" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></>
                      : <><path d="M12 2L2 12" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round"/><path d="M2 12H8M2 12V6" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></>}
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {subtitle}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color }}>
                    {sign}{amountStr} {token}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {dateStr || '—'}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
  )

  if (isDesktop) {
    return (
      <DesktopDialogFrame onClose={onClose} maxWidth={440}>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}>
          {headerRow}
          {listBody}
        </div>
      </DesktopDialogFrame>
    )
  }
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
      onClick={onClose}>
      <div style={{ width: '100%', maxWidth: '100%', margin: '0 auto', background: 'var(--surface)',
        borderRadius: '24px 24px 0 0', border: '1px solid var(--border)',
        borderBottom: 'none', maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        {headerRow}
        {listBody}
      </div>
    </div>
  )
}

// ── Recent — people I sent money to recently ──────────────────────────────────
// Clicking a person goes to /send?to=walletAddress (pre-fills recipient in send page)
// "View all" opens /recent-paid page showing full list
// Logic lives in src/lib/recentContacts.ts — this is the canonical "Home
// Avatar Recent" behavior that the Send page recent row and the View-all
// Recent page both reuse, so all three stay in sync.
function RecentRow({ navigate, compact, resultLimit = 5 }: { navigate: NavigateFunction; compact?: boolean; resultLimit?: number }) {
  const avatarSize = compact ? 44 : 56
  const user = useAuthStore(s => s.user)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [recents, setRecents] = useState<RecentContact[]>([])
  const [loaded, setLoaded]   = useState(false)

  useEffect(() => {
    if (!walletAddress) return

    // Backfill activity history from messages — run ONCE per wallet per session
    const backfillKey = `meshport_backfilled_${walletAddress.toLowerCase()}`
    if (user?.id && !user.id.startsWith('usr_') && !sessionStorage.getItem(backfillKey)) {
      sessionStorage.setItem(backfillKey, '1')
      import('@/lib/ActivityService').then(({ backfillActivityFromMessages }) => {
        backfillActivityFromMessages(walletAddress, user.id!).catch(() => {})
      })
    }

    const load = async () => {
      try {
        // resultLimit is desktop-aware (see the call site below) — desktop's
        // wider card was stretching just 5 avatars across the full row
        // width (each one gets flex:1, so fewer avatars = more empty gap
        // between them), while mobile's narrower width already fills
        // naturally at 5. maxAddresses stays comfortably above whatever
        // resultLimit asks for either way.
        const meshPortUsers = await fetchRecentContacts(walletAddress, { activityLimit: 20, maxAddresses: Math.max(10, resultLimit * 2), resultLimit })
        setRecents(meshPortUsers)
      } catch (e) {
        console.error('RecentRow load error:', e)
      } finally {
        setLoaded(true)
      }
    }
    load()
  }, [walletAddress, resultLimit])

  const COLORS = RECENT_AVATAR_COLORS
  const initials = recentInitial
  const shortName = recentShortName

  // Click → pre-fill /send with this recipient
  const goSend = (c: RecentContact) => {
    navigate(`/pay-send?to=${encodeURIComponent(recentSendTarget(c))}`, { state: { returnTo: '/' } })
  }

  if (!loaded) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 8 : 14 }}>
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>Recent</span>
        </div>
        <div style={{ display: 'flex', gap: compact ? 12 : 16 }}>
          {Array.from({ length: resultLimit }, (_, i) => i).map(i => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div style={{ width: avatarSize, height: avatarSize, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}/>
              <div style={{ width: 36, height: 8, borderRadius: 4, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}/>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (recents.length === 0) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 6 : 12 }}>
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>Recent</span>
          <button onClick={() => navigate('/pay-send')}
            style={{ fontSize: 14, color: 'var(--brand)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
            Pay →
          </button>
        </div>
        <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
          padding: compact ? '10px 14px' : '14px 18px', textAlign: 'center', cursor: 'pointer' }}
          onClick={() => navigate('/pay-send')}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Your recent recipients will appear here</div>
          <div style={{ fontSize: 14, color: 'var(--brand)', fontWeight: 600, marginTop: 6 }}>Make your first payment →</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 8 : 14 }}>
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>Recent</span>
        <button onClick={() => navigate('/recent-paid')}
          style={{ fontSize: 14, color: 'var(--brand)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
          View all
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {recents.map((c, i) => (
          <div key={c.id || c.wallet_address}
            onClick={() => goSend(c)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? 6 : 8, cursor: 'pointer', flex: 1 }}>
            {c.avatar_url ? (
              <img src={c.avatar_url} alt={shortName(c)}
                style={{ width: avatarSize, height: avatarSize, borderRadius: '50%', objectFit: 'cover',
                  border: '1px solid var(--border)' }}/>
            ) : (
              <div style={{ width: avatarSize, height: avatarSize, borderRadius: '50%',
                background: COLORS[i % COLORS.length],
                border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: compact ? 16 : 20, fontWeight: 700, color: '#fff' }}>
                {initials(c)}
              </div>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-primary)', textAlign: 'center',
              maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortName(c)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Asset Row ─────────────────────────────────────────────────────────────────
function AssetRow({ icon, fallbackColor, fallbackChar, name, sub, cryptoAmount, usdValue, usdColor, onClick, border, hidden, changePct }: {
  icon: string; fallbackColor: string; fallbackChar: string;
  name: string; sub: string; cryptoAmount: string; usdValue: string; usdColor: string;
  onClick: () => void; border?: boolean; hidden: boolean;
  // Desktop-only — real 24h % change from CoinGecko (see fetchPortfolio's
  // change-24h fetch). Left undefined on mobile call sites, so nothing new
  // renders there. null means "fetched but unavailable" (never faked).
  changePct?: number | null;
}) {
  const [imgOk, setImgOk] = useState(true)
  // `changePct !== undefined` is only ever true from desktop call sites (see
  // the prop comment above), so it doubles as a compact-density flag here —
  // avoids a second useMediaQuery hook just for padding/icon size.
  const showChange = changePct !== undefined
  const changeUp = (changePct ?? 0) >= 0
  const iconSize = showChange ? 32 : 40
  return (
    <div onClick={onClick} className="asset-row-hover"
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: showChange ? '8px 14px' : '13px 16px',
        borderBottom: border ? '1px solid var(--border)' : 'none', cursor: 'pointer',
        background: 'var(--ar-hover-bg, transparent)', transition: 'background-color 150ms ease' }}>
      <div style={{ width: iconSize, height: iconSize, borderRadius: '50%', flexShrink: 0,
        background: fallbackColor, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {imgOk
          ? <img src={icon} alt={name} style={{ width: iconSize, height: iconSize, objectFit: 'cover' }} onError={() => setImgOk(false)}/>
          : <span style={{ color: '#fff', fontWeight: 700, fontSize: showChange ? 13 : 16 }}>{fallbackChar}</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: showChange ? 13.5 : 15, fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: showChange ? 11 : 12, color: 'var(--text-secondary)', marginTop: 1 }}>{sub}</div>
      </div>
      {showChange && (
        <div style={{ minWidth: 64, textAlign: 'right' }}>
          {changePct === null ? (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>—</span>
          ) : (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12.5, fontWeight: 600,
              color: changeUp ? 'var(--success)' : 'var(--danger)',
            }}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ transform: changeUp ? 'none' : 'rotate(180deg)' }}>
                <path d="M5 1v8M5 1L1.5 4.5M5 1l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>
      )}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: showChange ? 13.5 : 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {hidden ? '••••' : usdValue}
        </div>
        <div style={{ fontSize: showChange ? 11 : 12, color: usdColor, marginTop: 1 }}>
          {hidden ? '••••' : cryptoAmount}
        </div>
      </div>
    </div>
  )
}

// ── Sparkline — small inline SVG trend line, no charting dependency ────────────
// Fed real bucketed values only (balance trend, insights volume trend, stat
// mini-charts) — never synthetic. A flat/empty series still renders a flat
// mid-line rather than nothing, so the card never looks broken.
function Sparkline({ values, color, height = 32, fill = false }: { values: number[]; color: string; height?: number; fill?: boolean }) {
  const w = 100, h = height
  const max = Math.max(...values, 0.0001)
  const min = Math.min(...values, 0)
  const range = Math.max(max - min, 0.0001)
  const pts = values.length > 1
    ? values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * h}`)
    : [`0,${h / 2}`, `${w},${h / 2}`]
  const line = pts.join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      {fill && (
        <polygon points={`0,${h} ${line} ${w},${h}`} fill={color} opacity={0.12} />
      )}
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ── Quick Actions — desktop-only card, 8 real routes + Customize→MoreSheet ─────
// Reuses the exact icon glyphs already drawn for MoreSheet's `actions` list
// above (same shapes, same routes) rather than inventing a second icon set.
// Module-level (not per-render) — the full pool of 10 actions a user can
// choose from when customizing the grid; QuickActionsCard only renders
// whichever ids are currently selected (see `actionIds` prop), in that order.
const QUICK_ACTION_POOL_ICON_COLOR = 'var(--text-primary)'
const QUICK_ACTION_POOL: { id: string; label: string; path: string; icon: React.ReactNode }[] = (() => {
  const c = QUICK_ACTION_POOL_ICON_COLOR
  return [
    { id: 'pay', label: 'Pay', path: '/pay-send', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M17 7H9M17 7V15" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> },
    { id: 'receive', label: 'Receive', path: '/receive', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M17 7L7 17M7 17H15M7 17V9" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> },
    { id: 'swap', label: 'Swap', path: '/swap', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h13M4 7l3-3M4 7l3 3" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 17H7M20 17l-3 3M20 17l-3-3" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> },
    { id: 'bulk-pay', label: 'Bulk Pay', path: '/bulk-payout', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke={c} strokeWidth="1.7"/><path d="M3 10h18M7 14h2M11 14h2" stroke={c} strokeWidth="1.4" strokeLinecap="round"/></svg> },
    { id: 'multichain-transfer', label: 'Multichain Transfer', path: '/multichain-transfer', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.7"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9s1.3-6.5 3.8-9z" stroke={c} strokeWidth="1.5"/></svg> },
    { id: 'multichain-claim', label: 'Multichain Claim', path: '/multichain-claim', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 4v11M12 15l-4-4M12 15l4-4" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke={c} strokeWidth="1.7" strokeLinecap="round"/></svg> },
    { id: 'scan-qr', label: 'Scan QR', path: '/scanner', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.2" stroke={c} strokeWidth="1.7"/><rect x="14" y="3" width="7" height="7" rx="1.2" stroke={c} strokeWidth="1.7"/><rect x="3" y="14" width="7" height="7" rx="1.2" stroke={c} strokeWidth="1.7"/><path d="M14 14h3v3h-3zM19 14h2M14 19h2M19 19h2" stroke={c} strokeWidth="1.5" strokeLinecap="round"/></svg> },
    { id: 'claim-rewards', label: 'Claim Rewards', path: '/rewards', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2l2.4 5.5H20l-4.5 3.5 1.7 5.5L12 13 6.8 16.5l1.7-5.5L4 7.5h5.6L12 2z" stroke={c} strokeWidth="1.7" strokeLinejoin="round"/></svg> },
    { id: 'p2p', label: 'P2P', path: '/p2p', icon: <Users size={16} color={c} strokeWidth={1.8} /> },
    { id: 'insights', label: 'Insights', path: '/insights', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 19h16M4 15l4-4 4 2 4-6" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  ]
})()
const DEFAULT_QUICK_ACTION_IDS = ['pay', 'receive', 'swap', 'bulk-pay', 'multichain-transfer', 'multichain-claim', 'scan-qr', 'claim-rewards']
const MAX_QUICK_ACTIONS = 8

function QuickActionsCard({ navigate, actionIds, onCustomize }: { navigate: (p: string) => void; actionIds: string[]; onCustomize: () => void }) {
  const tiles = actionIds.map(id => QUICK_ACTION_POOL.find(a => a.id === id)).filter((a): a is typeof QUICK_ACTION_POOL[number] => !!a)
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
      padding: '12px 14px', boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Quick Actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {tiles.map(t => (
          <div key={t.id} onClick={() => navigate(t.path)}
            className="transition-[box-shadow,transform] duration-200 hover:shadow-elevation-2 hover:-translate-y-0.5"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, padding: '8px 2px', borderRadius: 12, cursor: 'pointer',
              background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
              border: '1px solid var(--border)',
            }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface)',
              border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {t.icon}
            </div>
            <span style={{ fontSize: 9.5, color: 'var(--text-secondary)', fontWeight: 500, textAlign: 'center', lineHeight: 1.15 }}>{t.label}</span>
          </div>
        ))}
      </div>
      <button onClick={onCustomize} style={{
        width: '100%', marginTop: 8, padding: 7, borderRadius: 10, fontSize: 12, fontWeight: 600,
        background: 'none', color: 'var(--brand)', border: '1px dashed var(--border)', cursor: 'pointer',
      }}>
        Customize
      </button>
    </div>
  )
}

// ── Customize Quick Actions — desktop-only sheet, add/remove up to 8 ───────────
// Real add/remove, not a static nav list (that's MoreSheet's job, unchanged
// and untouched by this — mobile's "More" button still opens MoreSheet
// exactly as before). Selection persists to localStorage so it survives a
// reload; capped at MAX_QUICK_ACTIONS with an inline warning instead of a
// silent no-op when the user tries to add a 9th.
function CustomizeQuickActionsSheet({ selectedIds, onToggle, onClose, warning }: {
  selectedIds: string[]; onToggle: (id: string) => void; onClose: () => void; warning: boolean;
}) {
  const content = (
    <>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Customize Quick Actions</div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        Choose up to {MAX_QUICK_ACTIONS} actions to pin to your Home dashboard.
      </p>
      {warning && (
        <div style={{
          background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
          color: 'var(--warning)', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, fontWeight: 600,
          marginBottom: 14,
        }}>
          You already have {MAX_QUICK_ACTIONS} actions — remove one to add another.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {QUICK_ACTION_POOL.map(a => {
          const selected = selectedIds.includes(a.id)
          return (
            <div key={a.id} onClick={() => onToggle(a.id)}
              style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 4px', cursor: 'pointer' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: selected ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'var(--surface)',
                border: `1px solid ${selected ? 'var(--brand)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {a.icon}
              </div>
              <span style={{
                fontSize: a.label.length > 10 ? 10.5 : 12, color: 'var(--text-primary)', fontWeight: 400, textAlign: 'center',
                lineHeight: 1.25, width: '100%', wordBreak: 'break-word',
              }}>{a.label}</span>
              <span aria-hidden="true" style={{
                position: 'absolute', top: 10, right: 12, width: 20, height: 20, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: selected ? 'var(--danger)' : 'var(--brand)', color: '#fff',
                fontSize: 14, fontWeight: 700, lineHeight: 1,
              }}>
                {selected ? '−' : '+'}
              </span>
            </div>
          )
        })}
      </div>
      <button onClick={onClose} style={{
        width: '100%', padding: 14, borderRadius: 14, fontSize: 15, fontWeight: 500,
        background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-primary)',
        border: '1px solid var(--border)', cursor: 'pointer',
        marginTop: 16, fontFamily: '-apple-system,sans-serif',
      }}>Done</button>
    </>
  )
  return (
    <DesktopDialogFrame onClose={onClose} maxWidth={420}>
      <div style={{ padding: '24px 20px 28px' }}>{content}</div>
    </DesktopDialogFrame>
  )
}

// ── Insights sub-cards — desktop-only, all fed real computed numbers ───────────
function InsightStatCard({ label, value, changePct, sparkValues }: {
  label: string; value: string; changePct: number | null; icon?: React.ReactNode; sparkValues: number[];
}) {
  const up = (changePct ?? 0) >= 0
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
      padding: '11px 12px', boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      {changePct !== null && (
        <span style={{ fontSize: 10, fontWeight: 600, color: up ? 'var(--success)' : 'var(--danger)' }}>
          {up ? '↑' : '↓'}{Math.abs(changePct).toFixed(0)}%
        </span>
      )}
      <Sparkline values={sparkValues} color="var(--brand)" height={16} />
    </div>
  )
}

function MultichainUsageCard({ chains, total }: { chains: { name: string; pct: number; count: number }[]; total: number }) {
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
      padding: '10px 12px', boxShadow: 'var(--shadow-1)', display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Multichain Usage</div>
      {chains.length === 0 ? (
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>No multichain activity yet</p>
      ) : chains.map(c => (
        <div key={c.name}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 2 }}>
            <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{c.name}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{c.pct.toFixed(0)}%</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${c.pct}%`, height: '100%', background: 'var(--brand)', borderRadius: 2 }} />
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, paddingTop: 5, borderTop: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--text-secondary)' }}>Total Transactions</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{total}</span>
      </div>
    </div>
  )
}

function PaymentIntelligenceCard({ avgPayment, largestPayment, activeHourLabel, frequencyPerDay, receivedChangePct }: {
  avgPayment: number; largestPayment: number; activeHourLabel: string; frequencyPerDay: number; receivedChangePct: number | null;
}) {
  const row = (label: string, value: string, valueColor?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: valueColor || 'var(--text-primary)' }}>{value}</span>
    </div>
  )
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)',
      padding: '10px 12px', boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>Payment Intelligence</div>
      {row('Average Payment', `$${trimTrailingZeros(avgPayment.toFixed(2))}`)}
      {row('Largest Payment', `$${trimTrailingZeros(largestPayment.toFixed(2))}`)}
      {row('Most Active Hour', activeHourLabel)}
      {row('Payment Frequency', `${frequencyPerDay.toFixed(1)}x per day`)}
      {receivedChangePct !== null && row(
        'You Received',
        `${receivedChangePct >= 0 ? '+' : ''}${receivedChangePct.toFixed(0)}%`,
        receivedChangePct >= 0 ? 'var(--success)' : 'var(--danger)',
      )}
    </div>
  )
}

// Activity bar chart — Daily/Weekly/Monthly bucket toggle + hover tooltip.
// `buckets` are precomputed by the caller (see bucketActivity/aggregateBuckets
// below) from real fetched activity records; this component only renders.
function ActivityChartCard({ buckets, granularity, setGranularity, totalCount, periodLabel }: {
  buckets: { label: string; count: number }[]; granularity: 'daily' | 'weekly' | 'monthly';
  setGranularity: (g: 'daily' | 'weekly' | 'monthly') => void; totalCount: number; periodLabel: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const max = Math.max(1, ...buckets.map(b => b.count))
  // Only label a handful of buckets (like the reference's "Aug 1 / Aug 8 /
  // Aug 15…" spacing) — always shown, regardless of bucket count, rather
  // than the old "hide entirely past 12 buckets" rule, which is what made
  // Daily-within-a-month/year read as broken (bars with no axis at all).
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6))
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
      padding: '14px 16px', boxShadow: 'var(--shadow-1)', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>Activity</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>{totalCount} transactions {periodLabel}</div>
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', borderRadius: 9, padding: 2, flexShrink: 0 }}>
          {(['daily', 'weekly', 'monthly'] as const).map(g => (
            <button key={g} onClick={() => setGranularity(g)} style={{
              padding: '4px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 600, textTransform: 'capitalize',
              background: granularity === g ? 'var(--brand)' : 'transparent',
              color: granularity === g ? '#fff' : 'var(--text-secondary)',
            }}>{g}</button>
          ))}
        </div>
      </div>
      {/* overflowX:auto + minWidth:0 on every ancestor up to the grid column
          (see the column wrappers below) is what keeps a large bucket count
          (e.g. Daily within This Year = 365 bars) scrollable INSIDE this
          card instead of forcing the whole page wider than the viewport —
          flex/grid items default to min-width:auto, which otherwise lets a
          wide row of un-shrinkable bars blow out every ancestor up to the
          grid track. */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 2, height: 82, marginTop: 12, overflowX: 'auto', minWidth: 0 }}>
        {hoverIdx !== null && buckets[hoverIdx] && (
          <div style={{
            position: 'absolute', top: -6, left: `${(hoverIdx / Math.max(1, buckets.length - 1)) * 100}%`,
            transform: 'translate(-50%, -100%)', background: 'var(--text-primary)', color: 'var(--bg)',
            fontSize: 10, fontWeight: 600, padding: '4px 7px', borderRadius: 7, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 2,
          }}>
            {buckets[hoverIdx].label}<br />{buckets[hoverIdx].count} transactions
          </div>
        )}
        {buckets.map((b, i) => (
          <div key={i} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}
            style={{ flex: '1 0 6px', minWidth: 6, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'pointer' }}>
            <div style={{
              width: '100%', borderRadius: 3,
              height: `${Math.max(3, (b.count / max) * 100)}%`,
              background: hoverIdx === i ? 'var(--brand)' : 'color-mix(in srgb, var(--brand) 55%, transparent)',
              transition: 'background-color 120ms ease',
            }} />
          </div>
        ))}
      </div>
      {buckets.length > 0 && (
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {buckets.map((b, i) => (
            <span key={i} style={{ flex: '1 0 6px', minWidth: 6, textAlign: 'center', fontSize: 8.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {i % labelStep === 0 ? b.label : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main HomePage ─────────────────────────────────────────────────────────────
// ── P2P Order Alert Popup ───────────────────────────────────────────────────
// Home-screen pop-up cards for the two P2P moments that actually require the
// user to go DO something next: a new order landing on their offer (they
// need to prepare/fulfill it), or a buyer marking payment as sent (the
// seller needs to review and release escrow). Every other P2P event (funds
// released, cancelled, expired, dispute opened/resolved, refund completed)
// is purely informational and already covered by the bell/toast (see
// lib/p2pNotifications.ts) — showing those here too would turn Home into a
// wall of banners for things the user doesn't need to act on right now.
const HOME_POPUP_TYPES = new Set(['buy_order_placed', 'sell_order_placed', 'payment_marked_completed'])

function OrderAlertPopup({ title, body, isPaymentMarked, onOpen, onDismiss }: {
  title: string; body: string; isPaymentMarked: boolean
  onOpen: () => void; onDismiss: (e: React.MouseEvent) => void
}) {
  const accent = isPaymentMarked ? 'var(--warning)' : 'var(--success)'
  return (
    <div
      onClick={onOpen}
      role="button"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: isPaymentMarked ? 'color-mix(in srgb, var(--warning) 10%, transparent)' : 'color-mix(in srgb, var(--success) 10%, transparent)',
        border: `1px solid ${isPaymentMarked ? 'color-mix(in srgb, var(--warning) 35%, transparent)' : 'color-mix(in srgb, var(--success) 35%, transparent)'}`,
        borderRadius: 14, padding: '12px 14px', cursor: 'pointer', position: 'relative',
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 10, flexShrink: 0,
        background: isPaymentMarked ? 'color-mix(in srgb, var(--warning) 18%, transparent)' : 'color-mix(in srgb, var(--success) 18%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isPaymentMarked
          ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingRight: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.35 }}>{body}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginTop: 6 }}>
          {isPaymentMarked ? 'Review & release →' : 'View order →'}
        </div>
      </div>
      {/* X — dismisses this popup only (marks it read); tapping the card
          body itself opens the order/trade page instead. stopPropagation
          keeps the two actions from firing together. */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: '50%',
          background: 'var(--border)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const mnemonic = useAuthStore(s => s.mnemonic)
  const walletSource = useAuthStore(s => s.walletSource)
  const setWallet = useAuthStore(s => s.setWallet)
  const { balance, setBalance } = useWalletStore()
  const { notifications, unreadCount, badgeLabel, addNotification } = useNotificationStore()
  const { showToastMessage } = useUIStore()
  const [handleCopied, setHandleCopied] = useState(false)

  // Newest-first, capped at 3, and DEDUPED PER TRADE — "new order placed"
  // and "payment marked sent" are two stages of the same underlying order,
  // not two separate things, so once the newer one arrives for a trade the
  // older one for that same trade is superseded and should stop showing,
  // not stack up alongside it. Recomputes automatically as notifications
  // arrive via Realtime (this is what makes the swap feel instant — no
  // polling, just reacting to the same live `notifications` array the
  // bell/toast already use) or get dismissed/marked read.
  const homePopups = useMemo(() => {
    const relevant = notifications.filter(n => !n.isRead && HOME_POPUP_TYPES.has(n.type as string))
    const latestPerTrade = new Map<string, typeof relevant[number]>()
    const untracked: typeof relevant = [] // no tradeId to key on — shouldn't happen for these types, but shown as-is rather than silently dropped
    for (const n of relevant) {
      if (!n.tradeId) { untracked.push(n); continue }
      const existing = latestPerTrade.get(n.tradeId)
      if (!existing || new Date(n.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
        latestPerTrade.set(n.tradeId, n)
      }
    }
    return [...latestPerTrade.values(), ...untracked]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 3)
  }, [notifications])

  const [eurcBalance,    setEurcBalance]    = useState(0)
  const [cirBtcBalance,  setCirBtcBalance]  = useState(0)
  const [btcPrice,       setBtcPrice]       = useState(0)
  const [unifiedBalance, setUnifiedBalance] = useState<number | null>(null)
  // Desktop Assets table's real 24h % change column — fetched alongside the
  // BTC price below. `null` per-token means "fetched, unavailable from any
  // source" (renders a "—", never a fabricated number); starts `undefined`
  // (not fetched yet) so mobile — which never triggers this fetch — simply
  // never sets it, and AssetRow's `changePct` prop stays unpassed there.
  const [assetChange24h, setAssetChange24h] = useState<{ USDC: number | null; EURC: number | null; cirBTC: number | null }>({ USDC: null, EURC: null, cirBTC: null })

  // Refreshes whichever balance actually changed — previously every
  // payment-received handler unconditionally called getUSDCBalance()
  // regardless of what token was actually involved, so an EURC or cirBTC
  // payment would show up correctly in Activity but the displayed wallet
  // balance for that specific token would silently stay stale until the
  // next full portfolio refresh (e.g. reopening the app).
  //
  // ── Debounced ────────────────────────────────────────────────────────────
  // This is called from every realtime activity/message handler below,
  // including the general activity subscription that now fires for
  // EXTERNAL deposits too (deposit-scan-all's recordExternalReceive is a
  // plain `activity` insert — no different from any other). A single
  // deposit-scan-all sweep pass can record several rows in quick succession
  // (e.g. two deposits landing close together, or a burst on reconnect), and
  // Realtime delivers each as its own event — without coalescing, that's one
  // RPC balance call per row instead of one per burst. Calls are batched by
  // token symbol behind a short timer instead of firing immediately: any
  // calls arriving within BALANCE_REFRESH_DEBOUNCE_MS of the first one join
  // the same pending batch, and exactly one balance fetch per distinct token
  // fires when the timer elapses. The scheduled 30s/60s poll in the
  // useEffect below this keeps working as the fallback — this only adds an
  // immediate, coalesced refresh on top of it. Both paths now share the
  // same cache/dedup coordinator (BlockchainManager), so if the two land
  // close together they collapse into a single Arc RPC call rather than
  // two.
  const pendingRefreshTokensRef = useRef<Set<string>>(new Set())
  const refreshDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const BALANCE_REFRESH_DEBOUNCE_MS = 600

  const refreshBalanceForToken = (token?: string | null) => {
    const t = (token || 'USDC').toUpperCase()
    pendingRefreshTokensRef.current.add(t)
    if (refreshDebounceTimerRef.current) return // a flush is already scheduled — just joined its batch
    refreshDebounceTimerRef.current = setTimeout(() => {
      const tokens = [...pendingRefreshTokensRef.current]
      pendingRefreshTokensRef.current.clear()
      refreshDebounceTimerRef.current = null
      // Routed through BlockchainManager instead of calling arcService's
      // getters directly — if the scheduled poll (see "Live balance polling"
      // effect below) already fetched this exact token within the last few
      // seconds, this reuses that value instead of firing a second Arc RPC
      // call for the same data. Same coordination the previous
      // balanceCache.ts hop provided, except the cache key now includes the
      // wallet address, so a wallet switch can't serve the old wallet's
      // number (balanceCache keyed by token alone).
      for (const tok of tokens) {
        if (tok === 'EURC')   { readArcBalance(walletAddress, 'EURC').then(setEurcBalance).catch(() => {}); continue }
        if (tok === 'CIRBTC') { readArcBalance(walletAddress, 'CIRBTC').then(setCirBtcBalance).catch(() => {}); continue }
        readArcBalance(walletAddress, 'USDC').then(setBalance).catch(() => {})
      }
    }, BALANCE_REFRESH_DEBOUNCE_MS)
  }

  // Clear any pending debounced refresh on unmount / wallet change so it
  // never fires setState against a stale or gone wallet.
  useEffect(() => {
    return () => {
      if (refreshDebounceTimerRef.current) clearTimeout(refreshDebounceTimerRef.current)
      refreshDebounceTimerRef.current = null
      pendingRefreshTokensRef.current.clear()
    }
  }, [walletAddress])

  // CHANGE 3: Balance visibility toggle
  const [balanceHidden, setBalanceHidden] = useState(() => {
    try { return localStorage.getItem('meshport_balance_hidden') === '1' } catch { return false }
  })
  const toggleBalanceHidden = () => {
    setBalanceHidden(h => {
      const next = !h
      try { localStorage.setItem('meshport_balance_hidden', next ? '1' : '0') } catch {}
      return next
    })
  }

  // ── Home header search: People + Services ──────────────────────────────────
  // Two different matching rules, merged:
  //  - Saved contacts: partial match (e.g. "sub" finds "Suvarna") — you
  //    already know them, so a few letters is enough.
  //  - Anyone NOT already a saved contact: only ever surfaces once the full
  //    "username.arc" handle is typed (via searchUsersDb) — typing a few
  //    letters of a stranger's name should never reveal them.
  const [searchOpen, setSearchOpen] = useState(false)
  // Desktop already gets a search box, notification bell and profile
  // button in DesktopHeader (persistent app-wide chrome) — Home's own
  // identity/search/bell header block below would just duplicate them,
  // so it's skipped on desktop entirely. DesktopHeader now owns its own
  // live search dropdown directly (see DesktopHeader.tsx) rather than
  // routing here — this block's `?search=1` hook-in stays only as a
  // harmless legacy entry point (nothing links to it anymore) and as
  // mobile's own search trigger below, which sets `searchOpen` directly.
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    // Deliberately watches `searchParams` (not mount-only `[]`) — clicking
    // DesktopHeader's search button while already on Home navigates to the
    // same route with just the query string changed, which doesn't remount
    // this component. A mount-only effect would only ever catch the very
    // first time Home loaded with ?search=1, so re-clicking search while
    // already here silently did nothing. Safe to depend on searchParams:
    // the param is deleted immediately after being read, so it can only
    // match '1' once per navigation, not loop.
    if (searchParams.get('search') === '1') {
      setSearchOpen(true)
      setSearchParams(prev => { prev.delete('search'); return prev }, { replace: true })
    }
  }, [searchParams, setSearchParams])
  const [savedContacts, setSavedContactsCache] = useState<DbUser[] | null>(null)
  const [searchPeople, setSearchPeople] = useState<DbUser[]>([])
  const [searching, setSearching] = useState(false)
  const [navigatingId, setNavigatingId] = useState<string | null>(null)

  const searchServices = filterServices(searchQuery)

  // Fetch known people once, lazily, the first time search is opened —
  // merges explicit saved contacts with people from recent send/receive
  // activity (same source Recent already uses), since nothing in the app
  // previously ever wrote to the contacts table, making it effectively
  // always empty and search feel broken for anyone who'd only ever
  // messaged/paid people without an explicit "Add Contact" step.
  useEffect(() => {
    if (!searchOpen || savedContacts !== null || !user?.id || !walletAddress) return

    const loadKnownPeople = async () => {
      const [explicitContacts, recentPeople] = await Promise.all([
        fetchContactsDb(user.id!).catch(() => []),
        (async () => {
          try {
            const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
            const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
            const headers = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
            const myAddr = walletAddress.toLowerCase()
            const [sentRes, recvRes] = await Promise.all([
              fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.send&order=created_at.desc&limit=20&select=counterparty_address`, { headers }),
              fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.receive&order=created_at.desc&limit=20&select=counterparty_address`, { headers }),
            ])
            const [sentRows, recvRows] = await Promise.all([sentRes.json(), recvRes.json()])
            const addrs = [...new Set(
              [...(Array.isArray(sentRows) ? sentRows : []), ...(Array.isArray(recvRows) ? recvRows : [])]
                .map((r: any) => (r.counterparty_address || '').toLowerCase())
                .filter((a: string) => a && a !== myAddr)
            )]
            if (!addrs.length) return []
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase.from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').or(addrs.map(a => `wallet_address.ilike.${a}`).join(','))
            return (data || []) as DbUser[]
          } catch { return [] }
        })(),
      ])

      const removed = getRemovedContacts(walletAddress)
      const merged = new Map<string, DbUser>()
      for (const u of [...explicitContacts, ...recentPeople]) {
        if (!removed.has(u.id)) merged.set(u.id, u)
      }
      setSavedContactsCache([...merged.values()])
    }
    loadKnownPeople()
  }, [searchOpen, user?.id, walletAddress])

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) { setSearchPeople([]); setSearching(false); return }

    const ql = q.toLowerCase().replace(/^@/, '')
    const contactMatches = (savedContacts ?? []).filter(c =>
      (c.display_name || '').toLowerCase().includes(ql) ||
      (c.username || '').toLowerCase().includes(ql)
    )

    // Full .arc handle typed? Also check for a NEW (not-already-known) user.
    const isFullHandle = ql.endsWith('.arc')
    if (!isFullHandle) {
      setSearchPeople(contactMatches.slice(0, 6))
      setSearching(false)
      return
    }

    setSearchPeople(contactMatches.slice(0, 6))
    setSearching(true)
    const timer = setTimeout(() => {
      searchUsersDb(q, user?.id)
        .then(exact => {
          const removed = getRemovedContacts(walletAddress)
          const contactIds = new Set(contactMatches.map(c => c.id))
          const newOnes = exact.filter(u => !contactIds.has(u.id) && !removed.has(u.id))
          setSearchPeople([...contactMatches, ...newOnes].slice(0, 6))
        })
        .catch(() => {})
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, savedContacts, user?.id, walletAddress])

  const openChatWithUser = async (otherUser: { id: string; display_name?: string; username?: string; avatar_url?: string; wallet_address?: string }) => {
    const otherUserId = otherUser.id
    if (!user?.id || navigatingId) return
    setNavigatingId(otherUserId)
    try {
      const { id: convId, error } = await getOrCreateConversation(user.id, otherUserId)
      if (error || !convId) return
      // Warm the chat header cache with what's already on hand right here
      // (this exact user object is what's rendering the search result row
      // being tapped) — keyed by the real conversation id, matching
      // exactly what ChatConversationPage looks up for a non-"new_" route.
      // Without this, the conversation screen has nothing cached to show
      // on this specific entry point and the avatar/name still pop in
      // late even though the data was available the whole time, just one
      // page away.
      const { cacheOtherUser } = await import('@/features/chat/ChatPage')
      cacheOtherUser(convId, otherUser)
      navigate(`/chat/${convId}`)
    } finally {
      setNavigatingId(null)
    }
  }

  const closeSearch = () => { setSearchOpen(false); setSearchQuery('') }

  const highlightMatch = (text: string, query: string) => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <span style={{ color: 'var(--brand)' }}>{text.slice(idx, idx + query.length)}</span>
        {text.slice(idx + query.length)}
      </>
    )
  }

  // CHANGE 4: Total portfolio = USDC + EURC (in USD) + cirBTC (in USD)
  const portfolioTotal = balance + eurcBalance * 1.08 + cirBtcBalance * btcPrice

  // Animated count-up for the balance display — purely visual, never used
  // for anything computed. Balance visibility toggle (below) bypasses this
  // entirely and shows the masked dots straight away, so hiding the
  // balance never has to wait on an in-flight animation.
  const balanceMotion = useMotionValue(portfolioTotal)
  const [displayedBalance, setDisplayedBalance] = useState(portfolioTotal)
  useEffect(() => {
    const controls = animate(balanceMotion, portfolioTotal, {
      duration: 0.6, ease: 'easeOut',
      onUpdate: (v) => setDisplayedBalance(v),
    })
    return () => controls.stop()
  }, [portfolioTotal])

  const [assetSheet,   setAssetSheet]   = useState<'USDC'|'EURC'|'cirBTC'|null>(null)
  // Desktop's Recent Activity panel — tapping a row used to navigate away to
  // /activity entirely (same as "View all"), so there was no way to see a
  // single transaction's detail without leaving Home. Reuses ActivityPage's
  // own DetailSheet popup instead, same as tapping a row on the Activity
  // page itself does — "View all" still correctly navigates to /activity.
  const [selectedActivity, setSelectedActivity] = useState<ActivityRecord | null>(null)
  // Home's real scroll container (below) is its own overflowY:'auto' div,
  // not the window — MyQrCard's scroll-linked reveal needs this ref to
  // measure element positions against the actual scrolling element.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Assets card ref — the QR reveal is driven off THIS crossing a
  // reference point (rather than the QR card's own position), so it
  // starts unfolding as soon as Assets begins scrolling past its resting
  // spot, well before the QR card itself is anywhere near the viewport.
  const assetsCardRef = useRef<HTMLDivElement>(null)
  // The profile header is `position: sticky` INSIDE the scroll container,
  // so the container's own top edge sits at the header's TOP, not its
  // visible bottom — using the container's top as the crossing point
  // meant Assets had to scroll fully underneath the entire header height
  // before the QR reveal even started, leaving too little scroll room
  // afterward to ever finish. This ref lets us use the header's actual
  // rendered bottom edge (stable on-screen since it's sticky) instead.
  const stickyHeaderRef = useRef<HTMLDivElement>(null)
  const [assetHistory, setAssetHistory] = useState<any[]>([])

  // CHANGE 1: More sheet state
  const [showMore, setShowMore] = useState(false)

  // ── Desktop-only: customizable Quick Actions grid ─────────────────────────
  // Persisted so the chosen set survives a reload. Falls back to the
  // original fixed 8 if nothing's saved yet, or if a saved id no longer
  // exists in the pool (e.g. after a future pool change).
  const [quickActionIds, setQuickActionIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('meshport_quick_actions') || 'null')
      if (Array.isArray(saved) && saved.length > 0 && saved.every((id: unknown) => typeof id === 'string')) {
        return saved.filter((id: string) => QUICK_ACTION_POOL.some(a => a.id === id)).slice(0, MAX_QUICK_ACTIONS)
      }
    } catch {}
    return DEFAULT_QUICK_ACTION_IDS
  })
  const [showCustomizeActions, setShowCustomizeActions] = useState(false)
  const [quickActionsLimitWarning, setQuickActionsLimitWarning] = useState(false)
  const toggleQuickAction = (id: string) => {
    setQuickActionIds(prev => {
      if (prev.includes(id)) {
        setQuickActionsLimitWarning(false)
        const next = prev.filter(x => x !== id)
        try { localStorage.setItem('meshport_quick_actions', JSON.stringify(next)) } catch {}
        return next
      }
      if (prev.length >= MAX_QUICK_ACTIONS) {
        setQuickActionsLimitWarning(true)
        return prev
      }
      setQuickActionsLimitWarning(false)
      const next = [...prev, id]
      try { localStorage.setItem('meshport_quick_actions', JSON.stringify(next)) } catch {}
      return next
    })
  }

  // ── Faucet — opens Circle's public faucet (faucet.circle.com) rather than
  // calling their /v1/faucet/drips API directly. That API endpoint's limit
  // ("one request per 24 hours per token, per testnet") is scoped to the
  // whole Circle developer account/API key, not per wallet — so with many
  // MeshPort users sharing one server-side key, only a single claim total
  // would succeed per day app-wide. The public faucet's limit (20 USDC /
  // 2h) is scoped per wallet address instead, which actually scales across
  // users. The wallet address is copied to the clipboard first so the user
  // can just paste it into the faucet page instead of retyping it.
  const handleFaucet = () => {
    if (walletAddress) {
      copyText(walletAddress)
      showToastMessage('Address copied — paste it on the faucet page', 'success')
    }
    window.open('https://faucet.circle.com/', '_blank', 'noopener,noreferrer')
  }

  // ── Realtime: incoming payment notifications ──────────────────────────────
  useEffect(() => {
    if (!walletAddress || !user?.id) return
    let channel: any
    import('@/lib/supabase').then(({ supabase }) => {
      channel = supabase
        .channel('recv-' + user.id.slice(0, 8) + '-' + walletAddress.slice(2, 10).toLowerCase())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload: any) => {
          const msg = payload.new
          if (msg.type !== 'payment_sent') return
          if (!msg.payment_amount || msg.sender_id === user.id) return
          try {
            // If this sender was previously removed, only re-allow them if this
            // payment happened after the removal (a live INSERT always is, but
            // route through the same timestamp-checked helper as the catch-up
            // scan below for consistency) — AND actually save them as a contact
            // (clearing the removed flag alone only let them back into Recent;
            // it never made them a real saved contact, which is the "show
            // everywhere" gap).
            unblockIfNewerActivity(walletAddress, msg.sender_id, msg.created_at)
            if (user?.id) {
              import('@/lib/supabase').then(({ upsertContactDb }) => upsertContactDb(user.id!, msg.sender_id))
            }
            const { data: sender } = await supabase.from('users')
              .select('username,display_name,wallet_address').eq('id', msg.sender_id).maybeSingle()
            // BUG FIX (real column name): the `messages` row has NO `tx_hash`
            // column — chatService.ts/ChatPage.tsx write and read this as
            // `payment_tx_hash`. Every reference below used to say
            // `msg.tx_hash`, which is always `undefined` on the actual
            // Postgres row/realtime payload, so:
            //   1. The Activity.receive() call just below silently NEVER ran
            //      (dead code gated on an always-false condition) — so this
            //      handler never tagged the deposit row `receiveKind:
            //      'p2p_payment'`. That tag is what tells HomePage's own
            //      chain-scan branch (fireIfReceived, further below) to skip
            //      notifying for it — see Activity.receive's own doc comment
            //      on receiveKind. Without it, the row stayed classified
            //      `external_deposit` (set by the server-side deposit
            //      pipeline that also sees this same on-chain transfer),
            //      which IS supposed to notify — so it did, every time.
            //   2. The notification id fell back to `payment_recv_msg_<msg.id>`
            //      unconditionally instead of the tx-hash-keyed
            //      `ext_recv_tx_<hash>` scheme, so it could never dedupe
            //      against arcDepositWatcher.ts's real-time on-chain watcher,
            //      which fires its own `ext_recv_tx_<hash>` notification for
            //      the exact same transfer immediately.
            // Together, that's two independent notifications for one
            // MeshPort-to-MeshPort payment. A genuine external-wallet deposit
            // has no payment_sent message at all — only the watcher path ever
            // runs for it — which is why external deposits already showed
            // correctly as a single notification. Using the real column name
            // fixes both: the activity row gets correctly tagged so the
            // chain-scan path suppresses itself, AND the id here matches the
            // watcher's, so whichever fires first wins and the other dedupes.
            const txHash: string | undefined = msg.payment_tx_hash || undefined
            if (txHash) {
              const { Activity } = await import('@/lib/ActivityService')
              // Activity.receive() already prepends 'recv_' to txHash itself
              // — pass the RAW hash here. Passing an already-prefixed hash
              // produced 'recv_recv_<hash>' rows that never matched
              // deposit-scan-all's own 'recv_<hash>' dedupe key, so its
              // independent chain sweep would record a second, address-only
              // 'External deposit' row for the same payment — the source of
              // both the duplicate Activity entries and the address-instead-
              // of-username notification for payments from other MeshPort users.
              Activity.receive({ walletAddress, txHash: txHash.toLowerCase(),
                amount: msg.payment_amount, tokenSymbol: msg.token_symbol || 'USDC',
                fromAddress: sender?.wallet_address || msg.sender_id || '',
                fromUsername: sender?.username || undefined,
                note: msg.note || undefined,
                receiveKind: 'p2p_payment',
              }).catch(() => {})
            }
            const notifId = txHash ? `ext_recv_tx_${txHash.toLowerCase()}` : `payment_recv_msg_${msg.id}`
            if (sender?.username) notifyPaymentReceived({ id: notifId, amount: msg.payment_amount, fromUsername: sender.username.replace(/\.arc$/, ''), tokenSymbol: msg.token_symbol, createdAt: msg.created_at })
            else notifyPaymentReceivedFromAddress({ id: notifId, amount: msg.payment_amount, fromAddress: msg.sender_id || '0x???', tokenSymbol: msg.token_symbol, createdAt: msg.created_at })
            refreshBalanceForToken(msg.token_symbol)
            import('@/lib/recentContacts').then(({ invalidateRecentContactsCache }) => invalidateRecentContactsCache())
          } catch {}
        }).subscribe()
    })
    return () => { channel?.unsubscribe() }
  }, [walletAddress, user?.id])

  // ── Catch-up: incoming payments received while we weren't listening ───────
  // The realtime subscription above only fires live, the instant a payment_sent
  // message is inserted. If this recipient's app wasn't open at that moment
  // (closed tab, locked phone, etc.) that INSERT event is gone forever and the
  // bell never lights up — even though the payment itself landed fine. This
  // looks back over recent payment_sent messages addressed to this user and
  // fires any notifications that were missed. Uses the same deterministic id
  // (`payment_recv_msg_<message id>`) as the live handler, so the notification
  // store's id-based dedupe makes re-running this on every mount safe — no
  // duplicates, no re-notifying for one already shown.
  useEffect(() => {
    if (!walletAddress || !user?.id) return
    const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
    const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
    if (!SUPA_URL || !SUPA_KEY) return

    ;(async () => {
      try {
        const { supabase } = await import('@/lib/supabase')
        const { authHeaders } = await import('@/lib/chatService')
        const headers = await authHeaders()

        // See migration 20260719090000_notifications_cleared_watermark.sql —
        // without this, a browser whose local storage got wiped would
        // re-discover every payment_sent message within the limit=20
        // window below (regardless of age) and re-notify for all of them,
        // even ones the user already saw and explicitly cleared long ago.
        let since: string | undefined
        const { data: userRow } = await supabase.from('users').select('notifications_cleared_at').eq('id', user.id).maybeSingle()
        since = userRow?.notifications_cleared_at || undefined
        const sinceFilter = since ? `&created_at=gt.${encodeURIComponent(since)}` : ''

        const convRes = await fetch(
          `${SUPA_URL}/rest/v1/conversations?or=(participant_a.eq.${user.id},participant_b.eq.${user.id})&select=id,participant_a,participant_b&limit=100`,
          { headers }
        )
        const convs: any[] = convRes.ok ? await convRes.json() : []
        for (const c of convs) {
          const otherId = c.participant_a === user.id ? c.participant_b : c.participant_a
          if (!otherId) continue
          const msgRes = await fetch(
            `${SUPA_URL}/rest/v1/messages?conversation_id=eq.${c.id}&type=eq.payment_sent&sender_id=eq.${otherId}&select=*&order=created_at.desc&limit=20${sinceFilter}`,
            { headers }
          )
          const msgs: any[] = msgRes.ok ? await msgRes.json() : []
          if (!msgs.length) continue
          const { data: sender } = await supabase.from('users')
            .select('username,display_name,wallet_address').eq('id', otherId).maybeSingle()
          // Only re-allow (and re-save as a contact) if this person's most
          // recent payment happened AFTER they were removed. `msgs` is already
          // ordered newest-first. Without this check, this scan ran on every
          // Home mount and unconditionally undid "Remove contact" for anyone
          // who had EVER paid you — which is nearly everyone you'd remove.
          unblockIfNewerActivity(walletAddress, otherId, msgs[0]?.created_at)
          if (!getRemovedContacts(walletAddress).has(otherId) && user?.id) {
            import('@/lib/supabase').then(({ upsertContactDb }) => upsertContactDb(user.id!, otherId))
          }
          msgs.forEach((msg: any) => {
            if (!msg.payment_amount) return
            // BUG FIX (real column name): see the live-handler effect above —
            // the row has no `tx_hash` column, only `payment_tx_hash`.
            const txHash: string | undefined = msg.payment_tx_hash || undefined
            if (txHash) {
              import('@/lib/ActivityService').then(({ Activity }) => {
                // See the live-handler effect above for why this must be
                // the raw hash — Activity.receive() prepends 'recv_' itself.
                Activity.receive({
                  walletAddress, txHash: txHash.toLowerCase(),
                  amount: msg.payment_amount, tokenSymbol: msg.token_symbol || 'USDC',
                  fromAddress: sender?.wallet_address || otherId || '',
                  fromUsername: sender?.username || undefined,
                  note: msg.note || undefined,
                  receiveKind: 'p2p_payment',
                }).catch(() => {})
              })
            }
            // Same fix as the live-handler effect above: key on tx hash (when
            // present) instead of message id, so this catch-up scan agrees
            // with arcDepositWatcher.ts's `ext_recv_tx_<hash>` id for the same
            // on-chain transfer and the store's dedup collapses them to one.
            const notifId = txHash ? `ext_recv_tx_${txHash.toLowerCase()}` : `payment_recv_msg_${msg.id}`
            if (sender?.username) notifyPaymentReceived({ id: notifId, amount: msg.payment_amount, fromUsername: sender.username.replace(/\.arc$/, ''), tokenSymbol: msg.token_symbol, createdAt: msg.created_at })
            else notifyPaymentReceivedFromAddress({ id: notifId, amount: msg.payment_amount, fromAddress: otherId || '0x???', tokenSymbol: msg.token_symbol, createdAt: msg.created_at })
            refreshBalanceForToken(msg.token_symbol)
          })
        }
      } catch {}
    })()
  }, [walletAddress, user?.id])

  // ── Incoming bulk-payout notifications ──────────────────────────────────────
  // Bulk payouts don't send a chat message, so recipients don't get the listener
  // above — this reacts to the receiver-side activity row BulkPayoutPage writes
  // directly (Activity.bulkReceived), instead of duplicating that insert here.
  //
  // Two paths, both needed:
  //  1) Realtime — fires while this tab is open and subscribed, the instant the
  //     row is inserted.
  //  2) Catch-up — on mount, look back over recent 'bulk' activity rows for this
  //     wallet. Realtime is a live-only stream: if the recipient wasn't online
  //     (app closed / phone locked) at the exact moment the sender ran the bulk
  //     payout, that INSERT event is gone forever and step 1 never fires — the
  //     money still arrives, but the bell never lights up. This backfills those
  //     missed notifications. Both paths use the same deterministic notification
  //     id (`bulk_recv_<activity row id>`), so the notification store's existing
  //     id-based dedupe makes re-running this on every mount safe (no duplicates,
  //     no re-notifying for one already seen).
  useEffect(() => {
    if (!walletAddress) return
    // Final check right before notifying a 'receive' row as an external
    // deposit — independent of, and in addition to, deposit-scan-all's own
    // server-side dedup (which races against the swap's own activity write
    // and can still lose that race depending on deploy/timing). By the
    // moment this actually runs — after the live subscription's round trip,
    // or after a full page load for the catch-up scan — much more time has
    // passed than any server-side race window, so a genuine swap's own
    // 'swap' row is overwhelmingly likely to already exist by now even if
    // the earlier server-side check missed it. Re-queries live rather than
    // trusting anything decided earlier, so this can't be defeated by
    // deployment lag on the server-side fixes.
    // Circle's own Kit/CCTP infrastructure contracts on Arc — mirrors
    // KNOWN_INTERNAL_CONTRACTS in supabase/functions/deposit-scan-all and
    // CIRCLE_CONTRACTS in api/relay-rpc.js (kept in sync manually). A
    // 'receive' row whose counterpartyAddress is one of these is
    // DEFINITIONALLY not a real external payment — e.g. a swap's output
    // leg is a Transfer FROM the Kit Adapter Contract, never from a wallet
    // a real person or exchange controls. This is a hard fact, not a
    // timing-dependent guess like isNearRecentSwap below — checked first,
    // and unlike that check, needs no amount/token matching at all.
    // BUG FIX: was missing Multicall3 (BulkPay's routing contract) — see the
    // matching, more detailed comment in onchainReceivedActivity.ts's own
    // copy of this exact list for the full explanation. Kept in sync with
    // that file and every server-side copy.
    const KNOWN_INTERNAL_CONTRACTS = new Set([
      '0x0077777d7eba4688bdef3e311b846f25870a19b9',
      '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
      '0x7865fafc2db2093669d92c0f33aeef291086befd',
      '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
      '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // Kit Bridge Contract testnet
      '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', // Kit Adapter Contract testnet — swaps route through this
      '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger
      '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter
      '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3 — BulkPay routes through this
    ])
    const isKnownInternalContract = (addr: string | undefined | null): boolean =>
      KNOWN_INTERNAL_CONTRACTS.has((addr || '').toLowerCase())

    const isNearRecentSwap = async (wallet: string, token: string, amount: number): Promise<boolean> => {
      try {
        const { supabase } = await import('@/lib/supabase')
        const since = new Date(Date.now() - 60_000).toISOString()
        const { data } = await supabase
          .from('activity')
          .select('metadata')
          .eq('wallet_address', wallet.toLowerCase())
          .eq('activity_type', 'swap')
          .gte('created_at', since)
        return (data ?? []).some((r: any) => {
          const meta = r.metadata || {}
          const outToken = meta.tokenOut
          const outAmount = parseFloat(meta.amountOut)
          if (!outToken || !Number.isFinite(outAmount)) return false
          return outToken === token && Math.abs(outAmount - amount) <= Math.max(0.01, amount * 0.01)
        })
      } catch { return false } // fail open — never let this check itself block a real notification
    }

    const fireIfReceived = async (record: any) => {
      if (record.activityType === 'bulk') {
        const meta: any = record.metadata || {}
        if (meta.direction !== 'received') return
        const fromLabel = meta.fromUsername || (record.counterpartyAddress
          ? record.counterpartyAddress.slice(0, 6) + '...' + record.counterpartyAddress.slice(-6)
          : 'a bulk payout')
        notifyBulkPaymentReceived({ id: `bulk_recv_${record.id}`, amount: record.amount, fromLabel, purpose: meta.purpose, createdAt: record.createdAt })
        return
      }

      // ── FIX: external-address deposits never notified ──────────────────
      // deposit-scan-all's recordExternalReceive(), claim-recovery-scan's
      // equivalent branch, and the canonical deposit-activity-consumer all
      // write a plain `activity` row of type 'receive'. In-app username
      // payments are deliberately NOT handled here — those are notified via
      // the separate `messages`-table subscription further up this file
      // (or fired directly at write time, e.g. PaySendPage.tsx/rewards.ts), so
      // notifying them again here would double-notify one payment.
      //
      // Classification now uses the explicit metadata.receiveKind every
      // current writer sets (see ActivityService.ts's own comment on it) —
      // NOT a free-form note string. That string-matching WAS the bug: this
      // used to require meta.note === 'External deposit' exactly, and
      // claim-recovery-scan's own writer used a slightly different string
      // ('External deposit (e.g. faucet)') for the same real-world event,
      // so anything it recovered silently never notified. receiveKind is a
      // closed, deliberately-set enum every writer controls directly, so
      // there is no way for two writers to drift out of sync with each
      // other the way two independently-typed free-text strings could.
      //
      // The `meta.note === 'External deposit'` fallback below exists ONLY
      // for rows written before this fix shipped (no receiveKind at all) —
      // it is legacy-compat, not the primary mechanism, and can be deleted
      // once no unclassified 'receive' rows are expected to still surface.
      if (record.activityType === 'receive') {
        const meta: any = record.metadata || {}
        const kind = meta.receiveKind as 'external_deposit' | 'p2p_payment' | 'reward_claim' | undefined
        if (kind === 'p2p_payment' || kind === 'reward_claim') return // already notified at write time
        if (kind === undefined && meta.note !== 'External deposit') return // legacy rows only
        if (kind !== undefined && kind !== 'external_deposit') return // any future kind not yet handled here
        if (isKnownInternalContract(record.counterpartyAddress)) return
        if (walletAddress && await isNearRecentSwap(walletAddress, record.tokenSymbol, record.amount)) return

        // This row came from the chain-scan path (deposit-scan-all /
        // claim-recovery-scan), which only ever sees a raw address — it has
        // no chat message to resolve a username from directly, unlike the
        // two paths above. But the sender might still be a registered
        // MeshPort user who happened to send straight from their wallet
        // address rather than through the in-app Pay flow. Check before
        // falling back to showing the address.
        let fromUsername: string | undefined
        if (record.counterpartyAddress) {
          try {
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase.from('users')
              .select('id,username').eq('wallet_address', record.counterpartyAddress.toLowerCase()).maybeSingle()
            fromUsername = data?.username || undefined
            // A resolved username means the sender IS a registered MeshPort
            // user — auto-add them as a contact, same as the chat-message
            // path already does for in-app payments. This path (chain-scan
            // detected, no chat message) never had this wired at all, which
            // is why a real MeshPort-to-MeshPort payment sent straight from
            // a wallet address (not through the in-app Pay flow) correctly
            // notified with a username but never created a contact/chat.
            if (data?.id && user?.id) {
              import('@/lib/supabase').then(({ upsertContactDb }) => upsertContactDb(user.id!, data.id)).catch(() => {})
            }
          } catch {}
        }

        // Tx-hash-keyed id (was record.id) so this delayed server-row path and
        // the instant client watcher (lib/arcDepositWatcher.ts) fire the SAME
        // notification id for one deposit — whichever lands first wins, the
        // other is deduped by the notification store's seen-ids ledger.
        // Falls back to record.id for a legacy row with no tx hash.
        const notifId = `ext_recv_tx_${record.txHash || record.id}`
        if (fromUsername) {
          notifyPaymentReceived({
            id: notifId,
            amount: record.amount,
            fromUsername: fromUsername.replace(/\.arc$/, ''),
            tokenSymbol: record.tokenSymbol,
            createdAt: record.createdAt,
          })
        } else {
          notifyPaymentReceivedFromAddress({
            id: notifId,
            amount: record.amount,
            fromAddress: record.counterpartyAddress || '0x???',
            tokenSymbol: record.tokenSymbol,
            createdAt: record.createdAt,
          })
        }
      }
    }

    let unsub: (() => void) | undefined
    import('@/lib/ActivityService').then(({ subscribeToActivity, fetchActivity }) => {
      // Live updates while the app is open. Fires for every new activity
      // insert on this wallet; fireIfReceived() itself decides which rows
      // warrant a notification (bulk-received, or an external-deposit
      // 'receive' row — see its definition above). refreshBalanceForToken()
      // runs for every row regardless, so the balance refresh rides the
      // same event as the activity row appearing, and the two feel
      // simultaneous to the user. refreshBalanceForToken is debounced (see
      // its definition above) so a burst of several rows arriving close
      // together — e.g. one deposit-scan-all sweep pass recording multiple
      // deposits — collapses into a single balance fetch per token instead
      // of one per row.
      // Serializes fireIfReceived calls — a burst of activity rows landing
      // close together (several deposits in the same deposit-scan-all
      // sweep pass, or several rapid payments) used to call the async
      // fireIfReceived concurrently, once per row, with no ordering
      // guarantee between them. Each call does its own awaited Supabase
      // work (username lookup, contact upsert, recent-swap check) before
      // reaching the notification-store dedup check — overlapping those
      // async calls is exactly the kind of race that can cause some
      // notifications in a burst to go missing while others show up fine.
      // Chaining onto the same promise forces one call to fully finish
      // (including its addNotification) before the next one starts.
      let fireQueue = Promise.resolve()
      // Extra guard, in front of the notification store's own id dedup —
      // three independent paths can each discover the very same activity
      // row and hand it to onNew: the live realtime INSERT event, this
      // subscription's own internal reconnect catch-up (see catchUp()'s
      // onReconnect in ActivityService.ts — common on a weak mobile signal,
      // which flaps the WebSocket), and HomePage's separate catch-up IIFE
      // just below, which runs unawaited on every mount. All three
      // eventually route through addNotification with the same
      // deterministic `ext_recv_<id>`, which should dedupe on its own — but
      // that check only fires once each call actually reaches it, after its
      // own awaited work (username lookup, isNearRecentSwap). Two of these
      // paths overlapping for the same fresh row, on a spotty connection
      // right after a reconnect, is exactly the kind of narrow window where
      // that intended protection wasn't enough — reproduced as one $1.00
      // external deposit notifying twice, "just now" both times. Tracking
      // processed row ids here, before any async work even starts, closes
      // that window regardless of which of the three paths delivers first.
      const processedRowIds = new Set<string>()
      const queuedFireIfReceived = (record: any) => {
        if (record?.id) {
          if (processedRowIds.has(record.id)) return
          processedRowIds.add(record.id)
        }
        fireQueue = fireQueue.then(() => fireIfReceived(record)).catch((e) => console.error('[HomePage] fireIfReceived failed:', e?.message))
      }

      unsub = subscribeToActivity(walletAddress, (record) => {
        queuedFireIfReceived(record)
        refreshBalanceForToken((record as any).tokenSymbol)
      })
      // Catch up on anything received while we weren't listening — bulk
      // payouts and external-address deposits (deposit-scan-all /
      // claim-recovery-scan) both land here since neither sends a chat
      // message that the messages-table subscription elsewhere would catch.
      // Respects notifications_cleared_at (see the migration
      // 20260719090000_notifications_cleared_watermark.sql) so a browser
      // whose local storage got wiped doesn't resurrect everything the
      // user already cleared before — that boundary is checked
      // server-side now, not just via the local seen-ids ledger.
      ;(async () => {
        let since: string | undefined
        if (user?.id) {
          try {
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase.from('users').select('notifications_cleared_at').eq('id', user.id).maybeSingle()
            since = data?.notifications_cleared_at || undefined
          } catch {}
        }
        Promise.all([
          fetchActivity(walletAddress, { activityType: 'bulk', limit: 30, since }),
          fetchActivity(walletAddress, { activityType: 'receive', limit: 30, since }),
        ])
          .then(([bulkRows, receiveRows]) => { bulkRows.forEach(queuedFireIfReceived); receiveRows.forEach(queuedFireIfReceived) })
          .catch(() => {})
      })()
    })
    return () => { unsub?.() }
  }, [walletAddress])

  // ── Instant balance on a real-time external deposit ───────────────────────
  // The session-wide Arc log watcher (lib/arcDepositWatcher.ts, started in
  // AppLayout) dispatches 'meshport:arc-deposit' the moment a Transfer to this
  // wallet is seen on-chain — seconds, not the 2-4 min the server
  // chain_events -> activity-consumer pipeline takes. Refresh the balance for
  // exactly that token right away, so the number moves with the notification
  // instead of waiting for the next 30s poll or the Supabase row. The
  // notification itself is fired by the watcher (deduped against
  // fireIfReceived's now-tx-hash-keyed id), and the Activity list is handled
  // by useActivity's own buffer merge — this effect is purely the balance.
  useEffect(() => {
    if (!walletAddress) return
    const onArcDeposit = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      refreshBalanceForToken(detail.tokenSymbol)
    }
    window.addEventListener('meshport:arc-deposit', onArcDeposit)
    return () => window.removeEventListener('meshport:arc-deposit', onArcDeposit)
  }, [walletAddress])


  // ── Auto-restore private key ──────────────────────────────────────────────
  useEffect(() => {
    const run = async () => {
      if (!privateKey && (walletAddress || mnemonic)) {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey().catch(() => {})
      }
      // A mnemonic_hint backfill for older accounts used to live here,
      // writing the raw mnemonic to Supabase in PLAINTEXT — a critical
      // security issue, fixed and then removed entirely along with the
      // whole server-side backup design. MeshPort no longer stores private
      // keys or recovery phrases server-side at all, in any form — see
      // restoreWallet.ts for the current, local-only recovery paths.
    }
    run()
  }, [walletAddress])

  // ── Verify address matches private key ───────────────────────────────────
  useEffect(() => {
    if (!privateKey) return
    deriveAddressFromPrivateKey(privateKey).then(viemAddress => {
      if (walletAddress && walletAddress.toLowerCase() !== viemAddress.toLowerCase()) {
        setWallet(viemAddress, privateKey, mnemonic || undefined, walletSource || undefined)
      }
      if (username && viemAddress) {
        import('@/lib/usernameRegistry').then(({ registerUsername }) => {
          registerUsername({ username, walletAddress: viemAddress, displayName: user?.displayName || username, email: user?.email })
        })
      }
    }).catch(() => {})
  }, [privateKey, walletAddress])

  // ── Live balance polling ──────────────────────────────────────────────────
  // Both the USDC read and the EURC/cirBTC reads go through
  // BlockchainManager.readArcBalance() instead of calling getUSDCBalance()
  // directly / re-implementing the eth_call here. That fixes two things
  // that used to independently hit Arc's RPC:
  //   - This poll and the debounced realtime refresh above were hitting
  //     EURC/cirBTC through two totally separate, uncached code paths
  //     (arcService's getEURCBalance/getCirBtcBalance vs. an inline
  //     fetchToken() here using the same contracts) — now both funnel
  //     through one cached/deduped path.
  //   - On mount, fetchBalance() and fetchPortfolio() used to fire
  //     together (3 concurrent Arc RPC calls in the same tick — the most
  //     likely trigger for the 429s). They now run sequentially with a
  //     short stagger. The 60s portfolio interval also starts 15s offset
  //     from the 30s balance interval so the two never land on the same
  //     tick (previously they'd coincide every 60s: t=60,120,180…).
  useEffect(() => {
    if (!walletAddress && !privateKey) return
    const address = walletAddress || ''
    if (!address) return
    let cancelled = false
    let retryCount = 0

    const fetchBalance = async () => {
      try {
        const bal = await readArcBalance(address, 'USDC')
        if (!cancelled) {
          // A genuine increase means new funds landed since the last
          // check — dispatching the same event useActivity.ts's on-chain
          // received layer already listens for directly links "balance
          // went up" to "Activity list refreshes right now", rather than
          // leaving these as two independently-timed polls that could
          // drift apart by however many seconds separate their intervals.
          const previousBalance = useWalletStore.getState().balance
          if (typeof previousBalance === 'number' && bal > previousBalance) {
            window.dispatchEvent(new CustomEvent('meshport:onchain-activity'))
          }
          setBalance(bal); retryCount = 0
        }
      } catch {
        if (retryCount < 3) { retryCount++; setTimeout(fetchBalance, 3000 * retryCount) }
      }
    }

    const fetchPortfolio = async () => {
      const fetchBtcPrice = async (): Promise<number> => {
        // Try multiple sources in order — CoinGecko often rate-limits free tier
        const sources = [
          async () => {
            const r = await fetch(
              'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
              { signal: AbortSignal.timeout(5000) }
            )
            if (!r.ok) throw new Error(`CoinGecko ${r.status}`)
            const p = (await r.json())?.bitcoin?.usd
            if (!p) throw new Error('No price')
            return p as number
          },
          async () => {
            // Binance public API — no auth needed
            const r = await fetch(
              'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
              { signal: AbortSignal.timeout(5000) }
            )
            if (!r.ok) throw new Error(`Binance ${r.status}`)
            const p = parseFloat((await r.json())?.price ?? '0')
            if (!p) throw new Error('No price')
            return p
          },
          async () => {
            // CoinCap — reliable fallback
            const r = await fetch(
              'https://api.coincap.io/v2/assets/bitcoin',
              { signal: AbortSignal.timeout(5000) }
            )
            if (!r.ok) throw new Error(`CoinCap ${r.status}`)
            const p = parseFloat((await r.json())?.data?.priceUsd ?? '0')
            if (!p) throw new Error('No price')
            return p
          },
        ]
        for (const source of sources) {
          try { return await source() } catch { /* try next */ }
        }
        return 0
      }
      // Desktop-only — the Assets table's real "Change (24h)" column. One
      // batched CoinGecko call for all three tokens' real 24h % change; no
      // Binance/CoinCap fallback for the % itself (neither exposes it as
      // simply), so a failure here just leaves assetChange24h as null per
      // token and AssetRow renders "—" rather than a guessed number.
      const fetchChange24h = async () => {
        if (!isDesktop) return
        try {
          const r = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,euro-coin,bitcoin&vs_currencies=usd&include_24hr_change=true',
            { signal: AbortSignal.timeout(5000) }
          )
          if (!r.ok) throw new Error(`CoinGecko ${r.status}`)
          const data = await r.json()
          if (cancelled) return
          setAssetChange24h({
            USDC: typeof data?.['usd-coin']?.usd_24h_change === 'number' ? data['usd-coin'].usd_24h_change : null,
            EURC: typeof data?.['euro-coin']?.usd_24h_change === 'number' ? data['euro-coin'].usd_24h_change : null,
            cirBTC: typeof data?.bitcoin?.usd_24h_change === 'number' ? data.bitcoin.usd_24h_change : null,
          })
        } catch { /* leave as null — no fabricated change % */ }
      }

      // BUG FIX (2026-09-03): the actual on-chain EURC/cirBTC balance reads
      // used to be bundled into the SAME Promise.all as fetchBtcPrice() and
      // fetchChange24h() below — both external CoinGecko/Binance/CoinCap
      // calls, each with up to a 5s timeout and (fetchBtcPrice) up to THREE
      // sequential fallback attempts if the first source is slow or
      // rate-limited (CoinGecko's free tier "often rate-limits", per that
      // function's own comment) — worst case, up to ~15s. Since it was one
      // Promise.all, setEurcBalance/setCirBtcBalance couldn't fire until
      // ALL FOUR calls settled, so a slow/rate-limited price lookup for
      // purely cosmetic data (USD-equivalent estimate, 24h % change badge)
      // directly delayed the REAL balance numbers from appearing — while
      // USDC's balance, fetched separately by fetchBalance() with no price
      // calls attached at all, showed up fast. This is the direct cause of
      // "EURC and cirBTC balance loads late while USDC loads fine": the
      // balance was never actually slow, it was queued behind an unrelated
      // API call. Split into two independent tracks: the real balance
      // reads resolve and render on their own, as fast as they always
      // could; price/24h-change are strictly best-effort enrichment that
      // arrives whenever it arrives, never gating the balance display.
      const balancesPromise = Promise.all([
        readArcBalance(address, 'EURC').catch(() => 0),
        readArcBalance(address, 'CIRBTC').catch(() => 0),
      ]).then(([eurc, cirbtc]) => {
        if (cancelled) return
        setEurcBalance(eurc); setCirBtcBalance(cirbtc)
      })

      const priceEnrichmentPromise = Promise.all([
        fetchBtcPrice(),
        fetchChange24h(),
      ]).then(([btcP]) => {
        if (cancelled) return
        // Cache last known BTC price in sessionStorage so it survives API failures
        if (btcP > 0) {
          sessionStorage.setItem('meshport_btc_price', String(btcP))
          setBtcPrice(btcP)
        } else {
          const cached = parseFloat(sessionStorage.getItem('meshport_btc_price') || '0')
          if (cached > 0) setBtcPrice(cached)
        }
      })

      // Still awaited together here so the CALLER (the mount sequence
      // below) knows when this whole pass is fully done for polling-
      // interval purposes — but by this point both setEurcBalance/
      // setCirBtcBalance already fired independently, as soon as their own
      // fast on-chain reads resolved, not gated on the slow branch.
      await Promise.all([balancesPromise, priceEnrichmentPromise])
    }

    let bi: ReturnType<typeof setInterval> | null = null
    let pi: ReturnType<typeof setInterval> | null = null
    let piStartTimer: ReturnType<typeof setTimeout> | null = null

    ;(async () => {
      await fetchBalance()
      if (cancelled) return
      await new Promise(r => setTimeout(r, 250)) // stagger — avoid firing USDC + EURC + cirBTC in the same tick
      if (cancelled) return
      await fetchPortfolio()
      if (cancelled) return
      // PHASE 6 — balance poll lengthened 30s -> 90s, NOT removed.
      // deposit_detected now invalidates the wallet's Arc scope via
      // SyncCoordinator, so a real credit lands on the event. This tick remains
      // the fallback for a throttled/backgrounded tab, a dropped Realtime
      // socket, or SYNC_COORDINATOR_ENABLED being flipped off.
      bi = setInterval(fetchBalance, 90_000)
      piStartTimer = setTimeout(() => {
        if (cancelled) return
        pi = setInterval(fetchPortfolio, 120_000)
      }, 15_000) // offset so this tick never coincides with the balance tick
    })()

    return () => {
      cancelled = true
      if (bi) clearInterval(bi)
      if (pi) clearInterval(pi)
      if (piStartTimer) clearTimeout(piStartTimer)
    }
  }, [walletAddress])

  // ── Scan external chain balances ──────────────────────────────────────────
  // Admin Panel → Chains toggles. Re-scanning whenever settings change means
  // a chain disabled by an admin drops out of this total immediately, same
  // as it already does on the Hub and Claim page.
  const settingsMap = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    // Guards against the 60s interval and a visibilitychange (tab
    // refocus) firing at nearly the same moment — without this, that
    // overlap runs two full 21-chain scans concurrently (up to 42
    // simultaneous requests across the external RPCs). Skips the second
    // trigger instead; the next tick or the next refocus picks it up.
    let inFlight = false
    const scan = () => {
      if (inFlight) return
      inFlight = true
      readExternalTotal(walletAddress, settingsMap, settingsLoaded).then(total => {
        if (!cancelled) setUnifiedBalance(total > 0.001 ? total : null)
      }).catch(() => {}).finally(() => { inFlight = false })
    }
    scan()
    const iv = setInterval(scan, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible' && !cancelled) scan() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
  }, [walletAddress, settingsMap, settingsLoaded])

  if (!user) return null

  const displayName = user.displayName || username || (user.username || '').replace(/\.arc$/, '') || 'User'
  const shortAddr = walletAddress ? walletAddress.slice(0, 6) + '...' + walletAddress.slice(-6) : ''
  const arcHandle = (username || '').replace(/\.arc$/, '') + '.arc'

  const openAssetHistory = async (token: 'USDC'|'EURC'|'cirBTC') => {
    setAssetSheet(token)
    if (!walletAddress) return
    try {
      const { fetchActivity } = await import('@/lib/ActivityService')
      if (token === 'USDC') {
        const records = await fetchActivity(walletAddress, { limit: 100 })
        const usdcTypes = new Set(['send', 'receive', 'claim', 'bridge', 'deposit', 'bulk'])
        const usdcNonSwap = records.filter(r => usdcTypes.has(r.activityType) && (r.tokenSymbol || 'USDC') === 'USDC')
        // Swaps are fetched separately (fetchActivity's default type filter
        // doesn't cover 'swap' the way the non-swap types above do) and
        // merged in — a USDC->EURC swap moves USDC too, so it belongs in
        // USDC's history same as EURC's. AssetSheet itself figures out
        // which side (in/out) applies to the token being viewed.
        const swapRecords = await fetchActivity(walletAddress, { activityType: 'swap', limit: 100 })
        const usdcSwaps = swapRecords.filter(r => r.metadata?.tokenIn === 'USDC' || r.metadata?.tokenOut === 'USDC')
        setAssetHistory([...usdcNonSwap, ...usdcSwaps].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()))
      } else {
        // Was swap-only before — a direct receive of EURC/cirBTC (not via
        // a swap) never showed up here at all, which is exactly why
        // cirBTC's history could appear completely empty for a wallet
        // that had only ever received it directly. Now matches USDC's own
        // logic: direct activity for this specific token, merged with any
        // swaps that moved it.
        const directTypes = new Set(['send', 'receive', 'claim', 'bridge', 'deposit', 'bulk'])
        const records = await fetchActivity(walletAddress, { limit: 100 })
        const directForToken = records.filter(r => directTypes.has(r.activityType) && r.tokenSymbol === token)

        const swapRecords = await fetchActivity(walletAddress, { activityType: 'swap', limit: 100 })
        const swapsForToken = swapRecords.filter(r => r.metadata?.tokenIn === token || r.metadata?.tokenOut === token)

        setAssetHistory([...directForToken, ...swapsForToken].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()))
      }
    } catch { setAssetHistory([]) }
  }

  // ── Desktop-only: Insights column + Recent Activity + Balance trend ────────
  // Skipped entirely on mobile (none of these widgets render there) so no
  // extra network round-trip happens on the phone-shell experience. Fetches
  // BOTH the selected Insights period AND the prior equal-length period in
  // one query (since = start of the prior period), so every "vs last
  // period" percentage below is a real comparison, never a guess.
  const PERIOD_DAYS: Record<'week' | 'month' | 'year', number> = { week: 7, month: 30, year: 365 }
  const [insightsPeriod, setInsightsPeriod] = useState<'week' | 'month' | 'year'>('month')
  const [activityGranularity, setActivityGranularity] = useState<InsightsGranularity>('daily')
  const [homeRecentActivity, setHomeRecentActivity] = useState<ActivityRecord[]>([])
  useEffect(() => {
    if (!isDesktop || !walletAddress) return
    let cancelled = false
    ;(async () => {
      const { fetchActivity } = await import('@/lib/ActivityService')
      const days = PERIOD_DAYS[insightsPeriod]
      const since = new Date(Date.now() - days * 2 * 86400000).toISOString()
      const records = await fetchActivity(walletAddress, { limit: 500, since })
      if (!cancelled) setHomeRecentActivity(records)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, walletAddress, insightsPeriod])

  // Balance card's mini trend — always the trailing 7 days regardless of the
  // Insights period selector (the fetch above always covers >= 14 days, so a
  // 7-day slice is always fully present). Cumulative running NET (received −
  // sent) per day — a relative trend line, not a fabricated historical
  // balance series this app has no snapshot data for.
  const balanceTrend = useMemo(() => {
    const shells = makeBuckets(7, 'daily', new Date())
    let running = 0
    return shells.map(b => {
      const net = homeRecentActivity
        .filter(r => { const t = new Date(r.createdAt).getTime(); return t >= b.start && t < b.end })
        .reduce((s, r) => {
          const sign = activitySign(r.activityType, r.metadata?.direction)
          return s + (sign === '+' ? r.amount : sign === '-' ? -r.amount : 0)
        }, 0)
      running += net
      return running
    })
  }, [homeRecentActivity])

  const todayChange = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const net = homeRecentActivity
      .filter(r => new Date(r.createdAt).getTime() >= startOfToday.getTime())
      .reduce((s, r) => {
        const sign = activitySign(r.activityType, r.metadata?.direction)
        return s + (sign === '+' ? r.amount : sign === '-' ? -r.amount : 0)
      }, 0)
    return { net, pct: portfolioTotal > 0 ? (net / portfolioTotal) * 100 : 0 }
  }, [homeRecentActivity, portfolioTotal])

  // Insights card — every figure below is computed straight from the fetched
  // ActivityRecords for the selected period (`current`) vs. the immediately
  // preceding equal-length window (`prior`), no fabricated inputs.
  const insightsData = useMemo(() => {
    const days = PERIOD_DAYS[insightsPeriod]
    const now = Date.now()
    const periodStart = now - days * 86400000
    const prevStart = now - days * 2 * 86400000
    const current = homeRecentActivity.filter(r => new Date(r.createdAt).getTime() >= periodStart)
    const prior = homeRecentActivity.filter(r => { const t = new Date(r.createdAt).getTime(); return t >= prevStart && t < periodStart })

    const sumSign = (recs: ActivityRecord[], want: '+' | '-') =>
      recs.reduce((s, r) => activitySign(r.activityType, r.metadata?.direction) === want ? s + r.amount : s, 0)
    const pctChange = (curr: number, prev: number): number | null => {
      if (prev === 0) return curr === 0 ? null : 100
      return ((curr - prev) / prev) * 100
    }
    const distinctContacts = (recs: ActivityRecord[]) => new Set(
      recs.filter(r => (r.activityType === 'send' || r.activityType === 'receive' || r.activityType === 'bulk') && r.counterpartyAddress)
        .map(r => r.counterpartyAddress!.toLowerCase())
    ).size

    const sent = sumSign(current, '-')
    const received = sumSign(current, '+')
    const priorSent = sumSign(prior, '-')
    const priorReceived = sumSign(prior, '+')
    const activeContacts = distinctContacts(current)
    const priorActiveContacts = distinctContacts(prior)
    const totalVolume = current.reduce((s, r) => s + r.amount, 0)

    // Most active contact — most transactions with a single counterparty this period
    const contactCounts = new Map<string, { count: number; label: string }>()
    current.forEach(r => {
      if ((r.activityType !== 'send' && r.activityType !== 'receive' && r.activityType !== 'bulk') || !r.counterpartyAddress) return
      const key = r.counterpartyAddress.toLowerCase()
      const uname = ((r.metadata?.toUsername || r.metadata?.fromUsername || '') as string).replace(/\.arc$/, '')
      const label = uname || (key.slice(0, 6) + '...' + key.slice(-4))
      const entry = contactCounts.get(key)
      if (entry) entry.count++
      else contactCounts.set(key, { count: 1, label })
    })
    let mostActiveContact: { label: string; count: number } | null = null
    for (const v of contactCounts.values()) {
      if (!mostActiveContact || v.count > mostActiveContact.count) mostActiveContact = v
    }

    const swaps = current.filter(r => r.activityType === 'swap')
    const swapVolume = swaps.reduce((s, r) => s + r.amount, 0)

    const payments = current.filter(r => r.activityType === 'send' || r.activityType === 'receive')
    const avgPayment = payments.length ? payments.reduce((s, r) => s + r.amount, 0) / payments.length : 0
    const largestPayment = payments.length ? Math.max(...payments.map(r => r.amount)) : 0
    const hourCounts = new Array(24).fill(0)
    current.forEach(r => hourCounts[new Date(r.createdAt).getHours()]++)
    const topHour = hourCounts.every(c => c === 0) ? null : hourCounts.indexOf(Math.max(...hourCounts))
    const activeHourLabel = topHour === null ? '—' : new Date(2000, 0, 1, topHour).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const frequencyPerDay = current.length / days

    // Multichain Usage — bridge/claim/deposit rows grouped by source chain
    const multiRecords = current.filter(r => r.activityType === 'bridge' || r.activityType === 'claim' || r.activityType === 'deposit')
    const chainCounts = new Map<string, number>()
    multiRecords.forEach(r => {
      const chain = (r.sourceChain || r.destinationChain || 'Unknown').replace(/_/g, ' ')
      chainCounts.set(chain, (chainCounts.get(chain) || 0) + 1)
    })
    const multichainTotal = multiRecords.length
    const chains = [...chainCounts.entries()]
      .map(([name, count]) => ({ name, count, pct: multichainTotal > 0 ? (count / multichainTotal) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)

    return {
      current, sent, received, activeContacts, totalVolume,
      netFlow: received - sent,
      sentChangePct: pctChange(sent, priorSent),
      receivedChangePct: pctChange(received, priorReceived),
      activeContactsChangePct: pctChange(activeContacts, priorActiveContacts),
      mostActiveContact, swapVolume, swapCount: swaps.length,
      avgPayment, largestPayment, activeHourLabel, frequencyPerDay,
      chains, multichainTotal,
    }
  }, [homeRecentActivity, insightsPeriod])

  // Year is bucketed monthly instead of daily purely for chart legibility
  // (365 daily bars vs. 12 monthly ones) — same real per-record data either way.
  const insightsBucketGranularity: InsightsGranularity = insightsPeriod === 'year' ? 'monthly' : 'daily'
  const volumeTrendBuckets = useMemo(
    () => aggregateBuckets(insightsData.current, PERIOD_DAYS[insightsPeriod], insightsBucketGranularity, new Date()),
    [insightsData.current, insightsPeriod, insightsBucketGranularity],
  )
  const sentTrendBuckets = useMemo(
    () => aggregateBuckets(insightsData.current.filter(r => activitySign(r.activityType, r.metadata?.direction) === '-'), PERIOD_DAYS[insightsPeriod], insightsBucketGranularity, new Date()),
    [insightsData.current, insightsPeriod, insightsBucketGranularity],
  )
  const receivedTrendBuckets = useMemo(
    () => aggregateBuckets(insightsData.current.filter(r => activitySign(r.activityType, r.metadata?.direction) === '+'), PERIOD_DAYS[insightsPeriod], insightsBucketGranularity, new Date()),
    [insightsData.current, insightsPeriod, insightsBucketGranularity],
  )
  const contactsTrendBuckets = useMemo(() => {
    const shells = makeBuckets(PERIOD_DAYS[insightsPeriod], insightsBucketGranularity, new Date())
    return shells.map(b => {
      const recs = insightsData.current.filter(r => {
        const t = new Date(r.createdAt).getTime()
        return t >= b.start && t < b.end && (r.activityType === 'send' || r.activityType === 'receive' || r.activityType === 'bulk') && r.counterpartyAddress
      })
      return new Set(recs.map(r => r.counterpartyAddress!.toLowerCase())).size
    })
  }, [insightsData.current, insightsPeriod, insightsBucketGranularity])
  const activityBuckets = useMemo(
    () => aggregateBuckets(insightsData.current, PERIOD_DAYS[insightsPeriod], activityGranularity, new Date()),
    [insightsData.current, insightsPeriod, activityGranularity],
  )

  // BUG FIX: same as ActivityPage.tsx's formatAmt — the "n < 0.01" fallback
  // below only went to 4 decimals for non-BTC tokens, which rounds a
  // USDC/EURC amount like 0.000004 to "0.0000" (then "0" after trimming).
  // The fine-precision tiers now apply regardless of symbol.
  const fmt = (n: number, symbol?: string) => {
    const abs = Math.abs(n)
    const sym = (symbol || '').toLowerCase()
    const isBtcLike = sym.includes('btc') || sym.includes('eth')
    let decimals: number
    if (abs < 0.0001) decimals = 8
    else if (abs < 0.01) decimals = 6
    else decimals = isBtcLike ? 4 : 2
    return trimTrailingZeros(n.toFixed(decimals)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  return (
    <div ref={scrollContainerRef} style={{
      flex: 1, overflowY: 'auto', background: 'var(--bg)',
      // Desktop: sized to exactly fill the viewport at 100% browser zoom (see
      // the compact card sizing throughout this column) so nothing scrolls
      // under normal conditions — but overflowY stays 'auto', never 'hidden',
      // so content remains fully reachable by scrolling if the user zooms
      // their browser in past 100% (accessibility), rather than being clipped.
      display: isDesktop ? 'flex' : undefined, flexDirection: isDesktop ? 'column' : undefined,
    }}>

      {/* ── HEADER — floating card, no border ─────────────────────────────── */}
      {/* Desktop: DesktopHeader already covers profile/search/notifications
          app-wide, so this block only mounts there while actively searching
          (opened via DesktopHeader's search box, see isDesktop above). */}
      {(!isDesktop || searchOpen) && (
      <div ref={stickyHeaderRef} style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'color-mix(in srgb, var(--bg) 70%, transparent)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)',
        paddingBottom: 6, paddingLeft: 20, paddingRight: 20,
        boxSizing: 'border-box',
      }}>
        <div style={{
          borderRadius: 14, padding: '14px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 40,
        }}>
          {searchOpen ? (
            <>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', borderRadius: 20, padding: '0 14px', height: 40 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search people, services..."
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13 }}
                />
              </div>
              <button onClick={closeSearch} style={{ background: 'none', border: 'none', color: 'var(--brand)', fontSize: 14, fontWeight: 600, marginLeft: 10, cursor: 'pointer', flexShrink: 0 }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                {user?.avatar ? (
                  <div onClick={() => navigate('/profile')} style={{ cursor: 'pointer', flexShrink: 0, width: 47, height: 47, borderRadius: '50%', padding: 2, background: 'var(--brand)' }}>
                    <img src={user.avatar.split('?')[0]} alt="avatar"
                      loading="eager" decoding="async"
                      style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--bg)' }}/>
                  </div>
                ) : (
                  <div onClick={() => navigate('/profile')} style={{ cursor: 'pointer', flexShrink: 0, width: 47, height: 47, borderRadius: '50%', padding: 2, background: 'var(--brand)' }}>
                    <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--brand)', border: '2px solid var(--bg)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 17, fontWeight: 700 }}>
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</div>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      const ok = await copyToClipboard(arcHandle)
                      setHandleCopied(true)
                      showToastMessage(ok ? 'Username copied' : 'Could not copy username', ok ? 'success' : 'error')
                      setTimeout(() => setHandleCopied(false), 1500)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--link)', fontFamily: 'monospace' }}>{arcHandle}</span>
                    {handleCopied
                      ? <Check className="w-3 h-3 text-success flex-shrink-0" />
                      : <Copy className="w-3 h-3 text-link/60 flex-shrink-0" />}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {/* Search */}
                <button onClick={() => setSearchOpen(true)}
                  style={{ width: 38, height: 38, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                {/* Bell — notifications */}
                <button onClick={() => navigate('/notifications')}
                  style={{ position: 'relative', width: 38, height: 38, borderRadius: '50%',
                    background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 15%, transparent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                    <path d="M9 1.5A5.5 5.5 0 0113.5 7v3l1.5 2H3L4.5 10V7A5.5 5.5 0 019 1.5z" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M7 13.5a2 2 0 004 0" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                  {(unreadCount > 0 || badgeLabel) && (
                    <span style={{ position: 'absolute', top: 7, right: 8, width: 6, height: 6,
                      background: 'var(--danger)', borderRadius: '50%' }}/>
                  )}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Search results — grouped People / Services */}
        {searchOpen && searchQuery.trim() && (
          <div style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--brand) 25%, transparent)', borderRadius: 18, marginTop: 8, padding: '4px 10px 10px', maxHeight: '60vh', overflowY: 'auto' }}>
            {searching && searchPeople.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>Searching...</p>
            )}

            {searchPeople.length > 0 && (
              <>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '12px 0 4px 6px' }}>People</div>
                {searchPeople.map(p => (
                  <div key={p.id} onClick={() => openChatWithUser(p)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderRadius: 12, cursor: 'pointer', opacity: navigatingId === p.id ? 0.5 : 1 }}>
                    <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                      {(p.display_name || p.username || 'U').charAt(0).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{highlightMatch(p.display_name || p.username || '', searchQuery.trim())}</div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{(p.username || '').replace(/\.arc$/, '')}.arc</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {searchServices.length > 0 && (
              <>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '12px 0 4px 6px' }}>Services</div>
                {searchServices.map(s => (
                  <div key={s.path} onClick={() => { closeSearch(); navigate(s.path) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderRadius: 12, cursor: 'pointer' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 10, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/></svg>
                    </div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{highlightMatch(s.label, searchQuery.trim())}</div>
                  </div>
                ))}
              </>
            )}

            {!searching && searchPeople.length === 0 && searchServices.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
                {searchQuery.trim().toLowerCase().endsWith('.arc')
                  ? `No results for "${searchQuery.trim()}"`
                  : 'No saved contact matches — enter the full username.arc to find someone new'}
              </p>
            )}
          </div>
        )}
      </div>
      )}

      <div className="lg:max-w-[1500px]" style={{
        padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 12,
        flex: isDesktop ? 1 : undefined, minHeight: isDesktop ? 0 : undefined,
      }}>

        {/* ── P2P ORDER ALERTS — new order received / payment marked as paid ── */}
        {homePopups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10 }}>
            {homePopups.map(n => {
              // Clears every popup-type notification for this SAME trade, not
              // just the one currently visible — dedup above already hid an
              // earlier "order placed" notification once "payment marked"
              // arrived for the same trade, but that older one is still
              // sitting unread in the store with no popup left to reach it
              // from. Interacting with the current (latest) one resolves
              // the whole trade's popup thread together, matching "both are
              // one order popup" — not two separate things to individually
              // dismiss.
              const clearTradePopups = () => {
                if (!n.tradeId) { markP2PNotificationRead(n.id); return }
                for (const other of notifications) {
                  if (other.tradeId === n.tradeId && HOME_POPUP_TYPES.has(other.type as string) && !other.isRead) {
                    markP2PNotificationRead(other.id)
                  }
                }
              }
              return (
                <OrderAlertPopup
                  key={n.id}
                  title={n.title}
                  body={n.body}
                  isPaymentMarked={n.type === 'payment_marked_completed'}
                  onOpen={() => {
                    clearTradePopups()
                    navigate(n.tradeId ? `/p2p/trade/${n.tradeId}` : '/p2p/my-trades')
                  }}
                  onDismiss={(e) => { e.stopPropagation(); clearTradePopups() }}
                />
              )
            })}
          </div>
        )}

        {/* Desktop: 3 columns — Balance/Multichain Hub/Recent/Assets far left;
            Quick Actions/Recent Activity in the middle; Insights on the
            right. Mobile keeps its original flat stacking order below
            (flex-col) — only the lg:col/row-start placement below reorders
            things visually at desktop width; DOM order is untouched. */}
        <div className="flex flex-col gap-[18px] lg:grid lg:grid-cols-[2.7fr_1.15fr] lg:gap-4 lg:items-start lg:flex-1 lg:min-h-0 lg:min-w-0">
        {/* ── COLUMNS 1+2 WRAPPER — column 2 (Quick Actions/Recent Activity)
             needs to match column 1's bottom edge, NOT the grid row's full
             height (which is set by whichever column is tallest — column 3
             here — items-stretch on the outer grid matched column 2 to
             THAT instead of column 1, leaving a large gap under it). This
             wrapper groups columns 1+2 into their own nested flex row
             (items-stretch scoped to just these two, independent of
             column 3), sized to the taller of the two — which is always
             column 1 in practice. `contents` makes this wrapper invisible
             to mobile's layout (its children render exactly as if they
             were direct children of the flex-col stack above, unchanged)
             — it only becomes a real flex row at `lg:`. */}
        <div className="contents lg:flex lg:col-start-1 lg:row-start-1 lg:items-stretch lg:gap-4 lg:min-w-0">
        {/* ── LEFT COLUMN — Balance / Multichain Hub / Pay&Receive / Recent /
             Assets, all in ONE grid cell (col-start-1, row-start-1) stacked
             internally via flexbox. Keeping every left-column piece in a
             single cell (rather than each on its own row-start) means this
             column's height is never forced to match the right column's —
             see the right column's own comment below for why that matters. */}
        <div className="flex flex-col gap-[18px] lg:gap-3 lg:flex-[1.7] lg:min-w-0">
        {/* ── BALANCE — shows all tokens total, eye toggles visibility ────────
             Desktop gets a bordered card with the address chip moved to the
             top-right and two real additions below the number: today's net
             change (computed from homeRecentActivity, not fabricated) and a
             7-day cumulative-net trend line (balanceTrend, see above). Mobile
             branch below is byte-identical to before this change. */}
        {isDesktop ? (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '14px 18px', boxShadow: 'var(--shadow-1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Total Balance</span>
                <button onClick={toggleBalanceHidden}
                  style={{ width: 26, height: 26, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
                    border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  {balanceHidden ? (
                    <svg width="14" height="11" viewBox="0 0 22 18" fill="none">
                      <path d="M2 2l18 14" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round"/>
                      <path d="M6.5 5.5A9.7 9.7 0 011 9c2 3.5 5.5 6 10 6a9.5 9.5 0 005.5-1.8" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round"/>
                      <path d="M9 3.5A10 10 0 0121 9a10.3 10.3 0 01-2.5 3.5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round"/>
                      <circle cx="11" cy="9" r="3" stroke="var(--text-secondary)" strokeWidth="1.5"/>
                    </svg>
                  ) : (
                    <svg width="14" height="10" viewBox="0 0 22 16" fill="none">
                      <ellipse cx="11" cy="8" rx="10" ry="7" stroke="var(--text-secondary)" strokeWidth="1.5"/>
                      <circle cx="11" cy="8" r="3" stroke="var(--text-secondary)" strokeWidth="1.5"/>
                    </svg>
                  )}
                </button>
              </div>
              <div onClick={() => { copyText(walletAddress || ''); showToastMessage('Address copied', 'success') }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '6px 10px' }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', letterSpacing: '0.2px' }}>{shortAddr}</span>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="5" y="1" width="10" height="10" rx="2" stroke="var(--brand)" strokeWidth="1.4"/>
                  <path d="M1 5v9a1 1 0 001 1h9" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 4 }}>
              {balanceHidden ? (
                <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-1.5px', lineHeight: 1, color: 'var(--text-primary)' }}>••••••</span>
              ) : (
                <>
                  <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-1.5px', lineHeight: 1 }}>${fmt(displayedBalance).split('.')[0]}</span>
                  <span style={{ fontSize: 20, fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 1 }}>.{fmt(displayedBalance).split('.')[1]}</span>
                </>
              )}
            </div>
            {!balanceHidden && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: todayChange.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ transform: todayChange.net >= 0 ? 'none' : 'rotate(180deg)' }}>
                    <path d="M5 1v8M5 1L1.5 4.5M5 1l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {todayChange.pct >= 0 ? '+' : ''}{todayChange.pct.toFixed(2)}%
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {todayChange.net >= 0 ? '+' : '-'}${trimTrailingZeros(Math.abs(todayChange.net).toFixed(2))} today
                </span>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <Sparkline values={balanceTrend} color={todayChange.net >= 0 ? 'var(--success)' : 'var(--danger)'} height={26} fill />
            </div>
          </div>
        ) : (
        <div style={{ background: 'var(--brand)', borderRadius: 16, padding: '12px 16px 0', overflow: 'hidden', width: '95%', margin: '0 auto' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
            <span style={{ fontSize: 16, color: '#fff', fontWeight: 500 }}>Available Balance</span>
            <button onClick={toggleBalanceHidden}
              style={{ position: 'absolute', right: 0, width: 26, height: 26, borderRadius: '50%', background: 'transparent',
                border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              {balanceHidden ? (
                <svg width="16" height="13" viewBox="0 0 22 18" fill="none">
                  <path d="M2 2l18 14" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M6.5 5.5A9.7 9.7 0 011 9c2 3.5 5.5 6 10 6a9.5 9.5 0 005.5-1.8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M9 3.5A10 10 0 0121 9a10.3 10.3 0 01-2.5 3.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="11" cy="9" r="3" stroke="#fff" strokeWidth="1.5"/>
                </svg>
              ) : (
                <svg width="16" height="12" viewBox="0 0 22 16" fill="none">
                  <ellipse cx="11" cy="8" rx="10" ry="7" stroke="#fff" strokeWidth="1.5"/>
                  <circle cx="11" cy="8" r="3" stroke="#fff" strokeWidth="1.5"/>
                </svg>
              )}
            </button>
          </div>
          <div onClick={() => { copyText(walletAddress || ''); showToastMessage('Address copied', 'success') }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer', marginBottom: 11 }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', fontFamily: 'monospace', letterSpacing: '0.2px' }}>
              {shortAddr}
            </span>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="5" y="1" width="10" height="10" rx="2" stroke="rgba(255,255,255,0.75)" strokeWidth="1.4"/>
              <path d="M1 5v9a1 1 0 001 1h9" stroke="rgba(255,255,255,0.75)" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </div>
        {(() => {
          // Auto-shrink the balance figure so large amounts (6+ digits)
          // stay inside the white pill instead of overflowing past it —
          // normal balances (up to 5 digits before the decimal) keep the
          // original 38px untouched.
          // fmt() adds thousand-separator commas (e.g. "1,420") for the
          // asset-history table elsewhere in this file, where that reads
          // naturally — but this hero figure is meant to show the plain
          // number, so strip the commas back out here specifically rather
          // than changing fmt() itself and affecting every other caller.
          const formattedBalance = fmt(displayedBalance).replace(/,/g, '')
          const wholePart = formattedBalance.split('.')[0].replace(/[^0-9]/g, '')
          const digitCount = wholePart.length
          const amountFontSize = digitCount >= 9 ? 20 : digitCount >= 8 ? 24 : digitCount >= 7 ? 27 : digitCount >= 6 ? 30 : 34
          // BUG FIX: fmt() already trims a whole-number balance down to
          // "1,420" (no decimal point at all, see trimTrailingZeros in
          // lib/utils.ts) — but this split-into-two-spans layout always
          // rendered a literal "." before the decimal-part span regardless
          // of whether one actually existed. React renders {undefined} as
          // nothing, so that hardcoded "." was the ONLY thing left behind:
          // a whole-number balance showed as "$1,420." with a dangling dot
          // and no digits after it. Only render the decimal span (and its
          // leading dot) when there's a real decimal part to show.
          const decimalPart = formattedBalance.split('.')[1]
          return (
        <div style={{ background: 'var(--surface)', borderRadius: '12px 12px 0 0', padding: '10px 16px 1px', margin: '0 16%', textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 4, marginBottom: 0, lineHeight: 1 }}>
              <span style={{ fontSize: amountFontSize, fontWeight: 700, lineHeight: 1, color: 'var(--text-primary)' }}>$</span>
              {balanceHidden ? (
                <span style={{ fontSize: amountFontSize, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1, color: 'var(--text-primary)' }}>••••••</span>
              ) : (
                <>
                  <span style={{ fontSize: amountFontSize, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1, color: 'var(--text-primary)' }}>
                    {formattedBalance.split('.')[0]}
                  </span>
                  {decimalPart ? (
                    <span style={{ fontSize: amountFontSize, fontWeight: 700, lineHeight: 1, color: 'var(--text-primary)' }}>
                      .{decimalPart}
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <span onClick={() => navigate('/activity')} style={{ fontSize: 14, color: 'var(--brand)', fontWeight: 500, cursor: 'pointer', display: 'inline-block', marginTop: 1 }}>
              View Transactions
            </span>
          </div>
          )
        })()}
        </div>
        )}

        {/* ── QUICK ACTIONS — all 4, above the Multichain Hub card ──────────── */}
        {/* Mobile only. Desktop is unaffected: it never rendered this row
            (its own Quick Actions card lives in column 2). */}
        {!isDesktop && (
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '95%', margin: '0 auto' }}>
          {[
            { label: 'Pay',     path: '/pay-send',    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
            { label: 'Receive', path: '/receive', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
            { label: 'Swap',    path: '/swap',    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 7h13M4 7l3-3M4 7l3 3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 17H7M20 17l-3 3M20 17l-3-3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
            { label: 'More',    path: null,       icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="7" height="7" rx="1.5" fill="#fff"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="#fff"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="#fff"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="#fff"/></svg> },
          ].map(a => (
            <div key={a.label}
              onClick={() => a.path ? navigate(a.path) : setShowMore(true)}
              className="transition-[box-shadow,transform] duration-200 hover:shadow-elevation-2"
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 8, cursor: 'pointer',
              }}>
              <div style={{
                width: 55, height: 55, borderRadius: '50%', background: 'var(--brand)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {a.icon}
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, lineHeight: 1 }}>{a.label}</span>
            </div>
          ))}
        </div>
        )}

        {/* ── MULTICHAIN — single card, click navigates to hub ─────────────── */}
        {/* Renders on mobile too (just flows inline there) — only the
            isDesktop-gated style values change; mobile keeps padding:14/16,
            radius:16 exactly as before. hover:shadow/translate classes are
            harmless additions on mobile since touch devices never :hover. */}
        <div
          onClick={() => navigate('/multichain')}
          className="transition-[box-shadow,transform] duration-200 hover:shadow-elevation-2 lg:hover:-translate-y-0.5"
          style={{
            background: 'var(--surface)', borderRadius: isDesktop ? 16 : 16,
            border: '1px solid var(--border)',
            padding: isDesktop ? '12px 16px' : '14px 16px',
            boxShadow: isDesktop ? 'var(--shadow-1)' : undefined,
            display: 'flex', alignItems: 'center', gap: 12,
            cursor: 'pointer',
          }}>
          <div style={{
            width: isDesktop ? 34 : 42, height: isDesktop ? 34 : 42, borderRadius: '50%',
            background: 'var(--brand)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#fff" strokeWidth="1.4"/>
              <ellipse cx="9" cy="9" rx="4" ry="8" stroke="#fff" strokeWidth="1.4"/>
              <line x1="1" y1="9" x2="17" y2="9" stroke="#fff" strokeWidth="1.4"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Multichain Hub</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              {unifiedBalance !== null && unifiedBalance > 0
                ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>${fmt(unifiedBalance)} available</span>
                : 'Claim & transfer across chains'}
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M5 3l6 5-6 5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* ── RECENT — people I sent money to ──────────────────────────────── */}
        {/* Desktop-only bordered card, same language as the Multichain Hub
            card above it. Mobile keeps the plain unboxed wrapper. */}
        <div style={isDesktop ? {
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16,
          padding: '12px 16px', boxShadow: 'var(--shadow-1)',
        } : undefined}>
        <RecentRow navigate={navigate} compact={isDesktop} resultLimit={isDesktop ? 7 : 5} />
        </div>

        {/* ── ASSETS — all 3 tokens ────────────────────────────────────────── */}
        <div ref={assetsCardRef}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isDesktop ? 6 : 12 }}>
            <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>Assets</span>
            <button onClick={handleFaucet}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: 15.4, color: 'var(--brand)', fontWeight: 500,
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 3s6 6.5 6 10.5a6 6 0 01-12 0C6 9.5 12 3 12 3z" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round"/>
              </svg>
              Faucet
            </button>
          </div>
          {isDesktop && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 14px', marginBottom: 4, fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <span style={{ flex: 1 }}>Asset</span>
              <span style={{ minWidth: 64, textAlign: 'right' }}>Change (24h)</span>
              <span style={{ minWidth: 90, textAlign: 'right' }}>Value (USD)</span>
            </div>
          )}
          <div style={{ background: 'var(--surface)', borderRadius: isDesktop ? 18 : 16, border: '1px solid var(--border)', overflow: 'hidden', boxShadow: isDesktop ? 'var(--shadow-1)' : undefined }}>
            <AssetRow
              icon="https://assets.coingecko.com/coins/images/6319/small/usdc.png"
              fallbackColor="var(--usdc-icon)" fallbackChar="$"
              name="USDC" sub="USD Coin"
              cryptoAmount={`${fmt(balance)} USDC`}
              usdValue={`$${fmt(balance)}`}
              usdColor="var(--brand)"
              onClick={() => openAssetHistory('USDC')}
              hidden={balanceHidden}
              changePct={isDesktop ? assetChange24h.USDC : undefined}
              border
            />
            <AssetRow
              icon="https://assets.coingecko.com/coins/images/26045/small/euro-coin.png"
              fallbackColor="var(--usdc-icon)" fallbackChar="€"
              name="EURC" sub="Euro Coin"
              cryptoAmount={`${fmt(eurcBalance)} EURC`}
              usdValue={`$${fmt(eurcBalance * 1.08)}`}
              usdColor="var(--brand)"
              onClick={() => openAssetHistory('EURC')}
              hidden={balanceHidden}
              changePct={isDesktop ? assetChange24h.EURC : undefined}
              border
            />
            <AssetRow
              icon="https://assets.coingecko.com/coins/images/1/small/bitcoin.png"
              fallbackColor="#F7931A" fallbackChar="₿"
              name="cirBTC" sub="Celo Bitcoin"
              cryptoAmount={`${cirBtcBalance > 0 ? trimTrailingZeros(cirBtcBalance < 0.0001 ? cirBtcBalance.toFixed(8) : cirBtcBalance.toFixed(6)) : '0'} cirBTC`}
              usdValue={cirBtcBalance > 0 && btcPrice === 0 ? "Fetching..." : `$${trimTrailingZeros((cirBtcBalance * btcPrice).toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`}
              usdColor="var(--warning)"
              onClick={() => openAssetHistory('cirBTC')}
              hidden={balanceHidden}
              changePct={isDesktop ? assetChange24h.cirBTC : undefined}
            />
          </div>
        </div>

        {/* ── Biometric row — desktop: right below Assets card. ────────────── */}
        {isDesktop && <BiometricFooterRow isDesktop />}

        {/* ── MY QR — below Assets card. Mobile only. ─────────────────────── */}
        {!isDesktop && <MyQrCard walletAddress={walletAddress} username={username} scrollContainerRef={scrollContainerRef} assetsCardRef={assetsCardRef} />}
        {/* ── Biometric row — mobile: right below the QR card. ─────────────── */}
        {!isDesktop && <BiometricFooterRow isDesktop={false} />}
        </div>
        {/* ── COLUMN 2 — Quick Actions + Recent Activity. Desktop only, a
             flex item inside the columns-1+2 wrapper above (stretches to
             column 1's height via that wrapper's items-stretch, not the
             grid row's). */}
        <div className="hidden lg:flex lg:flex-1 lg:min-w-0" style={{ flexDirection: 'column', gap: 12 }}>
          <QuickActionsCard navigate={navigate} actionIds={quickActionIds} onCustomize={() => { setQuickActionsLimitWarning(false); setShowCustomizeActions(true) }} />

          {/* Recent activity — flex:1 so its bottom edge always lands on
              column 1/3's bottom edge (the grid row's real height, via
              items-stretch above) instead of wherever its own N rows of
              content happen to end. Internally scrollable so extra items
              beyond what fits are still reachable rather than overflowing. */}
          <div style={{
            display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto',
            background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
            padding: '12px 14px', boxShadow: 'var(--shadow-1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Recent Activity</span>
              <span onClick={() => navigate('/activity')} style={{ fontSize: 11.5, color: 'var(--brand)', fontWeight: 600, cursor: 'pointer' }}>View all</span>
            </div>
            {homeRecentActivity.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', padding: '20px 0' }}>No recent activity</p>
            ) : homeRecentActivity.slice(0, 8).map((r, i) => {
              const sign = activitySign(r.activityType, r.metadata?.direction)
              const color = sign === '+' ? 'var(--success)' : sign === '-' ? 'var(--danger)' : 'var(--text-secondary)'
              const { title: rowTitle } = deriveActivityRow(r)
              return (
                <div key={r.id} onClick={() => setSelectedActivity(r)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                  borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none',
                  cursor: 'pointer',
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: sign === '+' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--danger) 12%, transparent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                      {sign === '+'
                        ? <path d="M12 2L2 12M2 12H8M2 12V6" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        : <path d="M2 12L12 2M12 2H6M12 2V8" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>}
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rowTitle}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 1 }}>{timeAgo(r.createdAt)}</div>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color, flexShrink: 0 }}>{sign}{fmt(r.amount, r.tokenSymbol)} {r.tokenSymbol}</div>
                </div>
              )
            })}
          </div>
        </div>
        </div>
        {/* ── COLUMN 3 — Insights. Desktop only, ONE grid cell (col-start-2 of
             the 2-track grid — columns 1+2 above are combined into ONE
             track via the nested flex wrapper, so this is the grid's
             second and last real track), internal flexbox stacking — CSS
             Grid sizes a row-track to the TALLEST cell sharing that row
             across ALL columns, so giving each card its own row-start here
             would stretch the shorter column-1/column-2 rows to match this
             much taller column, reopening the gap bug already fixed once
             this session. Every number below comes from insightsData
             (useMemo above, computed from real fetched ActivityRecords for
             the selected period vs. the prior equal-length period) — none
             of it is fabricated. */}
        <div className="hidden lg:flex lg:col-start-2 lg:row-start-1 lg:min-w-0" style={{ flexDirection: 'column', gap: 10 }}>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
            padding: '12px 16px', boxShadow: 'var(--shadow-1)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Insights</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>Your payment intelligence</div>
              </div>
              <div style={{ display: 'flex', gap: 3, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', borderRadius: 9, padding: 3, flexShrink: 0 }}>
                {(['week', 'month', 'year'] as const).map(p => (
                  <button key={p} onClick={() => setInsightsPeriod(p)} style={{
                    padding: '4px 7px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontSize: 9.5, fontWeight: 600, whiteSpace: 'nowrap',
                    background: insightsPeriod === p ? 'var(--brand)' : 'transparent',
                    color: insightsPeriod === p ? '#fff' : 'var(--text-secondary)',
                  }}>{p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'This Year'}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Total Volume</div>
              <div style={{ fontSize: 27, fontWeight: 700, color: 'var(--text-primary)', marginTop: 1 }}>${trimTrailingZeros(insightsData.totalVolume.toFixed(2))}</div>
            </div>
            <Sparkline values={volumeTrendBuckets.map(b => b.volume)} color="var(--brand)" height={34} fill />
            <div style={{ display: 'flex', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>Net Flow</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: insightsData.netFlow >= 0 ? 'var(--success)' : 'var(--danger)', marginTop: 1 }}>
                  {insightsData.netFlow >= 0 ? '+' : '-'}${trimTrailingZeros(Math.abs(insightsData.netFlow).toFixed(2))}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>Most Active Contact</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {insightsData.mostActiveContact ? insightsData.mostActiveContact.label : '—'}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>Swap Volume</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand)', marginTop: 1 }}>${trimTrailingZeros(insightsData.swapVolume.toFixed(2))}</div>
                <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{insightsData.swapCount} swaps</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <InsightStatCard
              label="Paid" value={`$${insightsData.sent.toFixed(2)}`} changePct={insightsData.sentChangePct}
              sparkValues={sentTrendBuckets.map(b => b.volume)}
              icon={<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 12L12 2M12 2H6M12 2V8" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            />
            <InsightStatCard
              label="Received" value={`$${insightsData.received.toFixed(2)}`} changePct={insightsData.receivedChangePct}
              sparkValues={receivedTrendBuckets.map(b => b.volume)}
              icon={<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 2L2 12M2 12H8M2 12V6" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            />
            <InsightStatCard
              label="Active Contacts" value={`${insightsData.activeContacts}`} changePct={insightsData.activeContactsChangePct}
              sparkValues={contactsTrendBuckets}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3" stroke="var(--brand)" strokeWidth="1.6"/><path d="M3 20v-1a6 6 0 016-6h0a6 6 0 016 6v1" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round"/><circle cx="17" cy="8" r="2.4" stroke="var(--brand)" strokeWidth="1.4"/></svg>}
            />
          </div>

          <ActivityChartCard
            buckets={activityBuckets.map(b => ({ label: b.label, count: b.count }))}
            granularity={activityGranularity} setGranularity={setActivityGranularity}
            totalCount={insightsData.current.length}
            periodLabel={insightsPeriod === 'week' ? 'this week' : insightsPeriod === 'month' ? 'this month' : 'this year'}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <MultichainUsageCard chains={insightsData.chains} total={insightsData.multichainTotal} />
            <PaymentIntelligenceCard
              avgPayment={insightsData.avgPayment} largestPayment={insightsData.largestPayment}
              activeHourLabel={insightsData.activeHourLabel} frequencyPerDay={insightsData.frequencyPerDay}
              receivedChangePct={insightsData.receivedChangePct}
            />
          </div>
        </div>
      </div>
      </div>

      {/* ── MORE ACTIONS SHEET ───────────────────────────────────────────────── */}
      {showMore && <MoreSheet onClose={() => setShowMore(false)} navigate={navigate} />}

      {/* ── CUSTOMIZE QUICK ACTIONS SHEET ────────────────────────────────────── */}
      {showCustomizeActions && (
        <CustomizeQuickActionsSheet
          selectedIds={quickActionIds}
          onToggle={toggleQuickAction}
          onClose={() => setShowCustomizeActions(false)}
          warning={quickActionsLimitWarning}
        />
      )}

      {/* ── ASSET HISTORY SHEET ─────────────────────────────────────────────── */}
      {assetSheet && (
        <AssetSheet token={assetSheet} history={assetHistory} onClose={() => setAssetSheet(null)} />
      )}
      {selectedActivity && (
        <DetailSheet record={selectedActivity} onClose={() => setSelectedActivity(null)} />
      )}
    </div>
  )
}
