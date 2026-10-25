// src/wallet/privy.ts
//
// Privy embedded wallets (docs/PRIVY_WALLETS.md) for Google / email accounts.
// Privy keeps the key split in its secure hardware (AWS Nitro enclaves) and
// signs only for requests authorized by the signed-in user; recovery on a new
// device is just the MeshPort sign-in. Privy authenticates users with
// MeshPort's own Supabase session ("custom auth", Supabase JWKS), so there is
// one sign-in.
//
// The Privy SDK is React; it runs in PrivyRoot.tsx (loaded only for signed-in
// Google / email accounts), which registers a bridge here. privyAccount() is a
// WalletAccount like the frame's: Pay, Swap, Bridge, P2P use it as any
// wallet - the app's passcode / biometric approves (Privy's own confirmation
// modals are off), Privy signs, and MeshPort broadcasts through its relay.

import { toAccount } from 'viem/accounts'
import { bytesToHex, type Hex, type TransactionSerializable, type TypedDataDefinition } from 'viem'
import type { WalletAccount } from './account'

const APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() ?? ''
export const privyAppId = (): string => APP_ID
export const privyConfigured = (): boolean => !!APP_ID

/** What PrivyRoot.tsx hands over once Privy is loaded. */
export interface PrivyBridge {
  ready: boolean
  authenticated: boolean
  /** Addresses of this user's Privy embedded Ethereum wallets. */
  wallets: string[]
  createWallet(): Promise<string>
  signTransaction(tx: Record<string, unknown>, address: string): Promise<Hex>
  signMessage(message: string | { raw: Hex }, address: string): Promise<Hex>
  signTypedData(typedData: Record<string, unknown>, address: string): Promise<Hex>
}

let bridge: PrivyBridge | null = null
const waiters = new Set<() => void>()

export function setPrivyBridge(b: PrivyBridge | null): void {
  bridge = b
  for (const w of [...waiters]) w()
}

/** The bridge once Privy is ready and the user is signed in to it (and `test` holds). */
function whenBridge(test: (b: PrivyBridge) => boolean, timeoutMs: number): Promise<PrivyBridge> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (bridge?.ready && bridge.authenticated && test(bridge)) { done(); resolve(bridge) }
    }
    const timer = setTimeout(() => { done(); reject(new Error('Your wallet is taking too long to open - try again')) }, timeoutMs)
    const done = () => { clearTimeout(timer); waiters.delete(check) }
    waiters.add(check)
    check()
  })
}

/** This account's Privy wallet address, creating the wallet the first time. */
export async function ensurePrivyWallet(timeoutMs = 30_000): Promise<Hex> {
  const b = await whenBridge(() => true, timeoutMs)
  return (b.wallets[0] ?? await b.createWallet()) as Hex
}

/** The Privy signer for `address`, when it is this account's Privy wallet. */
export async function restorePrivyAccount(address: string, timeoutMs = 15_000): Promise<WalletAccount | null> {
  if (!privyConfigured()) return null
  const mine = (b: PrivyBridge) => b.wallets.some(w => w.toLowerCase() === address.toLowerCase())
  // Signed in to Privy first; then a moment for the wallet list - an account
  // whose wallet is not a Privy wallet is told so in ~1.5 s, not the full wait.
  try { await whenBridge(() => true, timeoutMs) } catch { return null }
  try { await whenBridge(mine, 1_500) } catch { return null }
  return privyAccount(address)
}

// viem's request → what Privy's signTransaction takes (gasLimit, hex quantities).
function privyTransaction(tx: TransactionSerializable): Record<string, unknown> {
  const hex = (v: unknown) => (typeof v === 'bigint' || typeof v === 'number' ? `0x${v.toString(16)}` : v)
  const t = tx as Record<string, unknown>
  const out: Record<string, unknown> = {
    to: t.to, data: t.data, chainId: t.chainId, nonce: hex(t.nonce), value: hex(t.value ?? 0n),
    gasLimit: hex(t.gas),
  }
  if (t.maxFeePerGas !== undefined) { out.maxFeePerGas = hex(t.maxFeePerGas); out.maxPriorityFeePerGas = hex(t.maxPriorityFeePerGas); out.type = 2 }
  else if (t.gasPrice !== undefined) { out.gasPrice = hex(t.gasPrice); out.type = 0 }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k]
  return out
}

const accounts = new Map<string, WalletAccount>()

export function privyAccount(address: string): WalletAccount {
  const key = address.toLowerCase()
  const hit = accounts.get(key)
  if (hit) return hit
  const open = () => whenBridge(b => b.wallets.some(w => w.toLowerCase() === key), 15_000)
  const base = toAccount({
    address: address as Hex,
    async signMessage({ message }) {
      const m = typeof message === 'string' ? message : { raw: typeof message.raw === 'string' ? message.raw : bytesToHex(message.raw) }
      return (await open()).signMessage(m, address)
    },
    async signTransaction(transaction) {
      return (await open()).signTransaction(privyTransaction(transaction), address)
    },
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData as TypedDataDefinition
      return (await open()).signTypedData({ domain, types, primaryType, message } as Record<string, unknown>, address)
    },
  })
  const account = Object.assign(base, { meshportWallet: true as const, privyWallet: true as const }) as WalletAccount
  accounts.set(key, account)
  return account
}
