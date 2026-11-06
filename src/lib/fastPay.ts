// lib/fastPay.ts - Fast Pay session (proof of concept, Google / email Circle wallets)
//
// A Circle signature takes ~3.6 s (Circle's hosted signing page + Circle's
// servers, wallet_events 2 Nov). Fast Pay asks Circle for ONE signature per
// session instead of one per payment:
//
//   session start (after unlock / opening Pay / app load, in the background)
//     1. a fresh random session key, in memory only (never stored or sent)
//     2. MeshPort's relayer gives the key a small gas float (Arc gas is USDC)
//     3. once per wallet and token (USDC; EURC / cirBTC when held): the Circle
//        wallet signs an EIP-2612 permit that lets Permit2 move it (typed data - no transaction, no nonce clash
//        with pay-intent's reservations); the key puts it on-chain at once.
//        The signature is kept (localStorage) until it is on-chain, so a
//        reload / lock in the middle doesn't ask Circle for it again - it
//        grants nothing by itself (Permit2 still needs a per-key permit).
//     4. the Circle wallet signs ONE Permit2 PermitBatch: "this session key may
//        spend up to ~$100 of each of these tokens until EXPIRY" (typed data);
//        the key puts it on-chain
//   each payment ≤ what's left of its token (USDC, EURC, cirBTC; no order memo), after the PIN
//     the session key signs Permit2.transferFrom([owner → recipient,
//     owner → key: this payment's gas, plus the setup's on the first one])
//     locally (~0.01 s); it goes out through the same relay as every Pay send.
//     The USDC moves FROM the Circle wallet - same address, same balance - and
//     the user pays their own network fee, as on any payment.
//   anything else (bigger, swaps / bridges, order payments, no session yet)
//     the normal Circle path, unchanged.
//   app closed / locked / reopened: the session carries on - the frame keeps
//     its key sealed to this device and it is reopened (~1 s, no Circle
//     signature); every payment still needs the passcode.
//   session end (expiry / logout / switched off): the key sends what's left
//     of its gas back to the relayer, then it is dropped.
//
// Passcode: every payment's PIN is checked by the wallet frame itself too
// (wallet-frame/src/fastPayGate.ts): the frame signs a payment only with an
// approval from that PIN - not because the app asked.
//
// Security: the session key has no execution rights over the Circle wallet.
// Its only power is Permit2's allowance, capped on-chain by amount AND expiry
// (Permit2 AllowanceTransfer) - a leaked key can take at most what is left of
// the limit, only until it expires. Logout / switching off drops the key.
// The key lives only in the wallet frame (web); the native app moves it to
// Android Keystore / iOS Keychain.
//
// Facts this relies on, verified 3 Nov on Arc testnet / docs:
//   Permit2 at the canonical address (Arc docs, contract addresses - Testnet;
//   eth_getCode, DOMAIN_SEPARATOR); USDC ERC-20 at 0x3600…0000 with
//   allowance / transferFrom (Arc docs) and EIP-2612 (name "USDC", version "2",
//   nonces()); Circle user-controlled wallets sign EIP-712 typed data
//   (/user/sign/typedData; Permit2 approvals are a documented use).
//   Field 3 Nov 05:53: setup 12.8 s, a payment 0.55 s after the PIN.

import { create } from 'zustand'
import {
  decodeFunctionResult, encodeFunctionData, maxUint256, parseSignature, type Hex,
} from 'viem'
import { arcRpcJson } from './arc'
import { lastKnownEurcPrice } from './eurcPrice'
import { lastKnownBtcPrice } from './btcPrice'
import { onPasscodeVerified } from './security'

// ── The session key: in the wallet frame when it can, else in memory here ────
/** What Fast Pay needs from a session key: its address and transaction signing. */
export interface SessionAccount { address: Hex; signTransaction: (tx: any) => Promise<Hex> }
export type KeyHome = 'frame'
/**
 * A fresh session key. Preferred: made and kept inside the wallet frame (its
 * own origin - nothing in this page can read it; the frame only signs Fast
 * Pay's own calls). A frame from before Fast Pay doesn't know these requests
 * ('unsupported'): then, for this proof of concept, the key is kept in this
 * module's memory instead (never stored). The set-up line says which.
 */
async function frameKey(address: Hex): Promise<{ key: SessionAccount; end: () => void }> {
  const [{ callWallet }, { plainTransaction }] = await Promise.all([import('@/wallet/frameClient'), import('@/wallet/account')])
  return {
    key: { address, signTransaction: async (tx: any) => (await callWallet('session:sign', { address, transaction: plainTransaction(tx) })).serialized },
    end: () => { void callWallet('session:end', { address }).catch(() => {}) },
  }
}
async function newSessionKey(owner: Hex): Promise<{ key: SessionAccount; home: KeyHome; kept: boolean; end: () => void }> {
  // Only in the wallet frame: there its payment signatures need the passcode,
  // checked by the frame itself (wallet-frame/src/fastPayGate.ts). A frame
  // that can't (older, or no passcode confirmed yet) means no Fast Pay - never
  // a key kept out here, where nothing would check the passcode.
  const { callWallet } = await import('@/wallet/frameClient')
  // keep: sealed to this device in the frame, so the session survives the app closing.
  const { address, kept } = await callWallet('session:create', { keep: true, owner })
  return { ...(await frameKey(address)), home: 'frame', kept: kept === true }
}

// ── A session kept across app restarts ───────────────────────────────────────
// Field 3 Nov 08:16-08:18: three app opens in three minutes, each one a new
// set-up (a Circle signature, ~10 s) - and a payment made right after opening
// always beat it. A session whose key the frame kept (sealed to this device)
// is reopened instead: only public facts are stored here (no key); what's
// left and when it ends are read back from Permit2 on-chain.
interface SavedSession {
  owner: string; key: string; expiresAt: number; payGas: string; payGasEstimate: string; owedGasWei: string; relayer: string | null
  /** Each token's cap (atomic). Saved before EURC / cirBTC: `limit` = the USDC cap. */
  limits?: Partial<Record<FastToken, string>>
  limit?: string
  /** The shared Express limit and what is spent of it (USD). Absent: saved before the shared limit. */
  limitUsd?: number
  spentUsd?: number
}
const sessionStoreKey = (owner: string) => `meshport:fastpay-session:${owner.toLowerCase()}`
function loadSaved(owner: string): SavedSession | null {
  try { return JSON.parse(localStorage.getItem(sessionStoreKey(owner)) || 'null') as SavedSession | null } catch { return null }
}
function saveSession(s: Session | null, owner: string): void {
  try {
    if (!s) { localStorage.removeItem(sessionStoreKey(owner)); return }
    const saved: SavedSession = {
      owner: s.owner, key: s.key.address, expiresAt: s.expiresAt,
      limits: Object.fromEntries(Object.entries(s.grants).map(([t, g]) => [t, g!.limit.toString()])),
      payGas: s.payGas.toString(), payGasEstimate: s.payGasEstimate.toString(), owedGasWei: s.owedGasWei.toString(), relayer: s.relayer,
      limitUsd: s.limitUsd, spentUsd: s.spentUsd,
    }
    localStorage.setItem(sessionStoreKey(owner), JSON.stringify(saved))
  } catch { /* private mode */ }
}

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
export const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const
export const ARC_CHAIN_ID = 5042002

