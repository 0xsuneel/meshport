// lib/fastCctp.ts
//
// USDC from Arc to another EVM chain over Circle CCTP v2, without the SDK's
// round trips. Circle's App Kit (kit.bridge) makes ~30 sequential RPC calls
// per Arc step (chain checks, simulations, fee reads, receipt polling) - on a
// phone that was 5-7 s per step even though Arc confirms in under a second.
//
// Same contracts, same calls the SDK makes - Circle's own documented ones:
//   1. approve(TokenMessengerV2, amount) on Arc USDC - EXACTLY the amount,
//      so the burn uses all of it and nothing stays approved. Skipped only
//      when the allowance is already exactly the amount. A leftover allowance
//      (the earlier one-time max approval) is replaced by the exact amount on
//      the next transfer, so it ends at 0 too. (The Arc router, when deployed,
//      needs no approval at all.)
//   2. TokenMessengerV2.depositForBurnWithHook(..., FORWARD_HOOK) (Circle's
//      forwarder mints) or depositForBurn(...) (MeshPort's relayer mints)
// Each is signed on this device (the key never leaves the wallet) and sent the
// way Pay sends: one request, the server broadcasts to every Arc node and
// returns the receipt (arcService.relayArcSend). Gas is estimated first, so a
// transaction that would revert is never sent.
//   3. Circle's attestation, read from Iris every second
//   4. the mint: Circle's forwarder (Iris reports its tx), or MeshPort's
//      relayer submits receiveMessage with Circle's attestation - the attested
//      message fixes recipient and amount, and a message mints only once.
//
// Steps are reported through onStep with the same payload shape as the SDK's
// events, and the result has the kit's shape ({ state, steps }), so the
// Transfer screen's step list, Activity rows and success screen are unchanged.

import { encodeFunctionData, decodeFunctionResult, pad, parseUnits, toHex, type Hex } from 'viem'
import type { WalletAccount } from '@/wallet'
import { arcRpcJson } from './arc'
import { CCTP_DOMAINS, IRIS, fetchIrisMessage, forwardDone, type IrisMessage } from './cctpTracker'
import { FORWARD_HOOK, FAST_FINALITY, ARC_DOMAIN, bridgeNonce, type BridgeParams } from './gaslessBridge'
import { CROSS_CHAIN_FEE, usdRule, meshportFee, arcWeiToUsdcUnits } from './feePolicy'

