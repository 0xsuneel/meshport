// lib/fastPay.ts - Fast Pay session (proof of concept, Google / email Circle wallets)
//
// A Circle signature takes ~3.6 s (Circle's hosted signing page + Circle's
// servers, wallet_events 2 Nov). Fast Pay asks Circle for ONE signature per
// session instead of one per payment:
//
//   session start (after unlock, in the background)
//     1. a fresh random session key, in memory only (never stored or sent)
//     2. once per wallet: the Circle wallet signs a USDC EIP-2612 permit that
//        lets Permit2 move USDC (typed data - no transaction, no nonce clash
//        with pay-intent's reservations)
//     3. the Circle wallet signs a Permit2 PermitSingle: "this session key may
//        spend up to LIMIT USDC until EXPIRY" (typed data)
//     4. MeshPort's relayer gives the session key a tiny gas float (Arc gas is
//        USDC; ~0.0016 per payment)
//     5. the session key submits the permit(s) on-chain
//   each payment ≤ what's left (USDC, no order memo), after the PIN
//     the session key signs Permit2.transferFrom(owner → recipient) locally
//     (~0.01 s) and it goes out through the same relay as every Pay send.
//     The USDC moves FROM the Circle wallet - same address, same balance.
//   anything else (bigger, other tokens, order payments, no session yet)
//     the normal Circle path, unchanged.
//
// Security: the session key has no execution rights over the Circle wallet.
// Its only power is Permit2's allowance, capped on-chain by amount AND expiry
// (Permit2 AllowanceTransfer) - a leaked key can take at most what is left of
// the limit, only until it expires. Lock / logout / reload drops the key.
// PoC: the key lives in this module's memory; the product design moves it to
// the wallet frame (web) or Android Keystore / iOS Keychain (native).
//
// Facts this relies on, verified 3 Nov on Arc testnet / docs:
//   Permit2 at the canonical address (Arc docs, contract addresses - Testnet;
//   eth_getCode, DOMAIN_SEPARATOR); USDC ERC-20 at 0x3600…0000 with
//   allowance / transferFrom (Arc docs) and EIP-2612 (name "USDC", version "2",
//   nonces()); Circle user-controlled wallets sign EIP-712 typed data
//   (/user/sign/typedData; Permit2 approvals are a documented use).

import { create } from 'zustand'
import {
  decodeFunctionResult, encodeFunctionData, maxUint256, parseSignature, type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { arcRpcJson } from './arc'

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
export const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const
export const ARC_CHAIN_ID = 5042002

export const FAST_PAY_LIMIT_USDC = 100
export const FAST_PAY_SESSION_MS = 2 * 60 * 60_000
/** A payment isn't started on a session about to expire. */
const EXPIRY_MARGIN_MS = 60_000
const SIG_DEADLINE_S = 30 * 60
/** Gas limit for one transferFrom: the estimate × 1.5 (only gas used is paid). */
const PAY_GAS_HEADROOM = 1.5

// ── EIP-712 (exported for tests: they must hash to the on-chain domains) ─────
export const usdcPermitDomain = { name: 'USDC', version: '2', chainId: ARC_CHAIN_ID, verifyingContract: ARC_USDC_ERC20 } as const
export const usdcPermitTypes = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const
export const permit2Domain = { name: 'Permit2', chainId: ARC_CHAIN_ID, verifyingContract: PERMIT2 } as const
export const permitSingleTypes = {
  PermitDetails: [
    { name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

// ── ABIs ──────────────────────────────────────────────────────────────────────
export const usdcAbi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
  },
] as const
const permitDetailsTuple = { type: 'tuple', components: [
  { name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
] } as const
export const permit2Abi = [
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
  {
    type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'permitSingle', type: 'tuple', components: [
        { name: 'details', ...permitDetailsTuple }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
      ] },
      { name: 'signature', type: 'bytes' },
    ],
  },
  {
    type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'token', type: 'address' }],
  },
] as const

// ── On/off (per device; the proof of concept's switch) ───────────────────────
const ENABLED_KEY = 'meshport:fast-pay'
export function fastPayEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1' } catch { return false }
}
export function setFastPayEnabled(on: boolean): void {
  try { if (on) localStorage.setItem(ENABLED_KEY, '1'); else localStorage.removeItem(ENABLED_KEY) } catch { /* private mode */ }
  if (!on) endFastPaySession()
}

// ── Session state ─────────────────────────────────────────────────────────────
interface Session {
  owner: Hex
  key: PrivateKeyAccount
  limit: bigint          // USDC, 6 decimals
  spent: bigint          // sent or possibly sent (pending counts)
  expiresAt: number      // ms
  nonce: number          // the session key's next transaction nonce
  payGas: bigint
}
let session: Session | null = null
let starting: Promise<boolean> | null = null
let generation = 0

export type FastPayPhase = 'off' | 'starting' | 'ready' | 'error'
export const useFastPay = create<{ phase: FastPayPhase; remaining: number; expiresAt: number; error: string | null }>(() => ({
  phase: 'off', remaining: 0, expiresAt: 0, error: null,
}))
function publish(phase?: FastPayPhase, error: string | null = null) {
  const s = session
  useFastPay.setState({
    phase: phase ?? (s ? 'ready' : 'off'),
    remaining: s ? Number(s.limit - s.spent) / 1e6 : 0,
    expiresAt: s?.expiresAt ?? 0,
    error,
  })
}