export const ARC_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const
export const ARC_CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as const

/**
 * The tokens Fast Pay pays in. Each has its own on-chain cap in the session
 * grant, worth about FAST_PAY_LIMIT_USD at set-up. All three are Circle
 * FiatToken-style ERC-20s with EIP-2612 permit, version "2" (DOMAIN_SEPARATOR
 * checked on Arc testnet 3 Nov - fastPay.arc.integration.test.ts).
 * Gas refunds are always paid in USDC (Arc's gas token).
 */
export type FastToken = 'USDC' | 'EURC' | 'cirBTC'
export const FAST_TOKENS: Record<FastToken, { address: Hex; decimals: number; permitName: string }> = {
  USDC:   { address: '0x3600000000000000000000000000000000000000', decimals: 6, permitName: 'USDC' },
  EURC:   { address: ARC_EURC, decimals: 6, permitName: 'EURC' },
  cirBTC: { address: ARC_CIRBTC, decimals: 8, permitName: 'Circle Wrapped Bitcoin' },
}
const TOKEN_ORDER: FastToken[] = ['USDC', 'EURC', 'cirBTC']
export function isFastToken(t: string): t is FastToken { return t === 'USDC' || t === 'EURC' || t === 'cirBTC' }
const atomic = (token: FastToken, amount: number) => BigInt(Math.round(amount * 10 ** FAST_TOKENS[token].decimals))
const fromAtomic = (token: FastToken, units: bigint) => Number(units) / 10 ** FAST_TOKENS[token].decimals

// ── Express (formerly "Fast Pay"): one shared limit ─────────────────────────
// One dollar limit for everything Express does - Pay, Swap, Transfer, Bring,
// in any token - chosen by the user: $100 or $300 per session. Not a limit per
// token: a $60 EURC payment and a $40 swap use up a $100 limit together.
// On-chain, each granted token's Permit2 cap is worth the whole limit (so any
// mix fits); the shared total is counted here, in USD at the last known price.
// Anything Express can't cover - over what's left, a token without a price,
// the session not ready, or an Express send that fails before anything went
// out - goes the normal way (the Circle wallet), never refused.
export const EXPRESS_LIMITS = [100, 300] as const
export type ExpressLimit = typeof EXPRESS_LIMITS[number]
export const FAST_PAY_LIMIT_USD: ExpressLimit = 100
/** @deprecated see expressLimitUsd(). */
export const FAST_PAY_LIMIT_USDC = FAST_PAY_LIMIT_USD
const LIMIT_KEY = 'meshport:express-limit'
/** The user's chosen Express limit (USD, shared by everything). */
export function expressLimitUsd(): ExpressLimit {
  try { const v = Number(localStorage.getItem(LIMIT_KEY)); return (EXPRESS_LIMITS as readonly number[]).includes(v) ? v as ExpressLimit : FAST_PAY_LIMIT_USD } catch { return FAST_PAY_LIMIT_USD }
}
/** Sets the limit for the next session (the screen restarts a running one). */
export function setExpressLimitUsd(v: ExpressLimit): void {
  try { localStorage.setItem(LIMIT_KEY, String(v)) } catch { /* private mode */ }
}
/** A token's USD price right now, synchronously (0 = unknown: Express doesn't cover it). */
export function expressUsdPrice(token: FastToken): number {
  if (token === 'USDC') return 1
  try { return token === 'EURC' ? lastKnownEurcPrice() || 0 : lastKnownBtcPrice() || 0 } catch { return 0 }
}
/** Room kept for the gas refunds (USD), so the last payment's refund always fits. */
const REFUND_RESERVE_USD = 0.05
export const FAST_PAY_SESSION_MS = 2 * 60 * 60_000
/** A payment isn't started on a session about to expire. */
const EXPIRY_MARGIN_MS = 60_000
const SIG_DEADLINE_S = 30 * 60
/** Gas limit for one payment: the estimate × 1.5 (only gas used is paid). */
const PAY_GAS_HEADROOM = 1.5
/** Kept back from the limit for the payments' own gas refunds (USDC 6-dec): 0.05 USDC. */
const REFUND_RESERVE = 50_000n
/** 1 USDC unit of the ERC-20 interface (6 dec) in native wei (18 dec). */
const WEI_PER_UNIT = 1_000_000_000_000n
const NATIVE_TRANSFER_GAS = 21_000n

// ── EIP-712 (exported for tests: they must hash to the on-chain domains) ─────
export const usdcPermitDomain = { name: 'USDC', version: '2', chainId: ARC_CHAIN_ID, verifyingContract: ARC_USDC_ERC20 } as const
export const tokenPermitDomain = (t: FastToken) => ({ name: FAST_TOKENS[t].permitName, version: '2', chainId: ARC_CHAIN_ID, verifyingContract: FAST_TOKENS[t].address }) as const
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
/** One signature, every token's cap: the session grant. */
export const permitBatchTypes = {
  PermitDetails: permitSingleTypes.PermitDetails,
  PermitBatch: [
    { name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

// ── ABIs ──────────────────────────────────────────────────────────────────────
export const usdcAbi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
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
    type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'permitBatch', type: 'tuple', components: [
        { name: 'details', type: 'tuple[]', components: permitDetailsTuple.components }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
      ] },
      { name: 'signature', type: 'bytes' },
    ],
  },
  {
    type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'token', type: 'address' }],
  },
  {
    // The owner cancels allowances at once (amount → 0): Fast Pay's "turn off".
    type: 'function', name: 'lockdown', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'approvals', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }] }],
  },
  {
    // Batch: the payment and the key's gas refund in one transaction.
    type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'transferDetails', type: 'tuple[]', components: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'token', type: 'address' },
    ] }],
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