export const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Hex
export const ARC_USDC = '0x3600000000000000000000000000000000000000' as Hex // ERC-20 view, 6 decimals
const SLOW_FINALITY = 2000
const ZERO32 = pad('0x0', { size: 32 })

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const
const BURN_ARGS = [
  { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' },
  { name: 'burnToken', type: 'address' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
  { name: 'minFinalityThreshold', type: 'uint32' },
] as const
const MESSENGER = [
  { type: 'function', name: 'depositForBurn', stateMutability: 'nonpayable', inputs: BURN_ARGS, outputs: [] },
  { type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable', inputs: [...BURN_ARGS, { name: 'hookData', type: 'bytes' }], outputs: [] },
] as const

/** Can this destination take the direct path? (EVM chains with a CCTP domain.) */
export function canFastCctp(destination: string): boolean {
  if (destination === 'Solana_Devnet' || destination === 'Solana' || destination === ARC_KEY) return false
  return CCTP_DOMAINS[destination] !== undefined
}
const ARC_KEY = 'Arc_Testnet'

// ── Fees ─────────────────────────────────────────────────────────────────────
type IrisFeeRow = { finalityThreshold: number; minimumFee: number; forwardFee?: { low?: number; med?: number; high?: number } }

/**
 * The maxFee cap (USDC units) from Circle's fee table: the protocol fee
 * (minimumFee is in basis points, may be fractional) plus the forwarder's
 * fee, with headroom - it's a cap, not a charge. A cap under Circle's fee
 * makes a FAST transfer wait for standard finality, so it errs high.
 * Pure - unit tested.
 */
export function maxFeeFromIris(rows: IrisFeeRow[], amount: bigint, o: { fast: boolean; forward: boolean; l1: boolean }): bigint | null {
  if (!Array.isArray(rows) || !rows.length) return null
  const want = o.fast ? FAST_FINALITY : SLOW_FINALITY
  const row = rows.find(r => r.finalityThreshold === want)
    ?? (o.fast ? rows.find(r => r.finalityThreshold <= FAST_FINALITY) : rows.find(r => r.finalityThreshold >= SLOW_FINALITY))
  if (!row || typeof row.minimumFee !== 'number') return null
  const bpsX100 = BigInt(Math.ceil(row.minimumFee * 100))
  const protocol = (amount * bpsX100 + 999_999n) / 1_000_000n
  const fwdRaw = o.forward ? row.forwardFee?.high ?? row.forwardFee?.med : 0
  if (o.forward && typeof fwdRaw !== 'number') return null
  const fwd = BigInt(Math.ceil(fwdRaw ?? 0))
  // Ethereum's gas moves most between quote and mint: 50% headroom there, 20% elsewhere.
  const headroom = o.l1 ? 15n : 12n
  return ((protocol + fwd) * headroom) / 10n + 1_000n
}

// Circle's fee table per route, kept 20 s: Review and Confirm read the same one.
const FEE_ROWS_TTL_MS = 20_000
const feeRows = new Map<string, { at: number; rows: Promise<IrisFeeRow[] | null> }>()

/** Circle's fee table from Arc to `destination` (null: Iris unreachable). */
export function irisFeeRows(destination: string, forward: boolean): Promise<IrisFeeRow[] | null> {
  const dst = CCTP_DOMAINS[destination]
  if (dst === undefined) return Promise.resolve(null)
  const key = `${dst}|${forward}`
  const hit = feeRows.get(key)
  if (hit && Date.now() - hit.at < FEE_ROWS_TTL_MS) return hit.rows
  const rows = (async () => {
    // Only the configured Iris: the other network's fee table is a different
    // price list, and a maxFee cap built from it can hold a FAST transfer back.
    try {
      const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${ARC_DOMAIN}/${dst}${forward ? '?forward=true' : ''}`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) return null
      const json = await r.json()
      if (Array.isArray(json) && json.length) return json as IrisFeeRow[]
    } catch { /* Iris unreachable: the caller falls back */ }
    return null
  })()
  const entry = { at: Date.now(), rows }
  feeRows.set(key, entry)
  void rows.then(r => { if (!r && feeRows.get(key) === entry) feeRows.delete(key) }) // a miss is never cached
  return rows
}

/** Circle's fee cap for this route right now, in USDC (6 dp string), or null when Iris can't say. */
export async function fastCctpMaxFee(p: { destination: string; amount: number; fast: boolean; forward: boolean; l1: boolean }): Promise<string | null> {
  const rows = await irisFeeRows(p.destination, p.forward)
  const cap = rows ? maxFeeFromIris(rows, parseUnits(p.amount.toFixed(6), 6), p) : null
  return cap !== null ? (Number(cap) / 1e6).toFixed(6) : null
}

/**
 * The fees Circle will charge (USDC), for Review - not the cap: the
 * protocol fee (bps of the amount) and the forwarder's typical fee. Pure.
 */
export function expectedFeesFromIris(rows: IrisFeeRow[], amount: number, o: { fast: boolean; forward: boolean }): { bridgeFee: number; forwarderFee: number } | null {
  const want = o.fast ? FAST_FINALITY : SLOW_FINALITY
  const row = rows.find(r => r.finalityThreshold === want)
    ?? (o.fast ? rows.find(r => r.finalityThreshold <= FAST_FINALITY) : rows.find(r => r.finalityThreshold >= SLOW_FINALITY))
  if (!row || typeof row.minimumFee !== 'number') return null
  const fwd = o.forward ? row.forwardFee?.med ?? row.forwardFee?.high : 0
  if (o.forward && typeof fwd !== 'number') return null
  const bridgeFee = Math.ceil(amount * 1e6 * row.minimumFee / 10_000) / 1e6
  return { bridgeFee, forwarderFee: (fwd ?? 0) / 1e6 }
}

// Arc gas the wallet pays (in USDC): the burn, plus the approval unless the allowance is exactly the amount.
const APPROVE_GAS = 60_000n
const BURN_GAS = 200_000n

/**
 * Review's fees for a USDC transfer from Arc, straight from Circle's fee
 * table and two Arc reads, all in parallel - instead of the SDK's estimate.
 * Null when anything can't be read (the caller uses the SDK then).
 */
export async function fastCctpFees(p: { destination: string; amount: number; fast: boolean; forward: boolean; owner: string; destMintGas?: bigint }): Promise<{ bridgeFee: number; forwarderFee: number; networkFee: number } | null> {
  if (!canFastCctp(p.destination)) return null
  try {
    const [rows, gasPriceHex, allowanceHex] = await Promise.all([
      irisFeeRows(p.destination, p.forward),
      rpc('eth_gasPrice', []),
      rpc('eth_call', [{ to: ARC_USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [p.owner as Hex, TOKEN_MESSENGER_V2] }) }, 'latest']),
    ])
    const fees = rows ? expectedFeesFromIris(rows, p.amount, p) : null
    if (!fees) return null
    // Through the Arc router: its fee (the relayer's gas), whatever the allowance.
    if (arcRouterAddress()) return { ...fees, networkFee: Number(routerFee(BigInt(gasPriceHex), parseUnits(p.amount.toFixed(6), 6), p.forward ? 0n : (p.destMintGas ?? 0n))) / 1e6 }
    const allowance = decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: allowanceHex as Hex }) as bigint
    const gas = BURN_GAS + (allowance !== parseUnits(p.amount.toFixed(6), 6) ? APPROVE_GAS : 0n)
    // Arc gas is USDC with 18 decimals.
    const networkFee = Number(gas * BigInt(gasPriceHex)) / 1e18
    return { ...fees, networkFee }
  } catch { return null }
}

// ── Arc RPC (through MeshPort's ranked proxy) ────────────────────────────────
export const rpc = async (method: string, params: unknown[]) => (await arcRpcJson({ jsonrpc: '2.0', id: 1, method, params }))?.result

/** Gas for a call (30% headroom). A call the node says reverts throws: nothing is sent. */
export async function estimate(from: string, to: Hex, data: Hex, value = 0n): Promise<bigint> {
  try {
    const g = await rpc('eth_estimateGas', [{ from, to, data, ...(value > 0n ? { value: '0x' + value.toString(16) } : {}) }])
    return (BigInt(g) * 13n) / 10n
  } catch (e: any) {
    // The node simulated it and it reverts: nothing is sent.
    const why = String(e?.message || e?.data?.message || '').replace(/^execution reverted:?\s*/i, '')
    throw new FastCctpError(why ? `Arc rejected this transfer: ${why}` : 'Arc rejected this transfer (simulation failed). Nothing was sent.', 'rejected')
  }
}

export class FastCctpError extends Error {
  constructor(message: string, readonly kind: 'rejected' | 'not_sent' | 'settling') { super(message) }
}

// ── One signature through MeshPortRouter on Arc (when it is deployed) ───────
// contracts/MeshPortRouter.sol at VITE_ARC_ROUTER: the wallet signs ONE
// EIP-3009 authorization (USDC "ReceiveWithAuthorization") for exactly
// amount + fee to the router; MeshPort's relayer submits it
// (api/bridge-relay arc_transfer). The router pulls exactly that, approves
// exactly the amount to TokenMessengerV2, burns it, and resets the approval to
// 0 - in one transaction. No approval is ever left with TokenMessenger, and
// the wallet signs no transaction (one signature every time, first included).
// Every parameter (recipient, chain, fees, finality, hook) is bound into the
// authorization's nonce, so the relayer can't change any of them.
const ARC_CHAIN_ID = 5042002
/** Gas the relayer's router call uses, at most (simulated 3 Nov: ~210k); the fee is this × today's gas price. */
export const ROUTER_TRANSFER_GAS = 300_000n
const ROUTER_AUTH_WINDOW_SEC = 60 * 60
export function arcRouterAddress(): Hex | null {
  const r = String((import.meta.env.VITE_ARC_ROUTER as string | undefined) ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(r) ? r as Hex : null
}
/**
 * MeshPort's fee for one transfer of `amount` (USDC units): 0.2%, min $0.05,
 * cap $5 - never below the router call's gas at today's price × 1.15
 * (lib/feePolicy - the relayer checks the same number).
 */
export function routerFee(gasPrice: bigint, amount: bigint, destMintGas: bigint = 0n): bigint {
  return meshportFee(amount, arcWeiToUsdcUnits(ROUTER_TRANSFER_GAS * gasPrice) + destMintGas, usdRule(CROSS_CHAIN_FEE, 6))
}

// ── Who mints on the destination (api/bridge-relay transfer_mint) ──────────
// Circle's forwarder (the user pays Circle's forwarding fee out of the amount)
// or MeshPort's relayer (its destination gas is part of MeshPort's fee). The
// relayer when that's cheaper, and where Circle's forwarder keeps failing.
export type MintPlan = { forward: boolean; destMintGas: bigint }
const planCache = new Map<string, { at: number; plan: Promise<MintPlan> }>()
export function transferMintPlan(destination: string): Promise<MintPlan> {
  const hit = planCache.get(destination)
  if (hit && Date.now() - hit.at < 30_000) return hit.plan
  const plan = (async (): Promise<MintPlan> => {
    const { circleForwarderMintsTo } = await import('@/blockchain/chains')
    const fallback = circleForwarderMintsTo(destination)
    try {
      const r = await fetch(`/api/bridge-relay?action=transfer_mint&chain=${encodeURIComponent(destination)}`, { signal: AbortSignal.timeout(6_000) })
      const j = await r.json().catch(() => null) as { relayer?: boolean; destGas?: string } | null
      if (!r.ok || !j) throw new Error('no plan')
      const forward = j.relayer ? false : fallback
      return { forward, destMintGas: forward ? 0n : BigInt(j.destGas ?? '0') }
    } catch {
      planCache.delete(destination)
      return { forward: fallback, destMintGas: 0n }
    }
  })()
  planCache.set(destination, { at: Date.now(), plan })
  return plan
}

async function routerBurn(p: FastCctpParams, router: Hex, amount: bigint, maxFee: bigint, dst: number): Promise<Hex> {
  const { currentGasPrice } = await import('./arcService')
  const gasPrice = await beforeSending(currentGasPrice())
  const fee = routerFee(gasPrice, amount, p.useForwarder ? 0n : (p.destMintGas ?? 0n))
  const params: BridgeParams = {
    token: ARC_USDC, destinationDomain: dst, mintRecipient: pad(p.recipient as Hex, { size: 32 }),
    fee, maxFee, minFinalityThreshold: p.speed === 'FAST' ? FAST_FINALITY : SLOW_FINALITY,
    hookData: p.useForwarder ? FORWARD_HOOK : '0x',
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  }
  const nonce = bridgeNonce(params, ARC_CHAIN_ID, router)
  const value = amount + fee
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + ROUTER_AUTH_WINDOW_SEC)
  const from = p.account.address
  const signature = await p.account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: ARC_CHAIN_ID, verifyingContract: ARC_USDC },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from, to: router, value, validAfter: 0n, validBefore, nonce },
  })
  const { authApiHeaders } = await import('@/lib/supabase')
  const body = JSON.stringify({
    action: 'arc_transfer',
    bridge: { ...params, fee: fee.toString(), maxFee: maxFee.toString() },
    authorization: { from, value: value.toString(), validAfter: '0', validBefore: validBefore.toString(), signature },
  })
  // The relayer answers a repeat of the same authorization with the
  // transaction it already sent, so one retry after a lost answer is safe.
  let out: { txHash?: string; error?: string } | null = null
  let status = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('/api/bridge-relay', { method: 'POST', headers: await authApiHeaders(), body, signal: AbortSignal.timeout(45_000) })
      status = r.status
      out = await r.json().catch(() => null)
      break
    } catch (e) {
      if (attempt === 1) throw Object.assign(new FastCctpError("Couldn't reach MeshPort - your transfer may still go through. Check Activity in a minute before trying again.", 'settling'), { cause: e })
    }
  }
  const hash = out?.txHash
  if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
    if (status >= 500) throw Object.assign(new FastCctpError('The transfer failed on Arc. Nothing was sent.', 'not_sent'), { txHash: hash })
    return hash as Hex
  }
  // Already sent (a retry after a lost answer) but its transaction wasn't
  // found yet: never "nothing was sent" - it may be on its way.
  if ((out as { alreadySubmitted?: boolean } | null)?.alreadySubmitted) {
    throw new FastCctpError('This transfer was already sent - check Activity in a minute before trying again.', 'settling')
  }
  throw new FastCctpError(`${out?.error || 'The transfer was refused'}. Nothing was sent.`, 'not_sent')
}

export const ARC_UNREACHABLE = "Couldn't reach Arc - your connection dropped. Nothing was sent. Try again."
/**
 * Reads made before anything is signed. A lost connection there is a clean
 * "nothing was sent" - not the browser's raw "signal timed out".
 */
export async function beforeSending<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    if (e instanceof FastCctpError) throw e
    const name = e instanceof Error ? e.name : ''
    if (name === 'TimeoutError' || name === 'AbortError' || e instanceof TypeError || /timed out|failed to fetch|network|Arc RPC (5\d\d|429)/i.test(String((e as any)?.message ?? e)))
      throw new FastCctpError(ARC_UNREACHABLE, 'not_sent')
    throw e
  }
}

// ── The transfer ─────────────────────────────────────────────────────────────
export type FastCctpStep = 'approve' | 'burn' | 'attestation' | 'mint'
type StepPayload = { values: { state: 'success' | 'pending' | 'error'; txHash?: string } }

export interface FastCctpParams {
  /** MeshPort's relayer's gas for the destination mint (USDC units), when it mints - part of MeshPort's fee. */
  destMintGas?: bigint
  account: WalletAccount
  /** Destination chain (kit id, e.g. Ethereum_Sepolia). */
  destination: string
  recipient: string
  /** USDC, 6 dp. */
  amount: string
  /** Cap on Circle's fees, USDC 6 dp. */
  maxFee: string
  speed: 'FAST' | 'SLOW'
  /** Circle's forwarder mints (true) or MeshPort's relayer does (false). */
  useForwarder: boolean
  onStep: (step: FastCctpStep, payload: StepPayload) => void
  /** The burn is out (or may be): from here the transfer settles on its own. */
  onBurnSent?: (hash: string) => void
  /** Poll interval for Circle's attestation (ms). */
  pollMs?: number
  /** How long to wait for Circle's attestation before handing over to "still settling". */
  attestationTimeoutMs?: number
}

type KitStep = { name: string; state: 'success' | 'error'; txHash?: string }
export interface FastCctpResult { state: 'success'; steps: KitStep[] }

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Sends one Arc transaction; returns its hash once it has succeeded. */
export async function sendStep(account: WalletAccount, tx: { to: Hex; data: Hex; gas: bigint; nonce: number; value?: bigint }, what: string, onSent?: (h: string) => void): Promise<Hex> {
  const { relayArcSend, waitForConfirmation } = await import('./arcService')
  let sent: Awaited<ReturnType<typeof relayArcSend>>
  try {
    sent = await relayArcSend(account, tx, h => onSent?.(h))
  } catch (e: any) {
    throw new FastCctpError(`${what} was rejected by Arc: ${e?.message || 'unknown error'}. Nothing was sent.`, 'not_sent')
  }
  let state = sent.state
  if (state === 'pending') state = (await waitForConfirmation(sent.txHash, 60_000)).state
  if (state === 'success') return sent.txHash
  if (state === 'failed') throw new FastCctpError(`${what} failed on Arc. Nothing was sent.`, 'not_sent')
  // Out, but not confirmed yet.
  throw Object.assign(new FastCctpError(`${what} is still confirming on Arc.`, 'settling'), { txHash: sent.txHash })
}

/**
 * Circle's forwarder has submitted the mint (forwardTxHash) but Iris hasn't
 * said COMPLETE yet - it lags the chain (field 31 Oct: EURC minted on Ethereum
 * 11 s after leaving Arc, the screen still waiting 38 s later). The
 * destination chain's own receipt settles it: a successful receipt for the
 * mint Circle reported is the delivery. Unsure (no RPC answer, not mined yet)
 * is "not yet", never a failure.
 */
export async function deliveredOnChain(msg: IrisMessage | null, destination: string, timeoutMs = 4000): Promise<boolean> {
  const hash = msg?.forwardTxHash
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash) || forwardFailed(msg)) return false
  const { EXTERNAL_CHAINS } = await import('@/blockchain/chains')
  const rpcs = EXTERNAL_CHAINS[destination === 'Polygon_Amoy_Testnet' ? 'Polygon_Sepolia' : destination]?.rpcs ?? []
  for (const url of rpcs.slice(0, 3)) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!r.ok) continue
      const j = await r.json()
      if (j?.result?.status === '0x1') return true
      if (j?.result) return false // mined and reverted: Circle retries or reports it
    } catch { /* next RPC */ }
  }
  return false
}

export const attested = (m: IrisMessage | null) => !!m && m.status === 'complete' && !!m.message && !!m.attestation && m.attestation !== 'PENDING'
export const forwarded = (m: IrisMessage | null) => forwardDone(m)
export const forwardFailed = (m: IrisMessage | null) => (m?.forwardState ?? '').toUpperCase() === 'FAILED'

export async function fastCctpTransfer(p: FastCctpParams): Promise<FastCctpResult> {
  const dst = CCTP_DOMAINS[p.destination]
  if (dst === undefined || !canFastCctp(p.destination)) throw new FastCctpError(`${p.destination} isn't a CCTP destination`, 'rejected')
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.recipient)) throw new FastCctpError('Invalid recipient address', 'rejected')
  const amount = parseUnits(p.amount, 6)
  const maxFee = parseUnits(p.maxFee, 6)
  if (!(amount > 0n)) throw new FastCctpError('Enter an amount greater than 0', 'rejected')
  // Circle's contract rule; checked here so it can't surface as an opaque revert.
  if (maxFee >= amount) throw new FastCctpError('This amount is too small for the route fee', 'rejected')
  const pollMs = p.pollMs ?? 1000
  const from = p.account.address

  const burnData = p.useForwarder
    ? encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurnWithHook', args: [amount, dst, pad(p.recipient as Hex, { size: 32 }), ARC_USDC, ZERO32, maxFee, p.speed === 'FAST' ? FAST_FINALITY : SLOW_FINALITY, FORWARD_HOOK] })
    : encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurn', args: [amount, dst, pad(p.recipient as Hex, { size: 32 }), ARC_USDC, ZERO32, maxFee, p.speed === 'FAST' ? FAST_FINALITY : SLOW_FINALITY] })
  const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] })

  // Express (lib/fastPay): no Circle signature - the session key burns it,
  // within the shared Express limit. Anything it can't do (over the limit,
  // not ready, an older wallet frame, a failure before the burn) goes on below.
  const express = await expressBurn(p, amount, burnData)
  if (express) {
    p.onStep('approve', { values: { state: 'success' } })
    p.onBurnSent?.(express)
    p.onStep('burn', { values: { state: 'success', txHash: express } })
    return settle(p, express, undefined, pollMs)
  }

  // MeshPortRouter on Arc: one signature, nothing left approved.
  const router = arcRouterAddress()
  if (router) {
    p.onStep('approve', { values: { state: 'success' } }) // no approval: the router's one transaction covers it
    const burnHash = await routerBurn(p, router, amount, maxFee, dst)
    p.onBurnSent?.(burnHash)
    p.onStep('burn', { values: { state: 'success', txHash: burnHash } })
    return settle(p, burnHash, undefined, pollMs)
  }

  // Nonce and allowance together (one round trip each, in parallel).
  const [nonceHex, allowanceHex] = await beforeSending(Promise.all([
    rpc('eth_getTransactionCount', [from, 'pending']),
    rpc('eth_call', [{ to: ARC_USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [from, TOKEN_MESSENGER_V2] }) }, 'latest']),
  ]))
  let nonce = Number(BigInt(nonceHex))
  const allowance = decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: allowanceHex as Hex }) as bigint

  // 1. Approve exactly the amount - the burn spends it all, nothing stays
  //    approved. A leftover allowance (old max approval) is replaced here.
  let approveHash: string | undefined
  if (allowance !== amount) {
    const gas = await estimate(from, ARC_USDC, approveData)
    approveHash = await sendStep(p.account, { to: ARC_USDC, data: approveData, gas, nonce }, 'The approval')
    nonce += 1
  }
  p.onStep('approve', { values: { state: 'success', txHash: approveHash } })

  // 2. Burn. Simulated first: a burn that would revert is never sent.
  const burnGas = await estimate(from, TOKEN_MESSENGER_V2, burnData)
  let burnHash: string
  try {
    burnHash = await sendStep(p.account, { to: TOKEN_MESSENGER_V2, data: burnData, gas: burnGas, nonce }, 'The transfer')
  } catch (e: any) {
    if (e instanceof FastCctpError && e.kind === 'settling' && (e as any).txHash) p.onBurnSent?.((e as any).txHash)
    throw e
  }
  p.onStep('burn', { values: { state: 'success', txHash: burnHash } })
  return settle(p, burnHash, approveHash, pollMs)
}

