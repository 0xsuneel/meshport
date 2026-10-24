// src/wallet/index.ts
//
// The app's wallet API. Every operation that needs the key is a request to
// the wallet frame (protocol.ts); what comes back is an address, a signature,
// a status or a ciphertext - never the key or the recovery phrase.

import { callWallet, WalletFrameError, walletOrigin } from './frameClient'
import { walletAccount, type WalletAccount } from './account'
import type { PasskeyOutcome, PasskeyRequest, WalletKind, WalletStatus } from './protocol'

export { walletAccount, isWalletAccount, toEthersSigner, createWalletAdapter, type WalletAccount } from './account'
export { WalletFrameError, walletOrigin, walletReady } from './frameClient'
export { createMpcWallet, getMpcWallet, mpcSpeedCheck, mpcWalletAccount, mpcWarm, withMpcTiming, type MpcTiming } from './mpcAccount'
export type { PasskeyOutcome, PasskeyRequest, WalletKind, WalletStatus } from './protocol'

export function walletStatus(address: string): Promise<WalletStatus> {
  return callWallet('status', { address })
}

/** A brand-new wallet, made in the frame. */
export async function createWallet(kind: 'create' | 'social-auto', passcode?: string): Promise<WalletAccount> {
  const { address } = await callWallet('create', { kind, passcode })
  return walletAccount(address)
}

/** A phrase / key the user typed. The caller should clear its input right after. */
export async function importWallet(kind: 'import-seed' | 'import-privkey', secret: string, passcode?: string): Promise<WalletAccount> {
  const { address } = await callWallet('import', { kind, secret, passcode })
  return walletAccount(address)
}

/**
 * Open the wallet without asking the user (session / device copy), or with
 * the passcode for create / import wallets. null when it stays locked.
 */
export async function unlockWallet(address: string, passcode?: string): Promise<WalletAccount | null> {
  const { unlocked } = await callWallet('unlock', { address, passcode })
  return unlocked ? walletAccount(address) : null
}

export async function setWalletPasscode(address: string, passcode: string, oldPasscode?: string): Promise<void> {
  await callWallet('set-passcode', { address, passcode, oldPasscode })
}

export function lockWallet(address?: string) { return callWallet('lock', { address }).catch(() => undefined) }
export function forgetWallet(address?: string, everything = false) { return callWallet('forget', { address, everything }).catch(() => undefined) }

