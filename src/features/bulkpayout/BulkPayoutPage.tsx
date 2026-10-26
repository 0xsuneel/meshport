import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { useState, useRef, useEffect } from 'react'
import { useStepDirection } from '@/hooks/useStepDirection'
import { useNavigate } from 'react-router-dom'
import { PinSheet } from '@/components/ui/PinSheet'
import {
  ArrowLeft, Plus, Trash2, Upload, CheckCircle, XCircle,
  Send, ExternalLink, Search, Loader2, User, Download,
  Users, DollarSign, HelpCircle, AlertCircle
} from 'lucide-react'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { motion, AnimatePresence } from 'framer-motion'
import { MENU_MOTION } from '@/lib/motion'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { AmountField, quickAmounts } from '@/components/ui/AmountField'
import { formatAmount, midShortenAddress, trimTrailingZeros } from '@/lib/utils'
import { getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { prepareBatch, findUnpayable, sendBatch, resolvePayee, batchFee } from '@/lib/batchPay'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { searchUsersDb, getUserByWalletAddress, type DbUser } from '@/lib/supabase'
import { isValidAddress } from '@/lib/arcService'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { ProcessingRing } from '@/components/ui/ProcessingRing'
import { SuccessFlash } from '@/components/ui/SuccessFlash'
import { PointsEarnedLine } from '@/components/rewards/PointsEarnedLine'
import { useKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen'

import { ARC_EXPLORER } from '@/lib/chainExplorers'
import { useLeaveGuard } from '@/lib/leaveGuard'
const USDC_DECIMALS   = 6


type Step = 'setup' | 'review' | 'processing' | 'results'
type RecipientStatus = 'pending' | 'resolved' | 'unresolved'

interface Recipient {
  id: string; input: string; walletAddress: string
  displayName: string; username: string; amount: number
  status: RecipientStatus; error?: string; arcUserId?: string
  avatarUrl?: string | null
}
interface TxResult {
  recipient: Recipient; txHash: string | null
  status: 'success' | 'failed'; error?: string
}

function parseCSV(text: string): Array<{ input: string; amount: number }> {
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length < 2) return []
  const header = lines[0].toLowerCase().split(',').map(h => h.trim())
  const recIdx = header.findIndex(h => ['username','address','recipient','wallet'].some(k => h.includes(k)))
  const amtIdx = header.findIndex(h => h.includes('amount'))
  if (recIdx === -1 || amtIdx === -1) return []
  return lines.slice(1).flatMap(line => {
    const cols = line.split(',').map(c => c.trim())
    const input = cols[recIdx]; const amount = parseFloat(cols[amtIdx])
    if (!input || !amount || amount <= 0) return []
    return [{ input, amount }]
  })
}

// Decimal places a row amount can be typed with - the same cap for the typed
// field (desktop) and the keypad (phone). Max and the totals work in cents.
const BULK_DECIMALS = 2

function downloadCSVTemplate() {
  const csv = 'username,amount\njohn.arc,50\nalice.arc,100\n0x1234567890abcdef1234567890abcdef12345678,75'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'bulk-payout-template.csv'; a.click()
  URL.revokeObjectURL(url)
}

export function BulkPayoutPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const senderAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance, setBalance } = useWalletStore()
  const { showToastMessage } = useUIStore()

  const [step, setStep] = useState<Step>('setup')
  // While the payout is sending, hold Back / sidebar until every row has a result.
  useLeaveGuard(step === 'processing', 'Bulk payout')
  // Setup ⇄ Review slide like pages (forward from the right, back from the left).
  const stepDir = useStepDirection(step, ['setup', 'review', 'processing', 'results'] as const)
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [passEntry, setPassEntry] = useState('')
  const [showReviewPinSheet, setShowReviewPinSheet] = useState(false)
  // Wake the Arc RPC proxy on mount - same pattern as PaySendPage/ChatPage so
  // the cold-start is already resolved by the time the user reaches Review or
  // the passcode sheet. The showReviewPinSheet effect kept below is retained
  // as a belt-and-suspenders re-ping in case the throttle window has expired
  // by the time the user actually taps Pay.
  useEffect(() => {
    import('@/lib/arcService').then(m => m.warmArcRpc()).catch(() => {})
   
  }, [])
  const payoutInFlightRef = useRef(false)
  const [showBulkAmountPad, setShowBulkAmountPad] = useState(false)
  // Mobile: same amount box as Multichain Transfer - tapping it opens the
  // amount keypad and the form glides up so the box sits just above it.
  const bulkAmountBoxRef = useRef<HTMLDivElement>(null)
  const bulkKeypadLift = useKeypadLift(showBulkAmountPad, bulkAmountBoxRef, !isDesktop)
  // The bottom Cancel/Review bar steps aside while the phone keyboard (or the
  // amount keypad) is up, so it never sits on top of what's being typed.
  const keyboardOpen = useKeyboardOpen(!isDesktop)
  const openBulkAmountPad = () => {
    // Close the phone keyboard first (e.g. from the username field).
    (document.activeElement as HTMLElement | null)?.blur?.()
    setShowBulkAmountPad(true)
  }
  const [passError, setPassError] = useState('')
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [results, setResults] = useState<TxResult[]>([])
  const [resolving, setResolving] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [processingStatus, setProcessingStatus] = useState('')
  const [purpose, setPurpose] = useState('')
  const [entryMode, setEntryMode] = useState<'manual' | 'csv'>('manual')

  // ─── Resume an in-flight bulk payout after a refresh ────────────────────
  // If the page reloads while the Multicall3 tx was still confirming, don't
  // drop back to the empty setup screen with zero record the whole batch
  // might have already gone out - that's exactly the situation most likely
  // to make someone re-run the entire payout by accident. There's no
  // reliable way to reconstruct the original per-recipient results list
  // from just a tx hash, so this deliberately doesn't fabricate a fake
  // results screen - it shows a real "checking" state, then tells the user
  // plainly what happened once the activity table (the actual source of
  // truth) confirms it, rather than guessing at a breakdown it can't know.
  useEffect(() => {
    const marker = getResumableOperation('bulkpay')
    if (!marker) return
    const ctx = marker.context as Record<string, any>
    setStep('processing')
    setProcessing(true)
    setProcessingStatus('Checking your last bulk payout...')

    let cancelled = false
    let attempts = 0
    const walletAddress = ctx.walletAddress as string | undefined
    const poll = async () => {
      if (cancelled || !walletAddress) return
      attempts++
      const found = await hasAnyActivityForTx(walletAddress, marker.txHash)
      if (cancelled) return
      if (found) {
        clearResumableOperation('bulkpay')
        setProcessing(false)
        setStep('setup')
        showToastMessage(
          `Your bulk payout of ${trimTrailingZeros(Number(ctx.totalAmount ?? 0).toFixed(4))} USDC to ${ctx.recipientCount ?? 'your'} recipient(s) went through - see Activity for details.`,
          'success',
        )
        return
      }
      if (attempts >= 8) {
        setProcessingStatus('Still confirming - check Activity for the latest status.')
        return
      }
      setTimeout(poll, 1500)
    }
    poll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Manual entry row state
  const [rowUsername, setRowUsername] = useState('')
  const [rowAmount, setRowAmount]     = useState('')
  const [rowResults, setRowResults]   = useState<DbUser[]>([])
  const [rowSearching, setRowSearching] = useState(false)
  const [rowPending, setRowPending]   = useState<DbUser | null>(null)
  const [rowSelected, setRowSelected] = useState(false)  // true = wallet selected, show green badge
  const [addressMatch, setAddressMatch] = useState<DbUser | null>(null)   // MeshPort profile found for a typed 0x address
  const [addressChecking, setAddressChecking] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  const totalAmount    = recipients.reduce((s, r) => s + r.amount, 0)
  const resolvedCount  = recipients.filter(r => r.status === 'resolved').length
  const hasPending     = recipients.some(r => r.status === 'pending')
  const hasUnresolved  = recipients.some(r => r.status === 'unresolved')
  // Only known addresses can repeat: usernames not resolved yet (a Business
  // payout opens here with them pending) have no address and aren't duplicates.
  const knownWallets   = recipients.map(r => r.walletAddress.toLowerCase()).filter(Boolean)
  const hasDuplicates  = new Set(knownWallets).size < knownWallets.length
  // One Multicall3 transaction pays everyone, so this is a flat single-tx gas
  // estimate rather than resolvedCount separate transaction fees.
  const estimatedFee   = batchFee(resolvedCount)
  // More than the USDC balance (payout + network fee, both paid in USDC):
  // warn on the summary and review, and keep Review Payout / Pay dimmed.
  const bulkNeeded = totalAmount + estimatedFee
  // What's left for the next recipient: balance minus everyone already added
  // and the network fee with one more recipient (Max on the amount box).
  const remainingForNext = Math.max(0, (Number(balance) || 0) - totalAmount - batchFee(recipients.length + 1))
  const bulkInsufficient = recipients.length > 0 && totalAmount > 0 && bulkNeeded > (Number(balance) || 0) + 1e-9
  const insufficientNote = bulkInsufficient && (
    <div role="alert" className="rounded-2xl p-3.5" style={{ background: 'color-mix(in srgb, var(--danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
      <p className="text-sm font-semibold text-danger">Insufficient USDC balance</p>
      <p className="text-xs text-text-secondary mt-0.5">
        You have {formatAmount(Number(balance) || 0)} USDC. This payout needs {trimTrailingZeros(bulkNeeded.toFixed(4))} USDC including the network fee.
      </p>
    </div>
  )

  // Live search for manual row - suppress when user already selected
  useEffect(() => {
    const q = rowUsername.trim()
    // Don't search if user already selected - prevents dropdown reopening
    if (rowSelected) { setRowResults([]); setRowSearching(false); return }
    if (!q) { setRowResults([]); setAddressMatch(null); setAddressChecking(false); return }
    if (isValidAddress(q)) {
      // Typed a full wallet address - check if it belongs to a registered MeshPort
      // user before assuming it's an external wallet.
      setRowResults([]); setAddressMatch(null); setAddressChecking(true)
      const t = setTimeout(() => {
        getUserByWalletAddress(q)
          .then(u => setAddressMatch(u))
          .catch(() => setAddressMatch(null))
          .finally(() => setAddressChecking(false))
      }, 200)
      return () => clearTimeout(t)
    }
    setAddressMatch(null); setAddressChecking(false)
    setRowSearching(true)
    const t = setTimeout(() => {
      searchUsersDb(q).then(r => { setRowResults(r); setRowSearching(false) }).catch(() => setRowSearching(false))
    }, 250)
    return () => clearTimeout(t)
  }, [rowUsername, rowSelected])

  const addUser = (u: DbUser, amt: number) => {
    const isExternal = u.id === u.wallet_address
    const rec: Recipient = {
      id: `r_${Date.now()}_${Math.random()}`,
      input: isExternal ? u.wallet_address : u.username,
      walletAddress: u.wallet_address,
      displayName: isExternal ? `${u.wallet_address.slice(0, 10)}...` : u.display_name,
      username: isExternal ? u.wallet_address : u.username,
      amount: amt, status: 'resolved',
      arcUserId: isExternal ? undefined : u.id,
      avatarUrl: isExternal ? null : u.avatar_url,
    }
    setRecipients(prev => {
      if (prev.find(r => r.walletAddress.toLowerCase() === rec.walletAddress.toLowerCase())) {
        showToastMessage('Already in list', 'info'); return prev
      }
      return [...prev, rec]
    })
    setRowUsername(''); setRowAmount(''); setRowResults([]); setRowPending(null); setRowSelected(false)
  }

  const handleRowAdd = () => {
    const amt = parseFloat(rowAmount)
    if (!amt || amt <= 0) { showToastMessage('Enter amount', 'info'); return }
    if (rowPending) { addUser(rowPending, amt); return }
    const q = rowUsername.trim()
    if (isValidAddress(q)) {
      if (addressMatch) { addUser(addressMatch, amt); return }
      addUser({ id: q, username: q, display_name: 'External Wallet', wallet_address: q, email: '', avatar_url: null, created_at: '' } as DbUser, amt)
      return
    }
    showToastMessage('Select a user from the list first', 'info')
  }

  const handleCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const parsed = parseCSV(ev.target?.result as string)
      const newRecs: Recipient[] = parsed.map(p => ({
        id: `csv_${Date.now()}_${Math.random()}`, input: p.input,
        walletAddress: isValidAddress(p.input) ? p.input : '',
        displayName: p.input, username: p.input, amount: p.amount,
        status: isValidAddress(p.input) ? 'resolved' : 'pending' as RecipientStatus,
      }))
      setRecipients(prev => [...prev, ...newRecs])
      showToastMessage(`${newRecs.length} imported`, 'success')
    }
    reader.readAsText(file); e.target.value = ''
  }

  const resolveAll = async () => {
    setResolving(true)
    const updated = await Promise.all(recipients.map(async r => {
      if (r.status === 'resolved') return r
      const payee = await resolvePayee(r.input)
      return payee ? { ...r, ...payee, status: 'resolved' as RecipientStatus }
        : { ...r, status: 'unresolved' as RecipientStatus, error: `"${r.input}" not found` }
    }))
    setRecipients(updated)
    setResolving(false)
    const unresolved = updated.filter(r => r.status === 'unresolved')
    if (unresolved.length === 0) setStep('review')
    else showToastMessage(`${unresolved.length} could not be resolved`, 'error')
  }

  const executePayout = async () => {
    const resolved = recipients.filter(r => r.status === 'resolved')
    if (!resolved.length) return
    // Privacy and USDC blocklist checks for everyone before anything is sent
    // (lib/batchPay); nothing is sent while any is refused. The batch and its
    // chain reads start now, alongside the checks.
    setProcessing(true)
    const prepared = prepareBatch(resolved)
    const refused = await findUnpayable(resolved)
    if (refused.size) {
      setProcessing(false)
      setRecipients(prev => prev.map(r => refused.has(r.id) ? { ...r, status: 'unresolved' as RecipientStatus, error: refused.get(r.id) } : r))
      showToastMessage(refused.size === 1 ? "1 person can't be paid - remove them to continue" : `${refused.size} people can't be paid - remove them to continue`, 'error')
      return
    }
    setStep('processing')
    // ONE Multicall3 transaction pays everyone - all or nothing.
    const outcome = await sendBatch(resolved, { purpose: purpose || 'Payroll', resumeKey: 'bulkpay', onStatus: setProcessingStatus, prepared })
    if (outcome.state === 'locked') return
    const txResults: TxResult[] = resolved.map(r => outcome.state === 'paid'
      ? { recipient: r, txHash: outcome.txHash, status: 'success' }
      : { recipient: r, txHash: outcome.txHash, status: 'failed', error: outcome.error })
    setResults(txResults); setProcessing(false); setStep('results')
  }

  const successCount = results.filter(r => r.status === 'success').length
  const failCount    = results.filter(r => r.status === 'failed').length
  // Full-screen success moment when a payout lands (skipped if nothing went through).
  const [bulkFlash, setBulkFlash] = useState(false)
  useEffect(() => {
    if (step !== 'results' || successCount === 0) { setBulkFlash(false); return }
    setBulkFlash(true)
    const t = setTimeout(() => setBulkFlash(false), 1300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  const isExternal   = (r: Recipient) => r.walletAddress === r.username

  // Empties the recipient list and the amount/username entry.
  const clearEntry = () => {
    setRecipients([]); setPurpose('')
    setRowUsername(''); setRowAmount(''); setRowResults([]); setRowPending(null); setRowSelected(false)
    setAddressMatch(null); setAddressChecking(false)
  }
  // The payout is done: clear the entry screen straight away (the results
  // keep their own copy of who was paid), so it's ready for the next one.
  // Recipients that failed stay in the list (with the purpose), ready to
  // retry with Review Payout.
  useEffect(() => {
    if (step !== 'results') return
    const failed = results.filter(r => r.status === 'failed').map(r => ({ ...r.recipient, error: undefined }))
    const keepPurpose = purpose
    clearEntry()
    if (failed.length) { setRecipients(failed); setPurpose(keepPurpose) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  // Desktop: the step column beside Add Recipients - the passcode and the
  // success flash sit over it, like Transfer's panel.
  const stepColumnRef = useRef<HTMLDivElement>(null)
  // Desktop: Add Recipients is held while the payout runs.
  const recipientsHeld = isDesktop && step === 'processing'
  const recipientsColRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = recipientsColRef.current
    if (!el) return
    el.inert = recipientsHeld
    if (recipientsHeld && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }, [recipientsHeld])

  // ── Shared content, extracted into variables ──────────────────────────
  // Mobile renders these inside the ScreenPush-stepped single
  // column + fixed bottom bar, completely unchanged. Desktop renders them
  // split across a persistent left column (recipients + summary) and a
  // step-driven right column (purpose → review → processing → results),
  // with the action buttons in normal document flow at the bottom of
  // whichever column they belong to instead of position:fixed - the fixed
  // bar was anchored to the whole content area (not the page's own
  // column/maxWidth), which is why it rendered outside/misaligned on
  // desktop's wider layout.

  const addRecipientsSection = (
    <div className={isDesktop ? "bg-surface border border-border rounded-2xl overflow-hidden flex flex-col flex-1 min-h-0" : "bg-surface border border-border rounded-2xl overflow-hidden"}>
      <div className={isDesktop ? "px-4 pt-4 pb-3 border-b border-border flex-shrink-0" : "px-4 pt-4 pb-3 border-b border-border"}>
        <p className="text-sm font-semibold text-text-primary">1. Add Recipients</p>
        {/* Mode tabs */}
        {/* One line on every phone: labels never wrap; below 400px the
            Template link drops to its icon. */}
        <div className="flex gap-1.5 min-[360px]:gap-2 mt-3">
          <button onClick={() => setEntryMode('manual')}
            className={`flex items-center gap-1.5 px-2.5 min-[360px]:px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition ${entryMode === 'manual' ? 'bg-brand text-white border border-brand' : 'text-text-secondary border border-border'}`}>
            <Plus className="w-3.5 h-3.5" /> Manual Entry
          </button>
          <button onClick={() => setEntryMode('csv')}
            className={`flex items-center gap-1.5 px-2.5 min-[360px]:px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition ${entryMode === 'csv' ? 'bg-brand text-white border border-brand' : 'text-text-secondary border border-border'}`}>
            <Upload className="w-3.5 h-3.5" /> Upload CSV
          </button>
          <button onClick={downloadCSVTemplate} aria-label="Download CSV template" title="Download CSV template"
            className="ml-auto flex items-center gap-1 text-xs text-brand-text hover:text-brand-text whitespace-nowrap">
            <Download className="w-3.5 h-3.5 flex-shrink-0" /> <span className="max-[399px]:hidden">Template</span>
          </button>
        </div>
      </div>

      {entryMode === 'manual' && (
        <div className={isDesktop ? "p-4 space-y-2 flex-shrink-0" : "p-4 space-y-2"}>
          <div className="relative">
            {rowPending && rowSelected ? (
              // Selected state - show green badge, amount input below
              <div className="flex items-center gap-2 bg-success/10 border border-success/30 rounded-xl px-4 py-3.5">
                <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
                <span className="flex-1 text-base text-success truncate">
                  {rowPending.display_name === 'External Wallet'
                    ? rowPending.wallet_address.slice(0, 20) + '...'
                    : rowPending.username + '.arc'}
                </span>
                <button
                  onClick={() => { setRowPending(null); setRowUsername(''); setRowSelected(false); setRowResults([]) }}
                  className="text-xs text-text-secondary hover:text-danger transition-colors px-2">
                  ✕ Change
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-surface/50 border border-border rounded-xl px-4 py-3.5">
                {rowSearching
                  ? <Loader2 className="w-4 h-4 text-brand-text animate-spin flex-shrink-0" />
                  : <Search className="w-4 h-4 text-text-secondary flex-shrink-0" />}
                <input
                  type="text"
                  value={rowUsername}
                  onChange={e => { setRowUsername(e.target.value); setRowPending(null); setRowSelected(false) }}
                  placeholder="Username or 0x address"
                  className="flex-1 min-w-0 bg-transparent text-base text-text-primary placeholder-text-muted focus:outline-none"
                />
              </div>
            )}

            {/* Search dropdown - hidden while the amount pad is open: it
                covered the amount being typed. It comes back on Done, so
                typing the amount first and then tapping a name still works. */}
            {rowResults.length > 0 && !showBulkAmountPad && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-2xl z-20 divide-y divide-border shadow-xl">
                {rowResults.map(u => (
                  <button key={u.id} onClick={() => {
                    const amt = parseFloat(rowAmount)
                    if (amt && amt > 0) {
                      addUser(u, amt)
                    } else {
                      setRowPending(u)
                      setRowUsername('')      // clear input - prevents re-triggering search
                      setRowResults([])
                      setRowSearching(false)
                      setRowSelected(true)   // shows green badge
                      setTimeout(() => {
                        const amtInput = document.getElementById('bulk-amount-input')
                        if (amtInput) { (amtInput as HTMLInputElement).focus() }
                      }, 100)
                    }
                  }}
                    className="flex items-center gap-3 px-4 py-3 w-full hover:bg-[rgb(var(--text-primary-rgb)/0.05)] first:rounded-t-2xl last:rounded-b-2xl text-left">
                    <Avatar name={u.display_name} src={u.avatar_url} size="sm" />
                    <div className="flex-1 min-w-0">
                      <UsernameDisplay username={u.username} size="sm" />
                      <p className="text-xs text-text-secondary truncate">{u.display_name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Wallet address entered - checking / MeshPort match / external wallet */}
            {isValidAddress(rowUsername.trim()) && rowResults.length === 0 && !showBulkAmountPad && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-2xl z-20 shadow-xl">
                {addressChecking ? (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Loader2 className="w-4 h-4 text-brand-text animate-spin flex-shrink-0" />
                    <p className="text-xs text-text-secondary">Checking if this is an MeshPort wallet...</p>
                  </div>
                ) : addressMatch ? (
                  // Address belongs to a registered MeshPort user - show their username, not "External Wallet"
                  <button onClick={() => {
                      const amt = parseFloat(rowAmount)
                      if (amt && amt > 0) {
                        addUser(addressMatch, amt)
                      } else {
                        setRowPending(addressMatch)
                        setRowUsername('')
                        setRowResults([])
                        setRowSelected(true)
                        setTimeout(() => {
                          const amtInput = document.getElementById('bulk-amount-input')
                          if (amtInput) (amtInput as HTMLInputElement).focus()
                        }, 50)
                      }
                    }}
                    className="flex items-center gap-3 px-4 py-3 w-full hover:bg-[rgb(var(--text-primary-rgb)/0.05)] rounded-2xl text-left">
                    <Avatar name={addressMatch.display_name} src={addressMatch.avatar_url} size="sm" />
                    <div className="flex-1 min-w-0">
                      <UsernameDisplay username={addressMatch.username} size="sm" />
                      <p className="text-xs text-text-secondary truncate">{addressMatch.display_name} · MeshPort user</p>
                    </div>
                  </button>
                ) : (
                  <button onClick={() => {
                      const wallet = rowUsername.trim()
                      const amt = parseFloat(rowAmount)
                      const extUser = { id: wallet, username: wallet, display_name: 'External Wallet', wallet_address: wallet, email: '', avatar_url: null, created_at: '' } as DbUser
                      if (amt && amt > 0) {
                        addUser(extUser, amt)
                      } else {
                        setRowPending(extUser)
                        setRowUsername('')
                        setRowResults([])
                        setRowSelected(true)   // ← shows green badge immediately
                        setTimeout(() => {
                          const amtInput = document.getElementById('bulk-amount-input')
                          if (amtInput) amtInput.focus()
                        }, 50)
                      }
                    }}
                    className="flex items-center gap-3 px-4 py-3 w-full hover:bg-[rgb(var(--text-primary-rgb)/0.05)] rounded-2xl text-left">
                    <div className="w-8 h-8 bg-surface rounded-full flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-text-secondary" />
                    </div>
                    <div>
                      <p className="text-xs font-mono text-text-primary">{rowUsername.trim().slice(0,20)}...</p>
                      <p className="text-xs text-success">Tap to select external wallet</p>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* One amount field: typed straight in on desktop, tapping it opens
              the keypad sheet on the phone. The phone shows its label, the
              over-balance line and the Add button with it; desktop's Add
              button sits right under the field. */}
          {(() => {
            const overRemaining = (parseFloat(rowAmount) || 0) > remainingForNext + 1e-9
            const field = (
              <AmountField
                id={isDesktop ? 'bulk-amount-input' : undefined}
                value={rowAmount}
                onChange={raw => setRowAmount(sanitizeAmountInput(raw, BULK_DECIMALS))}
                autoFocus={false}
                onTap={isDesktop ? undefined : openBulkAmountPad}
                editing={showBulkAmountPad}
                boxRef={isDesktop ? undefined : bulkAmountBoxRef}
                invalid={!isDesktop && overRemaining}
                ariaLabel="Amount in USDC"
                token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }}
                onMax={balance > 0 ? () => setRowAmount(trimTrailingZeros((Math.floor(remainingForNext * 100) / 100).toFixed(2))) : undefined}
                quick={quickAmounts([10, 50, 100], '$', setRowAmount, remainingForNext)}
              />
            )
            return isDesktop ? (
              <>
                {field}
                <button onClick={handleRowAdd}
                  disabled={!rowAmount || parseFloat(rowAmount) <= 0}
                  className="w-full flex items-center justify-center gap-1.5 px-5 py-3.5 bg-brand/15 border border-brand/30 text-brand-text rounded-xl text-base font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/25 transition">
                  <Plus className="w-4 h-4" /> Add Recipient
                </button>
              </>
            ) : (
              <div className="space-y-2">
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Amount (USDC)</div>
                {field}
                {overRemaining && (
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)', margin: 0 }}>
                    Insufficient balance · Max {formatAmount(Math.floor(remainingForNext * 100) / 100)}
                  </p>
                )}
                <button onClick={() => { setShowBulkAmountPad(false); handleRowAdd() }}
                  disabled={!rowAmount || parseFloat(rowAmount) <= 0 || overRemaining}
                  className="w-full flex items-center justify-center gap-1.5 px-5 py-3.5 bg-brand/15 border border-brand/30 text-brand-text rounded-xl text-base font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/25 transition">
                  <Plus className="w-4 h-4" /> Add Recipient
                </button>
              </div>
            )
          })()}
        </div>
      )}

      {entryMode === 'csv' && (
        <div className={isDesktop ? "p-4 space-y-3 flex-shrink-0" : "p-4 space-y-3"}>
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleCSV} />
          <button onClick={() => fileRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-border rounded-2xl text-text-secondary hover:text-text-primary hover:border-brand/30 transition">
            <Upload className="w-8 h-8" />
            <p className="text-sm font-medium">Click to upload CSV</p>
            <p className="text-xs text-text-muted">Format: username,amount  or  wallet_address,amount</p>
          </button>
          <button onClick={downloadCSVTemplate}
            className="w-full flex items-center justify-center gap-2 py-2.5 border border-border rounded-xl text-xs text-text-secondary hover:text-text-primary transition-colors">
            <Download className="w-3.5 h-3.5" /> Download CSV Template
          </button>
        </div>
      )}

      {/* Added recipients - shown under whichever input mode is active, for
          both manual entries and CSV imports, so the full list with amounts
          is always visible right below where you just added them.
          Desktop: given its own bounded, scrollable box (same pattern
          reviewContent's recipient list already uses) instead of relying on
          the left column's ambient overflow - a CSV import can add far more
          rows than fit on screen, and without this the list just grew the
          whole column past the viewport with no reliable way to reach the
          rows (or the Purpose/Summary/actions below it) further down.
          Mobile unchanged - the page itself is the scroll container there,
          so nesting a second one would only fight it. */}
      {recipients.length > 0 && (
        <div
          className={isDesktop ? "px-4 pb-4 pt-1 space-y-3 border-t border-border mt-1 flex-1 min-h-0 flex flex-col overflow-hidden" : "px-4 pb-4 pt-1 space-y-3 border-t border-border mt-1"}
        >
          <div className={isDesktop ? "grid grid-cols-12 gap-2 px-1 pt-3 flex-shrink-0" : "grid grid-cols-12 gap-2 px-1 pt-3"}>
            <p className="col-span-1 text-xs text-text-muted">#</p>
            <p className="col-span-4 text-xs text-text-muted">Username (.arc)</p>
            <p className="col-span-4 text-xs text-text-muted">Full Name</p>
            <p className="col-span-2 text-xs text-text-muted">Amount</p>
            <p className="col-span-1 text-xs text-text-muted"></p>
          </div>
          <div
            className={isDesktop ? 'space-y-3 overflow-y-auto pr-1 flex-1 min-h-0' : 'space-y-3'}
            style={isDesktop ? { WebkitOverflowScrolling: 'touch' } : undefined}
          >
          {recipients.map((r, i) => (
            <div key={r.id} className="grid grid-cols-12 gap-2 items-center">
              <p className="col-span-1 text-xs text-text-secondary">{i + 1}</p>
              <div className="col-span-4 flex items-center gap-1.5 bg-surface/50 border border-border rounded-xl px-3 py-3">
                <p className="text-sm truncate flex-1">
                  {isExternal(r)
                    ? <span className="text-text-primary">{midShortenAddress(r.walletAddress)}</span>
                    : <span className="text-link">{r.username}.arc</span>}
                </p>
                {r.status === 'resolved' && <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />}
                {r.status === 'unresolved' && <XCircle className="w-4 h-4 text-danger flex-shrink-0" />}
              </div>
              <div className="col-span-4 flex items-center gap-1.5">
                {r.status === 'resolved' && !isExternal(r) ? (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <Avatar name={r.displayName} src={r.avatarUrl} size="xs" />
                    <p className="text-sm text-text-primary truncate">{r.displayName}</p>
                  </div>
                ) : (
                  <p className="text-xs text-text-secondary truncate flex-1">
                    {isExternal(r) ? 'External Wallet' : r.status === 'unresolved' ? r.error : '-'}
                  </p>
                )}
              </div>
              <div className="col-span-2">
                <p className="text-sm text-text-primary text-right">{formatAmount(r.amount)}</p>
              </div>
              <div className="col-span-1 flex justify-end">
                <button onClick={() => setRecipients(prev => prev.filter(p => p.id !== r.id))}
                  className="text-danger/60 hover:text-danger transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  )

  const purposeSection = (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <p className="text-sm font-semibold text-text-primary mb-3">
        2. Purpose <span className="text-text-secondary font-normal text-xs">(Optional)</span>
      </p>
      <div className="relative">
        <textarea
          value={purpose}
          onChange={e => { if (e.target.value.length <= 120) setPurpose(e.target.value) }}
          placeholder="What's it for? (optional)"
          rows={2}
          className="w-full bg-surface/50 border border-border rounded-xl px-3 py-2.5 text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] text-text-primary placeholder-text-muted focus:outline-none focus:border-brand/50 resize-none"
        />
        <p className="text-right text-xs text-text-muted mt-1">{purpose.length}/120</p>
      </div>
    </div>
  )

  // Desktop: genuinely smaller (real padding/gap reductions, not a visual-
  // only transform) so the Cancel/Review Payout buttons below it fit
  // higher up on shorter browser windows without needing to scroll past
  // the OS taskbar to reach them. Mobile sizing untouched.
  const summarySection = recipients.length > 0 && (
    <div className={isDesktop ? "bg-surface border border-border rounded-2xl p-3" : "bg-surface border border-border rounded-2xl p-4"}>
      <p className={isDesktop ? "text-sm font-semibold text-text-primary mb-2" : "text-sm font-semibold text-text-primary mb-3"}>3. Summary</p>
      {insufficientNote && <div className="mb-3">{insufficientNote}</div>}
      <div className={isDesktop ? "grid grid-cols-2 gap-2 mb-2" : "grid grid-cols-2 gap-3 mb-3"}>
        {[
          { icon: <Users className="w-4 h-4 text-brand-text" />, label: 'Recipients', value: recipients.length.toString(), bg: 'bg-brand/10' },
          { icon: <DollarSign className="w-4 h-4 text-success" />, label: 'Total Amount', value: `${formatAmount(totalAmount)} USDC`, bg: 'bg-success/10' },
          { icon: <AlertCircle className="w-4 h-4 text-warning" />, label: 'Estimated Fee', value: `~${trimTrailingZeros(estimatedFee.toFixed(3))} USDC`, bg: 'bg-warning/10' },
          { icon: <ExternalLink className="w-4 h-4 text-accent-text" />, label: 'Network', value: 'Arc Testnet', bg: 'bg-accent/10' },
        ].map(item => (
          <div key={item.label} className={`${item.bg} rounded-xl flex items-center gap-2 ${isDesktop ? 'p-2' : 'p-3'}`}>
            {item.icon}
            <div>
              <p className="text-xs text-text-secondary">{item.label}</p>
              <p className="text-sm font-semibold text-text-primary">{item.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Validation */}
      <div className={isDesktop ? "pt-2 border-t border-border space-y-1" : "pt-3 border-t border-border space-y-1.5"}>
        <p className={isDesktop ? "text-xs text-text-secondary font-medium uppercase tracking-wide mb-1" : "text-xs text-text-secondary font-medium uppercase tracking-wide mb-2"}>Validation</p>
        {[
          { ok: !hasUnresolved, label: hasUnresolved ? `${recipients.filter(r => r.status === 'unresolved').length} unresolved usernames` : 'All usernames are valid' },
          { ok: !hasDuplicates, label: hasDuplicates ? 'Duplicate recipients detected' : 'No duplicate recipients' },
          { ok: !hasPending, label: hasPending ? `${recipients.filter(r => r.status === 'pending').length} pending resolution` : 'All recipients resolved' },
        ].map(v => (
          <div key={v.label} className="flex items-center gap-2">
            <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${v.ok ? 'text-success' : 'text-danger'}`} />
            <p className={`text-xs ${v.ok ? 'text-text-secondary' : 'text-danger'}`}>{v.label}</p>
          </div>
        ))}
      </div>
    </div>
  )

  const reviewContent = (
    <>
      {insufficientNote}
      <div className="bg-surface border border-border rounded-2xl p-4 space-y-2">
        <div className="flex justify-between"><span className="text-text-secondary text-sm">Recipients</span><span className="text-text-primary text-sm font-semibold">{resolvedCount}</span></div>
        <div className="flex justify-between"><span className="text-text-secondary text-sm">Total Amount</span><span className="text-success text-sm font-semibold">${formatAmount(totalAmount)} USDC</span></div>
        <div className="flex justify-between"><span className="text-text-secondary text-sm">Network</span><span className="text-text-primary text-sm font-semibold">Arc Testnet · 1 Batch Tx</span></div>
        <div className="flex justify-between"><span className="text-text-secondary text-sm">Estimated Fee</span><span className="text-text-primary text-sm font-semibold">~{trimTrailingZeros(estimatedFee.toFixed(3))} USDC</span></div>
        {purpose && <div className="flex justify-between"><span className="text-text-secondary text-sm">Purpose</span><span className="text-text-primary text-sm font-semibold">{purpose}</span></div>}
      </div>

      <div className="bg-surface border border-border rounded-2xl divide-y divide-border overflow-y-auto" style={{ maxHeight: '55vh', WebkitOverflowScrolling: 'touch' }}>
        {recipients.filter(r => r.status === 'resolved').map(r => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3">
            {!isExternal(r) ? <Avatar name={r.displayName} src={r.avatarUrl} size="sm" /> : <div className="w-8 h-8 bg-surface rounded-full flex items-center justify-center"><User className="w-4 h-4 text-text-secondary" /></div>}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {isExternal(r)
                  ? <span className="text-text-primary">{r.walletAddress.slice(0,14)}...</span>
                  : <span className="text-link">{r.username}.arc</span>}
              </p>
              <p className="text-xs text-text-secondary truncate">{isExternal(r) ? 'External Wallet' : r.displayName}</p>
            </div>
            <span className="text-sm font-semibold text-text-primary">${formatAmount(r.amount)}</span>
          </div>
        ))}
      </div>
    </>
  )

  const processingContent = (
    <>
      <div className="flex justify-center"><ProcessingRing size={80} /></div>
      <div>
        <h2 className="text-xl font-bold text-text-primary">Executing Bulk Payout</h2>
        <p className="text-text-secondary mt-1 text-sm">{processingStatus || `${resolvedCount} transfers via Multicall3`}</p>
      </div>
      <p className="text-xs text-text-muted">Do not close this screen</p>
    </>
  )

  const resultHashes = [...new Set(results.map(r => r.txHash).filter(Boolean))]
  const sharedTxHash = resultHashes.length === 1 && results.filter(r => r.txHash).length > 1 ? resultHashes[0] : null
  const resultsContent = (
    <>
      {bulkFlash && <SuccessFlash title={failCount ? `${successCount} Payments Sent` : 'Payout Successful'}
        rect={isDesktop ? stepColumnRef.current?.getBoundingClientRect() ?? null : null} radius={20} />}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-success/10 border border-success/30 rounded-2xl p-4 text-center">
          <p className="text-3xl font-bold text-success">{successCount}</p>
          <p className="text-sm text-success">Successful</p>
        </div>
        <div className="bg-danger/10 border border-danger/30 rounded-2xl p-4 text-center">
          <p className="text-3xl font-bold text-danger">{failCount}</p>
          <p className="text-sm text-danger">Failed</p>
        </div>
      </div>
      {successCount > 0 && <div className="flex justify-center"><PointsEarnedLine type="bulkpay" /></div>}
      {/* The whole payout is one transaction (Multicall3): one link for it,
          not the same link on every row. */}
      {sharedTxHash && (
        <a href={`${ARC_EXPLORER}/tx/${sharedTxHash}`} target="_blank" rel="noopener noreferrer"
          className="text-sm font-semibold text-brand-text flex items-center justify-center gap-1.5">
          <ExternalLink className="w-4 h-4" /> View transaction on ArcScan
        </a>
      )}
      <div className="bg-surface border border-border rounded-2xl divide-y divide-border">
        {results.map(r => (
          <div key={r.recipient.id} className="flex items-center gap-3 px-4 py-3">
            {r.status === 'success' ? <CheckCircle className="w-5 h-5 text-success flex-shrink-0" /> : <XCircle className="w-5 h-5 text-danger flex-shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {isExternal(r.recipient)
                  ? <span className="text-text-primary">{r.recipient.walletAddress.slice(0,14)}...</span>
                  : <span className="text-link">{r.recipient.username}.arc</span>}
              </p>
              <p className="text-xs text-text-secondary">${formatAmount(r.recipient.amount)} USDC</p>
              {r.txHash && !sharedTxHash && (
                <a href={`${ARC_EXPLORER}/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-brand-text flex items-center gap-1 mt-0.5">
                  <ExternalLink className="w-3 h-3" /> View on ArcScan
                </a>
              )}
              {r.error && <p role="alert" className="text-xs text-danger mt-0.5">{r.error}</p>}
            </div>
          </div>
        ))}
      </div>
    </>
  )

  // Action-button rows - same JSX, mobile places them inside the fixed
  // bottom bar (unchanged), desktop places them in-flow at the bottom of
  // the right column's current step.
  const setupActionButtons = recipients.length === 0 ? (
    <button onClick={() => navigate('/')}
      className="w-full py-3.5 rounded-2xl font-semibold"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      Cancel
    </button>
  ) : (
    <div className="flex gap-3">
      <button onClick={() => navigate('/')}
        className="flex-1 py-3.5 rounded-2xl font-semibold"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
        Cancel
      </button>
      {(hasPending || hasUnresolved) ? (
        <button onClick={resolveAll} disabled={resolving}
          className="flex-1 py-3.5 rounded-2xl text-white font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
          {resolving ? <><Loader2 className="w-4 h-4 animate-spin" /> Resolving...</> : `Resolve ${recipients.filter(r => r.status !== 'resolved').length} Pending`}
        </button>
      ) : (
        <button onClick={() => {
            if (bulkInsufficient) return
            // Re-ping the RPC proxy now so the warm-up overlaps with the
            // user reviewing the recipient list before tapping Pay.
            import('@/lib/arcService').then(m => m.warmArcRpc()).catch(() => {})
            setStep('review')
          }} disabled={bulkInsufficient}
          className="flex-1 py-3.5 rounded-2xl text-white font-bold flex items-center justify-center gap-2 disabled:opacity-40"
          style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
          Review Payout <Send className="w-4 h-4" />
        </button>
      )}
    </div>
  )

  const reviewActionButtons = (
    <div className="flex gap-3">
      <button onClick={() => setStep('setup')}
        className="flex-1 py-3.5 rounded-2xl font-semibold"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
        Back
      </button>
      <button onClick={() => {
          if (bulkInsufficient) return
          if (storedPasscode) { setPassEntry(''); setPassError(''); setShowReviewPinSheet(true) }
          else executePayout()
        }}
        disabled={bulkInsufficient}
        className="flex-1 py-3.5 rounded-2xl text-white font-bold flex items-center justify-center gap-2 disabled:opacity-40"
        style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
        Pay <Send className="w-4 h-4" />
      </button>
    </div>
  )

  const resultsActionButtons = (
    <div className="flex flex-col gap-2.5">
      {/* The failed recipients are still in the list - back to it to retry them. */}
      {failCount > 0 && (
        <button onClick={() => { setStep('setup'); setResults([]) }}
          className="w-full py-3.5 rounded-2xl text-white font-bold"
          style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
          Retry {failCount} failed
        </button>
      )}
      <button onClick={() => { setStep('setup'); setResults([]); clearEntry() }}
        className={failCount > 0 ? 'w-full py-3.5 rounded-2xl font-semibold' : 'w-full py-3.5 rounded-2xl text-white font-bold'}
        style={failCount > 0
          ? { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
          : { background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
        New Bulk Payment
      </button>
      <button onClick={() => navigate('/')}
        className="w-full py-3.5 rounded-2xl font-semibold"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
        Back to Home
      </button>
    </div>
  )

  return (
    // Desktop: overflow:visible, not hidden - each column already manages
    // its own scroll (overflowY:'auto' below), and a hard-clipping root on
    // top of that was the same bug already found and fixed on Swap/Pay/
    // Multichain Claim: it clipped the Cancel/Review Payout buttons at the
    // bottom of the right column with no way to reach them. Mobile
    // unchanged (its own overflow-y-auto root, untouched).
    <div className={`flex flex-col bg-bg ${isDesktop ? 'h-full overflow-visible' : 'h-full overflow-y-auto pb-24'}`}>

      {/* ── HEADER ── */}
      <div className="header-row sticky top-0 z-20 bg-bg px-5 pt-header pb-header flex-shrink-0">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate('/')} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary whitespace-nowrap">Bulk Payment</h1>
            <p className="text-xs text-text-secondary">Send USDC to multiple recipients in one transaction</p>
          </div>
          <button onClick={() => setShowHowItWorks(true)} aria-label="How it works?" className="flex-shrink-0 whitespace-nowrap flex items-center gap-1.5 px-2.5 min-[375px]:px-3 py-1.5 border border-brand/30 rounded-xl text-xs text-brand-text active:scale-95 transition-transform">
            <HelpCircle className="w-3.5 h-3.5" /> <span className="hidden min-[375px]:inline">How it works?</span>
          </button>
        </div>
      </div>

      {isDesktop ? (
        // Desktop: left column = Add Recipients + Summary, persistent
        // across every step (matches "summary in left column"). Right
        // column = the step-driven flow (Purpose+actions → Review →
        // Processing → Results), same full-bleed/height:100%/trimmed-
        // bottom-padding spacing treatment as Swap's 2-column layout.
        // Results keeps its exact existing content/design, just moved
        // in-flow into this column instead of the page-wide fixed bar.
        // The shared desktop layout (DesktopTwoColumn), filling the space
        // under the page header.
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* BUG FIX (2026-09-03): this column used to be overflowY: 'auto'
              itself, WHILE the recipient list inside addRecipientsSection
              also had its own overflow-y-auto + maxHeight: 40vh - two
              nested scroll containers competing for the same wheel input.
              With few recipients (list shorter than 40vh, nothing to
              scroll internally), every scroll gesture fell through to
              THIS column instead, dragging the "Add Recipient" header/
              form out of view and giving no reliable way to see how many
              people had actually been added. Now `overflow: hidden` here
              - addRecipientsSection manages its own internal scroll (see
              its own flex-1/min-h-0 structure), so the recipient list is
              the ONE genuine scroll region, and the input form above it
              stays fixed/visible while it scrolls. */}
          {/* While the payout runs, nothing in Add Recipients responds (inert,
              dimmed, not-allowed cursor). Once the results show, a tap
              anywhere here closes them and goes back to entry (Purpose
              panel), ready for the next payout - no need to press New Bulk
              Payment first. Failed recipients stay listed for a retry. */}
          <DesktopTwoColumn stage
            mainProps={{ 'aria-busy': recipientsHeld || undefined, title: recipientsHeld ? 'Payout in progress' : undefined,
              onPointerDownCapture: () => { if (step === 'results') { setStep('setup'); setResults([]) } },
              style: { cursor: recipientsHeld ? 'not-allowed' : undefined } }}
            main={
              <div ref={recipientsColRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 16,
                opacity: recipientsHeld ? 0.55 : 1, transition: 'opacity 0.2s ease' }}>
                {addRecipientsSection}
              </div>
            }
            sideRef={stepColumnRef}
            sideProps={{ 'data-leave-guard': step === 'processing' ? '' : undefined, style: { borderRadius: 20 } }}
            side={<>
            {/* Steps fade in place (ScreenPush's desktop fade, same as Pay / Swap). */}
            <ScreenPush screenKey={step} back={stepDir === 'back'}>
              {step === 'setup' && (
                <div key="d-setup" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {purposeSection}
                  {summarySection}
                  {setupActionButtons}
                </div>
              )}
              {step === 'review' && (
                <div key="d-review" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {reviewContent}
                  {reviewActionButtons}
                </div>
              )}
              {step === 'processing' && (
                <div key="d-processing" className="py-16 text-center space-y-6">
                  {processingContent}
                </div>
              )}
              {step === 'results' && (
                <div key="d-results" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {resultsContent}
                  {resultsActionButtons}
                </div>
              )}
            </ScreenPush>
            </>} />
        </div>
      ) : (
      <>
      {/* Glides up with the amount keypad so the amount box stays in view
          (the keypad itself is rendered outside this, below). */}
      <motion.div animate={{ y: -bulkKeypadLift }} initial={false} transition={KEYPAD_SPRING}>
      {/* Steps push like pages (no fade-out to an empty screen in between).
          Processing → results stay on one screen. */}
      <ScreenPush screenKey={step === 'processing' || step === 'results' ? 'run' : step} back={stepDir === 'back'}>

        {/* ══════════════════ SETUP STEP ══════════════════ */}
        {step === 'setup' && (
          <div key="setup" className="px-4 space-y-4">
            {addRecipientsSection}
            {purposeSection}
            {summarySection}
          </div>
        )}

        {/* ══════════════════ REVIEW STEP ══════════════════ */}
        {step === 'review' && (
          <div key="review" className="px-4 space-y-4">
            {reviewContent}
          </div>
        )}

        {/* ══════════════════ PROCESSING ══════════════════ */}
        {step === 'processing' && (
          <div key="processing" data-leave-guard="" className="px-4 py-16 text-center space-y-6">
            {processingContent}
          </div>
        )}

        {/* ══════════════════ RESULTS ══════════════════ */}
        {step === 'results' && (
          <div key="results" className="px-4 space-y-4">
            {resultsContent}
          </div>
        )}

      </ScreenPush>
      </motion.div>

      <AmountKeypad
        open={showBulkAmountPad}
        value={rowAmount}
        onChange={v => setRowAmount(v)}
        balance={remainingForNext}
        token="USDC"
        // Same decimals cap as the typed field.
        decimals={BULK_DECIMALS}
        // The amount box above already has its own Max, like Transfer.
        showMax={false}
        onClose={() => setShowBulkAmountPad(false)}
        onDone={() => setShowBulkAmountPad(false)}
      />

      {/* ── FIXED BOTTOM ACTION BAR ── hidden while typing (phone keyboard or
          amount keypad up) so it never covers the field being filled in. */}
      {!(keyboardOpen || showBulkAmountPad) && (
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 pt-3 bg-gradient-to-t from-bg via-bg/95 to-transparent z-20">
          {step === 'setup' && setupActionButtons}
          {step === 'review' && reviewActionButtons}
          {step === 'results' && resultsActionButtons}
        </div>
      )}
      </>
      )}

      {/* ── Review step: the passcode step - opens only when Pay is tapped.
          Can't be closed while the payout is sending. ── */}
      <PinSheet
        open={showReviewPinSheet}
        onClose={() => { setShowReviewPinSheet(false); setPassEntry(''); setPassError('') }}
        locked={processing}
        id="bp-pass"
        bioVerb="Pay"
        title={isDesktop ? 'Authorize Bulk Payout' : 'Confirm payout'}
        // Phone: who and the total, as a card under the title.
        card={{ label: 'Paying', name: `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`, detail: 'Bulk payout', amount: `$${formatAmount(totalAmount)}`, unit: 'USDC' }}
        subtitle={`To ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
        amountLabel={`$${formatAmount(totalAmount)} USDC`}
        anchor={stepColumnRef.current}
        value={passEntry}
        onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={async () => {
          // Synchronous guard - prevents a double-fire from triggering
          // two separate batch payout transactions.
          if (payoutInFlightRef.current) return
          payoutInFlightRef.current = true
          try {
            const { verifyPasscode } = await import('@/lib/security')
            const ok = await verifyPasscode(passEntry, storedPasscode!)
            if (!ok) { setPassError('Incorrect passcode'); setPassEntry(''); return }
            setPassEntry(''); setPassError('')
            setShowReviewPinSheet(false)
            await executePayout()
          } finally {
            payoutInFlightRef.current = false
          }
        }}
      />

      {/* How it works tooltip - tap anywhere to dismiss */}
      <AnimatePresence>
        {showHowItWorks && (
          // Only the card moves (the menu motion); the layer around it just
          // catches the tap that dismisses it.
          <div
            key="how-it-works"
            className="absolute inset-0 z-50 flex items-start justify-end"
            style={{ paddingTop: '80px', paddingRight: '16px' }}
            onClick={() => setShowHowItWorks(false)}
          >
            <motion.div
              {...MENU_MOTION}
              onClick={e => e.stopPropagation()}
              className="rounded-2xl p-4 w-72"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-3)' }}
            >
              {/* Arrow pointer */}
              <div style={{ position: 'absolute', top: -7, right: 24, width: 14, height: 14, background: 'var(--surface)', border: '1px solid var(--border)', transform: 'rotate(45deg)', borderRight: 'none', borderBottom: 'none' }} />
              <p className="text-sm font-bold text-text-primary mb-3">How Bulk Pay works</p>
              <div className="space-y-2.5">
                {[
                  { n: '1', t: 'Add recipients', d: 'Enter usernames or wallet addresses manually, or upload a CSV file.' },
                  { n: '2', t: 'Set amounts', d: 'Assign a USDC amount to each recipient individually.' },
                  { n: '3', t: 'Review & confirm', d: 'Check the total, then confirm. All recipients are paid together in one Multicall3 transaction.' },
                  { n: '4', t: 'Done!', d: 'All recipients get paid instantly on Arc Testnet.' },
                ].map(item => (
                  <div key={item.n} className="flex gap-3">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: 'color-mix(in srgb, var(--brand) 20%, transparent)', fontSize: '11px', fontWeight: 700, color: 'var(--brand-text)' }}>
                      {item.n}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-text-primary">{item.t}</p>
                      <p className="text-xs text-text-secondary mt-0.5">{item.d}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-text-muted text-center mt-3">Tap anywhere to dismiss</p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