// ── The one-time USDC permit, kept until it is on-chain ──────────────────────
// Survives a reload / lock in the middle of the set-up, so Circle isn't asked
// for it twice. Bound to the wallet and to its USDC permit nonce: once used
// (or replaced by any other permit) it is invalid, and it is dropped.
interface SavedPermit { owner: string; nonce: string; deadline: string; sig: Hex }
const permitKey = (owner: string, token: FastToken = 'USDC') => `meshport:fastpay-${token === 'USDC' ? 'usdc' : token}-permit:${owner.toLowerCase()}`
function loadPermit(owner: string, nonce: bigint, token: FastToken = 'USDC'): SavedPermit | null {
  try {
    const p = JSON.parse(localStorage.getItem(permitKey(owner, token)) || 'null') as SavedPermit | null
    if (!p || p.nonce !== nonce.toString() || Number(p.deadline) * 1000 < Date.now() + 120_000) return null
    return p
  } catch { return null }
}
function savePermit(p: SavedPermit | null, owner: string, token: FastToken = 'USDC'): void {
  try { if (p) localStorage.setItem(permitKey(owner, token), JSON.stringify(p)); else localStorage.removeItem(permitKey(owner, token)) } catch { /* private mode */ }
}

// ── Session state ─────────────────────────────────────────────────────────────
interface Session {
  owner: Hex
  key: SessionAccount
  home: KeyHome
  kept: boolean
  endKey: () => void
  /** Each granted token's cap and what is spent of it (atomic; payments + USDC refunds, pending counts). USDC always. */
  grants: Partial<Record<FastToken, { limit: bigint; spent: bigint }>>
  expiresAt: number      // ms
  nonce: number          // the session key's next transaction nonce
  payGas: bigint         // gas limit for one payment
  payGasEstimate: bigint // its estimate (what the refund is based on)
  owedGasWei: bigint     // the setup's gas, repaid by the first payment
  relayer: Hex | null    // where the key's leftover gas goes at the end
  /** The shared Express limit (USD) and what is spent of it: payments, swaps, transfers, brings and gas refunds. */
  limitUsd: number
  spentUsd: number
}
let session: Session | null = null
let starting: Promise<boolean> | null = null
let generation = 0

export type FastPayPhase = 'off' | 'starting' | 'ready' | 'error'
export const useFastPay = create<{
  phase: FastPayPhase
  /** USDC left (what payments can use: the refund reserve kept back). */
  remaining: number
  /** What is left of each granted token. */
  remainingBy: Partial<Record<FastToken, number>>
  /** The shared limit (USD) and what is left of it. */
  limitUsd: number
  remainingUsd: number
  expiresAt: number
  error: string | null
}>(() => ({ phase: 'off', remaining: 0, remainingBy: {}, limitUsd: 0, remainingUsd: 0, expiresAt: 0, error: null }))
/** USD still free under the shared limit (the refund room kept back). */
function leftUsd(s: Session): number {
  return Math.max(0, s.limitUsd - s.spentUsd - REFUND_RESERVE_USD)
}
/** What a payment in `token` can still use (USDC keeps the refund reserve back). */
function leftFor(s: Session, token: FastToken): bigint {
  const g = s.grants[token]
  if (!g) return 0n
  const left = g.limit - g.spent - (token === 'USDC' ? REFUND_RESERVE : 0n)
  return left > 0n ? left : 0n
}
function publish(phase?: FastPayPhase, error: string | null = null) {
  const s = session
  const remainingBy: Partial<Record<FastToken, number>> = {}
  if (s) for (const t of TOKEN_ORDER) if (s.grants[t]) remainingBy[t] = fromAtomic(t, leftFor(s, t))
  useFastPay.setState({
    phase: phase ?? (s ? 'ready' : 'off'),
    remaining: remainingBy.USDC ?? 0,
    remainingBy,
    limitUsd: s?.limitUsd ?? 0,
    remainingUsd: s ? Math.floor(leftUsd(s) * 100) / 100 : 0,
    expiresAt: s?.expiresAt ?? 0,
    error,
  })
}

/**
 * Lock / logout / switched off: the key is dropped (memory only). Before that
 * it sends its leftover gas back to the relayer (best effort). Its on-chain
 * allowance runs out at expiry.
 */
export function endFastPaySession(): void {
  const s = session
  generation++
  session = null
  starting = null
  publish('off')
  if (!s) return
  saveSession(null, s.owner)
  // The leftover gas back to the relayer first (the key signs it), then the key is dropped.
  void (s.relayer ? returnLeftover(s) : Promise.resolve()).catch(() => {}).finally(() => s.endKey())
}

async function returnLeftover(s: Session): Promise<void> {
  const [{ relayArcSend, sendFeeCap }, bal] = await Promise.all([
    import('./arcService'),
    arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [s.key.address, 'latest'] }),
  ])
  const balance = BigInt(bal?.result ?? '0x0')
  const feeCap = await sendFeeCap()
  const value = balance - NATIVE_TRANSFER_GAS * feeCap
  if (value <= NATIVE_TRANSFER_GAS * feeCap) return // not worth a transaction
  await relayArcSend(s.key as any, { to: s.relayer!, value, gas: NATIVE_TRANSFER_GAS, nonce: s.nonce, maxFeePerGas: feeCap })
}


/**
 * Whether this payment goes the fast way: a ready session for this wallet,
 * not about to expire, this token granted, with enough left of it - and of
 * USDC for the gas refund. Synchronous - the screens' decisions must not wait.
 */
