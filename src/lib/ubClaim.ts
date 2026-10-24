// src/lib/ubClaim.ts
//
// Unified Balance (Circle Gateway) route for CLAIM: other chain → Arc.
// Mirror of the Transfer page's UB route (deposit on Arc → spend to the
// destination), reversed:
//   1. deposit()  USDC into the Unified Balance on the SOURCE chain
//   2. wait       until Gateway confirms it (source-chain finality)
//   3. spend()    from that chain's allocation to the user's Arc wallet
//
// Standard deposits wait for source finality: seconds on Avalanche, Polygon,
// Sonic, Sei and HyperEVM; up to ~15 min on Ethereum, Base, Arbitrum, OP,
// Unichain and World Chain (Arc docs: app-kit/tutorials/unified-balance).
// If the page is closed while waiting, nothing is lost - the USDC sits in
// the user's own Unified Balance and `spendUnifiedToArc` (Recovery panel)
// finishes it later.

// SDK chain ids that support Unified Balance deposits - see ubChains.ts.
import type { WalletAccount } from '@/wallet'
import { realTxHash } from './relayedProvider'
import { UB_CLAIM_CHAINS } from './ubChains'
import { FORWARDER_MINT_FAILING_SDK_CHAINS, forwarderMintFailing, noteForwarderMintFailed } from '@/blockchain/chains'
export { UB_CLAIM_CHAINS }

import { isMerchantNow } from './merchant'
import { ubQuoteFees, ubSpendCost, ubSpendMargin, ubForwarderPart } from './transferFees'
import { assertAccountUnlocked, isAccountLockedNow } from '@/lib/accountLockRule'

const FAST_FINALITY = new Set(['Avalanche_Fuji', 'Polygon_Amoy_Testnet', 'Sonic_Testnet', 'Sei_Testnet', 'HyperEVM_Testnet'])

/** Bring Funds timing on Unified Balance: the deposit waits for the source
 *  chain's finality before Gateway credits it (docs.arc.io: "standard deposits
 *  wait for source chain finality, which can take 15 minutes or longer";
 *  Ethereum 12-15 min; Avalanche and other fast-finality chains near-instant),
 *  then the spend to Arc. */
export function ubBringTime(sdkChainId: string): string {
  return FAST_FINALITY.has(sdkChainId) ? '1–3 min' : '3–20 min'
}

export function ubClaimEta(sdkChainId: string): string {
  return FAST_FINALITY.has(sdkChainId) ? 'under a minute' : 'up to 15 minutes'
}

// Chains whose claim is being driven right now by runUbClaim on this device -
// the background auto-finish leaves those alone so the two never race.
const inFlight = new Set<string>()

/**
 * One collect/claim per wallet + chain at a time - across the manual claim,
 * the merchant auto-collect and other open tabs. Two runs at once both try to
 * deposit the same USDC: the second deposit reverts on-chain, but used to be
 * recorded as a claim anyway (a "Processing" row that never finishes).
 * Returns null when another run holds the lock.
 */
async function withChainLock<T>(walletAddr: string, sdkChainId: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
  if (inFlight.has(sdkChainId)) return null
  inFlight.add(sdkChainId)
  try {
    const locks = (typeof navigator !== 'undefined' ? (navigator as any).locks : undefined)
    if (!locks?.request) return { value: await fn() }
    return await locks.request(`meshport-ub-claim:${walletAddr.toLowerCase()}:${sdkChainId}`, { ifAvailable: true },
      async (lock: unknown) => (lock ? { value: await fn() } : null))
  } finally {
    inFlight.delete(sdkChainId)
  }
}

export const UB_CLAIM_BUSY_MESSAGE = 'A payment from this chain is already being collected - it will finish on its own. Check Activity in a minute.'

/** Throws when the deposit transaction reverted on-chain (nothing moved). */
async function assertDepositSucceeded(sdkChainId: string, txHash: string | undefined): Promise<void> {
  if (!txHash) return
  let receipt: any = null
  try {
    const { getClient } = await import('@/blockchain/ProviderManager')
    const appChain = SDK_TO_APP_CHAIN[sdkChainId] ?? sdkChainId
    receipt = await getClient(appChain).waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 120_000 })
  } catch (e) {
    // Couldn't read it (RPC trouble / slow chain) - carry on as before.
    console.warn('[ubClaim] could not read deposit receipt', e)
    return
  }
  if (receipt?.status === 'reverted') {
    throw new Error('The deposit failed on-chain - nothing was moved. If another collection was running, it has already taken this payment.')
  }
}
// Below this, a chain's Unified Balance is leftover fee dust. Dust isn't
// shown on its own (moving it alone would cost a whole fee) - the next Bring
// from that chain sends it along to the user's Arc wallet (claimDust).
export const UB_MIN_SWEEP = 0.5
// Kept for older imports; dust isn't offered on its own (see claimDust).
export const UB_DUST_CLAIM_MIN = Number.POSITIVE_INFINITY

const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000
// The source chain's finality takes minutes - checked every 10s (Gateway's
// balance API, device path). The server-claim row is one cheap read, so the
// screen follows it every 5s, and every 2s once it is being sent to Arc.
const POLL_MS = 10_000
const POLL_SERVER_MS = 5_000
const POLL_MINTING_MS = 2_000
type Stage = 'approving' | 'attesting' | 'minting' | 'done' | 'error'
type StepFn = (stage: Stage, msg: string, pct: number, extra?: {
  txHash?: string; mintTxHash?: string
  /** MeshPort's server (ub-claim-worker) has the signed spend: safe to leave. */
  handedOff?: boolean
}) => void

function hashOf(r: any): string | undefined {
  // realTxHash: a relayed deposit/mint reports a hash that only the relayer's tx has on-chain.
  return realTxHash(r?.txHash ?? r?.transactionHash ?? r?.hash ?? r?.result?.txHash ?? undefined)
}

