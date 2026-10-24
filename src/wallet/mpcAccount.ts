// src/wallet/mpcAccount.ts
//
// MPC wallets in the app (docs/MPC_WALLET.md): create one, and use one as an
// ordinary viem account - so the ethers and Circle App Kit bridges in
// account.ts work with it unchanged. Every signature is the phone's share
// (wallet frame) and MeshPort's (/api/wallet-mpc) together; this file only
// carries their encrypted boxes (mpcClient.ts).

import { toAccount } from 'viem/accounts'
import { bytesToHex, serializeTransaction, type TransactionSerializable } from 'viem'
import { callWallet, WalletFrameError } from './frameClient'
import { plainTransaction, type WalletAccount } from './account'
import { mpcSign, mpcSignup, type MpcFrame, type MpcPost } from './mpcClient'
import type { EcdsaSig, Hex } from './mpc/protocol'

/**
 * Where a signup's time went, in ms: `phone` = the wallet frame computing,
 * `server` = MeshPort computing (its Server-Timing), `other` = the rest
 * (network, loading, waiting).
 */
export interface MpcTiming { total: number; phone: number; server: number; other: number }

let timing: MpcTiming | null = null
const timed = async <T>(key: 'phone', f: () => Promise<T>): Promise<T> => {
  const t = performance.now()
  try { return await f() } finally { if (timing) timing[key] += performance.now() - t }
}

const frame: MpcFrame = {
  keygenBegin: () => timed('phone', () => callWallet('mpc:keygen-begin', {})),
  keygenNext: (session, reply) => timed('phone', () => callWallet('mpc:keygen-next', { session, reply })),
  keygenFinish: (session, address) => timed('phone', () => callWallet('mpc:keygen-finish', { session, address })),
  signBegin: (address, request) => timed('phone', () => callWallet('mpc:sign-begin', { address, request })),
  signNext: (session, reply) => timed('phone', () => callWallet('mpc:sign-next', { session, reply })),
}

const post: MpcPost = async (body) => {
  const { authApiHeaders } = await import('@/lib/supabase')
  const r = await fetch('/api/wallet-mpc', { method: 'POST', headers: await authApiHeaders(), body: JSON.stringify(body) })
  if (timing) {
    // Server-Timing: "auth;dur=…, init;dur=…, mpc;dur=…, total;dur=…" - the server's own time.
    const total = /total;dur=(\d+)/.exec(r.headers.get('Server-Timing') ?? '')
    if (total) timing.server += Number(total[1])
  }
  const reply = await r.json().catch(() => ({}))
  if (!r.ok) throw new WalletFrameError('failed', reply?.error || `Wallet service error (${r.status})`)
  return reply
}

/** 65-byte r‖s‖v, the form signMessage / signTypedData return. */
const joined = (s: EcdsaSig): Hex => `${s.r}${s.s.slice(2)}${s.v.toString(16)}` as Hex

/** EIP-712 values as JSON can carry them (bigint → decimal string; hashTypedData takes both). */
function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]))
  return v
}

const cache = new Map<string, WalletAccount>()

/** The MPC wallet at `address` as a viem account. */
export function mpcWalletAccount(address: string): WalletAccount {
  const key = address.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit
  const a = address as Hex
  const sign = (request: Parameters<typeof mpcSign>[3]) => mpcSign(frame, post, a, request)
  const base = toAccount({
    address: a,
    async signMessage({ message }) {
      const m = typeof message === 'string' ? message : { raw: typeof message.raw === 'string' ? message.raw : bytesToHex(message.raw) }
      return joined(await sign({ kind: 'message', message: m }))
    },
    async signTransaction(transaction) {
      const tx = plainTransaction(transaction) as TransactionSerializable
      const s = await sign({ kind: 'tx', tx: serializeTransaction(tx) })
      return serializeTransaction(tx, { r: s.r, s: s.s, yParity: s.v - 27 })
    },
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData as Record<string, unknown>
      return joined(await sign({ kind: 'typed', typedData: jsonSafe({ domain, types, primaryType, message }) as Record<string, unknown> }))
    },
  })
  const account = Object.assign(base, { meshportWallet: true as const, mpc: true as const }) as WalletAccount
  cache.set(key, account)
  return account
}

/** The signed-in account's MPC wallet address, or null. */
export async function getMpcWallet(): Promise<Hex | null> {
  return (await post({ action: 'wallet' })).address ?? null
}

/** Get the MPC wallet ready to sign (worker, module, share) - call when a screen that may sign opens. */
export function mpcWarm(address?: string): Promise<void> {
  return callWallet('mpc:warm', { address }).then(() => undefined, () => undefined)
}

/** Speed check: how long this device takes for a full 3-party key generation (no network). */
export function mpcSpeedCheck(): Promise<{ ms: number; cores: number }> {
  return callWallet('mpc:benchmark', {})
}

/** Run `f` (MPC wallet work) and report where its time went. One at a time. */
export async function withMpcTiming<T>(f: () => Promise<T>): Promise<{ value: T; timing: MpcTiming }> {
  const t = { total: 0, phone: 0, server: 0, other: 0 }
  timing = t
  const start = performance.now()
  try {
    const value = await f()
    t.total = performance.now() - start
    t.other = Math.max(0, t.total - t.phone - t.server)
    return { value, timing: t }
  } finally { timing = null }
}

/** Create the signed-in user's MPC wallet (Google / email sign-in required), and where the time went. */
export async function createMpcWallet(): Promise<{ account: WalletAccount; timing: MpcTiming }> {
  const { value, timing: t } = await withMpcTiming(() => mpcSignup(frame, post))
  return { account: mpcWalletAccount(value), timing: t }
}
