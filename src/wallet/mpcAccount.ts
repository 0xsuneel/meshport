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

const frame: MpcFrame = {
  keygenBegin: () => callWallet('mpc:keygen-begin', {}),
  keygenNext: (session, reply) => callWallet('mpc:keygen-next', { session, reply }),
  keygenFinish: (session, address) => callWallet('mpc:keygen-finish', { session, address }),
  signBegin: (address, request) => callWallet('mpc:sign-begin', { address, request }),
  signNext: (session, reply) => callWallet('mpc:sign-next', { session, reply }),
}

const post: MpcPost = async (body) => {
  const { authApiHeaders } = await import('@/lib/supabase')
  const r = await fetch('/api/wallet-mpc', { method: 'POST', headers: await authApiHeaders(), body: JSON.stringify(body) })
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

/** Create the signed-in user's MPC wallet (Google / email sign-in required). */
export async function createMpcWallet(): Promise<WalletAccount> {
  return mpcWalletAccount(await mpcSignup(frame, post))
}