// Derive the networkType from the env rather than hardcoding 'testnet'.
// Hardcoding 'testnet' caused getBalances() to return 0 on mainnet
// deployments, making claims and Recover permanently invisible.
const UB_NETWORK_TYPE = (import.meta.env.VITE_NETWORK_ENV as string | undefined) === 'mainnet'
  ? 'mainnet'
  : 'testnet'

// The Arc destination chain key for UB spends - resolved from env so a
// mainnet build targets Arc mainnet instead of the testnet chain ID.
const ARC_CHAIN_KEY = (import.meta.env.VITE_NETWORK_ENV as string | undefined) === 'mainnet'
  ? 'Arc'
  : 'Arc_Testnet'

/** Confirmed Unified Balance per chain for this wallet. */
export async function getUnifiedBalances(kit: any, walletAddr: string): Promise<Array<{ chain: string; confirmed: number; pending: number }>> {
  const res: any = await kit.unifiedBalance.getBalances({
    token: 'USDC', sources: { address: walletAddr }, includePending: true,
    // An address-only source can't tell the network, and App Kit then
    // defaults to MAINNET - which reported 0 for every testnet deposit, so
    // claims never saw their deposit confirm and Recover never listed it.
    networkType: UB_NETWORK_TYPE,
  })
  const rows: Array<{ chain: string; confirmed: number; pending: number }> = []
  for (const acct of res?.breakdown ?? []) {
    for (const c of acct?.breakdown ?? acct?.chains ?? []) {
      rows.push({ chain: String(c.chain), confirmed: Number(c.confirmedBalance ?? 0), pending: Number(c.pendingBalance ?? 0) })
    }
  }
  return rows
}

async function confirmedOn(kit: any, walletAddr: string, chain: string): Promise<number> {
  const rows = await getUnifiedBalances(kit, walletAddr)
  return rows.filter(r => r.chain === chain).reduce((s, r) => s + r.confirmed, 0)
}

/**
 * Spend a chain's confirmed Unified Balance to the user's own Arc wallet.
 * `dust`: leftover already in that chain's Unified Balance (earlier
 * headroom, an unused part of a maxFee - see claimDust). It's the user's, and
 * the fee is per burn, so it goes along to their wallet at no extra cost.
 */
export async function spendUnifiedToArc(params: {
  kit: any; adapter: any; walletAddr: string; fromChain: string; amount: number; dust?: number
}): Promise<{ txHash?: string; received: number }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { dust, ...rest } = params
  return spendUnifiedTo({ ...rest, amount: params.amount + claimDust(dust), toChain: ARC_CHAIN_KEY, recipient: params.walletAddr })
}

/** The part of a chain's confirmed Unified Balance that is leftover dust
 *  (under UB_MIN_SWEEP - anything larger is someone's unfinished claim). */
export function claimDust(confirmed = 0): number {
  return confirmed > 0 && confirmed < UB_MIN_SWEEP ? confirmed : 0
}

// Circle's published Gateway gas fee per source chain, in USDC
// (developers.circle.com/gateway/references/fees - the same table App Kit
// ships as GAS_FEE_BY_CHAIN; testnets use their mainnet's fee). Only used
// when a live quote can't be had - e.g. before the deposit, when that
// chain's Unified Balance is still empty - so a Bring the fee would swallow
// is refused BEFORE anything moves.
const UB_PUBLISHED_GAS_FEE: Record<string, number> = {
  Arc_Testnet: 0.001, Arbitrum_Sepolia: 0.01, Avalanche_Fuji: 0.02, Base_Sepolia: 0.01,
  Ethereum_Sepolia: 2, HyperEVM_Testnet: 0.05, Optimism_Sepolia: 0.0015, Polygon_Amoy_Testnet: 0.0015,
  Sei_Testnet: 0.001, Sonic_Testnet: 0.01, Unichain_Sepolia: 0.001, World_Chain_Sepolia: 0.01,
}
const UB_DEFAULT_GAS_FEE = 0.1 // App Kit's own default for an unlisted chain
const GATEWAY_TRANSFER_FEE = 0.00005 // 0.5 bps

/** Circle's published Gateway fee to move `amount` out of `fromChain` (no live quote). */
export function ubPublishedFee(fromChain: string, amount: number): number {
  return (UB_PUBLISHED_GAS_FEE[fromChain] ?? UB_DEFAULT_GAS_FEE) + amount * GATEWAY_TRANSFER_FEE
}

/**
 * Read-only fee preview for a Unified Balance claim of `amount` from
 * `fromChain` to the user's own Arc wallet - the same estimateSpend() quote
 * the claim itself uses (signs nothing). The fee is Circle's maxFee for the
 * spend (Gateway fee + source gas + forwarding fee, see lib/transferFees);
 * the wallet receives at least `amount − total − headroom`, plus `dust`
 * already in that chain's Unified Balance, which goes along (see claimDust).
 * Never fails for want of a quote: before the deposit that chain's Unified
 * Balance can be empty and Circle won't price a spend from it, so Circle's
 * published fee for the chain is used instead (`approx`).
 */
