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
import { createRecoveryPayload, openRecoveryPayload, RecoveryError } from '@/lib/recoveryQr'
import { wrapWithPrf, openWithPrf } from '@/lib/passkeyWrap'
import { deriveChatSeed } from '@/lib/chatIdentity'
import type { KeyShare } from '@/wallet/mpc/protocol'
import * as vault from './vault'
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

// ── MPC worker (mpcWorker.ts) ───────────────────────────────────────────────
// MPC work runs in a worker so key generation never blocks the frame or the
// app. Created on first use; replies are matched by id.
let mpcWorker: Worker | null = null
const mpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let mpcSeq = 0

function mpcCall<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!mpcWorker) {
    mpcWorker = new Worker(new URL('./mpcWorker.ts', import.meta.url), { type: 'module' })
    mpcWorker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = mpcPending.get(e.data.id)
      if (!p) return
      mpcPending.delete(e.data.id)
      if (e.data.error !== undefined) p.reject(new RpcError('failed', e.data.error)); else p.resolve(e.data.result)
    }
    mpcWorker.onerror = () => {
      for (const p of mpcPending.values()) p.reject(new RpcError('failed', 'The wallet engine stopped - try again'))
      mpcPending.clear()
      mpcWorker?.terminate()
      mpcWorker = null
    }
  }
  const id = ++mpcSeq
  return new Promise<T>((resolve, reject) => {
    mpcPending.set(id, { resolve, reject })
    mpcWorker!.postMessage({ id, method, args })
  })
}

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
    await vault.setPasscode(address, passcode, oldPasscode)
    return { ok: true as const }
  },

  async 'passkey:wrap'({ address, prf, salt }) {
    try { return await wrapWithPrf(vault.keyFor(address), prf, salt) } finally { prf.fill(0) }
  },

  async 'passkey:open'({ address, prf, salt, ct, iv }) {
    const k = await openWithPrf(prf, salt, ct, iv).finally(() => prf.fill(0))
    if (!k) throw new RpcError('decrypt', "This passkey couldn't unlock the wallet")
    await vault.openRecovered(address, k)
    return { ok: true as const }
  },

  async 'recovery:create'({ address, password }) {
    return { payload: await createRecoveryPayload(vault.keyFor(address), address, password) }
  },

  async 'recovery:open'({ address, payload, password }) {
    try {
      const { privateKey } = await openRecoveryPayload(payload, password, address)
      await vault.openRecovered(address, privateKey)
      return { ok: true as const }
    } catch (e) {
      if (e instanceof RecoveryError) throw new RpcError(e.code === 'mismatch' ? 'mismatch' : e.code === 'decrypt' ? 'decrypt' : 'invalid', e.message)
      throw e
    }
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

  async 'sign:message'({ address, message }) {
    return { signature: await signer(address).signMessage({ message }) }
  },

  async 'sign:typed-data'({ address, typedData }) {
    return { signature: await signer(address).signTypedData(typedData as any) }
  },

  async 'sign:transaction'({ address, transaction }) {
    return { serialized: await signer(address).signTransaction(transaction as any) }
  },

  async 'chat:seed'({ address }) {
    const seed = deriveChatSeed(vault.keyFor(address))
    try { return { seed: bytesToHex(seed) } } finally { seed.fill(0) }
  },

  async lock({ address }) { vault.lock(address); return { ok: true as const } },

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

  async 'mpc:keygen-begin'() { return mpcCall('keygenBegin') },

  async 'mpc:keygen-next'({ session, reply }) {
    const r = await mpcCall<{ box: string; shares?: { address: Hex; phone: KeyShare; backup: KeyShare } }>('keygenNext', String(session), reply)
    // The phone's shares exist before its last box goes out: store them first,
    // so a failed store stops signup before the server saves its share.
    if (r.shares) await vault.storeMpc(r.shares.address, r.shares.phone, r.shares.backup)
    return { box: r.box } // the shares stay in this origin
  },

  async 'mpc:keygen-finish'({ session, address }) {
    try {
      return await mpcCall<{ address: Hex }>('keygenFinish', String(session), address)
    } catch (e) {
      vault.forgetMpc(address) // the server finished with another wallet: these shares are useless
      throw e
    }
  },

  async 'mpc:sign-begin'({ address, request }) {
    const share = await vault.mpcShare(address)
    return mpcCall('signBegin', share, request)
  },

  async 'mpc:sign-next'({ session, reply }) { return mpcCall('signNext', String(session), reply) },

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
