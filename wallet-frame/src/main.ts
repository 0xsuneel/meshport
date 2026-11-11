// wallet-frame/src/main.ts
//
// The wallet frame: a hidden page on its own origin that holds the wallet key
// and answers the app's requests (src/wallet/protocol.ts). It never returns a
// private key or a recovery phrase - those are shown only by reveal.html,
// inside this origin.
//
// Who may talk to it: only a page whose origin is in VITE_WALLET_PARENT_ORIGINS,
// and only when that page is this frame's own parent (not a popup or a
// sibling frame). Replies go back to that exact origin, never '*'.
// The hosting adds CSP frame-ancestors with the same list and connect-src
// 'none' (wallet-frame/vercel.json): the frame makes no network requests.

import { generateMnemonic, english, privateKeyToAccount } from 'viem/accounts'
import { bytesToHex } from 'viem'
import {
  WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION, REVEAL_CHANNEL, PASSKEY_CHANNEL, CONFIRM_CHANNEL,
  isWalletMessage, parseOrigins,
  type Hex, type WalletMethod, type WalletParams, type WalletResult, type WalletResponse, type WalletErrorCode,
  type PasskeyRequest, type PasskeyOutcome,
  type ConfirmIntent, type ConfirmSummary, type ConfirmBiometric, type ConfirmOutcome,
} from '@/wallet/protocol'
import * as keys from './keys'
import { parseIntent, describeIntent, matchesIntent, type IntentView } from './intent'
import { deriveChatSeed } from '@/lib/chatIdentity'
import { chatPublicKey, wrapMessageKey, unwrapMessageKey, openV1 } from '@/lib/chatWrap'
import { solanaPublicKey, solanaSign, solanaHexToBytes } from '@/lib/solanaKey'
import * as vault from './vault'
import { VaultError } from './vault'

const DEV_PARENTS = 'http://localhost:5173,http://127.0.0.1:5173'
const ALLOWED_PARENTS = new Set(parseOrigins(import.meta.env.VITE_WALLET_PARENT_ORIGINS as string | undefined
  ?? (import.meta.env.DEV ? DEV_PARENTS : '')))

class RpcError extends Error {
  constructor(public code: WalletErrorCode, message: string, public lockedForMs?: number) { super(message) }
}

// ── Request checks (the app is not trusted to send well-formed params) ──────
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
function addr(address: unknown): string {
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw new RpcError('invalid', 'Not a wallet address')
  return address
}
/** Hex param → bytes, of exactly `len` bytes when given (old chat files: up to 40 MB). */
function hexBytes(v: unknown, len?: number): Uint8Array {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v) || v.length > 2 + 80_000_000) throw new RpcError('invalid', 'Bad chat data')
  const out = new Uint8Array((v.length - 2) / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(v.slice(2 + i * 2, 4 + i * 2), 16)
  if (len != null && out.length !== len) throw new RpcError('invalid', 'Bad chat data')
  return out
}
/** Runs `use` with this wallet's chat identity seed, wiped afterwards. */
async function withChatSeed<T>(address: unknown, use: (seed: Uint8Array) => T | Promise<T>): Promise<T> {
  const seed = deriveChatSeed(vault.keyFor(addr(address)))
  try { return await use(seed) } finally { seed.fill(0) }
}
const KINDS = new Set(['create', 'import-seed', 'import-privkey'])
function passcodeParam(passcode: unknown, required = false): string | undefined {
  if (passcode == null || passcode === '') {
    if (required) throw new RpcError('invalid', 'Enter your passcode')
    return undefined
  }
  if (!vault.validPasscode(passcode)) throw new RpcError('invalid', 'Passcode must be at least 6 characters')
  return passcode
}

// ── Accounts from a phrase / key (keys.ts) ──────────────────────────────────
function fromPhrase(phrase: unknown) {
  try { return keys.fromPhrase(String(phrase ?? '')) } catch (e) { throw new RpcError('invalid', (e as Error).message) }
}
function fromKey(secret: unknown) {
  try { return keys.fromKey(String(secret ?? '')) } catch (e) { throw new RpcError('invalid', (e as Error).message) }
}

const signer = (address: string) => privateKeyToAccount(vault.keyFor(address) as Hex)

