// Pay many people in ONE Arc transaction (Multicall3 aggregate3Value).
//
// The engine behind Bulk Pay and Business → Pay staff: resolve each person
// (username or address), refuse anyone who can't be paid (privacy, USDC
// blocklist), then send one batch - a server-issued nonce and intent first
// (docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md), the screen made
// resumable as soon as the batch is out, and one Activity row for the payer
// plus one for each person paid.
import { createPublicClient, encodeFunctionData } from 'viem'
import type { WalletAccount } from '@/wallet'
import { useAuthStore } from '@/store'
import { arcTransport, arcRpcJson } from '@/lib/arc'
import { isValidAddress } from '@/lib/arcService'
import { resolveUsernameDb, getUserByWalletAddress } from '@/lib/supabase'
import { shortenAddress, trimTrailingZeros } from '@/lib/utils'
import { saveResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { notifyRewardBulk } from '@/lib/notifications'

// ── Multicall3 (canonical deterministic deployment, same address on every EVM chain) ──
// https://github.com/mds1/multicall - deployed via CREATE2 at this address on 100+ chains.
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

// Only the piece of the Multicall3 ABI we actually call: aggregate3Value.
// Call3Value.value lets each leg forward native value, and the whole batch is
// submitted (and mined) as ONE transaction - one txHash covers every recipient.
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

/** A person in a batch, once resolved to a wallet. */
export interface BatchRecipient {
  id: string; input: string; walletAddress: string
  displayName: string; username: string; amount: number
  arcUserId?: string; avatarUrl?: string | null
}

/** Network fee for one batch paying `count` people (USDC). */
export const batchFee = (count: number) => count > 0 ? 0.002 + count * 0.0002 : 0

/** One Multicall3 aggregate3Value call paying every recipient (pure). */
export function buildBatch(resolved: Array<{ walletAddress: string; amount: number }>) {
  const calls = resolved.map(r => ({
    target: r.walletAddress as `0x${string}`,
    allowFailure: false,
    value: BigInt(Math.round(r.amount * 1_000_000)) * (10n ** 12n),
    callData: '0x' as `0x${string}`,
  }))
  const totalValue = calls.reduce((sum, c) => sum + c.value, 0n)
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3Value', args: [calls] })
  return { totalValue, data }
}

/** Gas for the batch; a per-recipient estimate if the node can't say. Never throws. */
export function estimateBatchGas(from: `0x${string}`, batch: { totalValue: bigint; data: `0x${string}` }, count: number): Promise<bigint> {
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })
  return publicClient.estimateGas({ account: from, to: MULTICALL3_ADDRESS, data: batch.data, value: batch.totalValue })
    .catch(() => 80_000n + BigInt(count) * 40_000n)
}

/** A username (with or without @ / .arc) or 0x address → who gets paid, or null if not found. */
export async function resolvePayee(input: string): Promise<Omit<BatchRecipient, 'id' | 'amount'> | null> {
  const raw = input.trim()
  if (isValidAddress(raw)) {
    const profile = await getUserByWalletAddress(raw).catch(() => null)
    return { input: raw, walletAddress: raw, displayName: profile?.display_name || shortenAddress(raw), username: profile?.username || shortenAddress(raw), arcUserId: profile?.id, avatarUrl: profile?.avatar_url }
  }
  const cleanName = raw.replace(/^@/, '').replace(/\.arc$/, '')
  if (!cleanName) return null
  const addr = await resolveUsernameDb(cleanName).catch(() => null)
  if (!addr) return null
  const profile = await getUserByWalletAddress(addr).catch(() => null)
  return { input: raw, walletAddress: addr, displayName: profile?.display_name || cleanName, username: profile?.username || cleanName, arcUserId: profile?.id, avatarUrl: profile?.avatar_url }
}

/**
 * The batch and the two chain reads it needs (balance, gas) - started before
 * the privacy checks, since they don't depend on them, so they're done by the
 * time the checks are.
 */
