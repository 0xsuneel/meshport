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

import { generateMnemonic, english, privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bytesToHex } from 'viem'
import {
  WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION, REVEAL_CHANNEL, PASSKEY_CHANNEL,
  isWalletMessage, parseOrigins,
  type Hex, type WalletMethod, type WalletParams, type WalletResult, type WalletResponse, type WalletErrorCode,
  type PasskeyRequest, type PasskeyOutcome,
} from '@/wallet/protocol'
import * as keys from './keys'
import { deriveChatSeed } from '@/lib/chatIdentity'
import { solanaPublicKey, solanaSign, solanaHexToBytes } from '@/lib/solanaKey'
import * as vault from './vault'
import { sealForDevice, openFromDevice } from '@/lib/security'
import * as gate from './fastPayGate'
import { VaultError } from './vault'

const DEV_PARENTS = 'http://localhost:5173,http://127.0.0.1:5173'
const ALLOWED_PARENTS = new Set(parseOrigins(import.meta.env.VITE_WALLET_PARENT_ORIGINS as string | undefined
  ?? (import.meta.env.DEV ? DEV_PARENTS : '')))

class RpcError extends Error {
  constructor(public code: WalletErrorCode, message: string, public lockedForMs?: number) { super(message) }
}

// ── Accounts from a phrase / key (keys.ts) ──────────────────────────────────
function fromPhrase(phrase: string) {
  try { return keys.fromPhrase(phrase) } catch (e) { throw new RpcError('invalid', (e as Error).message) }
}
function fromKey(secret: string) {
  try { return keys.fromKey(secret) } catch (e) { throw new RpcError('invalid', (e as Error).message) }
}

const signer = (address: string) => privateKeyToAccount(vault.keyFor(address) as Hex)

// ── Approval: the passcode, checked here, before anything that moves value ──
// The app's own passcode sheet is not enough on its own: anything running in
// the app's page could post a signing request. So the frame signs
// transactions, typed data (permits, transfer authorizations) and Solana
// transactions only within APPROVAL_MS of the person's passcode - checked by
// the frame itself (`approve`; every passcode / fingerprint entry in the app
// sends it). Like a hosted wallet's MFA window: one entry covers a multi-step action
// (approve + swap, a bridge). Left free: plain messages (sign-in binding,
// chat key, P2P "marked paid" - they move nothing), MeshPort name
// registration, and a 0-value transfer to the wallet itself (cancelling a
// stuck payment). A wallet without a passcode here (Google / email device
// wallets) has nothing to check.
const APPROVAL_MS = 2 * 60_000
const approvedUntil = new Map<string, number>()
// Required once this device's app has sent an approval (an app version from
// before approvals never does - it keeps working until it updates); from then
// on for good, kept in this frame's storage where the app can't undo it.
function requireApproval(address: string) {
  if (!vault.approvalsUsed() || !vault.hasPasscode(address)) return
  if ((approvedUntil.get(address.toLowerCase()) ?? 0) > Date.now()) return
  throw new RpcError('approval-required', 'Enter your passcode to approve this')
}
function isSelfCancel(address: string, tx: Record<string, unknown>): boolean {
  const value = tx.value == null ? 0n : BigInt(tx.value as bigint | string | number)
  const data = tx.data as string | undefined
  return typeof tx.to === 'string' && tx.to.toLowerCase() === address.toLowerCase() && value === 0n && (!data || data === '0x')
}
function isNameRegistration(typedData: Record<string, unknown>): boolean {
  const domain = typedData.domain as { name?: unknown } | undefined
  return domain?.name === 'MeshPortNames' && typedData.primaryType === 'Register'
}

