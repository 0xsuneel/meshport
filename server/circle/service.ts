// server/circle/service.ts
//
// MeshPort's backend for Circle User-Controlled Wallets. The wallet is a
// generic EVM EOA (EVM-TESTNET): Circle signs, MeshPort broadcasts through
// its own relay exactly like the app's other wallets - Circle only offers
// "sign, don't send" for generic EVM wallets. Users sign in to Circle with
// Google (the same Google sign-in as MeshPort) or an email code; every
// signature is a challenge the app runs in Circle's SDK. This file never sees
// keys or OTP codes.
//
// Identity: one MeshPort account is linked to exactly one Circle user. Every
// call that acts for a user checks that the Circle session (X-User-Token)
// belongs to the Circle user linked to the signed-in MeshPort account, so one
// person's Circle session can never act on another's MeshPort account. The
// wallet a call acts on comes from that link, never from the request.

import { getAddress, isAddress } from 'viem'
import { CIRCLE_ERR, CircleApiError, type CircleClient } from './client'

export const CIRCLE_CHAIN = 'EVM-TESTNET'
const SESSION_CACHE_MS = 5 * 60_000
// The account ↔ Circle user link changes only when it is made or its wallet
// is first found (both below update this cache), so a signature needn't look
// it up in the database every time. Per warm instance.
const LINK_CACHE_MS = 5 * 60_000

export type CircleWalletErrorCode =
  | 'bad-request'      // malformed input
  | 'session'          // Circle session missing, expired or not this account's: sign in to Circle again
  | 'not-linked'       // no Circle user linked to this MeshPort account yet
  | 'linked-elsewhere' // this Circle login belongs to a different MeshPort account (or vice versa)
  | 'no-wallet'        // the Circle user has no EVM wallet yet: initialize first
  | 'circle'           // Circle refused or failed

export class CircleWalletError extends Error {
  constructor(public code: CircleWalletErrorCode, message: string) { super(message) }
}

export interface CircleLink { circleUserId: string; walletId: string | null; address: string | null; blockchain: string | null }

export interface CircleRepo {
  /** The Circle user (and wallet) linked to this MeshPort account, if any. */
  link(authUid: string): Promise<CircleLink | null>
  /** Link a Circle user; 'taken' if that Circle user is linked to another account. */
  saveLink(authUid: string, circleUserId: string): Promise<'saved' | 'taken'>
  saveWallet(authUid: string, walletId: string, address: string, blockchain: string): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY = /^(?:0x[0-9a-fA-F]{1,64}|\d{1,78})$/

const bad = (m: string): never => { throw new CircleWalletError('bad-request', m) }
const needUuid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) bad(`${what} must be a UUID`)
  return v as string
}
const needDevice = (v: unknown): string => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) bad('deviceId is missing')
  return v as string
}
const needToken = (v: unknown): string => {
  if (typeof v !== 'string' || v.length < 20 || v.length > 8000) throw new CircleWalletError('session', 'Sign in to your Circle wallet again')
  return v as string
}
/** A quantity (number, decimal or hex string) as 0x-hex, or undefined. */
const quantity = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v
  if (typeof s !== 'string' || !QUANTITY.test(s)) bad(`${what} must be a non-negative integer`)
  return '0x' + BigInt(s as string).toString(16)
}

/**
 * The EIP-1559 JSON Circle signs, from an EVM transaction request. A legacy
 * gasPrice becomes maxFeePerGas = maxPriorityFeePerGas = gasPrice (Circle
 * only signs EIP-1559).
 */
export function circleTransaction(tx: unknown): string {
  if (!tx || typeof tx !== 'object') bad('transaction is missing')
  const t = tx as Record<string, unknown>
  if (t.type !== undefined && t.type !== 'eip1559' && t.type !== 'legacy' && t.type !== 2 && t.type !== '0x2') bad('Only EIP-1559 transactions can be signed')
  const chainId = Number(t.chainId)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('chainId is missing')
  if (t.to !== undefined && t.to !== null && (typeof t.to !== 'string' || !isAddress(t.to))) bad('to is not an address')
  if (t.data !== undefined && t.data !== null && (typeof t.data !== 'string' || !HEX.test(t.data))) bad('data must be hex')
  const nonce = quantity(t.nonce, 'nonce')
  const gas = quantity(t.gas, 'gas')
  if (nonce === undefined || gas === undefined) bad('nonce and gas are required')
  const gasPrice = quantity(t.gasPrice, 'gasPrice')
  const maxFeePerGas = quantity(t.maxFeePerGas, 'maxFeePerGas') ?? gasPrice
  const maxPriorityFeePerGas = quantity(t.maxPriorityFeePerGas, 'maxPriorityFeePerGas') ?? gasPrice
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) bad('fees are required')
  const out: Record<string, unknown> = {
    ...(t.to ? { to: getAddress(t.to as string) } : {}),
    nonce, value: quantity(t.value, 'value') ?? '0x0',
    ...(t.data && t.data !== '0x' ? { data: t.data } : {}),
    chainId, gas, maxFeePerGas, maxPriorityFeePerGas,
  }
  const json = JSON.stringify(out)
  if (json.length > 200_000) bad('transaction is too large')
  return json
}