export async function estimateUbClaimFee(params: {
  kit: any; adapter: any; walletAddr: string; fromChain: string; amount: number; dust?: number
}): Promise<{ gatewayFee: number; forwarderFee: number; otherFee: number; total: number; receiveAtLeast: number; approx?: boolean }> {
  const { kit, adapter, walletAddr, fromChain, amount } = params
  const dust = claimDust(params.dust)
  let est: any
  try {
    est = await kit.unifiedBalance.estimateSpend({
      from: { adapter, allocations: [{ amount: amount.toFixed(6), chain: fromChain }] },
      to: { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true },
      token: 'USDC',
      amount: amount.toFixed(6),
    })
  } catch (e: any) {
    // "too small": Circle says the fee is more than the amount.
    const published = ubPublishedFee(fromChain, amount)
    const total = /too small/i.test(e?.message ?? '') ? Math.max(published, amount) : published
    return { gatewayFee: total, forwarderFee: 0, otherFee: 0, total, approx: true,
      receiveAtLeast: Math.max(0, amount + dust - total - ubSpendMargin(total)) }
  }
  const f = ubQuoteFees(est)
  const total = ubSpendCost(f)
  // The forwarding fee is part of maxFee ('gasFee'), shown as its own row.
  const forwarderFee = ubForwarderPart(f)
  const gatewayFee = total - forwarderFee
  return { gatewayFee, forwarderFee, otherFee: 0, total, receiveAtLeast: Math.max(0, amount + dust - total - ubSpendMargin(total)) }
}

// Destinations where Circle's Gateway forwarder mint has been failing
// on-chain ("Forwarder transfer failed: ON_CHAIN_FAILURE") - mint these
// ourselves instead of waiting for the forwarder to fail first. Includes
// every chain in FORWARDER_MINT_FAILING_SDK_CHAINS (see blockchain/chains.ts).
export const GATEWAY_SELF_MINT_CHAINS = new Set(['Sei_Testnet', ...FORWARDER_MINT_FAILING_SDK_CHAINS])

/** Mint a Gateway spend to `sdk` ourselves: listed above, or the forwarder failed there recently (forwarderMintFailing). */
export function gatewaySelfMintsTo(sdk: string): boolean {
  return GATEWAY_SELF_MINT_CHAINS.has(sdk) || forwarderMintFailing(sdk)
}

/** true when a Gateway spend failed at the forwarder's destination mint and can be minted by us. */
export function forwarderMintRetry(err: any): { attestation: string; signature: string } | null {
  const trace = err?.cause?.trace
  const msg = String(err?.message ?? '')
  if (trace?.attestation && trace?.signature && (err?.recoverability === 'RESUMABLE' || /ON_CHAIN_FAILURE|forwarder/i.test(msg))) {
    return { attestation: trace.attestation, signature: trace.signature }
  }
  return null
}

/**
 * Spend `amount` of `fromChain`'s Unified Balance to any chain/recipient
 * (fees come out of `amount`). Uses Circle's forwarder; if the forwarder's
 * mint fails on-chain - or the destination is in GATEWAY_SELF_MINT_CHAINS -
 * the mint is submitted by the user's own wallet on the destination
 * (`destAdapter`, submitted through MeshPort's relayer - see relayedProvider). The recipient never
 * changes; only who pays for and submits the mint.
 */
