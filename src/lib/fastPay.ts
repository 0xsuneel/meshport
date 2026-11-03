// lib/fastPay.ts - Fast Pay session (proof of concept, Google / email Circle wallets)
//
// A Circle signature takes ~3.6 s (Circle's hosted signing page + Circle's
// servers, wallet_events 2 Nov). Fast Pay asks Circle for ONE signature per
// session instead of one per payment:
//
//   session start (after unlock / opening Pay / app load, in the background)
//     1. a fresh random session key, in memory only (never stored or sent)
//     2. MeshPort's relayer gives the key a small gas float (Arc gas is USDC)
//     3. once per wallet: the Circle wallet signs a USDC EIP-2612 permit that
//        lets Permit2 move USDC (typed data - no transaction, no nonce clash
//        with pay-intent's reservations); the key puts it on-chain at once.
//        The signature is kept (localStorage) until it is on-chain, so a
//        reload / lock in the middle doesn't ask Circle for it again - it
//        grants nothing by itself (Permit2 still needs a per-key permit).
//     4. the Circle wallet signs a Permit2 PermitSingle: "this session key may
//        spend up to LIMIT USDC until EXPIRY" (typed data); the key puts it
//        on-chain
//   each payment ≤ what's left (USDC, no order memo), after the PIN
//     the session key signs Permit2.transferFrom([owner → recipient,
//     owner → key: this payment's gas, plus the setup's on the first one])
//     locally (~0.01 s); it goes out through the same relay as every Pay send.
//     The USDC moves FROM the Circle wallet - same address, same balance - and
//     the user pays their own network fee, as on any payment.
//   anything else (bigger, other tokens, order payments, no session yet)
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
interface SavedSession { owner: string; key: string; limit: string; expiresAt: number; payGas: string; payGasEstimate: string; owedGasWei: string; relayer: string | null }
const sessionStoreKey = (owner: string) => `meshport:fastpay-session:${owner.toLowerCase()}`
function loadSaved(owner: string): SavedSession | null {
  try { return JSON.parse(localStorage.getItem(sessionStoreKey(owner)) || 'null') as SavedSession | null } catch { return null }
}
function saveSession(s: Session | null, owner: string): void {
  try {
    if (!s) { localStorage.removeItem(sessionStoreKey(owner)); return }
    const saved: SavedSession = {
      owner: s.owner, key: s.key.address, limit: s.limit.toString(), expiresAt: s.expiresAt,
      payGas: s.payGas.toString(), payGasEstimate: s.payGasEstimate.toString(), owedGasWei: s.owedGasWei.toString(), relayer: s.relayer,
    }
    localStorage.setItem(sessionStoreKey(owner), JSON.stringify(saved))
  } catch { /* private mode */ }
}

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
export const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const
export const ARC_CHAIN_ID = 5042002

export const FAST_PAY_LIMIT_USDC = 100
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
const permitKey = (owner: string) => `meshport:fastpay-usdc-permit:${owner.toLowerCase()}`
function loadPermit(owner: string, nonce: bigint): SavedPermit | null {
  try {
    const p = JSON.parse(localStorage.getItem(permitKey(owner)) || 'null') as SavedPermit | null
    if (!p || p.nonce !== nonce.toString() || Number(p.deadline) * 1000 < Date.now() + 120_000) return null
    return p
  } catch { return null }
}
function savePermit(p: SavedPermit | null, owner: string): void {
  try { if (p) localStorage.setItem(permitKey(owner), JSON.stringify(p)); else localStorage.removeItem(permitKey(owner)) } catch { /* private mode */ }
}