async function tokenKey(userToken: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userToken)))
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('')
}

export function createCircleWalletService(opts: { circle: CircleClient; repo: CircleRepo; now?: () => number }) {
  const { circle, repo } = opts
  const now = opts.now ?? Date.now
  // Which Circle user a session token belongs to (keyed by the token's hash, never the token).
  const sessions = new Map<string, { circleUserId: string; exp: number }>()
  const links = new Map<string, { link: CircleLink; exp: number }>()

  /** repo.link, remembered for LINK_CACHE_MS (a missing link isn't remembered - it may be made any moment). */
  async function linkOf(authUid: string): Promise<CircleLink | null> {
    const hit = links.get(authUid)
    if (hit && hit.exp > now()) return hit.link
    const link = await repo.link(authUid)
    if (link) {
      if (links.size > 5000) links.delete(links.keys().next().value!)
      links.set(authUid, { link, exp: now() + LINK_CACHE_MS })
    }
    return link
  }

  /** Circle errors → this service's errors. */
  async function call<T>(f: () => Promise<T>): Promise<T> {
    try { return await f() } catch (e) {
      if (e instanceof CircleWalletError) throw e
      if (e instanceof CircleApiError) {
        if (e.code === CIRCLE_ERR.userTokenExpired || e.status === 401) throw new CircleWalletError('session', 'Your Circle sign-in expired - sign in again')
        throw new CircleWalletError('circle', e.message)
      }
      throw new CircleWalletError('circle', 'Circle could not be reached - try again')
    }
  }

  async function circleUserOf(userToken: string): Promise<string> {
    const key = await tokenKey(userToken)
    const hit = sessions.get(key)
    if (hit && hit.exp > now()) return hit.circleUserId
    const u = await call(() => circle.request<{ id?: string; status?: string }>('GET', '/v1/w3s/user', { userToken }))
    if (!u.id) throw new CircleWalletError('session', 'Sign in to your Circle wallet again')
    if (u.status === 'DISABLED') throw new CircleWalletError('circle', 'This Circle account is disabled')
    if (sessions.size > 5000) sessions.delete(sessions.keys().next().value!)
    sessions.set(key, { circleUserId: u.id, exp: now() + SESSION_CACHE_MS })
    return u.id
  }

  /** The signed-in account's link, after checking the Circle session belongs to it. */
  async function linked(authUid: string, userToken: unknown): Promise<CircleLink> {
    const token = needToken(userToken)
    const [link, circleUserId] = await Promise.all([linkOf(authUid), circleUserOf(token)])
    if (!link) throw new CircleWalletError('not-linked', 'Connect your Circle wallet first')
    if (link.circleUserId !== circleUserId) throw new CircleWalletError('linked-elsewhere', 'This Circle sign-in belongs to a different MeshPort account')
    return link
  }

  type Wallet = { id: string; address: string; blockchain: string; state: string; accountType?: string; createDate: string }

  async function liveWallet(userToken: string): Promise<Wallet | null> {
    const r = await call(() => circle.request<{ wallets?: Wallet[] }>('GET', '/v1/w3s/wallets', { userToken, query: { blockchain: CIRCLE_CHAIN } }))
    const live = (r.wallets ?? [])
      .filter(w => w.blockchain === CIRCLE_CHAIN && w.state === 'LIVE' && w.accountType === 'EOA')
      .sort((a, b) => a.createDate.localeCompare(b.createDate))
    return live[0] ?? null
  }

  async function walletOf(authUid: string, userToken: unknown): Promise<{ walletId: string; address: string }> {
    const link = await linked(authUid, userToken)
    if (link.walletId && link.address && link.blockchain === CIRCLE_CHAIN) return { walletId: link.walletId, address: link.address }
    const w = await liveWallet(userToken as string)
    if (!w) throw new CircleWalletError('no-wallet', 'Your Circle wallet is not set up yet')
    const address = getAddress(w.address)
    await repo.saveWallet(authUid, w.id, address, CIRCLE_CHAIN)
    links.set(authUid, { link: { ...link, walletId: w.id, address, blockchain: CIRCLE_CHAIN }, exp: now() + LINK_CACHE_MS })
    return { walletId: w.id, address }
  }

  return {
    /** For a Google sign-in: device credentials for this browser. Needs no MeshPort session (it starts the sign-in). */
    async socialDeviceToken(deviceId: unknown) {
      return call(() => circle.request<{ deviceToken: string; deviceEncryptionKey?: string }>('POST', '/v1/w3s/users/social/token',
        { body: { idempotencyKey: crypto.randomUUID(), deviceId: needDevice(deviceId) } }))
    },

    /** For Circle's email-code sign-in: always the MeshPort account's own email, never one from the request. */
    async emailDeviceToken(deviceId: unknown, accountEmail: string | null) {
      if (!accountEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) bad('This MeshPort account has no email address')
      return call(() => circle.request<{ deviceToken: string; deviceEncryptionKey?: string; otpToken?: string }>('POST', '/v1/w3s/users/email/token',
        { body: { idempotencyKey: crypto.randomUUID(), deviceId: needDevice(deviceId), email: accountEmail } }))
    },

    async refresh(userToken: unknown, refreshToken: unknown, deviceId: unknown) {
      if (typeof refreshToken !== 'string' || refreshToken.length < 20) bad('refreshToken is missing')
      return call(() => circle.request<{ userToken: string; encryptionKey?: string; refreshToken?: string }>('POST', '/v1/w3s/users/token/refresh',
        { userToken: needToken(userToken), body: { idempotencyKey: crypto.randomUUID(), refreshToken: refreshToken as string, deviceId: needDevice(deviceId) } }))
    },

    /** Link this MeshPort account to the Circle user signed in with `userToken` (first time), or confirm it. */
    async link(authUid: string, userToken: unknown) {
      const circleUserId = await circleUserOf(needToken(userToken))
      const existing = await linkOf(authUid)
      if (existing) {
        if (existing.circleUserId !== circleUserId) throw new CircleWalletError('linked-elsewhere', 'This MeshPort account uses a different Circle sign-in')
        return { circleUserId }
      }
      if (await repo.saveLink(authUid, circleUserId) === 'taken') {
        throw new CircleWalletError('linked-elsewhere', 'This Circle sign-in belongs to a different MeshPort account')
      }
      links.delete(authUid)
      return { circleUserId }
    },

    /**
     * A challenge that creates the user's EVM wallet, or { ready } if it
     * exists. A user Circle set up before (e.g. with an Arc-only wallet) gets
     * the EVM wallet added instead of a second set-up.
     */
    async initialize(authUid: string, userToken: unknown): Promise<{ challengeId: string } | { ready: true }> {
      await linked(authUid, userToken)
      const token = userToken as string
      try {
        const r = await circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/initialize', {
          userToken: token, body: { idempotencyKey: crypto.randomUUID(), accountType: 'EOA', blockchains: [CIRCLE_CHAIN] },
        })
        return { challengeId: r.challengeId }
      } catch (e) {
        if (!(e instanceof CircleApiError && e.code === CIRCLE_ERR.userWasInitialized)) return call(() => Promise.reject(e))
      }
      if (await liveWallet(token)) return { ready: true }
      const r = await call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/wallets', {
        userToken: token, body: { idempotencyKey: crypto.randomUUID(), accountType: 'EOA', blockchains: [CIRCLE_CHAIN] },
      }))
      return { challengeId: r.challengeId }
    },

    /** The account's wallet (looked up at Circle once, then remembered). */
    async wallet(authUid: string, userToken: unknown) {
      const { walletId, address } = await walletOf(authUid, userToken)
      return { walletId, address, blockchain: CIRCLE_CHAIN }
    },

    /** A challenge to sign an EVM transaction; the app broadcasts the result itself. */
    async signTransaction(authUid: string, userToken: unknown, req: { transaction?: unknown }) {
      const transaction = circleTransaction(req.transaction)
      const { walletId } = await walletOf(authUid, userToken)
      return call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/sign/transaction', {
        userToken: userToken as string, body: { walletId, transaction },
      }))
    },

    async signMessage(authUid: string, userToken: unknown, req: { message?: unknown; encodedByHex?: unknown }) {
      if (typeof req.message !== 'string' || !req.message || req.message.length > 10_000) bad('message is missing or too long')
      if (req.encodedByHex === true && !HEX.test(req.message as string)) bad('message is not hex')
      const { walletId } = await walletOf(authUid, userToken)
      return call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/sign/message', {
        userToken: userToken as string, body: { walletId, message: req.message as string, encodedByHex: req.encodedByHex === true },
      }))
    },

    async signTypedData(authUid: string, userToken: unknown, req: { typedData?: unknown }) {
      const t = req.typedData as { domain?: unknown; types?: unknown; primaryType?: unknown; message?: unknown } | undefined
      if (!t || typeof t !== 'object' || !t.domain || !t.types || typeof t.primaryType !== 'string' || !t.message) bad('typedData must have domain, types, primaryType and message')
      const data = JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
      if (data.length > 50_000) bad('typedData is too large')
      const { walletId } = await walletOf(authUid, userToken)
      return call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/sign/typedData', {
        userToken: userToken as string, body: { walletId, data },
      }))
    },

    /** A challenge's status (after the app runs it in Circle's SDK). */
    async challenge(authUid: string, userToken: unknown, id: unknown) {
      await linked(authUid, userToken)
      const r = await call(() => circle.request<{ challenge: { id: string; status: string; type: string; correlationIds?: string[]; errorCode?: number; errorMessage?: string } }>(
        'GET', `/v1/w3s/user/challenges/${needUuid(id, 'challengeId')}`, { userToken: userToken as string }))
      const c = r.challenge
      return { id: c.id, status: c.status, type: c.type, errorCode: c.errorCode ?? null, errorMessage: c.errorMessage ?? null }
    },
  }
}

export type CircleWalletService = ReturnType<typeof createCircleWalletService>
