/**
 * Arc Blockchain Service
 * Implemented exactly per Arc docs: https://docs.arc.io/integrate/exchanges/withdrawals
 */
import { createPublicClient, parseUnits, encodeFunctionData, parseGwei, getAddress, isAddress, keccak256 } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { arcTransport, arcRpcJson } from './arc'
import { ARC, ARC_TOKENS, ARC_CHAIN_INLINE as REGISTRY_ARC_CHAIN_INLINE } from '@/blockchain/chains'
import { isSlowNetwork } from './connectivity'

// ─── Chain/token constants re-exported from the shared registry ─────────────
// Definitions moved to src/blockchain/chains.ts (Phase 0 of
// docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md). Re-exported here so existing
// importers (p2pEscrowContract.ts imports ARC_CHAIN_INLINE from this module,
// among others) keep working unchanged. Values are identical.
export const ARC_TESTNET = {
  chainId:     ARC.chainId,
  name:        ARC.name,
  rpcUrl:      ARC.rpcUrl,
  explorerUrl: ARC.explorerUrl,
  faucetUrl:   ARC.faucetUrl,
}
export const USDC_CONTRACT = ARC_TOKENS.USDC.contract
export const USDC_DECIMALS = ARC_TOKENS.USDC.decimals

// Arc docs: chain config for sendTransaction - decimals: 18 (native USDC wei).
// Exported so p2pEscrowContract.ts can reuse it directly rather than
// duplicating the constant.
export const ARC_CHAIN_INLINE = REGISTRY_ARC_CHAIN_INLINE

// ─── BUG FIX (Payment Failed: "Value `1e-8` is not a valid decimal number.") ─
// sendEURC/sendCirBTC used to build viem's `parseUnits` input with plain
// `params.amount.toString()`. `params.amount` is a JS `number`, and
// `Number.prototype.toString()` switches to EXPONENTIAL notation for any
// magnitude below 1e-6 - e.g. `(0.00000001).toString()` is `'1e-8'`, not
// `'0.00000001'`. viem's `parseUnits` only accepts a plain decimal string and
// throws exactly this error on exponential notation, so sending a small-but-
// entirely-valid cirBTC amount like 0.00000001 (well above its 8-decimal
// minimum unit) failed outright. sendUSDC never had this bug because it
// converts the amount with plain arithmetic (`Math.round(amount * 1e6)`)
// instead of round-tripping through a string.
// `toLocaleString` with grouping disabled never emits exponential notation
// regardless of magnitude, and capping `maximumFractionDigits` to the
// token's own decimals keeps the string aligned with what `parseUnits`
// would resolve the amount to anyway.
export function toPlainDecimalString(amount: number, decimals: number): string {
  if (!Number.isFinite(amount)) throw new Error(`Invalid amount: ${amount}`)
  return amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals })
}

// ─── Get USDC balance - Arc docs: use eth_getBalance (18-decimal native wei) ──
/** Like getUSDCBalance, but a failed read throws instead of looking like 0 (offline must never show $0). */
export async function readUSDCBalanceOrThrow(address: string): Promise<number> {
  const json = await arcRpcJson({
    jsonrpc: '2.0', id: 1,
    method: 'eth_getBalance',    // Arc docs recommended method
    params: [address, 'latest'],
  }, isSlowNetwork() ? 30000 : 15000) // a very weak link needs longer to answer
  if (json?.error) throw new Error(json.error.message || 'eth_getBalance failed')
  const raw = json?.result
  if (!raw || raw === '0x' || raw === '0x0') return 0
  // Arc native balance: 18 decimals. Divide by 1e18 for USDC display value.
  return Number(BigInt(raw)) / 1e18
}

export async function getUSDCBalance(address: string): Promise<number> {
  try {
    return await readUSDCBalanceOrThrow(address)
  } catch (e: any) {
    console.error('[MeshPort] Balance fetch error:', e?.name === 'AbortError' ? 'timeout' : e?.message)
    return 0
  }
}

export interface SendResult {
  txHash: string
  explorerUrl: string
  state: 'success' | 'pending' | 'failed'
  blockNumber?: string
  senderAddress: string
  recipientAddress: string
}