export function fastPayCovers(owner: string, amount: number, token: string = 'USDC'): boolean {
  const s = session
  if (!s || !(amount > 0) || !isFastToken(token)) return false
  if (s.owner.toLowerCase() !== owner.toLowerCase()) return false
  if (Date.now() > s.expiresAt - EXPIRY_MARGIN_MS) return false
  const units = atomic(token, amount)
  if (!(units > 0n) || units > leftFor(s, token)) return false
  // The shared limit: this amount, in USD, must fit what is left of it.
  const price = expressUsdPrice(token)
  if (!(price > 0) || amount * price > leftUsd(s) + 1e-9) return false
  // The refund is USDC: a non-USDC payment needs the reserve still there.
  if (token !== 'USDC') { const u = s.grants.USDC; if (!u || u.limit - u.spent < REFUND_RESERVE) return false }
  return true
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
/** The payment + refund batch (Permit2 transferFrom(AllowanceTransferDetails[])). */
function batchData(owner: Hex, to: Hex, amount: bigint, key: Hex, refund: bigint, token: FastToken = 'USDC'): Hex {
  const details: Array<{ from: Hex; to: Hex; amount: bigint; token: Hex }> = [{ from: owner, to, amount, token: FAST_TOKENS[token].address }]
  if (refund > 0n) details.push({ from: owner, to: key, amount: refund, token: ARC_USDC_ERC20 })
  return encodeFunctionData({ abi: permit2Abi, functionName: 'transferFrom', args: [details] })
}

/**
 * Each token's cap for a new session: worth about FAST_PAY_LIMIT_USD now.
 * USDC exactly; EURC and cirBTC at today's price (no price: not granted).
 */
async function tokenCaps(limitUsd: number = FAST_PAY_LIMIT_USD): Promise<Partial<Record<FastToken, bigint>>> {
  const [eur, btc] = await Promise.all([
    import('./eurcPrice').then(m => m.fetchEurcPriceUsd()).catch(() => 0),
    import('./btcPrice').then(m => m.fetchBtcPriceUsd()).catch(() => 0),
  ])
  // Each worth the whole shared limit: any mix of tokens fits (the shared total is counted in the app).
  const cap = (t: FastToken, usdPerToken: number) => usdPerToken > 0 ? atomic(t, Math.floor(limitUsd / usdPerToken * 10 ** FAST_TOKENS[t].decimals) / 10 ** FAST_TOKENS[t].decimals) : 0n
  return { USDC: atomic('USDC', limitUsd), EURC: cap('EURC', eur), cirBTC: cap('cirBTC', btc) }
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

/**
 * Reopen this wallet's kept session after an app restart: the frame unseals
 * its key; what's left, the expiry and the key's next nonce come from the
 * chain. No Circle signature. False: none, ended, or the frame lost it.
 */
async function resume(owner: Hex, gen: number): Promise<boolean> {
  const saved = loadSaved(owner)
  if (!saved || saved.owner.toLowerCase() !== owner.toLowerCase()) return false
  const t0 = performance.now()
  const forget = async () => {
    saveSession(null, owner)
    try { const { callWallet } = await import('@/wallet/frameClient'); await callWallet('session:end', { address: saved.key }) } catch { /* gone already */ }
  }
  if (Date.now() > saved.expiresAt - 10 * 60_000) { await forget(); return false }
  let restored = false
  try {
    const { callWallet } = await import('@/wallet/frameClient')
    restored = (await callWallet('session:restore', { address: saved.key })).restored
  } catch { return false }
  if (!restored) { saveSession(null, owner); return false }
  const keyAddr = saved.key as Hex
  const limits: Partial<Record<FastToken, bigint>> = {}
  for (const [t, v] of Object.entries(saved.limits ?? (saved.limit ? { USDC: saved.limit } : {}))) if (isFastToken(t) && v) limits[t] = BigInt(v)
  const tokens = TOKEN_ORDER.filter(t => limits[t] != null)
  if (!limits.USDC) { await forget(); return false }
  const [nonceHex, ...p2s] = await Promise.all([
    arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [keyAddr, 'pending'] }),
    ...tokens.map(t => call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, FAST_TOKENS[t].address, keyAddr])),
  ])
  const grants: Session['grants'] = {}
  tokens.forEach((t, i) => { const left = p2s[i][0]; grants[t] = { limit: limits[t]!, spent: limits[t]! > left ? limits[t]! - left : 0n } })
  const usdc = p2s[0]
  const left = usdc[0]
  const expiresAt = Number(usdc[1]) * 1000
  if (Date.now() > expiresAt - 10 * 60_000 || left <= REFUND_RESERVE) { await forget(); return false }
  if (gen !== generation) return false
  const { useAuthStore } = await import('@/store')
  const now = useAuthStore.getState()
  if (now.isLocked || now.walletAddress?.toLowerCase() !== owner.toLowerCase()) return false
  const { key, end } = await frameKey(keyAddr)
  session = {
    owner, key, home: 'frame', kept: true, endKey: end, grants, expiresAt,
    nonce: Number(BigInt(nonceHex?.result ?? '0x0')),
    payGas: BigInt(saved.payGas), payGasEstimate: BigInt(saved.payGasEstimate), owedGasWei: BigInt(saved.owedGasWei),
    relayer: saved.relayer as Hex | null,
    // Saved before the shared limit: its USDC cap was the limit, and what is spent is read back from the chain.
    limitUsd: saved.limitUsd ?? fromAtomic('USDC', limits.USDC),
    spentUsd: Math.max(saved.spentUsd ?? 0, tokens.reduce((sum, t) => sum + fromAtomic(t, grants[t]!.spent) * expressUsdPrice(t), 0)),
  }
  publish('ready')
  const secs = ((performance.now() - t0) / 1000).toFixed(2)
  const extra = tokens.filter(t => t !== 'USDC').map(t => ` + ${t}`).join('')
  void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] resumed ${secs}, ${(Number(left) / 1e6).toFixed(2)} left${extra}, key in frame`)).catch(() => {})
  return true
}

async function start(gen: number): Promise<boolean> {
  const { useAuthStore } = await import('@/store')
  const auth = useAuthStore.getState()
  if (auth.walletSource !== 'circle' || auth.isLocked || !auth.walletAddress || !auth.signer) return false
  const { isCircleAccount } = await import('@/wallet/circle')
  if (!isCircleAccount(auth.signer)) return false
  const signer = auth.signer as unknown as CircleSigner
  const owner = auth.walletAddress as Hex
  if (await resume(owner, gen)) return true
  publish('starting')
  const t0 = performance.now()
  const marks: string[] = []
  const mark = (name: string) => marks.push(`${name} ${((performance.now() - t0) / 1000).toFixed(2)}`)
  const live = () => gen === generation && !useAuthStore.getState().isLocked

  // 1. The session key: random, in the wallet frame (or, PoC fallback, memory here).
  const { key, home, kept: keyKept, end: endKey } = await newSessionKey(owner)
  let kept = false
  try {
  const now = Date.now()
  const expiresAt = now + FAST_PAY_SESSION_MS

  // On-chain state + 2. the gas float - in parallel, before anything is signed,
  // so whatever Circle signs can go on-chain at once.
  const { authApiHeaders } = await import('./supabase')
  const gasP = (async () => {
    const r = await fetch('/api/bridge-relay', {
      method: 'POST', headers: await authApiHeaders(),
      body: JSON.stringify({ action: 'fastpay_gas', address: key.address }),
    })
    const out = await r.json().catch(() => null) as { from?: string; error?: string } | null
    if (!r.ok) throw new Error(out?.error || `gas float refused (${r.status})`)
    return /^0x[0-9a-fA-F]{40}$/.test(out?.from ?? '') ? out!.from as Hex : null
  })()
  gasP.catch(() => {})
  // Per token: Permit2's ERC-20 allowance, the permit nonce, the balance, and
  // Permit2's nonce for this key - plus the prices for the caps.
  const reads = await Promise.all(TOKEN_ORDER.map(async t => {
    const addr = FAST_TOKENS[t].address
    const [allowance, permitNonce, balance, p2] = await Promise.all([
      call<bigint>(addr, usdcAbi, 'allowance', [owner, PERMIT2]),
      call<bigint>(addr, usdcAbi, 'nonces', [owner]),
      t === 'USDC' ? Promise.resolve(1n) : call<bigint>(addr, usdcAbi, 'balanceOf', [owner]).catch(() => 0n),
      call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, addr, key.address]),
    ])
    return { t, allowance, permitNonce, balance, p2nonce: Number(p2[2]) }
  }))
  const limitUsd = expressLimitUsd()
  const caps = await tokenCaps(limitUsd)
  // USDC always (it pays the gas refunds); EURC / cirBTC when the wallet holds some.
  const granted = reads.filter(r => r.t === 'USDC' || (r.balance > 0n && (caps[r.t] ?? 0n) > 0n))
  mark('reads')
  const relayer = await gasP
  mark('gas')

  const { relayArcSend, sendFeeCap, currentGasPrice } = await import('./arcService')
  const [feeCap, gasPrice] = await Promise.all([sendFeeCap(), currentGasPrice().catch(() => 0n)])
  let nonce = 0
  let setupGas = 0n
  const sendAsKey = async (to: Hex, data: Hex) => {
    const est = await estimate(key.address, to, data)
    const sent = await relayArcSend(key as any, { to, data, gas: est * 13n / 10n, nonce, maxFeePerGas: feeCap })
    nonce++
    setupGas += est
    if (sent.state !== 'success') throw new Error(`setup transaction ${sent.state}`)
  }

  // 3. Once per wallet and token: let Permit2 move it (EIP-2612, typed data) -
  // reusing one Circle already signed if a set-up was interrupted.
  const firstTime: FastToken[] = []
  for (const r of granted) {
    if (r.allowance >= caps[r.t]!) continue
    firstTime.push(r.t)
    let saved = loadPermit(owner, r.permitNonce, r.t)
    if (!saved) {
      const deadline = BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S)
      const sig = await signer.signTypedData({
        domain: tokenPermitDomain(r.t), types: usdcPermitTypes, primaryType: 'Permit',
        message: { owner, spender: PERMIT2, value: maxUint256, nonce: r.permitNonce, deadline },
      })
      saved = { owner, nonce: r.permitNonce.toString(), deadline: deadline.toString(), sig }
      savePermit(saved, owner, r.t)
      mark(`${r.t.toLowerCase()}-permit`)
    } else mark(`${r.t.toLowerCase()}-permit-reused`)
    const { v, yParity, r: rr, s: ss } = parseSignature(saved.sig)
    await sendAsKey(FAST_TOKENS[r.t].address, encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
      args: [owner, PERMIT2, maxUint256, BigInt(saved.deadline), Number(v ?? BigInt(yParity + 27)), rr, ss] }))
    savePermit(null, owner, r.t) // used: the nonce moved on
    mark(`${r.t.toLowerCase()}-permit-onchain`)
    if (!live()) return false
  }
  if (!live()) return false

  // 4. The session grant - ONE Circle signature for every token (Permit2
  // PermitBatch, typed data): each token's cap + the expiry, on-chain.
  const expiration = Math.floor(expiresAt / 1000)
  const permitBatch = {
    details: granted.map(r => ({ token: FAST_TOKENS[r.t].address, amount: caps[r.t]!, expiration, nonce: r.p2nonce })),
    spender: key.address,
    sigDeadline: BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S),
  }
  const grantSig = await signer.signTypedData({ domain: permit2Domain, types: permitBatchTypes, primaryType: 'PermitBatch', message: permitBatch })
  mark('grant')
  if (!live()) return false
  await sendAsKey(PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'permit', args: [owner, permitBatch, grantSig] }))
  mark('grant-onchain')
  const grants: Session['grants'] = {}
  for (const r of granted) grants[r.t] = { limit: caps[r.t]!, spent: 0n }

  // Gas for one payment + refund (1-unit transfers, now that the allowance exists).
  const payGasEstimate = await estimate(key.address, PERMIT2, batchData(owner, owner, 1n, key.address, 1n))
  if (!live()) return false
  const still = useAuthStore.getState()
  if (still.walletAddress?.toLowerCase() !== owner.toLowerCase()) return false

  session = {
    owner, key, home, kept: keyKept, endKey, grants, expiresAt, nonce,
    payGas: BigInt(Math.ceil(Number(payGasEstimate) * PAY_GAS_HEADROOM)), payGasEstimate,
    owedGasWei: setupGas * gasPrice, relayer, limitUsd, spentUsd: 0,
  }
  if (keyKept) saveSession(session, owner)
  kept = true
  publish('ready')
  mark('ready')
  const tokensNote = granted.length > 1 ? `, tokens ${granted.map(r => r.t).join('+')}` : ''
  void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] ${marks.join(', ')}, key in ${home}${tokensNote}${firstTime.length ? ` (first-time Permit2 approval: ${firstTime.join(', ')})` : ''}`)).catch(() => {})
  return true
  } finally {
    if (!kept) endKey() // a set-up that didn't finish leaves no key behind
  }
}

