/**
 * Arc Blockchain Service
 * Implemented exactly per Arc docs: https://docs.arc.io/integrate/exchanges/withdrawals
 */
import { createPublicClient, createWalletClient, parseUnits, encodeFunctionData, parseGwei, getAddress, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_RPCS, arcTransport, arcRpcJson } from './arc'
import { ARC, ARC_TOKENS, ARC_CHAIN_INLINE as REGISTRY_ARC_CHAIN_INLINE } from '@/blockchain/chains'

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

// Arc docs: chain config for sendTransaction — decimals: 18 (native USDC wei).
// Exported so p2pEscrowContract.ts can reuse it directly rather than
// duplicating the constant.
export const ARC_CHAIN_INLINE = REGISTRY_ARC_CHAIN_INLINE

// ─── BUG FIX (Payment Failed: "Value `1e-8` is not a valid decimal number.") ─
// sendEURC/sendCirBTC used to build viem's `parseUnits` input with plain
// `params.amount.toString()`. `params.amount` is a JS `number`, and
// `Number.prototype.toString()` switches to EXPONENTIAL notation for any
// magnitude below 1e-6 — e.g. `(0.00000001).toString()` is `'1e-8'`, not
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

// ─── Get USDC balance — Arc docs: use eth_getBalance (18-decimal native wei) ──
export async function getUSDCBalance(address: string): Promise<number> {
  try {
    const json = await arcRpcJson({
      jsonrpc: '2.0', id: 1,
      method: 'eth_getBalance',    // Arc docs recommended method
      params: [address, 'latest'],
    }, 15000)
    const raw = json.result
    if (!raw || raw === '0x' || raw === '0x0') return 0
    // Arc native balance: 18 decimals. Divide by 1e18 for USDC display value.
    const balance = Number(BigInt(raw)) / 1e18
    return balance
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

/**
 * Waits for a transaction's receipt in the background and reports whether it
 * actually succeeded on-chain, without ever blocking the caller. Used so
 * sendUSDC/sendEURC can return the instant a transaction is genuinely
 * submitted (a real signed transaction with a real hash, already broadcast)
 * instead of making the whole UI sit and wait for full confirmation before
 * showing ANY feedback — that wait (nonce fetch + gas estimate + send +
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
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })
  publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60000 })
    .then(receipt => {
      onSettled({ success: receipt.status !== 'reverted', blockNumber: receipt.blockNumber?.toString() })
    })
    .catch(e => {
      console.error('[arcService] background confirmation failed for', txHash, e instanceof Error ? e.message : e)
      // Deliberately does NOT call onSettled with success:false here — a
      // confirmation-check failure (RPC hiccup, timeout) is not the same
      // fact as the transaction itself having reverted, and treating it
      // that way would incorrectly flip a genuinely successful payment to
      // "failed" in the UI/activity feed just because our own polling had
      // trouble, not because anything was wrong with the transaction.
    })
}

// ─── Send USDC — exact Arc docs pattern ──────────────────────────────────────
export async function sendUSDC(params: {
  privateKey: string
  to: string
  amount: number
  idempotencyKey?: string
  recipientUsername?: string | null
}): Promise<SendResult> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`)
  const senderAddress = account.address


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

  // Arc docs Step 3: Create clients — walletClient WITHOUT chain (chain passed inline)
  const publicClient = createPublicClient({
    transport: arcTransport({ retryCount: 3, timeout: 30000 }),
  })
  const walletClient = createWalletClient({
    account,
    transport: arcTransport(),
  })

  const { createPayIntent, markPayAttemptSubmitted } = await import('./payIntentService')

  // PERF FIX ("slow payments"): the balance check, server-side intent/nonce
  // reservation, and gas estimate are three independent network round trips
  // — none needs another's result — that used to run strictly sequentially.
  // Arc's own finality is sub-second (see CONFIRM_TIMEOUT_MS below), so the
  // actual on-chain send was never the slow part; three back-to-back RPC/
  // server hops before the transaction was even broadcast was. Running them
  // concurrently cuts that pre-broadcast leg from ~3 round trips to ~1.
  //
  // Safe to create the pay intent before the balance check resolves:
  // getUSDCBalance() never throws (catches internally, returns 0 on
  // failure — see its own definition), and an intent that turns out to
  // belong to a too-small balance is exactly the same "created but never
  // broadcast" shape payNonceRecovery.ts/payReconcile.ts already handle for
  // any other pre-broadcast failure (e.g. estimateGas throwing) in the
  // previous sequential version of this same function.
  const [balanceUsdc, intentResult, gasEstimate] = await Promise.all([
    getUSDCBalance(senderAddress),
    createPayIntent({
      walletAddress: senderAddress,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
      chainId: 'arc',
      amountAtomic: amount18dec.toString(),
      decimals: 18,
      isNative: true,
      tokenAddress: null,
      tokenSymbol: 'USDC',
      recipientAddress: destination,
      recipientUsername: params.recipientUsername ?? null,
    }),
    // Arc docs Step 3: Estimate gas
    publicClient.estimateGas({
      account: senderAddress,
      to: destination,
      value: amount18dec,
    }),
  ])

  // Step 2: Check balance
  if (balanceUsdc < params.amount) {
    throw new Error(
      `Insufficient USDC. Have ${balanceUsdc.toFixed(4)} USDC, need ${params.amount} USDC. ` +
      `Get testnet USDC at faucet.circle.com`
    )
  }
  // ── One Pay operation = one transaction_intent + one transaction_attempt,
  // created server-side BEFORE any broadcast, with the nonce reserved
  // server-side too (docs/PAY_TRANSACTION_INTENT_IMPLEMENTATION.md) — the
  // same architecture already production-validated for BulkPay. This
  // function no longer computes its own nonce via
  // publicClient.getTransactionCount at all — a client-computed nonce is
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
  // is unaffected — this is purely a type-level viem overload issue.
  //
  // Server-issued nonce (above) — NEVER a client-computed
  // publicClient.getTransactionCount call, and no client-side retry with a
  // freshly self-computed nonce either (that was exactly as much
  // "frontend independently decides the nonce" as the original fetch —
  // removed for the same reason). A real broadcast failure here is
  // surfaced to the caller and, if the transaction may still have reached
  // the network, resolved by the same UNKNOWN/nonce-recovery mechanism
  // BulkPay already uses (payNonceRecovery.ts).
  const txHash = await walletClient.sendTransaction({
    to: destination,
    value: amount18dec,
    gas: (gasEstimate * 120n) / 100n,
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
    chain: ARC_CHAIN_INLINE,
    nonce: serverNonce,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

  // Persist the real tx_hash server-side IMMEDIATELY, before waiting for
  // any receipt — fire-and-forget: markPayAttemptSubmitted never throws,
  // and its own failure must never block or fail an already-broadcast,
  // already-real payment.
  void markPayAttemptSubmitted(attemptId, txHash).catch(() => { /* best-effort */ })

  // BUG FIX (2026-09-03) — this used to return immediately after
  // broadcasting, before any confirmation at all, on the theory that
  // waiting was the measurable source of "slow to execute" and that a
  // rare revert could be caught afterward by confirmTransactionInBackground.
  // In practice that meant "Payment Sent" — the chat message, the Activity
  // row, the recipient notification — could all fire for a transaction
  // that hadn't actually landed yet, and in the rare revert case, had
  // already told the user (and the recipient) it succeeded before quietly
  // correcting itself moments later. That's a real trust problem for a
  // payments app, not just a cosmetic one — "paid" should mean paid.
  //
  // Arc's own consensus has confirmationDepth 0 (no reorgs, one
  // confirmation is final — see the removed comment this replaces, and
  // arc/chains.ts), so the actual wait for the common case is small —
  // typically under a second. Waiting for the real receipt here, bounded
  // by a short timeout, means the success state callers see now actually
  // means "confirmed on-chain," not just "broadcast," at negligible cost
  // in the case that matters (a healthy connection). The timeout exists
  // specifically for the OTHER case — a genuinely slow/unreliable
  // connection — so this can never hang the whole payment flow: if the
  // receipt doesn't land within the window, this falls back to exactly
  // the previous behavior (return as submitted, let
  // confirmTransactionInBackground and the server-side payConfirmation
  // reconcile it afterward) rather than making the user wait indefinitely.
  const CONFIRM_TIMEOUT_MS = 8_000
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: CONFIRM_TIMEOUT_MS })
    if (receipt.status === 'reverted') {
      // Caught BEFORE returning to the caller — this is what actually
      // closes the "shown success, then silently corrected" gap. The
      // caller's own catch block now sees a real failure, the same as any
      // other send error, instead of an optimistic success it has to
      // walk back later.
      throw new Error('Transaction reverted on-chain')
    }
    return {
      txHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
      state: 'success',
      blockNumber: receipt.blockNumber?.toString(),
      senderAddress,
      recipientAddress: destination,
    }
  } catch (e: any) {
    // A revert (thrown above) must propagate as a real failure. A
    // confirmation-check problem (RPC hiccup, or a genuinely slow network
    // exceeding CONFIRM_TIMEOUT_MS) is a DIFFERENT fact — the transaction
    // is still real and already broadcast, our own polling just didn't
    // finish in time — so that case falls through to the same
    // "submitted, not yet confirmed" return the function always used to
    // give, and confirmTransactionInBackground (already wired up by every
    // caller) picks up the real outcome from there without blocking
    // anyone further.
    if (e?.message === 'Transaction reverted on-chain') throw e
  }

  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    state: 'pending',
    senderAddress,
    recipientAddress: destination,
  }
}