/** Lock / logout / switched off: the key is dropped (memory only). Its on-chain allowance runs out at expiry. */
export function endFastPaySession(): void {
  generation++
  session = null
  starting = null
  publish('off')
}

const usdcAtomic = (amount: number) => BigInt(Math.round(amount * 1e6))

/**
 * Whether this payment goes the fast way: a ready session for this wallet,
 * not about to expire, with enough left. Synchronous - the screens' decisions
 * (skip the Circle preparation) must not wait.
 */
export function fastPayCovers(owner: string, amount: number): boolean {
  const s = session
  if (!s || !(amount > 0)) return false
  if (s.owner.toLowerCase() !== owner.toLowerCase()) return false
  if (Date.now() > s.expiresAt - EXPIRY_MARGIN_MS) return false
  return usdcAtomic(amount) <= s.limit - s.spent
}

// ── Chain reads (Circle's Arc node first, the proxy as fallback - lib/arc) ───
async function call<T>(to: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<T> {
  const data = encodeFunctionData({ abi: abi as any, functionName, args: args as any })
  const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
  if (j?.error) throw new Error(j.error.message || `${functionName} failed`)
  return decodeFunctionResult({ abi: abi as any, functionName, data: j.result }) as T
}
async function estimate(from: Hex, to: Hex, data: Hex): Promise<bigint> {
  const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ from, to, data }] })
  if (j?.error) throw new Error(j.error.message || 'estimateGas failed')
  return BigInt(j.result)
}

// ── Start ─────────────────────────────────────────────────────────────────────
type CircleSigner = { address: Hex; signTypedData: (td: any) => Promise<Hex> }

/**
 * Start a session if Fast Pay is on, the wallet is a Circle wallet, the app is
 * unlocked and none is running. Background work: resolves true when ready,
 * false otherwise; never throws. Single-flight.
 */
export function maybeStartFastPay(): Promise<boolean> {
  if (!fastPayEnabled()) return Promise.resolve(false)
  if (session && Date.now() < session.expiresAt - 10 * 60_000) return Promise.resolve(true)
  if (starting) return starting
  const gen = generation
  starting = start(gen).catch(e => {
    const msg = e instanceof Error ? e.message : String(e)
    void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] failed: ${msg.slice(0, 200)}`)).catch(() => {})
    if (gen === generation) publish('error', msg)
    return false
  }).finally(() => { if (gen === generation) starting = null })
  return starting
}

async function start(gen: number): Promise<boolean> {
  const { useAuthStore } = await import('@/store')
  const auth = useAuthStore.getState()
  if (auth.walletSource !== 'circle' || auth.isLocked || !auth.walletAddress || !auth.signer) return false
  const { isCircleAccount } = await import('@/wallet/circle')
  if (!isCircleAccount(auth.signer)) return false
  const signer = auth.signer as unknown as CircleSigner
  const owner = auth.walletAddress as Hex
  publish('starting')
  const t0 = performance.now()
  const marks: string[] = []
  const mark = (name: string) => marks.push(`${name} ${((performance.now() - t0) / 1000).toFixed(2)}`)

  // 1. The session key: random, memory only.
  const key = privateKeyToAccount(generatePrivateKey())
  const now = Date.now()
  const expiresAt = now + FAST_PAY_SESSION_MS
  const limit = usdcAtomic(FAST_PAY_LIMIT_USDC)

  // What's on-chain already (the Permit2 approval is once per wallet).
  const [permit2Allowance, usdcNonce, p2] = await Promise.all([
    call<bigint>(ARC_USDC_ERC20, usdcAbi, 'allowance', [owner, PERMIT2]),
    call<bigint>(ARC_USDC_ERC20, usdcAbi, 'nonces', [owner]),
    call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, ARC_USDC_ERC20, key.address]),
  ])
  mark('reads')

  // 2. Once per wallet: let Permit2 move this wallet's USDC (EIP-2612, typed data).
  let usdcPermit: { deadline: bigint; v: number; r: Hex; s: Hex } | null = null
  if (permit2Allowance < limit) {
    const deadline = BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S)
    const sig = await signer.signTypedData({
      domain: usdcPermitDomain, types: usdcPermitTypes, primaryType: 'Permit',
      message: { owner, spender: PERMIT2, value: maxUint256, nonce: usdcNonce, deadline },
    })
    const { v, yParity, r, s } = parseSignature(sig)
    usdcPermit = { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s }
    mark('usdc-permit')
  }

  // 3. The session grant (Permit2 PermitSingle, typed data): amount + expiry, on-chain.
  const permitSingle = {
    details: { token: ARC_USDC_ERC20, amount: limit, expiration: Math.floor(expiresAt / 1000), nonce: Number(p2[2]) },
    spender: key.address,
    sigDeadline: BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S),
  }
  const grantSig = await signer.signTypedData({ domain: permit2Domain, types: permitSingleTypes, primaryType: 'PermitSingle', message: permitSingle })
  mark('grant')
  if (gen !== generation) return false

  // 4. Gas float for the session key, from MeshPort's relayer.
  const { authApiHeaders } = await import('./supabase')
  const r = await fetch('/api/bridge-relay', {
    method: 'POST', headers: await authApiHeaders(),
    body: JSON.stringify({ action: 'fastpay_gas', address: key.address }),
  })
  const out = await r.json().catch(() => null) as { txHash?: string; error?: string } | null
  if (!r.ok) throw new Error(out?.error || `gas float refused (${r.status})`)
  mark('gas')

  // 5. The session key puts the permit(s) on-chain.
  const { relayArcSend, sendFeeCap } = await import('./arcService')
  const feeCap = await sendFeeCap()
  let nonce = 0
  const sendAsKey = async (to: Hex, data: Hex) => {
    const gas = (await estimate(key.address, to, data)) * 13n / 10n
    const sent = await relayArcSend(key as any, { to, data, gas, nonce: nonce, maxFeePerGas: feeCap })
    nonce++
    if (sent.state !== 'success') throw new Error(`setup transaction ${sent.state}`)
  }
  if (usdcPermit) {
    await sendAsKey(ARC_USDC_ERC20, encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
      args: [owner, PERMIT2, maxUint256, usdcPermit.deadline, usdcPermit.v, usdcPermit.r, usdcPermit.s] }))
    mark('usdc-permit-onchain')
  }
  await sendAsKey(PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'permit', args: [owner, permitSingle, grantSig] }))
  mark('grant-onchain')

  // Gas for one payment (a 1-unit transfer to the owner, now that the allowance exists).
  const payGas = BigInt(Math.ceil(Number(await estimate(key.address, PERMIT2, encodeFunctionData({
    abi: permit2Abi, functionName: 'transferFrom', args: [owner, owner, 1n, ARC_USDC_ERC20],
  }))) * PAY_GAS_HEADROOM))
  if (gen !== generation) return false
  const still = useAuthStore.getState()
  if (still.isLocked || still.walletAddress?.toLowerCase() !== owner.toLowerCase()) return false

  session = { owner, key, limit, spent: 0n, expiresAt, nonce, payGas }
  publish('ready')
  mark('ready')
  void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] ${marks.join(', ')}${usdcPermit ? ' (first-time Permit2 approval)' : ''}`)).catch(() => {})
  return true
}