// ── Session state ─────────────────────────────────────────────────────────────
interface Session {
  owner: Hex
  key: SessionAccount
  home: KeyHome
  kept: boolean
  endKey: () => void
  limit: bigint          // USDC, 6 decimals
  spent: bigint          // payments + refunds, sent or possibly sent (pending counts)
  expiresAt: number      // ms
  nonce: number          // the session key's next transaction nonce
  payGas: bigint         // gas limit for one payment
  payGasEstimate: bigint // its estimate (what the refund is based on)
  owedGasWei: bigint     // the setup's gas, repaid by the first payment
  relayer: Hex | null    // where the key's leftover gas goes at the end
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
    remaining: s ? Number(s.limit - s.spent > REFUND_RESERVE ? s.limit - s.spent - REFUND_RESERVE : 0n) / 1e6 : 0,
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

const usdcAtomic = (amount: number) => BigInt(Math.round(amount * 1e6))

/**
 * Whether this payment goes the fast way: a ready session for this wallet,
 * not about to expire, with enough left (keeping a little for the gas
 * refunds). Synchronous - the screens' decisions must not wait.
 */
export function fastPayCovers(owner: string, amount: number): boolean {
  const s = session
  if (!s || !(amount > 0)) return false
  if (s.owner.toLowerCase() !== owner.toLowerCase()) return false
  if (Date.now() > s.expiresAt - EXPIRY_MARGIN_MS) return false
  return usdcAtomic(amount) + REFUND_RESERVE <= s.limit - s.spent
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
function batchData(owner: Hex, to: Hex, amount: bigint, key: Hex, refund: bigint): Hex {
  const details = [{ from: owner, to, amount, token: ARC_USDC_ERC20 }]
  if (refund > 0n) details.push({ from: owner, to: key, amount: refund, token: ARC_USDC_ERC20 })
  return encodeFunctionData({ abi: permit2Abi, functionName: 'transferFrom', args: [details] })
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
  const [p2, nonceHex] = await Promise.all([
    call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, ARC_USDC_ERC20, keyAddr]),
    arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [keyAddr, 'pending'] }),
  ])
  const left = p2[0]
  const expiresAt = Number(p2[1]) * 1000
  if (Date.now() > expiresAt - 10 * 60_000 || left <= REFUND_RESERVE) { await forget(); return false }
  if (gen !== generation) return false
  const { useAuthStore } = await import('@/store')
  const now = useAuthStore.getState()
  if (now.isLocked || now.walletAddress?.toLowerCase() !== owner.toLowerCase()) return false
  const limit = BigInt(saved.limit)
  const { key, end } = await frameKey(keyAddr)
  session = {
    owner, key, home: 'frame', kept: true, endKey: end, limit, spent: limit - left, expiresAt,
    nonce: Number(BigInt(nonceHex?.result ?? '0x0')),
    payGas: BigInt(saved.payGas), payGasEstimate: BigInt(saved.payGasEstimate), owedGasWei: BigInt(saved.owedGasWei),
    relayer: saved.relayer as Hex | null,
  }
  publish('ready')
  const secs = ((performance.now() - t0) / 1000).toFixed(2)
  void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] resumed ${secs}, ${(Number(left) / 1e6).toFixed(2)} left, key in frame`)).catch(() => {})
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
  const limit = usdcAtomic(FAST_PAY_LIMIT_USDC)

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
  const [permit2Allowance, usdcNonce, p2] = await Promise.all([
    call<bigint>(ARC_USDC_ERC20, usdcAbi, 'allowance', [owner, PERMIT2]),
    call<bigint>(ARC_USDC_ERC20, usdcAbi, 'nonces', [owner]),
    call<readonly [bigint, number, number]>(PERMIT2, permit2Abi, 'allowance', [owner, ARC_USDC_ERC20, key.address]),
  ])
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

  // 3. Once per wallet: let Permit2 move this wallet's USDC (EIP-2612, typed
  // data) - reusing one Circle already signed if a set-up was interrupted.
  let firstTime = false
  if (permit2Allowance < limit) {
    firstTime = true
    let saved = loadPermit(owner, usdcNonce)
    if (!saved) {
      const deadline = BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S)
      const sig = await signer.signTypedData({
        domain: usdcPermitDomain, types: usdcPermitTypes, primaryType: 'Permit',
        message: { owner, spender: PERMIT2, value: maxUint256, nonce: usdcNonce, deadline },
      })
      saved = { owner, nonce: usdcNonce.toString(), deadline: deadline.toString(), sig }
      savePermit(saved, owner)
      mark('usdc-permit')
    } else mark('usdc-permit-reused')
    const { v, yParity, r, s } = parseSignature(saved.sig)
    await sendAsKey(ARC_USDC_ERC20, encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
      args: [owner, PERMIT2, maxUint256, BigInt(saved.deadline), Number(v ?? BigInt(yParity + 27)), r, s] }))
    savePermit(null, owner) // used: the nonce moved on
    mark('usdc-permit-onchain')
  }
  if (!live()) return false

  // 4. The session grant (Permit2 PermitSingle, typed data): amount + expiry, on-chain.
  const permitSingle = {
    details: { token: ARC_USDC_ERC20, amount: limit, expiration: Math.floor(expiresAt / 1000), nonce: Number(p2[2]) },
    spender: key.address,
    sigDeadline: BigInt(Math.floor(now / 1000) + SIG_DEADLINE_S),
  }
  const grantSig = await signer.signTypedData({ domain: permit2Domain, types: permitSingleTypes, primaryType: 'PermitSingle', message: permitSingle })
  mark('grant')
  if (!live()) return false
  await sendAsKey(PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'permit', args: [owner, permitSingle, grantSig] }))
  mark('grant-onchain')

  // Gas for one payment + refund (1-unit transfers, now that the allowance exists).
  const payGasEstimate = await estimate(key.address, PERMIT2, batchData(owner, owner, 1n, key.address, 1n))
  if (!live()) return false
  const still = useAuthStore.getState()
  if (still.walletAddress?.toLowerCase() !== owner.toLowerCase()) return false

  session = {
    owner, key, home, kept: keyKept, endKey, limit, spent: 0n, expiresAt, nonce,
    payGas: BigInt(Math.ceil(Number(payGasEstimate) * PAY_GAS_HEADROOM)), payGasEstimate,
    owedGasWei: setupGas * gasPrice, relayer,
  }
  if (keyKept) saveSession(session, owner)
  kept = true
  publish('ready')
  mark('ready')
  void import('./errorReport').then(m => m.reportPerf(`[perf fastpay setup] ${marks.join(', ')}, key in ${home}${firstTime ? ' (first-time Permit2 approval)' : ''}`)).catch(() => {})
  return true
  } finally {
    if (!kept) endKey() // a set-up that didn't finish leaves no key behind
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
const PAYMENT_PATHS = ['/pay', '/chat']
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
export async function sendFastPay(p: { owner: string; to: Hex; amount: number; idempotencyKey?: string }): Promise<{ txHash: Hex; state: 'success' | 'failed' | 'pending'; blockNumber?: string }> {
  const s = session
  if (!s || !fastPayCovers(p.owner, p.amount)) throw new FastPayNotSent('No Fast Pay session for this payment')
  if (p.idempotencyKey && sentByKey.has(p.idempotencyKey)) {
    const { waitForConfirmation } = await import('./arcService')
    const h = sentByKey.get(p.idempotencyKey)! as Hex
    return { txHash: h, ...(await waitForConfirmation(h)) }
  }
  // This payment's passcode, checked by the frame: one approval, one signature.
  const pin = takePin()
  if (!pin) throw new FastPayNotSent('No passcode for this payment')
  try {
    const { callWallet } = await import('@/wallet/frameClient')
    await callWallet('fastpay:approve', { owner: s.owner, passcode: pin })
  } catch (e) {
    const code = (e as { code?: string })?.code
    throw new FastPayNotSent(`Frame refused the passcode (${code ?? 'error'})`)
  }
  const { relaySend, sendFeeCap, currentGasPrice } = await import('./arcService')
  const [feeCap, gasPrice] = await Promise.all([sendFeeCap(), currentGasPrice().catch(() => 0n)])
  const amount = usdcAtomic(p.amount)
  const owed = s.owedGasWei
  const refund = gasPrice > 0n ? refundUnits(s.payGasEstimate, gasPrice, owed) : 0n
  if (refund > REFUND_RESERVE) throw new FastPayNotSent('Gas refund above the reserve')
  const nonce = s.nonce
  s.nonce++
  s.spent += amount + refund // counted up front: a pending payment may still land
  s.owedGasWei = 0n
  if (s.kept) saveSession(s, s.owner)
  publish()
  try {
    const data = batchData(s.owner, p.to, amount, s.key.address, refund)
    const sent = await relaySend(s.key as any, { to: PERMIT2, data, gas: s.payGas, nonce, maxFeePerGas: feeCap }, h => {
      if (p.idempotencyKey) sentByKey.set(p.idempotencyKey, h)
    })
    if (sent.state === 'failed') { s.spent -= amount + refund; s.owedGasWei += owed; publish() }
    return { txHash: sent.txHash, state: sent.state, blockNumber: sent.blockNumber }
  } catch (e) {
    // relaySend throws only when every node refused it - nothing was sent.
    s.spent -= amount + refund
    s.owedGasWei += owed
    s.nonce = Math.min(s.nonce, nonce)
    if (s.kept) saveSession(s, s.owner)
    publish()
    throw new FastPayNotSent(e instanceof Error ? e.message : 'Fast Pay send refused')
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