// ─── Pre-broadcast preflight, startable early ────────────────────────────────
// Everything a send needs before it can sign: the server-reserved
// intent/attempt/nonce (pay-intent Edge Function - the slowest leg), the gas
// estimate, and (native USDC only) the balance check. None of it needs the
// private key, so callers start it the moment the PIN is complete via
// preparePayment(), overlapping the server round trip with passcode
// verification and key restore (two 100k-iteration PBKDF2 derives) instead
// of paying for it after them. The send function then picks the result up
// by idempotency key and only has to sign + broadcast.
//
// Only started once the PIN is entered - never when the PIN screen merely
// opens - so an abandoned preflight is rare, and even then harmless: a wrong
// PIN retries the SAME payment with the SAME idempotency key, which
// pay-intent answers with the same reservation (idempotent_replay).
type PayToken = 'USDC' | 'EURC' | 'cirBTC'
type Preflight = { intent: import('./payIntentService').CreatePayIntentResult; gas: bigint; balance?: number }

const PREFLIGHT_TTL_MS = 60_000
const preflights = new Map<string, { sig: string; at: number; promise: Promise<Preflight> }>()

const ERC20_TRANSFER_ABI = [{
  name: 'transfer',
  type: 'function',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
}] as const

function payTx(token: PayToken, destination: `0x${string}`, amount: number) {
  if (token === 'USDC') {
    const amountAtomic = BigInt(Math.round(amount * 1_000_000)) * (10n ** 12n)
    return { to: destination, value: amountAtomic, data: undefined, amountAtomic, decimals: 18, isNative: true, tokenAddress: null }
  }
  const decimals = token === 'EURC' ? 6 : 8
  const contract = (token === 'EURC' ? ARC_TOKENS.EURC.contract : ARC_TOKENS.cirBTC.contract) as `0x${string}`
  const amountAtomic = parseUnits(toPlainDecimalString(amount, decimals), decimals)
  const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [destination, amountAtomic] })
  return { to: contract, value: undefined, data, amountAtomic, decimals, isNative: false, tokenAddress: contract as string }
}

const preflightSig = (token: PayToken, sender: string, destination: string, amountAtomic: bigint) =>
  `${token}|${sender.toLowerCase()}|${destination.toLowerCase()}|${amountAtomic}`

async function runPreflight(token: PayToken, sender: `0x${string}`, destination: `0x${string}`, amount: number, idempotencyKey: string, recipientUsername?: string | null): Promise<Preflight> {
  const tx = payTx(token, destination, amount)
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })
  const { createPayIntent } = await import('./payIntentService')
  const [balance, intent, gas] = await Promise.all([
    token === 'USDC' ? getUSDCBalance(sender) : Promise.resolve(undefined),
    createPayIntent({
      walletAddress: sender,
      idempotencyKey,
      chainId: 'arc',
      amountAtomic: tx.amountAtomic.toString(),
      decimals: tx.decimals,
      isNative: tx.isNative,
      tokenAddress: tx.tokenAddress,
      tokenSymbol: token,
      recipientAddress: destination,
      recipientUsername: recipientUsername ?? null,
    }),
    publicClient.estimateGas({ account: sender, to: tx.to, value: tx.value, data: tx.data }),
  ])
  return { intent, gas, balance }
}

/** Starts a send's preflight early (see comment above). Fire-and-forget; never throws. */
// Wakes the RPC proxy (a serverless function that may be cold) with one
// cheap call when the passcode screen opens, so the payment's own calls
// don't pay the cold start. Throttled; failures are ignored.
let lastWarmAt = 0
export function warmArcRpc(): void {
  if (Date.now() - lastWarmAt < 30_000) return
  lastWarmAt = Date.now()
  arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 4000).catch(() => {})
}