// ── Turning it off: the limit cancelled on-chain ─────────────────────────────
// Dropping the key (endFastPaySession) is not enough if it had leaked: its
// Permit2 allowance would stay valid until it expires. Turning Fast Pay off
// therefore also has the Circle wallet send Permit2.lockdown for the session
// key and every token it was granted - its allowance becomes 0 at once. One
// Circle signature; skipped when nothing is left on-chain.
export type StopResult = { cancelled: true; txHash: Hex } | { cancelled: false; reason: 'nothing-left' | 'no-wallet' | 'failed'; error?: string; expiresAt?: number }

export async function stopFastPay(): Promise<StopResult> {
  const { useAuthStore } = await import('@/store')
  const auth = useAuthStore.getState()
  const owner = (session?.owner ?? auth.walletAddress) as Hex | null
  // The spender and its tokens: the live session, else the one kept for a restart.
  let spender: Hex | null = session?.key.address ?? null
  let tokens: FastToken[] = session ? TOKEN_ORDER.filter(t => session!.grants[t]) : []
  const expiresAt = session?.expiresAt
  if (!spender && owner) {
    const saved = loadSaved(owner)
    if (saved) {
      spender = saved.key as Hex
      tokens = TOKEN_ORDER.filter(t => (saved.limits ?? (saved.limit ? { USDC: saved.limit } : {}))[t])
    }
  }
  setFastPayEnabled(false) // ends the session: the key is dropped (its leftover gas goes back)
  if (!owner || !spender || !tokens.length) return { cancelled: false, reason: 'nothing-left' }
  if (auth.walletSource !== 'circle' || !auth.signer || auth.walletAddress?.toLowerCase() !== owner.toLowerCase()) return { cancelled: false, reason: 'no-wallet', expiresAt }
  try {
    // Only what still has something to cancel (amount left, not expired).
    const nowS = Math.floor(Date.now() / 1000)
    const live = (await Promise.all(tokens.map(async t => {
      const [amount, exp] = await call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, FAST_TOKENS[t].address, spender])
      return amount > 0n && Number(exp) > nowS ? t : null
    }))).filter((t): t is FastToken => !!t)
    if (!live.length) return { cancelled: false, reason: 'nothing-left' }
    const data = encodeFunctionData({ abi: permit2Abi, functionName: 'lockdown', args: [live.map(t => ({ token: FAST_TOKENS[t].address, spender: spender! }))] })
    const [nonceHex, gas] = await Promise.all([
      arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
      estimate(owner, PERMIT2, data),
    ])
    const { relayArcSend } = await import('./arcService')
    const sent = await relayArcSend(auth.signer as any, { to: PERMIT2, data, gas: gas * 13n / 10n, nonce: Number(BigInt(nonceHex?.result ?? '0x0')) })
    if (sent.state === 'failed') throw new Error('cancel transaction failed')
    void import('./errorReport').then(m => m.reportPerf(`[perf fastpay stop] limit cancelled on-chain (${live.join('+')}) ${sent.txHash.slice(0, 12)}`)).catch(() => {})
    return { cancelled: true, txHash: sent.txHash }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    void import('./errorReport').then(m => m.reportPerf(`[perf fastpay stop] cancel failed: ${error.slice(0, 160)}`)).catch(() => {})
    return { cancelled: false, reason: 'failed', error, expiresAt }
  }
}

