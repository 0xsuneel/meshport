// lib/fastCctpx.ts
//
// EURC / cirBTC from Arc to another chain over Circle CCTPx, without the
// SDK's round trips - the token counterpart of lib/fastCctp (USDC). Circle's
// App Kit made ~30 sequential RPC calls per Arc step here too (measured: 33 s
// per transfer against 15-20 s for USDC on the direct path).
//
// The same calls the kit makes (@circle-fin/provider-cctpx), on Circle's own
// contracts:
//   1. a signed fee quote from Circle (Iris /v2/quote/cctpx/...): FORWARD (Circle
//      delivers on the destination) + PRE_FINALITY (fast) when Circle quotes it
//   2. approve(TokenManager, amount) on the token - exact amount, only when the
//      allowance is short. The manager is read from the CrossChainTokenService
//      on Arc (resolveTokenManager), not taken from anywhere else.
//   3. CrossChainTokenService.crossChainTransfer(tokenId, amount, domain,
//      recipient (20 bytes), 0, finality, (signedQuote, refund = the sender),
//      false, "") with Circle's fee as msg.value (Arc's native USDC)
//   4. Circle's attestation and delivery, read from Iris every second
//      (forwardState COMPLETE → the mint on the destination)
// Signed on this device, sent the way Pay sends (fastCctp.sendStep), every
// transaction simulated first: one that would revert is never sent. The quote
// is bound on-chain to this exact transfer (the fee manager reverts on a
// mismatch), so nothing about it can be swapped.

import { encodeFunctionData, decodeFunctionResult, type Hex } from 'viem'
import type { WalletAccount } from '@/wallet'
import { CCTP_DOMAINS, IRIS_SANDBOX, fetchIrisMessage, type IrisMessage } from './cctpTracker'
import { ARC_DOMAIN } from './gaslessBridge'
import { CCTPX_TOKEN_IDS } from './gaslessToken'
import { FastCctpError, estimate, sendStep, rpc, sleep, attested, forwarded, forwardFailed, canFastCctp, type FastCctpStep } from './fastCctp'
import type { CctpxToken } from './tokenBridge'

/** Circle's CrossChainTokenService (testnet; the same address on every testnet chain). */
export const CCTPX_SERVICE = '0x63753E722bd2C2A5DF6EE19C5106662208B81077' as Hex
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex
const FAST = 1000
const SLOW = 2000