export async function spendUnifiedTo(params: {
  kit: any; adapter: any; fromChain: string; amount: number; toChain: string; recipient: string
  destAdapter?: any
  /** Dust on `fromChain` beyond `amount`, used as the safety margin. */
  cushion?: number
  /** Same-chain move (Arc → Arc): the wallet submits the mint itself, paying
   *  only that chain's gas, instead of Circle's forwarder. */
  selfMint?: boolean
}): Promise<{ txHash?: string; received: number }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { kit, adapter, fromChain, amount, toChain, recipient } = params
  const destAdapter = params.destAdapter ?? adapter
  const forwarderTo = { chain: toChain, recipientAddress: recipient, useForwarder: true }
  const selfMintTo = { chain: toChain, recipientAddress: recipient, adapter: destAdapter, useForwarder: false }
  const alloc = (a: number) => ({ adapter, allocations: [{ amount: a.toFixed(6), chain: fromChain }] })

  // Fees come out of the Unified Balance, so send amount − fee - priced for
  // the route actually used. A self-mint destination (Ethereum Sepolia…)
  // pays no forwarding fee: quoting it with the forwarder added Circle's
  // forwarding fee + Ethereum mint gas (~1.5 USDC) that is never charged,
  // so small amounts were refused and larger ones sent ~1.5 USDC short.
  // If that quote fails, the forwarder quote (always the higher) is used.
  const selfMint = !!params.selfMint || (toChain !== ARC_CHAIN_KEY && gatewaySelfMintsTo(toChain))
  const quote = (to: any) => kit.unifiedBalance.estimateSpend({ from: alloc(amount), to, token: 'USDC', amount: amount.toFixed(6) })
  const est: any = selfMint ? await quote(selfMintTo).catch(() => quote(forwarderTo)) : await quote(forwarderTo)
  const fee = ubSpendCost(ubQuoteFees(est))
  const send = Math.max(0, amount - fee - ubSpendMargin(fee, params.cushion))
  if (send <= 0) throw new Error(`Amount too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)

  if (selfMint) {
    const r: any = await kit.unifiedBalance.spend({ from: alloc(send), to: selfMintTo, token: 'USDC', amount: send.toFixed(6) })
    return { txHash: hashOf(r), received: send }
  }
  try {
    const r: any = await kit.unifiedBalance.spend({ from: alloc(send), to: forwarderTo, token: 'USDC', amount: send.toFixed(6) })
    return { txHash: hashOf(r), received: send }
  } catch (err) {
    // Forwarder mint failed on-chain: the attestation is still valid -
    // mint it ourselves on the destination (same recipient).
    const retry = forwarderMintRetry(err)
    if (!retry) throw err
    noteForwarderMintFailed(toChain)
    const r: any = await kit.unifiedBalance.spend({
      from: alloc(send), to: selfMintTo, token: 'USDC', amount: send.toFixed(6), config: { retry },
    })
    return { txHash: hashOf(r), received: send }
  }
}

/** Full UB claim: deposit on source → wait for Gateway → spend to Arc. */
export async function runUbClaim(params: {
  kit: any; adapter: any; walletAddr: string; sdkChainId: string; chainLabel: string; amount: number; onStep: StepFn
}): Promise<void> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { kit, adapter, walletAddr, sdkChainId, chainLabel, amount, onStep } = params
  if (!UB_CLAIM_CHAINS.has(sdkChainId)) throw new Error(`${chainLabel} does not support Unified Balance`)
  const ran = await withChainLock(walletAddr, sdkChainId, () =>
    runUbClaimInner({ kit, adapter, walletAddr, sdkChainId, chainLabel, amount, onStep }))
  if (!ran) throw new Error(UB_CLAIM_BUSY_MESSAGE)
}

async function runUbClaimInner(params: {
  kit: any; adapter: any; walletAddr: string; sdkChainId: string; chainLabel: string; amount: number; onStep: StepFn
  detach?: boolean
}): Promise<void> {
  const { kit, adapter, walletAddr, sdkChainId, chainLabel, amount, onStep } = params

  const before = await confirmedOn(kit, walletAddr, sdkChainId).catch(() => 0)

  // Check the fee BEFORE anything moves. Moving USDC out of some chains'
  // Unified Balance costs more than a small amount (Ethereum: Circle charges
  // that chain's gas, ~$1+). Depositing first and finding out at the send
  // left the USDC stuck there. Without a live quote (that chain's Unified
  // Balance is often empty before the deposit) Circle's published fee for the
  // chain decides - a failed quote used to let the deposit go ahead.
  const fee = await estimateUbClaimFee({ kit, adapter, walletAddr, fromChain: sdkChainId, amount, dust: before })
  if (fee.receiveAtLeast <= 0) {
    throw new Error(`The fee to bring from ${chainLabel} (${fee.approx ? 'up to' : 'about'} ${fee.total.toFixed(2)} USDC) is more than ${amount} USDC - nothing was moved. Use CCTP, or bring a larger amount.`)
  }

  onStep('approving', `Moving ${amount} USDC into Unified Balance on ${chainLabel}…`, 25)
  const dep: any = await kit.unifiedBalance.deposit({
    from: { adapter, chain: sdkChainId }, amount: amount.toFixed(6), token: 'USDC', allowanceStrategy: 'permit',
  })
  const depositTx = hashOf(dep)
  // A reverted deposit moved nothing - don't record it as a claim.
  await assertDepositSucceeded(sdkChainId, depositTx)
  // From here the USDC is in the user's Unified Balance - never "failed".
  onStep('attesting', `Waiting for ${chainLabel} to finalize (${ubClaimEta(sdkChainId)})…`, 50, { txHash: depositTx })

  // Preferred path: sign the Arc spend now and hand it to MeshPort's server
  // (ub-claim-worker), which submits it once the deposit is final - so the
  // claim completes even if the phone is locked or the app is closed.
  let serverId: string | null = null
  try {
    serverId = (await registerServerClaim({ kit, adapter, walletAddr, sdkChainId, amount, depositTx, dust: before })).id
  } catch (e) {
    console.warn('[ubClaim] server hand-off failed - finishing on this device', e)
  }
  // Server path: the ub_claim_intents trigger already wrote the "Processing"
  // Activity row. Device path: write it here so the Hub shows it right away.
  if (!serverId && depositTx) {
    try {
      const { Activity } = await import('./ActivityService')
      await Activity.ubClaimPending({ walletAddress: walletAddr, sourceChain: SDK_TO_APP_CHAIN[sdkChainId] ?? sdkChainId, amount, depositTxHash: depositTx, merchant: isMerchantNow() })
    } catch { /* best effort */ }
  }
  if (serverId && params.detach) return
  if (serverId) {
    onStep('attesting', `Waiting for ${chainLabel} to finalize (${ubClaimEta(sdkChainId)}). MeshPort finishes this automatically - you can close the app.`, 50, { txHash: depositTx, handedOff: true })
    await followServerClaim(serverId, chainLabel, depositTx, onStep)
    return
  }

  let out: { txHash?: string; received: number }
  try {
    const started = Date.now()
    let available = 0
    while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
      available = await confirmedOn(kit, walletAddr, sdkChainId).catch(() => available)
      if (available - before >= amount * 0.999) break
      await new Promise(r => setTimeout(r, POLL_MS))
    }
    if (available - before < amount * 0.999) {
      throw new Error(`Your USDC is safe in your Unified Balance on ${chainLabel} but isn't confirmed yet. Finish it later from Multichain Hub → Recover.`)
    }

    onStep('minting', 'Sending to your Arc wallet…', 80, { txHash: depositTx })
    out = await spendUnifiedToArc({ kit, adapter, walletAddr, fromChain: sdkChainId, amount, dust: before })
    // History: "Claimed from <chain>" in Activity and the Hub (best effort -
    // the funds have already arrived either way).
    await recordUbClaim({ walletAddr, sdkChainId, received: out.received, claimedAmount: amount, depositTxHash: depositTx, arcTxHash: out.txHash })
  } catch (e: any) {
    // The USDC is in the Unified Balance but couldn't be sent on: say so on
    // its Activity row (held → Recover), instead of "Verifying" forever.
    if (depositTx) {
      try {
        const { Activity } = await import('./ActivityService')
        await Activity.ubClaimHeld({ walletAddress: walletAddr, depositTxHash: depositTx, claimedAmount: amount, reason: String(e?.message ?? e), merchant: isMerchantNow() })
      } catch { /* best effort */ }
    }
    throw e
  }
  onStep('done', `Received ${out.received.toFixed(2)} USDC on Arc`, 100, { txHash: depositTx, mintTxHash: out.txHash })
}

/**
 * Sends leftover Unified Balance dust from several chains to Arc in ONE
 * spend (one fee instead of one per chain). The fee is shared across the
 * chains in proportion to each chain's dust.
 */