/** 3 and 4: Circle's attestation, then the mint - the same for both ways of burning. */
/**
 * The Express way, when it covers this transfer: the burn's hash, or null to
 * go the normal way. MeshPort's fee is the same as the router path's.
 */
async function expressBurn(p: FastCctpParams, amount: bigint, burnData: Hex): Promise<Hex | null> {
  let fp: typeof import('./fastPay')
  let args: Parameters<typeof import('./fastPay')['expressTransfer']>[0]
  // Anything before Express sends: the normal way.
  try {
    fp = await import('./fastPay')
    const owner = p.account.address
    if (!fp.fastPayEnabled()) return null
    const { currentGasPrice } = await import('./arcService')
    const fee = routerFee(await currentGasPrice(), amount, p.useForwarder ? 0n : (p.destMintGas ?? 0n))
    if (!fp.expressCoversTransfer(owner, Number(amount + fee) / 1e6)) return null
    const fw = String((import.meta.env.VITE_FEE_WALLET as string | undefined) ?? '').trim()
    args = { owner, amount, fee, feeWallet: /^0x[0-9a-fA-F]{40}$/.test(fw) ? fw as Hex : null, burnData }
  } catch { return null }
  try {
    return (await fp.expressTransfer(args)).burnHash
  } catch (e) {
    // Nothing moved (or it was returned): the normal way. Anything else - a
    // burn still confirming, funds held - is the user's to see, not retried.
    if (e instanceof fp.FastPayNotSent) {
      void import('./errorReport').then(m => m.reportPerf(`[perf express transfer] normal way: ${(e.message || '').slice(0, 140)}`)).catch(() => {})
      return null
    }
    throw e
  }
}