// ── Pay ───────────────────────────────────────────────────────────────────────
/** Thrown before anything was broadcast: the caller may pay the normal way. */
export class FastPayNotSent extends Error {}

const sentByKey = new Map<string, string>() // idempotency key → tx hash (a retry never pays twice)

/**
 * A USDC payment through the session (call only after fastPayCovers and the PIN).
 * Returns what sendUSDC returns. FastPayNotSent: nothing went out.
 */
export async function sendFastPay(p: { owner: string; to: Hex; amount: number; idempotencyKey?: string }): Promise<{ txHash: Hex; state: 'success' | 'failed' | 'pending'; blockNumber?: string }> {
  const s = session
  if (!s || !fastPayCovers(p.owner, p.amount)) throw new FastPayNotSent('No Fast Pay session for this payment')
  if (p.idempotencyKey && sentByKey.has(p.idempotencyKey)) {
    const { waitForConfirmation } = await import('./arcService')
    const h = sentByKey.get(p.idempotencyKey)! as Hex
    return { txHash: h, ...(await waitForConfirmation(h)) }
  }
  const amount = usdcAtomic(p.amount)
  const nonce = s.nonce
  s.nonce++
  s.spent += amount // counted up front: a pending payment may still land
  publish()
  const { relaySend, sendFeeCap } = await import('./arcService')
  try {
    const data = encodeFunctionData({ abi: permit2Abi, functionName: 'transferFrom', args: [s.owner, p.to, amount, ARC_USDC_ERC20] })
    const sent = await relaySend(s.key as any, { to: PERMIT2, data, gas: s.payGas, nonce, maxFeePerGas: await sendFeeCap() }, h => {
      if (p.idempotencyKey) sentByKey.set(p.idempotencyKey, h)
    })
    if (sent.state === 'failed') { s.spent -= amount; publish() }
    return { txHash: sent.txHash, state: sent.state, blockNumber: sent.blockNumber }
  } catch (e) {
    // relaySend throws only when every node refused it - nothing was sent.
    s.spent -= amount
    s.nonce = Math.min(s.nonce, nonce)
    publish()
    throw new FastPayNotSent(e instanceof Error ? e.message : 'Fast Pay send refused')
  }
}

// A wallet provider's unlock (store.unlock): start in the background.
if (typeof window !== 'undefined') {
  try { window.addEventListener('meshport:wallet-unlocked', () => { void maybeStartFastPay() }) } catch { /* no window */ }
}

/** Test hook. */
export function _resetFastPay(): void { endFastPaySession(); sentByKey.clear() }
/** Test hook: install a session directly. */
export function _setSessionForTest(s: Session | null): void { session = s; publish() }