export function prepareBatch(resolved: BatchRecipient[]) {
  const batch = buildBatch(resolved)
  const fromAddr = useAuthStore.getState().walletAddress
  const early = fromAddr && isValidAddress(fromAddr) ? {
    from: fromAddr.toLowerCase(),
    balance: arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [fromAddr, 'latest'] }),
    gas: estimateBatchGas(fromAddr as `0x${string}`, batch, resolved.length),
  } : null
  early?.balance.catch(() => {})
  return { batch, early }
}
export type PreparedBatch = ReturnType<typeof prepareBatch>

/**
 * Chat privacy, checked for every MeshPort user in the list (typed by
 * username or by wallet) before anything is sent: someone who blocked me,
 * or only takes payments from their contacts, can't be paid here either -
 * same rule and wording as Pay. USDC refuses blocklisted addresses: the
 * whole batch would fail on-chain. Returns recipient id → why.
 */
export async function findUnpayable(resolved: BatchRecipient[]): Promise<Map<string, string>> {
  const { reachCheck, BLOCKED_YOU, STRANGER_PAY_BLOCKED } = await import('@/lib/privacy')
  const { blockedAmong, BLOCKED_TEXT } = await import('@/lib/usdcBlocklist')
  const blockedLookup = blockedAmong(resolved.map(r => r.walletAddress).filter(Boolean)).catch(() => new Set<string>())
  const refused = new Map<string, string>()
  await Promise.all(resolved.map(async r => {
    const userId = r.arcUserId || (r.walletAddress ? (await getUserByWalletAddress(r.walletAddress).catch(() => null))?.id : null)
    if (!userId) return
    const reach = await reachCheck(userId)
    if (reach.canPay) return
    const name = `${String(r.username || '').replace(/\.arc$/, '')}.arc`
    refused.set(r.id, reach.blocked ? BLOCKED_YOU(name) : STRANGER_PAY_BLOCKED(name))
  }))
  const blocked = await blockedLookup
  for (const r of resolved) if (blocked.has(r.walletAddress.toLowerCase())) refused.set(r.id, BLOCKED_TEXT)
  return refused
}

export type BatchOutcome =
  | { state: 'paid'; txHash: string }
  | { state: 'failed'; txHash: string | null; error: string }
  /** No signer on this device: the app was locked to ask for the passcode. */
  | { state: 'locked' }

export interface SendBatchOptions {
  /** Shown in Activity ("Staff salary", "Payroll"). */
  purpose: string
  /** Where the screen keeps its "batch is out" marker (lib/resumableOperation). */
  resumeKey: string
  onStatus?: (text: string) => void
  prepared?: PreparedBatch
  /** Pay staff: Activity reads as paying staff, from the business by name. */
  payroll?: { businessName: string }
  /** Kept with the resume marker (e.g. which saved payout this was). */
  context?: Record<string, unknown>
}

const arcLabel = (u: string) => u.endsWith('.arc') ? u : u + '.arc'

/**
 * Sends one batch paying every recipient - all or nothing (allowFailure is
 * false for every leg, so a failing leg reverts the whole transaction).
 * Never throws. Recipients must be resolved and checked (findUnpayable).
 */