export async function spendDustToArc(params: {
  kit: any; adapter: any; walletAddr: string; dust: Array<{ chain: string; amount: number }>
}): Promise<{ txHash?: string; received: number }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { kit, adapter, walletAddr } = params
  const dust = params.dust.filter(d => d.amount > 0.000001)
  const total = dust.reduce((s, d) => s + d.amount, 0)
  if (total <= 0) throw new Error('No leftover balance to claim')
  const to = { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true }
  const est: any = await kit.unifiedBalance.estimateSpend({
    from: { adapter, allocations: dust.map(d => ({ amount: d.amount.toFixed(6), chain: d.chain })) },
    to, token: 'USDC', amount: total.toFixed(6),
  })
  const fee = ubSpendCost(ubQuoteFees(est))
  const ratio = (total - fee - ubSpendMargin(fee)) / total
  if (ratio <= 0) throw new Error(`Leftover balance is too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)
  const allocations = dust
    .map(d => ({ chain: d.chain, amount: Math.floor(d.amount * ratio * 1e6) / 1e6 }))
    .filter(a => a.amount > 0)
  const send = allocations.reduce((s, a) => s + a.amount, 0)
  const r: any = await kit.unifiedBalance.spend({
    from: { adapter, allocations: allocations.map(a => ({ amount: a.amount.toFixed(6), chain: a.chain })) },
    to, token: 'USDC', amount: send.toFixed(6),
  })
  return { txHash: hashOf(r), received: send }
}

// ── Server hand-off ─────────────────────────────────────────────────────────

// CONCURRENCY FIX: signSpendToArc and signSpendAllToArc both temporarily
// monkey-patch globalThis.fetch to intercept the App Kit transfer call
// before it is submitted. If two of these run concurrently (e.g. a merchant's
// Claim All at the same time as a manual claim from another tab), the two
// patched functions race on globalThis.fetch:
//
//   Tab A patches: globalThis.fetch = patchA  (saves realA = original)
//   Tab B patches: globalThis.fetch = patchB  (saves realB = patchA, NOT original)
//   Tab A restores: globalThis.fetch = realA  (original - correct)
//   Tab B restores: globalThis.fetch = realB  (patchA - Tab A's stale patch)
//
// After that, every future fetch goes through Tab A's stale intercept: all
// subsequent /v1/transfer calls (real spend/claim calls) are swallowed and
// returned a fake 400, silently failing every Gateway operation.
//
// Fix: serialise all fetch-patch sections behind a single Web Lock
// (cross-tab, cross-worker, cross-document) and a same-tab boolean guard.
// Any concurrent call that cannot acquire the lock immediately returns an
// error - it never patches fetch, and the caller gets a clear error message
// rather than a silent failure or a corrupted fetch state.
let _fetchPatchActive = false

async function withFetchPatch<T>(fn: (realFetch: typeof fetch) => Promise<T>): Promise<T> {
  // Same-tab guard: prevents two sign calls within the same JS context from
  // patching simultaneously even before the Web Lock check runs.
  if (_fetchPatchActive) throw new Error('A transfer is already being prepared - please wait a moment and try again')

  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined
  if (locks?.request) {
    // Cross-tab lock: any other tab holding this lock must release it first.
    // { ifAvailable: true } returns immediately with lock=null if busy, so
    // we never stall - we fail fast and let the caller retry instead.
    return locks.request('meshport-fetch-patch', { ifAvailable: true }, async (lock: unknown) => {
      if (!lock) throw new Error('A transfer is already being prepared in another tab - please wait a moment and try again')
      return _runWithFetchPatch(fn)
    })
  }
  // Web Locks not available (non-browser / old browser): fall back to the
  // same-tab boolean guard only. Cross-tab safety degrades but same-tab
  // concurrent calls are still protected.
  return _runWithFetchPatch(fn)
}

async function _runWithFetchPatch<T>(fn: (realFetch: typeof fetch) => Promise<T>): Promise<T> {
  _fetchPatchActive = true
  const realFetch = globalThis.fetch
  try {
    return await fn(realFetch)
  } finally {
    // Always restore, even if fn threw, even if fn itself already restored
    // (idempotent: restoring the same reference twice is harmless).
    globalThis.fetch = realFetch
    _fetchPatchActive = false
  }
}

/**
 * Builds and signs the Gateway burn intent for "Unified Balance on
 * `fromChain` → user's own Arc wallet" WITHOUT submitting it: App Kit's
 * spend() is run with its final POST /v1/transfer intercepted, so we get the
 * exact signed body App Kit would have sent. The server submits it later.
 */
export async function signSpendToArc(params: {
  kit: any; adapter: any; walletAddr: string; fromChain: string; amount: number; dust?: number
}): Promise<{ body: any; send: number }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { kit, adapter, walletAddr, fromChain, amount } = params
  const base = {
    from: { adapter, allocations: [{ amount: amount.toFixed(6), chain: fromChain }] },
    to: { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true },
    token: 'USDC',
  }
  const est: any = await kit.unifiedBalance.estimateSpend({ ...base, amount: amount.toFixed(6) })
  const fee = ubSpendCost(ubQuoteFees(est))
  // Leftover dust goes along to the user's own wallet (see claimDust).
  const send = Math.max(0, amount + claimDust(params.dust) - fee - ubSpendMargin(fee))
  if (send <= 0) throw new Error(`Amount too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)

  const captured = await withFetchPatch(async (realFetch) => {
    let cap: any = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!cap && /\/v1\/transfer(\?|$)/.test(url) && (init?.method ?? 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
        cap = JSON.parse(init.body)
        // 4xx → App Kit stops without retrying; nothing is submitted.
        return new Response(JSON.stringify({ success: false, message: 'captured for server submission' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(input as any, init)
    }) as typeof fetch
    try {
      await kit.unifiedBalance.spend({
        ...base,
        amount: send.toFixed(6),
        from: { adapter, allocations: [{ amount: send.toFixed(6), chain: fromChain }] },
      })
    } catch { /* expected - the transfer call was intercepted */ }
    return cap
  })

  if (!Array.isArray(captured) || captured.length === 0) throw new Error('Could not prepare the Arc transfer')

  // Sanity: the main intent must mint to this wallet on Arc (domain 26).
  const intents = captured.flatMap((e: any) => e?.burnIntent ? [e.burnIntent] : (e?.burnIntentSet?.intents ?? []))
  const me = walletAddr.toLowerCase().replace(/^0x/, '')
  const ok = intents.some((i: any) => Number(i?.spec?.destinationDomain) === 26 && String(i?.spec?.destinationRecipient ?? '').toLowerCase().endsWith(me))
  if (!ok) throw new Error('Prepared transfer does not target your Arc wallet')
  return { body: captured, send }
}

/**
 * Signs ONE Unified Balance → Arc transfer drawn from several chains
 * at once, without submitting it (same capture as signSpendToArc). The fee is
 * shared across the chains in proportion to each chain's amount.
 */
export async function signSpendAllToArc(params: {
  kit: any; adapter: any; walletAddr: string; parts: Array<{ chain: string; amount: number }>
}): Promise<{ body: any; send: number; allocations: Array<{ chain: string; amount: number }> }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { kit, adapter, walletAddr } = params
  const parts = params.parts.filter(p => p.amount > 0.000001)
  const total = parts.reduce((s, p) => s + p.amount, 0)
  if (total <= 0) throw new Error('Nothing to move')
  const to = { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true }
  const est: any = await kit.unifiedBalance.estimateSpend({
    from: { adapter, allocations: parts.map(p => ({ amount: p.amount.toFixed(6), chain: p.chain })) },
    to, token: 'USDC', amount: total.toFixed(6),
  })
  const fee = ubSpendCost(ubQuoteFees(est))
  const ratio = (total - fee - ubSpendMargin(fee)) / total
  if (ratio <= 0) throw new Error(`Too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)
  const allocations = parts
    .map(p => ({ chain: p.chain, amount: Math.floor(p.amount * ratio * 1e6) / 1e6 }))
    .filter(a => a.amount > 0)
  const send = allocations.reduce((s, a) => s + a.amount, 0)

  const captured = await withFetchPatch(async (realFetch) => {
    let cap: any = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!cap && /\/v1\/transfer(\?|$)/.test(url) && (init?.method ?? 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
        cap = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: false, message: 'captured for server submission' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(input as any, init)
    }) as typeof fetch
    try {
      await kit.unifiedBalance.spend({
        from: { adapter, allocations: allocations.map(a => ({ amount: a.amount.toFixed(6), chain: a.chain })) },
        to, token: 'USDC', amount: send.toFixed(6),
      })
    } catch { /* expected - the transfer call was intercepted */ }
    return cap
  })
  if (!Array.isArray(captured) || captured.length === 0) throw new Error('Could not prepare the Arc transfer')
  const intents = captured.flatMap((e: any) => e?.burnIntent ? [e.burnIntent] : (e?.burnIntentSet?.intents ?? []))
  const me = walletAddr.toLowerCase().replace(/^0x/, '')
  if (!intents.length || !intents.every((i: any) => Number(i?.spec?.destinationDomain) === 26 && String(i?.spec?.destinationRecipient ?? '').toLowerCase().endsWith(me))) {
    throw new Error('Prepared transfer does not target your Arc wallet')
  }
  return { body: captured, send, allocations }
}

async function registerServerClaim(p: {
  kit: any; adapter: any; walletAddr: string; sdkChainId: string; amount: number; depositTx?: string; dust?: number
}): Promise<{ id: string | null; send: number }> {
  const { body, send } = await signSpendToArc({ kit: p.kit, adapter: p.adapter, walletAddr: p.walletAddr, fromChain: p.sdkChainId, amount: p.amount, dust: p.dust })
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase.from('ub_claim_intents').insert({
    wallet_address: p.walletAddr.toLowerCase(),
    source_chain:   p.sdkChainId,
    // Approved merchants: shown as "Payment received" (the DB re-checks approval).
    merchant:       isMerchantNow(),
    amount:         p.amount,
    send_amount:    Number(send.toFixed(6)),
    deposit_tx:     p.depositTx?.toLowerCase() ?? null,
    transfer_body:  body,
  }).select('id').single()
  if (error) throw error
  return { id: (data as any)?.id ?? null, send }
}

/**
 * Sends a chain's held Unified Balance (a claim that didn't finish) to the
 * user's own Arc wallet through MeshPort's server, the same hand-off a Bring
 * uses: the server submits it and its trigger completes the claim's Activity
 * row (keyed by that claim's deposit tx), so it finishes even if the app is
 * closed straight after. Falls back to sending from this device.
 */
export async function finishHeldUbToArc(p: {
  kit: any; adapter: any; walletAddr: string; chain: string; amount: number
}): Promise<{ serverId: string | null; received: number; txHash?: string }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  const { Activity } = await import('./ActivityService')
  const depositTx = await Activity.pendingUbClaimTx({ walletAddress: p.walletAddr, sourceChain: SDK_TO_APP_CHAIN[p.chain] ?? p.chain })
  try {
    const { id, send } = await registerServerClaim({ kit: p.kit, adapter: p.adapter, walletAddr: p.walletAddr, sdkChainId: p.chain, amount: p.amount, depositTx })
    if (id) return { serverId: id, received: send }
  } catch (e) {
    console.warn('[ubClaim] server hand-off for held funds failed - sending from this device', e)
  }
  const out = await spendUnifiedToArc({ kit: p.kit, adapter: p.adapter, walletAddr: p.walletAddr, fromChain: p.chain, amount: p.amount })
  await recordUbClaim({ walletAddr: p.walletAddr, sdkChainId: p.chain, received: out.received, claimedAmount: p.amount, depositTxHash: depositTx, arcTxHash: out.txHash, recovered: !depositTx })
  return { serverId: null, ...out }
}

/** Mirrors the server row into the claim screen's progress. */
async function followServerClaim(id: string, chainLabel: string, depositTx: string | undefined, onStep: StepFn): Promise<void> {
  const { supabase } = await import('./supabase')
  const started = Date.now()
  let shownMinting = false
  while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, shownMinting ? POLL_MINTING_MS : POLL_SERVER_MS))
    const { data } = await supabase.from('ub_claim_intents').select('status, send_amount, mint_tx, last_error').eq('id', id).maybeSingle()
    const row: any = data
    if (!row) continue
    if (row.status === 'submitted' && !shownMinting) {
      shownMinting = true
      onStep('minting', 'Sending to your Arc wallet…', 80, { txHash: depositTx })
    }
    if (row.status === 'completed') {
      onStep('done', `Received ${Number(row.send_amount ?? 0).toFixed(2)} USDC on Arc`, 100, { txHash: depositTx, mintTxHash: row.mint_tx ?? undefined })
      return
    }
    if (row.status === 'failed' || row.status === 'expired') {
      throw new Error(`Your USDC is safe in your Unified Balance on ${chainLabel}. MeshPort will send it to Arc next time the app is open, or finish it from Multichain Hub → Recover.`)
    }
  }
  // Still running on the server - it will arrive by itself.
}

/** Chains with a claim the server is still finishing (auto-finish leaves them alone). */
async function serverOwnedChains(walletAddr: string): Promise<Set<string>> {
  try {
    const { supabase } = await import('./supabase')
    const { data } = await supabase.from('ub_claim_intents').select('source_chain, source_chains')
      .eq('wallet_address', walletAddr.toLowerCase()).in('status', ['waiting', 'submitted'])
    return new Set((data ?? []).flatMap((r: any) => [String(r.source_chain), ...(Array.isArray(r.source_chains) ? r.source_chains.map(String) : [])]))
  } catch { return new Set() }
}

// SDK chain id → MeshPort chain key used in Activity / chain labels.
const SDK_TO_APP_CHAIN: Record<string, string> = { Polygon_Amoy_Testnet: 'Polygon_Sepolia' }

/** Writes the Activity row for a UB claim (direct, or recovered from Recover). */
export async function recordUbClaim(p: {
  walletAddr: string; sdkChainId: string; received: number; claimedAmount: number
  depositTxHash?: string; arcTxHash?: string; recovered?: boolean
}): Promise<void> {
  try {
    const { Activity } = await import('./ActivityService')
    await Activity.ubClaim({
      walletAddress: p.walletAddr, sourceChain: SDK_TO_APP_CHAIN[p.sdkChainId] ?? p.sdkChainId,
      received: p.received, claimedAmount: p.claimedAmount,
      depositTxHash: p.depositTxHash, arcTxHash: p.arcTxHash, recovered: p.recovered,
      merchant: isMerchantNow(),
    })
  } catch (e) {
    console.warn('[ubClaim] activity write failed', e)
  }
}

// ── Merchant Claim All ────────────────────────────────────────────────────
// Approved merchants: customer payments on other chains stay there until the
// merchant taps Claim All (Business → Manage money → Chains). Nothing moves by itself.
// Claim All is offered once every 6 hours - single chains can still be
// claimed any time from the chain list.
// Merchants use CCTP only (no Unified Balance): one gasless claim per chain
// through MeshPort's bridge router - the relayer (api/bridge-relay) pays the
// source-chain gas and MeshPort's fee is taken in the same transaction,
// exactly like anyone's CCTP claim. The claim worker then mints on Arc.
export const CLAIM_ALL_COOLDOWN_MS = 6 * 60 * 60_000
export const CLAIM_ALL_MIN_CHAIN = 1
const claimAllKey = (addr: string) => `meshport_claim_all_${addr.toLowerCase()}`

/** When this merchant last ran a Claim All that moved money (this device). */
export async function lastClaimAllAt(walletAddress: string): Promise<number> {
  try { return Number(localStorage.getItem(claimAllKey(walletAddress)) || 0) || 0 } catch { return 0 }
}

/** One chain's progress in Claim All; `claimId` (once sent) opens its Track Progress. */
export type ClaimAllStep = { chainId: string; state: 'working' | 'done' | 'error'; msg: string; claimId?: string }
let claimingAll = false

export async function merchantClaimAll(p: {
  walletAddress: string; signer: WalletAccount
  /** App chain ids with their wallet balance. */
  chains: Array<{ chainId: string; balance: number }>
  onStep?: (s: ClaimAllStep) => void
}): Promise<{ cctp: number; failed: string[] }> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  if (claimingAll) throw new Error('Claim All is already running')
  claimingAll = true
  const step = (chainId: string, state: ClaimAllStep['state'], msg: string, claimId?: string) => p.onStep?.({ chainId, state, msg, claimId })
  const out = { cctp: 0, failed: [] as string[] }
  try {
    const [{ isGaslessBridgeAvailable, bringFundsGasless }, { submitClaim }] = await Promise.all([
      import('./gaslessBridge'), import('./claimService'),
    ])
    const due = p.chains.filter(c => c.balance >= CLAIM_ALL_MIN_CHAIN && isGaslessBridgeAvailable(c.chainId))
    for (const c of due) {
      const amount = Math.floor(c.balance * 1e6) / 1e6
      step(c.chainId, 'working', 'Signing…')
      try {
        const r = await bringFundsGasless({
          chainId: c.chainId, amountUsdc: amount, signer: p.signer, walletAddress: p.walletAddress,
          onStatus: msg => step(c.chainId, 'working', msg === 'Submitting…' || msg === 'Confirming…' ? 'MeshPort is sending the transfer…' : msg),
        })
        // The claim is the burned amount: MeshPort's fee was taken before the burn.
        const claim = await submitClaim({ walletAddress: p.walletAddress, sourceChain: c.chainId, amount: Math.max(0, amount - r.fee), txHash: r.txHash, meshportFee: r.fee })
        out.cctp += amount
        step(c.chainId, 'done', 'On its way to Arc · a few minutes', claim.claimId)
      } catch (e) {
        out.failed.push(c.chainId)
        step(c.chainId, 'error', (e instanceof Error ? e.message : 'Claim failed').slice(0, 90))
      }
    }
    // The 6-hour wait starts only when something actually moved.
    if (out.cctp > 0) {
      try { localStorage.setItem(claimAllKey(p.walletAddress), String(Date.now())) } catch { /* storage off */ }
    }
    return out
  } finally {
    claimingAll = false
  }
}

/** @deprecated Merchants collect with Claim All (merchantClaimAll). */
export async function autoCollectMerchantPayments(_p: { walletAddress: string; signer: WalletAccount; makeAdapter: () => Promise<any> }): Promise<number> {
  return 0
}

// ── Auto-finish ───────────────────────────────────────────────────────────
// Fallback for deposits the server isn't finishing (older claims, a failed
// hand-off, a Gateway error): whenever the app is open and unlocked, sweep
// any CONFIRMED Unified Balance on other chains into the Arc wallet. Chains
// with an open ub_claim_intents row are skipped - the server owns those.
//
// CROSS-TAB DEDUP FIX: the old approach used a module-level `sweeping`
// boolean, which only guards the same JS context. Two browser tabs open at
// the same time both had sweeping=false, so they both entered the sweep,
// both called spendUnifiedToArc for the same chain at the same time, and
// one of those spends reverted on-chain (the USDC was already spent by the
// other tab's call). The failed spend produced a confusing "transfer
// reverted" activity row with no explanation. Using a per-wallet Web Lock
// (exclusive, non-blocking) means only one tab can sweep a given wallet at
// a time across the entire browser session.
// Auto-finish moves held funds by itself only when Circle's fee is at most
// this share of them; anything costlier waits in Recover for the person.
export const UB_AUTO_FINISH_MAX_FEE_SHARE = 0.05

/** Auto-finish may move `amount` only for a live quote whose fee is a small share of it. */
export function autoFinishWorthIt(fee: { total: number; approx?: boolean; receiveAtLeast: number }, amount: number): boolean {
  return !fee.approx && fee.receiveAtLeast > 0 && fee.total <= amount * UB_AUTO_FINISH_MAX_FEE_SHARE
}

let _sweepingSameTab = false

export async function autoFinishUbClaims(p: { walletAddress: string; signer: WalletAccount }): Promise<number> {
  if (isAccountLockedNow()) return 0 // business not approved yet
  if (_sweepingSameTab) return 0
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined
  const lockName = `meshport-ub-autosweep:${p.walletAddress.toLowerCase()}`
  if (locks?.request) {
    return locks.request(lockName, { ifAvailable: true }, async (lock: unknown) => {
      if (!lock) return 0 // another tab holds the sweep lock for this wallet
      return _runAutoFinish(p)
    })
  }
  // Web Locks not available: fall back to same-tab boolean guard only.
  return _runAutoFinish(p)
}

async function _runAutoFinish(p: { walletAddress: string; signer: WalletAccount }): Promise<number> {
  _sweepingSameTab = true
  let finished = 0
  try {
    const [{ AppKit }, { createWalletAdapter }] = await Promise.all([
      import('@circle-fin/app-kit'), import('@/wallet'),
    ])
    const kit = new AppKit({ disableErrorReporting: true } as any)
    const rows = await getUnifiedBalances(kit, p.walletAddress)
    const serverOwned = await serverOwnedChains(p.walletAddress)
    const ready = rows.filter(r => r.chain !== ARC_CHAIN_KEY && r.confirmed >= UB_MIN_SWEEP && !inFlight.has(r.chain) && !serverOwned.has(r.chain))
    if (ready.length === 0) return 0
    const adapter = await createWalletAdapter({ account: p.signer })
    for (const r of ready) {
      if (inFlight.has(r.chain)) continue
      // Per-chain Web Lock mirrors what withChainLock does for manual claims -
      // same guard, same lock namespace, so a manual claim and an auto-sweep
      // for the same chain never race.
      const ran = await withChainLock(p.walletAddress, r.chain, async () => {
        // Only when Circle's fee is small next to the amount. Moving a held
        // $1 out of Ethereum's Unified Balance took ~$0.60 of it without
        // asking; a balance like that stays in Recover, where the person
        // sees the fee and can pick the 7-day withdrawal instead.
        const fee = await estimateUbClaimFee({ kit, adapter, walletAddr: p.walletAddress, fromChain: r.chain, amount: r.confirmed })
        if (!autoFinishWorthIt(fee, r.confirmed)) {
          console.info(`[ubClaim] auto-finish: leaving ${r.confirmed} USDC on ${r.chain} for Recover - Circle's fee ${fee.total.toFixed(4)} is too large a share`)
          return
        }
        await finishHeldUbToArc({ kit, adapter, walletAddr: p.walletAddress, chain: r.chain, amount: r.confirmed })
        finished++
      })
      if (!ran) console.warn('[ubClaim] auto-finish: chain lock busy for', r.chain, '- skipping this chain this sweep')
    }
  } catch (e) {
    console.warn('[ubClaim] auto-finish check failed', e)
  } finally {
    _sweepingSameTab = false
  }
  return finished
}