// ── Approval: the passcode, checked here, before anything that moves value ──
// The app's own passcode sheet is not enough on its own: anything running in
// the app's page could post a signing request. So the frame signs
// transactions, typed data (permits, transfer authorizations), Solana
// transactions, passkey signatures and raw hashes only within APPROVAL_MS of
// the person's passcode - entered and checked on this origin's own page
// (confirm.html, 'confirm:begin'), never one typed in the app. Like a hosted
// wallet's MFA window: one entry covers a multi-step action (approve + swap,
// a bridge). A payment confirmed with its exact transaction opens no window.
// Left free: MeshPort's own text messages (sign-in binding, chat key, profile
// update - they move nothing), MeshPort name registration on Arc, and a
// 0-value, low-fee transfer to the wallet itself (cancelling a stuck payment).
// A wallet with no passcode on this device signs nothing that needs approval
// until 'passcode:check' gives it one and confirm.html approves.
const APPROVAL_MS = 2 * 60_000
const approvedUntil = new Map<string, number>()
function requireApproval(address: string) {
  if (vault.hasPasscode(address) && (approvedUntil.get(address.toLowerCase()) ?? 0) > Date.now()) return
  throw new RpcError('approval-required', 'Enter your passcode to approve this')
}

const ARC_CHAIN_ID = 5042002
// At most this much in fees for a self-cancel (Arc pays gas in USDC, 18 decimals natively).
const SELF_CANCEL_MAX_FEE = 50_000_000_000_000_000n // 0.05 of the native token
const big = (v: unknown): bigint => (v == null ? 0n : BigInt(v as bigint | string | number))
function isSelfCancel(address: string, tx: Record<string, unknown>): boolean {
  try {
    // Arc only: the fee cap is in Arc's native coin (USDC). On another chain
    // 0.05 ETH is real money - a script could burn it, nonce after nonce,
    // with no passcode. MeshPort only cancels stuck payments on Arc.
    if (Number(tx.chainId) !== ARC_CHAIN_ID) return false
    if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== address.toLowerCase()) return false
    if (big(tx.value) !== 0n || (tx.data && tx.data !== '0x')) return false
    if (tx.authorizationList != null || tx.type === 'eip7702' || tx.blobs != null) return false
    const gas = big(tx.gas ?? 21_000n)
    const price = big(tx.maxFeePerGas ?? tx.gasPrice)
    return gas <= 30_000n && gas * price <= SELF_CANCEL_MAX_FEE
  } catch { return false }
}

const REGISTER_FIELDS = 'name:string,account:address,kind:uint8,displayName:string,nonce:uint256,deadline:uint256'
function isNameRegistration(address: string, typedData: Record<string, unknown>): boolean {
  const domain = typedData.domain as { name?: unknown; chainId?: unknown } | undefined
  if (domain?.name !== 'MeshPortNames' || typedData.primaryType !== 'Register') return false
  if (Number(domain.chainId) !== ARC_CHAIN_ID) return false
  const types = typedData.types as Record<string, { name: string; type: string }[]> | undefined
  const own = Object.keys(types ?? {}).filter(t => t !== 'EIP712Domain')
  if (own.length !== 1 || own[0] !== 'Register') return false
  if (types!.Register.map(f => `${f.name}:${f.type}`).join(',') !== REGISTER_FIELDS) return false
  const message = typedData.message as { account?: unknown } | undefined
  return typeof message?.account === 'string' && message.account.toLowerCase() === address.toLowerCase()
}

// MeshPort's own text messages that move nothing (they start with these lines).
const FREE_MESSAGES = ['MeshPort sign-in\n', 'MeshPort chat key\n', 'MeshPort profile update\n']
function isFreeMessage(message: unknown): boolean {
  return typeof message === 'string' && message.length <= 2_000 && FREE_MESSAGES.some(p => message.startsWith(p))
}

