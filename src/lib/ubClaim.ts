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
// If the page is closed while waiting, nothing is lost — the USDC sits in
// the user's own Unified Balance and `spendUnifiedToArc` (Recovery panel)
// finishes it later.

// SDK chain ids that support Unified Balance deposits — see ubChains.ts.
import { UB_CLAIM_CHAINS } from './ubChains'
export { UB_CLAIM_CHAINS }

import { isMerchantNow } from './merchant'

const FAST_FINALITY = new Set(['Avalanche_Fuji', 'Polygon_Amoy_Testnet', 'Sonic_Testnet', 'Sei_Testnet', 'HyperEVM_Testnet'])

export function ubClaimEta(sdkChainId: string): string {
  return FAST_FINALITY.has(sdkChainId) ? 'under a minute' : 'up to 15 minutes'
}

// Chains whose claim is being driven right now by runUbClaim on this device —
// the background auto-finish leaves those alone so the two never race.
const inFlight = new Set<string>()

/**
 * One collect/claim per wallet + chain at a time — across the manual claim,
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

export const UB_CLAIM_BUSY_MESSAGE = 'A payment from this chain is already being collected — it will finish on its own. Check Activity in a minute.'

/** Throws when the deposit transaction reverted on-chain (nothing moved). */
async function assertDepositSucceeded(sdkChainId: string, txHash: string | undefined): Promise<void> {
  if (!txHash) return
  let receipt: any = null
  try {
    const { getClient } = await import('@/blockchain/ProviderManager')
    const appChain = SDK_TO_APP_CHAIN[sdkChainId] ?? sdkChainId
    receipt = await getClient(appChain).waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 120_000 })
  } catch (e) {
    // Couldn't read it (RPC trouble / slow chain) — carry on as before.
    console.warn('[ubClaim] could not read deposit receipt', e)
    return
  }
  if (receipt?.status === 'reverted') {
    throw new Error('The deposit failed on-chain — nothing was moved. If another collection was running, it has already taken this payment.')
  }
}
// Below this, a chain's Unified Balance is leftover fee dust. Dust is never
// shown or swept — it stays in the Unified Balance as the safety margin for
// the next spend from that chain (see spendMargin below).
export const UB_MIN_SWEEP = 0.5
// Kept for older imports; dust is no longer offered back to the user.
export const UB_DUST_CLAIM_MIN = Number.POSITIVE_INFINITY

const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000
const POLL_MS = 10_000
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
  return r?.txHash ?? r?.transactionHash ?? r?.hash ?? r?.result?.txHash ?? undefined
}