const SERVICE_ABI = [
  { type: 'function', name: 'resolveTokenManager', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'crossChainTransfer', stateMutability: 'payable',
    inputs: [
      { name: 'tokenId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationAddress', type: 'bytes' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'claim', type: 'tuple', components: [{ name: 'signedQuote', type: 'bytes' }, { name: 'refundAddress', type: 'address' }] },
      { name: 'autoExecuteHookData', type: 'bool' }, { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const
const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// ── Circle's signed fee quote ────────────────────────────────────────────────
export interface CctpxQuote {
  token: CctpxToken
  destination: string
  recipient: string
  amount: bigint
  signedQuote: Hex
  /** Circle's fee in Arc's native currency (USDC, 18 decimals), paid as msg.value. */
  nativeFee: bigint
  finality: number
  at: number
}

/** Pure: checks Circle's answer and turns it into a quote (throws on anything unexpected). */
export function parseCctpxQuote(j: any): { signedQuote: Hex; nativeFee: bigint } {
  if (!j || typeof j.signedQuote !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(j.signedQuote)) throw new Error('Circle fee quote unavailable')
  if (typeof j.feeTotalAmount !== 'string' || !/^\d+$/.test(j.feeTotalAmount)) throw new Error('Circle fee quote unavailable')
  // Only Arc's native currency is paid here (msg.value); any other fee token isn't expected.
  if (String(j.feeToken || ZERO_ADDRESS).toLowerCase() !== ZERO_ADDRESS) throw new Error('Unexpected Circle fee token')
  return { signedQuote: j.signedQuote as Hex, nativeFee: BigInt(j.feeTotalAmount) }
}

async function requestQuote(token: CctpxToken, dst: number, amount: bigint, recipient: string, fast: boolean) {
  const r = await fetch(`${IRIS_SANDBOX}/v2/quote/cctpx/${CCTPX_TOKEN_IDS[token]}/${ARC_DOMAIN}/${dst}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amount.toString(), feeToken: ZERO_ADDRESS,
      requests: [{ type: 'FORWARD', params: { msgType: 'TransferMessage', destinationAddress: recipient } }, ...(fast ? [{ type: 'PRE_FINALITY' }] : [])],
    }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!r.ok) throw new Error('Circle fee quote unavailable')
  return parseCctpxQuote(await r.json().catch(() => null))
}

/** Circle's quote for this exact transfer: fast when Circle quotes it, otherwise standard. */
export async function quoteCctpx(p: { token: CctpxToken; destination: string; recipient: string; amount: bigint }): Promise<CctpxQuote> {
  const dst = CCTP_DOMAINS[p.destination]
  if (dst === undefined || !canFastCctp(p.destination)) throw new Error(`${p.token} can't be sent to ${p.destination}`)
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.recipient)) throw new Error('Invalid recipient address')
  let q: { signedQuote: Hex; nativeFee: bigint }
  let finality = FAST
  try { q = await requestQuote(p.token, dst, p.amount, p.recipient, true) }
  catch { q = await requestQuote(p.token, dst, p.amount, p.recipient, false); finality = SLOW }
  return { ...p, ...q, finality, at: Date.now() }
}

/** A quote is used for the transfer only while fresh and for exactly this transfer. */
export const QUOTE_FRESH_MS = 20_000
export function quoteMatches(q: CctpxQuote | null | undefined, p: { token: CctpxToken; destination: string; recipient: string; amount: bigint }, now = Date.now()): q is CctpxQuote {
  return !!q && now - q.at < QUOTE_FRESH_MS && q.token === p.token && q.destination === p.destination
    && q.recipient.toLowerCase() === p.recipient.toLowerCase() && q.amount === p.amount
}

// ── Review's fees ────────────────────────────────────────────────────────────
// Arc gas the wallet pays (USDC): the transfer, plus the approval when the allowance is short.
const APPROVE_GAS = 60_000n
const TRANSFER_GAS = 450_000n

const managers = new Map<string, Promise<Hex>>()
/** The token's TokenManager on Arc, from Circle's service (cached; a failure isn't). */
function tokenManager(token: CctpxToken): Promise<Hex> {
  let p = managers.get(token)
  if (!p) {
    p = rpc('eth_call', [{ to: CCTPX_SERVICE, data: encodeFunctionData({ abi: SERVICE_ABI, functionName: 'resolveTokenManager', args: [CCTPX_TOKEN_IDS[token]] }) }, 'latest'])
      .then(raw => {
        const a = decodeFunctionResult({ abi: SERVICE_ABI, functionName: 'resolveTokenManager', data: raw as Hex }) as Hex
        if (!/^0x[0-9a-fA-F]{40}$/.test(a) || a.toLowerCase() === ZERO_ADDRESS) throw new Error(`${token} isn't set up for transfers on Arc`)
        return a
      })
    managers.set(token, p)
    p.catch(() => managers.delete(token))
  }
  return p
}

async function allowanceOf(tokenAddress: Hex, owner: string, spender: Hex): Promise<bigint> {
  const raw = await rpc('eth_call', [{ to: tokenAddress, data: encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [owner as Hex, spender] }) }, 'latest'])
  return decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: raw as Hex }) as bigint
}

/**
 * Review's fees for an EURC / cirBTC transfer: Circle's fee (USDC) and Arc gas
 * (USDC), with the quote to reuse at Confirm. One quote request and two Arc
 * reads, in parallel - no wallet, no SDK.
 */
export async function fastCctpxFees(p: { token: CctpxToken; tokenAddress: Hex; destination: string; recipient: string; amount: bigint; owner: string }): Promise<{ circleFee: number; networkFee: number; quote: CctpxQuote }> {
  const [quote, gasPriceHex, manager] = await Promise.all([quoteCctpx(p), rpc('eth_gasPrice', []), tokenManager(p.token)])
  const allowance = await allowanceOf(p.tokenAddress, p.owner, manager)
  const gas = TRANSFER_GAS + (allowance < p.amount ? APPROVE_GAS : 0n)
  return { circleFee: Number(quote.nativeFee) / 1e18, networkFee: Number(gas * BigInt(gasPriceHex)) / 1e18, quote }
}

// ── The transfer ─────────────────────────────────────────────────────────────
type StepPayload = { values: { state: 'success' | 'pending' | 'error'; txHash?: string } }

export interface FastCctpxParams {
  account: WalletAccount
  token: CctpxToken
  /** The token's contract on Arc. */
  tokenAddress: Hex
  destination: string
  recipient: string
  /** Token units. */
  amount: bigint
  /** The quote Review showed, reused when it is still fresh and for this exact transfer. */
  quote?: CctpxQuote | null
  onStep: (step: FastCctpStep, payload: StepPayload) => void
  /** The send is out (or may be): from here the transfer settles on its own. */
  onSendSent?: (hash: string) => void
  pollMs?: number
  deliveryTimeoutMs?: number
}