export async function sendBatch(resolved: BatchRecipient[], opts: SendBatchOptions): Promise<BatchOutcome> {
  const status = opts.onStatus ?? (() => {})
  const { batch, early } = opts.prepared ?? prepareBatch(resolved)
  const totalAmount = resolved.reduce((s, r) => s + r.amount, 0)
  // One BulkPay operation = one idempotency key, generated once per send.
  // Server-enforced via transaction_intents_wallet_idem_key
  // UNIQUE(wallet_address, idempotency_key) - see
  // docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md Question B.
  const idempotencyKey = crypto.randomUUID()

  status('Restoring wallet signer...')
  let activeSigner = useAuthStore.getState().signer
  if (!activeSigner) {
    const { restorePrivateKey } = await import('@/lib/restoreWallet')
    await restorePrivateKey()
    activeSigner = useAuthStore.getState().signer
  }
  if (!activeSigner) { useAuthStore.getState().lock(); return { state: 'locked' } }

  // A definite batch failure goes to Activity as one failed Bulk Payment
  // row with its exact reason (lib/failure.ts); "may still complete" never does.
  const { classifyFailure, classifyPreBroadcastFailure, recordFailure } = await import('@/lib/failure')
  type BulkFailure = ReturnType<typeof classifyFailure>
  const noteBatchFailed = (failure: BulkFailure, txHash?: string | null) => {
    void recordFailure({
      feature: 'bulk_pay', walletAddress: useAuthStore.getState().walletAddress, amount: totalAmount, token: 'USDC',
      txHash: txHash ?? undefined, failure, metadata: { recipientCount: resolved.length, purpose: opts.purpose, ...(opts.payroll ? { kind: 'payroll' } : {}) },
    })
    return failure.message
  }

  let bulkTxHash: `0x${string}` | null = null
  try {
    status('Connecting to Arc Testnet...')
    const account = activeSigner
    const sameWallet = early?.from === account.address.toLowerCase()

    status('Checking balance...')
    // Arc docs: use eth_getBalance (18-decimal native USDC wei), not ERC-20 balanceOf.
    const balJson = (sameWallet ? await early!.balance.catch(() => null) : null)
      ?? await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [account.address, 'latest'] })
    const rawBal = balJson.result && balJson.result !== '0x' ? balJson.result : '0x0'
    const balanceUsdc = Number(BigInt(rawBal)) / 1e18
    if (balanceUsdc < totalAmount) {
      return { state: 'failed', txHash: null, error: noteBatchFailed({ code: 'insufficient_funds', definite: true,
        message: `Not enough balance: you have ${trimTrailingZeros(balanceUsdc.toFixed(4))} USDC, this payout needs ${trimTrailingZeros(totalAmount.toFixed(4))} USDC - nothing was sent.` }) }
    }

    // One transaction_intent + one transaction_attempt, created server-side
    // BEFORE any broadcast. The nonce this returns is the ONLY nonce used -
    // a client-computed nonce is exactly the value a lost broadcast response
    // leaves nothing to reconcile against
    // (docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md).
    status('Preparing...')
    const totalAmountAtomic = (BigInt(Math.round(totalAmount * 1_000_000)) * (10n ** 12n)).toString()
    const { createBulkPayIntent, markBulkPayAttemptSubmitted } = await import('@/lib/bulkPayIntentService')
    const [intentResult, gasEst] = await Promise.all([
      createBulkPayIntent({
        walletAddress: account.address, idempotencyKey, chainId: 'arc', amountAtomic: totalAmountAtomic,
        decimals: 18, isNative: true, tokenAddress: null, tokenSymbol: 'USDC',
        recipientCount: resolved.length, purpose: opts.purpose,
      }),
      sameWallet ? early!.gas : estimateBatchGas(account.address, batch, resolved.length),
    ])
    if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
      return { state: 'failed', txHash: null, error: noteBatchFailed(classifyPreBroadcastFailure(new Error(intentResult.error ?? "Couldn't prepare the payout"))) }
    }
    const attemptId = intentResult.attemptId

    // ── Send ALL payouts in ONE Multicall3 transaction ───────────────────
    // Arc's USDC is the chain's native currency: aggregate3Value forwards a
    // slice of msg.value to each `target` as `target.call{value: v}("")`.
    try {
      status('Sending the transaction...')
      // Signed here, sent to every Arc node and confirmed by the server in
      // ONE request (relaySend in arcService.ts). As soon as the batch is
      // out: the hash is kept, the screen made resumable, and the real
      // tx_hash persisted server-side - all BEFORE the receipt is known.
      const { relaySend, waitForConfirmation } = await import('@/lib/arcService')
      const onSent = (txHash: `0x${string}`) => {
        if (bulkTxHash) return
        bulkTxHash = txHash
        saveResumableOperation(opts.resumeKey, txHash, { ...opts.context, totalAmount, recipientCount: resolved.length, walletAddress: account.address })
        void markBulkPayAttemptSubmitted(attemptId, txHash).catch(() => { /* best-effort */ })
        status('Confirming on Arc...')
      }
      const sent = await relaySend(account, { to: MULTICALL3_ADDRESS as `0x${string}`, data: batch.data, value: batch.totalValue, gas: (gasEst * 130n) / 100n, nonce: intentResult.nonce }, onSent)
      // A batch the network may still be mining gets the full wait before
      // it's reported (never "failed" while it can still land).
      const conf = sent.state === 'pending' ? await waitForConfirmation(sent.txHash, 45_000) : sent
      if (!bulkTxHash && conf.state !== 'pending') onSent(sent.txHash)
      if (conf.state === 'failed') throw new Error('Multicall3 transaction reverted')
      if (conf.state === 'pending') throw new Error('Not confirmed yet - it may still complete. Check Activity before retrying.')
    } catch (e) {
      // Reverted → definite (real hash kept); "Not confirmed yet" → uncertain, not recorded.
      const failure = classifyFailure(e)
      const error = failure.definite ? noteBatchFailed(failure, failure.code === 'reverted' ? bulkTxHash : null) : failure.message
      return { state: 'failed', txHash: bulkTxHash, error }
    }
    refreshBalancesAfterTx(account.address)
  } catch (err: any) {
    console.error('[batchPay] Unexpected error:', err?.shortMessage || err?.message)
    // Only reached before the batch was sent (the send has its own catch above).
    return { state: 'failed', txHash: null, error: noteBatchFailed(classifyPreBroadcastFailure(err)) }
  } finally {
    clearResumableOperation(opts.resumeKey)
  }

  const txHash: string = bulkTxHash!
  void recordPaid(resolved, txHash, opts)
  return { state: 'paid', txHash }
}

