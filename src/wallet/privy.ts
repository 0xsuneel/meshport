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
  /** Addresses of this user's Privy embedded Ethereum wallets, once Privy's
   *  wallet iframe has connected them (can take seconds after sign-in). */
  wallets: string[]
  /** The same wallets from the account's own record - known as soon as Privy
   *  has signed in, before the wallet iframe connects them. */
  linked: string[]
  createWallet(): Promise<string>
  signTransaction(tx: Record<string, unknown>, address: string): Promise<Hex>
  signMessage(message: string | { raw: Hex }, address: string): Promise<Hex>
  signTypedData(typedData: Record<string, unknown>, address: string): Promise<Hex>
  /** Addresses of this user's Privy embedded Solana wallets (docs/SOLANA.md). */
  solanaWallets: string[]
  /** Privy has loaded the Solana wallets (before that an empty list means nothing). */
  solanaReady: boolean
  createSolanaWallet(): Promise<string>
  /** Sign a serialized Solana transaction (wire format); returns the signed bytes. */
  signSolanaTransaction(transaction: Uint8Array, address: string): Promise<Uint8Array>
}

let bridge: PrivyBridge | null = null
const waiters = new Set<() => void>()
const listeners = new Set<() => void>()

export function setPrivyBridge(b: PrivyBridge | null): void {
  bridge = b
  // A new Privy (PrivyRoot rebuilt it - a new iframe) has to authenticate
  // its wallets again: their warm-up starts over.
  if (!b) { warmed.clear(); warming.clear() }
  // Privy's SDK is running (PrivyRoot) - not merely this module loaded.
  if (b) void import('@/lib/perfTrace').then(m => m.markStartup('provider')).catch(() => {})
  for (const w of [...waiters]) w()
  for (const l of [...listeners]) l()
  // Wallet readiness (lib/walletReadiness): "Privy lists it" vs "it can sign".
  void import('@/lib/walletReadiness').then(m => m.recompute()).catch(() => {})
  if (b?.ready && b.authenticated) for (const w of b.wallets) void warmPrivySigner(w)
}

// ── Warm-up: authenticate the wallet with Privy before the first payment ───
// Privy authenticates an embedded wallet's session on its FIRST signature
// (inside its iframe, /api/v1/wallets/authenticate) - and that call is slow,
// often 20-45 s. Whatever signs first pays for it. Until 28 Oct the chat-key
// signatures at start happened to be first; once those stopped, the person's
// own payment / swap was - the "36 s" payment and the "47 s" swap. So as soon
// as Privy has connected the wallet (start, unlock, a rebuilt Privy) it signs
// one fixed MeshPort statement - a plain message, never a transaction, it
// can't move anything - and only then is the wallet "ready to sign"
// (privySignerConnected → walletReadiness signer_ready; the lock screen waits
// for it). The payment that follows signs at once.
export const PRIVY_WARM_MESSAGE = 'MeshPort: unlocking this wallet on this device. This signature only checks the wallet is ready - it does not approve any payment.'
const warmed = new Set<string>()
const warming = new Map<string, Promise<boolean>>()
export function warmPrivySigner(address: string): Promise<boolean> {
  const a = address.toLowerCase()
  if (warmed.has(a)) return Promise.resolve(true)
  const running = warming.get(a)
  if (running) return running
  const b = bridge
  if (!b || !b.ready || !b.authenticated || !b.wallets.some(w => w.toLowerCase() === a)) return Promise.resolve(false)
  const p = timed('warm-up', async () => b, x => x.signMessage(PRIVY_WARM_MESSAGE, address))
    .then(() => {
      // Only if it's still the same Privy (not rebuilt meanwhile).
      if (bridge === b || (bridge && bridge.wallets.some(w => w.toLowerCase() === a))) warmed.add(a)
      return true
    })
    .catch(() => false)
    .finally(() => {
      warming.delete(a)
      void import('@/lib/walletReadiness').then(m => m.recompute()).catch(() => {})
    })
  warming.set(a, p)
  return p
}

/** True once Privy's wallet iframe has connected this wallet AND authenticated it (warm-up signed) - a payment signs without waiting. */
export function privySignerConnected(address: string): boolean {
  const a = address.toLowerCase()
  return !!bridge?.ready && !!bridge.authenticated && bridge.wallets.some(w => w.toLowerCase() === a) && warmed.has(a)
}
void import('@/lib/walletReadiness').then(m => m.setPrivyConnectedProbe(privySignerConnected)).catch(() => {})