// ── The passcode, checked by the wallet frame ────────────────────────────────
// A Google / email wallet's passcode is checked only in the wallet frame
// (lib/circlePasscode.ts) - unlocking included. A passcode that passes on a
// payment screen (Pay, chat Pay) is noted here for a minute; a Fast Pay
// payment hands it to the frame, which checks it again and allows ONE
// signature - so a passcode typed to unlock never approves a payment.
const PIN_TTL_MS = 60_000
let pendingPin: { pin: string; at: number } | null = null
onPasscodeVerified(async pin => {
  if (!fastPayEnabled()) return
  const { useAuthStore } = await import('@/store')
  const { walletSource, walletAddress } = useAuthStore.getState()
  if (walletSource !== 'circle' || !walletAddress) return
  // Only a PIN entered on a payment screen can approve a payment - not one
  // typed to unlock, in Security or to reveal a phrase.
  if (onPaymentScreen()) pendingPin = { pin, at: Date.now() }
})
/** The screens whose PIN sheet pays with sendUSDC (Pay, chat Pay). */
const PAYMENT_PATHS = ['/pay', '/chat', '/multichain', '/swap']
function onPaymentScreen(): boolean {
  try { const p = window.location.pathname; return PAYMENT_PATHS.some(x => p === x || p.startsWith(x + '/')) } catch { return false }
}
function takePin(): string | null {
  const p = pendingPin
  pendingPin = null
  return p && Date.now() - p.at < PIN_TTL_MS ? p.pin : null
}

/** Turning Fast Pay on, with the passcode the person just confirmed: the frame must hold its check. Resolves when the session is ready (true) or couldn't start. */
export async function enableFastPay(passcode: string): Promise<boolean> {
  const { useAuthStore } = await import('@/store')
  const { FRAME_PASSCODE } = await import('./security')
  if (useAuthStore.getState().passcode !== FRAME_PASSCODE) {
    const { adoptCirclePasscode } = await import('./circlePasscode')
    if (!(await adoptCirclePasscode(passcode))) throw new Error("Couldn't reach your wallet - try again")
    useAuthStore.getState().setPasscode(FRAME_PASSCODE)
  }
  setFastPayEnabled(true)
  return maybeStartFastPay() // true once the session is ready
}

// ── Pay ───────────────────────────────────────────────────────────────────────
/** Where a Fast Pay payment's time went (seconds), e.g.
 *  "[perf fastpay pay] approve 0.02 (fast check), gas 0.15, sign 0.03, send 0.85, confirm 0.10, total 1.15 (success)". */
function reportFastPayTiming(lap: Record<string, number>, total: number, fullCheck: boolean, state: string): void {
  const s = (k: string) => lap[k] == null ? '-' : (lap[k] / 1000).toFixed(2)
  const line = `[perf fastpay pay] approve ${s('approve')} (${fullCheck ? 'full' : 'fast'} check), gas ${s('gas')}, sign ${s('sign')}, send ${s('send')}, confirm ${s('confirm')}, total ${(total / 1000).toFixed(2)} (${state})`
  void import('./errorReport').then(m => m.reportPerf(line)).catch(() => {})
}

/** Thrown before anything was broadcast: the caller may pay the normal way. */
export class FastPayNotSent extends Error {}