// ── One-time reveal tickets (reveal.html) ───────────────────────────────────
// The app asks for a ticket; reveal.html (same origin as this frame, shown
// inside the app as a visible iframe) redeems it over a BroadcastChannel,
// which only same-origin pages can join. The secret never crosses into the
// app's origin. Tickets die at expiry and on lock / forget.
const REVEAL_TTL_MS = 2 * 60_000
const MAX_TICKETS = 4
const tickets = new Map<string, { secret: string; what: 'mnemonic' | 'privateKey' | 'verify'; address: string; expires: number }>()
try {
  const channel = new BroadcastChannel(REVEAL_CHANNEL)
  channel.onmessage = (e) => {
    const { type, ticket } = (e.data ?? {}) as { type?: string; ticket?: string }
    if (type !== 'redeem' || typeof ticket !== 'string') return
    const t = tickets.get(ticket)
    // Another tab's frame may hold it - only the issuer answers.
    if (!t) return
    tickets.delete(ticket)
    if (t.expires < Date.now()) { channel.postMessage({ type: 'redeemed', ticket, error: 'expired' }); return }
    channel.postMessage({ type: 'redeemed', ticket, what: t.what, secret: t.secret })
  }
} catch { /* no BroadcastChannel: reveal is unavailable, everything else works */ }

/** Drop this wallet's tickets (every wallet's with no address); expired ones always go. */
function dropTickets(address?: string | null) {
  for (const [id, t] of tickets) {
    if (t.expires < Date.now() || address === undefined || (address && t.address === address.toLowerCase())) tickets.delete(id)
  }
}

function newTicket(address: string, secret: string, what: 'mnemonic' | 'privateKey' | 'verify'): string {
  dropTickets(null) // expired ones only
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!)
  const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  tickets.set(ticket, { secret, what, address: address.toLowerCase(), expires: Date.now() + REVEAL_TTL_MS })
  setTimeout(() => tickets.delete(ticket), REVEAL_TTL_MS + 1_000)
  return ticket
}

// ── Confirm-word check (right after a new phrase is shown) ──────────────────
// Answers pass / fail for the whole set only - never which word is wrong, so
// it can't be used to read the phrase word by word - needs 3+ positions, and
// allows a few tries per minute.
const CHECK_TRIES = 5
const CHECK_WINDOW_MS = 60_000
const checkTries = new Map<string, number[]>()

// ── Passkey ceremonies (passkey.html) ───────────────────────────────────────
// The app asks for a ceremony and gets a ticket; passkey.html (same origin,
// visible, where the person taps) fetches the request from here over a
// BroadcastChannel - never from its URL - runs WebAuthn and reports back.
// The outcome (a public key or a Safe-format signature, nothing secret) is
// handed to the app once.
const PASSKEY_TTL_MS = 3 * 60_000
const MAX_CEREMONIES = 8
const ceremonies = new Map<string, { request: PasskeyRequest; expires: number; outcome: PasskeyOutcome; claimed: boolean }>()
try {
  const channel = new BroadcastChannel(PASSKEY_CHANNEL)
  channel.onmessage = (e) => {
    const d = (e.data ?? {}) as { type?: string; ticket?: string; outcome?: PasskeyOutcome }
    if (typeof d.ticket !== 'string') return
    const c = ceremonies.get(d.ticket)
    if (!c) return // another tab's frame holds it
    if (d.type === 'claim') {
      // One page per ticket: the first passkey.html to claim it runs it.
      if (c.claimed || c.expires < Date.now()) { channel.postMessage({ type: 'request', ticket: d.ticket, error: 'expired' }); return }
      c.claimed = true
      channel.postMessage({ type: 'request', ticket: d.ticket, request: c.request })
    } else if (d.type === 'outcome' && c.claimed && c.outcome.status === 'pending' && d.outcome && d.outcome.status !== 'pending') {
      c.outcome = d.outcome
    }
  }
} catch { /* no BroadcastChannel: passkeys are unavailable here */ }

