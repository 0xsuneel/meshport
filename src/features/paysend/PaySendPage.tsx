import { useState, useEffect, useLayoutEffect, useRef, useMemo, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import {
  Search, ChevronRight, ChevronDown, ArrowLeft, Wallet, Copy, Check,
  AlertCircle, X, Loader2, CheckCircle2, QrCode,
  User, Zap, FileText, Globe, Clock, ExternalLink, Activity as ActivityIcon, RotateCcw, Home,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { useWalletStore, useAuthStore, useUIStore } from '@/store'
import { formatAmount, shortenAddress, midShortenAddress, timeAgo, copyToClipboard } from '@/lib/utils'
import { amountFontSize } from '@/lib/amountFontSize'
import { sendUSDC, sendEURC, estimateTransferFee, isValidAddress, confirmTransactionInBackground } from '@/lib/arcService'
import { arcRpcJson } from '@/lib/arc'
import { notifyRewardSend } from '@/lib/notifications'
import { searchUsersDb, getUserByWalletAddress, fetchContactsDb, fetchConversations, type DbUser } from '@/lib/supabase'
import { useSettingsStore } from '@/store/settingsStore'
import { isCoinEnabled } from '@/lib/featureFilters'
import { fetchRecentContacts } from '@/lib/recentContacts'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { saveResumableOperation, getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton, DesktopHistoryDetail } from '@/components/ui/DesktopHistoryPanel'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'

type Screen = 'search' | 'amount' | 'review'
type Token = 'USDC' | 'EURC' | 'cirBTC'
type ProcessStage = 'idle' | 'verifying' | 'preparing' | 'sending' | 'confirming' | 'delivered' | 'failed'

// USDC/EURC are both ~$1-pegged, so 3 decimals used to read fine — but
// that cap also silently rounded away dust-size amounts (e.g. a real
// 0.000004 USDC payment showed as "$0"). Now that every display in this
// file trims trailing zeros (see formatAmount in lib/utils.ts), there's no
// downside to giving every token full 8-decimal precision — a normal "5
// USDC" still renders as "5", not "5.00000000" — so this now matches
// AmountKeypad.tsx's decimalCap (also raised to 8 for every token).
function tokenDisplayDecimals(t: Token): number {
  return 8
}
function tokenSymbolChar(t: Token): string {
  return t === 'USDC' ? '$' : t === 'EURC' ? '€' : '₿'
}

interface Recipient {
  id?: string
  display: string
  displayName: string
  walletAddress: string
  isUsername: boolean
  avatarUrl?: string | null
  enteredViaAddress?: boolean  // true only when user explicitly typed/pasted a wallet address
}

const QUICK_AMOUNTS = [10, 20, 50, 100]

// Small four-point sparkle glyph (24x24) scattered decoratively around the
// success badge — purely cosmetic, so it's fine for these few icons to be
// absolutely positioned inside their own small fixed-size wrapper without
// that counting as "main layout" absolute positioning.
const SPARKLE_PATH = 'M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z'
function Sparkle({ size, style }: { size: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', ...style }}>
      <path d={SPARKLE_PATH} fill="rgba(255,255,255,0.55)" />
    </svg>
  )
}

// One row of the Transaction details card (icon-in-circle + label on the
// left, value on the right), with an optional copy button and an optional
// bottom divider for every row but the last.
function TxDetailRow({ icon, label, value, mono, onCopy, copied, showDivider, last }: {
  icon: ReactNode; label: string; value: string; mono?: boolean
  onCopy?: () => void; copied?: boolean; showDivider?: boolean; last?: boolean
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        // `last` (only the final row, Time — the one with no divider below
        // it, when the Process checklist is collapsed) gets a smaller
        // bottom padding than every other row: -10% off the shared value,
        // top padding untouched. That shaves the card's total height off
        // its bottom edge only — every row's own top padding, and every
        // row before this one, stays exactly as it was, so nothing shifts
        // upward. Nothing inside any row (icon size, font sizes) changed.
        //
        // Padding trimmed down from the original clamp(13px, 2.85vh, 18px)
        // — noticeably tighter, but deliberately kept above the bare
        // minimum so rows still have breathing room, not a cramped list.
        paddingTop: 'clamp(9px, 1.9vh, 12px)',
        paddingBottom: last ? 'clamp(8.1px, 1.71vh, 10.8px)' : 'clamp(9px, 1.9vh, 12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(10px, 2.6vw, 13px)', minWidth: 0 }}>
          <div style={{
            width: 'clamp(32px, 8.5vw, 38px)', height: 'clamp(32px, 8.5vw, 38px)', borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--brand)',
          }}>
            {icon}
          </div>
          <span style={{ fontSize: 'clamp(14px, 3.6vw, 16px)', color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{
            fontSize: 'clamp(13.3px, 3.42vw, 15.2px)', fontWeight: mono ? 500 : 700, color: 'color-mix(in srgb, var(--text-primary) 100%, white 12%)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{value}</span>
          {onCopy && (
            <button onClick={onCopy} title="Copy" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0, color: 'var(--text-secondary)', display: 'flex' }}>
              {copied ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {showDivider && <div style={{ height: 1, background: 'var(--border)' }} />}
    </div>
  )
}

// One row of the "Process" checklist shown inside the success screen's
// "More details" expansion — a completed step, always shown as done
// (green check circle) since this checklist only ever renders after the
// payment has already succeeded.
function ProcessStep({ text, last }: { text: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: last ? 0 : 'clamp(10px, 2.2vh, 14px)' }}>
      <div style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--brand)', color: '#fff',
      }}>
        <Check className="w-3 h-3" strokeWidth={3} />
      </div>
      <span style={{ fontSize: 'clamp(13px, 3.4vw, 14.5px)', color: 'var(--text-primary)', lineHeight: 1.4 }}>{text}</span>
    </div>
  )
}

// Digit/decimal sanitizing for the desktop "Amount" native input (mirrors
// AmountKeypad's own internal sanitizer, which isn't exported).
// BUG FIX: this used to hardcode a 2-decimal cap regardless of token,
// making it impossible to even TYPE a cirBTC amount finer than 0.01 --
// takes the target token so the cap matches tokenDisplayDecimals (8 for
// cirBTC, 3 otherwise).
function sanitizeSendAmount(raw: string, decimals: number = 3): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, decimals)
  return cleaned
}