export interface FastCctpxResult {
  state: 'success'
  steps: Array<{ name: string; state: 'success'; txHash?: string }>
}

export async function fastCctpxTransfer(p: FastCctpxParams): Promise<FastCctpxResult> {
  const dst = CCTP_DOMAINS[p.destination]
  if (dst === undefined || !canFastCctp(p.destination)) throw new FastCctpError(`${p.token} can't be sent to ${p.destination}`, 'rejected')
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.recipient)) throw new FastCctpError('Invalid recipient address', 'rejected')
  if (!(p.amount > 0n)) throw new FastCctpError('Enter an amount greater than 0', 'rejected')
  const from = p.account.address
  const pollMs = p.pollMs ?? 1000
  const want = { token: p.token, destination: p.destination, recipient: p.recipient, amount: p.amount }

  // Quote (reused when fresh), token manager, nonce: in parallel.
  const [quote0, manager, nonceHex] = await Promise.all([
    quoteMatches(p.quote, want) ? Promise.resolve(p.quote) : quoteCctpx(want),
    tokenManager(p.token),
    rpc('eth_getTransactionCount', [from, 'pending']),
  ])
  let quote: CctpxQuote = quote0
  let nonce = Number(BigInt(nonceHex))

  // 1. Approve the token manager for exactly this amount (only when short).
  let approveHash: string | undefined
  if (await allowanceOf(p.tokenAddress, from, manager) < p.amount) {
    const data = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [manager, p.amount] })
    approveHash = await sendStep(p.account, { to: p.tokenAddress, data, gas: await estimate(from, p.tokenAddress, data), nonce }, 'The approval')
    nonce += 1
    // The approval took a moment: a quote that has gone stale is asked for again.
    if (!quoteMatches(quote, want)) quote = await quoteCctpx(want)
  }
  p.onStep('approve', { values: { state: 'success', txHash: approveHash } })

  // 2. Send from Arc, Circle's fee as msg.value. Simulated first.
  const data = encodeFunctionData({
    abi: SERVICE_ABI, functionName: 'crossChainTransfer',
    args: [CCTPX_TOKEN_IDS[p.token], p.amount, dst, p.recipient as Hex, ZERO32, quote.finality,
      { signedQuote: quote.signedQuote, refundAddress: from as Hex }, false, '0x'],
  })
  const gas = await estimate(from, CCTPX_SERVICE, data, quote.nativeFee)
  let sendHash: string
  try {
    sendHash = await sendStep(p.account, { to: CCTPX_SERVICE, data, gas, nonce, value: quote.nativeFee }, 'The transfer')
  } catch (e: any) {
    if (e instanceof FastCctpError && e.reason === 'settling' && (e as any).txHash) p.onSendSent?.((e as any).txHash)
    throw e
  }
  p.onStep('burn', { values: { state: 'success', txHash: sendHash } })

  // 3-4. Circle attests and delivers.
  const deadline = Date.now() + (p.deliveryTimeoutMs ?? 10 * 60_000)
  let msg: IrisMessage | null = null
  let sawAttestation = false
  while (Date.now() < deadline) {
    msg = await fetchIrisMessage('Arc_Testnet', sendHash).catch(() => msg)
    if (!sawAttestation && (attested(msg) || forwarded(msg))) { sawAttestation = true; p.onStep('attestation', { values: { state: 'success' } }) }
    if (forwarded(msg)) break
    if (forwardFailed(msg)) {
      throw new FastCctpError(`Circle couldn't deliver this ${p.token} automatically. It is safe - finish it from Multichain Hub → Recover.`, 'settling')
    }
    await sleep(pollMs)
  }
  if (!forwarded(msg)) {
    throw new FastCctpError(`Circle is still delivering this ${p.token}. It will arrive on its own - check ${p.destination.replace(/_/g, ' ')} in a few minutes.`, 'settling')
  }
  const mintHash = msg!.forwardTxHash!
  p.onStep('mint', { values: { state: 'success', txHash: mintHash } })
  return {
    state: 'success',
    steps: [
      { name: 'approve', state: 'success', txHash: approveHash },
      { name: 'transfer', state: 'success', txHash: sendHash },
      { name: 'fetchAttestation', state: 'success' },
      { name: 'forward', state: 'success', txHash: mintHash },
    ],
  }
}