// ── Confirmations (confirm.html) ────────────────────────────────────────────
// The person reads what they approve and types the passcode (or uses the
// fingerprint) on confirm.html - this origin, shown inside the app as a
// visible iframe - so the app never sees the passcode. confirm.html gets the
// request from here and sends the passcode back over a BroadcastChannel,
// which only this origin's pages can join.
//   intent:  the frame decoded the transaction (intent.ts); a correct
//            passcode allows signing that one transaction, once, within
//            APPROVAL_MS - no approval window opens.
//   summary: the app's own words (shown as such); a correct passcode opens
//            the usual approval window, like `approve`.
const CONFIRM_TTL_MS = 3 * 60_000
const MAX_CONFIRMS = 8
// MeshPortCheckout, when deployed (same address as the app's VITE_MESHPORT_CHECKOUT).
const CHECKOUT = String((import.meta.env.VITE_WALLET_CHECKOUT as string | undefined) ?? '').trim() || null
interface Confirmation {
  address: string
  intent: ConfirmIntent | null
  view: IntentView | null
  summary: ConfirmSummary | null
  biometric: ConfirmBiometric | null
  expires: number
  claimed: boolean
  checking: boolean
  outcome: ConfirmOutcome
  /** intent only: sign by then. */
  signUntil: number
}
const confirms = new Map<string, Confirmation>()
/** Drop this wallet's confirmations (every wallet's with no address, only stale ones with null). */
function dropConfirms(address?: string | null) {
  for (const [t, c] of confirms) {
    const stale = c.outcome.status === 'approved' ? c.signUntil < Date.now() : c.expires < Date.now()
    if (stale || address === undefined || (address && c.address === address.toLowerCase())) confirms.delete(t)
  }
}
const short = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
function summaryParam(s: unknown): ConfirmSummary | null {
  if (!s || typeof s !== 'object') return null
  const r = s as Record<string, unknown>
  const label = short(r.label, 40), name = short(r.name, 80)
  if (!label || !name) return null
  return { label, name, detail: short(r.detail, 80), amount: short(r.amount, 32), unit: short(r.unit, 16) }
}
function biometricParam(b: unknown): ConfirmBiometric | null {
  if (!b || typeof b !== 'object') return null
  const r = b as Record<string, unknown>
  const rpId = short(r.rpId, 253), credentialId = short(r.credentialId, 1024), salt = short(r.salt, 128), iv = short(r.iv, 64), ciphertext = short(r.ciphertext, 512)
  if (!rpId || !credentialId || !salt || !iv || !ciphertext) return null
  return { rpId, credentialId, salt, iv, ciphertext, label: short(r.label, 24) }
}
let confirmAvailable = false
try {
  const channel = new BroadcastChannel(CONFIRM_CHANNEL)
  confirmAvailable = true
  channel.onmessage = async (e) => {
    const d = (e.data ?? {}) as { type?: string; ticket?: string; passcode?: unknown; via?: unknown }
    if (typeof d.ticket !== 'string') return
    const c = confirms.get(d.ticket)
    if (!c) return // another tab's frame holds it
    const open = c.outcome.status === 'pending' && c.expires >= Date.now()
    if (d.type === 'claim') {
      // One page per ticket: the first confirm.html to claim it shows it.
      if (c.claimed || !open) { channel.postMessage({ type: 'request', ticket: d.ticket, error: 'expired' }); return }
      c.claimed = true
      channel.postMessage({ type: 'request', ticket: d.ticket, view: c.view, summary: c.summary, biometric: c.biometric })
    } else if (d.type === 'passcode') {
      if (!c.claimed || !open) { channel.postMessage({ type: 'checked', ticket: d.ticket, ok: false, code: 'expired', message: 'This request has expired - close it and try again' }); return }
      if (c.checking) return
      c.checking = true
      try {
        const passcode = String(d.passcode ?? '')
        // The passcode itself, every time (unlock alone says yes to an open key).
        await vault.checkPasscode(c.address, passcode)
        await vault.unlock(c.address, passcode)
        if (c.intent) c.signUntil = Date.now() + APPROVAL_MS
        else approvedUntil.set(c.address, Date.now() + APPROVAL_MS)
        c.outcome = { status: 'approved', viaBiometric: d.via === 'biometric' }
        channel.postMessage({ type: 'checked', ticket: d.ticket, ok: true })
      } catch (err) {
        const r = errorReply(err)
        channel.postMessage({ type: 'checked', ticket: d.ticket, ok: false, code: r.code, message: r.message, lockedForMs: r.lockedForMs })
      } finally { c.checking = false }
    } else if (d.type === 'cancel' && open) {
      c.outcome = { status: 'cancelled' }
    }
  }
} catch { /* no BroadcastChannel: confirm:begin is refused and the app uses its own passcode sheet */ }