/** After a paid batch: points, the bulk_payments row, and Activity for everyone. Best-effort. */
async function recordPaid(resolved: BatchRecipient[], txHash: string, opts: SendBatchOptions) {
  const { walletAddress: wa, user: u } = useAuthStore.getState()
  if (!wa) return
  const total = resolved.reduce((s, r) => s + r.amount, 0)

  // Points once for the whole batch.
  ;(async () => {
    try {
      const { awardTransactionPoints } = await import('@/lib/rewards')
      const pointUserId = u?.id && !u.id.startsWith('usr_') ? u.id : `wallet_${wa.toLowerCase().slice(2, 18)}`
      const r = await awardTransactionPoints({ userId: pointUserId, walletAddress: wa, txHash, actionType: 'bulkpay' })
      if (r.pointsAwarded > 0) notifyRewardBulk(r.pointsAwarded)
    } catch { /* points are a nice-to-have */ }
  })()

  // bulk_payments: recipient count, purpose, the one tx hash.
  ;(async () => {
    try {
      const { supabase } = await import('@/lib/supabase')
      const { error } = await supabase.from('bulk_payments').insert({
        // Only a real Supabase UUID (not wallet-derived 'usr_' IDs).
        user_id: (u?.id && !u.id.startsWith('usr_')) ? u.id : null,
        wallet_address: wa.toLowerCase(), total_amount: total, recipient_count: resolved.length,
        purpose: opts.purpose, tx_hash: txHash, status: 'completed',
      })
      if (error) console.error('[batchPay] bulk_payments insert error:', error.code, error.message)
    } catch (e) { console.warn('[batchPay] bulk_payments save failed:', e) }
  })()

  // ONE activity row for the payer, and one in each paid person's own
  // history with the amount THEY got - all on the same transaction hash.
  try {
    const { Activity } = await import('@/lib/ActivityService')
    const kind = opts.payroll ? 'payroll' as const : undefined
    void Activity.bulk({
      walletAddress: wa, userId: u?.id, txHash, amount: total, recipientCount: resolved.length,
      purpose: opts.purpose || undefined, kind,
      recipients: resolved.map(r => ({ label: r.username ? arcLabel(r.username) : r.walletAddress, amount: r.amount || 0, txHash })),
    }).catch(() => {})
    const payerLabel = u?.username ? arcLabel(u.username) : (u?.displayName || wa)
    for (const r of resolved) {
      if (!r.walletAddress) continue
      void Activity.bulkReceived({
        walletAddress: r.walletAddress, userId: r.arcUserId, txHash, amount: r.amount,
        fromAddress: wa, fromUsername: payerLabel, fromName: opts.payroll?.businessName, purpose: opts.purpose || undefined, kind,
      }).catch(() => {})
    }
  } catch (e) { console.warn('[batchPay] activity record failed:', e) }
}