// ── Fast Pay session keys ───────────────────────────────────────────────────
// In memory, and (keep) sealed to this device so the session survives the app
// closing - it ends at its on-chain expiry, sign-out or Fast Pay off. A session key can only
// sign what Fast Pay sends on Arc - nothing that could reach the user's main
// wallet beyond the Permit2 allowance the user granted it.
const ARC_CHAIN_ID = 5042002
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000'
const ARC_EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const ARC_CIRBTC = '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf'
const EIP2612_PERMIT = new Set(['0xd505accf']) // permit(owner, spender, value, deadline, v, r, s)
const ERC20_APPROVE = '0x095ea7b3' // approve(spender, amount)
const ERC20_TRANSFER = '0xa9059cbb' // transfer(to, amount) - only back to the session's owner
// Express Transfer: Circle's CCTP TokenMessengerV2 on Arc.
const TOKEN_MESSENGER_V2 = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'
// Express Swap: Circle's swap adapter on Arc (execute - its calls carry the
// stablecoin service's own signature over the route).
const SWAP_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'
const SESSION_CALLS: Record<string, ReadonlySet<string>> = {
  // permit(owner, PermitSingle, sig), permit(owner, PermitBatch, sig), transferFrom(AllowanceTransferDetails[])
  [PERMIT2]: new Set(['0x2b67b570', '0x2a2d80d1', '0x0d58b1db']),
  // The tokens Express pays in: their one-time permit for Permit2; USDC also
  // approve - only to TokenMessengerV2 (see APPROVE_SPENDERS), for a Transfer.
  [ARC_USDC_ERC20]: new Set([...EIP2612_PERMIT, ERC20_APPROVE, ERC20_TRANSFER]),
  [ARC_EURC]: new Set([...EIP2612_PERMIT, ERC20_APPROVE, ERC20_TRANSFER]),
  [ARC_CIRBTC]: new Set([...EIP2612_PERMIT, ERC20_APPROVE, ERC20_TRANSFER]),
  // depositForBurn, depositForBurnWithHook - an Express Transfer's burn.
  [TOKEN_MESSENGER_V2]: new Set(['0x8e0250ee', '0x779b432d']),
  // execute - an Express Swap.
  [SWAP_ADAPTER]: new Set(['0xaa3e079c']),
}
// Who a session key may approve. Approvals, the burn and plain transfers only
// ever spend what the key itself holds - its gas float, and what a
// passcode-approved Permit2 pull just moved to it for this one move.
const APPROVE_SPENDERS = new Set([TOKEN_MESSENGER_V2, SWAP_ADAPTER])
/** What this frame lets a session key do (the app checks before relying on it). */
export const SESSION_CAPABILITIES = ['pay', 'transfer', 'swap', 'bring'] as const