const sentByKey = new Map<string, string>() // idempotency key → tx hash (a retry never pays twice)

/**
 * The gas refund for one payment (USDC 6-dec units, rounded up): its gas at
 * today's price, plus the setup's gas on the first payment. Pure (tests).
 */
export function refundUnits(payGasEstimate: bigint, gasPriceWei: bigint, owedGasWei: bigint): bigint {
  const wei = payGasEstimate * gasPriceWei + owedGasWei
  return (wei + WEI_PER_UNIT - 1n) / WEI_PER_UNIT
}

/**
 * A USDC payment through the session (call only after fastPayCovers and the PIN).
 * Returns what sendUSDC returns. FastPayNotSent: nothing went out.
 */
export async function sendFastPay(p: { owner: string; to: Hex; amount: number; idempotencyKey?: string; token?: FastToken }): Promise<{ txHash: Hex; state: 'success' | 'failed' | 'pending'; blockNumber?: string }> {
  const s = session
  const token: FastToken = p.token ?? 'USDC'
  if (!s || !fastPayCovers(p.owner, p.amount, token)) throw new FastPayNotSent('No Fast Pay session for this payment')
  if (p.idempotencyKey && sentByKey.has(p.idempotencyKey)) {
    const { waitForConfirmation } = await import('./arcService')
    const h = sentByKey.get(p.idempotencyKey)! as Hex
    return { txHash: h, ...(await waitForConfirmation(h)) }
  }
  // This payment's passcode, checked by the frame: one approval, one signature.
  const pin = takePin()
  if (!pin) throw new FastPayNotSent('No passcode for this payment')
  const t0 = performance.now()
  const lap: Record<string, number> = {}
  let fullCheck = false
  try {
    const { callWallet } = await import('@/wallet/frameClient')
    fullCheck = (await callWallet('fastpay:approve', { owner: s.owner, passcode: pin })).full === true
    lap.approve = performance.now() - t0
  } catch (e) {
    const code = (e as { code?: string })?.code
    throw new FastPayNotSent(`Frame refused the passcode (${code ?? 'error'})`)
  }
  const { relaySend, sendFeeCap, currentGasPrice } = await import('./arcService')
  const tGas = performance.now()
  const [feeCap, gasPrice] = await Promise.all([sendFeeCap(), currentGasPrice().catch(() => 0n)])
  lap.gas = performance.now() - tGas
  const amount = atomic(token, p.amount)
  const owed = s.owedGasWei
  const refund = gasPrice > 0n ? refundUnits(s.payGasEstimate, gasPrice, owed) : 0n
  if (refund > REFUND_RESERVE) throw new FastPayNotSent('Gas refund above the reserve')
  const usdc = s.grants.USDC!
  const grant = s.grants[token]!
  if (token !== 'USDC' && refund > usdc.limit - usdc.spent) throw new FastPayNotSent('No USDC left for the gas refund')
  // Counted up front: a pending payment may still land. Undone below if nothing was sent.
  const usd = p.amount * expressUsdPrice(token) + fromAtomic('USDC', refund)
  const count = (sign: 1n | -1n) => { grant.spent += sign * amount; usdc.spent += sign * refund; s.spentUsd += Number(sign) * usd }
  const nonce = s.nonce
  s.nonce++
  count(1n)
  s.owedGasWei = 0n
  if (s.kept) saveSession(s, s.owner)
  publish()
  try {
    const data = batchData(s.owner, p.to, amount, s.key.address, refund, token)
    // The key's signature (in the frame) timed apart from the send.
    let signMs = 0
    const timedKey = { address: s.key.address, signTransaction: async (tx: any) => { const a = performance.now(); try { return await s.key.signTransaction(tx) } finally { signMs += performance.now() - a } } }
    const tSend = performance.now()
    let hashAt = 0
    const sent = await relaySend(timedKey as any, { to: PERMIT2, data, gas: s.payGas, nonce, maxFeePerGas: feeCap }, h => {
      hashAt = performance.now()
      if (p.idempotencyKey) sentByKey.set(p.idempotencyKey, h)
    })
    lap.sign = signMs
    lap.send = (hashAt || performance.now()) - tSend - signMs
    if (hashAt) lap.confirm = performance.now() - hashAt
    reportFastPayTiming(lap, performance.now() - t0, fullCheck, token === 'USDC' ? sent.state : `${sent.state}, ${token}`)
    if (sent.state === 'failed') { count(-1n); s.owedGasWei += owed; publish() }
    return { txHash: sent.txHash, state: sent.state, blockNumber: sent.blockNumber }
  } catch (e) {
    // relaySend throws only when every node refused it - nothing was sent.
    count(-1n)
    s.owedGasWei += owed
    s.nonce = Math.min(s.nonce, nonce)
    if (s.kept) saveSession(s, s.owner)
    publish()
    throw new FastPayNotSent(e instanceof Error ? e.message : 'Fast Pay send refused')
  }
}

// ── Express Transfer (Arc → another chain over CCTP) ─────────────────────────
// No Circle signature: after the passcode check (one approval), the session
// key pulls the amount (+ its gas refund) to itself and MeshPort's fee to the
// fee wallet in ONE Permit2 batch, then approves exactly the amount to
// Circle's TokenMessengerV2 and burns it to the recipient - three Arc
// transactions signed in the wallet frame, sent back to back. If anything
// fails after the pull, the key sends the amount straight back to the owner
// and the transfer goes the normal way (ExpressNotSent).
const TOKEN_MESSENGER_V2_ARC = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Hex
const APPROVE_GAS = 70_000n
const BURN_GAS = 260_000n
const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const

let _frameCaps: Promise<string[]> | null = null
/** Whether the wallet frame lets session keys do `cap` ('pay', 'transfer') - older frames: pay only. */
export async function frameCan(cap: string): Promise<boolean> {
  _frameCaps ??= import('@/wallet/frameClient').then(m => m.callWallet('session:capabilities', {} as Record<string, never>))
    .then(r => r.capabilities).catch(() => { _frameCaps = null; return ['pay'] })
  return (await _frameCaps).includes(cap)
}

/** Whether Express can make this transfer: `totalUsdc` = burn + MeshPort's fee. */
export function expressCoversTransfer(owner: string, totalUsdc: number): boolean {
  return fastPayCovers(owner, totalUsdc, 'USDC')
}