// ── Lock / forget reach every tab's frame ───────────────────────────────────
const LOCK_CHANNEL = 'meshport-wallet-lock'
let lockChannel: BroadcastChannel | null = null
function closeHere(address: string | undefined, everything: boolean, forgetting: boolean) {
  if (address) approvedUntil.delete(address.toLowerCase()); else approvedUntil.clear()
  dropTickets(address)
  dropConfirms(address)
  if (address) checkTries.delete(address.toLowerCase()); else checkTries.clear()
  if (forgetting) vault.forget(address, everything); else vault.lock(address)
}
try {
  lockChannel = new BroadcastChannel(LOCK_CHANNEL)
  lockChannel.onmessage = (e) => {
    const d = (e.data ?? {}) as { type?: string; address?: string }
    if (d.type !== 'lock' && d.type !== 'forget') return
    const address = typeof d.address === 'string' && ADDRESS.test(d.address) ? d.address : undefined
    // Storage is shared: the tab that sent it already removed what forget removes.
    closeHere(address, false, false)
  }
} catch { /* no BroadcastChannel: other tabs keep their own state until reload */ }

// ── Handlers ────────────────────────────────────────────────────────────────
type Handlers = { [M in WalletMethod]: (p: WalletParams<M>) => Promise<WalletResult<M>> }

