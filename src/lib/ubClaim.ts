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
import { realTxHash } from './relayedProvider'
import { UB_CLAIM_CHAINS } from './ubChains'
import { FORWARDER_MINT_FAILING_SDK_CHAINS, forwarderMintFailing, noteForwarderMintFailed } from '@/blockchain/chains'
export { UB_CLAIM_CHAINS }

import { isMerchantNow } from './merchant'

const FAST_FINALITY = new Set(['Avalanche_Fuji', 'Polygon_Amoy_Testnet', 'Sonic_Testnet', 'Sei_Testnet', 'HyperEVM_Testnet'])

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
// Below this, a chain's Unified Balance is leftover fee dust. Dust is never
// shown or swept - it stays in the Unified Balance as the safety margin for
// the next spend from that chain (see spendMargin below).
export const UB_MIN_SWEEP = 0.5
// Kept for older imports; dust is no longer offered back to the user.
export const UB_DUST_CLAIM_MIN = Number.POSITIVE_INFINITY

const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000
// The source chain's finality takes minutes - checked every 10s. Once the
// server is sending it to Arc (seconds away) the screen checks every 2s.
const POLL_MS = 10_000
const POLL_MINTING_MS = 2_000
const SPEND_MARGIN = 0.005 // USDC headroom so fee drift never fails the spend

/**
 * Headroom to leave on top of the fee. Dust already sitting in the chain's
 * Unified Balance (from earlier claims) covers fee drift instead, so the user
 * receives the full `amount − fee` whenever there's enough of it.
 */
function spendMargin(cushion = 0): number {
  return Math.max(0, SPEND_MARGIN - Math.max(0, cushion))
}

type Stage = 'approving' | 'attesting' | 'minting' | 'done' | 'error'
type StepFn = (stage: Stage, msg: string, pct: number, extra?: { txHash?: string; mintTxHash?: string }) => void

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