// ─── isValidAddress ───────────────────────────────────────────────────────────
export function isValidAddress(address: string): boolean {
  return isAddress(address)
}

// ─── Estimate fee ─────────────────────────────────────────────────────────────
export async function estimateTransferFee(_amount = 0): Promise<number> {
  try {
    const publicClient = createPublicClient({
      transport: arcTransport({ timeout: 10000 }),
    })
    const gasPrice = await publicClient.getGasPrice()
    const gasUnits = 21000n // typical native USDC send per Arc docs
    return Number(gasUnits * gasPrice) / 1e18
  } catch {
    return 0.0001
  }
}

// ─── EURC/cirBTC contracts — from the shared token registry ────────────────
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

  const publicClient = createPublicClient({
    transport: arcTransport({ retryCount: 3, timeout: 30000 }),
  })
  const walletClient = createWalletClient({
    account,
    transport: arcTransport(),
  })

  // Server-reserved intent/attempt/nonce — same as sendUSDC above, see its
  // own comment for the full reasoning. expectedTo for confirmation is
  // EURC_CONTRACT here (an ERC20 transfer's real destination), not the
  // recipient — payConfirmation.ts computes this correctly from
  // token_address, which is why it's sent below.
  //
  // PERF FIX ("slow payments"): intent creation and gas estimation are
  // independent round trips — same fix as sendUSDC above, see its own
  // comment for the full reasoning.
  const { createPayIntent, markPayAttemptSubmitted } = await import('./payIntentService')
  const [intentResult, gasEstimate] = await Promise.all([
    createPayIntent({
      walletAddress: senderAddress,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
      chainId: 'arc',
      amountAtomic: amountWei.toString(),
      decimals: 6,
      isNative: false,
      tokenAddress: EURC_CONTRACT,
      tokenSymbol: 'EURC',
      recipientAddress: destination,
      recipientUsername: params.recipientUsername ?? null,
    }),
    publicClient.estimateGas({
      account: senderAddress,
      to: EURC_CONTRACT,
      data,
    }),
  ])
  if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
    throw new Error(intentResult.error ?? 'Failed to prepare payment')
  }
  const attemptId = intentResult.attemptId
  const serverNonce = intentResult.nonce

  // Cast: see comment on the sendTransaction call above — viem's
  // overload resolution spuriously demands an EIP-4844 `kzg` field here
  // too. Runtime behavior is unaffected.
  const txHash = await walletClient.sendTransaction({
    to: EURC_CONTRACT,
    data,
    gas: (gasEstimate * 120n) / 100n,
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
    nonce: serverNonce,
    chain: {
      id: ARC_TESTNET.chainId,
      name: ARC_TESTNET.name,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ARC_RPCS } },
    },
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

  void markPayAttemptSubmitted(attemptId, txHash).catch(() => { /* best-effort */ })

  // Same fix as sendUSDC above — wait for the real receipt, bounded by a
  // short timeout, so "success" here means confirmed, not just broadcast.
  // See sendUSDC's own comment for the full reasoning; identical here.
  const CONFIRM_TIMEOUT_MS = 8_000
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: CONFIRM_TIMEOUT_MS })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted on-chain')
    }
    return {
      txHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
      state: 'success',
      blockNumber: receipt.blockNumber?.toString(),
      senderAddress,
      recipientAddress: destination,
    }
  } catch (e: any) {
    if (e?.message === 'Transaction reverted on-chain') throw e
    // Confirmation-check problem (RPC hiccup / slow network exceeding the
    // timeout) — not a revert. Fall through to "submitted, not yet
    // confirmed", same as before, and let confirmTransactionInBackground
    // reconcile it.
  }

  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    state: 'pending',
    senderAddress,
    recipientAddress: destination,
  }
}