/**
 * Send a Transfer's burn through the Express session. `burnData` is the
 * TokenMessengerV2 call (depositForBurn / WithHook) for exactly `amount`.
 * ExpressNotSent: nothing moved (or it was returned) - transfer the normal way.
 */
export async function expressTransfer(p: { owner: string; amount: bigint; fee: bigint; feeWallet: Hex | null; burnData: Hex }): Promise<{ burnHash: Hex }> {
  const s = session
  const total = p.amount + (p.feeWallet ? p.fee : 0n)
  if (!s || !expressCoversTransfer(p.owner, fromAtomic('USDC', total))) throw new FastPayNotSent('Express does not cover this transfer')
  if (!(await frameCan('transfer'))) throw new FastPayNotSent('This wallet frame cannot do Express transfers yet')
  const pin = takePin()
  if (!pin) throw new FastPayNotSent('No passcode for this transfer')
  const t0 = performance.now()
  const lap: Record<string, number> = {}
  let fullCheck = false
  try {
    const { callWallet } = await import('@/wallet/frameClient')
    fullCheck = (await callWallet('fastpay:approve', { owner: s.owner, passcode: pin })).full === true
    lap.approve = performance.now() - t0
  } catch (e) {
    throw new FastPayNotSent(`Frame refused the passcode (${(e as { code?: string })?.code ?? 'error'})`)
  }
  const { relaySend, sendFeeCap, currentGasPrice } = await import('./arcService')
  const [feeCap, gasPrice] = await Promise.all([sendFeeCap(), currentGasPrice().catch(() => 0n)])
  const owed = s.owedGasWei
  // The key's gas for all three transactions, refunded in USDC with the pull.
  const refund = gasPrice > 0n ? refundUnits(s.payGasEstimate + APPROVE_GAS + BURN_GAS, gasPrice, owed) : 0n
  const usdc = s.grants.USDC!
  if (total + refund > leftFor(s, 'USDC') + REFUND_RESERVE) throw new FastPayNotSent('Not enough left of the Express limit')
  const usd = fromAtomic('USDC', total + refund)
  const count = (sign: 1n | -1n) => { usdc.spent += sign * (total + refund); s.spentUsd += Number(sign) * usd }
  const nonce0 = s.nonce
  count(1n)
  s.owedGasWei = 0n
  s.nonce += 3
  if (s.kept) saveSession(s, s.owner)
  publish()
  const details: Array<{ from: Hex; to: Hex; amount: bigint; token: Hex }> = [{ from: s.owner, to: s.key.address, amount: p.amount + refund, token: ARC_USDC_ERC20 }]
  if (p.feeWallet && p.fee > 0n) details.push({ from: s.owner, to: p.feeWallet, amount: p.fee, token: ARC_USDC_ERC20 })
  const pullData = encodeFunctionData({ abi: permit2Abi, functionName: 'transferFrom', args: [details] })
  const approveData = encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [TOKEN_MESSENGER_V2_ARC, p.amount] })
  const undo = () => { count(-1n); s.owedGasWei += owed; s.nonce = Math.min(s.nonce, nonce0); if (s.kept) saveSession(s, s.owner); publish() }
  // 1. The pull (the passcode-approved signature).
  let pulled
  try {
    pulled = await relaySend(s.key as any, { to: PERMIT2, data: pullData, gas: s.payGas + (p.feeWallet ? s.payGas / 3n : 0n), nonce: nonce0, maxFeePerGas: feeCap }, () => {})
  } catch (e) {
    undo()
    throw new FastPayNotSent(e instanceof Error ? e.message : 'Express pull refused')
  }
  if (pulled.state !== 'success') {
    if (pulled.state === 'failed') { undo(); throw new FastPayNotSent('Express pull failed on-chain') }
    throw new Error('The transfer is still confirming - check Activity before trying again')
  }
  lap.pull = performance.now() - t0
  // 2-3. Approve exactly the amount, then the burn.
  try {
    const a = await relaySend(s.key as any, { to: ARC_USDC_ERC20, data: approveData, gas: APPROVE_GAS, nonce: nonce0 + 1, maxFeePerGas: feeCap }, () => {})
    if (a.state === 'failed') throw new Error('approve failed')
    const b = await relaySend(s.key as any, { to: TOKEN_MESSENGER_V2_ARC, data: p.burnData, gas: BURN_GAS, nonce: nonce0 + 2, maxFeePerGas: feeCap }, () => {})
    if (b.state === 'failed') throw new Error('burn failed')
    lap.burn = performance.now() - t0
    void import('./errorReport').then(m => m.reportPerf(`[perf express transfer] approve ${(lap.approve / 1000).toFixed(2)} (${fullCheck ? 'full' : 'fast'} check), pull ${(lap.pull / 1000).toFixed(2)}, burn ${(lap.burn / 1000).toFixed(2)} (${b.state})`)).catch(() => {})
    return { burnHash: b.txHash }
  } catch (e) {
    // The amount came to the key but wasn't burned: straight back to the owner
    // (the fee and the gas refund stay - those transactions ran).
    try {
      const back = await relaySend(s.key as any, { to: s.owner, value: p.amount * WEI_PER_UNIT, gas: NATIVE_TRANSFER_GAS, nonce: nonce0 + 3, maxFeePerGas: feeCap }, () => {})
      s.nonce = nonce0 + 4
      usdc.spent -= p.amount; s.spentUsd -= fromAtomic('USDC', p.amount)
      if (s.kept) saveSession(s, s.owner)
      publish()
      if (back.state !== 'failed') throw new FastPayNotSent(`Express transfer stopped (${e instanceof Error ? e.message : 'error'}) - the amount was returned`)
    } catch (r) { if (r instanceof FastPayNotSent) throw r }
    throw new Error("The transfer couldn't finish and the amount is held for you - open Recover or contact support")
  }
}

// A wallet provider's unlock (store.unlock), and this module loading (the app
// loads it a moment after start - a reload that didn't lock): start in the
// background.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('meshport:wallet-unlocked', () => { void maybeStartFastPay() })
    if (import.meta.env?.MODE !== 'test') setTimeout(() => { void maybeStartFastPay() }, 2_000)
  } catch { /* no window */ }
}

/** Test hook. */
export function _resetFastPay(): void { generation++; session = null; starting = null; publish('off'); sentByKey.clear() }
/** Test hook: install a session directly. */
export function _setSessionForTest(s: Session | null): void { session = s; publish() }
