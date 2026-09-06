import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import {
  ArrowLeft, Plus, Trash2, Upload, CheckCircle, XCircle,
  Send, ExternalLink, Search, Loader2, User, Download,
  Users, DollarSign, HelpCircle, AlertCircle
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {createPublicClient, createWalletClient, parseGwei, encodeFunctionData} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { notifyRewardBulk } from '@/lib/notifications'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { formatAmount, shortenAddress, midShortenAddress, trimTrailingZeros } from '@/lib/utils'
import { saveResumableOperation, getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { searchUsersDb, resolveUsernameDb, getUserByWalletAddress, type DbUser } from '@/lib/supabase'
import { isValidAddress } from '@/lib/arcService'
import { arcTestnet as ARC_CHAIN } from '@/lib/chain'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { arcTransport, arcRpcJson } from '@/lib/arc'

const ARC_EXPLORER    = 'https://testnet.arcscan.app'
const USDC_DECIMALS   = 6

// ── Multicall3 (canonical deterministic deployment, same address on every EVM chain) ──
// https://github.com/mds1/multicall — deployed via CREATE2 at this address on 100+ chains.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

// Only the piece of the Multicall3 ABI we actually call: aggregate3Value.
// Call3Value.value lets each leg forward native value, and the whole batch is
// submitted (and mined) as ONE transaction — one txHash covers every recipient.
const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3Value',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

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

// Digit/decimal sanitizing for the desktop "Amount" native input (mirrors
// AmountKeypad's own internal sanitizer, which isn't exported) — max one
// '.', capped at 2 typed decimal places.
function sanitizeBulkAmount(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, 2)
  return cleaned
}

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
  const privateKey = useAuthStore(s => s.privateKey)
  const senderAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance, setBalance } = useWalletStore()
  const { showToastMessage } = useUIStore()

  const [step, setStep] = useState<Step>('setup')
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [passEntry, setPassEntry] = useState('')
  const [showReviewPinSheet, setShowReviewPinSheet] = useState(false)
  const payoutInFlightRef = useRef(false)
  const [showBulkAmountPad, setShowBulkAmountPad] = useState(false)
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
  // might have already gone out — that's exactly the situation most likely
  // to make someone re-run the entire payout by accident. There's no
  // reliable way to reconstruct the original per-recipient results list
  // from just a tx hash, so this deliberately doesn't fabricate a fake
  // results screen — it shows a real "checking" state, then tells the user
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
          `Your bulk payout of ${trimTrailingZeros(Number(ctx.totalAmount ?? 0).toFixed(4))} USDC to ${ctx.recipientCount ?? 'your'} recipient(s) went through — see Activity for details.`,
          'success',
        )
        return
      }
      if (attempts >= 8) {
        setProcessingStatus('Still confirming — check Activity for the latest status.')
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
  const hasDuplicates  = new Set(recipients.map(r => r.walletAddress.toLowerCase())).size < recipients.length
  // One Multicall3 transaction pays everyone, so this is a flat single-tx gas
  // estimate rather than resolvedCount separate transaction fees.
  const estimatedFee   = resolvedCount > 0 ? 0.002 + resolvedCount * 0.0002 : 0

  // Live search for manual row — suppress when user already selected
  useEffect(() => {
    const q = rowUsername.trim()
    // Don't search if user already selected — prevents dropdown reopening
    if (rowSelected) { setRowResults([]); setRowSearching(false); return }
    if (!q) { setRowResults([]); setAddressMatch(null); setAddressChecking(false); return }
    if (isValidAddress(q)) {
      // Typed a full wallet address — check if it belongs to a registered MeshPort
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
      if (isValidAddress(r.input)) {
        const profile = await getUserByWalletAddress(r.input).catch(() => null)
        return { ...r, walletAddress: r.input, displayName: profile?.display_name || shortenAddress(r.input), username: profile?.username || shortenAddress(r.input), status: 'resolved' as RecipientStatus, arcUserId: profile?.id, avatarUrl: profile?.avatar_url }
      }
      const cleanName = r.input.replace(/^@/, '').replace(/\.arc$/, '')
      const addr = await resolveUsernameDb(cleanName).catch(() => null)
      if (addr) {
        const profile = await getUserByWalletAddress(addr).catch(() => null)
        return { ...r, walletAddress: addr, displayName: profile?.display_name || cleanName, username: profile?.username || cleanName, status: 'resolved' as RecipientStatus, arcUserId: profile?.id, avatarUrl: profile?.avatar_url }
      }
      return { ...r, status: 'unresolved' as RecipientStatus, error: `"${r.input}" not found` }
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
    setProcessing(true); setStep('processing')
    const txResults: TxResult[] = []
    // One BulkPay operation = one idempotency key, generated once per
    // executePayout invocation (i.e. once per button click) — a genuinely
    // new click gets a fresh key; nothing in this function regenerates it
    // mid-flight. Server-enforced via transaction_intents_wallet_idem_key
    // UNIQUE(wallet_address, idempotency_key) — see
    // docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md Question B.
    const idempotencyKey = crypto.randomUUID()

    setProcessingStatus('Restoring wallet signer...')
    let activePrivateKey = privateKey
    if (!activePrivateKey) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      await restorePrivateKey()
      activePrivateKey = useAuthStore.getState().privateKey
    }
    if (!activePrivateKey) {
      useAuthStore.getState().lock(); return
    }

    setProcessingStatus('Connecting to Arc Testnet...')
    try {
      const account = privateKeyToAccount(activePrivateKey as `0x${string}`)
      // Arc docs: walletClient WITHOUT chain — chain is passed inline to sendTransaction
      const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })
      const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: arcTransport() })

      setProcessingStatus('Checking balance...')
      // Arc docs: use eth_getBalance (18-decimal native USDC wei), not ERC-20 balanceOf
      // Both share same underlying balance. eth_getBalance is the Arc-recommended method.
      const balJson = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [account.address, 'latest'] })
      const rawBal = balJson.result && balJson.result !== '0x' ? balJson.result : '0x0'
      // Arc native balance: 18 decimals. Divide by 1e18 to get human-readable USDC.
      const balanceUsdc = Number(BigInt(rawBal)) / 1e18
      if (balanceUsdc < totalAmount) {
        resolved.forEach(r => txResults.push({ recipient: r, txHash: null, status: 'failed', error: `Insufficient balance: have ${trimTrailingZeros(balanceUsdc.toFixed(4))} USDC, need ${trimTrailingZeros(totalAmount.toFixed(4))} USDC` }))
      setResults(txResults); setProcessing(false); setStep('results'); clearResumableOperation('bulkpay'); return
      }

      // ── One BulkPay operation = one transaction_intent + one
      // transaction_attempt, created server-side BEFORE any broadcast
      // (docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md /
      // docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md). The nonce this
      // returns is the ONLY nonce used below — this function no longer
      // computes its own authoritative nonce via
      // publicClient.getTransactionCount at all; a client-computed nonce
      // is exactly the value a lost broadcast response leaves nothing to
      // reconcile against.
      setProcessingStatus('Preparing bulk payout...')
      const totalAmountAtomic = (BigInt(Math.round(totalAmount * 1_000_000)) * (10n ** 12n)).toString()
      const { createBulkPayIntent, markBulkPayAttemptSubmitted } = await import('@/lib/bulkPayIntentService')
      const intentResult = await createBulkPayIntent({
        walletAddress: account.address,
        idempotencyKey,
        chainId: 'arc',
        amountAtomic: totalAmountAtomic,
        decimals: 18,
        isNative: true,
        tokenAddress: null,
        tokenSymbol: 'USDC',
        recipientCount: resolved.length,
        purpose: purpose || 'Payroll',
      })
      if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
        resolved.forEach(r => txResults.push({ recipient: r, txHash: null, status: 'failed', error: intentResult.error ?? 'Failed to prepare bulk payout' }))
        setResults(txResults); setProcessing(false); setStep('results'); clearResumableOperation('bulkpay'); return
      }
      const attemptId = intentResult.attemptId
      const serverNonce = intentResult.nonce

      // ── Send ALL payouts in ONE Multicall3 transaction ─────────────────────────
      // Arc's USDC is the chain's native currency (see sendUSDC in arcService.ts —
      // sends move funds via call value, not an ERC-20 transfer() call).
      // aggregate3Value lets the caller attach native value to the outer tx and have
      // Multicall3 forward a slice of it to each `target` as `target.call{value: v}("")`.
      // Recipients here are plain wallet addresses expecting a plain value transfer
      // (no calldata to execute), so it doesn't matter that msg.sender inside that
      // call is the Multicall3 contract — Multicall3 holds the value for the
      // duration of the call because we funded it via msg.value on this same tx.
      // allowFailure is set to false for every leg, so the batch is atomic: either
      // every recipient is paid in this one transaction, or none are and the whole
      // tx reverts (no funds move, no dangling partial state).
      let bulkTxHash: `0x${string}` | null = null
      try {
        setProcessingStatus(`Building multicall for ${resolved.length} recipients...`)
        const calls = resolved.map(r => {
          const amount6dec  = BigInt(Math.round(r.amount * 1_000_000))
          const amount18dec = amount6dec * (10n ** 12n)
          return {
            target: r.walletAddress as `0x${string}`,
            allowFailure: false,
            value: amount18dec,
            callData: '0x' as `0x${string}`,
          }
        })
        const totalValue = calls.reduce((sum, c) => sum + c.value, 0n)

        const data = encodeFunctionData({
          abi: MULTICALL3_ABI,
          functionName: 'aggregate3Value',
          args: [calls],
        })

        const gasEst = await publicClient.estimateGas({
          account: account.address,
          to: MULTICALL3_ADDRESS,
          data,
          value: totalValue,
        }).catch(() => 80_000n + BigInt(resolved.length) * 40_000n)
        // Server-issued nonce (above) — NEVER a client-computed
        // publicClient.getTransactionCount call. See
        // docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md for why an
        // authoritative, server-independently-recorded nonce is what makes
        // Case 2 (lost broadcast response) recoverable at all.
        const nonce = serverNonce

        setProcessingStatus('Sending bulk payout transaction...')
        // Cast: viem's sendTransaction overload resolution (in the installed
        // viem/typescript combination) spuriously demands an EIP-4844 `kzg`
        // field for this plain EIP-1559 transaction. Runtime behavior is
        // unaffected — this is purely a type-level viem overload issue.
        const txHash = await walletClient.sendTransaction({
          to:    MULTICALL3_ADDRESS,
          data,
          value: totalValue,
          gas:   (gasEst * 130n) / 100n,
          maxFeePerGas:         parseGwei('25'),
          maxPriorityFeePerGas: parseGwei('1'),
          chain: ARC_CHAIN,
          nonce,
        } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

        // FIX (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md Phase 3):
        // bulkTxHash is now assigned IMMEDIATELY here, before the receipt
        // wait below — not after it succeeds. sendTransaction returning is
        // proof a real transaction was broadcast; if the receipt wait times
        // out or throws, the outer catch block (which only has access to
        // the OUTER `bulkTxHash`, not this inner `const txHash`, since the
        // latter is block-scoped to this try) now still has the real hash
        // to work with, instead of losing it entirely.
        bulkTxHash = txHash

        // Persist enough to resume this screen if the page gets refreshed
        // while still confirming — without this, a refresh here drops back
        // to the empty setup screen with no record the batch might have
        // already gone out, the exact situation most likely to make
        // someone re-run the whole payout by accident. Cleared once this
        // reaches 'results' below (success or failure either way).
        saveResumableOperation('bulkpay', txHash, {
          totalAmount, recipientCount: resolved.length, walletAddress: account.address,
        })

        // Persist the real tx_hash server-side, ALSO immediately, ALSO
        // before the receipt wait — this is what makes the attempt
        // recoverable even if THIS process is killed a moment from now
        // (tab close, network loss), which the local bulkTxHash variable
        // alone cannot help with. Deliberately fire-and-forget from this
        // flow's own perspective: markBulkPayAttemptSubmitted never throws
        // (it catches its own errors and returns {success:false}), and its
        // own failure must never block or fail the user's already-broadcast,
        // already-real payment — the attempt simply stays server-side
        // unconfirmed for this one call's worth of tx_hash persistence,
        // recoverable later by the existing UNKNOWN/nonce-recovery
        // machinery (docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md) exactly
        // as if this call had never been attempted at all.
        void markBulkPayAttemptSubmitted(attemptId, txHash).catch(() => { /* best-effort, see comment above */ })

        setProcessingStatus('Confirming bulk payout transaction...')
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000, confirmations: 1 })
        if (receipt.status === 'reverted') throw new Error('Multicall3 transaction reverted')

        // ONE tx, ONE hash — every recipient references the same bulkTxHash.
        resolved.forEach(r => txResults.push({ recipient: r, txHash: bulkTxHash, status: 'success' }))
      } catch (e: any) {
        const errMsg = e?.shortMessage || e?.message || 'Bulk multicall send failed'
        // bulkTxHash may now be non-null here (a real broadcast whose
        // receipt wait failed) — surfaced to txResults exactly as before,
        // now correctly carrying the real hash instead of null whenever a
        // broadcast genuinely happened. The 'failed' label in this
        // client-only TxResult type is retained (not changed to a new
        // 'unknown' status) deliberately: the full CONFIRMING/UNKNOWN
        // state distinction belongs to the server-side state machine
        // (server/transactionStateMachine, already supports it), not this
        // component's own, narrower UI-result type — introducing a new
        // client-side status value without the corresponding UI/reconciler
        // work to act on it would be a partial, unsafe change. See
        // docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md's "remaining
        // known gaps" for what full integration still requires.
        resolved.forEach(r => txResults.push({ recipient: r, txHash: bulkTxHash, status: 'failed', error: errMsg }))
      }

      // Award points once for the whole batch, keyed off the first successful send
      try {
        const firstSuccessTx = txResults.find(t => t.status === 'success')?.txHash
        if (firstSuccessTx) {
          const { awardTransactionPoints } = await import('@/lib/rewards')
          const { user: u, walletAddress: wa } = useAuthStore.getState()
          const pointUserId = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? `wallet_${wa.toLowerCase().slice(2, 18)}` : null
          if (pointUserId && wa) {
            const r = await awardTransactionPoints({ userId: pointUserId, walletAddress: wa, txHash: firstSuccessTx })
            if (r.pointsAwarded > 0) notifyRewardBulk(r.pointsAwarded)
          }
        }
      } catch {}

      const newBalJson = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [account.address, 'latest'] })
      // eth_getBalance returns 18-decimal USDC wei — divide by 1e18
      setBalance(newBalJson.result && newBalJson.result !== '0x' ? Number(BigInt(newBalJson.result)) / 1e18 : 0)
    } catch (err: any) {
      const errMsg = err?.shortMessage || err?.message || 'Unknown error'
      console.error('[BulkPayout] Unexpected error:', errMsg)
      resolved.forEach(r => {
        if (!txResults.find(t => t.recipient.id === r.id)) {
          txResults.push({ recipient: r, txHash: null, status: 'failed', error: errMsg })
        }
      })
    }
    // Save bulk_payment metadata to Supabase — ALL recipients share the SAME
    // Multicall3 transaction hash (bulkTxHash), since they were paid atomically
    // in one on-chain transaction rather than one tx each.
    try {
      const successTxs = txResults.filter((t: any) => t.status === 'success')
      if (successTxs.length > 0) {
        const totalSent = successTxs.reduce((sum: number, t: any) => sum + t.recipient.amount, 0)
        // Every entry in successTxs carries the identical hash — pull it once.
        const bulkTxHash = successTxs[0].txHash || ''

        // Save bulk_payment metadata to Supabase (recipient count, purpose, single txHash)
        try {
          const { walletAddress: bwa, user: buser } = useAuthStore.getState()
          const { supabase } = await import('@/lib/supabase')
          const { error: bulkErr } = await supabase.from('bulk_payments').insert({
            // Only send user_id if it's a real Supabase UUID (not wallet-derived 'usr_' IDs)
            user_id: (buser?.id && !buser.id.startsWith('usr_')) ? buser.id : null,
            wallet_address:  (bwa ?? '').toLowerCase(),
            total_amount:    totalSent,
            recipient_count: successTxs.length,
            purpose:         purpose || 'Payroll',
            tx_hash:         bulkTxHash,
            status:          'completed',
          })
          if (bulkErr) console.error('[BulkPayout] Supabase insert error:', bulkErr.code, bulkErr.message)
        } catch (e) { console.warn('[BulkPayout] Supabase bulk_payments save failed:', e) }

        // Save ONE aggregate activity record for the whole bulk payout
        try {
          const { walletAddress: bwa2, user: buser2 } = useAuthStore.getState()
          if (bwa2 && bulkTxHash) {
            const { Activity } = await import('@/lib/ActivityService')
            Activity.bulk({
              walletAddress:  bwa2,
              userId:         buser2?.id,
              // Store the raw on-chain hash — do NOT prefix it (e.g. `bulk_0x…`).
              // The prefix was being saved as the actual tx_hash, so both the
              // displayed hash and the explorer link (built from this same
              // value) ended up wrong / broken. Activity.bulk() itself now adds
              // its own bulk_/bulkrecv_ prefix internally, AFTER computing the
              // explorer URL from this clean value — see its own comment.
              txHash:         bulkTxHash,
              amount:         totalSent,
              recipientCount: successTxs.length,
              purpose:        purpose || undefined,
              recipients:     successTxs.map(t => {
                // NOTE (2026-09-02): previously labeled yourself "You" here
                // when you were one of your own batch's recipients. Per
                // product decision, the SENT-side breakdown should read
                // like an ordinary batch payment — no self-callout — since
                // it's a summary of who got paid, not a self-transfer in
                // the send/receive sense. The self indication now shows
                // only on the RECEIVE side (see bulkSubtitle's `from Self`
                // in ActivityPage.tsx's deriveActivityRow, driven by that
                // row's own counterpartyAddress === walletAddress check on
                // the bulkrecv_ leg — untouched by this change).
                return {
                  label: t.recipient.username
                    ? (t.recipient.username.endsWith('.arc') ? t.recipient.username : t.recipient.username + '.arc')
                    : t.recipient.walletAddress,
                  amount: t.recipient.amount || 0,
                  // Same bulkTxHash for every recipient — Alice, Bob, and Carol all
                  // point at the one Multicall3 transaction.
                  txHash: bulkTxHash,
                }
              }),
            }).catch(() => {})

            // Write a receiver-side record to EACH paid recipient's own history too —
            // shows the amount THEY were allocated (not the payer's total), who paid
            // them, and the purpose text — not just a summary on the payer's side.
            // All of these also reference the same bulkTxHash.
            //
            // Including yourself, if you're one of the recipients — previously
            // silently dropped by a key collision with the sent-summary row
            // above (both used the exact same unprefixed tx_hash on the same
            // wallet); Activity.bulk()/bulkReceived() now use distinct
            // bulk_/bulkrecv_ prefixes specifically so both legs coexist, the
            // same way Pay's send_/recv_ already does for a self-payment.
            const payerLabel = buser2?.username
              ? (buser2.username.endsWith('.arc') ? buser2.username : buser2.username + '.arc')
              : (buser2?.displayName || bwa2)
            successTxs.forEach((t: any) => {
              if (!t.recipient.walletAddress) return
              Activity.bulkReceived({
                walletAddress: t.recipient.walletAddress,
                userId:        t.recipient.arcUserId,
                txHash:        bulkTxHash,
                amount:        t.recipient.amount,
                fromAddress:   bwa2,
                fromUsername:  payerLabel,
                purpose:       purpose || undefined,
              }).catch(() => {})
            })
          }
        } catch {}
      }
    } catch (e) { console.warn('[BulkPayout] activity record failed:', e) }

    setResults(txResults); setProcessing(false); setStep('results'); clearResumableOperation('bulkpay')
  }

  const successCount = results.filter(r => r.status === 'success').length
  const failCount    = results.filter(r => r.status === 'failed').length
  const isExternal   = (r: Recipient) => r.walletAddress === r.username

  // ── Shared content, extracted into variables ──────────────────────────
  // Mobile renders these inside the existing AnimatePresence-stepped single
  // column + fixed bottom bar, completely unchanged. Desktop renders them
  // split across a persistent left column (recipients + summary) and a
  // step-driven right column (purpose → review → processing → results),
  // with the action buttons in normal document flow at the bottom of
  // whichever column they belong to instead of position:fixed — the fixed
  // bar was anchored to the whole content area (not the page's own
  // column/maxWidth), which is why it rendered outside/misaligned on
  // desktop's wider layout.

  const addRecipientsSection = (
    <div className={isDesktop ? "bg-surface border border-border rounded-2xl overflow-hidden flex flex-col flex-1 min-h-0" : "bg-surface border border-border rounded-2xl overflow-hidden"}>
      <div className={isDesktop ? "px-4 pt-4 pb-3 border-b border-border flex-shrink-0" : "px-4 pt-4 pb-3 border-b border-border"}>
        <p className="text-sm font-semibold text-text-primary">1. Add Recipients</p>
        {/* Mode tabs */}
        <div className="flex gap-2 mt-3">
          <button onClick={() => setEntryMode('manual')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${entryMode === 'manual' ? 'bg-brand/15 text-brand border border-brand/30' : 'text-text-secondary border border-border'}`}>
            <Plus className="w-3.5 h-3.5" /> Manual Entry
          </button>
          <button onClick={() => setEntryMode('csv')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${entryMode === 'csv' ? 'bg-brand/15 text-brand border border-brand/30' : 'text-text-secondary border border-border'}`}>
            <Upload className="w-3.5 h-3.5" /> Upload CSV
          </button>
          <button onClick={downloadCSVTemplate}
            className="ml-auto flex items-center gap-1 text-xs text-brand hover:text-brand">
            <Download className="w-3.5 h-3.5" /> Template
          </button>
        </div>
      </div>

      {entryMode === 'manual' && (
        <div className={isDesktop ? "p-4 space-y-2 flex-shrink-0" : "p-4 space-y-2"}>
          <div className="relative">
            {rowPending && rowSelected ? (
              // Selected state — show green badge, amount input below
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
                  ? <Loader2 className="w-4 h-4 text-brand animate-spin flex-shrink-0" />
                  : <Search className="w-4 h-4 text-text-secondary flex-shrink-0" />}
                <input
                  type="text"
                  value={rowUsername}
                  onChange={e => { setRowUsername(e.target.value); setRowPending(null); setRowSelected(false) }}
                  placeholder="username.arc or 0x address"
                  className="flex-1 bg-transparent text-base text-text-primary placeholder-text-muted focus:outline-none"
                />
              </div>
            )}

            {/* Search dropdown */}
            {rowResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-2xl z-20 divide-y divide-border shadow-xl">
                {rowResults.map(u => (
                  <button key={u.id} onClick={() => {
                    const amt = parseFloat(rowAmount)
                    if (amt && amt > 0) {
                      addUser(u, amt)
                    } else {
                      setRowPending(u)
                      setRowUsername('')      // clear input — prevents re-triggering search
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

            {/* Wallet address entered — checking / MeshPort match / external wallet */}
            {isValidAddress(rowUsername.trim()) && rowResults.length === 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-2xl z-20 shadow-xl">
                {addressChecking ? (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Loader2 className="w-4 h-4 text-brand animate-spin flex-shrink-0" />
                    <p className="text-xs text-text-secondary">Checking if this is an MeshPort wallet...</p>
                  </div>
                ) : addressMatch ? (
                  // Address belongs to a registered MeshPort user — show their username, not "External Wallet"
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

          {/* Mobile only — desktop's live amount input is the
              always-open AmountKeypad card below instead of a
              tap-to-reveal box; its own Add button moves below the
              card there too (see the isDesktop block after it). */}
          {!isDesktop && (
            <div className="flex gap-2">
              <div
                onClick={() => setShowBulkAmountPad(true)}
                className="flex-1 bg-surface/50 border border-border rounded-xl px-4 py-3.5 text-base text-text-primary cursor-pointer flex items-center"
                style={{ minHeight: 54 }}
              >
                <span style={{ color: rowAmount ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {rowAmount ? `$${rowAmount} USDC` : 'Amount (USDC)'}
                </span>
              </div>
              <button onClick={handleRowAdd}
                disabled={!rowAmount || parseFloat(rowAmount) <= 0}
                className="flex items-center gap-1.5 px-5 py-3.5 bg-brand/15 border border-brand/30 text-brand rounded-xl text-base font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/25 transition-all">
                <Plus className="w-4 h-4" /> Add
              </button>
            </div>
          )}
          {isDesktop ? (
            // Same bare-box + overlaid Max pill treatment as Multichain
            // Transfer's amount box (centered value, plain bordered box —
            // not AmountKeypad's own elevated/shadowed desktop card).
            <div style={{ position: 'relative' }}>
              <div style={{
                position: 'relative',
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
                padding: '28px 20px', minHeight: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
              }}>
                {/* $ pinned to a fixed left inset, not inline before the
                    input — keeps the digits truly centered in the box no
                    matter how many are typed. */}
                <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: rowAmount ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
                <input
                  id="bulk-amount-input"
                  type="text"
                  inputMode="decimal"
                  value={rowAmount}
                  onChange={e => setRowAmount(sanitizeBulkAmount(e.target.value))}
                  placeholder="0.00"
                  style={{
                    width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                    fontSize: 34, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
                    textAlign: 'center',
                  }}
                  aria-label="Amount in USDC"
                />
              </div>
              {balance > 0 && (
                <button
                  onClick={() => setRowAmount(parseFloat(balance.toFixed(2)).toString())}
                  style={{
                    position: 'absolute', top: 14, right: 16, padding: '5px 14px', borderRadius: 100,
                    border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
                    background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)',
                    fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Max
                </button>
              )}
            </div>
          ) : (
            <AmountKeypad
              open={showBulkAmountPad}
              value={rowAmount}
              onChange={v => setRowAmount(v)}
              balance={balance}
              token="USDC"
              quickAmounts={[10, 20, 50, 100]}
              onClose={() => setShowBulkAmountPad(false)}
              onDone={() => setShowBulkAmountPad(false)}
            />
          )}
          {isDesktop && (
            <button onClick={handleRowAdd}
              disabled={!rowAmount || parseFloat(rowAmount) <= 0}
              className="w-full flex items-center justify-center gap-1.5 px-5 py-3.5 bg-brand/15 border border-brand/30 text-brand rounded-xl text-base font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/25 transition-all">
              <Plus className="w-4 h-4" /> Add Recipient
            </button>
          )}
        </div>
      )}

      {entryMode === 'csv' && (
        <div className={isDesktop ? "p-4 space-y-3 flex-shrink-0" : "p-4 space-y-3"}>
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleCSV} />
          <button onClick={() => fileRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-border rounded-2xl text-text-secondary hover:text-text-primary hover:border-brand/30 transition-all">
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

      {/* Added recipients — shown under whichever input mode is active, for
          both manual entries and CSV imports, so the full list with amounts
          is always visible right below where you just added them.
          Desktop: given its own bounded, scrollable box (same pattern
          reviewContent's recipient list already uses) instead of relying on
          the left column's ambient overflow — a CSV import can add far more
          rows than fit on screen, and without this the list just grew the
          whole column past the viewport with no reliable way to reach the
          rows (or the Purpose/Summary/actions below it) further down.
          Mobile unchanged — the page itself is the scroll container there,
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
                    {isExternal(r) ? 'External Wallet' : r.status === 'unresolved' ? r.error : '—'}
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
          placeholder="Add a purpose for this payment (optional)"
          rows={2}
          className="w-full bg-surface/50 border border-border rounded-xl px-3 py-2.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-brand/50 resize-none"
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
      <div className={isDesktop ? "grid grid-cols-2 gap-2 mb-2" : "grid grid-cols-2 gap-3 mb-3"}>
        {[
          { icon: <Users className="w-4 h-4 text-brand" />, label: 'Recipients', value: recipients.length.toString(), bg: 'bg-brand/10' },
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
      <div className="w-20 h-20 bg-brand/15 rounded-full flex items-center justify-center mx-auto">
        <div className="w-10 h-10 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-text-primary">Executing Bulk Payout</h2>
        <p className="text-text-secondary mt-1 text-sm">{processingStatus || `${resolvedCount} transfers via Multicall3`}</p>
      </div>
      <p className="text-xs text-text-muted">Do not close this screen</p>
    </>
  )

  const resultsContent = (
    <>
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
              {r.txHash && (
                <a href={`${ARC_EXPLORER}/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-brand flex items-center gap-1 mt-0.5">
                  <ExternalLink className="w-3 h-3" /> View on ArcScan
                </a>
              )}
              {r.error && <p className="text-xs text-danger mt-0.5">{r.error}</p>}
            </div>
          </div>
        ))}
      </div>
    </>
  )

  // Action-button rows — same JSX, mobile places them inside the fixed
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
        <button onClick={() => setStep('review')}
          className="flex-1 py-3.5 rounded-2xl text-white font-bold flex items-center justify-center gap-2"
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
          if (storedPasscode) { setPassEntry(''); setPassError(''); setShowReviewPinSheet(true) }
          else executePayout()
        }}
        className="flex-1 py-3.5 rounded-2xl text-white font-bold flex items-center justify-center gap-2"
        style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
        Pay <Send className="w-4 h-4" />
      </button>
    </div>
  )

  const resultsActionButtons = (
    <div className="flex flex-col gap-2.5">
      <button onClick={() => {
          setStep('setup'); setRecipients([]); setResults([])
          setPurpose('')
          setRowUsername(''); setRowAmount(''); setRowResults([]); setRowPending(null); setRowSelected(false)
          setAddressMatch(null); setAddressChecking(false)
        }}
        className="w-full py-3.5 rounded-2xl text-white font-bold"
        style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
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
    // Desktop: overflow:visible, not hidden — each column already manages
    // its own scroll (overflowY:'auto' below), and a hard-clipping root on
    // top of that was the same bug already found and fixed on Swap/Pay/
    // Multichain Claim: it clipped the Cancel/Review Payout buttons at the
    // bottom of the right column with no way to reach them. Mobile
    // unchanged (its own overflow-y-auto root, untouched).
    <div className={`flex flex-col bg-bg ${isDesktop ? 'h-full overflow-visible' : 'h-full overflow-y-auto pb-24'}`}>

      {/* ── HEADER ── */}
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 px-5 pt-header pb-header flex-shrink-0">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate('/')} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div className="flex-1">
            <h1 className="text-xl font-bold text-text-primary">Bulk Payment</h1>
            <p className="text-xs text-text-secondary">Send USDC to multiple recipients in one transaction</p>
          </div>
          <button onClick={() => setShowHowItWorks(true)} className="flex items-center gap-1.5 px-3 py-1.5 border border-brand/30 rounded-xl text-xs text-brand active:scale-95 transition-transform">
            <HelpCircle className="w-3.5 h-3.5" /> How it works?
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
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
          {/* BUG FIX (2026-09-03): this column used to be overflowY: 'auto'
              itself, WHILE the recipient list inside addRecipientsSection
              also had its own overflow-y-auto + maxHeight: 40vh — two
              nested scroll containers competing for the same wheel input.
              With few recipients (list shorter than 40vh, nothing to
              scroll internally), every scroll gesture fell through to
              THIS column instead, dragging the "Add Recipient" header/
              form out of view and giving no reliable way to see how many
              people had actually been added. Now `overflow: hidden` here
              — addRecipientsSection manages its own internal scroll (see
              its own flex-1/min-h-0 structure), so the recipient list is
              the ONE genuine scroll region, and the input form above it
              stays fixed/visible while it scrolls. */}
          <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {addRecipientsSection}
          </div>

          <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
            <AnimatePresence mode="wait">
              {step === 'setup' && (
                <motion.div key="d-setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {purposeSection}
                  {summarySection}
                  {setupActionButtons}
                </motion.div>
              )}
              {step === 'review' && (
                <motion.div key="d-review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {reviewContent}
                  {reviewActionButtons}
                </motion.div>
              )}
              {step === 'processing' && (
                <motion.div key="d-processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-16 text-center space-y-6">
                  {processingContent}
                </motion.div>
              )}
              {step === 'results' && (
                <motion.div key="d-results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {resultsContent}
                  {resultsActionButtons}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      ) : (
      <>
      <AnimatePresence mode="wait">

        {/* ══════════════════ SETUP STEP ══════════════════ */}
        {step === 'setup' && (
          <motion.div key="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 space-y-4">
            {addRecipientsSection}
            {purposeSection}
            {summarySection}
          </motion.div>
        )}

        {/* ══════════════════ REVIEW STEP ══════════════════ */}
        {step === 'review' && (
          <motion.div key="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 space-y-4">
            {reviewContent}
          </motion.div>
        )}

        {/* ══════════════════ PROCESSING ══════════════════ */}
        {step === 'processing' && (
          <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 py-16 text-center space-y-6">
            {processingContent}
          </motion.div>
        )}

        {/* ══════════════════ RESULTS ══════════════════ */}
        {step === 'results' && (
          <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 space-y-4">
            {resultsContent}
          </motion.div>
        )}

      </AnimatePresence>

      {/* ── FIXED BOTTOM ACTION BAR ── */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 pt-3 bg-gradient-to-t from-bg via-bg/95 to-transparent z-20">
        {step === 'setup' && setupActionButtons}
        {step === 'review' && reviewActionButtons}
        {step === 'results' && resultsActionButtons}
      </div>
      </>
      )}

      {/* ── Review step: Pay PIN sheet / dialog — opens only when Pay is tapped ── */}
      <AnimatePresence>
        {showReviewPinSheet && (() => {
          const keypadContent = (
            <>
              <PinKeypad
                value={passEntry}
                onChange={v => { setPassEntry(v); setPassError('') }}
                length={6}
                error={!!passError}
                onComplete={async () => {
                  // Synchronous guard — prevents a double-fire from triggering
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
              {passError && <p className="text-xs text-danger text-center mt-2">{passError}</p>}
            </>
          )
          const pinContent = (
            <>
              <p className="text-center text-sm text-text-secondary mb-1">Confirm bulk payout of</p>
              <p className="text-center text-2xl font-bold text-text-primary mb-6">${formatAmount(totalAmount)} USDC</p>
              <p className="text-xs font-medium text-text-secondary text-center mb-2">Enter passcode to confirm</p>
              {keypadContent}
            </>
          )
          const close = () => { if (!processing) { setShowReviewPinSheet(false); setPassEntry(''); setPassError('') } }
          return isDesktop ? (
            <DesktopTransactionAuthDialog
              onClose={close}
              title="Authorize Bulk Payout"
              amountLabel={`$${formatAmount(totalAmount)} USDC`}
              subLabel={`To ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
            >
              {keypadContent}
            </DesktopTransactionAuthDialog>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40"
                onClick={close} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="absolute bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl px-6 pt-5 pb-10">
                <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }} />
                {pinContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* How it works tooltip — tap anywhere to dismiss */}
      <AnimatePresence>
        {showHowItWorks && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-50 flex items-start justify-end"
            style={{ paddingTop: '80px', paddingRight: '16px' }}
            onClick={() => setShowHowItWorks(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: -8 }}
              transition={{ duration: 0.18 }}
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
                      style={{ background: 'color-mix(in srgb, var(--brand) 20%, transparent)', fontSize: '11px', fontWeight: 700, color: 'var(--brand)' }}>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