const handlers: Handlers = {
  async ping() { return { version: WALLET_PROTOCOL_VERSION } },

  async status({ address }) { return await vault.status(addr(address)) },

  async create({ passcode }) {
    const pc = passcodeParam(passcode)
    const w = fromPhrase(generateMnemonic(english, 128))
    await vault.store(w.address, w.privateKey, { kind: 'create', passcode: pc, mnemonic: w.phrase })
    return { address: w.address }
  },

  async import({ kind, secret, passcode }) {
    const pc = passcodeParam(passcode)
    if (kind === 'import-seed') {
      const w = fromPhrase(secret)
      await vault.store(w.address, w.privateKey, { kind, passcode: pc, mnemonic: w.phrase })
      return { address: w.address }
    }
    if (kind !== 'import-privkey') throw new RpcError('invalid', 'Unknown wallet kind')
    const w = fromKey(secret)
    await vault.store(w.address, w.privateKey, { kind, passcode: pc })
    return { address: w.address }
  },

  async adopt({ address, privateKey, mnemonic, kind, passcode }) {
    if (!KINDS.has(kind)) throw new RpcError('invalid', 'Unknown wallet kind')
    const pc = passcodeParam(passcode)
    const k = fromKey(privateKey)
    if (k.address.toLowerCase() !== addr(address).toLowerCase()) throw new RpcError('mismatch', 'That key belongs to a different wallet')
    let phrase: string | undefined
    if (mnemonic) {
      const w = fromPhrase(mnemonic)
      if (w.address.toLowerCase() === k.address.toLowerCase()) phrase = w.phrase
    }
    await vault.store(k.address, k.privateKey, { kind, passcode: pc, mnemonic: phrase })
    return { address: k.address }
  },

  async unlock({ address, passcode }) {
    const a = addr(address)
    const unlocked = await vault.unlock(a, typeof passcode === 'string' && passcode ? passcode : undefined)
    return { unlocked, lockedForMs: (await vault.status(a)).lockedForMs }
  },

  async 'set-passcode'({ address, passcode, oldPasscode }) {
    const a = addr(address)
    const pc = passcodeParam(passcode, true)!
    // Changing it always needs the current one - else a script in the app
    // could set its own and approve itself. A wallet with no passcode here
    // yet (just created / imported on this device) takes its first one.
    if (vault.hasPasscode(a)) await vault.checkPasscode(a, String(oldPasscode ?? ''))
    await vault.setPasscode(a, pc, typeof oldPasscode === 'string' ? oldPasscode : undefined)
    approvedUntil.delete(a.toLowerCase())
    return { ok: true as const }
  },

  async 'mnemonic:check'({ address, answers, passcode }) {
    const a = addr(address)
    // Right after create / import the phrase is in memory; later (Back up
    // wallet → Check my backup) it's opened with the passcode just entered.
    const phrase = vault.phraseInMemory(a)
      ?? (passcode != null ? await vault.readPhrase(a, passcodeParam(passcode, true)) : null)
    if (!phrase) throw new RpcError('locked', 'The recovery phrase is no longer open - reveal it again')
    const words = phrase.split(' ')
    const entries = answers && typeof answers === 'object' ? Object.entries(answers) : []
    const positions = new Set(entries.map(([i]) => Number(i)))
    if (entries.length < 3 || positions.size !== entries.length || [...positions].some(i => !Number.isInteger(i) || i < 0 || i >= words.length)) {
      throw new RpcError('invalid', 'Check at least 3 different words')
    }
    const now = Date.now()
    const recent = (checkTries.get(a.toLowerCase()) ?? []).filter(t => now - t < CHECK_WINDOW_MS)
    if (recent.length >= CHECK_TRIES) throw new RpcError('rate-limited', 'Too many tries - wait a minute and check your backup', CHECK_WINDOW_MS - (now - recent[0]))
    const ok = entries.every(([i, w]) => words[Number(i)] === String(w).trim().toLowerCase())
    if (ok) checkTries.delete(a.toLowerCase())
    else checkTries.set(a.toLowerCase(), [...recent, now])
    // Never which word is wrong.
    return { ok, wrong: [] }
  },

  async 'reveal:grant'({ address, what, passcode }) {
    const a = addr(address)
    if (what === 'privateKey') {
      // The private key needs the passcode typed for this reveal, every time.
      // Not a recent signing approval: that can come from fingerprint / face,
      // and backup is passcode only (8 Nov).
      await vault.checkPasscode(a, String(passcode ?? ''))
      return { ticket: newTicket(a, vault.keyFor(a), what) }
    }
    // 'verify': the backup check (Rabby / OKX style) - reveal.html asks for
    // a few words as taps and tells the app only pass / fail; the phrase is
    // never shown in that mode.
    if (what !== 'mnemonic' && what !== 'verify') throw new RpcError('invalid', 'Nothing to reveal')
    vault.keyFor(a) // the wallet must be open too
    const phrase = await vault.readPhrase(a, typeof passcode === 'string' ? passcode : undefined)
    if (!phrase) throw new RpcError('not-found', 'This wallet has no recovery phrase on this device')
    return { ticket: newTicket(a, phrase, what) }
  },

  async 'passcode:check'({ address, passcode }) {
    const a = addr(address)
    if (!vault.hasPasscode(a)) {
      // No passcode on this device yet (its setup didn't finish): the passcode
      // the person just typed becomes this wallet's passcode here.
      const pc = passcodeParam(passcode, true)!
      await vault.setPasscode(a, pc)
      return { ok: true as const, set: true }
    }
    await vault.checkPasscode(a, String(passcode ?? ''))
    // Nothing approved: a passcode typed in the app's page could have been
    // recorded there. Signing needs it entered on confirm.html.
    return { ok: true as const, set: false }
  },

  async 'sign:message'({ address, message }) {
    const a = addr(address)
    if (!isFreeMessage(message)) requireApproval(a)
    if (typeof message !== 'string' && !(message && typeof message === 'object' && typeof (message as { raw?: unknown }).raw === 'string')) {
      throw new RpcError('invalid', 'Nothing to sign')
    }
    return { signature: await signer(a).signMessage({ message }) }
  },

  async 'sign:typed-data'({ address, typedData }) {
    const a = addr(address)
    if (!typedData || typeof typedData !== 'object') throw new RpcError('invalid', 'Nothing to sign')
    if (!isNameRegistration(a, typedData)) requireApproval(a)
    return { signature: await signer(a).signTypedData(typedData as any) }
  },

  async 'sign:transaction'({ address, transaction, confirmation }) {
    const a = addr(address)
    if (!transaction || typeof transaction !== 'object') throw new RpcError('invalid', 'Nothing to sign')
    if (confirmation != null) {
      // Exactly the transaction the person confirmed, once - never an
      // approval window, never another transaction.
      const c = typeof confirmation === 'string' ? confirms.get(confirmation) : undefined
      if (!c || !c.intent || c.address !== a.toLowerCase() || c.outcome.status !== 'approved' || c.signUntil < Date.now()) {
        throw new RpcError('mismatch', 'This payment was not confirmed - try again')
      }
      if (!matchesIntent(c.intent, transaction)) throw new RpcError('mismatch', 'This is not the payment you confirmed')
      confirms.delete(confirmation as string)
    } else if (!isSelfCancel(a, transaction)) requireApproval(a)
    return { serialized: await signer(a).signTransaction(transaction as any) }
  },

  async 'confirm:begin'({ address, intent, summary, biometric }) {
    const a = addr(address)
    if (!confirmAvailable) throw new RpcError('unsupported', 'Confirming here is not available in this browser')
    // No passcode on this device yet: the app's own sheet sets one (`approve`).
    if (!vault.hasPasscode(a)) throw new RpcError('not-found', 'This wallet has no passcode on this device')
    let parsed: ConfirmIntent | null = null
    if (intent != null) {
      try { parsed = parseIntent(intent) } catch (e) { throw new RpcError('invalid', (e as Error).message) }
    }
    const s = summaryParam(summary)
    if (!parsed && !s) throw new RpcError('invalid', 'Nothing to confirm')
    dropConfirms(null) // stale ones only
    while (confirms.size >= MAX_CONFIRMS) confirms.delete(confirms.keys().next().value!)
    const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    confirms.set(ticket, {
      address: a.toLowerCase(), intent: parsed, view: parsed ? describeIntent(parsed, { checkout: CHECKOUT }) : null,
      summary: s, biometric: biometricParam(biometric), expires: Date.now() + CONFIRM_TTL_MS,
      claimed: false, checking: false, outcome: { status: 'pending' }, signUntil: 0,
    })
    return { ticket }
  },

  async 'confirm:result'({ ticket }) {
    const c = typeof ticket === 'string' ? confirms.get(ticket) : undefined
    if (!c) return { status: 'error' as const, message: 'This request has expired - try again' }
    if (c.outcome.status === 'pending' && c.expires < Date.now()) {
      confirms.delete(ticket)
      return { status: 'error' as const, message: 'Timed out - try again' }
    }
    // An approved summary has done its job (the window is open); an approved
    // intent stays until it signs or expires.
    if (c.outcome.status === 'cancelled' || (c.outcome.status === 'approved' && !c.intent)) confirms.delete(ticket)
    return c.outcome
  },

  async 'confirm:cancel'({ ticket }) {
    if (typeof ticket === 'string') confirms.delete(ticket)
    return { ok: true as const }
  },

  // Chat (audit M15): the chat identity is derived from the wallet key here
  // (lib/chatIdentity) and never leaves the frame. The app gets the public
  // key and asks the frame to seal / open each message's own key
  // (lib/chatWrap). Needs the wallet open, like signing.
  async 'chat:pub'({ address }) {
    return withChatSeed(address, seed => ({ pub: bytesToHex(chatPublicKey(seed)) }))
  },

  async 'chat:wrap'({ address, rpk, key }) {
    const r = await withChatSeed(address, seed => wrapMessageKey(seed, hexBytes(rpk, 32), hexBytes(key, 32)))
    return { spk: bytesToHex(r.spk), iv: bytesToHex(r.iv), wrapped: bytesToHex(r.wrapped) }
  },

  async 'chat:unwrap'({ address, spk, rpk, iv, wrapped, peer }) {
    const k = await withChatSeed(address, seed => unwrapMessageKey(seed, hexBytes(spk, 32), hexBytes(rpk, 32), hexBytes(iv, 12),
      hexBytes(wrapped, 48), peer == null ? null : hexBytes(peer, 32)))
    if (!k) return { key: null }
    try { return { key: bytesToHex(k) } } finally { k.fill(0) }
  },

  async 'chat:v1'({ address, peer, iv, data }) {
    try {
      const plain = await withChatSeed(address, seed => openV1(seed, hexBytes(peer, 32), hexBytes(iv, 12), hexBytes(data)))
      return { plain: bytesToHex(plain) }
    } catch (e) {
      if (e instanceof RpcError || e instanceof VaultError) throw e
      throw new RpcError('invalid', 'This message does not open')
    }
  },

  async 'solana:key'({ address }) {
    return { publicKey: bytesToHex(solanaPublicKey(vault.keyFor(addr(address)))) }
  },

  async 'solana:sign'({ address, message }) {
    const a = addr(address)
    requireApproval(a)
    let bytes: Uint8Array
    try { bytes = solanaHexToBytes(String(message)) } catch { throw new RpcError('invalid', 'Solana message must be hex') }
    // A Solana transaction message fits in one packet (1232 bytes).
    if (bytes.length < 3 || bytes.length > 1232) throw new RpcError('invalid', 'Not a Solana transaction message')
    return { signature: bytesToHex(solanaSign(vault.keyFor(a), bytes)) }
  },

  async lock({ address }) {
    const a = address == null ? undefined : addr(address)
    closeHere(a, false, false)
    lockChannel?.postMessage({ type: 'lock', address: a })
    return { ok: true as const }
  },

  async forget({ address, everything, passcode }) {
    const a = address == null ? undefined : addr(address)
    // Wiping the passcode copy and phrase needs that wallet's passcode.
    if (everything) {
      if (!a) throw new RpcError('invalid', 'Which wallet?')
      if (vault.hasPasscode(a)) await vault.checkPasscode(a, String(passcode ?? ''))
    }
    closeHere(a, !!everything, true)
    lockChannel?.postMessage({ type: 'forget', address: a })
    return { ok: true as const }
  },

  async 'passkey:begin'(request) {
    if (!request || typeof request !== 'object') throw new RpcError('invalid', 'Unknown passkey request')
    const short = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
    if (request.mode === 'create') {
      if (!short(request.userId, 64) || !short(request.userName, 64)) throw new RpcError('invalid', 'A passkey needs an account id and name')
    } else if (request.mode === 'sign') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(request.challenge)) throw new RpcError('invalid', 'Passkey challenge must be a 32-byte hash')
      if (!short(request.credentialId, 1024)) throw new RpcError('invalid', 'Which passkey should sign?')
      if (request.label != null && !short(request.label, 120)) throw new RpcError('invalid', 'Label is too long')
      // A passkey signature can move a Safe's funds: same approval as any signature.
      if (!(request as { address?: unknown }).address) throw new RpcError('invalid', 'Which wallet is signing?')
      requireApproval(addr((request as { address?: unknown }).address))
    } else throw new RpcError('invalid', 'Unknown passkey request')
    for (const [t, c] of ceremonies) if (c.expires < Date.now()) ceremonies.delete(t)
    if (ceremonies.size >= MAX_CEREMONIES) throw new RpcError('rate-limited', 'Too many passkey requests open - finish or wait for one')
    const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    ceremonies.set(ticket, { request, expires: Date.now() + PASSKEY_TTL_MS, outcome: { status: 'pending' }, claimed: false })
    return { ticket }
  },

  async 'passkey:result'({ ticket }) {
    const c = ceremonies.get(ticket)
    if (!c) return { status: 'error' as const, message: 'This passkey request has expired - try again' }
    if (c.outcome.status !== 'pending') { ceremonies.delete(ticket); return c.outcome }
    if (c.expires < Date.now()) { ceremonies.delete(ticket); return { status: 'error' as const, message: 'Timed out waiting for Face ID - try again' } }
    return c.outcome
  },
}

