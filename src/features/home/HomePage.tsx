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
        let since: string | undefi
