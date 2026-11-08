// src/wallet/index.ts
//
// The app's wallet API. Every operation that needs the key is a request to
// the wallet frame (protocol.ts); what comes back is an address, a signature,
// a status or a ciphertext - never the key or the recovery phrase.

import { callWallet, WalletFrameError, walletOrigin } from './frameClient'
import { walletAccount, type WalletAccount } from './account'
import type { PasskeyOutcome, PasskeyRequest, WalletKind, WalletStatus } from './protocol'

export { walletAccount, quoteAccount, isWalletAccount, toEthersSigner, createWalletAdapter, type WalletAccount } from './account'
export { WalletFrameError, walletOrigin, walletReady } from './frameClient'
export type { PasskeyOutcome, PasskeyRequest, WalletKind, WalletStatus } from './protocol'

/** Wallets whose key is in the wallet frame: every created / imported wallet. */
export function keyInWalletFrame(walletSource: string | null | undefined): boolean {
  return !!walletSource
}

export function walletStatus(address: string): Promise<WalletStatus> {
  return callWallet('status', { address })
}

/** A brand-new wallet, made in the frame. */
export async function createWallet(kind: 'create', passcode?: string): Promise<WalletAccount> {
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

/** The person's passcode, for the frame to check before value-moving signatures (lib/walletApproval). */
export async function approveFrameWallet(address: string, passcode: string): Promise<{ required: boolean }> {
  const { required } = await callWallet('approve', { address, passcode })
  return { required }
}

export async function setWalletPasscode(address: string, passcode: string, oldPasscode?: string): Promise<void> {
  await callWallet('set-passcode', { address, passcode, oldPasscode })
}

export function lockWallet(address?: string) { return callWallet('lock', { address }).catch(() => undefined) }
export function forgetWallet(address?: string, everything = false) { return callWallet('forget', { address, everything }).catch(() => undefined) }

// ── Chat (audit M15): the chat key stays in the frame ──────────────────────
const toHexStr = (b: Uint8Array): `0x${string}` => { let h = '0x'; for (const x of b) h += x.toString(16).padStart(2, '0'); return h as `0x${string}` }
const fromHexStr = (h: string): Uint8Array => {
  const c = h.slice(2), out = new Uint8Array(c.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** This wallet's chat public key (needs the wallet open). */
export async function chatPublicKey(address: string): Promise<Uint8Array> {
  return fromHexStr((await callWallet('chat:pub', { address })).pub)
}
/** Seals a message's own key for `rpk` (and me). */
export async function chatWrap(address: string, rpk: Uint8Array, key: Uint8Array): Promise<{ spk: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }> {
  const r = await callWallet('chat:wrap', { address, rpk: toHexStr(rpk), key: toHexStr(key) })
  return { spk: fromHexStr(r.spk), iv: fromHexStr(r.iv), wrapped: fromHexStr(r.wrapped) }
}
/** Opens a sealed message key, or null when it isn't mine. */
export async function chatUnwrap(address: string, h: { spk: Uint8Array; rpk: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }, peer: Uint8Array | null): Promise<Uint8Array | null> {
  const r = await callWallet('chat:unwrap', { address, spk: toHexStr(h.spk), rpk: toHexStr(h.rpk), iv: toHexStr(h.iv), wrapped: toHexStr(h.wrapped), peer: peer ? toHexStr(peer) : null })
  return r.key ? fromHexStr(r.key) : null
}
/** Opens an old e2e:v1 text / file from the chat with `peer`. */
export async function chatOpenV1(address: string, peer: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return fromHexStr((await callWallet('chat:v1', { address, peer: toHexStr(peer), iv: toHexStr(iv), data: toHexStr(data) })).plain)
}

/** Confirm-word check right after a new wallet's phrase was shown. */
export async function checkRecoveryWords(address: string, answers: Record<number, string>, passcode?: string): Promise<{ ok: boolean; wrong: number[] }> {
  return callWallet('mnemonic:check', { address, answers, ...(passcode ? { passcode } : {}) })
}

/**
 * URL for wallet-frame/reveal.html showing this wallet's phrase or key - to
 * be put in a visible iframe (components/wallet/WalletSecretFrame.tsx).
 */
export async function revealUrl(address: string, what: 'mnemonic' | 'privateKey', opts: { passcode?: string; theme?: 'dark' | 'light' } = {}): Promise<string> {
  const { ticket } = await callWallet('reveal:grant', { address, what, passcode: opts.passcode })
  return `${walletOrigin()}/reveal.html#t=${ticket}&theme=${opts.theme ?? 'dark'}`
}

// ── Wallet passkey (Safe owner) ──────────────────────────────────────────────
/**
 * Start a passkey ceremony in the frame: create the Safe's passkey owner, or
 * sign a 32-byte hash with it. Returns the URL for a visible iframe
 * (components/wallet/WalletPasskeyFrame.tsx) and the ticket to wait on.
 */
export async function beginPasskey(request: PasskeyRequest, theme: 'dark' | 'light' = 'dark'): Promise<{ ticket: string; url: string }> {
  const { withApproval } = await import('./account')
  const { ticket } = await withApproval(() => callWallet('passkey:begin', request))
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
// Before the frame, the app kept (on its own origin) a session copy and a
// passcode-encrypted copy. On first open they're handed to the frame once
// and deleted here. A passcode copy is only deleted once the frame holds one
// too - otherwise the next session couldn't open the wallet.
export async function migrateLegacyKey(address: string, kind: WalletKind | null, passcodes: string[]): Promise<WalletAccount | null> {
  const a = address.toLowerCase()
  const sec = await import('@/lib/security')
  const encKey = sec.getEncryptedKey(a)
  const hasSession = await sec.getSessionPrivateKey(a).then(Boolean).catch(() => false)
  if (!encKey && !hasSession) return null

  let key: string | null = (await sec.getSessionPrivateKey(a).catch(() => null))
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

  const effectiveKind: WalletKind = kind ?? (mnemonic ? 'create' : 'import-privkey')
  try {
    await callWallet('adopt', { address, privateKey: key, mnemonic, kind: effectiveKind, passcode })
  } finally {
    key = null; mnemonic = undefined
  }

  sec.clearSessionPrivateKey(a)
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
