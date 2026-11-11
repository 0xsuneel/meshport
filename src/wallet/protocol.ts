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
export type WalletKind = 'create' | 'import-seed' | 'import-privkey'

export interface WalletStatus {
  /** The key is open in the frame right now. */
  unlocked: boolean
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
  create: [{ kind: 'create'; passcode?: string }, { address: Hex }]
  /** A phrase / key the user typed. Validated, stored, never echoed back. */
  import: [{ kind: 'import-seed' | 'import-privkey'; secret: string; passcode?: string }, { address: Hex }]
  /** One-time move of a key the app held before the frame existed. */
  adopt: [{ address: string; privateKey: string; mnemonic?: string; kind: WalletKind; passcode?: string }, { address: Hex }]
  /** Open the key: session copy → device copy → passcode (when given). */
  unlock: [{ address: string; passcode?: string }, { unlocked: boolean; lockedForMs: number }]
  /** Re-encrypt this device's copy under a new passcode (key must be open). */
  'set-passcode': [{ address: string; passcode: string; oldPasscode?: string }, { ok: true }]
  /**
   * Confirm-word check after backup: { wordIndex: word }, 3+ positions.
   * Pass / fail for the whole set only (`wrong` is always empty).
   */
  'mnemonic:check': [{ address: string; answers: Record<number, string>; passcode?: string }, { ok: boolean; wrong: number[] }]
  /**
   * One-time ticket for reveal.html to show a secret inside the frame.
   * Both need the passcode (or, for the key, an approval from the last 2 minutes).
   */
  'reveal:grant': [{ address: string; what: 'mnemonic' | 'privateKey' | 'verify'; passcode?: string }, { ticket: string }]
  /**
   * The person just entered the passcode (or a fingerprint released it): the
   * frame checks it itself and then signs value-moving requests for
   * APPROVAL_MS. A wallet with no passcode on this device takes this one.
   */
  approve: [{ address: string; passcode: string }, { approved: true; required: boolean; validForMs: number }]
  'sign:message': [{ address: string; message: string | { raw: Hex } }, { signature: Hex }]
  'sign:typed-data': [{ address: string; typedData: Record<string, unknown> }, { signature: Hex }]
  /**
   * `confirmation`: a ticket the person approved in confirm.html for exactly
   * this transaction (ConfirmIntent) - signed once, with no approval window.
   */
  'sign:transaction': [{ address: string; transaction: FrameTransaction; confirmation?: string }, { serialized: Hex }]
  /**
   * Start a confirmation: the app then shows confirm.html#t=<ticket> in a
   * visible iframe, where the person reads what they approve and types the
   * passcode (or uses the fingerprint) - inside the wallet's origin, so the
   * app never sees it. With `intent`, the frame decodes the transaction
   * itself and the approval signs only that one; without it (`summary` only:
   * the app's own description) a correct passcode opens the usual approval
   * window. 3 minutes to approve.
   */
  'confirm:begin': [{ address: string; intent?: ConfirmIntent; summary?: ConfirmSummary; biometric?: ConfirmBiometric }, { ticket: string }]
  /** Poll a confirmation. */
  'confirm:result': [{ ticket: string }, ConfirmOutcome]
  /** The person closed the sheet: the ticket is dropped. */
  'confirm:cancel': [{ ticket: string }, { ok: true }]
  /** This wallet's chat public key (X25519, 32 bytes). The private half never leaves the frame (audit M15). */
  'chat:pub': [{ address: string }, { pub: Hex }]
  /** Seal a message's own 32-byte key from this wallet's chat identity to `rpk` (lib/chatWrap). */
  'chat:wrap': [{ address: string; rpk: Hex; key: Hex }, { spk: Hex; iv: Hex; wrapped: Hex }]
  /** Open a sealed message key; null when it isn't this identity's or doesn't open. `peer`: the other side must be this key (or me). */
  'chat:unwrap': [{ address: string; spk: Hex; rpk: Hex; iv: Hex; wrapped: Hex; peer?: Hex | null }, { key: Hex | null }]
  /** Open an old e2e:v1 text / file from the chat with `peer`. */
  'chat:v1': [{ address: string; peer: Hex; iv: Hex; data: Hex }, { plain: Hex }]
  /** This wallet's Solana public key (32 bytes; derived, domain-separated - lib/solanaKey.ts). */
  'solana:key': [{ address: string }, { publicKey: Hex }]
  /** ed25519-sign a Solana transaction's message bytes with this wallet's Solana key. */
  'solana:sign': [{ address: string; message: Hex }, { signature: Hex }]
  /** Close the open key(s) in memory and this tab's session copy. */
  lock: [{ address?: string }, { ok: true }]
  /** Logout: close the key here and in other tabs. `everything` also wipes this wallet's passcode copy and phrase (needs its passcode). */
  forget: [{ address?: string; everything?: boolean; passcode?: string }, { ok: true }]
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
  | { mode: 'sign'; address: string; credentialId: string; challenge: Hex; label?: string }

export type PasskeyOutcome =
  | { status: 'pending' }
  | { status: 'created'; credentialId: string; x: Hex; y: Hex }
  | { status: 'signed'; signature: Hex }
  | { status: 'error'; message: string }

/** passkey.html ↔ frame, over a same-origin BroadcastChannel (never the app). */
export const PASSKEY_CHANNEL = 'meshport-wallet-passkey'

/**
 * One transaction a confirmation allows. The frame shows what it does from
 * these fields alone and signs a transaction only when chain, recipient,
 * value and data match exactly and gas × max fee per gas ≤ maxFee. Nonce and
 * gas are left to the sender (they are read after the passcode).
 * value / maxFee: decimal strings of the native unit's smallest unit.
 */
export interface ConfirmIntent { chainId: number; to: string; value: string; data: Hex; maxFee: string }

/** The app's own description of an action (shown as such, never as verified). */
export interface ConfirmSummary { label: string; name: string; detail?: string; amount?: string; unit?: string }

/**
 * The fingerprint copy of the passcode (lib/biometric.ts, sealed under the
 * passkey's PRF output): confirm.html runs the same passkey and opens it
 * there. Opaque to the frame until the person's fingerprint opens it.
 */
export interface ConfirmBiometric { rpId: string; credentialId: string; salt: string; iv: string; ciphertext: string; label?: string }

export type ConfirmOutcome =
  | { status: 'pending' }
  | { status: 'approved'; viaBiometric: boolean }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/** confirm.html ↔ frame, over a same-origin BroadcastChannel (never the app). */
export const CONFIRM_CHANNEL = 'meshport-wallet-confirm'

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
  | 'unsupported'
  | 'failed'
  | 'approval-required' // a value-moving signature without a recent passcode

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