export async function chatSeed(address: string): Promise<Uint8Array> {
  const { seed } = await callWallet('chat:seed', { address })
  const h = seed.slice(2)
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Confirm-word check right after a new wallet's phrase was shown. */
export async function checkRecoveryWords(address: string, answers: Record<number, string>): Promise<{ ok: boolean; wrong: number[] }> {
  return callWallet('mnemonic:check', { address, answers })
}

/**
 * URL for wallet-frame/reveal.html showing this wallet's phrase or key - to
 * be put in a visible iframe (components/wallet/WalletSecretFrame.tsx).
 */
export async function revealUrl(address: string, what: 'mnemonic' | 'privateKey', opts: { passcode?: string; theme?: 'dark' | 'light' } = {}): Promise<string> {
  const { ticket } = await callWallet('reveal:grant', { address, what, passcode: opts.passcode })
  return `${walletOrigin()}/reveal.html#t=${ticket}&theme=${opts.theme ?? 'dark'}`
}

// ── Recovery QR / passkey (lib/recoveryQr.ts, lib/walletPasskey.ts) ─────────
export async function createRecoveryQr(address: string, password: string): Promise<string> {
  return (await callWallet('recovery:create', { address, password })).payload
}
export async function openRecoveryQr(address: string, payload: string, password: string): Promise<WalletAccount> {
  await callWallet('recovery:open', { address, payload, password })
  return walletAccount(address)
}
export function wrapWithPasskey(address: string, prf: Uint8Array, salt: Uint8Array) {
  return callWallet('passkey:wrap', { address, prf, salt })
}
export async function openWithPasskey(address: string, p: { prf: Uint8Array; salt: Uint8Array; ct: Uint8Array; iv: Uint8Array }): Promise<WalletAccount> {
  await callWallet('passkey:open', { address, ...p })
  return walletAccount(address)
}

// ── Wallet passkey (Safe owner) ──────────────────────────────────────────────
/**
 * Start a passkey ceremony in the frame: create the Safe's passkey owner, or
 * sign a 32-byte hash with it. Returns the URL for a visible iframe
 * (components/wallet/WalletPasskeyFrame.tsx) and the ticket to wait on.
 */
export async function beginPasskey(request: PasskeyRequest, theme: 'dark' | 'light' = 'dark'): Promise<{ ticket: string; url: string }> {
  const { ticket } = await callWallet('passkey:begin', request)
  return { ticket, url: `${walletOrigin()}/passkey.html#t=${ticket}&theme=${theme}` }
}

/** Wait for the ceremony's outcome (the frame hands it out once). */
export async function awaitPasskey(ticket: string, opts: { signal?: AbortSignal; intervalMs?: number } = {}): Promise<Exclude<PasskeyOutcome, { status: 'pending' }>> {
  for (;;) {
    if (opts.signal?.aborted) return { status: 'error', message: 'Cancelled' }
    const outcome = await callWallet('passkey:result', { ticket })
    if (outcome.status !== 'pending') return outcome
    await new Promise(r => setTimeout(r, opts.intervalMs ?? 500))
  }
}

// ── Moving keys the app used to hold ────────────────────────────────────────
// Before the frame, the app kept (on its own origin) a session copy, a
// device-sealed copy for Google / email wallets and a passcode-encrypted copy
// for create / import wallets. On first open they're handed to the frame once
// and deleted here. A passcode copy is only deleted once the frame holds one
// too - otherwise the next session couldn't open the wallet.
const LEGACY_SOCIAL_COPY = 'meshport_social_dv_'

export async function migrateLegacyKey(address: string, kind: WalletKind | null, passcodes: string[]): Promise<WalletAccount | null> {
  const a = address.toLowerCase()
  const sec = await import('@/lib/security')
  const encKey = sec.getEncryptedKey(a)
  const hasSession = await sec.getSessionPrivateKey(a).then(Boolean).catch(() => false)
  let socialSealed: string | null = null
  try { socialSealed = localStorage.getItem(LEGACY_SOCIAL_COPY + a) } catch { /* */ }
  if (!encKey && !hasSession && !socialSealed) return null

  let key: string | null = (await sec.getSessionPrivateKey(a).catch(() => null))
  if (!key && socialSealed) key = await sec.openFromDevice(socialSealed)
  let passcode: string | undefined
  if (encKey) {
    for (const pc of passcodes) {
      const k = await sec.decryptPrivateKey(encKey, pc)
      if (k) { key = key ?? k; passcode = pc; break }
    }
  }
  if (!key) return null

  let mnemonic: string | undefined
  const encPhrase = sec.getEncryptedMnemonic(a)
  if (encPhrase && passcode) mnemonic = (await sec.decryptMnemonic(encPhrase, passcode)) ?? undefined

  const effectiveKind: WalletKind = kind ?? (socialSealed ? 'social-auto' : mnemonic ? 'create' : 'import-privkey')
  try {
    await callWallet('adopt', { address, privateKey: key, mnemonic, kind: effectiveKind, passcode })
  } finally {
    key = null; mnemonic = undefined
  }

  sec.clearSessionPrivateKey(a)
  try { localStorage.removeItem(LEGACY_SOCIAL_COPY + a) } catch { /* */ }
  if (passcode) {
    try {
      localStorage.removeItem('meshport_encrypted_' + a)
      localStorage.removeItem('meshport_encrypted_mnemonic_' + a)
    } catch { /* */ }
  }
  return walletAccount(address)
}

export function isWalletLocked(e: unknown): boolean {
  return e instanceof WalletFrameError && e.code === 'locked'
}