/** Call `listener` whenever Privy's state changes (screens following the Solana address). */
export function onPrivyChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** This account's Privy Solana address, once Privy is signed in and has one. */
export function privySolanaAddress(): string | null {
  return bridge?.ready && bridge.authenticated ? bridge.solanaWallets[0] ?? null : null
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

/** Sign a Solana transaction (wire format) with this account's Privy Solana wallet. */
export async function privySignSolana(wire: Uint8Array, address: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const b = await whenBridge(() => true, timeoutMs)
  return b.signSolanaTransaction(wire, address)
}

/** This account's Privy Solana address, creating the Solana wallet the first time. */
export async function ensurePrivySolanaWallet(timeoutMs = 30_000): Promise<string> {
  // Wait for Privy's Solana list: an empty list before it has loaded isn't "none".
  const b = await whenBridge(x => x.solanaReady, timeoutMs)
  return b.solanaWallets[0] ?? await b.createSolanaWallet()
}

/** The Privy signer for `address`, when it is this account's Privy wallet. */
/** Privy's state right now, for diagnostics (no addresses). */
export function privyState(address?: string): string {
  if (!bridge) return 'privy not loaded'
  const mine = !!address && bridge.wallets.some(w => w.toLowerCase() === address.toLowerCase())
  const linked = !!address && bridge.linked.some(w => w.toLowerCase() === address.toLowerCase())
  return `ready=${bridge.ready} authenticated=${bridge.authenticated} wallets=${bridge.wallets.length} listed=${mine} linked=${linked}`
}

/**
 * Open `address` as a Privy wallet: as soon as Privy has signed in and the
 * account's record lists it - not when the wallet iframe has connected it,
 * which can take many seconds more (or need a rebuild, PrivyRoot). Signing
 * waits for the iframe by itself (privyAccount). Waiting for the iframe here
 * made a slow start look like a missing wallet: a real Privy wallet was
 * taken for an old device-only one at sign-in, and the first payment after
 * a resume failed with "Couldn't access your wallet".
 * `listWaitMs`: how long to wait, once signed in, for the address to show.
 */
export async function restorePrivyAccount(address: string, timeoutMs = 15_000, listWaitMs = 1_500): Promise<WalletAccount | null> {
  if (!privyConfigured()) return null
  const a = address.toLowerCase()
  const mine = (b: PrivyBridge) => b.linked.some(w => w.toLowerCase() === a) || b.wallets.some(w => w.toLowerCase() === a)
  try { await whenBridge(() => true, timeoutMs) } catch { return null }
  try { await whenBridge(mine, listWaitMs) } catch { return null }
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

/** Typed data as JSON can carry it: Privy sends it to its servers, and
 *  JSON has no BigInt (swap permits carry uint256 values as BigInts). EIP-712
 *  takes integers as decimal strings; a domain chainId stays a number. */
export function jsonTypedData(t: { domain?: unknown; types?: unknown; primaryType?: unknown; message?: unknown }): Record<string, unknown> {
  const plain = (v: unknown): unknown =>
    typeof v === 'bigint' ? v.toString()
    : Array.isArray(v) ? v.map(plain)
    : v && typeof v === 'object' && !(v instanceof Uint8Array) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
    : v instanceof Uint8Array ? bytesToHex(v) : v
  const domain = plain(t.domain ?? {}) as Record<string, unknown>
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId)
  return { domain, types: t.types, primaryType: t.primaryType, message: plain(t.message) }
}

// A signature that fails or takes over 2 s is saved to client_errors (no
// message contents), so slow or failing signing can be seen without a screen.
// Split into waiting for Privy to be signed in and ready, and Privy signing.
// A Privy request that never answers used to hold a screen forever (a bulk
// payout sat on "Restoring wallet signer…" / signing with nothing logged).
// It is reported while still waiting, then given up on - safe, because
// nothing is broadcast without the signature, so a late one is never used.
export const PRIVY_STILL_WAITING_MS = 20_000
export const PRIVY_GIVE_UP_MS = 90_000
export const PRIVY_NO_ANSWER = "Your wallet didn't respond - nothing was sent. Try again."

async function timed<T>(what: string, open: () => Promise<PrivyBridge>, sign: (b: PrivyBridge) => Promise<T>): Promise<T> {
  const started = performance.now()
  let opened = 0
  const s = (ms: number) => (ms / 1000).toFixed(1)
  const parts = () => opened
    ? `waiting for Privy ${s(opened - started)} s, signing ${s(performance.now() - opened)} s`
    : `waiting for Privy ${s(performance.now() - started)} s, not signing yet`
  const report = (text: string) => void import('@/lib/errorReport')
    .then(r => r.reportClientError('rejection', new Error(`[privy ${what}] ${text}`))).catch(() => {})
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let giveUp: ReturnType<typeof setTimeout> | undefined
  try {
    watchdog = setTimeout(() => report(`still waiting after ${s(PRIVY_STILL_WAITING_MS)} s (${parts()})`), PRIVY_STILL_WAITING_MS)
    const noAnswer = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error(PRIVY_NO_ANSWER)), PRIVY_GIVE_UP_MS)
    })
    const out = await Promise.race([(async () => {
      const b = await open()
      opened = performance.now()
      return sign(b)
    })(), noAnswer])
    const ms = performance.now() - started
    if (ms > 2_000) report(`slow: ${s(ms)} s (${parts()})`)
    return out
  } catch (e) {
    report(`failed after ${s(performance.now() - started)} s (${parts()}): ${e instanceof Error ? e.message : String(e)}`)
    // Privy gives up on its own request with an AbortError ("signal is
    // aborted without reason") - nothing was signed, so nothing was sent.
    if (e instanceof Error && (e.name === 'AbortError' || /signal is aborted|aborted/i.test(e.message))) throw new Error(PRIVY_NO_ANSWER)
    throw e
  } finally {
    clearTimeout(watchdog)
    clearTimeout(giveUp)
  }
}