export function preparePayment(params: { token: PayToken; from: string; to: string; amount: number; idempotencyKey: string; recipientUsername?: string | null }): void {
  try {
    if (!isAddress(params.from) || !isAddress(params.to) || !(params.amount > 0)) return
    const sender = getAddress(params.from)
    const destination = getAddress(params.to)
    const sig = preflightSig(params.token, sender, destination, payTx(params.token, destination, params.amount).amountAtomic)
    const existing = preflights.get(params.idempotencyKey)
    if (existing && existing.sig === sig && Date.now() - existing.at < PREFLIGHT_TTL_MS) return
    const promise = runPreflight(params.token, sender, destination, params.amount, params.idempotencyKey, params.recipientUsername)
    promise.catch(() => { /* surfaced (or retried fresh) by the send that consumes it */ })
    preflights.set(params.idempotencyKey, { sig, at: Date.now(), promise })
  } catch { /* purely an optimization - the send runs its own preflight */ }
}

/** The send's preflight: the early one if it matches exactly, else a fresh one. */
async function getPreflight(token: PayToken, sender: `0x${string}`, destination: `0x${string}`, amount: number, idempotencyKey: string, recipientUsername?: string | null): Promise<Preflight> {
  const early = preflights.get(idempotencyKey)
  preflights.delete(idempotencyKey)
  const sig = preflightSig(token, sender, destination, payTx(token, destination, amount).amountAtomic)
  if (early && early.sig === sig && Date.now() - early.at < PREFLIGHT_TTL_MS) {
    try {
      const result = await early.promise
      if (result.intent.success || result.intent.existingTxHash) return result
    } catch { /* fall through to a fresh run - same key, so pay-intent replays the same reservation */ }
  }
  return runPreflight(token, sender, destination, amount, idempotencyKey, recipientUsername)
}

// ─── Confirmation before success ─────────────────────────────────────────────
// Sends used to return 'success' the instant they broadcast, so a payment
// that then reverted - or never got mined at all - still showed a success
// screen. Arc finalizes in under a second, and with 250ms polling the wait
// costs about that much, so sends now wait for the real receipt:
//   receipt ok        → 'success'
//   receipt reverted  → 'failed'   (broadcast happened, but nothing moved)
//   no receipt yet    → 'pending'  (SUBMITTED_UNKNOWN: never shown as failed -
//                                    it may still land, and a retry could
//                                    double-pay; callers keep watching it)
export const CONFIRM_TIMEOUT_MS = 10_000

// Polls eth_getTransactionReceipt directly. viem's waitForTransactionReceipt
// makes ~5–7 sequential round trips per wait (receipt, blockNumber watch,
// getTransaction replacement check with backoff, receipt again, wait for the
// next block…) - on Arc, where the receipt exists within ~1s, that machinery
// was most of the post-send wait. One cheap call every 200ms instead; the
// receipt (and its status) is still always checked.
const RECEIPT_POLL_MS = 200