// ── Transport ───────────────────────────────────────────────────────────────
function reply(target: MessageEventSource, origin: string, msg: Omit<WalletResponse, 'tag' | 'v'>) {
  (target as Window).postMessage({ tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, ...msg }, origin)
}

// Error text the app sees: the frame's own messages, never a library's (which
// could echo what it was given).
function errorReply(err: unknown): { code: WalletErrorCode; message: string; lockedForMs?: number } {
  if (err instanceof RpcError || err instanceof VaultError) return { code: err.code, message: err.message, lockedForMs: err.lockedForMs || undefined }
  return { code: 'failed', message: 'Wallet request failed' }
}

window.addEventListener('message', async (e: MessageEvent) => {
  if (!ALLOWED_PARENTS.has(e.origin)) return
  if (e.source !== window.parent || window.parent === window) return
  if (!isWalletMessage(e.data)) return
  const { id, method, params } = e.data as unknown as { id: string; method: WalletMethod; params: unknown }
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? (handlers as any)[method] : null
  if (!handler) { reply(e.source, e.origin, { id, error: { code: 'unsupported', message: 'Unknown request' } }); return }
  try {
    reply(e.source, e.origin, { id, result: await handler(params && typeof params === 'object' ? params : {}) })
  } catch (err) {
    reply(e.source, e.origin, { id, error: errorReply(err) })
  }
})

// Tell the parent we're listening (it also pings, in case this lands first).
if (window.parent !== window) {
  for (const origin of ALLOWED_PARENTS) {
    try { window.parent.postMessage({ tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, id: 'ready' }, origin) } catch { /* */ }
  }
}