// ─── Get EURC balance (ERC-20 balanceOf) ─────────────────────────────────────
export async function getEURCBalance(address: string): Promise<number> {
  try {
    const padded = address.toLowerCase().replace('0x','').padStart(64,'0')
    const json = await arcRpcJson({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: EURC_CONTRACT, data: '0x70a08231' + padded }, 'latest'],
    }, 10000)
    const hex = json?.result
    if (!hex || hex === '0x' || hex === '0x0') return 0
    return Number(BigInt(hex)) / 1e6   // EURC = 6 decimals
  } catch {
    return 0
  }
}

export async function getCirBtcBalance(address: string): Promise<number> {
  try {
    const padded = address.toLowerCase().replace('0x','').padStart(64,'0')
    const json = await arcRpcJson({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: CIRBTC_CONTRACT, data: '0x70a08231' + padded }, 'latest'],
    }, 10000)
    const hex = json?.result
    if (!hex || hex === '0x' || hex === '0x0') return 0
    return Number(BigInt(hex)) / 1e8   // cirBTC = 8 decimals
  } catch {
    return 0
  }
}

// ─── Send cirBTC (ERC-20 transfer) ───────────────────────────────────────────
// Byte-for-byte the same shape as sendEURC above — server-reserved
// intent/attempt/nonce, parallelized intent-creation + gas-estimate, real
// on-chain confirmation before returning 'success' — just pointed at
// CIRBTC_CONTRACT with 8 decimals instead of EURC_CONTRACT's 6. This
// function did not exist before: PaySendPage.tsx's send-routing ternary
// checked for `arcMod.sendCirBTC` and, finding it undefined, silently fell
// through to sendUSDC — meaning a cirBTC send would have actually broadcast
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

  const publicClient = createPublicClient({
    transport: arcTransport({ retryCount: 3, timeout: 30000 }),
  })
  const walletClient = createWalletClient({
    account,
    transport: arcTransport(),
  })

  // Server-reserved intent/attempt/nonce — same as sendUSDC/sendEURC above.
  // PERF: intent creation and gas estimation run concurrently, same fix as
  // sendUSDC/sendEURC — see sendUSDC's own comment for the full reasoning.
  const { createPayIntent, markPayAttemptSubmitted } = await import('./payIntentService')
  const [intentResult, gasEstimate] = await Promise.all([
    createPayIntent({
      walletAddress: senderAddress,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
      chainId: 'arc',
      amountAtomic: amountWei.toString(),
      decimals: 8,
      isNative: false,
      tokenAddress: CIRBTC_CONTRACT,
      tokenSymbol: 'cirBTC',
      recipientAddress: destination,
      recipientUsername: params.recipientUsername ?? null,
    }),
    publicClient.estimateGas({
      account: senderAddress,
      to: CIRBTC_CONTRACT,
      data,
    }),
  ])
  if (!intentResult.success || !intentResult.attemptId || typeof intentResult.nonce !== 'number') {
    throw new Error(intentResult.error ?? 'Failed to prepare payment')
  }
  const attemptId = intentResult.attemptId
  const serverNonce = intentResult.nonce

  // Cast: see comment on sendUSDC's sendTransaction call above — viem's
  // overload resolution spuriously demands an EIP-4844 `kzg` field here too.
  const txHash = await walletClient.sendTransaction({
    to: CIRBTC_CONTRACT,
    data,
    gas: (gasEstimate * 120n) / 100n,
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
    nonce: serverNonce,
    chain: {
      id: ARC_TESTNET.chainId,
      name: ARC_TESTNET.name,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ARC_RPCS } },
    },
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

  void markPayAttemptSubmitted(attemptId, txHash).catch(() => { /* best-effort */ })

  // Same fix as sendUSDC/sendEURC above — wait for the real receipt, bounded
  // by a short timeout, so "success" here means confirmed, not just
  // broadcast. See sendUSDC's own comment for the full reasoning.
  const CONFIRM_TIMEOUT_MS = 8_000
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: CONFIRM_TIMEOUT_MS })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted on-chain')
    }
    return {
      txHash,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
      state: 'success',
      blockNumber: receipt.blockNumber?.toString(),
      senderAddress,
      recipientAddress: destination,
    }
  } catch (e: any) {
    if (e?.message === 'Transaction reverted on-chain') throw e
    // Confirmation-check problem, not a revert — fall through to
    // "submitted, not yet confirmed", same as sendUSDC/sendEURC above.
  }

  return {
    txHash,
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    state: 'pending',
    senderAddress,
    recipientAddress: destination,
  }
}