/** Spend a chain's confirmed Unified Balance to the user's own Arc wallet. */
export async function spendUnifiedToArc(params: {
  kit: any; adapter: any; walletAddr: string; fromChain: string; amount: number; cushion?: number
}): Promise<{ txHash?: string; received: number }> {
  return spendUnifiedTo({ ...params, toChain: ARC_CHAIN_KEY, recipient: params.walletAddr })
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
}): Promise<{ txHash?: string; received: number }> {
  const { kit, adapter, fromChain, amount, toChain, recipient } = params
  const destAdapter = params.destAdapter ?? adapter
  const forwarderTo = { chain: toChain, recipientAddress: recipient, useForwarder: true }
  const selfMintTo = { chain: toChain, recipientAddress: recipient, adapter: destAdapter, useForwarder: false }
  const alloc = (a: number) => ({ adapter, allocations: [{ amount: a.toFixed(6), chain: fromChain }] })

  // Fees come out of the Unified Balance, so send amount − fee. (The
  // forwarder quote is the higher of the two, so it's safe for self-mint too.)
  const est: any = await kit.unifiedBalance.estimateSpend({ from: alloc(amount), to: forwarderTo, token: 'USDC', amount: amount.toFixed(6) })
  const fee = (est?.fees ?? []).reduce((s: number, f: any) => s + (f?.token === 'USDC' ? Number(f.amount ?? 0) : 0), 0)
    || Number(est?.total ?? 0)
  const send = Math.max(0, amount - fee - spendMargin(params.cushion))
  if (send <= 0) throw new Error(`Amount too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)

  const selfMint = toChain !== ARC_CHAIN_KEY && gatewaySelfMintsTo(toChain)
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
    serverId = await registerServerClaim({ kit, adapter, walletAddr, sdkChainId, amount, depositTx, cushion: before })
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
    onStep('attesting', `Waiting for ${chainLabel} to finalize (${ubClaimEta(sdkChainId)}). MeshPort finishes this automatically - you can close the app.`, 50, { txHash: depositTx })
    await followServerClaim(serverId, chainLabel, depositTx, onStep)
    return
  }

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
  const out = await spendUnifiedToArc({ kit, adapter, walletAddr, fromChain: sdkChainId, amount, cushion: before })
  // History: "Claimed from <chain>" in Activity and the Hub (best effort -
  // the funds have already arrived either way).
  await recordUbClaim({ walletAddr, sdkChainId, received: out.received, claimedAmount: amount, depositTxHash: depositTx, arcTxHash: out.txHash })
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
  const { kit, adapter, walletAddr } = params
  const dust = params.dust.filter(d => d.amount > 0.000001)
  const total = dust.reduce((s, d) => s + d.amount, 0)
  if (total <= 0) throw new Error('No leftover balance to claim')
  const to = { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true }
  const est: any = await kit.unifiedBalance.estimateSpend({
    from: { adapter, allocations: dust.map(d => ({ amount: d.amount.toFixed(6), chain: d.chain })) },
    to, token: 'USDC', amount: total.toFixed(6),
  })
  const fee = (est?.fees ?? []).reduce((s: number, f: any) => s + (f?.token === 'USDC' ? Number(f.amount ?? 0) : 0), 0)
    || Number(est?.total ?? 0)
  const ratio = (total - fee - SPEND_MARGIN * dust.length) / total
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
  kit: any; adapter: any; walletAddr: string; fromChain: string; amount: number; cushion?: number
}): Promise<{ body: any; send: number }> {
  const { kit, adapter, walletAddr, fromChain, amount } = params
  const base = {
    from: { adapter, allocations: [{ amount: amount.toFixed(6), chain: fromChain }] },
    to: { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true },
    token: 'USDC',
  }
  const est: any = await kit.unifiedBalance.estimateSpend({ ...base, amount: amount.toFixed(6) })
  const fee = (est?.fees ?? []).reduce((s: number, f: any) => s + (f?.token === 'USDC' ? Number(f.amount ?? 0) : 0), 0)
    || Number(est?.total ?? 0)
  const send = Math.max(0, amount - fee - spendMargin(params.cushion))
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
 * Signs ONE Ledger (Unified Balance) → Arc transfer drawn from several chains
 * at once, without submitting it (same capture as signSpendToArc). The fee is
 * shared across the chains in proportion to each chain's amount.
 */
export async function signSpendAllToArc(params: {
  kit: any; adapter: any; walletAddr: string; parts: Array<{ chain: string; amount: number }>
}): Promise<{ body: any; send: number; allocations: Array<{ chain: string; amount: number }> }> {
  const { kit, adapter, walletAddr } = params
  const parts = params.parts.filter(p => p.amount > 0.000001)
  const total = parts.reduce((s, p) => s + p.amount, 0)
  if (total <= 0) throw new Error('Nothing to move')
  const to = { chain: ARC_CHAIN_KEY, recipientAddress: walletAddr, useForwarder: true }
  const est: any = await kit.unifiedBalance.estimateSpend({
    from: { adapter, allocations: parts.map(p => ({ amount: p.amount.toFixed(6), chain: p.chain })) },
    to, token: 'USDC', amount: total.toFixed(6),
  })
  const fee = (est?.fees ?? []).reduce((s: number, f: any) => s + (f?.token === 'USDC' ? Number(f.amount ?? 0) : 0), 0)
    || Number(est?.total ?? 0)
  const ratio = (total - fee - SPEND_MARGIN * parts.length) / total
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
  kit: any; adapter: any; walletAddr: string; sdkChainId: string; amount: number; depositTx?: string; cushion?: number
}): Promise<string | null> {
  const { body, send } = await signSpendToArc({ kit: p.kit, adapter: p.adapter, walletAddr: p.walletAddr, fromChain: p.sdkChainId, amount: p.amount, cushion: p.cushion })
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
  return (data as any)?.id ?? null
}

/** Mirrors the server row into the claim screen's progress. */
async function followServerClaim(id: string, chainLabel: string, depositTx: string | undefined, onStep: StepFn): Promise<void> {
  const { supabase } = await import('./supabase')
  const started = Date.now()
  let shownMinting = false
  while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, shownMinting ? POLL_MINTING_MS : POLL_MS))
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
// merchant taps Claim All (Hub → Ledger → Chains). Nothing moves by itself.
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

export type ClaimAllStep = { chainId: string; state: 'working' | 'done' | 'error'; msg: string }
let claimingAll = false

export async function merchantClaimAll(p: {
  walletAddress: string; privateKey: string
  /** App chain ids with their wallet balance. */
  chains: Array<{ chainId: string; balance: number }>
  onStep?: (s: ClaimAllStep) => void
}): Promise<{ cctp: number; failed: string[] }> {
  if (claimingAll) throw new Error('Claim All is already running')
  claimingAll = true
  const step = (chainId: string, state: ClaimAllStep['state'], msg: string) => p.onStep?.({ chainId, state, msg })
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
          chainId: c.chainId, amountUsdc: amount, privateKey: p.privateKey, walletAddress: p.walletAddress,
          onStatus: msg => step(c.chainId, 'working', msg === 'Submitting…' || msg === 'Confirming…' ? 'MeshPort is sending the transfer…' : msg),
        })
        // The claim is the burned amount: MeshPort's fee was taken before the burn.
        await submitClaim({ walletAddress: p.walletAddress, sourceChain: c.chainId, amount: Math.max(0, amount - r.fee), txHash: r.txHash })
        out.cctp += amount
        step(c.chainId, 'done', 'On its way to Arc · a few minutes')
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
export async function autoCollectMerchantPayments(_p: { walletAddress: string; privateKey: string; makeAdapter: () => Promise<any> }): Promise<number> {
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
let _sweepingSameTab = false

export async function autoFinishUbClaims(p: { walletAddress: string; privateKey: string }): Promise<number> {
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

async function _runAutoFinish(p: { walletAddress: string; privateKey: string }): Promise<number> {
  _sweepingSameTab = true
  let finished = 0
  try {
    const [{ AppKit }, { createEthersAdapterFromPrivateKey }] = await Promise.all([
      import('@circle-fin/app-kit'), import('@circle-fin/adapter-ethers-v6'),
    ])
    const kit = new AppKit({ disableErrorReporting: true } as any)
    const rows = await getUnifiedBalances(kit, p.walletAddress)
    const serverOwned = await serverOwnedChains(p.walletAddress)
    const ready = rows.filter(r => r.chain !== ARC_CHAIN_KEY && r.confirmed >= UB_MIN_SWEEP && !inFlight.has(r.chain) && !serverOwned.has(r.chain))
    if (ready.length === 0) return 0
    const adapter = (createEthersAdapterFromPrivateKey as any)({ privateKey: p.privateKey })
    for (const r of ready) {
      if (inFlight.has(r.chain)) continue
      // Per-chain Web Lock mirrors what withChainLock does for manual claims -
      // same guard, same lock namespace, so a manual claim and an auto-sweep
      // for the same chain never race.
      const ran = await withChainLock(p.walletAddress, r.chain, async () => {
        const out = await spendUnifiedToArc({ kit, adapter, walletAddr: p.walletAddress, fromChain: r.chain, amount: r.confirmed })
        await recordUbClaim({ walletAddr: p.walletAddress, sdkChainId: r.chain, received: out.received, claimedAmount: r.confirmed, arcTxHash: out.txHash })
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