const accounts = new Map<string, WalletAccount>()

export function privyAccount(address: string): WalletAccount {
  const key = address.toLowerCase()
  const hit = accounts.get(key)
  if (hit) return hit
  // Signing needs the wallet iframe connected: wait for it (a stuck one is
  // rebuilt after 8 s - PrivyRoot), up to PRIVY_STILL_WAITING_MS and more.
  const open = () => whenBridge(b => b.wallets.some(w => w.toLowerCase() === key), 45_000)
  const base = toAccount({
    address: address as Hex,
    async signMessage({ message }) {
      const m = typeof message === 'string' ? message : { raw: typeof message.raw === 'string' ? message.raw : bytesToHex(message.raw) }
      return timed('signMessage', open, b => b.signMessage(m, address))
    },
    async signTransaction(transaction) {
      return timed('signTransaction', open, b => b.signTransaction(privyTransaction(transaction), address))
    },
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData as TypedDataDefinition
      return timed('signTypedData', open, b => b.signTypedData(jsonTypedData({ domain, types, primaryType, message }), address))
    },
  })
  const account = Object.assign(base, { meshportWallet: true as const, privyWallet: true as const }) as WalletAccount
  accounts.set(key, account)
  return account
}

// ── Chat identity (end-to-end encrypted chat) ───────────────────────────────
// Created / imported wallets derive the chat seed from the wallet key in the
// frame (lib/chatIdentity.ts); a Privy wallet's key is with Privy, so the
// seed comes from its signature over a fixed statement instead:
//   seed = sha256(signature ‖ "meshport-chat-identity-v2")
// Only usable when Privy signs deterministically (RFC 6979) - otherwise the
// chat key would change and older messages couldn't be read. Checked by
// signing twice: different signatures → no seed (chat stays as before) and
// it's reported. Once per session per wallet.
export const CHAT_SEED_STATEMENT = (address: string) =>
  `MeshPort chat key\n\nThis signature creates the key for your encrypted chats. It moves no funds and costs nothing.\n\nWallet: ${address.toLowerCase()}\nVersion: 2`

const chatSeeds = new Map<string, Promise<Uint8Array>>()
export function privyChatSeed(address: string): Promise<Uint8Array> {
  const key = address.toLowerCase()
  let p = chatSeeds.get(key)
  if (!p) {
    p = (async () => {
      const account = privyAccount(address)
      const message = CHAT_SEED_STATEMENT(address)
      const first = await account.signMessage({ message })
      const second = await account.signMessage({ message })
      if (first.toLowerCase() !== second.toLowerCase()) {
        void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error('[privy chat seed] signatures differ - chat key not derived'))).catch(() => {})
        throw new Error('This wallet cannot make a stable chat key')
      }
      const { sha256 } = await import('@noble/hashes/sha256')
      const sig = first.slice(2)
      const info = new TextEncoder().encode('meshport-chat-identity-v2')
      const bytes = new Uint8Array(sig.length / 2 + info.length)
      for (let i = 0; i < sig.length / 2; i++) bytes[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16)
      bytes.set(info, sig.length / 2)
      return sha256(bytes)
    })()
    chatSeeds.set(key, p)
    p.catch(() => chatSeeds.delete(key))
  }
  return p.then(s => new Uint8Array(s)) // a copy: callers may zero it
}