export function PaySendPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const locationState = (location.state || {}) as { returnTo?: string; conversationId?: string }
  const user = useAuthStore(s => s.user)
  const senderStoredAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance, setBalance } = useWalletStore()
  const { sendRecipient, setSendRecipient, showToastMessage } = useUIStore()
  const settingsMap = useSettingsStore((s) => s.settings)

  const [savedContacts, setSavedContacts] = useState<DbUser[]>([])

  // Resolve any recipient we already have synchronously (recent-avatar tap via
  // sendRecipient, or a payment-link `?to=` param) BEFORE the first paint, so
  // the component never mounts on the autoFocus search screen only to yank the
  // keyboard shut a tick later when the redirect effect fires. Only the truly
  // async case (a raw wallet address needing a DB lookup) still starts on
  // 'search' — see the effect below, which no longer autofocuses in that case.
  const initialRecipient = useState<Recipient | null>(() => {
    if (sendRecipient) return resolveCompound(sendRecipient)
    const toParam = searchParams.get('to')
    return toParam ? resolveCompound(toParam) : null
  })[0]
  const [screen, setScreen] = useState<Screen>(() => initialRecipient ? 'amount' : 'search')
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const goForward = (s: Screen) => { setDirection('forward'); setScreen(s) }
  const goBack2   = (s: Screen) => { setDirection('back');    setScreen(s) }
  const [recipient, setRecipient] = useState<Recipient | null>(initialRecipient)
  // True while we're still waiting on an async recipient resolution (raw
  // address lookup) that will redirect away from the search screen shortly —
  // used to suppress autoFocus so we don't open the keyboard just to close it.
  const hasPendingRedirect = !initialRecipient && !!(sendRecipient || searchParams.get('to'))

  // Search screen
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DbUser[]>([])
  const [searching, setSearching] = useState(false)
  const [addressPreview, setAddressPreview] = useState<Recipient | null>(null)
  const [addressResolving, setAddressResolving] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [recents, setRecents] = useState<Recipient[]>([])
  const latestQuery = useRef('')

  // Amount screen
  const [amount, setAmount] = useState(() => initialRecipient ? (searchParams.get('amount') || '') : '')
  const [showAmountPad, setShowAmountPad] = useState(false)
  const [amountError, setAmountError] = useState('')
  const [token, setToken] = useState<Token>('USDC')
  const settingsLoadedFlag = useSettingsStore((s) => s.loaded)
  useEffect(() => {
    if (!settingsLoadedFlag) return
    if (!isCoinEnabled(settingsMap, token)) {
      const fallback = (['USDC', 'EURC', 'cirBTC'] as Token[]).find(t => isCoinEnabled(settingsMap, t))
      if (fallback) setToken(fallback)
    }
  }, [settingsLoadedFlag, settingsMap])
  const [eurcBalance, setEurcBalance] = useState(0)
  const [cirbtcBalance, setCirbtcBalance] = useState<number | null>(null)
  const [showTokenPicker, setShowTokenPicker] = useState(false)
  const [estimatedFee, setEstimatedFee] = useState(0.001)
  const amountInputRef = useRef<HTMLInputElement>(null)

  // Review / passcode / processing
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [pin, setPin] = useState('')
  // Whether THIS payment's passcode came from a biometric check vs typed
  // manually — drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the processing->success animation. Set from PinKeypad's onComplete
  // second argument (see PinKeypad.tsx's own comment on why that exists).
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  const [pinError, setPinError] = useState(false)
  const [pinShake, setPinShake] = useState(false)
  const [processStage, setProcessStage] = useState<ProcessStage>('idle')
  const [txHash, setTxHash] = useState('')
  const [txError, setTxError] = useState('')
  const [hashCopied, setHashCopied] = useState(false)
  // Wall-clock duration of the send, measured start-to-finish, purely for
  // the success screen's "Completed in X Seconds" pill — doesn't affect
  // payment/transaction logic at all.
  const sendStartRef = useRef(0)
  const [elapsedSeconds, setElapsedSeconds] = useState('0.00')

  const returnTo = locationState.returnTo || null
  const returnConvId = locationState.conversationId || null
  const numAmount = parseFloat(amount) || 0
  const activeBalance = token === 'EURC' ? eurcBalance : token === 'cirBTC' ? (cirbtcBalance ?? 0) : balance
  const isProcessing = processStage !== 'idle' && processStage !== 'failed' && processStage !== 'delivered'
  const isDone = processStage === 'delivered'

  // ─── Resume an in-flight payment after a refresh ────────────────────────
  // If the page reloads while a send was still "confirming" (or even just
  // finishing up in the background), don't drop back to a blank search
  // screen with zero record that a payment might already be on-chain —
  // that's exactly the situation most likely to make someone send it again
  // by accident. Restore the review screen and check the real activity
  // table (the actual source of truth, not this marker) for what happened.
  useEffect(() => {
    const marker = getResumableOperation('pay')
    if (!marker) return
    const ctx = marker.context as Record<string, any>
    setScreen('review')
    setRecipient({
      display:       ctx.recipientDisplay || ctx.toAddress || '',
      displayName:   ctx.recipientDisplayName || ctx.recipientDisplay || ctx.toAddress || '',
      walletAddress: ctx.toAddress || '',
      isUsername:    !!ctx.recipientIsUsername,
      id:            ctx.recipientId,
    })
    setAmount(String(ctx.amount ?? ''))
    setToken((ctx.token as Token) || 'USDC')
    setTxHash(marker.txHash)
    setProcessStage('confirming')

    let cancelled = false
    let attempts = 0
    const senderAddr = senderStoredAddress || user?.walletAddress || ''
    const poll = async () => {
      if (cancelled || !senderAddr) return
      attempts++
      const found = await hasAnyActivityForTx(senderAddr, marker.txHash)
      if (cancelled) return
      if (found) {
        setProcessStage('delivered')
        clearResumableOperation('pay')
        return
      }
      if (attempts >= 8) {
        // Couldn't confirm either way within a reasonable window — don't
        // spin forever, and don't silently drop the marker either. Point
        // at Activity, the real source of truth, instead of guessing.
        setTxError('Still confirming — check Activity for the latest status.')
        return
      }
      setTimeout(poll, 1500)
    }
    poll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Full-screen success takeover, matching the reference video ────────
  // The earlier version moved a small circle from the processing spot up
  // into a header — the actual reference video does something bigger: the
  // ENTIRE screen flashes to brand color with a large checkmark + "Paid
  // Successfully", holds briefly, then that whole panel shrinks away while
  // the detailed success screen (same content as before, same text)
  // fades in underneath. Two phases, driven by plain initial/animate/exit
  // — not layout-prop or manual-FLIP geometry tracking. This matches the
  // pattern already used successfully everywhere else in this exact file
  // (the search/amount/review screen transitions below all use plain
  // initial/animate/exit), which is why this replaces the fancier
  // approaches tried first.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [showProcessDetails, setShowProcessDetails] = useState(false)
  useEffect(() => {
    if (!isDone) { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [isDone])

  // Gates FlashAuthIcon's own bio->check swap (see that component's
  // comment) — flips true only once the white circle below has actually
  // finished its spring entrance (onAnimationComplete), not on a guessed
  // timer. Reset alongside successPhase so a second payment in the same
  // session gets a fresh flash instead of starting pre-armed.
  const [flashCircleReady, setFlashCircleReady] = useState(false)
  useEffect(() => { if (successPhase === 'flash') setFlashCircleReady(false) }, [successPhase])

  // ─── Traveling checkmark: flash position -> hero card's own checkmark
  // spot, then the rest of the hero card drops in ────────────────────────
  // Not Framer's layout/layoutId — that's the exact mechanism that
  // produced zero visible motion in production earlier (see the extensive
  // comment history on this feature). This is the same manual
  // getBoundingClientRect + transform technique already proven working
  // for individual moves, extended here to bridge two DIFFERENT circles
  // (different size, different decoration - the flash one is plain, the
  // hero one has 4 sparkles) via one temporary clone that starts exactly
  // where the flash checkmark was and transforms (translate + scale) to
  // exactly where the hero card's own checkmark sits, then hands off to
  // the real hero checkmark once it arrives (invisible until then, so the
  // handoff is seamless) and reveals the hero card's other elements with
  // a staggered "drop in from above" entrance.
  const flashCheckRef = useRef<HTMLDivElement>(null)
  const heroCheckRef = useRef<HTMLDivElement>(null)
  const lastFlashRectRef = useRef<DOMRect | null>(null)
  const [travelRect, setTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  // Desktop's flash overlay used to portal straight to `document.body` with
  // `position:fixed; inset:0` — meaning it flashed the ENTIRE screen,
  // covering the Recent History column too, not just the flow column the
  // rest of this page's desktop layout confines itself to. It was ported
  // to `document.body` in the first place because PageTransition's
  // motion.div (wraps every route) leaves a stray transform on itself,
  // which makes it the containing block for any `position:fixed`
  // descendant — so a naive non-portalled fixed overlay rendered sized/
  // positioned to that transformed ancestor instead of the viewport. The
  // portal still needs to happen for that reason, but on desktop the
  // overlay's rect is now pinned to this ref (the same flow-column
  // wrapper `flow` already renders inside further down) instead of the
  // full viewport, so it visually respects the two-column layout.
  const desktopColumnRef = useRef<HTMLDivElement>(null)
  const [flashColumnRect, setFlashColumnRect] = useState<DOMRect | null>(null)

  // Continuously snapshot the flash checkmark's real position while it's
  // still mounted and settled (not mid-entrance-spring) — the LAST one
  // captured here, right before successPhase flips away, is what the
  // travel effect below uses as its starting point. Measuring live at
  // transition time instead would be unreliable: the flash panel has no
  // AnimatePresence wrapper (fixed below too), so its ref can already be
  // gone by the time an effect tries to read it, and even with that fixed,
  // measuring mid-exit-animation would capture an already-shrinking rect,
  // not the checkmark's true resting position.
  useLayoutEffect(() => {
    if (successPhase === 'flash' && flashCheckRef.current) {
      lastFlashRectRef.current = flashCheckRef.current.getBoundingClientRect()
    }
  })

  // Separate, dependency-gated effect — NOT folded into the unconditional
  // one above. That one has no dep array on purpose (it needs to keep
  // re-measuring flashCheckRef every render while flash is up), but
  // getBoundingClientRect() always returns a brand-new DOMRect object, so
  // calling setFlashColumnRect from an effect with no deps meant: render →
  // effect runs → setState with a "new" (referentially different, even if
  // numerically identical) rect → React sees a state change → re-render →
  // effect runs again → setState again → infinite loop (React error #185,
  // "Maximum update depth exceeded"). Gating on [successPhase, isDesktop]
  // makes it fire once per entry into the flash phase instead.
  useLayoutEffect(() => {
    if (isDesktop && successPhase === 'flash' && desktopColumnRef.current) {
      setFlashColumnRect(desktopColumnRef.current.getBoundingClientRect())
    }
  }, [successPhase, isDesktop])

  useEffect(() => {
    if (successPhase !== 'collapsed') { setTravelDone(false); setTravelRect(null); return }
    const from = lastFlashRectRef.current
    // Hero card has just mounted this render; its own checkmark ref isn't
    // attached until after this effect runs, so measure it on the next
    // frame once it's actually in the DOM.
    requestAnimationFrame(() => {
      const to = heroCheckRef.current?.getBoundingClientRect()
      if (from && to) {
        setTravelRect({ from, to })
        const t = setTimeout(() => setTravelDone(true), 520)
        return () => clearTimeout(t)
      } else {
        // Couldn't measure either circle (shouldn't normally happen) -
        // don't get stuck with an invisible checkmark forever.
        setTravelDone(true)
      }
    })
  }, [successPhase])

  // ─── Fee-aware spend ceiling (computed once, up front, on the Amount
  // screen) ───────────────────────────────────────────────────────────────
  // Arc's native gas token is USDC itself, so a USDC send pays its network
  // fee out of the exact same balance being sent. `feeReserve` is the
  // amount that must be held back so the transaction can still afford gas;
  // EURC/cirBTC are ERC-20s whose gas is paid separately out of native
  // USDC, not out of the EURC/cirBTC balance, so they reserve nothing here.
  // `SAFETY_BUFFER_MULT` covers gas-price drift between this estimate and
  // the moment the transaction actually lands on-chain.
  const SAFETY_BUFFER_MULT = 1.2
  const feeReserve = token === 'USDC' ? estimatedFee * SAFETY_BUFFER_MULT : 0
  // The true ceiling for anything the user types or taps Max for — not the
  // raw balance. Reusing this one value for Max, the keypad's own Done
  // button, and the Preview/Continue footer means every path into Review
  // is validated the same way, so an amount that can't afford gas can never
  // reach the passcode screen in the first place.
  const maxSpendable = Math.max(0, activeBalance - feeReserve)
  const amountExceedsBalance = numAmount > activeBalance
  const amountLeavesNoRoomForFee = !amountExceedsBalance && numAmount > maxSpendable
  const amountInvalid = amountExceedsBalance || amountLeavesNoRoomForFee
  const amountErrorMessage = amountExceedsBalance
    ? 'Insufficient balance'
    : amountLeavesNoRoomForFee
    ? `Leave at least ${formatAmount(feeReserve, 4)} ${token} for the network fee`
    : ''

  function resolveCompound(input: string): Recipient | null {
    const raw = input.trim()
    if (raw.includes('|')) {
      const parts = raw.split('|')
      const username = parts[0]; const walletAddr = parts[1]; const displayName = parts[2] || username
      const avatarUrl = parts[3] || null
      if (walletAddr && isValidAddress(walletAddr))
        return { display: username + '.arc', displayName: displayName || username, walletAddress: walletAddr, isUsername: true, avatarUrl }
    }
    if (isValidAddress(raw))
      return { display: shortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false }
    return null
  }

  // Async version — looks up MeshPort profile for a plain wallet address
  async function resolveCompoundAsync(input: string): Promise<Recipient | null> {
    const sync = resolveCompound(input)
    if (!sync) return null
    // If we only have a bare address (no username from compound format), try DB lookup
    if (!sync.isUsername && isValidAddress(input.trim())) {
      const profile = await getUserByWalletAddress(input.trim()).catch(() => null)
      if (profile) {
        return { id: profile.id, display: profile.username + '.arc', displayName: profile.display_name || profile.username, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url }
      }
    }
    return sync
  }

  // ─── Fee estimation, fetched up front on the Amount screen ─────────────
  // Runs immediately on mount and re-runs whenever something that could
  // change the network fee changes (token, recipient, network) — but NOT
  // when the passcode/Review screens are reached. The result is cached in
  // `estimatedFee` and reused everywhere else (Max, validation, the Review
  // page's fee row) rather than recomputed later.
  useEffect(() => {
    let cancelled = false
    estimateTransferFee(0).then(fee => { if (!cancelled) setEstimatedFee(fee) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, recipient?.walletAddress])

  useEffect(() => {
    const fetchEurc = async () => {
      try {
        const { walletAddress } = useAuthStore.getState()
        if (!walletAddress) return
        const pad = (s: string) => s.replace('0x', '').padStart(64, '0')
        const { result } = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', data: '0x70a08231' + pad(walletAddress) }, 'latest'] })
        if (result && result !== '0x') setEurcBalance(parseInt(result, 16) / 1e6)
      } catch {}
    }
    fetchEurc()

    import('@/lib/arcService').then((m: any) => {
      const { walletAddress } = useAuthStore.getState()
      // BUG FIX: this called `m.getCirBTCBalance` (capital BTC), but the
      // real export is `getCirBtcBalance` (see arcService.ts) -- the typo
      // meant this branch was always undefined, cirbtcBalance never left
      // its initial `null`, and cirBTC could never appear in the token
      // picker below (gated on `cirbtcBalance !== null`) no matter what the
      // Admin Panel's cirbtc_enabled toggle said.
      if (m.getCirBtcBalance && walletAddress) m.getCirBtcBalance(walletAddress).then((b: number) => setCirbtcBalance(b)).catch(() => {})
    }).catch(() => {})

    // Same logic as Home Avatar Recent (see src/lib/recentContacts.ts) — only
    // registered MeshPort users show up here, kept in sync with Home + the
    // View-all Recent page.
    const loadRecents = async () => {
      const { walletAddress } = useAuthStore.getState()
      if (!walletAddress) return
      try {
        const contacts = await fetchRecentContacts(walletAddress, { activityLimit: 20, maxAddresses: 10, resultLimit: 5 })
        const list: Recipient[] = contacts.map(p => ({
          id: p.id,
          display: p.username + '.arc',
          displayName: p.isSelf ? 'You' : (p.display_name || p.username),
          walletAddress: p.wallet_address,
          isUsername: true,
          avatarUrl: p.avatar_url,
        }))
        setRecents(list)
      } catch {}
    }
    loadRecents()

    if (sendRecipient) {
      // Sync-resolvable case was already applied before first paint (see
      // initialRecipient above) — only fall back to the async DB lookup here.
      if (!initialRecipient) resolveCompoundAsync(sendRecipient).then(r => { if (r) { setRecipient(r); goForward('amount') } })
      setSendRecipient(null)
    } else {
      const toParam = searchParams.get('to'); const amountParam = searchParams.get('amount')
      if (toParam && !initialRecipient) {
        // Raw address — needs async DB lookup (compound format was already
        // resolved synchronously before first paint)
        resolveCompoundAsync(toParam).then(r => {
          if (r) { setRecipient(r); if (amountParam) setAmount(amountParam); goForward('amount') }
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load contacts eagerly on mount — saved + conversation partners, merged A-Z, excluding removed
  useEffect(() => {
    const { user: u, walletAddress: wa } = useAuthStore.getState()
    import('@/lib/removedContacts').then(({ getRemovedContacts }) => {
      const removed = getRemovedContacts(wa)
      const contactsP = u?.id && !u.id.startsWith('usr_')
        ? fetchContactsDb(u.id).catch(() => [] as DbUser[])
        : Promise.resolve([] as DbUser[])
      const convsP = u?.id
        ? fetchConversations(u.id).catch(() => [] as any[])
        : Promise.resolve([] as any[])
      Promise.all([contactsP, convsP]).then(([savedRows, convs]) => {
        const merged = new Map<string, DbUser>()
        // Exclude your own id here — self is handled separately below as a
        // single pinned synthetic entry. Without this, a self-conversation
        // (created when you pay yourself by username — see PaySendPage's
        // chat block, which creates a conversation between user.id and
        // otherUser.id even when they're the same id) makes fetchConversations
        // return YOU as your own "other_user", merging you into this list a
        // second time — then the explicit `self` entry gets prepended on top
        // of that, producing two "(You)" rows.
        for (const c of savedRows) if (!removed.has(c.id) && c.id !== u?.id) merged.set(c.id, c)
        for (const conv of convs) {
          const other = conv.other_user
          if (other && other.id !== u?.id && !removed.has(other.id) && !merged.has(other.id)) merged.set(other.id, other)
        }
        const sorted = Array.from(merged.values()).sort((a, b) =>
          (a.display_name || a.username).localeCompare(b.display_name || b.username)
        )
        // Self-transfer: pin your own profile at the top of Contacts, as a
        // synthetic entry — never written to `user_contacts`, purely a UI
        // convenience so "pay yourself" is always one tap away without
        // requiring you to add yourself as a contact first. isSelf-tagged
        // rendering (the "(You)" label) happens where this list is mapped
        // below; this only builds the row's data.
        const self: DbUser | null = u?.id
          ? {
              id: u.id,
              username: u.username,
              display_name: u.displayName || u.username,
              email: u.email,
              wallet_address: wa || u.walletAddress,
              avatar_url: u.avatar || null,
              created_at: u.createdAt,
            }
          : null
        setSavedContacts(self ? [self, ...sorted] : sorted)
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Live search / address detection
  useEffect(() => {
    const raw = query.trim()
    latestQuery.current = raw
    setAddressPreview(null)
    setResults([])

    if (!raw) { setSearching(false); return }

    // Wallet address — resolve inline, no search
    if (isValidAddress(raw)) {
      setSearching(false)
      setAddressResolving(true)
      getUserByWalletAddress(raw).then(profile => {
        if (latestQuery.current !== raw) return
        setAddressPreview(profile
          ? { id: profile.id, display: profile.username + '.arc', displayName: profile.display_name || profile.username, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url, enteredViaAddress: true }
          : { display: midShortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false, enteredViaAddress: true }
        )
      }).catch(() => {
        setAddressPreview({ display: midShortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false, enteredViaAddress: true })
      }).finally(() => setAddressResolving(false))
      return
    }

    // 1. Filter saved contacts by display name or username (partial, case-insensitive)
    const term = raw.toLowerCase().replace(/\.arc$/i, '').trim()
    const savedMatches = savedContacts.filter(c =>
      (c.display_name || '').toLowerCase().includes(term) ||
      (c.username || '').toLowerCase().replace(/\.arc$/i, '').includes(term)
    )

    // 2. Only hit the DB if user typed a FULL username.arc (new contact search)
    const isFullUsername = /\.arc$/i.test(raw.trim())
    if (!isFullUsername) {
      // Partial: show saved contacts only — no open DB search
      setResults(savedMatches)
      setSearching(false)
      return
    }

    // Full username.arc — exact match only (this is a specific person's handle,
    // not a fuzzy prefix search, so don't surface similarly-named results).
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        // No excludeUserId here — self-transfer is permitted (see
        // arcService.ts's sendUSDC/sendEURC), and typing your own exact
        // username.arc should find yourself, tagged "You" at render time
        // below (isSelfResult), same as the pinned Contacts entry above.
        const dbResults = await searchUsersDb(raw) // exact "username = term" match, 0 or 1 result
        if (latestQuery.current !== raw) return
        // Only show a saved contact here if it's the SAME exact username, not a partial name match
        const exactSavedMatches = savedContacts.filter(c => (c.username || '').toLowerCase().replace(/\.arc$/i, '') === term)
        const savedIds = new Set(exactSavedMatches.map(c => c.id))
        const newOnly = dbResults.filter(u => !savedIds.has(u.id))
        setResults([...exactSavedMatches, ...newOnly])
        setSearching(false)
      } catch { setSearching(false) }
    }, 220)
    return () => clearTimeout(timer)
  }, [query, savedContacts])

  // Auto-submit pin when 6 digits entered
  useEffect(() => {
    if (pin.length === 6 && !isProcessing) { verifyAndSend() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin])

  const pickResult = (u: DbUser) => {
    setRecipient({ id: u.id, display: u.username + '.arc', displayName: u.display_name, walletAddress: u.wallet_address, isUsername: true, avatarUrl: u.avatar_url })
    // BUG FIX: amount (and any stale validation error) used to carry over
    // from a previous recipient — go back and pick someone new, and
    // whatever you'd typed for the last person was still sitting there.
    // Clearing here means every fresh recipient selection starts blank,
    // matching what you'd expect from Venmo/Cash App/etc.
    setAmount(''); setAmountError('')
    setQuery(''); setResults([]); goForward('amount')
  }

  const pickRecipient = (r: Recipient) => {
    setRecipient(r)
    setAmount(''); setAmountError('')
    goForward('amount')
  }

  const handlePasteSubmit = async () => {
    const addr = pasteValue.trim()
    if (!isValidAddress(addr)) { setPasteError('Enter a valid 0x wallet address'); return }
    setPasteError('')
    const profile = await getUserByWalletAddress(addr).catch(() => null)
    const r: Recipient = profile
      ? { id: profile.id, display: profile.username + '.arc', displayName: profile.display_name, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url, enteredViaAddress: true }
      : { display: shortenAddress(addr), displayName: 'External Wallet', walletAddress: addr, isUsername: false, enteredViaAddress: true }
    setRecipient(r); setPasteMode(false); setPasteValue(''); setAmount(''); setAmountError(''); goForward('amount')
  }

  const goBack = () => {
    if (screen === 'review') { goBack2('amount'); return }
    if (screen === 'amount') {
      const rt = locationState.returnTo
      if (rt === '/') { navigate('/'); return }
      if (rt === 'contacts') { navigate('/contacts'); return }
      if (rt === 'chat' && returnConvId) { navigate(`/chat/${returnConvId}`); return }
      if (rt === '/recent-paid') { navigate('/recent-paid'); return }
      if (rt === '/payment-link') { navigate(-1); return }
      goBack2('search')
      return
    }
    if (returnTo === 'contacts') navigate('/contacts')
    else if (returnTo === 'chat' && returnConvId) navigate(`/chat/${returnConvId}`)
    else navigate('/')
  }

  const sendInFlightRef = useRef(false)

  const openPasscodeSheet = () => { setPin(''); setPinError(false); setTxError(''); setShowPasscodeSheet(true) }

  const verifyAndSend = async () => {
    // Synchronous guard — `isProcessing` (React state) doesn't flip until
    // AFTER the async verifyPasscode() call below resolves, leaving a window
    // where a second onComplete fire would pass the isProcessing check and
    // trigger a second real on-chain send. A ref is checked/set synchronously
    // so this can never race.
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    try {
      if (storedPasscode) {
        const { verifyPasscode } = await import('@/lib/security')
        const correct = await verifyPasscode(pin, storedPasscode)
        if (!correct) {
          setPinError(true); setPinShake(true)
          setTimeout(() => setPinShake(false), 400)
          setTimeout(() => { setPin(''); setPinError(false) }, 500)
          sendInFlightRef.current = false
          return
        }
      }
      setShowPasscodeSheet(false)
      await runProcessing()
    } finally {
      sendInFlightRef.current = false
    }
  }

  const runProcessing = async () => {
    if (!recipient) return
    sendStartRef.current = performance.now()
    setTxError(''); setTxHash(''); setProcessStage('verifying')
    setProcessStage('preparing')

    let activePrivateKey = privateKey
    if (!activePrivateKey) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(pin || undefined)
      if (restored) activePrivateKey = useAuthStore.getState().privateKey
    }
    if (!activePrivateKey) { setTxError("Couldn't access your wallet on this device. Sign out and re-import your wallet with your recovery phrase or private key to continue."); setProcessStage('failed'); return }

    const toAddr = recipient.walletAddress
    const senderAddr = senderStoredAddress || user?.walletAddress || ''
    // Self-transfer is now permitted -- previously blocked here.

    // One Pay operation = one idempotency key, generated once per
    // runProcessing invocation (i.e. once per confirmed send) — a
    // genuinely new send gets a fresh key; nothing in this function
    // regenerates it mid-flight. Server-enforced via the same
    // UNIQUE(wallet_address, idempotency_key) constraint already proven
    // for BulkPay.
    const idempotencyKey = crypto.randomUUID()

    setProcessStage('sending')
    try {
      const arcMod: any = await import('@/lib/arcService').catch(() => ({}))
      const recipientUsername = recipient?.isUsername ? recipient.display : undefined
      const result = token === 'EURC'
        ? await sendEURC({ privateKey: activePrivateKey, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername })
        : token === 'cirBTC' && arcMod.sendCirBTC
        ? await arcMod.sendCirBTC({ privateKey: activePrivateKey, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername })
        : await sendUSDC({ privateKey: activePrivateKey, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername })

      setProcessStage('confirming')
      setTxHash(result.txHash)

      // Persist enough to resume this exact screen if the page gets
      // refreshed while still "confirming"/finishing up below — without
      // this, a refresh mid-send drops back to a blank search screen with
      // no record a payment might have already gone out, which is exactly
      // the situation most likely to make someone send it again by
      // accident. Cleared once this reaches a terminal state (delivered or
      // failed) below.
      saveResumableOperation('pay', result.txHash, {
        amount: numAmount, token, toAddress: result.recipientAddress,
        recipientDisplay: recipient?.display, recipientDisplayName: recipient?.displayName,
        recipientIsUsername: recipient?.isUsername, recipientId: recipient?.id,
      })

      // Clear recipient from removed contacts — user chose to pay them
      if (recipient?.id) {
        import('@/lib/removedContacts').then(({ removeFromRemovedContacts: clearRemoved }) => {
          clearRemoved(result.senderAddress, recipient.id!)
        })
        // Paying someone is exactly the "return pay" signal that should save
        // them as a real contact — dedup-safe, never creates duplicates no
        // matter how many times you pay the same person.
        if (user?.id) {
          import('@/lib/supabase').then(({ upsertContactDb }) => {
            upsertContactDb(user.id!, recipient.id!)
          })
        }
      }

      if (result.txHash) {
        const { Activity, updateActivityStatus } = await import('@/lib/ActivityService')
        Activity.send({ walletAddress: result.senderAddress, txHash: result.txHash, amount: numAmount, tokenSymbol: token, toAddress: result.recipientAddress, fee: estimatedFee, toUsername: recipient?.isUsername ? recipient.display : undefined }).catch(() => {})

        // Write the RECEIVE-side row directly, right here, in the same
        // processing event as the confirmed on-chain transfer — instead of
        // relying on the recipient's own client to notice a `payment_sent`
        // chat message over Realtime and create it themselves. That indirect
        // path (persist message → recipient app open & subscribed → recipient
        // writes its own Activity.receive) only fires the moment the
        // recipient happens to be online, and is skipped entirely for a raw
        // wallet address that never resolved to a known MeshPort user (see
        // resolveCompoundAsync above) — which is exactly why wallet-address
        // receives could take minutes (or forever) to show up while
        // username/contact payments felt instant.
        //
        // activity rows are keyed by wallet_address, not by user id, so this
        // insert succeeds even for a destination that isn't a registered
        // MeshPort account yet — the row is simply waiting there the moment
        // that wallet is ever opened in the app. subscribeToActivity's
        // Realtime channel (already correct) picks up this INSERT instantly
        // for anyone with that wallet currently subscribed.
        Activity.receive({
          walletAddress: result.recipientAddress,
          userId:        recipient?.isUsername ? recipient.id : undefined,
          txHash:        result.txHash,
          amount:        numAmount,
          tokenSymbol:   token,
          fromAddress:   result.senderAddress,
          fromUsername:  user?.username || undefined,
          receiveKind:   'p2p_payment',
        }).catch(() => {})

        // A payment is exactly the kind of change the short-lived Recent
        // cache (see recentContacts.ts) can't know about on its own —
        // invalidate it so Home/Send's Recent row picks up this recipient
        // right away rather than waiting out the cache window.
        import('@/lib/recentContacts').then(({ invalidateRecentContactsCache }) => invalidateRecentContactsCache())

        // Confirm in the background, without blocking anything above —
        // the user already sees success. This only ever needs to act in
        // the rare case the transaction actually reverted, correcting the
        // activity rows that were just written optimistically and letting
        // the user know, rather than leaving a wrong "success" standing.
        confirmTransactionInBackground(result.txHash as `0x${string}`, ({ success }) => {
          if (success) return
          updateActivityStatus(`send_${result.txHash.toLowerCase()}`, result.senderAddress, 'failed')
          updateActivityStatus(`recv_${result.txHash.toLowerCase()}`, result.recipientAddress, 'failed')
          showToastMessage('Payment failed to confirm on-chain — please check Activity', 'error')
        })
      }

      try {
        const { awardTransactionPoints } = await import('@/lib/rewards')
        const { user: u, walletAddress: wa } = useAuthStore.getState()
        const pid = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? `wallet_${wa.toLowerCase().slice(2, 18)}` : null
        if (pid && wa && result.txHash) {
          const r = await awardTransactionPoints({ userId: pid, walletAddress: wa, txHash: result.txHash })
          if (r.pointsAwarded > 0) notifyRewardSend(r.pointsAwarded, token)
        }
      } catch {}

      try {
        const { getUSDCBalance } = await import('@/lib/arcService')
        const { deriveAddressFromPrivateKey } = await import('@/lib/arc')
        // Fire-and-forget — deriving the address then fetching the balance
        // is only for refreshing the displayed balance after send; no reason
        // to block the success screen on it.
        deriveAddressFromPrivateKey(activePrivateKey).then((realAddr: string) => {
          getUSDCBalance(realAddr).then((bal: number) => setBalance(bal))
        }).catch(() => {})
      } catch {}

      // BUG FIX: this whole block used to be `await`-ed inline, meaning the
      // success screen sat on "processing" through FOUR sequential network
      // round-trips (ensureAnonSession, a user lookup, ensureConversation,
      // persistMessage) — all just to log a "Sent $X to Y" chat message —
      // even though the actual on-chain transfer had already completed.
      // It's already wrapped in try/catch that silently swallows any
      // failure either way, so awaiting it bought zero error-handling
      // benefit, only latency. Now fire-and-forget, same pattern already
      // used for the rewards/balance-refresh blocks just above.
      (async () => {
        try {
          const { supabase, ensureAnonSession } = await import('@/lib/supabase')
          const { ensureConversation, persistMessage, touchConversation } = await import('@/lib/chatService')
          if (recipient.isUsername && user) {
            await ensureAnonSession()
            const name = recipient.display.replace('.arc', '')
            const { data: otherUser, error: lookupErr } = await supabase.from('users').select('id,username,display_name').eq('username', name).maybeSingle()
            if (lookupErr) {
              // Was previously swallowed with zero trace — this is the
              // single most likely failure point (recipient lookup needs a
              // Supabase session; ensureAnonSession is best-effort and can
              // fail/time out, e.g. anonymous sign-in disabled on the
              // project, or a slow/dropped connection right after the send).
              console.error('[PaySend] chat: recipient lookup failed — payment card will not be created:', lookupErr.message, { username: name })
            } else if (!otherUser?.id) {
              console.error('[PaySend] chat: no user found for username — payment card will not be created:', name)
            } else {
              const convId = await ensureConversation(user.id, otherUser.id)
              if (!convId) {
                console.error('[PaySend] chat: ensureConversation returned no id — payment card will not be created:', { myId: user.id, otherId: otherUser.id })
              } else {
                const content = `Sent ${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token} to ${otherUser.username}.arc`
                const persisted = await persistMessage({ conversationId: convId, senderId: user.id, content, type: 'payment_sent', paymentAmount: numAmount, paymentTxHash: result.txHash, tokenSymbol: token, senderWalletAddress: result.senderAddress, recipientWalletAddress: result.recipientAddress, toUsername: recipient?.isUsername ? recipient.display : undefined })
                if (!persisted) {
                  console.error('[PaySend] chat: persistMessage failed — payment card will not be created:', { convId, txHash: result.txHash })
                } else {
                  touchConversation(convId, content)
                }
              }
            }
          }
        } catch (e: any) {
          console.error('[PaySend] chat: unexpected error creating payment card:', e?.message || e)
        }
      })()

      setElapsedSeconds(((performance.now() - sendStartRef.current) / 1000).toFixed(2))
      setProcessStage('delivered')
      clearResumableOperation('pay')
    } catch (err: any) {
      setTxError(err?.message || 'Unknown error')
      setProcessStage('failed')
      clearResumableOperation('pay')
    }
  }

  const copyHash = async () => {
    if (!txHash) return
    const ok = await copyToClipboard(txHash)
    setHashCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setHashCopied(false), 1500)
  }

  const finishDone = () => {
    if (returnTo === 'contacts') navigate('/contacts', { replace: true })
    else if (returnTo === 'chat' && returnConvId) navigate(`/chat/${returnConvId}`, { replace: true })
    else navigate('/', { replace: true })
  }

  // ── Desktop-only: Pay History (right column) ────────────────────────────
  // Real data — this wallet's own outgoing 'send' rows, same ActivityService
  // fetch pattern used across the app. Skipped entirely on mobile (that
  // column doesn't render there), and re-fetched once a payment actually
  // delivers so the new one appears without needing a page reload.
  const [payHistory, setPayHistory] = useState<ActivityRecord[]>([])
  const [payHistoryLoaded, setPayHistoryLoaded] = useState(false)
  const [payHistDetail, setPayHistDetail] = useState<ActivityRecord | null>(null)
  useEffect(() => {
    if (!isDesktop || !senderStoredAddress) return
    let cancelled = false
    fetchActivity(senderStoredAddress, { activityType: 'send', limit: 50 })
      .then(records => { if (!cancelled) setPayHistory(records) })
      .finally(() => { if (!cancelled) setPayHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [isDesktop, senderStoredAddress, processStage === 'delivered'])



  // Held in a variable (not returned directly) so the exact same JSX can be
  // placed either as the whole page (mobile, unchanged) or as the left
  // column of the desktop 2-column layout below — never duplicated.
  // Desktop: no root-level overflow-hidden — each screen already has its
  // own bounded h-full + inner flex-1 overflow-y-auto (mobile's proven
  // pattern), and the desktop column wrapping `flow` already has its own
  // overflowY:'auto'. Hard-clipping here too (on top of that) was cutting
  // off the bottom of tall content — the Success screen's summary card +
  // buttons — with no way to reach it, since this was the innermost clip
  // boundary. Mobile keeps overflow-hidden, unchanged.
  const flow = (
    <div className={`flex flex-col ${isDesktop ? 'h-full' : 'h-screen overflow-hidden'}`} style={{ background: 'var(--bg)' }}>
      <AnimatePresence mode="popLayout">

        {/* ══════════════ SCREEN 1 — SEARCH RECIPIENT ══════════════ */}
        {screen === 'search' && (
          <motion.div key="search"
            initial={{ opacity: 0, x: direction === "back" ? -24 : 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction === "back" ? 24 : -24 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="flex flex-col h-full">

            <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
              {!isDesktop && (
                <button onClick={goBack} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
              )}
              <div>
                <h1 className="text-xl font-bold text-text-primary">Pay on Arc</h1>
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>Search people on MeshPort</p>
              </div>
            </div>

              {/* Single combined search box. Desktop gets a QR button next
                  to it — works like Home's "Scan QR" quick action, but
                  passes align=left so the scanner lands pinned to this
                  page's own column 1 instead of centering across the full
                  content width (which would drift toward column 2). */}
            <div className="px-5 pb-3 flex-shrink-0 flex items-center gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-secondary)' }} />
                <input
                  autoFocus={!hasPendingRedirect}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search username or paste 0x address"
                  className="w-full rounded-2xl pl-11 pr-10 text-[15px] text-text-primary placeholder-text-secondary focus:outline-none font-mono"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', paddingTop: '15px', paddingBottom: '15px' }}
                />
                {query && (
                  <button onClick={() => { setQuery(''); setResults([]); setAddressPreview(null) }}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ background: 'var(--border)' }}>
                    <X className="w-3 h-3 text-text-primary" />
                  </button>
                )}
              </div>
              {isDesktop && (
                <button onClick={() => navigate('/scanner?align=left')} aria-label="Scan QR code"
                  className="flex items-center justify-center flex-shrink-0 rounded-2xl"
                  style={{ width: 50, height: 50, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <QrCode className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-5">

              {/* ── Address preview card (when 0x address entered) ── */}
              {(addressResolving || addressPreview) && (
                <div>
                  <p className="text-xs font-semibold mb-2.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>WALLET</p>
                  <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    {addressResolving ? (
                      <div className="py-6 flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--brand)' }} />
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Looking up address…</span>
                      </div>
                    ) : addressPreview && (
                      <button onClick={() => pickRecipient(addressPreview)}
                        className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-text-primary/5 transition-colors text-left">
                        {addressPreview.isUsername
                          ? <Avatar name={addressPreview.displayName} src={addressPreview.avatarUrl} size="sm" />
                          : <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                              <Wallet className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                            </div>
                        }
                        <div className="flex-1 min-w-0">
                          <p className="text-[15px] font-semibold text-text-primary truncate">{addressPreview.displayName}</p>
                          {addressPreview.isUsername
                            ? <p className="text-[12px] font-mono mt-0.5 truncate text-link">{addressPreview.display}</p>
                            : <p className="text-[11px] font-mono mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{midShortenAddress(addressPreview.walletAddress)}</p>
                          }
                        </div>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── Username search results ── */}
              {!addressPreview && !addressResolving && query.trim().replace(/\.arc$/i, '') && (
                <div>
                  <p className="text-xs font-semibold mb-2.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>RESULTS</p>
                  <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    {searching ? (
                      <div className="py-8 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--brand)' }} />
                      </div>
                    ) : results.length > 0 ? results.map((u, i) => (
                      <button key={u.id} onClick={() => pickResult(u)}
                        className="w-full flex items-center gap-3 px-4 py-3 active:bg-text-primary/5 transition-colors"
                        style={{ borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}>
                        <Avatar name={u.display_name} src={u.avatar_url} size="sm" />
                        <div className="flex-1 text-left min-w-0">
                          <p className="text-[15px] font-semibold text-text-primary truncate">
                            {u.id === user?.id ? 'You' : u.display_name}
                          </p>
                          <p className="text-[12px] font-mono mt-0.5 truncate text-link">{u.username?.endsWith('.arc') ? u.username : `${u.username}.arc`}</p>
                        </div>
                      </button>
                    )) : (
                      <div className="px-4 py-6 text-center">
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No users found for "{query.replace(/\.arc$/i, '')}"</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Empty state ── */}
              {!query.trim() && (
                <>
                  {/* Recent — 5 avatars with display name */}
                  {recents.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>RECENT</p>
                      <div className="flex gap-4 overflow-x-auto pb-1">
                        {recents.slice(0, 5).map((r, i) => (
                          <button key={i} onClick={() => pickRecipient(r)} className="flex flex-col items-center gap-2 flex-shrink-0">
                            <div style={{
                              width: 56, height: 56, borderRadius: '50%',
                              background: ['var(--avatar-1)','var(--avatar-2)','var(--avatar-3)','var(--avatar-4)','var(--avatar-1)'][i % 5],
                              border: '2px solid var(--border)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              overflow: 'hidden', flexShrink: 0,
                            }}>
                              {r.avatarUrl
                                ? <img src={r.avatarUrl} alt={r.displayName} style={{ width: 56, height: 56, objectFit: 'cover' }} />
                                : <span style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>{(r.displayName || '?').charAt(0).toUpperCase()}</span>
                              }
                            </div>
                            <p style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.displayName.split(' ')[0] || midShortenAddress(r.walletAddress)}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Contacts — saved only, sorted A–Z */}
                  {savedContacts.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold mb-2.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>CONTACTS</p>
                      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        {savedContacts.map((c, i) => (
                          <button key={c.id}
                            onClick={() => pickResult(c)}
                            className="w-full flex items-center gap-3 px-4 py-3 active:bg-text-primary/5 transition-colors text-left"
                            style={{ borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}>
                            <Avatar name={c.display_name || c.username} src={c.avatar_url} size="sm" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[15px] font-semibold text-text-primary truncate">
                                {c.id === user?.id ? '(You)' : (c.display_name || c.username)}
                              </p>
                              <p className="text-[12px] font-mono mt-0.5 truncate text-link">{c.username?.endsWith('.arc') ? c.username : `${c.username}.arc`}</p>
                            </div>
                            <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {recents.length === 0 && savedContacts.length === 0 && (
                    <div className="text-center pt-8">
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Search a username or paste a wallet address</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}

        {/* ══════════════ SCREEN 2 — ENTER AMOUNT ══════════════ */}
        {screen === 'amount' && recipient && (
          <motion.div key="amount"
            initial={{ opacity: 0, x: direction === "back" ? -24 : 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction === "back" ? 24 : -24 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="flex flex-col h-full">

            <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
              {!isDesktop && (
                <button onClick={goBack} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-5">

              {/* Recipient card */}
              <div className="flex items-center gap-3 p-3.5 rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                {recipient.isUsername
                  ? <Avatar name={recipient.displayName} src={recipient.avatarUrl} size="md" />
                  : <div className="w-[46px] h-[46px] rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}><Wallet className="w-5 h-5" style={{ color: 'var(--brand)' }} /></div>
                }
                <div className="flex-1 min-w-0">
                  {recipient.isUsername ? (
                    <>
                      <p className="text-[15px] font-bold text-text-primary truncate">{recipient.displayName}</p>
                      <p className="text-[12px] font-mono mt-0.5 truncate text-link">{recipient.display}</p>
                      {recipient.enteredViaAddress && (
                        <p className="text-[11px] font-mono mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{midShortenAddress(recipient.walletAddress)}</p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-[13px] font-bold text-text-primary truncate">External Wallet</p>
                      <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-secondary)', wordBreak: 'break-all', whiteSpace: 'normal' }}>{midShortenAddress(recipient.walletAddress)}</p>
                    </>
                  )}
                </div>
              </div>

              {/* Amount label */}
              <p className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Amount</p>

              {/* Tappable amount display — mobile only. Desktop shows just
                  the token picker here; the live amount input itself is
                  the AmountKeypad card right below (no separate display to
                  tap, it's always there and always editable). */}
              <div className="flex items-center"
                onClick={isDesktop ? undefined : () => setShowAmountPad(true)}
                style={{ justifyContent: isDesktop ? 'flex-end' : 'space-between', cursor: isDesktop ? 'default' : 'pointer' }}>
                {!isDesktop && (
                  <div className="flex items-baseline gap-0.5">
                    {/* BUG FIX: both spans below were a fixed 44px no
                        matter how long `amount` got -- a long cirBTC
                        amount (8 decimals) would overflow this row instead
                        of shrinking to fit. */}
                    <span className="font-bold" style={{ fontSize: amountFontSize(amount, 44), lineHeight: 1, color: amount ? 'var(--text-primary)' : 'color-mix(in srgb, var(--text-primary) 20%, transparent)' }}>{tokenSymbolChar(token)}</span>
                    <span className="font-bold text-text-primary" style={{ fontSize: amountFontSize(amount, 44), lineHeight: 1 }}>
                      {amount || '0'}
                    </span>
                  </div>
                )}
                <button onClick={e => { e.stopPropagation(); setShowTokenPicker(true) }}
                  className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full flex-shrink-0 active:opacity-70"
                  style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
                  {/* BUG FIX: this badge hardcoded the USDC "$" glyph +
                      color regardless of which token was actually selected
                      -- picking EURC or cirBTC still showed a blue "$"
                      circle here. Now matches the same per-token
                      symbol/color the other token badges on this page
                      already use (see the receive-summary and token-list
                      badges below). */}
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0" style={{ background: token === 'USDC' ? 'var(--usdc-icon)' : token === 'EURC' ? 'var(--brand)' : '#F7931A' }}>{tokenSymbolChar(token)}</div>
                  <span className="text-sm font-bold text-text-primary">{token}</span>
                  <svg className="w-2.5 h-2.5" style={{ color: 'var(--brand)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              </div>

              {isDesktop ? (
                // Same bare-box + centered value treatment as Multichain
                // Transfer's amount box, instead of AmountKeypad's own
                // elevated/shadowed desktop card.
                <div style={{
                  position: 'relative',
                  background: 'var(--bg)', border: `1px solid ${amountErrorMessage ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 14,
                  padding: '28px 20px', minHeight: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                }}>
                  {/* Symbol pinned to a fixed left inset, not inline before
                      the input — that keeps the digits truly centered in
                      the box no matter how many are typed, instead of the
                      whole "symbol+digits" group drifting off-center as it
                      grows. BUG FIX: was hardcoded to "$" regardless of
                      token, so EURC/cirBTC showed the wrong symbol here too. */}
                  <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: amount ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>{tokenSymbolChar(token)}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={amount}
                    onChange={e => { setAmount(sanitizeSendAmount(e.target.value, tokenDisplayDecimals(token))); setAmountError('') }}
                    placeholder="0.00"
                    style={{
                      width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                      // BUG FIX: this was a fixed 34px no matter how long
                      // the typed amount got -- an 8-decimal cirBTC value
                      // would overflow the box instead of shrinking.
                      fontSize: amountFontSize(amount, 34), fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
                      textAlign: 'center',
                    }}
                    aria-label={`Amount in ${token}`}
                  />
                </div>
              ) : (
                <AmountKeypad
                  open={showAmountPad}
                  value={amount}
                  onChange={v => { setAmount(v); setAmountError('') }}
                  balance={activeBalance}
                  token={token}
                  quickAmounts={QUICK_AMOUNTS}
                  // feeReserve/maxSpendable are computed once above from the
                  // fee cached at page-open — Max, this keypad's own Done
                  // button, and the footer's Preview button all validate
                  // against the same fee-safe ceiling.
                  feeReserve={feeReserve}
                  onClose={() => setShowAmountPad(false)}
                  doneLabel="Review"
                  onDone={() => {
                    if (!amount || numAmount <= 0 || amountInvalid) return
                    setShowAmountPad(false)
                    goForward('review')
                  }}
                  error={amountErrorMessage}
                />
              )}
              {amountErrorMessage && isDesktop && (
                <p className="text-xs text-center" style={{ color: 'var(--danger)' }}>{amountErrorMessage}</p>
              )}

              {/* Available balance (+ Max on desktop, where AmountKeypad's
                  own internal Max button no longer renders) */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Available Balance</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{formatAmount(activeBalance, tokenDisplayDecimals(token))} {token}</span>
                  {isDesktop && activeBalance > 0 && (
                    <button
                      onClick={() => {
                        const decimals = tokenDisplayDecimals(token)
                        const maxSendable = Math.max(0, activeBalance - feeReserve)
                        setAmount(parseFloat(maxSendable.toFixed(decimals)).toString())
                        setAmountError('')
                      }}
                      style={{
                        padding: '5px 14px', borderRadius: 100, border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)', fontSize: 12, fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Max
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Back + Preview footer — the keypad sheet has its own "Review"
                button while it's open, but once it's dismissed (tap outside,
                swipe down) or the user comes back from the Review screen,
                there was no way to continue without reopening the keypad.
                Show a persistent footer instead — but only once an amount
                has actually been entered, so it doesn't appear on a blank
                $0 screen. Desktop's AmountKeypad card is always "open"
                (see its `open` prop above) and has no Back button of its
                own, so the footer stays visible there unconditionally
                once an amount exists, instead of waiting for a sheet to
                close that no longer exists on desktop. */}
            {(isDesktop || !showAmountPad) && numAmount > 0 && (
              <div className="flex-shrink-0 px-5 flex items-center gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + 16px)', paddingTop: 8 }}>
                <button onClick={goBack}
                  className="px-6 py-4 rounded-2xl text-[15px] font-bold text-text-primary active:scale-[.98] flex-shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: '1px solid var(--border)' }}>
                  Back
                </button>
                <button
                  onClick={() => {
                    if (!amount || numAmount <= 0 || amountInvalid) return
                    goForward('review')
                  }}
                  disabled={amountInvalid}
                  className="flex-1 py-4 rounded-2xl text-[15px] font-bold text-text-primary active:scale-[.98]"
                  style={{
                    background: numAmount > 0 && !amountInvalid ? 'var(--brand)' : 'var(--border)',
                    border: numAmount > 0 && !amountInvalid ? '1px solid color-mix(in srgb, black 12%, transparent)' : 'none',
                    color: numAmount > 0 && !amountInvalid ? '#FFFFFF' : 'var(--text-secondary)',
                    opacity: numAmount > 0 && !amountInvalid ? 1 : 0.5,
                  }}>
                  Preview
                </button>
              </div>
            )}
          </motion.div>
        )}

        {/* ══════════════ SCREEN 3 — REVIEW + INLINE STATES ══════════════ */}
        {screen === 'review' && recipient && (
          <motion.div key="review"
            initial={{ opacity: 0, x: direction === "back" ? -24 : 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction === "back" ? 24 : -24 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="flex flex-col h-full">

            {/* This is the REAL isDone branch — the one that actually
                renders (confirmed against a live screenshot: this hero
                card's exact copy, "Pay again"/"Back to Home", is what
                really shows up). Every earlier animation attempt was
                spent editing a visually-similar-looking but structurally
                dead copy further down this same file, inside the `: (`
                branch below — reachable only when isDone is FALSE, so it
                could never fire for the actual success case no matter how
                correct the code inside it was. Confirmed by finding that
                exact "Pay again" text only exists once in this whole file:
                right here.
                The flash phase is the only new piece — everything from
                the hero card onward (all text, the whole detail card,
                both buttons) is completely unchanged. */}
            {/* Instant hide, not a graceful fade - a fading flash panel
                lingers as a translucent brand-color overlay on top of the
                hero card for its whole exit duration, which looked like
                two screens stacked (the hero's own header peeking through
                underneath while the flash's checkmark+text were still
                fading in front). The traveling checkmark clone is what
                should be the only thing visibly moving during this
                instant - not this panel too. */}
            {isDone && successPhase === 'flash' && createPortal(
              // Portalled straight to <body> — same fix as SwapPage's
              // identical flash overlay and TravelingCheckmark just below:
              // PageTransition's motion.div (wraps every route, desktop
              // included) leaves a non-`none` transform on itself from
              // animating `y`, which makes it the containing block for any
              // `position: fixed` descendant instead of the real viewport.
              // Invisible on mobile (that ancestor fills the screen exactly),
              // but desktop's Send flow also sits inside its own extra
              // scrollable 65%-width column below, so this overlay could
              // render sized/positioned to that scrolled, non-viewport box —
              // often off-screen entirely.
              <div
                style={{
                  position: 'fixed',
                  ...(isDesktop && flashColumnRect
                    ? { top: flashColumnRect.top, left: flashColumnRect.left, width: flashColumnRect.width, height: flashColumnRect.height, borderRadius: 20 }
                    : { inset: 0 }),
                  zIndex: 999, background: 'var(--brand)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}
              >
                <motion.div ref={flashCheckRef} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220, damping: 16 }}
                  onAnimationComplete={() => setFlashCircleReady(true)}
                  className="rounded-full flex items-center justify-center" style={{ width: 82.08, height: 82.08, background: '#fff', marginBottom: 20 }}>
                  {paidViaBiometric ? (
                    <FlashAuthIcon viaBiometric start={flashCircleReady} size={37.62} color="var(--brand)" />
                  ) : (
                    <motion.svg width={37.62} height={37.62} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                      <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.25 }} />
                    </motion.svg>
                  )}
                </motion.div>
                <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0 }}>Paid Successfully</p>
              </div>,
              document.body
            )}

            {/* Traveling checkmark clone — bridges the flash checkmark's
                measured position to the hero card's own checkmark spot
                (measured separately, different size/decoration). Fixed,
                on top of everything, only exists during the ~520ms travel
                window; the hero's real checkmark stays invisible until
                travelDone so the handoff between clone and real element
                is seamless. */}
            {travelRect && !travelDone && (
              <TravelingCheckmark from={travelRect.from} to={travelRect.to} />
            )}

            {isDone && successPhase === 'collapsed' ? (() => {
              const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : '—'
              const timeLabel = new Date().toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
              })
              const recipientLabel = recipient.isUsername ? recipient.display : midShortenAddress(recipient.walletAddress)
              const senderLabel = user?.username || (senderStoredAddress ? midShortenAddress(senderStoredAddress) : 'You')
              return (
                <div style={{ height: '100%', overflowY: 'auto' }}>
                  {/* Hidden SVG def: smooth elliptical-arc clip path for the hero's
                      scalloped bottom border, replacing the old polygon() version
                      whose many short straight segments rendered as a faceted,
                      hand-drawn-looking edge. Same envelope (corners, dip width,
                      dip depth) — just a true curve instead of a polyline. */}
                  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                    <defs>
                      <clipPath id="heroBottomClip" clipPathUnits="objectBoundingBox">
                        <path d="M0,0 L1,0 L1,0.75 L0.826,0.75 C0.805,0.75 0.805,0.859 0.755,0.859 L0.245,0.859 C0.195,0.859 0.195,0.75 0.174,0.75 L0,0.75 Z" />
                      </clipPath>
                    </defs>
                  </svg>
                  {/* ─── Hero: back + title, success badge, Paid, amount, recipient, completion pill ─── */}
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    background: 'var(--brand)',
                    paddingTop: 'calc(env(safe-area-inset-top, 0px) + clamp(3.3px, 0.99vh, 8.8px))',
                    // Hero card height, bottom padding only (downward-only,
                    // extends the card further down without moving/resizing
                    // anything inside it, and without shifting the
                    // transaction card below — that card's own marginTop is
                    // untouched, it simply starts a bit lower because the
                    // hero above it is taller).
                    //
                    // clamp(33px, 5.94vh, 46.2px) was already +10% over the
                    // original clamp(30px, 5.4vh, 42px). This is a further
                    // +13% on top of THAT (33->37.3, 5.94vh->6.71vh,
                    // 46.2->52.2), not +13% of the original — so the total
                    // is +24.3% over the very first value, all of it
                    // downward via this one bottom-padding value.
                    paddingBottom: 'clamp(37.3px, 6.71vh, 52.2px)',
                    paddingLeft: 'clamp(13.2px, 3.74vw, 16.5px)', paddingRight: 'clamp(13.2px, 3.74vw, 16.5px)',
                    clipPath: 'url(#heroBottomClip)',
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '47.3px 1fr 47.3px', alignItems: 'center', width: '100%', marginBottom: 'clamp(3.8px, 1.27vh, 12.7px)' }}>
                      <button onClick={finishDone} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4.4, color: '#FFFFFF', display: 'flex', justifySelf: 'start' }}>
                        <ArrowLeft style={{ width: 26.4, height: 26.4 }} />
                      </button>
                      <h1 style={{ fontSize: 'clamp(15.4px, 4.62vw, 20.9px)', fontWeight: 700, color: '#FFFFFF', textAlign: 'center', margin: 0 }}>Payment Successful!</h1>
                      <span />
                    </div>

                    <div ref={heroCheckRef} style={{ position: 'relative', width: 'clamp(55px, 14.52vw, 67.1px)', height: 'clamp(55px, 14.52vw, 67.1px)', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, margin: 'clamp(3.8px, 0.89vh, 7.6px) 0', opacity: travelDone ? 1 : 0 }}>
                      <Sparkle size={11} style={{ top: '4%', left: '-40%' }} />
                      <Sparkle size={6.6} style={{ top: '70%', left: '-32%' }} />
                      <Sparkle size={11} style={{ top: '2%', right: '-42%' }} />
                      <Sparkle size={6.6} style={{ top: '68%', right: '-30%' }} />
                      {paidViaBiometric && travelDone ? (
                        // Mounted fresh here (not earlier, just hidden) so
                        // its internal toggle timer starts exactly when
                        // this becomes visible - mounting it earlier would
                        // have it finish its whole sequence invisibly
                        // while opacity was still 0, showing only the
                        // final checkmark by the time you could see it.
                        <FlashAuthIcon key="landing-toggle" viaBiometric loop size={28} color="var(--brand)" />
                      ) : (
                        <svg viewBox="0 0 24 24" width="46%" height="46%" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>

                    <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.1 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        // paddingTop/Bottom: this whole group (Paid /
                        // amount / to X / pill) previously had zero
                        // breathing room above/below itself. First pass was
                        // +25%; this is a further +25% on top of that
                        // (+56.25% total over the original) — still only
                        // this group's own spacing, not the circle/header.
                        paddingTop: 'clamp(5.94px, 1.19vh, 11.88px)', paddingBottom: 'clamp(5.94px, 1.19vh, 11.88px)',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7.7, color: 'rgba(255,255,255,0.92)' }}>
                        <User style={{ width: 22, height: 22 }} />
                        <span style={{ fontSize: 'clamp(13.2px, 3.74vw, 15.4px)', fontWeight: 600 }}>Paid</span>
                      </div>

                      <p style={{ fontSize: 'clamp(24.2px, 7.04vw, 30.8px)', fontWeight: 800, color: '#FFFFFF', margin: 'clamp(5.94px,1.19vh,11.88px) 0 0', lineHeight: 1 }}>
                        {formatAmount(numAmount, tokenDisplayDecimals(token))} {token}
                      </p>
                      <p style={{ fontSize: 'clamp(12.1px, 3.399vw, 14.52px)', color: 'rgba(255,255,255,0.75)', margin: 'clamp(5.94px,1.19vh,11.88px) 0 0' }}>
                        to {recipientLabel}
                      </p>

                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.14)',
                        padding: 'clamp(4.75px,1.045vh,5.7px) clamp(8.7px,2.349vw,11.31px)', borderRadius: 999,
                        // +25% more on top of the prior +25% pass — same
                        // value now used for every gap in this group
                        // (Paid->amount, amount->to, to->pill) plus the
                        // paddingTop/Bottom above, all scaled together.
                        marginTop: 'clamp(5.94px,1.19vh,11.88px)',
                      }}>
                        <Zap className="w-3.5 h-3.5" style={{ color: '#FFD54A' }} fill="#FFD54A" />
                        <span style={{ fontSize: 'clamp(9px, 2.5vw, 11px)', fontWeight: 600, color: '#FFFFFF' }}>
                          Completed in {elapsedSeconds} Seconds
                        </span>
                      </div>
                    </motion.div>
                  </div>

                  {/* ─── Body: transaction card followed by success actions.
                      "More details" expands naturally; actions stay in normal flow. ─── */}
                  <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                    style={{
                      display: 'flex', flexDirection: 'column',
                      paddingLeft: 'clamp(16px, 4.5vw, 20px)', paddingRight: 'clamp(16px, 4.5vw, 20px)',
                      // The negative offset needs to live on this container,
                      // not on the card inside it. Putting it on the card
                      // instead pushed the card's top edge above this
                      // container's own top — since the outer scroll starts
                      // at the top already, that part (the "Transaction" row
                      // + hash) just got clipped off and was unreachable.
                      // Shifting the whole container up avoids that: nothing
                      // inside it moves relative to its own box, so nothing
                      // clips.
                      marginTop: 'calc(-1 * clamp(37.3px, 6.71vh, 52.2px) + 20px)',
                    }}>
                    <div className="shadow-elevation-1" style={{
                      marginTop: 0, background: 'var(--surface)', border: '1px solid var(--border)',
                      borderTopLeftRadius: 'clamp(18px, 4.5vw, 22px)', borderTopRightRadius: 'clamp(18px, 4.5vw, 22px)',
                      borderBottomLeftRadius: 'clamp(16.2px, 4.05vw, 19.8px)', borderBottomRightRadius: 'clamp(16.2px, 4.05vw, 19.8px)',
                      padding: '0 clamp(16px, 4vw, 20px)',
                    }}>
                      <TxDetailRow icon={<FileText className="w-4 h-4" />} label="Transaction" value={shortHash} mono onCopy={txHash ? copyHash : undefined} copied={hashCopied} showDivider />
                      <TxDetailRow icon={<User className="w-4 h-4" />} label="To" value={recipientLabel} showDivider />
                      <TxDetailRow icon={<Globe className="w-4 h-4" />} label="Network" value="Arc Testnet" showDivider />
                      <TxDetailRow icon={<Clock className="w-4 h-4" />} label="Time" value={timeLabel} showDivider />

                      {/* Expandable "Process" checklist — how the payment
                          actually went through, step by step. Lives inside
                          the same card as the rows above rather than as a
                          separate card, matching the reference design. */}
                      <AnimatePresence initial={false}>
                        {showProcessDetails && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                            style={{ overflow: 'hidden' }}>
                            <div style={{ paddingTop: 'clamp(13px, 2.85vh, 18px)', paddingBottom: 'clamp(11.7px, 2.565vh, 16.2px)' }}>
                              <p style={{ fontSize: 'clamp(12px, 3.2vw, 13px)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 clamp(10px, 2.2vh, 14px)' }}>
                                Process
                              </p>
                              <ProcessStep text="Payment approved" />
                              <ProcessStep text={<>Payment made by <strong>{senderLabel}</strong></>} />
                              <ProcessStep text={<>Payment received by <strong>{recipientLabel}</strong></>} last />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <button onClick={() => setShowProcessDetails(v => !v)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          background: 'none', border: 'none', cursor: 'pointer',
                          padding: 'clamp(10px, 2.2vh, 13px) 0', marginTop: showProcessDetails ? 0 : undefined,
                          borderTop: showProcessDetails ? '1px solid var(--border)' : 'none',
                        }}>
                        <span style={{ fontSize: 'clamp(13px, 3.4vw, 14px)', fontWeight: 600, color: 'var(--text-primary)' }}>{showProcessDetails ? 'Hide details' : 'More details'}</span>
                        <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-secondary)', transform: showProcessDetails ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                      </button>
                    </div>

                    {/* ─── Success actions + explorer links ─── */}
                    <div style={{ position: 'relative', background: 'var(--bg)', paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + clamp(12px, 2.5vh, 20px))' }}>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(58.08px, 20.328vw, 92.4px)', paddingTop: 'clamp(18px, 3.4vh, 26px)', marginBottom: 'clamp(18px, 3.4vh, 26px)' }}>
                        {txHash && (
                          <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
                            <span style={{
                              width: 'clamp(48px, 13vw, 56px)', height: 'clamp(48px, 13vw, 56px)', borderRadius: '50%',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)',
                            }}>
                              <ExternalLink className="w-5 h-5" />
                            </span>
                            <span style={{ fontSize: 'clamp(12px, 3.2vw, 13px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>
                              View on<br />Arc Explorer
                            </span>
                          </a>
                        )}
                        <button onClick={() => navigate('/activity')}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                          <span style={{
                            width: 'clamp(48px, 13vw, 56px)', height: 'clamp(48px, 13vw, 56px)', borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)',
                          }}>
                            <ActivityIcon className="w-5 h-5" />
                          </span>
                          <span style={{ fontSize: 'clamp(12px, 3.2vw, 13px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>
                            View<br />Activity
                          </span>
                        </button>
                      </div>

                      <div style={{ display: 'flex', gap: 'clamp(10px, 3vw, 14px)', width: '100%', maxWidth: isDesktop ? 560 : 'none', margin: '0 auto', boxSizing: 'border-box' }}>
                        <button onClick={() => { setAmount(''); setAmountError(''); setProcessStage('idle'); setShowProcessDetails(false); goForward('amount') }}
                          style={{
                            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                            height: 'clamp(48px, 13vw, 56px)', borderRadius: 16,
                            border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand)',
                            fontSize: 'clamp(14px, 3.6vw, 15px)', fontWeight: 700, cursor: 'pointer',
                          }}>
                          <RotateCcw className="w-4 h-4" /> Pay again
                        </button>
                        <button onClick={finishDone}
                          style={{
                            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                            height: 'clamp(48px, 13vw, 56px)', borderRadius: 16,
                            border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#FFFFFF',
                            fontSize: 'clamp(14px, 3.6vw, 15px)', fontWeight: 700, cursor: 'pointer',
                          }}>
                          <Home className="w-4 h-4" /> Back to Home
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </div>
              )
            })() : (
            <>
            {!isDone && (
              <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
                {!isDesktop && (
                  <button onClick={goBack} disabled={isProcessing} className="back-btn disabled:opacity-30">
                    <ArrowLeft className="w-5 h-5 text-text-primary" />
                  </button>
                )}
                <h1 className="text-xl font-bold text-text-primary">Review Payment</h1>
              </div>
            )}

            {/* Desktop-only compact "Success" header (same padding/size as
                MultichainClaimPage's own done-step header) — this step had
                no header at all before, so its content started right at
                the column's top edge instead of level with
                DesktopHistoryPanel's own header row next to it. */}
            {isDesktop && isDone && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '16px', flexShrink: 0 }}>
                <button onClick={() => navigate('/')} style={{ position: 'absolute', left: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-primary)', display: 'flex', alignItems: 'center' }}>
                  <ArrowLeft className="w-5 h-5"/>
                </button>
                <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Success</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 pb-4 flex flex-col">
              <AnimatePresence mode="popLayout">

                {/* ── PROCESSING → SUCCESS ──────────────────────────────────
                     Matches the reference video's actual pattern: the
                     checkmark isn't a small circle that slides into place
                     — the whole screen flashes to brand color with a big
                     checkmark + "Paid Successfully", holds briefly, then
                     that panel shrinks away while the detailed success
                     screen fades in underneath. Two named phases
                     (successPhase, declared above with the rest of this
                     screen's state), switched via plain initial/animate/
                     exit — the same pattern every other screen transition
                     in this file already uses successfully (see the
                     search/amount/review screens above), not layout-prop
                     or manual position-tracking, both of which turned out
                     harder to get reliably working for this. */}
                {isProcessing && (
                  <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="flex flex-col items-center justify-center flex-1 space-y-6 py-10">
                    <div className="w-20 h-20 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                      <Loader2 className="w-9 h-9 animate-spin" style={{ color: 'var(--brand)' }} />
                    </div>
                    <p className="text-text-primary" style={{ fontSize: 14.7, fontWeight: 700 }}>Processing payment…</p>
                    <p style={{ fontSize: 12.6, fontWeight: 700, color: 'var(--text-secondary)' }}>Do not close this screen</p>
                  </motion.div>
                )}

                {/* NOTE: there is no isDone-driven success rendering here
                    anymore. It used to be here, but is structurally dead —
                    this whole tree only ever renders when the OUTER
                    isDone-check (at the top of the "review" screen, a few
                    hundred lines up) has already evaluated to FALSE, so by
                    the time control reaches this point isDone can never be
                    true. That outer branch owns the entire success screen
                    now (hero card + the new full-screen flash phase before
                    it) — see that block's own comment. */}

                {/* ── FAILED STATE (inline) ── */}
                {processStage === 'failed' && (
                  <motion.div key="failed" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center pt-10 pb-4 space-y-5">
                    <div className="w-20 h-20 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
                      <AlertCircle className="w-11 h-11 text-danger" />
                    </div>
                    <div className="text-center">
                      <h2 className="text-xl font-bold text-text-primary">Payment Failed</h2>
                      <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{txError || 'Something went wrong. No funds were moved.'}</p>
                    </div>
                    <button onClick={() => setProcessStage('idle')}
                      className="w-full py-4 rounded-2xl text-[15px] font-bold text-white shadow-elevation-2"
                      style={{ background: 'var(--brand)' }}>
                      Try Again
                    </button>
                  </motion.div>
                )}

                {/* ── REVIEW CARD (default) ── */}
                {processStage === 'idle' && (
                  <motion.div key="reviewcard" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4 flex-1">
                    {/* Amount hero */}
                    <div className="text-center pt-2 pb-1">
                      <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>You are sending</p>
                      <p className="font-bold" style={{ fontSize: '40px', color: 'var(--brand)', lineHeight: 1 }}>{tokenSymbolChar(token)}{formatAmount(numAmount, tokenDisplayDecimals(token))}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-2">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ background: token === 'USDC' ? 'var(--usdc-icon)' : token === 'EURC' ? 'var(--brand)' : '#F7931A' }}>{tokenSymbolChar(token)}</div>
                        <span className="text-xs font-semibold text-text-primary">{token}</span>
                      </div>
                    </div>

                    {/* To */}
                    <div className="rounded-3xl p-4 space-y-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                      <p className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>To</p>
                      <div className="flex items-center gap-3">
                        <Avatar name={recipient.displayName} src={recipient.avatarUrl} size="md" />
                        <div className="min-w-0 flex-1">
                          {recipient.isUsername ? (
                            <>
                              <p className="text-[15px] font-bold text-text-primary truncate">{recipient.displayName}</p>
                              <p className="text-[12px] font-mono mt-0.5 truncate text-link">{recipient.display}</p>
                              {recipient.enteredViaAddress && (
                                <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-secondary)', wordBreak: 'break-all', whiteSpace: 'normal' }}>{recipient.walletAddress}</p>
                              )}
                            </>
                          ) : (
                            <>
                              <p className="text-[13px] font-bold text-text-primary truncate">External Wallet</p>
                              <p className="text-[11px] font-mono mt-1" style={{ color: 'var(--text-secondary)', wordBreak: 'break-all', whiteSpace: 'normal', lineHeight: 1.5 }}>{recipient.walletAddress}</p>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="pt-3 mt-2 flex items-center justify-between" style={{ borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Network</span>
                        <span className="text-sm font-semibold text-text-primary">Arc Testnet</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Fee</span>
                        {/* Reuses the fee already calculated on the Amount
                            page (see `estimatedFee` above) — the Review
                            screen never recomputes it, it just displays the
                            cached value. */}
                        <span className="text-sm font-semibold text-green-400">
                          {estimatedFee > 0 ? `~${formatAmount(estimatedFee, 4)} USDC` : 'Free'}
                        </span>
                      </div>
                      {!recipient.isUsername && (
                        <div className="flex items-center gap-2 mt-2 p-2.5 rounded-xl" style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)' }}>
                          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                          <p className="text-xs font-medium" style={{ color: 'var(--warning)' }}>Payments cannot be reversed. Please verify the address carefully.</p>
                        </div>
                      )}
                    </div>

                    {/* Secured */}
                    <div className="flex items-center justify-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Secured by MeshPort</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Pay button — only visible on review idle/failed */}
            {!isProcessing && !isDone && processStage !== 'failed' && (
              <div className="px-5 pb-6 pt-2 flex-shrink-0">
                <button onClick={openPasscodeSheet}
                  className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-[15px] font-bold text-white active:scale-[.98] shadow-elevation-2"
                  style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" />
                  </svg>
                  Pay
                </button>
              </div>
            )}
            </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══════════════ PASSCODE SHEET / DIALOG (modal over review) ══════════════ */}
      <AnimatePresence>
        {showPasscodeSheet && (isDesktop ? (
          <DesktopTransactionAuthDialog
            onClose={() => setShowPasscodeSheet(false)}
            title="Authorize Payment"
            amountLabel={`${tokenSymbolChar(token)}${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token}`}
            subLabel={`To ${recipient?.displayName}`}
          >
            {pinError && (
              <p className="text-xs text-center mb-4" style={{ color: 'var(--danger)' }}>Incorrect passcode. Try again.</p>
            )}
            <PinKeypad
              value={pin}
              onChange={setPin}
              length={6}
              error={pinError}
              shake={pinShake}
              onComplete={(_, viaBiometric) => { if (!isProcessing) { setPaidViaBiometric(!!viaBiometric); verifyAndSend() } }}
            />
          </DesktopTransactionAuthDialog>
        ) : (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 z-40"
              style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}
              onClick={() => setShowPasscodeSheet(false)} />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="absolute bottom-0 left-0 right-0 z-50 rounded-t-3xl pt-3 pb-10 px-6"
              style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }} />
              <div className="text-center mb-7">
                <h2 className="text-lg font-bold text-text-primary">Enter Passcode</h2>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                  {pinError
                    ? <span className="text-danger">Incorrect passcode. Try again.</span>
                    : `Authorise ${tokenSymbolChar(token)}${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token} to ${recipient?.displayName}`}
                </p>
              </div>
              <PinKeypad
                value={pin}
                onChange={setPin}
                length={6}
                error={pinError}
                shake={pinShake}
                onComplete={(_, viaBiometric) => { if (!isProcessing) { setPaidViaBiometric(!!viaBiometric); verifyAndSend() } }}
              />
            </motion.div>
          </>
        ))}
      </AnimatePresence>

      {/* ══════════════ TOKEN PICKER SHEET / DIALOG ══════════════ */}
      <AnimatePresence>
        {showTokenPicker && (() => {
          const tokenList = (['USDC', 'EURC'] as Token[]).concat(cirbtcBalance !== null ? ['cirBTC' as Token] : [])
            .filter(t => isCoinEnabled(settingsMap, t)).map(t => {
            const bal = t === 'USDC' ? balance : t === 'EURC' ? eurcBalance : (cirbtcBalance ?? 0)
            const icon = t === 'USDC' ? 'var(--usdc-icon)' : t === 'EURC' ? 'var(--brand)' : '#F7931A'
            const sym = t === 'USDC' ? '$' : t === 'EURC' ? '€' : '₿'
            return (
              <button key={t}
                className="w-full flex items-center gap-4 px-5 py-4 active:bg-text-primary/5 transition-colors"
                onClick={() => { setToken(t); setAmount(''); setShowTokenPicker(false) }}>
                <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 text-base font-bold text-white" style={{ background: icon }}>{sym}</div>
                <div className="flex-1 text-left">
                  <p className="text-base font-bold text-text-primary">{t}</p>
                  <p className="text-xs text-text-secondary mt-0.5">Arc Testnet</p>
                </div>
                <div className="text-right mr-2">
                  <p className="text-sm font-bold text-text-primary">{formatAmount(bal, tokenDisplayDecimals(t))}</p>
                  <p className="text-xs text-text-secondary">{t}</p>
                </div>
                {token === t && (
                  <div className="w-5 h-5 rounded-full bg-brand flex items-center justify-center flex-shrink-0">
                    <Check className="w-3 h-3 text-white" strokeWidth={3} />
                  </div>
                )}
              </button>
            )
          })

          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setShowTokenPicker(false)} maxWidth={400}>
              <div className="px-5 pb-2 pt-5">
                <p className="text-base font-bold text-text-primary">Select Asset</p>
                <p className="text-xs text-text-secondary mt-0.5">Choose token to send</p>
              </div>
              {tokenList}
              <div className="h-2" />
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm"
                onClick={() => setShowTokenPicker(false)} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="absolute bottom-0 left-0 right-0 z-50 rounded-t-3xl overflow-hidden"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-1"><div className="w-10 h-1 rounded-full bg-text-primary/20" /></div>
                <div className="px-5 pb-2 pt-1">
                  <p className="text-base font-bold text-text-primary">Select Asset</p>
                  <p className="text-xs text-text-secondary mt-0.5">Choose token to send</p>
                </div>
                {tokenList}
                <div className="h-8" />
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + Pay History (right), independently scrollable ──
  // Fills the full available content width (no maxWidth cap) at a fixed
  // 65/35 grow split, same treatment as Swap/Multichain Transfer. Bottom
  // padding trimmed so both columns reach down close to the viewport's
  // bottom edge.
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }} ref={desktopColumnRef}>{flow}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/activity')}>
          {!payHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : payHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Payments you send will show up here" />
          ) : (
            payHistory.map((r, i) => {
              const toLabel = ((r.metadata?.toUsername as string | undefined) || '').replace(/\.arc$/, '')
                || (r.counterpartyAddress ? shortenAddress(r.counterpartyAddress) : 'Unknown recipient')
              return (
                <div key={r.id} onClick={() => setPayHistDetail(r)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', cursor: 'pointer',
                  borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none',
                }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                      <path d="M2 12L12 2M12 2H6M12 2V8" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {toLabel}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>{timeAgo(r.createdAt)}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', flexShrink: 0 }}>
                    -{formatAmount(r.amount, 8)} {r.tokenSymbol}
                  </div>
                </div>
              )
            })
          )}
        </DesktopHistoryPanel>
      </div>
      <AnimatePresence>
        {payHistDetail && (() => {
          const r = payHistDetail
          const toLabel = ((r.metadata?.toUsername as string | undefined) || '').replace(/\.arc$/, '')
            || (r.counterpartyAddress ? shortenAddress(r.counterpartyAddress) : 'Unknown recipient')
          return (
            <DesktopHistoryDetail
              onClose={() => setPayHistDetail(null)}
              title="Payment Details"
              icon={<svg width="20" height="20" viewBox="0 0 14 14" fill="none"><path d="M2 12L12 2M12 2H6M12 2V8" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              iconColor="var(--danger)"
              amountLabel={`-${formatAmount(r.amount, 8)} ${r.tokenSymbol}`}
              amountColor="var(--danger)"
              rows={[
                { label: 'To', value: toLabel },
                { label: 'Time', value: timeAgo(r.createdAt) },
                { label: 'Status', value: r.status === 'completed' ? 'Completed' : r.status === 'failed' ? 'Failed' : 'Pending' },
                ...(r.txHash ? [{ label: 'Tx Hash', value: `${r.txHash.slice(0, 8)}…${r.txHash.slice(-6)}` }] : []),
              ]}
              explorerLinks={r.txHash ? [{ label: 'View on Arc Explorer', href: `https://testnet.arcscan.app/tx/${r.txHash}` }] : undefined}
            />
          )
        })()}
      </AnimatePresence>
    </div>
  )
}

function SRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-sm font-semibold" style={{ color: valueColor || 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