// ── Express Bring keys ───────────────────────────────────────────────────────
// One per wallet, kept (sealed to this device) for weeks: MeshPortRouter on
// each Bring chain accepts its signature once the owner registered it there
// (setBringKey). It signs ONLY an ExpressBring for its own owner, and only
// after a passcode approval checked here - and the router itself sends such
// a Bring only to the owner's own Arc wallet, with a capped fee.
const BRING_STORE = 'mp.bring.key.' // + owner → sealed key
const bringKeys = new Map<string, ReturnType<typeof privateKeyToAccount>>()
async function bringKeyFor(owner: string, create: boolean): Promise<ReturnType<typeof privateKeyToAccount> | null> {
  const o = owner.toLowerCase()
  const hit = bringKeys.get(o)
  if (hit) return hit
  let sealed: string | null = null
  try { sealed = localStorage.getItem(BRING_STORE + o) } catch { sealed = null }
  if (sealed) {
    const pk = await openFromDevice(sealed)
    if (pk) { const k = privateKeyToAccount(pk as Hex); bringKeys.set(o, k); return k }
  }
  if (!create) return null
  const pk = generatePrivateKey()
  const k = privateKeyToAccount(pk)
  // Kept sealed to this device; where that can't be done (storage blocked),
  // for this visit only - the per-chain setup is then asked again next time.
  const seal = await sealForDevice(pk).catch(() => null)
  if (seal) { try { localStorage.setItem(BRING_STORE + o, seal) } catch { /* memory only */ } }
  bringKeys.set(o, k)
  return k
}
const EXPRESS_BRING_TYPES = { ExpressBring: [
  { name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'fee', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
  { name: 'hookDataHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
] } as const
const sessionKeys = new Map<string, ReturnType<typeof privateKeyToAccount>>()
const sessionOwner = new Map<string, string>() // session key → the wallet it spends for
const SESSION_STORE = 'mp.fastpay.session.' // + address → { owner, sealed key }
function dropSessionKey(a: string): void {
  sessionKeys.delete(a)
  sessionOwner.delete(a)
  try { localStorage.removeItem(SESSION_STORE + a) } catch { /* storage blocked */ }
}
/** A Fast Pay payment (Permit2 batch transferFrom) - the call that needs the passcode. */
function isSessionPayment(tx: Record<string, unknown>): boolean {
  return typeof tx.data === 'string' && tx.data.toLowerCase().startsWith('0x0d58b1db')
}
function gateError(e: unknown): RpcError {
  if (e instanceof gate.GateError) return new RpcError(e.code, e.message, e.lockedForMs)
  return new RpcError('failed', e instanceof Error ? e.message : 'Fast Pay passcode check failed')
}
/** Why a session key must not sign this (null: allowed). Exported for tests. */
export function sessionTxRefusal(tx: Record<string, unknown>, owner?: string): string | null {
  if (Number(tx.chainId) !== ARC_CHAIN_ID) return 'Fast Pay signs on Arc only'
  const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : ''
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '0x'
  if (data === '0x' || data === '') return to ? null : 'No recipient' // a plain value transfer (the leftover gas back)
  const allowed = SESSION_CALLS[to]
  const selector = data.slice(0, 10)
  // What was refused (public: a contract address and a function selector) -
  // so a refusal in the field says which call to look at.
  const what = (extra = '') => `Not a Fast Pay call (to ${to || '-'}, fn ${selector}${extra})`
  if (!allowed || !allowed.has(selector)) return what()
  if (selector === ERC20_APPROVE && !APPROVE_SPENDERS.has('0x' + data.slice(34, 74))) return what(`, spender 0x${data.slice(34, 74)}`)
  // A token transfer only back to the wallet the session spends for (returning an unfinished move).
  if (selector === ERC20_TRANSFER && (!owner || '0x' + data.slice(34, 74) !== owner.toLowerCase())) return what(', not to the owner')
  return null
}

// ── One-time reveal tickets (reveal.html) ───────────────────────────────────
// The app asks for a ticket; reveal.html (same origin as this frame, shown
// inside the app as a visible iframe) redeems it over a BroadcastChannel,
// which only same-origin pages can join. The secret never crosses into the
// app's origin.
const REVEAL_TTL_MS = 2 * 60_000
const tickets = new Map<string, { secret: string; what: 'mnemonic' | 'privateKey'; expires: number }>()
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

function newTicket(secret: string, what: 'mnemonic' | 'privateKey'): string {
  const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  tickets.set(ticket, { secret, what, expires: Date.now() + REVEAL_TTL_MS })
  return ticket
}

// ── Passkey ceremonies (passkey.html) ───────────────────────────────────────
// The app asks for a ceremony and gets a ticket; passkey.html (same origin,
// visible, where the person taps) fetches the request from here over a
// BroadcastChannel - never from its URL - runs WebAuthn and reports back.
// The outcome (a public key or a Safe-format signature, nothing secret) is
// handed to the app once.
const PASSKEY_TTL_MS = 3 * 60_000
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

// ── Handlers ────────────────────────────────────────────────────────────────
type Handlers = { [M in WalletMethod]: (p: WalletParams<M>) => Promise<WalletResult<M>> }

const handlers: Handlers = {
  async ping() { return { version: WALLET_PROTOCOL_VERSION } },

  async status({ address }) { return await vault.status(address) },

  async create({ kind, passcode }) {
    if (kind === 'social-auto') {
      const privateKey = generatePrivateKey()
      const address = privateKeyToAccount(privateKey).address
      await vault.store(address, privateKey, { kind })
      return { address }
    }
    const w = fromPhrase(generateMnemonic(english, 128))
    await vault.store(w.address, w.privateKey, { kind, passcode, mnemonic: w.phrase })
    return { address: w.address }
  },

  async import({ kind, secret, passcode }) {
    if (kind === 'import-seed') {
      const w = fromPhrase(secret)
      await vault.store(w.address, w.privateKey, { kind, passcode, mnemonic: w.phrase })
      return { address: w.address }
    }
    const w = fromKey(secret)
    await vault.store(w.address, w.privateKey, { kind, passcode })
    return { address: w.address }
  },

  async adopt({ address, privateKey, mnemonic, kind, passcode }) {
    const k = fromKey(privateKey)
    if (k.address.toLowerCase() !== address.toLowerCase()) throw new RpcError('mismatch', 'That key belongs to a different wallet')
    let phrase: string | undefined
    if (mnemonic) {
      const w = fromPhrase(mnemonic)
      if (w.address.toLowerCase() === k.address.toLowerCase()) phrase = w.phrase
    }
    await vault.store(k.address, k.privateKey, { kind, passcode, mnemonic: phrase })
    return { address: k.address }
  },

  async unlock({ address, passcode }) {
    const unlocked = await vault.unlock(address, passcode)
    return { unlocked, lockedForMs: (await vault.status(address)).lockedForMs }
  },

  async 'set-passcode'({ address, passcode, oldPasscode }) {
    // Changing it needs the current one - else a script in the app could set
    // its own and approve itself. Not right after create / import on this
    // device (the wallet's first passcode, or a re-import).
    if (vault.hasPasscode(address) && !vault.storedRecently(address)) await vault.checkPasscode(address, oldPasscode ?? '')
    await vault.setPasscode(address, passcode, oldPasscode)
    return { ok: true as const }
  },

  async 'mnemonic:check'({ address, answers }) {
    const phrase = vault.phraseInMemory(address)
    if (!phrase) throw new RpcError('locked', 'The recovery phrase is no longer open - reveal it again')
    const words = phrase.split(' ')
    const entries = Object.entries(answers)
    // Which positions are wrong - never the right words.
    const wrong = entries.filter(([i, w]) => words[Number(i)] !== String(w).trim().toLowerCase()).map(([i]) => Number(i))
    return { ok: entries.length > 0 && wrong.length === 0, wrong }
  },

  async 'reveal:grant'({ address, what, passcode }) {
    if (what === 'privateKey') return { ticket: newTicket(vault.keyFor(address), what) }
    vault.keyFor(address) // the wallet must be open too
    const phrase = await vault.readPhrase(address, passcode)
    if (!phrase) throw new RpcError('not-found', 'This wallet has no recovery phrase on this device')
    return { ticket: newTicket(phrase, what) }
  },

  async approve({ address, passcode }) {
    vault.noteApprovalsUsed()
    if (!vault.hasPasscode(address)) return { approved: true as const, required: false, validForMs: 0 }
    await vault.checkPasscode(address, passcode)
    approvedUntil.set(address.toLowerCase(), Date.now() + APPROVAL_MS)
    return { approved: true as const, required: true, validForMs: APPROVAL_MS }
  },

  async 'sign:message'({ address, message }) {
    return { signature: await signer(address).signMessage({ message }) }
  },

  async 'sign:typed-data'({ address, typedData }) {
    if (!isNameRegistration(typedData)) requireApproval(address)
    return { signature: await signer(address).signTypedData(typedData as any) }
  },

  async 'sign:transaction'({ address, transaction }) {
    if (!isSelfCancel(address, transaction)) requireApproval(address)
    return { serialized: await signer(address).signTransaction(transaction as any) }
  },

  // ── Fast Pay session keys (src/lib/fastPay.ts) ──────────────────────────
  // Each key belongs to one wallet (owner). Its payment signatures need a
  // passcode approval checked here (fastPayGate) - never just the app's word.
  async 'session:create'({ keep, owner } = {}) {
    if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new RpcError('invalid', 'Which wallet is this Fast Pay session for?')
    if (!gate.hasPasscode()) throw new RpcError('not-found', 'Unlock with your passcode first')
    const pk = generatePrivateKey()
    const k = privateKeyToAccount(pk)
    const a = k.address.toLowerCase()
    sessionKeys.set(a, k)
    sessionOwner.set(a, owner.toLowerCase())
    // Kept across app restarts: sealed with this browser's non-extractable
    // device key (the same protection as the device copies of wallet keys),
    // in this frame's own storage, with its owner. The app's page can't read it.
    let kept = false
    if (keep) {
      const sealed = await sealForDevice(pk)
      if (sealed) { try { localStorage.setItem(SESSION_STORE + a, JSON.stringify({ owner: owner.toLowerCase(), sealed })); kept = true } catch { /* storage blocked */ } }
    }
    return { address: k.address, kept }
  },

  async 'session:restore'({ address }) {
    const a = String(address).toLowerCase()
    if (sessionKeys.has(a)) return { restored: true }
    let saved: { owner?: string; sealed?: string } | null = null
    try { saved = JSON.parse(localStorage.getItem(SESSION_STORE + a) || 'null') } catch { saved = null }
    // No owner (a key kept before the passcode check existed) or no check value: not reopened.
    if (!saved?.owner || !saved.sealed || !gate.hasPasscode()) {
      try { localStorage.removeItem(SESSION_STORE + a) } catch { /* storage blocked */ }
      return { restored: false }
    }
    const pk = await openFromDevice(saved.sealed)
    if (!pk) return { restored: false }
    const k = privateKeyToAccount(pk as Hex)
    if (k.address.toLowerCase() !== a) return { restored: false }
    sessionKeys.set(a, k)
    sessionOwner.set(a, saved.owner)
    return { restored: true }
  },

  async 'session:sign'({ address, transaction }) {
    const a = String(address).toLowerCase()
    const k = sessionKeys.get(a)
    if (!k) throw new RpcError('locked', 'This Fast Pay session has ended')
    const why = sessionTxRefusal(transaction, sessionOwner.get(a))
    if (why) throw new RpcError('invalid', why)
    // A payment (Permit2 batch transferFrom) needs the passcode, checked here.
    if (isSessionPayment(transaction) && !gate.takeApproval(sessionOwner.get(a) ?? '')) {
      throw new RpcError('approval-required', 'Enter your passcode to approve this')
    }
    return { serialized: await k.signTransaction(transaction as any) }
  },

  async 'bring:key'({ owner, create }) {
    if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new RpcError('invalid', 'Which wallet?')
    if (!gate.hasPasscode()) throw new RpcError('not-found', 'Unlock with your passcode first')
    const k = await bringKeyFor(owner, create === true)
    return { address: k?.address ?? null }
  },

  async 'bring:sign'({ owner, chainId, router, bring }) {
    const o = String(owner ?? '').toLowerCase()
    const b = (bring ?? {}) as Record<string, string | number>
    if (!/^0x[0-9a-f]{40}$/.test(o) || String(b.owner ?? '').toLowerCase() !== o) throw new RpcError('invalid', 'A Bring key signs only for its own wallet')
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(router)) || !(Number(chainId) > 0)) throw new RpcError('invalid', 'Unknown router')
    const k = await bringKeyFor(o, false)
    if (!k) throw new RpcError('not-found', 'No Express Bring key on this device')
    // Every Bring needs the passcode, checked here.
    if (!gate.takeApproval(o)) throw new RpcError('approval-required', 'Enter your passcode to approve this')
    const signature = await k.signTypedData({
      domain: { name: 'MeshPortRouter', version: '1', chainId: Number(chainId), verifyingContract: String(router) as Hex },
      types: EXPRESS_BRING_TYPES, primaryType: 'ExpressBring',
      message: {
        owner: o as Hex, token: String(b.token) as Hex, amount: BigInt(b.amount), fee: BigInt(b.fee), maxFee: BigInt(b.maxFee),
        minFinalityThreshold: Number(b.minFinalityThreshold), hookDataHash: String(b.hookDataHash) as Hex, salt: String(b.salt) as Hex,
        deadline: BigInt(b.deadline),
      },
    })
    return { signature }
  },

  async 'bring:forget'({ owner }) {
    const o = String(owner ?? '').toLowerCase()
    bringKeys.delete(o)
    try { localStorage.removeItem(BRING_STORE + o) } catch { /* storage blocked */ }
    return { ok: true as const }
  },

  async 'session:capabilities'() {
    return { capabilities: [...SESSION_CAPABILITIES] }
  },

  async 'session:end'({ address }) {
    if (address) dropSessionKey(String(address).toLowerCase())
    else {
      for (const a of [...sessionKeys.keys()]) dropSessionKey(a)
      try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(SESSION_STORE)) localStorage.removeItem(k) } } catch { /* storage blocked */ }
    }
    return { ok: true as const }
  },

  // ── Google / email wallet passcode (fastPayGate) ─────────────────────────
  // The only check of that passcode: unlocking, and every Fast Pay payment.
  async 'circle-passcode:set'({ passcode, oldPasscode }) {
    try { await gate.setPasscode(passcode, oldPasscode) } catch (e) { throw gateError(e) }
    return { ok: true as const }
  },

  async 'circle-passcode:check'({ passcode }) {
    try { await gate.checkPasscode(passcode) } catch (e) { throw gateError(e) }
    return { ok: true as const }
  },

  async 'circle-passcode:forget'() {
    gate.forget()
    // Every Fast Pay session key goes with it (memory and storage).
    for (const a of [...sessionKeys.keys()]) dropSessionKey(a)
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(SESSION_STORE)) localStorage.removeItem(k) } } catch { /* storage blocked */ }
    return { ok: true as const }
  },

  async 'fastpay:approve'({ owner, passcode }) {
    try { return { approved: true as const, ...(await gate.approve(owner, passcode)) } } catch (e) { throw gateError(e) }
  },

  async 'chat:seed'({ address }) {
    const seed = deriveChatSeed(vault.keyFor(address))
    try { return { seed: bytesToHex(seed) } } finally { seed.fill(0) }
  },

  async 'solana:key'({ address }) {
    return { publicKey: bytesToHex(solanaPublicKey(vault.keyFor(address))) }
  },

  async 'solana:sign'({ address, message }) {
    requireApproval(address)
    let bytes: Uint8Array
    try { bytes = solanaHexToBytes(String(message)) } catch { throw new RpcError('invalid', 'Solana message must be hex') }
    // A Solana transaction message fits in one packet (1232 bytes).
    if (bytes.length < 3 || bytes.length > 1232) throw new RpcError('invalid', 'Not a Solana transaction message')
    return { signature: bytesToHex(solanaSign(vault.keyFor(address), bytes)) }
  },

  async lock({ address }) {
    if (address) approvedUntil.delete(address.toLowerCase()); else approvedUntil.clear()
    vault.lock(address)
    return { ok: true as const }
  },

  async forget({ address, everything }) { vault.forget(address, everything); return { ok: true as const } },

  async 'passkey:begin'(request) {
    if (request.mode === 'create') {
      if (!request.userId || !request.userName) throw new RpcError('invalid', 'A passkey needs an account id and name')
    } else if (request.mode === 'sign') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(request.challenge)) throw new RpcError('invalid', 'Passkey challenge must be a 32-byte hash')
      if (!request.credentialId) throw new RpcError('invalid', 'Which passkey should sign?')
    } else throw new RpcError('invalid', 'Unknown passkey request')
    for (const [t, c] of ceremonies) if (c.expires < Date.now()) ceremonies.delete(t)
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

window.addEventListener('message', async (e: MessageEvent) => {
  if (!ALLOWED_PARENTS.has(e.origin)) return
  if (e.source !== window.parent || window.parent === window) return
  if (!isWalletMessage(e.data)) return
  const { id, method, params } = e.data as unknown as { id: string; method: WalletMethod; params: unknown }
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? (handlers as any)[method] : null
  if (!handler) { reply(e.source, e.origin, { id, error: { code: 'unsupported', message: `Unknown request ${String(method)}` } }); return }
  try {
    reply(e.source, e.origin, { id, result: await handler(params ?? {}) })
  } catch (err) {
    const code: WalletErrorCode = err instanceof RpcError || err instanceof VaultError ? err.code : 'failed'
    const lockedForMs = err instanceof RpcError || err instanceof VaultError ? err.lockedForMs : undefined
    const message = err instanceof Error ? err.message : 'Wallet request failed'
    reply(e.source, e.origin, { id, error: { code, message, lockedForMs } })
  }
})

// Tell the parent we're listening (it also pings, in case this lands first).
if (window.parent !== window) {
  for (const origin of ALLOWED_PARENTS) {
    try { window.parent.postMessage({ tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, id: 'ready' }, origin) } catch { /* */ }
  }
}
