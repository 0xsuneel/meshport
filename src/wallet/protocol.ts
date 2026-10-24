// src/wallet/protocol.ts
//
// The message contract between the MeshPort app and the wallet frame - the
// small page on its own origin (wallet-frame/) that is the only place a
// wallet key ever exists in readable form.
//
//   app (meshport.xyz)                       wallet frame (wallet.meshport.xyz)
//   ─────────────────                        ──────────────────────────────────
//   wallet/frameClient.ts ──postMessage──▶   wallet-frame/src/main.ts
//                         ◀──results only──  keys: memory + frame-origin storage
//
// The browser keeps the two origins apart, so nothing running in the app -
// its own code, a dependency, an injected script - can read the frame's
// memory or storage. The app can only send these requests; none of them
// returns a private key or a recovery phrase. Secrets are shown to the user
// inside the frame itself (wallet-frame/reveal.html).
//
// Shared by both sides; holds types and constants only, never key material.

export const WALLET_MESSAGE_TAG = 'meshport-wallet'
export const WALLET_PROTOCOL_VERSION = 1

export type Hex = `0x${string}`
export type WalletKind = 'create' | 'import-seed' | 'import-privkey' | 'social-auto'

export interface WalletStatus {
  /** The key is open in the frame right now. */
  unlocked: boolean
  /** A copy sealed to this browser exists (opens without a prompt). */
  device: boolean
  /** A passcode-encrypted copy exists on this device. */
  passcode: boolean
  /** A recovery phrase is kept for this wallet (create / import-seed). */
  mnemonic: boolean
  /** Words in that phrase, for the confirm-word check (0 when none). */
  wordCount: number
  /** While passcode attempts are locked out, ms until the next try. */
  lockedForMs: number
  /**
   * The passcode copy is sealed to a device key this browser no longer has
   * (site data partly cleared): restore from the phrase / key.
   */
  bindingLost: boolean
}

/** Unsigned EVM transaction as viem describes it (bigints survive postMessage). */
export type FrameTransaction = Record<string, unknown>

/** Every request the frame answers: method → [params, result]. */
export interface WalletRpc {
  ping: [Record<string, never>, { version: number }]
  status: [{ address: string }, WalletStatus]
  /** New wallet made in the frame. `create` also keeps a recovery phrase. */
  create: [{ kind: 'create' | 'social-auto'; passcode?: string }, { address: Hex }]
  /** A phrase / key the user typed. Validated, stored, never echoed back. */
  import: [{ kind: 'import-seed' | 'import-privkey'; secret: string; passcode?: string }, { address: Hex }]
  /** One-time move of a key the app held before the frame existed. */
  adopt: [{ address: string; privateKey: string; mnemonic?: string; kind: WalletKind; passcode?: string }, { address: Hex }]
  /** Open the key: session copy → device copy → passcode (when given). */
  unlock: [{ address: string; passcode?: string }, { unlocked: boolean; lockedForMs: number }]
  /** Re-encrypt this device's copy under a new passcode (key must be open). */
  'set-passcode': [{ address: string; passcode: string; oldPasscode?: string }, { ok: true }]
  /** Lock the open key with a passkey's PRF secret; returns the ciphertext to store. */
  'passkey:wrap': [{ address: string; prf: Uint8Array; salt: Uint8Array }, { ct: Uint8Array; iv: Uint8Array }]
  /** Open a passkey-locked ciphertext; the key then stays in the frame. */
  'passkey:open': [{ address: string; prf: Uint8Array; salt: Uint8Array; ct: Uint8Array; iv: Uint8Array }, { ok: true }]
  'recovery:create': [{ address: string; password: string }, { payload: string }]
  'recovery:open': [{ address: string; payload: string; password: string }, { ok: true }]
  /** Confirm-word check after backup: { wordIndex: word }. */
  'mnemonic:check': [{ address: string; answers: Record<number, string> }, { ok: boolean; wrong: number[] }]
  /**
   * One-time ticket for reveal.html to show a secret inside the frame.
   * The recovery phrase needs the passcode (it's kept passcode-encrypted).
   */
  'reveal:grant': [{ address: string; what: 'mnemonic' | 'privateKey'; passcode?: string }, { ticket: string }]
  'sign:message': [{ address: string; message: string | { raw: Hex } }, { signature: Hex }]
  'sign:typed-data': [{ address: string; typedData: Record<string, unknown> }, { signature: Hex }]
  'sign:transaction': [{ address: string; transaction: FrameTransaction }, { serialized: Hex }]
  /** This wallet's chat identity seed (derived, domain-separated - not the wallet key). */
  'chat:seed': [{ address: string }, { seed: Hex }]
  /** Close the open key(s) in memory and this tab's session copy. */
  lock: [{ address?: string }, { ok: true }]
  /** Logout: also delete this browser's sealed device copy. Passcode copies stay. */
  forget: [{ address?: string; everything?: boolean }, { ok: true }]
  /**
   * Start a passkey ceremony. The app then shows passkey.html#t=<ticket> in a
   * visible iframe; the person taps there (browsers only allow WebAuthn in a
   * cross-origin frame after a tap inside it). Single use, 3 minutes.
   */
  'passkey:begin': [PasskeyRequest, { ticket: string }]
  /** Poll a ceremony's outcome; a finished result is handed out once. */
  'passkey:result': [{ ticket: string }, PasskeyOutcome]
}

export type PasskeyRequest =
  | { mode: 'create'; userId: string; userName: string }
  | { mode: 'sign'; credentialId: string; challenge: Hex; label?: string }

export type PasskeyOutcome =
  | { status: 'pending' }
  | { status: 'created'; credentialId: string; x: Hex; y: Hex }
  | { status: 'signed'; signature: Hex }
  | { status: 'error'; message: string }

/** passkey.html ↔ frame, over a same-origin BroadcastChannel (never the app). */
export const PASSKEY_CHANNEL = 'meshport-wallet-passkey'

export type WalletMethod = keyof WalletRpc
export type WalletParams<M extends WalletMethod> = WalletRpc[M][0]
export type WalletResult<M extends WalletMethod> = WalletRpc[M][1]

export interface WalletRequest<M extends WalletMethod = WalletMethod> {
  tag: typeof WALLET_MESSAGE_TAG
  v: number
  id: string
  method: M
  params: WalletParams<M>
}

export type WalletErrorCode =
  | 'locked'        // the key isn't open in the frame
  | 'not-found'     // no wallet with that address on this device
  | 'bad-passcode'
  | 'rate-limited'  // too many wrong passcodes; wait lockedForMs
  | 'mismatch'      // a secret opened, but it's a different wallet
  | 'invalid'       // malformed phrase / key / request
  | 'decrypt'       // wrong recovery password or tampered QR
  | 'unsupported'
  | 'failed'

export interface WalletResponse {
  tag: typeof WALLET_MESSAGE_TAG
  v: number
  id: string
  result?: unknown
  error?: { code: WalletErrorCode; message: string; lockedForMs?: number }
}

/** Reveal page ↔ frame, over a same-origin BroadcastChannel (never the app). */
export const REVEAL_CHANNEL = 'meshport-wallet-reveal'

export function isWalletMessage(data: unknown): data is { tag: string; v: number; id: string } {
  return !!data && typeof data === 'object'
    && (data as any).tag === WALLET_MESSAGE_TAG
    && (data as any).v === WALLET_PROTOCOL_VERSION
    && typeof (data as any).id === 'string'
}

/** Origins split from a comma list (env), normalised, no wildcards. */
export function parseOrigins(list: string | undefined): string[] {
  return (list ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => new URL(s).origin)
}