/**
 * MeshPort's relayer mints from the server: it waits for Circle's attestation
 * itself and submits the mint the moment it's there (api/bridge-relay
 * transfer_mint_start). Resolves to the mint tx, or null (not done - the app
 * finishes it the usual way).
 */
export async function serverTransferMint(destination: string, burnTx: string): Promise<string | null> {
  try {
    const sb = await import('./supabase')
    const r = await fetch('/api/bridge-relay', {
      method: 'POST', headers: await sb.authApiHeaders(),
      body: JSON.stringify({ action: 'transfer_mint_start', chain: destination, burnTx }),
      signal: AbortSignal.timeout(58_000),
    })
    const j = await r.json().catch(() => null) as { txHash?: string } | null
    return r.ok && j?.txHash && /^0x[0-9a-fA-F]{64}$/.test(j.txHash) ? j.txHash : null
  } catch { return null }
}

async function settle(p: FastCctpParams, burnHash: string, approveHash: string | undefined, pollMs: number): Promise<FastCctpResult> {
  // MeshPort's relayer mints: the server starts now and mints as soon as Circle attests.
  const serverMint = p.useForwarder ? null : serverTransferMint(p.destination, burnHash)

  // 3. Circle's attestation.
  const attestDeadline = Date.now() + (p.attestationTimeoutMs ?? 10 * 60_000)
  let msg: IrisMessage | null = null
  while (Date.now() < attestDeadline) {
    msg = await fetchIrisMessage(ARC_KEY, burnHash).catch(() => null)
    if (attested(msg) || forwarded(msg)) break
    await sleep(pollMs)
  }
  if (!attested(msg) && !forwarded(msg)) {
    throw new FastCctpError('Circle is still confirming this transfer. It will arrive on its own - check your balance in a few minutes.', 'settling')
  }
  p.onStep('attestation', { values: { state: 'success' } })

  // 4. Mint: Circle's forwarder, or MeshPort's relayer.
  let mintHash: string | null = forwarded(msg) ? msg!.forwardTxHash! : null
  if (!mintHash && serverMint) mintHash = await serverMint
  if (!mintHash && p.useForwarder) {
    const fwdDeadline = Date.now() + 90_000
    while (!mintHash && Date.now() < fwdDeadline && !forwardFailed(msg)) {
      await sleep(pollMs)
      msg = await fetchIrisMessage(ARC_KEY, burnHash).catch(() => msg)
      if (forwarded(msg) || await deliveredOnChain(msg, p.destination)) mintHash = msg!.forwardTxHash!
    }
  }
  if (!mintHash) {
    // No forwarder, or it failed / is late: MeshPort's relayer finishes it
    // with Circle's attestation (it refuses an already-minted message).
    const { finishCctpMintViaRelayer } = await import('./cctpRecovery')
    const done = await finishCctpMintViaRelayer({ sourceChain: ARC_KEY, destinationChain: p.destination, burnTxHash: burnHash, timeoutMs: 60_000, pollMs }).catch(() => null)
    mintHash = done?.mintTxHash ?? null
  }
  if (!mintHash) {
    throw new FastCctpError('Circle has confirmed this transfer and it is being delivered. It will arrive on its own - check your balance in a few minutes.', 'settling')
  }
  p.onStep('mint', { values: { state: 'success', txHash: mintHash } })

  return {
    state: 'success',
    steps: [
      { name: 'approve', state: 'success', txHash: approveHash },
      { name: 'burn', state: 'success', txHash: burnHash },
      { name: 'fetchAttestation', state: 'success' },
      { name: 'mint', state: 'success', txHash: mintHash },
    ],
  }
}
