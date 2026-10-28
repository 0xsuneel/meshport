import { backLayerPop } from '@/lib/backLayers'
import { displayOrderNumber } from '@/lib/orderLabels'
import { orderKindOf, orderTitle, paymentOrderTag, type OrderKind } from '@/lib/merchantPay'
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { TokenLogo } from '@/components/ui/TokenLogo'
import { arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import { prewarmCamera } from '@/lib/scannerPrewarm'
import { MOBILE_TAB_FADE_TRANSITION } from '@/lib/motion'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Wallet,
  AlertCircle, Loader2, CheckCircle2, QrCode,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { PanelScanner } from '@/features/scanner/PanelScanner'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { PinSheet } from '@/components/ui/PinSheet'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { AmountField, quickAmounts } from '@/components/ui/AmountField'
import { useWalletStore, useAuthStore, useUIStore } from '@/store'
import { formatAmount, shortenAddress, midShortenAddress, timeAgo, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { sendUSDC, sendEURC, estimateTransferFee, isValidAddress, confirmTransactionInBackground } from '@/lib/arcService'
import { classifyFailure, recordFailure, FAILURE_MESSAGES } from '@/lib/failure'
import { arcRpcJson } from '@/lib/arc'
import { notifyRewardSend } from '@/lib/notifications'
import { getUserByWalletAddress, getUserByUsername, type DbUser } from '@/lib/supabase'
import { useSettingsStore } from '@/store/settingsStore'
import { isCoinEnabled } from '@/lib/featureFilters'
import { fetchRecentContacts } from '@/lib/recentContacts'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { saveResumableOperation, getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { SuccessFlash } from '@/components/ui/SuccessFlash'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { SuccessReceipt } from '@/components/ui/SuccessReceipt'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton, DesktopHistoryDetail } from '@/components/ui/DesktopHistoryPanel'
import { ActivityRow } from '@/features/activity/ActivityPage'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'
import { ProcessingRing } from '@/components/ui/ProcessingRing'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { readPeople, writePeople } from '@/lib/peopleCache'
import { loadPayContacts } from '@/lib/payPeople'
import { SearchField } from '@/components/ui/SearchField'
import { useUserSearch } from '@/hooks/useUserSearch'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { reachCheck, STRANGER_PAY_BLOCKED, BLOCKED_YOU } from '@/lib/privacy'
import { payStep, payStepStart } from '@/lib/perfTrace'
import { useLeaveGuard } from '@/lib/leaveGuard'

type Screen = 'search' | 'amount' | 'review'
type Token = 'USDC' | 'EURC' | 'cirBTC'
type ProcessStage = 'idle' | 'verifying' | 'preparing' | 'sending' | 'confirming' | 'delivered' | 'failed'

// USDC/EURC are both ~$1-pegged, so 3 decimals used to read fine - but
// that cap also silently rounded away dust-size amounts (e.g. a real
// 0.000004 USDC payment showed as "$0"). Now that every display in this
// file trims trailing zeros (see formatAmount in lib/utils.ts), there's no
// downside to giving every token full 8-decimal precision - a normal "5
// USDC" still renders as "5", not "5.00000000" - so this now matches
// AmountKeypad.tsx's decimalCap (also raised to 8 for every token).
// USDC/EURC: 6 decimals (their on-chain precision). cirBTC: 8.
function tokenDisplayDecimals(t: Token): number {
  return t === 'cirBTC' ? 8 : 6
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
  // false = came from a link/QR "username|wallet|name|avatar" string and has
  // not yet been checked against that username's registered wallet. Nothing
  // can be signed until it is (see the verification effect below).
  verified?: boolean
}

const QUICK_AMOUNTS = [10, 20, 50, 100]

export function PaySendPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const locationState = (location.state || {}) as { returnTo?: string; conversationId?: string; merchantView?: import('@/lib/merchantPay').PaymentView }
  const user = useAuthStore(s => s.user)
  const senderStoredAddress = useAuthStore(s => s.walletAddress)
  const signer = useAuthStore(s => s.signer)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance, setBalance } = useWalletStore()
  const { sendRecipient, setSendRecipient, showToastMessage } = useUIStore()
  const settingsMap = useSettingsStore((s) => s.settings)

  // Recent / Contacts / last-activity start from the last-known lists (see
  // peopleCache) so they're on screen instantly; the loaders below refresh them.
  const [savedContacts, setSavedContacts] = useState<DbUser[]>(() => readPeople<DbUser>('pay-contacts', user?.id) ?? [])
  const [contactsLoaded, setContactsLoaded] = useState(() => readPeople('pay-contacts', user?.id) !== null)
  // Last paid / received date per wallet address, for the Recent & Contacts rows.
  const [lastByAddr, setLastByAddr] = useState<Map<string, LastPayment>>(
    () => new Map(readPeople<[string, LastPayment]>('pay-last', user?.id) ?? []))
  // Last payment for a Recent row (sent / received / failed - failed sends
  // are ledger rows too, see lib/failure.ts).
  const lastFor = (addr: string | null | undefined): LastPayment | undefined => lastByAddr.get((addr || '').toLowerCase())

  // Resolve any recipient we already have synchronously (recent-avatar tap via
  // sendRecipient, or a payment-link `?to=` param) BEFORE the first paint, so
  // the component never mounts on the autoFocus search screen only to yank the
  // keyboard shut a tick later when the redirect effect fires. Only the truly
  // async case (a raw wallet address needing a DB lookup) still starts on
  // 'search' - see the effect below, which no longer autofocuses in that case.
  const initialRecipient = useState<Recipient | null>(() => {
    if (sendRecipient) return resolveCompound(sendRecipient)
    const toParam = searchParams.get('to')
    return toParam ? resolveCompound(toParam) : null
  })[0]
  // ?review=1 (a Shop QR amount typed on the shop page): open on Review.
  const [screen, setScreen] = useState<Screen>(() => initialRecipient
    ? (searchParams.get('review') === '1' && searchParams.get('merchantPay') && searchParams.get('amount') ? 'review' : 'amount')
    : 'search')
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const goForward = (s: Screen) => { setDirection('forward'); setScreen(s) }
  const goBack2   = (s: Screen) => { setDirection('back');    setScreen(s) }
  const [recipient, setRecipient] = useState<Recipient | null>(initialRecipient)
  // True while we're still waiting on an async recipient resolution (raw
  // address lookup) that will redirect away from the search screen shortly -
  // used to suppress autoFocus so we don't open the keyboard just to close it.
  const hasPendingRedirect = !initialRecipient && !!(sendRecipient || searchParams.get('to'))

  // Search screen
  const [query, setQuery] = useState('')
  const [addressPreview, setAddressPreview] = useState<Recipient | null>(null)
  const [addressResolving, setAddressResolving] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [recents, setRecents] = useState<Recipient[]>(() => readPeople<Recipient>('pay-recent', user?.id) ?? [])
  const latestQuery = useRef('')

  // Amount screen
  const [amount, setAmount] = useState(() => initialRecipient ? (searchParams.get('amount') || '') : '')
  const [showAmountPad, setShowAmountPad] = useState(false)
  // Desktop: the QR scanner open over the search column (PanelScanner).
  const [scanAnchor, setScanAnchor] = useState<HTMLElement | null>(null)
  const amountBoxRef = useRef<HTMLDivElement>(null)
  const keypadLift = useKeypadLift(showAmountPad && screen === 'amount', amountBoxRef, !isDesktop)
  // Optional message the payer adds on the amount page (saved with the payment).
  const [note, setNote] = useState('')
  const [amountError, setAmountError] = useState('')
  // ?token= - opened from a token's own page (Home → Assets), so the amount
  // screen starts on that token.
  const [token, setToken] = useState<Token>(() => {
    const t = searchParams.get('token')
    return t === 'EURC' || t === 'cirBTC' ? t : 'USDC'
  })
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
  // manually - drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the processing->success animation. Set from PinKeypad's onComplete
  // second argument (see PinKeypad.tsx's own comment on why that exists).
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  const [pinError, setPinError] = useState(false)
  const [processStage, setProcessStage] = useState<ProcessStage>('idle')
  const [txHash, setTxHash] = useState('')
  const [txError, setTxError] = useState('')
  const [hashCopied, setHashCopied] = useState(false)
  // Wall-clock duration of the send, measured start-to-finish, purely for
  // the success screen's "Completed in X Seconds" pill - doesn't affect
  // payment/transaction logic at all.
  const sendStartRef = useRef(0)
  const reachPromiseRef = useRef<Promise<Awaited<ReturnType<typeof reachCheck>> | null> | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState('0.00')
  // Broadcast but not confirmed within the send's wait - shown as
  // "submitted", never as success or failure (see waitForConfirmation).
  const [payPending, setPayPending] = useState(false)

  const returnTo = locationState.returnTo || null
  // Paying a merchant payment request (/pay/r/<code>): the tx is handed to
  // the server for on-chain verification, then we return to the request.
  const merchantPayCode = searchParams.get('merchantPay')
  // The number pad opens only when the amount is tapped (not on arrival), so
  // the message box and the Review button below it stay in view.
  // Merchant payment: order number + amount come from the request and
  // can't be edited; the payment is confirmed against both.
  const [merchantOrderNumber, setMerchantOrderNumber] = useState<string | null>(() => searchParams.get('order'))
  // Paying an order in USDC: the order rides along on-chain (Arc memo).
  const orderMemo = (t: string) => merchantPayCode && t === 'USDC'
    ? { code: merchantPayCode, label: displayOrderNumber(merchantOrderNumber || merchantPayCode.slice(0, 6).toUpperCase()) }
    : null
  // The order handed over by the shop page (in-app navigation state - a link
  // can't set it), so its kind and checks don't wait on a second fetch.
  const handedView = merchantPayCode && locationState.merchantView?.code === merchantPayCode ? locationState.merchantView : null
  const [merchantOrderKind, setMerchantOrderKind] = useState<OrderKind>(() => handedView ? orderKindOf(handedView) : 'request')
  // The order's requester (for the chat card when the recipient came from a
  // link or QR without a username).
  const [merchantUsername, setMerchantUsername] = useState<string | null>(null)
  // Order payments: amount, order number and recipient come from the order on
  // the server - not from the link - so they can't be changed by editing it.
  const recipientRef = useRef(recipient)
  recipientRef.current = recipient
  useEffect(() => {
    if (!merchantPayCode) return
    let cancelled = false
    import('@/lib/merchantPay').then(async ({ getPayment, orderDue, isOrderPayable }) => {
      try {
        const v = handedView ?? await getPayment(merchantPayCode)
        if (cancelled) return
        const wrongRecipient = !!recipientRef.current?.walletAddress && recipientRef.current.walletAddress.toLowerCase() !== v.merchantWallet?.toLowerCase()
        if (!isOrderPayable(v) || wrongRecipient) { navigate(`/paylink/r/${merchantPayCode}?stay=1`, { replace: true }); return }
        setToken('USDC')
        setAmount(String(orderDue(v)))
        setMerchantOrderNumber(v.orderNumber ?? null)
        setMerchantOrderKind(orderKindOf(v))
        setMerchantUsername(v.merchantUsername ? String(v.merchantUsername).replace(/\.arc$/i, '') : null)
        // The recipient is the order's own merchant wallet (checked above).
        setRecipient(r => r ? { ...r, verified: true } : r)
      } catch {
        // Fail closed: without the order from the server, the recipient and
        // amount in the link can't be trusted. Show the request page instead.
        if (!cancelled) navigate(`/paylink/r/${merchantPayCode}?stay=1`, { replace: true })
      }
    })
    return () => { cancelled = true }
  }, [merchantPayCode])
  // Link/QR recipients ("username|wallet|name|avatar"): the username must own
  // that wallet. A forged link showing a real user's name with someone
  // else's address is refused; name and photo always come from the database.
  const [recipientError, setRecipientError] = useState('')
  useEffect(() => {
    const r = recipient
    if (!r || r.verified !== false || merchantPayCode) return
    let cancelled = false
    getUserByUsername(r.display).then(u => {
      if (cancelled) return
      if (u?.wallet_address && u.wallet_address.toLowerCase() === r.walletAddress.toLowerCase()) {
        setRecipient(cur => cur && cur.walletAddress === r.walletAddress ? {
          ...cur, id: u.id, displayName: u.display_name || u.username, avatarUrl: u.avatar_url, verified: true,
        } : cur)
      } else {
        setRecipient(null)
        setRecipientError(`This payment link doesn't match ${r.display}'s wallet, so it was blocked. Ask them for a new link.`)
        setDirection('back'); setScreen('search')
      }
    }).catch(() => { /* stays unverified - sending stays blocked */ })
    return () => { cancelled = true }
  }, [recipient?.walletAddress, recipient?.verified, merchantPayCode])
  const recipientUnverified = recipient?.verified === false
  // Chat privacy: the recipient may only accept payments from their contacts.
  // Checked as soon as they're picked (nothing can be reviewed or sent), and
  // again just before signing (runProcessing).
  const [payBlocked, setPayBlocked] = useState(false)
  const [blockedMe, setBlockedMe] = useState(false) // they blocked me
  // The recipient's MeshPort account - also for a pasted / scanned wallet
  // address, so the same rules apply as when they're picked by username.
  const recipientAccountId = async (): Promise<string | null> => {
    if (recipient?.id) return recipient.id
    const addr = recipient?.walletAddress
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null
    return (await getUserByWalletAddress(addr).catch(() => null))?.id ?? null
  }
  useEffect(() => {
    setPayBlocked(false); setBlockedMe(false)
    if (!recipient || merchantPayCode) return
    let cancelled = false
    recipientAccountId().then(rid => rid ? reachCheck(rid) : null)
      .then(r => { if (!cancelled && r) { setPayBlocked(!r.canPay); setBlockedMe(r.blocked) } })
    return () => { cancelled = true }
  }, [recipient?.id, recipient?.walletAddress, merchantPayCode])
  const payBlockedMessage = blockedMe
    ? BLOCKED_YOU(recipient?.display || 'This person')
    : STRANGER_PAY_BLOCKED(recipient?.display || 'This person')

  const returnConvId = locationState.conversationId || null
  const numAmount = parseFloat(amount) || 0
  const activeBalance = token === 'EURC' ? eurcBalance : token === 'cirBTC' ? (cirbtcBalance ?? 0) : balance
  const isProcessing = processStage !== 'idle' && processStage !== 'failed' && processStage !== 'delivered'
  // Hold Back / sidebar from the passcode until the payment lands or fails.
  useLeaveGuard(isProcessing, 'Payment')
  const isDone = processStage === 'delivered'

  // ─── Resume an in-flight payment after a refresh ────────────────────────
  // If the page reloads while a send was still "confirming" (or even just
  // finishing up in the background), don't drop back to a blank search
  // screen with zero record that a payment might already be on-chain -
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
        // Couldn't confirm either way within a reasonable window - don't
        // spin forever, and don't silently drop the marker either. Point
        // at Activity, the real source of truth, instead of guessing.
        setTxError('Still confirming - check Activity for the latest status.')
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
  // into a header - the actual reference video does something bigger: the
  // ENTIRE screen flashes to brand color with a large checkmark + "Paid
  // Successfully", holds briefly, then that whole panel shrinks away while
  // the detailed success screen (same content as before, same text)
  // fades in underneath. Two phases, driven by plain initial/animate/exit
  // - not layout-prop or manual-FLIP geometry tracking. This matches the
  // pattern already used successfully everywhere else in this exact file
  // (the search/amount/review screen transitions below all use plain
  // initial/animate/exit), which is why this replaces the fancier
  // approaches tried first.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  useEffect(() => {
    if (!isDone) { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [isDone])

  // Gates FlashAuthIcon's own bio->check swap (see that component's
  // comment) - flips true only once the white circle below has actually
  // finished its spring entrance (onAnimationComplete), not on a guessed
  // timer. Reset alongside successPhase so a second payment in the same
  // session gets a fresh flash instead of starting pre-armed.
  const [flashCircleReady, setFlashCircleReady] = useState(false)
  useEffect(() => { if (successPhase === 'flash') setFlashCircleReady(false) }, [successPhase])

  // ─── Traveling checkmark: flash position -> hero card's own checkmark
  // spot, then the rest of the hero card drops in ────────────────────────
  // Not Framer's layout/layoutId - that's the exact mechanism that
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
  // The receipt's check circle, once it's on screen: the flash stays up
  // until then, so there's never a frame with neither on screen.
  const [heroCheckEl, setHeroCheckEl] = useState<HTMLDivElement | null>(null)
  const heroCheckCallback = useCallback((el: HTMLDivElement | null) => { heroCheckRef.current = el; setHeroCheckEl(el) }, [])
  const lastFlashRectRef = useRef<DOMRect | null>(null)
  const [travelRect, setTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  // Desktop's flash overlay used to portal straight to `document.body` with
  // `position:fixed; inset:0` - meaning it flashed the ENTIRE screen,
  // covering the Recent History column too, not just the flow column the
  // rest of this page's desktop layout confines itself to. It was ported
  // to `document.body` in the first place because PageTransition's
  // motion.div (wraps every route) leaves a stray transform on itself,
  // which makes it the containing block for any `position:fixed`
  // descendant - so a naive non-portalled fixed overlay rendered sized/
  // positioned to that transformed ancestor instead of the viewport. The
  // portal still needs to happen for that reason, but on desktop the
  // overlay's rect is now pinned to this ref (the same flow-column
  // wrapper `flow` already renders inside further down) instead of the
  // full viewport, so it visually respects the two-column layout.
  const desktopColumnRef = useRef<HTMLDivElement>(null)
  const [flashColumnRect, setFlashColumnRect] = useState<DOMRect | null>(null)

  // Continuously snapshot the flash checkmark's real position while it's
  // still mounted and settled (not mid-entrance-spring) - the LAST one
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

  // Separate, dependency-gated effect - NOT folded into the unconditional
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

  // Measured before paint, once the receipt's check circle is mounted, so
  // the traveling checkmark is on screen in the receipt's very first frame.
  useLayoutEffect(() => {
    if (successPhase !== 'collapsed') { setTravelDone(false); setTravelRect(null); return }
    if (!heroCheckEl) return
    const from = lastFlashRectRef.current
    const to = heroCheckEl.getBoundingClientRect()
    // Couldn't measure the flash circle - don't leave an invisible checkmark.
    if (!from) { setTravelDone(true); return }
    setTravelRect({ from, to })
    const t = setTimeout(() => setTravelDone(true), 520)
    return () => clearTimeout(t)
  }, [successPhase, heroCheckEl])

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
  // The true ceiling for anything the user types or taps Max for - not the
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
        return { display: username.endsWith('.arc') ? username : username + '.arc', displayName: displayName || username, walletAddress: walletAddr, isUsername: true, avatarUrl, verified: false }
    }
    if (isValidAddress(raw))
      return { display: shortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false }
    return null
  }

  // Async version - looks up MeshPort profile for a plain wallet address
  async function resolveCompoundAsync(input: string): Promise<Recipient | null> {
    const sync = resolveCompound(input)
    if (!sync) return null
    // If we only have a bare address (no username from compound format), try DB lookup
    if (!sync.isUsername && isValidAddress(input.trim())) {
      const profile = await getUserByWalletAddress(input.trim()).catch(() => null)
      if (profile) {
        return { id: profile.id, display: profile.username?.endsWith('.arc') ? profile.username : profile.username + '.arc', displayName: profile.display_name || profile.username, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url }
      }
    }
    return sync
  }

  // ── Pre-warm heavy chunks AND serverless endpoints on mount ─────────────
  // The two modules below are the largest dynamic imports on the send
  // critical path. arcService pulls in viem (heavy); payIntentService is
  // imported inside sendUSDC/sendEURC right before the broadcast. Both
  // cold-parse on first use - typically 200–600ms - and that cost used to
  // land squarely on the PIN-submit → broadcast leg, making the send FEEL
  // slow even when Arc's own finality is sub-second. Kicking the imports
  // the instant the component mounts means V8 has parsed and cached them
  // before the user has even entered an amount, let alone their PIN.
  //
  // Additionally, the pay-intent Supabase Edge Function and the Arc RPC
  // relay (Vercel serverless) both cold-start in 500ms–1.5s when idle.
  // Warming them NOW (on page mount, not on passcode open) means the
  // actual payment's Edge Function call hits a hot isolate, not a cold one.
  // Fire-and-forget: errors silently ignored, these are pure warm-ups.
  useEffect(() => {
    import('@/lib/arcService').then(m => { m.warmArcRpc() }).catch(() => {})
    import('@/lib/payIntentService').then(m => { void m.warmPayIntent() }).catch(() => {})
    import('@/lib/security').catch(() => {})
  }, [])

  // ─── Fee estimation, fetched up front on the Amount screen ─────────────
  // Runs immediately on mount and re-runs whenever something that could
  // change the network fee changes (token, recipient, network) - but NOT
  // when the passcode/Review screens are reached. The result is cached in
  // `estimatedFee` and reused everywhere else (Max, validation, the Review
  // page's fee row) rather than recomputed later.
  useEffect(() => {
    let cancelled = false
    // BUG FIX (2026-09-17): estimateTransferFee's gas-unit assumption
    // depends on which kind of transfer this is - see its own comment in
    // arcService.ts. USDC is a native send (21,000 gas); EURC and cirBTC
    // are ERC-20 transfer() calls (~65,000 gas, per Arc's own docs) and
    // were silently getting the native-send number here before, understating
    // their real fee by roughly 3x on this exact screen.
    estimateTransferFee(0, token !== 'USDC').then(fee => { if (!cancelled) setEstimatedFee(fee) })
    return () => { cancelled = true }
     
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

    // Same logic as Home Avatar Recent (see src/lib/recentContacts.ts) - only
    // registered MeshPort users show up here, kept in sync with Home + the
    // View-all Recent page.
    const loadRecents = async () => {
      const { walletAddress } = useAuthStore.getState()
      if (!walletAddress) return
      try {
        const contacts = await fetchRecentContacts(walletAddress, { activityLimit: 20, maxAddresses: 10, resultLimit: 5 })
        const list: Recipient[] = contacts.map(p => ({
          id: p.id,
          display: p.username?.endsWith('.arc') ? p.username : p.username + '.arc',
          displayName: p.isSelf ? 'You' : (p.display_name || p.username),
          walletAddress: p.wallet_address,
          isUsername: true,
          avatarUrl: p.avatar_url,
        }))
        setRecents(list)
        writePeople('pay-recent', useAuthStore.getState().user?.id, list)
      } catch {}
      try {
        const { fetchLastActivityByAddress } = await import('@/lib/recentContacts')
        const last = await fetchLastActivityByAddress(walletAddress)
        setLastByAddr(last)
        writePeople('pay-last', useAuthStore.getState().user?.id, Array.from(last.entries()))
      } catch {}
    }
    loadRecents()

    if (sendRecipient) {
      // Sync-resolvable case was already applied before first paint (see
      // initialRecipient above) - only fall back to the async DB lookup here.
      if (!initialRecipient) resolveCompoundAsync(sendRecipient).then(r => { if (r) { setRecipient(r); goForward('amount') } })
      setSendRecipient(null)
    } else {
      const toParam = searchParams.get('to'); const amountParam = searchParams.get('amount')
      if (toParam && !initialRecipient) {
        // Raw address - needs async DB lookup (compound format was already
        // resolved synchronously before first paint)
        resolveCompoundAsync(toParam).then(r => {
          if (r) { setRecipient(r); if (amountParam) setAmount(amountParam); goForward('amount') }
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load contacts eagerly on mount - saved + conversation partners, merged A-Z,
  // excluding removed, you pinned first (lib/payPeople.ts).
  useEffect(() => {
    loadPayContacts().then(list => {
      if (list) setSavedContacts(list)
      setContactsLoaded(true)
    }).catch(() => setContactsLoaded(true))
  }, [user?.id])

  // Live address detection (a pasted 0x address resolves inline, no search).
  useEffect(() => {
    const raw = query.trim()
    latestQuery.current = raw
    setAddressPreview(null)
    if (!raw || !isValidAddress(raw)) return
    setAddressResolving(true)
    getUserByWalletAddress(raw).then(profile => {
      if (latestQuery.current !== raw) return
      setAddressPreview(profile
        ? { id: profile.id, display: profile.username?.endsWith('.arc') ? profile.username : profile.username + '.arc', displayName: profile.display_name || profile.username, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url, enteredViaAddress: true }
        : { display: midShortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false, enteredViaAddress: true }
      )
    }).catch(() => {
      setAddressPreview({ display: midShortenAddress(raw), displayName: 'External Wallet', walletAddress: raw, isUsername: false, enteredViaAddress: true })
    }).finally(() => setAddressResolving(false))
  }, [query])
  // Live username search (shared with the Business customer field -
  // hooks/useUserSearch): partial text filters saved contacts; a full
  // username.arc is looked up exactly. No excludeUserId - self-transfer is
  // permitted (see arcService.ts's sendUSDC/sendEURC), and typing your own
  // exact username.arc finds yourself, tagged "You" at render time.
  const { results, searching } = useUserSearch(isValidAddress(query.trim()) ? '' : query, savedContacts)

  // Warm the RPC proxy as soon as the passcode sheet opens.
  useEffect(() => {
    if (showPasscodeSheet) import('@/lib/arcService').then(m => m.warmArcRpc()).catch(() => {})
  }, [showPasscodeSheet])

  // Auto-submit pin when 6 digits entered
  useEffect(() => {
    if (pin.length === 6 && !isProcessing) { verifyAndSend() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin])

  const pickResult = (u: DbUser) => {
    setRecipient({ id: u.id, display: u.username?.endsWith('.arc') ? u.username : u.username + '.arc', displayName: u.display_name, walletAddress: u.wallet_address, isUsername: true, avatarUrl: u.avatar_url })
    // BUG FIX: amount (and any stale validation error) used to carry over
    // from a previous recipient - go back and pick someone new, and
    // whatever you'd typed for the last person was still sitting there.
    // Clearing here means every fresh recipient selection starts blank,
    // matching what you'd expect from Venmo/Cash App/etc.
    setAmount(''); setAmountError(''); setNote('')
    setQuery(''); goForward('amount')
  }

  const pickRecipient = (r: Recipient) => {
    setRecipient(r)
    setAmount(''); setAmountError(''); setNote('')
    goForward('amount')
  }

  const handlePasteSubmit = async () => {
    const addr = pasteValue.trim()
    if (!isValidAddress(addr)) { setPasteError('Enter a valid 0x wallet address'); return }
    setPasteError('')
    const profile = await getUserByWalletAddress(addr).catch(() => null)
    const r: Recipient = profile
      ? { id: profile.id, display: profile.username?.endsWith('.arc') ? profile.username : profile.username + '.arc', displayName: profile.display_name, walletAddress: profile.wallet_address, isUsername: true, avatarUrl: profile.avatar_url, enteredViaAddress: true }
      : { display: shortenAddress(addr), displayName: 'External Wallet', walletAddress: addr, isUsername: false, enteredViaAddress: true }
    setRecipient(r); setPasteMode(false); setPasteValue(''); setAmount(''); setAmountError(''); setNote(''); goForward('amount')
  }

  const goBack = () => {
    if (screen === 'review') { goBack2('amount'); return }
    if (screen === 'amount') {
      if (merchantPayCode) { if (window.history.length > 1) navigate(-1); else navigate('/', { replace: true }); return }
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

  // ─── Phone / browser Back steps through Pay's own screens ───────────────
  // Search → amount → review are one route, so Back used to leave Pay (Home)
  // even from Review. Each in-page screen entered adds a history entry; Back
  // then takes the same step as the on-screen arrow (Review → amount → search),
  // and the on-screen arrow drops the entry it leaves. Steps that leave Pay
  // (an amount screen opened from Home / Contacts / Chat / a link) add none.
  // While a payment is processing the leave guard holds Back first; Leave,
  // or Back on the result, exits Pay instead of returning to the amount.
  const rtNow = locationState.returnTo
  const amountExitsPay = !!merchantPayCode || rtNow === '/' || rtNow === 'contacts' || rtNow === '/recent-paid'
    || rtNow === '/payment-link' || (rtNow === 'chat' && !!returnConvId)
  const inPageDepth = screen === 'review' ? (amountExitsPay ? 1 : 2) : screen === 'amount' && !amountExitsPay ? 1 : 0
  const pushedStepsRef = useRef(0)
  const ignoreNextPopRef = useRef(false)
  const backStateRef = useRef({ screen, busyOrDone: false })
  backStateRef.current = { screen, busyOrDone: isProcessing || isDone }
  useEffect(() => {
    if (isProcessing || isDone) return // the entries stay until Pay is left
    while (pushedStepsRef.current < inPageDepth) {
      window.history.pushState({ ...(window.history.state ?? {}), mpPayStep: pushedStepsRef.current + 1 }, '')
      pushedStepsRef.current += 1
    }
    if (pushedStepsRef.current > inPageDepth) {
      // Went back with the on-screen arrow: drop the entries it left.
      const n = pushedStepsRef.current - inPageDepth
      pushedStepsRef.current = inPageDepth
      ignoreNextPopRef.current = true
      window.history.go(-n)
    }
  }, [inPageDepth, isProcessing, isDone])
  useEffect(() => {
    const onPop = () => {
      // Back closed a sheet / keypad on top (lib/backLayers): not ours.
      if (backLayerPop()) return
      if (ignoreNextPopRef.current) { ignoreNextPopRef.current = false; return }
      if (pushedStepsRef.current === 0) return
      pushedStepsRef.current -= 1
      const { screen: cur, busyOrDone } = backStateRef.current
      if (busyOrDone) {
        // Leave (while processing) or Back on the result: out of Pay.
        const dest = returnTo === 'contacts' ? '/contacts' : returnTo === 'chat' && returnConvId ? `/chat/${returnConvId}` : '/'
        navigate(dest, { replace: true })
        return
      }
      if (cur === 'review') goBack2('amount')
      else if (cur === 'amount') goBack2('search')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendInFlightRef = useRef(false)

  // RESILIENCE FIX (2026-09-17, explicit product requirement: Pay must
  // still work correctly on a bad/flaky connection, not just fail or
  // double-send on retry). This used to be a plain `crypto.randomUUID()`
  // generated fresh inside runProcessing on every single call - meaning
  // every retry (wrong PIN re-entry aside, any retry after a genuinely
  // dropped response on a bad connection) minted a BRAND NEW key. Since
  // pay-intent's own dedup is keyed on (wallet_address, idempotencyKey),
  // a fresh key on every retry gave that protection nothing to match
  // against: if the first attempt's response never reached this device
  // but had already broadcast server/chain-side, retrying would create a
  // second, entirely separate intent+attempt+nonce - a genuine
  // double-send, exactly the failure mode idempotency keys exist to
  // prevent, and exactly the scenario most likely on a bad connection.
  //
  // Keyed on the actual payment parameters rather than any lifecycle
  // event (opening the PIN sheet, tapping send, etc.): identical
  // recipient+amount+token reuses the same key across as many retries as
  // it takes, so pay-intent's existing_replay path (see arcService.ts's
  // own comment on intentResult.existingTxHash) can recognize a repeat
  // and resume instead of re-broadcasting. The moment any of the three
  // actually changes, this naturally computes a fresh key with no manual
  // invalidation to remember - safer than trying to catch every place
  // recipient/amount/token could change and reset a ref by hand.
  const idempotencyKeyRef = useRef<{ signature: string; key: string } | null>(null)
  const getIdempotencyKey = (): string => {
    const signature = `${recipient?.walletAddress ?? ''}:${numAmount}:${token}`
    if (idempotencyKeyRef.current?.signature !== signature) {
      idempotencyKeyRef.current = { signature, key: crypto.randomUUID() }
    }
    return idempotencyKeyRef.current.key
  }

  // Opened straight on Review (Shop QR): the Review button's checks and
  // warm-up didn't run. An amount the balance can't cover goes back to the
  // amount step, which says why; otherwise warm up the send once the order
  // is confirmed (same preflight the Review button starts).
  const directReviewWarmed = useRef(false)
  useEffect(() => {
    if (screen !== 'review' || !merchantPayCode || isProcessing || isDone || directReviewWarmed.current) return
    if (amountInvalid) { goBack2('amount'); return }
    const fromAddr = senderStoredAddress || user?.walletAddress
    if (!recipient || recipient.verified === false || !fromAddr || !(numAmount > 0)) return
    directReviewWarmed.current = true
    import('@/lib/arcService').then(({ preparePayment }) => preparePayment({
      token: 'USDC', from: fromAddr, to: recipient.walletAddress, amount: numAmount,
      idempotencyKey: getIdempotencyKey(),
      recipientUsername: recipient.isUsername ? recipient.display : undefined,
      memo: orderMemo('USDC'),
    })).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, merchantPayCode, amountInvalid, recipient?.verified, recipient?.walletAddress, numAmount])

  const openPasscodeSheet = () => { setPin(''); setPinError(false); setTxError(''); setShowPasscodeSheet(true) }

  const verifyAndSend = async () => {
    // Synchronous guard - `isProcessing` (React state) doesn't flip until
    // AFTER the async verifyPasscode() call below resolves, leaving a window
    // where a second onComplete fire would pass the isProcessing check and
    // trigger a second real on-chain send. A ref is checked/set synchronously
    // so this can never race.
    if (sendInFlightRef.current) return
    if (recipient?.verified === false) return
    sendInFlightRef.current = true
    payStepStart()
    try {
      // PERF FIX (transaction-speed audit): kick off private-key restore
      // NOW, concurrently with verifyPasscode below, instead of waiting for
      // runProcessing() to start it after passcode verification resolves.
      // Both are independent PBKDF2 (100k-iteration) derives from this same
      // just-typed `pin` -- running them back-to-back (the previous
      // behavior) paid that cost twice in serial on every send that didn't
      // already have the key warm in memory. restorePrivateKey() has its
      // own single-flight guard (restoreWallet.ts), so runProcessing()'s
      // own restorePrivateKey() call below simply attaches to this same
      // in-flight promise -- no redundant derive, just overlapped instead
      // of sequential. `silent: true` because a wrong PIN legitimately
      // fails this speculative attempt and must not flip on the app-wide
      // "wallet recovery needed" banner before the passcode check below
      // even reports "Incorrect passcode".
      if (!signer) {
        import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(pin || undefined, { silent: true })).catch(() => {})
      }
      // PERF: start the send's preflight (server intent/nonce, gas, balance)
      // now too, so the pay-intent round trip overlaps passcode verification
      // and key restore instead of following them. runProcessing's send
      // picks it up by idempotency key. See preparePayment in arcService.ts.
      const fromAddr = senderStoredAddress || user?.walletAddress
      if (recipient && fromAddr) {
        const idempotencyKey = getIdempotencyKey()
        const toAddr = recipient.walletAddress
        const recipientUsername = recipient.isUsername ? recipient.display : undefined
        import('@/lib/arcService').then(({ preparePayment }) => preparePayment({
          token: token === 'EURC' || token === 'cirBTC' ? token : 'USDC',
          from: fromAddr, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername, memo: orderMemo(token),
        })).catch(() => {})
      }
      // PERF: the "may I pay this person" check is a network round trip that
      // used to run only after the passcode check (PBKDF2) finished - run
      // the two side by side; runProcessing awaits this same promise.
      reachPromiseRef.current = merchantPayCode ? Promise.resolve(null)
        : recipientAccountId().then(id => (id ? reachCheck(id) : null)).catch(() => null)
      if (storedPasscode) {
        const { verifyPasscode } = await import('@/lib/security')
        const correct = await verifyPasscode(pin, storedPasscode)
        if (!correct) {
          setPinError(true)
          setTimeout(() => { setPin(''); setPinError(false) }, 500)
          sendInFlightRef.current = false
          return
        }
      }
      payStep('pin')
      setShowPasscodeSheet(false)
      await runProcessing()
    } finally {
      sendInFlightRef.current = false
    }
  }

  const runProcessing = async () => {
    if (!recipient || recipient.verified === false) return
    sendStartRef.current = performance.now()
    setTxError(''); setTxHash(''); setPayPending(false); setProcessStage('verifying')
    // Preflight: nothing has been signed or sent yet, so a refusal is final.
    // Started alongside the passcode check (verifyAndSend) when it can be.
    const early = reachPromiseRef.current
    reachPromiseRef.current = null
    const reach = early ? await early
      : merchantPayCode ? null
      : await recipientAccountId().then(id => (id ? reachCheck(id) : null))
    payStep('recipient')
    if (reach) {
      if (!reach.canPay) {
        setPayBlocked(true); setBlockedMe(reach.blocked)
        setTxError(reach.blocked ? BLOCKED_YOU(recipient.display) : STRANGER_PAY_BLOCKED(recipient.display))
        setProcessStage('failed'); return
      }
    }
    setProcessStage('preparing')

    let activeSigner = signer
    if (!activeSigner) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(pin || undefined)
      if (restored) activeSigner = useAuthStore.getState().signer
    }
    if (!activeSigner) { const { walletUnavailableMessage } = await import('@/lib/restoreWallet'); setTxError(walletUnavailableMessage()); setProcessStage('failed'); return }
    payStep('wallet')

    const toAddr = recipient.walletAddress
    const senderAddr = senderStoredAddress || user?.walletAddress || ''
    // Self-transfer is now permitted -- previously blocked here.

    // One Pay operation = one idempotency key. Now stable across retries
    // of the SAME payment (see idempotencyKeyRef/getIdempotencyKey above)
    // - a genuinely new send (different recipient, amount, or token) still
    // gets a fresh key automatically; nothing here needs to track that by
    // hand.
    const idempotencyKey = getIdempotencyKey()

    setProcessStage('sending')
    try {
      const arcMod: any = await import('@/lib/arcService').catch(() => ({}))
      const recipientUsername = recipient?.isUsername ? recipient.display : undefined
      // A definite failure (refused by every node, or reverted) is noted for
      // the Recent rows; a 'pending' send is never counted as failed.
      const noteFailed = (err: unknown, txHash?: string) => void recordFailure({
        feature: 'pay', walletAddress: useAuthStore.getState().walletAddress, amount: numAmount, token,
        counterparty: toAddr, txHash, failure: classifyFailure(err, { reverted: !!txHash }),
        metadata: { toUsername: recipient?.isUsername ? recipient.display : undefined, ...(merchantPayCode ? { merchantOrder: merchantOrderNumber ?? undefined, merchantOrderKind: merchantOrderKind === 'bill' ? 'invoice' : 'request', merchantPersonal: merchantOrderKind === 'bill' ? undefined : merchantOrderKind === 'request', merchantVia: merchantOrderKind === 'shop' ? 'shop_qr' : undefined } : {}) },
      })
      const result = await (token === 'EURC'
        ? sendEURC({ signer: activeSigner, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername })
        : token === 'cirBTC' && arcMod.sendCirBTC
        ? arcMod.sendCirBTC({ signer: activeSigner, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername })
        : sendUSDC({ signer: activeSigner, to: toAddr, amount: numAmount, idempotencyKey, recipientUsername, memo: orderMemo('USDC') })
      ).catch((e: unknown) => { noteFailed(e); throw e })

      // The send now waits for the real receipt (see waitForConfirmation in
      // arcService.ts). A reverted payment moved nothing - show the failed
      // screen, and drop the idempotency key so a retry is a genuinely new
      // payment instead of a replay of this failed one.
      if (result.state === 'failed') {
        idempotencyKeyRef.current = null
        noteFailed(null, result.txHash)
        throw new Error(`The payment was rejected on-chain, so no ${token} was sent. A small network fee may have been used. Please try again.`)
      }
      setPayPending(result.state === 'pending')
      setProcessStage('confirming')
      setTxHash(result.txHash)
      if (merchantPayCode && token === 'USDC' && result.txHash) {
        import('@/lib/merchantPay').then(({ submitPayment }) => submitPayment(merchantPayCode, ARC_CHAIN_KEY, result.txHash, { orderNumber: merchantOrderNumber ?? undefined, amount: numAmount }))
          .catch(e => console.warn('[PaySend] merchant payment submit failed (merchant can verify by tx):', e))
      }

      // Persist enough to resume this exact screen if the page gets
      // refreshed while still "confirming"/finishing up below - without
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

      // Clear recipient from removed contacts - user chose to pay them
      if (recipient?.id) {
        import('@/lib/removedContacts').then(({ removeFromRemovedContacts: clearRemoved }) => {
          clearRemoved(result.senderAddress, recipient.id!)
        })
        // Paying someone is exactly the "return pay" signal that should save
        // them as a real contact - dedup-safe, never creates duplicates no
        // matter how many times you pay the same person.
        if (user?.id) {
          import('@/lib/supabase').then(({ upsertContactDb }) => {
            upsertContactDb(user.id!, recipient.id!)
          })
        }
      }

      if (result.txHash) {
        const { Activity, updateActivityStatus } = await import('@/lib/ActivityService')
        Activity.send({ walletAddress: result.senderAddress, txHash: result.txHash, amount: numAmount, tokenSymbol: token, toAddress: result.recipientAddress, fee: estimatedFee, toUsername: recipient?.isUsername ? recipient.display : undefined, note: note.trim() || undefined }).catch(() => {})

        // Write the RECEIVE-side row directly, right here, in the same
        // processing event as the confirmed on-chain transfer - instead of
        // relying on the recipient's own client to notice a `payment_sent`
        // chat message over Realtime and create it themselves. That indirect
        // path (persist message → recipient app open & subscribed → recipient
        // writes its own Activity.receive) only fires the moment the
        // recipient happens to be online, and is skipped entirely for a raw
        // wallet address that never resolved to a known MeshPort user (see
        // resolveCompoundAsync above) - which is exactly why wallet-address
        // receives could take minutes (or forever) to show up while
        // username/contact payments felt instant.
        //
        // activity rows are keyed by wallet_address, not by user id, so this
        // insert succeeds even for a destination that isn't a registered
        // MeshPort account yet - the row is simply waiting there the moment
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
          note:          note.trim() || undefined,
          receiveKind:   'p2p_payment',
        }).catch(() => {})

        // A payment is exactly the kind of change the short-lived Recent
        // cache (see recentContacts.ts) can't know about on its own -
        // invalidate it so Home/Send's Recent row picks up this recipient
        // right away rather than waiting out the cache window.
        import('@/lib/recentContacts').then(({ invalidateRecentContactsCache }) => invalidateRecentContactsCache())

        // Only still-unconfirmed ("pending") payments need watching: keep
        // following the receipt, flip the screen to confirmed when it lands,
        // or correct the Activity rows if it ends up reverting.
        if (result.state === 'pending') confirmTransactionInBackground(result.txHash as `0x${string}`, ({ success }) => {
          if (success) { setPayPending(false); return }
          updateActivityStatus(`send_${result.txHash.toLowerCase()}`, result.senderAddress, 'failed', FAILURE_MESSAGES.reverted)
          updateActivityStatus(`recv_${result.txHash.toLowerCase()}`, result.recipientAddress, 'failed', FAILURE_MESSAGES.reverted)
          showToastMessage('Payment failed to confirm on-chain - please check Activity', 'error')
        })
      }

      // PERF FIX: fire-and-forget - rewards points are a nice-to-have on top
      // of an already-confirmed payment; awaiting this server round trip
      // before showing success only added latency with no correctness
      // benefit (same pattern already used for the balance refresh and chat
      // message below). Internal try/catch still swallows all errors, so
      // this can never produce an unhandled rejection.
      (async () => {
        try {
          const { awardTransactionPoints } = await import('@/lib/rewards')
          const { user: u, walletAddress: wa } = useAuthStore.getState()
          const pid = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? `wallet_${wa.toLowerCase().slice(2, 18)}` : null
          if (pid && wa && result.txHash) {
            const r = await awardTransactionPoints({ userId: pid, walletAddress: wa, txHash: result.txHash, actionType: 'pay_send' })
            if (r.pointsAwarded > 0) notifyRewardSend(r.pointsAwarded, token)
          }
        } catch {}
      })()

      try {
        // Fire-and-forget - deriving the address then fetching the balance
        // is only for refreshing the displayed balance after send; no reason
        // to block the success screen on it.
        Promise.resolve(activeSigner.address).then((realAddr: string) => {
          // Balance drops at once, then the chain's figure replaces it
          // (retried while the chain still shows the old value).
          refreshBalancesAfterTx(realAddr, { spent: token === 'USDC' ? numAmount : 0 })
        }).catch(() => {})
      } catch {}

      // BUG FIX: this whole block used to be `await`-ed inline, meaning the
      // success screen sat on "processing" through FOUR sequential network
      // round-trips (ensureAnonSession, a user lookup, ensureConversation,
      // persistMessage) - all just to log a "Sent $X to Y" chat message -
      // even though the actual on-chain transfer had already completed.
      // It's already wrapped in try/catch that silently swallows any
      // failure either way, so awaiting it bought zero error-handling
      // benefit, only latency. Now fire-and-forget, same pattern already
      // used for the rewards/balance-refresh blocks just above.
      (async () => {
        try {
          const { supabase, ensureAnonSession } = await import('@/lib/supabase')
          const { ensureConversation, persistMessage, touchConversation } = await import('@/lib/chatService')
          // Paying an order by link / QR: the chat gets the same payment card
          // as paying the request in chat - with "Bill ORD-… · Paid in full".
          // A Shop QR payment has no number but is still tagged (" · Payment").
          const orderTag = merchantPayCode && (merchantOrderNumber || merchantOrderKind === 'shop') ? paymentOrderTag(merchantOrderKind, merchantOrderNumber) : ''
          const chatName = recipient.isUsername ? recipient.display.replace('.arc', '') : merchantPayCode ? merchantUsername : null
          if (chatName && user) {
            await ensureAnonSession()
            const name = chatName
            // SUPABASE REDUCTION: replaced direct supabase.from('users') lookup
            // with /api/profile?username= so the client never needs the anon key
            // for user lookups. Same shape: {id, username, display_name}.
            const _profileRes = await fetch(`/api/profile?username=${encodeURIComponent(name)}`)
            const _profileRows = _profileRes.ok ? await _profileRes.json().catch(() => []) as any[] : []
            const otherUser = _profileRows[0] ?? null
            const lookupErr = _profileRes.ok ? null : { message: `profile lookup ${_profileRes.status}` }
            if (lookupErr) {
              // Was previously swallowed with zero trace - this is the
              // single most likely failure point (recipient lookup needs a
              // Supabase session; ensureAnonSession is best-effort and can
              // fail/time out, e.g. anonymous sign-in disabled on the
              // project, or a slow/dropped connection right after the send).
              console.error('[PaySend] chat: recipient lookup failed - payment card will not be created:', lookupErr.message, { username: name })
            } else if (!otherUser?.id) {
              console.error('[PaySend] chat: no user found for username - payment card will not be created:', name)
            } else {
              const convId = await ensureConversation(user.id, otherUser.id)
              if (!convId) {
                console.error('[PaySend] chat: ensureConversation returned no id - payment card will not be created:', { myId: user.id, otherId: otherUser.id })
              } else {
                const content = `Sent ${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token} to ${otherUser.username}.arc${orderTag}`
                const persisted = await persistMessage({ conversationId: convId, senderId: user.id, content, type: 'payment_sent', paymentAmount: numAmount, paymentTxHash: result.txHash, tokenSymbol: token, senderWalletAddress: result.senderAddress, recipientWalletAddress: result.recipientAddress, toUsername: recipient?.isUsername ? recipient.display : `${otherUser.username}.arc` })
                if (!persisted) {
                  console.error('[PaySend] chat: persistMessage failed - payment card will not be created:', { convId, txHash: result.txHash })
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
      // Same exact reason the failed Activity row carries (lib/failure.ts).
      setTxError(classifyFailure(err).message)
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
    // An order paid with MeshPort (a Shop QR, a bill or request link): this
    // success screen is the receipt - Done goes Home like any payment. The
    // order page's "Payment received" is for people paying from another
    // wallet, never a second success screen here.
    if (merchantPayCode) { navigate('/', { replace: true }); return }
    if (returnTo === 'contacts') navigate('/contacts', { replace: true })
    else if (returnTo === 'chat' && returnConvId) navigate(`/chat/${returnConvId}`, { replace: true })
    else if (isDesktop) {
      // Desktop: a fresh payment on the same page, beside the updated
      // Recent History (like Swap / Transfer); phone: Home.
      setProcessStage('idle'); setTxHash(''); setPayPending(false)
      setRecipient(null); setAmount(''); setAmountError(''); setNote(''); setQuery('')
      idempotencyKeyRef.current = null
      goBack2('search')
    }
    else navigate('/', { replace: true })
  }

  // ── Desktop-only: Pay History (right column) ────────────────────────────
  // Real data - this wallet's own outgoing 'send' rows, same ActivityService
  // fetch pattern used across the app. Skipped entirely on mobile (that
  // column doesn't render there), and re-fetched once a payment actually
  // delivers so the new one appears without needing a page reload.
  const [payHistory, setPayHistory] = useState<ActivityRecord[]>([])
  const [payHistoryLoaded, setPayHistoryLoaded] = useState(false)
  const [payHistDetail, setPayHistDetail] = useState<ActivityRecord | null>(null)
  const payFlash = useReturnFlash()
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
  // column of the desktop 2-column layout below - never duplicated.
  // Desktop: no root-level overflow-hidden - each screen already has its
  // own bounded h-full + inner flex-1 overflow-y-auto (mobile's proven
  // pattern), and the desktop column wrapping `flow` already has its own
  // overflowY:'auto'. Hard-clipping here too (on top of that) was cutting
  // off the bottom of tall content - the Success screen's summary card +
  // buttons - with no way to reach it, since this was the innermost clip
  // boundary. Mobile keeps overflow-hidden, unchanged.
  const flow = (
    <div data-leave-guard={isProcessing ? '' : undefined} className={`flex flex-col ${isDesktop ? 'h-full' : 'h-full flex-1 min-h-0 overflow-hidden'}`} style={{ background: 'var(--bg)', borderRadius: isDesktop ? 20 : undefined }}>
      {/* Search → amount → review push like pages (ScreenPush), so two
          screens are never seen through each other mid-change. Desktop:
          ScreenPush's quick fade in place, same as Swap. The screens
          themselves swap instantly - ScreenPush does all the motion. */}
      <ScreenPush screenKey={screen} back={direction === 'back'}>

        {/* ══════════════ SCREEN 1 - SEARCH RECIPIENT ══════════════ */}
        {screen === 'search' && (
          <div key="search" data-pay-search="" className="flex flex-col h-full">
            {/* Desktop: the QR scanner opens over this column only, not the whole screen. */}
            {scanAnchor && (
              <PanelScanner anchor={scanAnchor} wallet={false}
                onClose={() => setScanAnchor(null)}
                onPay={(compound, scanAmount, scanToken) => {
                  setScanAnchor(null)
                  resolveCompoundAsync(compound).then(r => {
                    if (!r) return
                    setRecipient(r)
                    if (scanToken === 'EURC' || scanToken === 'cirBTC' || scanToken === 'USDC') setToken(scanToken)
                    if (scanAmount) setAmount(scanAmount)
                    goForward('amount')
                  })
                }} />
            )}

            <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
              {!isDesktop && (
                <button onClick={goBack} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
              )}
              <div>
                <h1 className="text-xl font-bold text-text-primary">Pay on Arc</h1>
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>Search people on MeshPort</p>
                {recipientError && (
                  <p role="alert" className="text-xs mt-1.5" style={{ color: 'var(--danger-text)' }}>{recipientError}</p>
                )}
              </div>
            </div>

              {/* Single combined search box. Desktop gets a QR button next
                  to it - works like Home's "Scan QR" quick action, but
                  passes align=left so the scanner lands pinned to this
                  page's own column 1 instead of centering across the full
                  content width (which would drift toward column 2). */}
            <div className="px-5 pb-3 flex-shrink-0 flex items-center gap-2.5">
              {/* Same search box as everywhere else. The keyboard only opens
                  when the box is tapped (desktop still focuses it, no keyboard). */}
              <SearchField
                autoFocus={isDesktop && !hasPendingRedirect}
                value={query}
                onChange={setQuery}
                placeholder="Username or 0x address"
                ariaLabel="Search username or wallet address"
                wrap
              />
              {isDesktop && (
                <button onClick={e => { setScanAnchor(e.currentTarget.closest('[data-pay-search]') as HTMLElement | null); prewarmCamera() }} aria-label="Scan QR code"
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
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--brand-text)' }} />
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
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--brand-text)' }} />
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
                  {/* Recent - last people you paid or got paid by, with the last payment */}
                  {recents.length > 0 && (
                    <div>
                      <div className="flex items-center">
                        <div className="flex-1"><SectionLabel>Recent</SectionLabel></div>
                        <button onClick={() => navigate('/recent-paid', { state: { from: '/pay' } })} className="text-[13px] font-semibold mb-2 text-link">See all</button>
                      </div>
                      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        {recents.slice(0, 5).map((r, i) => (
                          <PersonRow key={r.id ?? i} first={i === 0}
                            name={r.displayName === 'You' ? 'You' : (r.displayName || midShortenAddress(r.walletAddress))}
                            username={r.isUsername ? r.display : midShortenAddress(r.walletAddress)}
                            avatarName={r.displayName || r.display} avatarUrl={r.avatarUrl}
                            last={lastFor(r.walletAddress)} showLast usernameBelow
                            onClick={() => pickRecipient(r)} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Contacts - everyone saved, A–Z with letter headers (you pinned first) */}
                  {savedContacts.length > 0 ? (
                    <div>
                      <SectionLabel count={savedContacts.length}>Contacts</SectionLabel>
                      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        {savedContacts.map((c, i) => {
                          const isSelf = c.id === user?.id
                          const name = c.display_name || c.username
                          const letter = isSelf ? '' : contactLetter(name)
                          const prev = i > 0 && savedContacts[i - 1].id !== user?.id ? contactLetter(savedContacts[i - 1].display_name || savedContacts[i - 1].username) : null
                          const header = !isSelf && letter !== prev
                          return (
                            <div key={c.id}>
                              {header && (
                                <p className="px-4 pt-2.5 pb-0.5 text-[12px] font-extrabold text-link"
                                  style={{ borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}>{letter}</p>
                              )}
                              <PersonRow first={i === 0 || header} name={name} self={isSelf} usernameBelow
                                username={c.username?.endsWith('.arc') ? c.username : `${c.username}.arc`}
                                avatarName={name} avatarUrl={c.avatar_url}
                                onClick={() => pickResult(c)} />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : !contactsLoaded && (
                    <div>
                      <SectionLabel>Contacts</SectionLabel>
                      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        {[0, 1, 2, 3].map(i => (
                          <div key={i} className="flex items-center gap-3 px-3.5 py-3"
                            style={{ borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}>
                            <div className="w-9 h-9 rounded-full mp-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }} />
                            <div className="flex-1 space-y-1.5">
                              <div className="h-3 w-28 rounded mp-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }} />
                              <div className="h-2.5 w-20 rounded mp-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {recents.length === 0 && savedContacts.length === 0 && contactsLoaded && (
                    <div className="text-center pt-8">
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Search a username or paste a wallet address</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ══════════════ SCREEN 2 - ENTER AMOUNT ══════════════ */}
        {screen === 'amount' && recipient && (
          <div key="amount" className="flex flex-col h-full">

            <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
              {!isDesktop && (
                <button onClick={goBack} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4">
            {/* Glides up with the number pad on short phones so the amount
                stays in view above it (useKeypadLift). The pad itself sits
                outside this moved box - a transform would break its fixed
                position. */}
            <motion.div animate={{ y: -keypadLift }} initial={false} transition={KEYPAD_SPRING} className="space-y-5">

              {/* Recipient card */}
              <div className="flex items-center gap-3 p-3.5 rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                {recipient.isUsername
                  ? <Avatar name={recipient.displayName} src={recipient.avatarUrl} size="md" />
                  : <div className="w-[46px] h-[46px] rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}><Wallet className="w-5 h-5" style={{ color: 'var(--brand-text)' }} /></div>
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
              {merchantPayCode && (
                <p className="text-[12px]" style={{ color: 'var(--text-secondary)', marginTop: -6 }}>
                  {merchantOrderKind === 'shop' ? 'Amount entered for this shop'
                    : <>{merchantOrderNumber ? `${orderTitle(merchantOrderKind, merchantOrderNumber)} · ` : ''}Amount is fixed by the request</>}
                </p>
              )}

              <div ref={amountBoxRef}>
              <AmountField
                value={amount}
                onChange={raw => { if (merchantPayCode) return; setAmount(sanitizeAmountInput(raw, tokenDisplayDecimals(token))); setAmountError('') }}
                autoFocus={isDesktop && !merchantPayCode}
                // Mobile: the same field opens the number pad.
                onTap={isDesktop ? undefined : () => setShowAmountPad(true)}
                editing={showAmountPad}
                readOnly={!!merchantPayCode}
                invalid={!!amountErrorMessage}
                symbol={tokenSymbolChar(token)}
                tokenPicker={
                  <div className="flex-shrink-0" style={{ position: 'relative', zIndex: showTokenPicker ? 41 : undefined }}>
                    <button onClick={e => { e.stopPropagation(); if (!merchantPayCode) setShowTokenPicker(v => !v) }}
                      aria-expanded={showTokenPicker} className="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full flex-shrink-0 active:opacity-70"
                      style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
                      {/* BUG FIX: this badge hardcoded the USDC "$" glyph +
                          color regardless of which token was actually selected
                          -- picking EURC or cirBTC still showed a blue "$"
                          circle here. Now matches the same per-token
                          symbol/color the other token badges on this page
                          already use (see the receive-summary and token-list
                          badges below). */}
                      <TokenLogo token={token} size={20} />
                      <span className="text-sm font-bold text-text-primary">{token}</span>
                      {!merchantPayCode && <svg className="w-2.5 h-2.5" style={{ color: 'var(--brand-text)', transform: showTokenPicker ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>}
                    </button>
                    <AnimatePresence>
                      {showTokenPicker && (
                        <TokenMenu selected={token} onClose={() => setShowTokenPicker(false)}
                          onSelect={id => { setToken(id as Token); setAmount('') }}
                          options={(['USDC', 'EURC'] as Token[]).concat(cirbtcBalance !== null ? ['cirBTC' as Token] : [])
                            .filter(t => isCoinEnabled(settingsMap, t)).map(t => ({
                              id: t, label: t,
                              icon: <TokenLogo token={t} size={22} />,
                            }))} />
                      )}
                    </AnimatePresence>
                  </div>
                }
                ariaLabel={`Amount in ${token}`}
                // Same fee-safe ceiling as the keypad's Max (maxSpendable).
                onMax={merchantPayCode ? undefined : () => { setAmount(parseFloat(maxSpendable.toFixed(tokenDisplayDecimals(token))).toString()); setAmountError('') }}
                quick={merchantPayCode ? [] : token === 'cirBTC'
                  ? [0.25, 0.5, 0.75].map(f => ({ label: `${f * 100}%`, disabled: maxSpendable <= 0,
                      onClick: () => { setAmount(parseFloat((maxSpendable * f).toFixed(tokenDisplayDecimals(token))).toString()); setAmountError('') } }))
                  : quickAmounts(QUICK_AMOUNTS, tokenSymbolChar(token), v => { setAmount(v); setAmountError('') }, maxSpendable)}
              />
              </div>
              {/* Too much: shown here too once the keypad (which shows it while
                  open) is closed, so it's never just a dimmed Review button. */}
              {amountErrorMessage && (isDesktop || !showAmountPad) && (
                <p role="alert" className="text-[13px] font-semibold text-center" style={{ color: 'var(--danger-text)' }}>{amountErrorMessage}</p>
              )}

              {/* Available balance */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Available Balance</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold" style={{ color: amountExceedsBalance ? 'var(--danger-text)' : 'var(--text-primary)' }}>{formatAmount(activeBalance, tokenDisplayDecimals(token))} {token}</span>
                </div>
              </div>

              {/* Message - optional, saved with the payment. */}
              {!merchantPayCode && (
                <div>
                  <label htmlFor="pay-note" className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Message</label>
                  <div style={{ position: 'relative', marginTop: 6 }}>
                    <input id="pay-note" type="text" value={note} maxLength={140}
                      onChange={e => setNote(e.target.value)}
                      onFocus={() => setShowAmountPad(false)}
                      placeholder="What's it for? (optional)" enterKeyHint="done"
                      className="w-full text-[15px] text-text-primary placeholder-text-secondary focus:outline-none"
                      style={{ display: 'block', height: 46, padding: '0 58px 0 14px', borderRadius: 14, boxSizing: 'border-box',
                        background: 'var(--surface)', border: '1px solid var(--border)' }} />
                    <span aria-hidden className="text-[11px]" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>{note.length}/140</span>
                  </div>
                </div>
              )}
            </motion.div>
            </div>
              {!isDesktop && (
                <AmountKeypad
                  // The amount field above has its own Max.
                  showMax={false}
                  open={showAmountPad}
                  value={amount}
                  onChange={v => { if (merchantPayCode) return; setAmount(v); setAmountError('') }}
                  balance={activeBalance}
                  token={token}
                  // feeReserve/maxSpendable are computed once above from the
                  // fee cached at page-open - Max, this keypad's own Done
                  // button, and the footer's Preview button all validate
                  // against the same fee-safe ceiling.
                  feeReserve={feeReserve}
                  onClose={() => setShowAmountPad(false)}
                  doneLabel="Done"
                  onDone={() => setShowAmountPad(false)}
                  error={amountErrorMessage}
                />
              )}

            {/* Back + Preview footer - the keypad sheet has its own "Review"
                button while it's open, but once it's dismissed (tap outside,
                swipe down) or the user comes back from the Review screen,
                there was no way to continue without reopening the keypad.
                Show a persistent footer instead - but only once an amount
                has actually been entered, so it doesn't appear on a blank
                $0 screen. Desktop's AmountKeypad card is always "open"
                (see its `open` prop above) and has no Back button of its
                own, so the footer stays visible there unconditionally
                once an amount exists, instead of waiting for a sheet to
                close that no longer exists on desktop. */}
            {(isDesktop || !showAmountPad) && (() => {
              const ready = numAmount > 0 && !amountInvalid && !recipientUnverified && !payBlocked
              return (
                <div className="flex-shrink-0 px-5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + 16px)', paddingTop: 8 }}>
                  {payBlocked && (
                    <p role="alert" className="text-[13px] text-center mb-3" style={{ color: 'var(--danger-text)' }}>{payBlockedMessage}</p>
                  )}
                  <button
                    onClick={() => {
                      if (!ready) return
                      // PERF FIX: start the preflight (server intent/nonce
                      // reservation + gas estimate) the instant the user taps
                      // Review, not when they tap the first PIN digit. This
                      // gives the full Review→PIN-entry time (~2-5s) as a
                      // free warm-up window. Previously preparePayment only
                      // ran at PIN entry, so biometric/Face ID users (who
                      // skip typing 6 digits) paid the FULL preflight cost
                      // sequentially after auth - making every biometric pay
                      // feel exactly as slow as a cold send.
                      const fromAddr = senderStoredAddress || user?.walletAddress
                      if (recipient && fromAddr) {
                        const idempotencyKey = getIdempotencyKey()
                        import('@/lib/arcService').then(({ preparePayment }) => preparePayment({
                          token: token === 'EURC' || token === 'cirBTC' ? token : 'USDC',
                          from: fromAddr,
                          to: recipient.walletAddress,
                          amount: numAmount,
                          idempotencyKey,
                          recipientUsername: recipient.isUsername ? recipient.display : undefined,
                          memo: orderMemo(token),
                        })).catch(() => {})
                      }
                      goForward('review')
                    }}
                    disabled={!ready}
                    className="w-full py-4 rounded-2xl text-[15px] font-bold active:scale-[.98]"
                    style={{
                      background: ready ? 'var(--brand)' : 'var(--border)',
                      border: 'none',
                      color: ready ? '#fff' : 'var(--text-secondary)',
                      opacity: ready ? 1 : 0.5,
                    }}>
                    Review
                  </button>
                </div>
              )
            })()}
          </div>
        )}

        {/* ══════════════ SCREEN 3 - REVIEW + INLINE STATES ══════════════ */}
        {screen === 'review' && recipient && (
          <div key="review" className="flex flex-col h-full">

            {/* This is the REAL isDone branch - the one that actually
                renders (confirmed against a live screenshot: this hero
                card's exact copy, "Pay again"/"Back to Home", is what
                really shows up). Every earlier animation attempt was
                spent editing a visually-similar-looking but structurally
                dead copy further down this same file, inside the `: (`
                branch below - reachable only when isDone is FALSE, so it
                could never fire for the actual success case no matter how
                correct the code inside it was. Confirmed by finding that
                exact "Pay again" text only exists once in this whole file:
                right here.
                The flash phase is the only new piece - everything from
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
            {isDone && (successPhase === 'flash' || !heroCheckEl) && (
  <SuccessFlash title={payPending ? "Payment Submitted" : "Paid Successfully"} checkRef={flashCheckRef} viaBiometric={paidViaBiometric} circleReady={flashCircleReady} onCircleReady={() => setFlashCircleReady(true)} rect={isDesktop ? flashColumnRect : null} radius={20} />
)}

            {/* Traveling checkmark clone - bridges the flash checkmark's
                measured position to the hero card's own checkmark spot
                (measured separately, different size/decoration). Fixed,
                on top of everything, only exists during the ~520ms travel
                window; the hero's real checkmark stays invisible until
                travelDone so the handoff between clone and real element
                is seamless. */}
            {travelRect && !travelDone && (
              <TravelingCheckmark from={travelRect.from} to={travelRect.to} toStroke="var(--success)" />
            )}

            {isDone && successPhase === 'collapsed' ? (() => {
              const timeLabel = new Date().toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
              })
              const recipientLabel = recipient.isUsername ? recipient.display : midShortenAddress(recipient.walletAddress)
              const senderLabel = user?.username || (senderStoredAddress ? midShortenAddress(senderStoredAddress) : 'You')
              const amountLabel = `${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token}`
              return (
                <SuccessReceipt
                  reward="pay_send"
                  title={payPending ? 'Payment Submitted' : 'Paid Successfully'}
                  subtitle={payPending
                    ? <>Still confirming on Arc. Activity updates when it lands.</>
                    : <>Delivered on Arc</>}
                  pill={payPending ? undefined : `Completed in ${elapsedSeconds} Seconds`}
                  rows={[
                    { label: 'Amount', value: amountLabel },
                    { label: 'To', value: recipientLabel, positive: true },
                    { label: 'Network Fee', value: estimatedFee > 0 ? `~${formatAmount(estimatedFee, 4)} USDC` : 'Free' },
                    ...(txHash ? [{ label: 'Transaction Hash', value: `${txHash.slice(0, 6)}…${txHash.slice(-4)}`, onCopy: copyHash, copied: hashCopied }] : []),
                    { label: 'Time', value: timeLabel },
                  ]}
                  steps={payPending ? ['Payment approved', <>Payment sent by <strong>{senderLabel}</strong></>] : ['Payment approved', <>Payment made by <strong>{senderLabel}</strong></>, <>Payment received by <strong>{recipientLabel}</strong></>]}
                  detailRows={[
                    { label: 'Network', value: 'Arc Testnet' },
                  ]}
                  fullHash={txHash || undefined}
                  links={txHash ? [{ title: 'View on ArcScan', explorer: 'ArcScan', hash: txHash, href: arcExplorerTxUrl(txHash) }] : undefined}
                  onPrimary={finishDone}
                  checkRef={heroCheckCallback}
                  revealed={travelDone}
                  checkContent={paidViaBiometric && travelDone
                    // Mounted fresh here (not earlier, just hidden) so its
                    // internal toggle timer starts exactly when this becomes
                    // visible.
                    ? <FlashAuthIcon key="landing-toggle" viaBiometric loop size={34} color="var(--success)" />
                    : undefined}
                />
              )
            })() : (
            <>
            {(!isDone || successPhase === 'flash') && (
              <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header flex-shrink-0">
                {!isDesktop && (
                  <button onClick={goBack} disabled={isProcessing || isDone} className="back-btn disabled:opacity-30">
                    <ArrowLeft className="w-5 h-5 text-text-primary" />
                  </button>
                )}
                <h1 className="text-xl font-bold text-text-primary">{isProcessing ? 'Sending Payment' : 'Review Payment'}</h1>
              </div>
            )}

            {/* Desktop-only compact "Success" header (same padding/size as
                MultichainClaimPage's own done-step header) - this step had
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
                     - the whole screen flashes to brand color with a big
                     checkmark + "Paid Successfully", holds briefly, then
                     that panel shrinks away while the detailed success
                     screen fades in underneath. Two named phases
                     (successPhase, declared above with the rest of this
                     screen's state), switched via plain initial/animate/
                     exit - the same pattern every other screen transition
                     in this file already uses successfully (see the
                     search/amount/review screens above), not layout-prop
                     or manual position-tracking, both of which turned out
                     harder to get reliably working for this. */}
                {/* Also stays up under the success flash, so the flash never
                    grows over an empty screen. */}
                {(isProcessing || (isDone && (successPhase === 'flash' || !heroCheckEl))) && (
                  <motion.div key="processing" initial={false}
                    className="flex flex-col items-center justify-center flex-1 space-y-6 py-10">
                    <ProcessingRing size={80} />
                    <p className="text-text-primary" style={{ fontSize: 15, fontWeight: 700 }}>Processing payment…</p>
                    <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>Do not close this screen</p>
                  </motion.div>
                )}

                {/* NOTE: there is no isDone-driven success rendering here
                    anymore. It used to be here, but is structurally dead -
                    this whole tree only ever renders when the OUTER
                    isDone-check (at the top of the "review" screen, a few
                    hundred lines up) has already evaluated to FALSE, so by
                    the time control reaches this point isDone can never be
                    true. That outer branch owns the entire success screen
                    now (hero card + the new full-screen flash phase before
                    it) - see that block's own comment. */}

                {/* ── FAILED STATE (inline): an in-place swap, so a quick fade ── */}
                {processStage === 'failed' && (
                  <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={MOBILE_TAB_FADE_TRANSITION}
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
                {/* No fade-in: on phone the screen already slides in (ScreenPush), and a
                    fade made the details blink in after the header and Pay button. */}
                {processStage === 'idle' && (
                  <motion.div key="reviewcard" initial={false} className="space-y-4 flex-1">
                    {/* Amount hero */}
                    <div className="text-center pt-2 pb-1">
                      <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>You are sending</p>
                      <p className="font-bold" style={{ fontSize: '40px', color: 'var(--brand-text)', lineHeight: 1 }}>{tokenSymbolChar(token)}{formatAmount(numAmount, tokenDisplayDecimals(token))}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-2">
                        <TokenLogo token={token} size={16} />
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
                            page (see `estimatedFee` above) - the Review
                            screen never recomputes it, it just displays the
                            cached value. */}
                        <span className="text-sm font-semibold text-green-400">
                          {estimatedFee > 0 ? `~${formatAmount(estimatedFee, 4)} USDC` : 'Free'}
                        </span>
                      </div>
                      {note.trim() && (
                        <div className="pt-3 mt-2 flex items-start justify-between gap-4" style={{ borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                          <span className="text-sm flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>Message</span>
                          <span className="text-sm font-semibold text-text-primary text-right" style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{note.trim()}</span>
                        </div>
                      )}
                      {!recipient.isUsername && (
                        <div className="flex items-center gap-2 mt-2 p-2.5 rounded-xl" style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)' }}>
                          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--warning-text)' }} />
                          <p className="text-xs font-medium" style={{ color: 'var(--warning-text)' }}>Payments cannot be reversed. Please verify the address carefully.</p>
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

            {/* Pay button - only visible on review idle/failed */}
            {!isProcessing && !isDone && processStage !== 'failed' && (
              <div className="px-5 pb-6 pt-2 flex-shrink-0">
                <button onClick={openPasscodeSheet}
                  className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-[15px] font-bold active:scale-[.98]"
                  style={{ background: 'var(--brand)', color: '#fff', border: 'none' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" />
                  </svg>
                  Pay
                </button>
              </div>
            )}
            </>
            )}
          </div>
        )}
      </ScreenPush>

      {/* ══════════════ PASSCODE STEP (modal over review) ══════════════ */}
      {/* Desktop: the authorize dialog over the flow column. Phone Back
          closes it first (it's a layer over Review); the page's own step
          history (popstate above) leaves that Back alone. */}
      <PinSheet
        open={showPasscodeSheet}
        onClose={() => setShowPasscodeSheet(false)}
        id="ps-pass"
        title={isDesktop ? 'Authorize Payment' : 'Confirm payment'}
        subtitle={isDesktop ? `To ${recipient?.displayName}`
          : `Authorise ${tokenSymbolChar(token)}${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token} to ${recipient?.displayName}`}
        amountLabel={`${tokenSymbolChar(token)}${formatAmount(numAmount, tokenDisplayDecimals(token))} ${token}`}
        card={recipient ? {
          label: 'Paying', name: recipient.displayName || recipient.display,
          detail: recipient.display && recipient.display !== recipient.displayName ? recipient.display : undefined,
          amount: `${tokenSymbolChar(token)}${formatAmount(numAmount, tokenDisplayDecimals(token))}`, unit: token,
        } : undefined}
        bioVerb="Pay"
        anchor={desktopColumnRef.current}
        value={pin}
        onChange={setPin}
        error={pinError ? 'Incorrect passcode. Try again.' : undefined}
        onComplete={(_, viaBiometric) => { if (!isProcessing) { setPaidViaBiometric(!!viaBiometric); verifyAndSend() } }}
      />

    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + Pay History (right), independently scrollable ──
  // The shared 65/35 desktop layout (DesktopTwoColumn), same as Swap.
  return (
    <DesktopTwoColumn
      mainRef={desktopColumnRef}
      main={flow}
      side={
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/activity')}>
          {!payHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : payHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Payments you send will show up here" />
          ) : (
            payHistory.map((r, i, list) => (
              <ActivityRow key={r.id} record={r} isFirst={i === 0} isLast={i === list.length - 1} inPanel
                onSelect={() => { payFlash.opened(); setPayHistDetail(r) }} flash={r.id === payFlash.flashId} />
            ))
          )}
        </DesktopHistoryPanel>
      }
      extra={
      <AnimatePresence>
        {payHistDetail && (() => {
          const r = payHistDetail
          const toLabel = ((r.metadata?.toUsername as string | undefined) || '').replace(/\.arc$/, '')
            || (r.counterpartyAddress ? shortenAddress(r.counterpartyAddress) : 'Unknown recipient')
          return (
            <DesktopHistoryDetail
              onClose={() => { payFlash.closed(r.id); setPayHistDetail(null) }}
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
              explorerLinks={r.txHash ? [{ label: 'View on Arc Explorer', href: arcExplorerTxUrl(r.txHash) }] : undefined}
            />
          )
        })()}
      </AnimatePresence>
      }
    />
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


function lastAmountLabel(amount: number, token: string): string {
  const n = trimTrailingZeros(amount.toFixed(token === 'cirBTC' ? 8 : 2))
  return token === 'USDC' ? `$${n}` : `${n} ${token}`
}
function SectionLabel({ children, count }: { children: string; count?: number }) {
  return (
    <p className="text-[12px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
      {children}
      {count != null && <span className="normal-case tracking-normal text-[11px] font-semibold px-1.5 rounded-md" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>{count}</span>}
    </p>
  )
}

// First letter for the Contacts A–Z headers ('#' for anything that isn't a letter).
function contactLetter(name: string): string {
  const ch = (name || '').trim().charAt(0).toUpperCase()
  return /[A-Z]/.test(ch) ? ch : '#'
}
type LastPayment = { at: string; dir: 'paid' | 'received' | 'failed'; amount: number; token: string }
/** "Today, 6:42 PM" / "Yesterday, 9:15 AM" / "08 Oct, 4:03 PM" (+ year if not this year). */
export function lastPaymentWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 864e5)
  const date = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return `${date}, ${time}`
}
/** "↓ $5 received · Today, 6:42 PM" / "↑ $1 sent · …" / "✕ $2 failed · …" */
export function lastPaymentLine(info: LastPayment): string {
  const when = lastPaymentWhen(info.at)
  const amt = info.amount > 0 ? `${lastAmountLabel(info.amount, info.token)} ` : ''
  const [icon, verb] = info.dir === 'failed' ? ['×', 'failed'] : info.dir === 'paid' ? ['↑', 'sent'] : ['↓', 'received']
  return `${icon} ${amt}${verb}${when ? ` · ${when}` : ''}`
}
// One Pay-page person row: avatar, name + username, optional last payment, Pay pill.
function PersonRow({ name, username, avatarName, avatarUrl, self, last, showLast, first, usernameBelow, onClick }: {
  name: string; username: string; avatarName: string; avatarUrl?: string | null; self?: boolean
  /** Name on the first line, username on its own line under it. */
  usernameBelow?: boolean
  last?: LastPayment; showLast?: boolean; first?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3.5 py-3 active:bg-text-primary/5 transition-colors text-left"
      style={{ borderTop: first ? undefined : '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
      <Avatar name={avatarName} src={avatarUrl ?? undefined} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[15px] font-semibold text-text-primary truncate" style={{ maxWidth: '60%' }}>{name}</span>
          {!usernameBelow && <span className="text-[13px] truncate text-link">{username}</span>}
          {self && (
            <span className="flex-shrink-0 self-center text-[11px] font-bold uppercase tracking-wide px-1.5 py-[1px] rounded-md"
              style={{ color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 14%, transparent)' }}>You</span>
          )}
        </div>
        {usernameBelow && <p className="text-[13px] mt-0.5 truncate text-link">{username}</p>}
        {showLast && (
          <p className="text-[13px] mt-0.5 truncate" style={{ color: last?.dir === 'received' ? 'var(--success-text)' : last?.dir === 'failed' ? 'var(--danger-text)' : 'var(--text-secondary)' }}>
            {last ? lastPaymentLine(last) : 'No payments yet'}
          </p>
        )}
      </div>
      <span className="flex-shrink-0 rounded-full px-4 text-[14px] font-bold flex items-center"
        style={{ height: 32, background: 'var(--brand)', color: '#fff' }}>Pay</span>
    </button>
  )
}