/** Confirmed Unified Balance per chain for this wallet. */
export async function getUnifiedBalances(kit: any, walletAddr: string): Promise<Array<{ chain: string; confirmed: number; pending: number }>> {
  const res: any = await kit.unifiedBalance.getBalances({
    token: 'USDC', sources: { address: walletAddr }, includePending: true,
    // An address-only source can't tell the network, and App Kit then
    // defaults to MAINNET — which reported 0 for every testnet deposit, so
    // claims never saw their deposit confirm and Recover never listed it.
    networkType: 'testnet',
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
  return spendUnifiedTo({ ...params, toChain: 'Arc_Testnet', recipient: params.walletAddr })
}

// Destinations where Circle's Gateway forwarder mint has been failing
// on-chain ("Forwarder transfer failed: ON_CHAIN_FAILURE") — mint these
// ourselves instead of waiting for the forwarder to fail first.
export const GATEWAY_SELF_MINT_CHAINS = new Set(['Sei_Testnet'])

/** Tops up the signer's native gas on `chain` (MeshPort relay) so it can submit the destination mint. */
export async function fundDestinationGas(chain: string, signerAddress: string): Promise<void> {
  try {
    await fetch('/api/relay-gas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: chain, userAddress: signerAddress }),
    })
  } catch (e) {
    console.warn('[ubClaim] relay-gas top-up failed, trying the mint anyway', e)
  }
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
 * mint fails on-chain — or the destination is in GATEWAY_SELF_MINT_CHAINS —
 * the mint is submitted by the user's own wallet on the destination
 * (`destAdapter`, gas topped up by MeshPort's relay). The recipient never
 * changes; only who pays for and submits the mint.
 */
export async function spendUnifiedTo(params: {
  kit: any; adapter: any; fromChain: string; amount: number; toChain: string; recipient: string
  destAdapter?: any; signerAddress?: string
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

  const selfMint = toChain !== 'Arc_Testnet' && GATEWAY_SELF_MINT_CHAINS.has(toChain)
  if (selfMint) {
    if (params.signerAddress) await fundDestinationGas(toChain, params.signerAddress)
    const r: any = await kit.unifiedBalance.spend({ from: alloc(send), to: selfMintTo, token: 'USDC', amount: send.toFixed(6) })
    return { txHash: hashOf(r), received: send }
  }
  try {
    const r: any = await kit.unifiedBalance.spend({ from: alloc(send), to: forwarderTo, token: 'USDC', amount: send.toFixed(6) })
    return { txHash: hashOf(r), received: send }
  } catch (err) {
    // Forwarder mint failed on-chain: the attestation is still valid —
    // mint it ourselves on the destination (same recipient).
    const retry = forwarderMintRetry(err)
    if (!retry) throw err
    if (params.signerAddress && toChain !== 'Arc_Testnet') await fundDestinationGas(toChain, params.signerAddress)
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
  // A reverted deposit moved nothing — don't record it as a claim.
  await assertDepositSucceeded(sdkChainId, depositTx)
  // From here the USDC is in the user's Unified Balance — never "failed".
  onStep('attesting', `Waiting for ${chainLabel} to finalize (${ubClaimEta(sdkChainId)})…`, 50, { txHash: depositTx })

  // Preferred path: sign the Arc spend now and hand it to MeshPort's server
  // (ub-claim-worker), which submits it once the deposit is final — so the
  // claim completes even if the phone is locked or the app is closed.
  let serverId: string | null = null
  try {
    serverId = await registerServerClaim({ kit, adapter, walletAddr, sdkChainId, amount, depositTx, cushion: before })
  } catch (e) {
    console.warn('[ubClaim] server hand-off failed — finishing on this device', e)
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
    onStep('attesting', `Waiting for ${chainLabel} to finalize (${ubClaimEta(sdkChainId)}). MeshPort finishes this automatically — you can close the app.`, 50, { txHash: depositTx })
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
  // History: "Claimed from <chain>" in Activity and the Hub (best effort —
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
  const to = { chain: 'Arc_Testnet', recipientAddress: walletAddr, useForwarder: true }
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
    to: { chain: 'Arc_Testnet', recipientAddress: walletAddr, useForwarder: true },
    token: 'USDC',
  }
  const est: any = await kit.unifiedBalance.estimateSpend({ ...base, amount: amount.toFixed(6) })
  const fee = (est?.fees ?? []).reduce((s: number, f: any) => s + (f?.token === 'USDC' ? Number(f.amount ?? 0) : 0), 0)
    || Number(est?.total ?? 0)
  const send = Math.max(0, amount - fee - spendMargin(params.cushion))
  if (send <= 0) throw new Error(`Amount too small to cover the Gateway fee (${fee.toFixed(4)} USDC)`)

  let captured: any = null
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!captured && /\/v1\/transfer(\?|$)/.test(url) && (init?.method ?? 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
      captured = JSON.parse(init.body)
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
  } catch { /* expected — the transfer call was intercepted */ } finally {
    globalThis.fetch = realFetch
  }
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
  const to = { chain: 'Arc_Testnet', recipientAddress: walletAddr, useForwarder: true }
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

  let captured: any = null
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!captured && /\/v1\/transfer(\?|$)/.test(url) && (init?.method ?? 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
      captured = JSON.parse(init.body)
      return new Response(JSON.stringify({ success: false, message: 'captured for server submission' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input as any, init)
  }) as typeof fetch
  try {
    await kit.unifiedBalance.spend({
      from: { adapter, allocations: allocations.map(a => ({ amount: a.amount.toFixed(6), chain: a.chain })) },
      to, token: 'USDC', amount: send.toFixed(6),
    })
  } catch { /* expected — the transfer call was intercepted */ } finally {
    globalThis.fetch = realFetch
  }
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
    await new Promise(r => setTimeout(r, POLL_MS))
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
  // Still running on the server — it will arrive by itself.
}

/** Chains with a claim the server is still finishing (auto-finish leaves them alone). */
async function serverOwnedChains(walletAddr: string): Promise<Set<string>> {
  try {
    const { supabase } = await import('./supabase')
    const { data } = await supabase.from('ub_claim_intents').select('source_chain')
      .eq('wallet_address', walletAddr.toLowerCase()).in('status', ['waiting', 'submitted'])
    return new Set((data ?? []).map((r: any) => String(r.source_chain)))
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

// ── Merchant auto-convert (scheduled) ────────────────────────────────────
// Approved merchants only, and only when they turned Auto-convert on.
// Customer payments on other chains stay there until the scheduled run:
//   run (every 6 h, booked by the server): deposit every chain's USDC into
//   the Ledger (Unified Balance) → sign ONE Ledger → Arc transfer for all of
//   it → hand it to the server with not_before = +1 h. The server submits it
//   an hour later (even if the app is closed) → "Merchant funds moved to Arc".
// Under $2 in total → nothing moves; it waits for the next run.
// merchant_auto_convert_claim() hands each run to exactly one device/tab, so
// it never runs twice or early. Signing needs the merchant's key, so the run
// itself happens when the app is open at (or after) the booked time.
export const AUTO_CONVERT_MIN_TOTAL = 2
const AUTO_CONVERT_MIN_CHAIN = 1
let converting = false

export async function runMerchantAutoConvert(p: {
  walletAddress: string; makeAdapter: () => Promise<any>
}): Promise<'skipped' | 'not_due' | 'too_small' | 'scheduled' | 'error'> {
  if (converting || !isMerchantNow()) return 'skipped'
  const { supabase } = await import('./supabase')
  // Cheap check first; the claim below is the authority.
  const { data: cfg } = await supabase.from('merchant_auto_convert').select('enabled, next_run_at').maybeSingle()
  if (!cfg?.enabled || !cfg.next_run_at || new Date(cfg.next_run_at).getTime() > Date.now()) return 'not_due'
  const { data: claimed } = await supabase.rpc('merchant_auto_convert_claim')
  if (!claimed) return 'not_due'
  converting = true
  let deposited = 0
  const done = async (result: string, retry = false) => { await supabase.rpc('merchant_auto_convert_done', { p_result: result, p_retry: retry }) }
  try {
    const { readExternalChainBalance } = await import('@/blockchain/BlockchainManager')
    const [{ AppKit }, adapter] = await Promise.all([import('@circle-fin/app-kit'), p.makeAdapter()])
    const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
    const serverOwned = await serverOwnedChains(p.walletAddress)
    const toApp = (c: string) => SDK_TO_APP_CHAIN[c] ?? c

    // What's waiting: USDC in the wallet on each chain + anything already in
    // the Ledger on that chain (earlier runs / dust).
    const chains = [...UB_CLAIM_CHAINS].filter(c => !serverOwned.has(c) && !inFlight.has(c))
    const wallet = new Map<string, number>()
    for (const c of chains) wallet.set(c, await readExternalChainBalance(toApp(c), p.walletAddress).catch(() => 0))
    const ledger = new Map<string, number>()
    for (const r of await getUnifiedBalances(kit, p.walletAddress).catch(() => [])) {
      if (chains.includes(r.chain)) ledger.set(r.chain, (ledger.get(r.chain) ?? 0) + r.confirmed + r.pending)
    }
    const toDeposit = chains.filter(c => (wallet.get(c) ?? 0) >= AUTO_CONVERT_MIN_CHAIN)
    const total = toDeposit.reduce((s, c) => s + (wallet.get(c) ?? 0), 0) + [...ledger.values()].reduce((s, v) => s + v, 0)
    if (total < AUTO_CONVERT_MIN_TOTAL) { await done(`$${total.toFixed(2)} waiting — under $${AUTO_CONVERT_MIN_TOTAL}, left for the next run`); return 'too_small' }

    // 1) All chains into the Ledger, in this one run.
    for (const c of toDeposit) {
      const amount = Math.floor((wallet.get(c) ?? 0) * 1e6) / 1e6
      const ran = await withChainLock(p.walletAddress, c, async () => {
        const dep: any = await kit.unifiedBalance.deposit({
          from: { adapter, chain: c as any }, amount: amount.toFixed(6), token: 'USDC', allowanceStrategy: 'permit',
        })
        await assertDepositSucceeded(c, hashOf(dep))
      }).catch(e => { console.warn('[autoConvert] deposit failed on', c, e); return null })
      if (ran) { ledger.set(c, (ledger.get(c) ?? 0) + amount); deposited++ }
    }

    // 2) ONE Ledger → Arc transfer for everything, submitted by the server in 1 hour.
    const parts = [...ledger.entries()].map(([chain, amount]) => ({ chain, amount: Math.floor(amount * 1e6) / 1e6 })).filter(x => x.amount > 0)
    const sum = parts.reduce((s, x) => s + x.amount, 0)
    if (sum < AUTO_CONVERT_MIN_TOTAL) { await done(`Only $${sum.toFixed(2)} in the Ledger — left for the next run`); return 'too_small' }
    const { body, send, allocations } = await signSpendAllToArc({ kit, adapter, walletAddr: p.walletAddress, parts })
    const { error } = await supabase.from('ub_claim_intents').insert({
      wallet_address: p.walletAddress.toLowerCase(),
      source_chain:   allocations[0].chain,
      source_chains:  allocations.map(a => a.chain),
      merchant:       true,
      auto_convert:   true,
      amount:         Number(sum.toFixed(6)),
      send_amount:    Number(send.toFixed(6)),
      transfer_body:  body,
      not_before:     new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    if (error) throw error
    await done(`Moved $${sum.toFixed(2)} from ${allocations.map(a => toApp(a.chain).split('_')[0]).join(', ')} into the Ledger — to Arc in 1 hour`)
    return 'scheduled'
  } catch (e) {
    console.warn('[autoConvert] run failed', e)
    // Nothing moved yet (network etc.) → one retry in 30 min. If deposits went
    // through, the funds wait safely in the Ledger for the next run.
    await done(`Run failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 180), deposited === 0).catch(() => {})
    return 'error'
  } finally {
    converting = false
  }
}

/** @deprecated Instant collection was replaced by the scheduled runMerchantAutoConvert. */
export async function autoCollectMerchantPayments(_p: { walletAddress: string; privateKey: string; makeAdapter: () => Promise<any> }): Promise<number> {
  return 0
}

// ── Auto-finish ───────────────────────────────────────────────────────────
// Fallback for deposits the server isn't finishing (older claims, a failed
// hand-off, a Gateway error): whenever the app is open and unlocked, sweep
// any CONFIRMED Unified Balance on other chains into the Arc wallet. Chains
// with an open ub_claim_intents row are skipped — the server owns those.
let sweeping = false

export async function autoFinishUbClaims(p: { walletAddress: string; privateKey: string }): Promise<number> {
  if (sweeping) return 0
  sweeping = true
  let finished = 0
  try {
    const [{ AppKit }, { createEthersAdapterFromPrivateKey }] = await Promise.all([
      import('@circle-fin/app-kit'), import('@circle-fin/adapter-ethers-v6'),
    ])
    const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
    const rows = await getUnifiedBalances(kit, p.walletAddress)
    const serverOwned = await serverOwnedChains(p.walletAddress)
    const ready = rows.filter(r => r.chain !== 'Arc_Testnet' && r.confirmed >= UB_MIN_SWEEP && !inFlight.has(r.chain) && !serverOwned.has(r.chain))
    if (ready.length === 0) return 0
    const adapter = (createEthersAdapterFromPrivateKey as any)({ privateKey: p.privateKey })
    for (const r of ready) {
      if (inFlight.has(r.chain)) continue
      inFlight.add(r.chain)
      try {
        const out = await spendUnifiedToArc({ kit, adapter, walletAddr: p.walletAddress, fromChain: r.chain, amount: r.confirmed })
        await recordUbClaim({ walletAddr: p.walletAddress, sdkChainId: r.chain, received: out.received, claimedAmount: r.confirmed, arcTxHash: out.txHash })
        finished++
      } catch (e) {
        console.warn('[ubClaim] auto-finish failed for', r.chain, e)
      } finally {
        inFlight.delete(r.chain)
      }
    }
  } catch (e) {
    console.warn('[ubClaim] auto-finish check failed', e)
  } finally {
    sweeping = false
  }
  return finished
}