export async function waitForConfirmation(txHash: string, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<{ state: SendResult['state']; blockNumber?: string }> {
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 1, timeout: 4000 }) })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` })
      if (receipt) return { state: receipt.status === 'reverted' ? 'failed' : 'success', blockNumber: receipt.blockNumber?.toString() }
    } catch { /* not mined yet (TransactionReceiptNotFoundError) or RPC hiccup - keep polling */ }
    await new Promise(r => setTimeout(r, RECEIPT_POLL_MS))
  }
  // Timeout is not evidence the transaction failed.
  return { state: 'pending' }
}

/**
 * Waits for a transaction's receipt in the background and reports whether it
 * actually succeeded on-chain, without ever blocking the caller. Used so
 * sendUSDC/sendEURC can return the instant a transaction is genuinely
 * submitted (a real signed transaction with a real hash, already broadcast)
 * instead of making the whole UI sit and wait for full confirmation before
 * showing ANY feedback - that wait (nonce fetch + gas estimate + send +
 * polling for the receipt) was the actual, measurable source of "slow to
 * execute" after entering a passcode. A submitted transaction with valid
 * signature/nonce/gas succeeds the vast majority of the time; catching the
 * rare revert here and reporting it back via onSettled, rather than making
 * every single send wait several seconds for that small extra certainty, is
 * a genuinely better tradeoff for a payments app where users check this
 * multiple times a day.
 */
export function confirmTransactionInBackground(
  txHash: `0x${string}`,
  onSettled: (result: { success: boolean; blockNumber?: string }) => void,
): void {
  // PERF FIX: pollingInterval defaults to viem's built-in 4000ms when
  // unset. waitForTransactionReceipt's first check happens right after
  // broadcast - before Arc has even produced the next block - so without
  // an explicit fast interval, every wait effectively costs a full ~4s
  // regardless of Arc's real sub-second finality (the receipt is usually
  // ready well before the SECOND poll tick, but nothing checks again until
  // then). 250ms lets this notice the receipt within a fraction of a
  // second of it actually landing.
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }), pollingInterval: 250 })
  publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60000 })
    .then(receipt => {
      onSettled({ success: receipt.status !== 'reverted', blockNumber: receipt.blockNumber?.toString() })
    })
    .catch(e => {
      console.error('[arcService] background confirmation failed for', txHash, e instanceof Error ? e.message : e)
      // Deliberately does NOT call onSettled with success:false here - a
      // confirmation-check failure (RPC hiccup, timeout) is not the same
      // fact as the transaction itself having reverted, and treating it
      // that way would incorrectly flip a genuinely successful payment to
      // "failed" in the UI/activity feed just because our own polling had
      // trouble, not because anything was wrong with the transaction.
    })
}


// ─── Send through the server (OKX-style) ────────────────────────────────────
// The phone signs the payment itself (the key never leaves it) and already
// knows the transaction hash before anything is sent. One request then hands
// the signed bytes to /api/arc-rpc, which broadcasts to every Arc node at once
// and waits for the receipt on the server's fast connection - instead of the
// phone doing chainId + send + receipt polling over a weak link.
// Anything unclear (old server, lost answer) falls back to sending it directly
// as before; a payment that may have gone out is reported 'pending', never
// 'failed' (SUBMITTED_UNKNOWN - Architecture rule 5).
const RELAY_METHOD = 'meshport_sendRawTransactionAndWait'
const RELAY_REJECTED = -32003
const ALREADY_SENT = /already known|known transaction|already imported|nonce too low|replacement transaction underpriced/i

export async function relaySend(
  account: PrivateKeyAccount,
  tx: { to: `0x${string}`; value?: bigint; data?: `0x${string}`; gas: bigint; nonce: number },
  onSent: (hash: `0x${string}`) => void,
): Promise<{ txHash: `0x${string}`; state: SendResult['state']; blockNumber?: string }> {
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: ARC_CHAIN_INLINE.id,
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
  })
  const txHash = keccak256(raw)

  let relayed: { hash?: string; status?: string; blockNumber?: string; broadcast?: string } | null = null
  try {
    const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: RELAY_METHOD, params: [raw, txHash, 8000] }, isSlowNetwork() ? 40_000 : 20_000)
    relayed = json?.result ?? null
  } catch (e: any) {
    // Every node that answered refused it: nothing was sent.
    if (e && typeof e === 'object' && e.code === RELAY_REJECTED) throw new Error(e.message || 'Transaction rejected')
    // Otherwise unknown (lost answer / older server): handled below.
  }
  if (relayed?.hash && relayed.broadcast !== 'unknown') {
    onSent(txHash)
    if (relayed.status === 'success' || relayed.status === 'failed') {
      return { txHash, state: relayed.status, blockNumber: relayed.blockNumber ? BigInt(relayed.blockNumber).toString() : undefined }
    }
    // Sent, no receipt within the server's wait: one short look, then pending.
    return { txHash, ...(await waitForConfirmation(txHash, 3_000)) }
  }

  // Fallback: send it directly through the proxy, as before. Re-sending the
  // identical signed bytes is harmless ("already known").
  try {
    await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
    onSent(txHash)
  } catch (e: any) {
    const msg = String(e?.message ?? '')
    if (ALREADY_SENT.test(msg)) onSent(txHash)
    // A JSON-RPC rejection from the node: not sent.
    else if (e && typeof e === 'object' && typeof e.code === 'number') throw new Error(msg || 'Transaction rejected')
    // A network failure: it may or may not be out - keep watching it.
    else return { txHash, state: 'pending' }
  }
  return { txHash, ...(await waitForConfirmation(txHash)) }
}

// ─── Send USDC - exact Arc docs pattern ──────────────────────────────────────
/** Last check before signing: a real amount and a real recipient. */
function assertSendable(to: string, amount: number) {
  if (!(Number.isFinite(amount) && amount > 0)) throw new Error('Enter an amount greater than 0')
  if (/^0x0{40}$/i.test(String(to))) throw new Error('Cannot send to the zero address')
}

export async function sendUSDC(params: {
  privateKey: string
  to: string
  amount: number
  idempotencyKey?: string
  recipientUsername?: string | null
}): Promise<SendResult> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`)
  const senderAddress = account.address


  assertSendable(params.to, params.amount)
  // Step 1: Validate destination address (Arc docs Step 1)
  if (!isAddress(params.to)) {
    throw new Error(`Invalid destination address: ${params.to}`)
  }
  const destination = getAddress(params.to) // EIP-55 checksum

  // Self-transfer is now permitted (previously blocked here). A self-send
  // still costs real gas with no net balance change -- that tradeoff is now
  // the user's own choice, not something this function decides for them.

  // Arc docs Step 3: Convert amount
  // "If you track 6-decimal balances, convert with: amount = amount6 * 10n ** 12n"
  const amount6dec = BigInt(Math.round(params.amount * 1_000_000))
  const amount18dec = amount6dec * (10n ** 12n)  // exact Arc docs formula

  // Gas estimation lives in the shared preflight; signing happens locally in
  // relaySend (no wallet client / RPC round trips needed to sign).

  const { markPayAttemptSubmitted } = await import('./payIntentService')

  // PERF FIX ("slow payments"): the balance check, server-side intent/nonce
  // reservation, and gas estimate are three independent network round trips
  // - none needs another's result - that used to run strictly sequentially.
  // Arc's own finality is sub-second (see CONFIRM_TIMEOUT_MS below), so the
  // actual on-chain send was never the slow part; three back-to-back RPC/
  // server hops before the transaction was even broadcast was. Running them
  // concurrently cuts that pre-broadcast leg from ~3 round trips to ~1.
  //
  // Safe to create the pay intent before the balance check resolves:
  // getUSDCBalance() never throws (catches internally, returns 0 on
  // failure - see its own definition), and an intent that turns out to
  // belong to a too-small balance is exactly the same "created but never
  // broadcast" shape payNonceRecovery.ts/payReconcile.ts already handle for
  // any other pre-broadcast failure (e.g. estimateGas throwing) in the
  // previous sequential version of this same function.
  // Usually already resolved: started at PIN entry via preparePayment().
  const { intent: intentResult, gas: gasEstimate, balance } = await getPreflight(
    'USDC', senderAddress, destination, params.amount, params.idempotencyKey ?? crypto.randomUUID(), params.recipientUsername)
  const balanceUsdc = balance ?? 0

  // Step 2: Check balance
  if (balanceUsdc < params.amount) {
    throw new Error(
      `Insufficient USDC. Have ${balanceUsdc.toFixed(4)} USDC, need ${params.amount} USDC. ` +
      `Get testnet USDC at faucet.circle.com`
    )
  }
  // RESILIENCE FIX (2026-09-17, explicit product requirement: Pay must
  // still work correctly on a bad/flaky connection, not just fail): if the
  // caller passed the SAME idempotencyKey as a previous attempt (see
  // PaySendPage.tsx's own idempotencyKeyRef - reused across retries of the
  // identical payment) AND that previous attempt already broadcast, the
  // server returns the real tx_hash here rather than a nonce. Signing and
  // broadcasting AGAIN in that case would be a genuine double-send - the
  // whole reason a client-computed nonce was removed earlier (see the
  // comment below). Instead, resume by returning success directly with the
  // ALREADY-real hash. No new signature, no new broadcast, no risk.
  if (intentResult.existingTxHash) {
    return {
      txHash: intentResult.existingTxHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${intentResult.existingTxHash}`,
      ...(await waitForConfirmation(intentResult.existingTxHash)),
      senderAddress,
      recipientAddress: destination,
    }
  }
  // ── One Pay operation = one transaction_intent + one transaction_attempt,
  // created server-side BEFORE any broadcast, with the nonce reserved
  // server-side too (docs/PAY_TRANSACTION_INTENT_IMPLEMENTATION.md) - the
  // same architecture already production-validated for BulkPay. This
  // function no longer computes its own nonce via
  // publicClient.getTransactionCount at all - a client-computed nonce is
  // exactly the value a lost broadcast response leaves nothing to
  // reconcile against.
  if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
    throw new Error(intentResult.error ?? 'Failed to prepare payment')
  }
  const attemptId = intentResult.attemptId
  const serverNonce = intentResult.nonce

  // Cast: viem's sendTransaction overload resolution (in the installed
  // viem/typescript combination) spuriously demands an EIP-4844 `kzg`
  // field for a plain EIP-1559 transfer like this one. Runtime behavior
  // is unaffected - this is purely a type-level viem overload issue.
  //
  // Server-issued nonce (above) - NEVER a client-computed
  // publicClient.getTransactionCount call, and no client-side retry with a
  // freshly self-computed nonce either (that was exactly as much
  // "frontend independently decides the nonce" as the original fetch -
  // removed for the same reason). A real broadcast failure here is
  // surfaced to the caller and, if the transaction may still have reached
  // the network, resolved by the same UNKNOWN/nonce-recovery mechanism
  // BulkPay already uses (payNonceRecovery.ts).
  // Signed here, sent and confirmed by the server in one request (relaySend);
  // the real tx_hash is persisted server-side as soon as it's out -
  // fire-and-forget: markPayAttemptSubmitted never throws, and its own
  // failure must never block or fail an already-broadcast payment.
  const sent = await relaySend(account, { to: destination, value: amount18dec, gas: (gasEstimate * 120n) / 100n, nonce: serverNonce },
    h => { void markPayAttemptSubmitted(attemptId, h).catch(() => { /* best-effort */ }) })
  const txHash = sent.txHash

  // BUG FIX (2026-09-03) - this used to return immediately after
  // broadcasting, before any confirmation at all. A blocking wait (bounded
  // by CONFIRM_TIMEOUT_MS) was added so "success" meant "confirmed
  // on-chain," not just "broadcast."
  //
  // 2026-09-17 this was reverted to an optimistic return (success on
  // broadcast) for speed, which let a reverted or never-mined payment show
  // a success screen. Restored to a real, bounded wait (2026-09-28, product
  // decision): with 250ms polling it costs ~Arc's sub-second finality, and
  // the pre-broadcast leg is now overlapped with PIN entry (preparePayment).
  // Callers branch on state: 'success' / 'failed' / 'pending'. relaySend
  // already waited for the real receipt (server-side).
  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    state: sent.state,
    blockNumber: sent.blockNumber,
    senderAddress,
    recipientAddress: destination,
  }
}

// ─── isValidAddress ───────────────────────────────────────────────────────────
export function isValidAddress(address: string): boolean {
  return isAddress(address)
}

// ─── Estimate fee ─────────────────────────────────────────────────────────────
// BUG FIX (2026-09-17): this used to hardcode 21,000 gas units - correct for
// a native USDC send, but silently wrong for EURC/cirBTC, which are ERC-20
// `transfer()` calls. Arc's own docs (docs.arc.io/integrate/exchanges/
// withdrawals) are explicit: "A native USDC send uses approximately 21,000
// gas units, while an ERC-20 transfer() call uses approximately 65,000."
// Every caller (PaySendPage.tsx, SwapPage.tsx) was getting a ~3x
// UNDER-estimate whenever the selected token was EURC or cirBTC, since the
// function had no way to know which kind of transfer it was being asked
// about. `isErc20` defaults to false (native) to keep every existing
// call site's behavior for USDC exactly unchanged.
export async function estimateTransferFee(_amount = 0, isErc20 = false): Promise<number> {
  try {
    const publicClient = createPublicClient({
      transport: arcTransport({ timeout: 10000 }),
    })
    const gasPrice = await publicClient.getGasPrice()
    const gasUnits = isErc20 ? 65000n : 21000n // Arc docs: native send vs ERC-20 transfer()
    return Number(gasUnits * gasPrice) / 1e18
  } catch {
    return 0.0001
  }
}

// ─── EURC/cirBTC contracts - from the shared token registry ────────────────
export const EURC_CONTRACT = ARC_TOKENS.EURC.contract
export const CIRBTC_CONTRACT = ARC_TOKENS.cirBTC.contract

// ─── Send EURC (ERC-20 transfer) ─────────────────────────────────────────────
export async function sendEURC(params: {
  privateKey: string
  to: string
  amount: number
  idempotencyKey?: string
  recipientUsername?: string | null
}): Promise<SendResult> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`)
  const senderAddress = account.address


  assertSendable(params.to, params.amount)
  if (!isAddress(params.to)) throw new Error(`Invalid destination address: ${params.to}`)
  const destination = getAddress(params.to)
  // Self-transfer is now permitted (previously blocked here) -- same
  // reasoning as sendUSDC above.

  // EURC is 6-decimal ERC-20
  const amountWei = parseUnits(toPlainDecimalString(params.amount, 6), 6)

  const ERC20_ABI = [{
    name: 'transfer',
    type: 'function',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  }] as const

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [destination, amountWei],
  })

  // Server-reserved intent/attempt/nonce - same as sendUSDC above, see its
  // own comment for the full reasoning. expectedTo for confirmation is
  // EURC_CONTRACT here (an ERC20 transfer's real destination), not the
  // recipient - payConfirmation.ts computes this correctly from
  // token_address, which is why it's sent below.
  //
  // PERF FIX ("slow payments"): intent creation and gas estimation are
  // independent round trips - same fix as sendUSDC above, see its own
  // comment for the full reasoning.
  // Usually already resolved: started at PIN entry via preparePayment().
  const { markPayAttemptSubmitted } = await import('./payIntentService')
  const { intent: intentResult, gas: gasEstimate } = await getPreflight(
    'EURC', senderAddress, destination, params.amount, params.idempotencyKey ?? crypto.randomUUID(), params.recipientUsername)
  // RESILIENCE FIX (2026-09-17): see sendUSDC's own comment above for the
  // full reasoning - resume from an already-broadcast retry instead of
  // signing/broadcasting a second time.
  if (intentResult.existingTxHash) {
    return {
      txHash: intentResult.existingTxHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${intentResult.existingTxHash}`,
      ...(await waitForConfirmation(intentResult.existingTxHash)),
      senderAddress,
      recipientAddress: destination,
    }
  }
  if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
    throw new Error(intentResult.error ?? 'Failed to prepare payment')
  }
  const attemptId = intentResult.attemptId
  const serverNonce = intentResult.nonce

  // Cast: see comment on the sendTransaction call above - viem's
  // overload resolution spuriously demands an EIP-4844 `kzg` field here
  // too. Runtime behavior is unaffected.
  // Signed here, sent and confirmed by the server in one request - see
  // relaySend (and sendUSDC's comments).
  const sent = await relaySend(account, { to: EURC_CONTRACT as `0x${string}`, data: data as `0x${string}`, gas: (gasEstimate * 120n) / 100n, nonce: serverNonce },
    h => { void markPayAttemptSubmitted(attemptId, h).catch(() => { /* best-effort */ }) })
  const txHash = sent.txHash

  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    // Real receipt, already waited for by relaySend.
    state: sent.state,
    blockNumber: sent.blockNumber,
    senderAddress,
    recipientAddress: destination,
  }
}

// ─── Get EURC balance (ERC-20 balanceOf) ─────────────────────────────────────
async function readTokenBalanceOrThrow(address: string, contract: string, decimals: number): Promise<number> {
  const padded = address.toLowerCase().replace('0x','').padStart(64,'0')
  const json = await arcRpcJson({
    jsonrpc: '2.0', id: 1,
    method: 'eth_call',
    params: [{ to: contract, data: '0x70a08231' + padded }, 'latest'],
  }, 10000)
  if (json?.error) throw new Error(json.error.message || 'balanceOf failed')
  const hex = json?.result
  if (!hex || hex === '0x' || hex === '0x0') return 0
  return Number(BigInt(hex)) / 10 ** decimals
}

/** Throwing variants: a failed read is an error, not a 0 balance. */
export const readEURCBalanceOrThrow = (address: string) => readTokenBalanceOrThrow(address, EURC_CONTRACT, 6)     // EURC = 6 decimals
export const readCirBtcBalanceOrThrow = (address: string) => readTokenBalanceOrThrow(address, CIRBTC_CONTRACT, 8) // cirBTC = 8 decimals

export async function getEURCBalance(address: string): Promise<number> {
  try { return await readEURCBalanceOrThrow(address) } catch { return 0 }
}

export async function getCirBtcBalance(address: string): Promise<number> {
  try { return await readCirBtcBalanceOrThrow(address) } catch { return 0 }
}

// ─── Send cirBTC (ERC-20 transfer) ───────────────────────────────────────────
// Byte-for-byte the same shape as sendEURC above - server-reserved
// intent/attempt/nonce, parallelized intent-creation + gas-estimate, real
// on-chain confirmation before returning 'success' - just pointed at
// CIRBTC_CONTRACT with 8 decimals instead of EURC_CONTRACT's 6. This
// function did not exist before: PaySendPage.tsx's send-routing ternary
// checked for `arcMod.sendCirBTC` and, finding it undefined, silently fell
// through to sendUSDC - meaning a cirBTC send would have actually broadcast
// a native USDC transfer (wrong asset, wrong decimals) while still logging
// the Activity row as 'cirBTC'. See sendEURC's own comments for the full
// reasoning behind each piece below; identical here.
export async function sendCirBTC(params: {
  privateKey: string
  to: string
  amount: number
  idempotencyKey?: string
  recipientUsername?: string | null
}): Promise<SendResult> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`)
  const senderAddress = account.address

  assertSendable(params.to, params.amount)
  if (!isAddress(params.to)) throw new Error(`Invalid destination address: ${params.to}`)
  const destination = getAddress(params.to)
  // Self-transfer is now permitted -- same reasoning as sendUSDC above.

  // cirBTC is 8-decimal ERC-20
  const amountWei = parseUnits(toPlainDecimalString(params.amount, 8), 8)

  const ERC20_ABI = [{
    name: 'transfer',
    type: 'function',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  }] as const

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [destination, amountWei],
  })

  // Server-reserved intent/attempt/nonce - same as sendUSDC/sendEURC above.
  // PERF: intent creation and gas estimation run concurrently, same fix as
  // sendUSDC/sendEURC - see sendUSDC's own comment for the full reasoning.
  // Usually already resolved: started at PIN entry via preparePayment().
  const { markPayAttemptSubmitted } = await import('./payIntentService')
  const { intent: intentResult, gas: gasEstimate } = await getPreflight(
    'cirBTC', senderAddress, destination, params.amount, params.idempotencyKey ?? crypto.randomUUID(), params.recipientUsername)
  // RESILIENCE FIX (2026-09-17): see sendUSDC's own comment above for the
  // full reasoning - resume from an already-broadcast retry instead of
  // signing/broadcasting a second time.
  if (intentResult.existingTxHash) {
    return {
      txHash: intentResult.existingTxHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${intentResult.existingTxHash}`,
      ...(await waitForConfirmation(intentResult.existingTxHash)),
      senderAddress,
      recipientAddress: destination,
    }
  }
  if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
    throw new Error(intentResult.error ?? 'Failed to prepare payment')
  }
  const attemptId = intentResult.attemptId
  const serverNonce = intentResult.nonce

  // Cast: see comment on sendUSDC's sendTransaction call above - viem's
  // overload resolution spuriously demands an EIP-4844 `kzg` field here too.
  // MAINNET FIX: same inline chain duplication bug as sendEURC - replaced
  // with ARC_CHAIN_INLINE (env-driven, matches sendUSDC and now sendEURC).
  // Signed here, sent and confirmed by the server in one request - see
  // relaySend (and sendUSDC's comments).
  const sent = await relaySend(account, { to: CIRBTC_CONTRACT as `0x${string}`, data: data as `0x${string}`, gas: (gasEstimate * 120n) / 100n, nonce: serverNonce },
    h => { void markPayAttemptSubmitted(attemptId, h).catch(() => { /* best-effort */ }) })
  const txHash = sent.txHash

  // PERF FIX (2026-09-17, explicit product decision): reverted back to
  // optimistic return - see sendUSDC's own comment for the full reasoning.
  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    // Real receipt, already waited for by relaySend.
    state: sent.state,
    blockNumber: sent.blockNumber,
    senderAddress,
    recipientAddress: destination,
  }
}
