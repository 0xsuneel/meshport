// server/circle/service.ts
//
// MeshPort's backend for Circle User-Controlled Wallets (EOA on Arc testnet).
// Users sign in to MeshPort as before (Supabase) and to Circle with Circle's
// own Google login or email OTP; every action is approved by the user in
// Circle's SDK (a challenge). This file never sees keys, PINs or OTP codes.
//
// Identity: one MeshPort account is linked to exactly one Circle user. Every
// call that acts for a user checks that the Circle session (X-User-Token)
// belongs to the Circle user linked to the signed-in MeshPort account, so one
// person's Circle session can never act on another's MeshPort account. The
// wallet a call acts on comes from that link, never from the request.

import { getAddress, isAddress } from 'viem'
import { CIRCLE_ERR, CircleApiError, type CircleClient } from './client'

export const CIRCLE_CHAIN = 'ARC-TESTNET'
const SESSION_CACHE_MS = 5 * 60_000

export type CircleWalletErrorCode =
  | 'bad-request'      // malformed input
  | 'session'          // Circle session missing, expired or not this account's: sign in to Circle again
  | 'not-linked'       // no Circle user linked to this MeshPort account yet
  | 'linked-elsewhere' // this Circle login belongs to a different MeshPort account (or vice versa)
  | 'no-wallet'        // the Circle user has no Arc wallet yet: initialize first
  | 'circle'           // Circle refused or failed

export class CircleWalletError extends Error {
  constructor(public code: CircleWalletErrorCode, message: string) { super(message) }
}

export interface CircleLink { circleUserId: string; walletId: string | null; address: string | null }

export interface CircleRepo {
  /** The Circle user (and wallet) linked to this MeshPort account, if any. */
  link(authUid: string): Promise<CircleLink | null>
  /** Link a Circle user; 'taken' if that Circle user is linked to another account. */
  saveLink(authUid: string, circleUserId: string): Promise<'saved' | 'taken'>
  saveWallet(authUid: string, walletId: string, address: string): Promise<void>
}

export interface TokenBalance { symbol: string; amount: string; tokenId: string; isNative: boolean; tokenAddress: string | null; decimals: number | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AMOUNT = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

const bad = (m: string): never => { throw new CircleWalletError('bad-request', m) }
const uuidOr = (v: unknown, what: string): string => {
  if (v === undefined || v === null || v === '') return crypto.randomUUID()
  if (typeof v !== 'string' || !UUID.test(v)) bad(`${what} must be a UUID`)
  return v as string
}
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

async function tokenKey(userToken: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userToken)))
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('')
}

export function createCircleWalletService(opts: { circle: CircleClient; repo: CircleRepo; now?: () => number }) {
  const { circle, repo } = opts
  const now = opts.now ?? Date.now
  // Which Circle user a session token belongs to (keyed by the token's hash, never the token).
  const sessions = new Map<string, { circleUserId: string; exp: number }>()

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
    const [link, circleUserId] = await Promise.all([repo.link(authUid), circleUserOf(token)])
    if (!link) throw new CircleWalletError('not-linked', 'Connect your Circle wallet first')
    if (link.circleUserId !== circleUserId) throw new CircleWalletError('linked-elsewhere', 'This Circle sign-in belongs to a different MeshPort account')
    return link
  }

  async function walletOf(authUid: string, userToken: unknown): Promise<{ link: CircleLink; walletId: string; address: string }> {
    const link = await linked(authUid, userToken)
    if (link.walletId && link.address) return { link, walletId: link.walletId, address: link.address }
    const w = await findWallet(authUid, userToken as string)
    return { link, ...w }
  }

  async function findWallet(authUid: string, userToken: string): Promise<{ walletId: string; address: string }> {
    const r = await call(() => circle.request<{ wallets?: Array<{ id: string; address: string; blockchain: string; state: string; accountType?: string; createDate: string }> }>(
      'GET', '/v1/w3s/wallets', { userToken, query: { blockchain: CIRCLE_CHAIN } }))
    const live = (r.wallets ?? [])
      .filter(w => w.blockchain === CIRCLE_CHAIN && w.state === 'LIVE' && w.accountType === 'EOA')
      .sort((a, b) => a.createDate.localeCompare(b.createDate))
    if (!live.length) throw new CircleWalletError('no-wallet', 'Your Circle wallet is not set up yet')
    const address = getAddress(live[0].address)
    await repo.saveWallet(authUid, live[0].id, address)
    return { walletId: live[0].id, address }
  }

  async function balancesOf(userToken: string, walletId: string): Promise<TokenBalance[]> {
    const r = await call(() => circle.request<{ tokenBalances?: Array<{ amount: string; token: { id: string; symbol?: string; isNative: boolean; tokenAddress?: string; decimals?: number } }> }>(
      'GET', `/v1/w3s/wallets/${walletId}/balances`, { userToken, query: { includeAll: 'true' } }))
    return (r.tokenBalances ?? []).map(b => ({
      symbol: b.token.symbol ?? '', amount: b.amount, tokenId: b.token.id, isNative: b.token.isNative,
      tokenAddress: b.token.tokenAddress ?? null, decimals: b.token.decimals ?? null,
    }))
  }

  return {
    /** For Circle's Web SDK Google login (performLogin): device credentials for this browser. */
    async socialDeviceToken(deviceId: unknown) {
      return call(() => circle.request<{ deviceToken: string; deviceEncryptionKey?: string }>('POST', '/v1/w3s/users/social/token',
        { body: { idempotencyKey: crypto.randomUUID(), deviceId: needDevice(deviceId) } }))
    },

    /** For Circle's email OTP login: always the MeshPort account's own email, never one from the request. */
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
      const existing = await repo.link(authUid)
      if (existing) {
        if (existing.circleUserId !== circleUserId) throw new CircleWalletError('linked-elsewhere', 'This MeshPort account uses a different Circle sign-in')
        return { circleUserId, walletId: existing.walletId, address: existing.address }
      }
      if (await repo.saveLink(authUid, circleUserId) === 'taken') {
        throw new CircleWalletError('linked-elsewhere', 'This Circle sign-in belongs to a different MeshPort account')
      }
      return { circleUserId, walletId: null, address: null }
    },

    /** First use: a challenge that creates the user's Arc EOA wallet; { initialized } if it exists already. */
    async initialize(authUid: string, userToken: unknown): Promise<{ challengeId: string } | { initialized: true }> {
      await linked(authUid, userToken)
      try {
        const r = await circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/initialize', {
          userToken: userToken as string,
          body: { idempotencyKey: crypto.randomUUID(), accountType: 'EOA', blockchains: [CIRCLE_CHAIN] },
        })
        return { challengeId: r.challengeId }
      } catch (e) {
        if (e instanceof CircleApiError && e.code === CIRCLE_ERR.userWasInitialized) return { initialized: true }
        return call(() => Promise.reject(e))
      }
    },

    /** The account's Arc wallet (looked up at Circle once, then remembered). */
    async wallet(authUid: string, userToken: unknown) {
      const { walletId, address } = await walletOf(authUid, userToken)
      return { walletId, address, blockchain: CIRCLE_CHAIN }
    },

    async balances(authUid: string, userToken: unknown) {
      const { walletId } = await walletOf(authUid, userToken)
      return { balances: await balancesOf(userToken as string, walletId) }
    },

    /** A transfer challenge; the user approves it in Circle's SDK. Retrying with the same idempotencyKey never sends twice. */
    async transfer(authUid: string, userToken: unknown, req: { to?: unknown; amount?: unknown; symbol?: unknown; idempotencyKey?: unknown }) {
      if (typeof req.to !== 'string' || !isAddress(req.to)) bad('Enter a valid 0x address to send to')
      if (typeof req.amount !== 'string' || !AMOUNT.test(req.amount) || /^0(?:\.0+)?$/.test(req.amount)) bad('Enter an amount above 0, like 1.50')
      const symbol = typeof req.symbol === 'string' && req.symbol ? req.symbol.toUpperCase() : 'USDC'
      const idempotencyKey = uuidOr(req.idempotencyKey, 'idempotencyKey')
      const { walletId } = await walletOf(authUid, userToken)
      const token = (await balancesOf(userToken as string, walletId)).find(b => b.symbol.toUpperCase() === symbol)
      if (!token) bad(`No ${symbol} in this wallet`)
      const decimals = token!.decimals
      if (decimals !== null && ((req.amount as string).split('.')[1]?.length ?? 0) > decimals) bad(`${symbol} has at most ${decimals} decimals`)
      const r = await call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/transactions/transfer', {
        userToken: userToken as string,
        body: { idempotencyKey, walletId, destinationAddress: getAddress(req.to as string), amounts: [req.amount as string], tokenId: token!.tokenId, feeLevel: 'MEDIUM' },
      }))
      return { challengeId: r.challengeId, idempotencyKey }
    },

    /** A contract call challenge (swap, bridge, escrow…): raw calldata, approved in Circle's SDK. */
    async contractExecution(authUid: string, userToken: unknown, req: { contractAddress?: unknown; callData?: unknown; amount?: unknown; idempotencyKey?: unknown }) {
      if (typeof req.contractAddress !== 'string' || !isAddress(req.contractAddress)) bad('contractAddress is not an address')
      if (typeof req.callData !== 'string' || !HEX.test(req.callData) || req.callData.length < 10) bad('callData must be hex calldata')
      if (req.amount !== undefined && (typeof req.amount !== 'string' || !AMOUNT.test(req.amount))) bad('amount must be a decimal string')
      const idempotencyKey = uuidOr(req.idempotencyKey, 'idempotencyKey')
      const { walletId } = await walletOf(authUid, userToken)
      const r = await call(() => circle.request<{ challengeId: string }>('POST', '/v1/w3s/user/transactions/contractExecution', {
        userToken: userToken as string,
        body: {
          idempotencyKey, walletId, contractAddress: getAddress(req.contractAddress as string), callData: req.callData as string,
          ...(req.amount ? { amount: req.amount as string } : {}), feeLevel: 'MEDIUM',
        },
      }))
      return { challengeId: r.challengeId, idempotencyKey }
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

    /** A challenge's status (after the user acts in Circle's SDK). */
    async challenge(authUid: string, userToken: unknown, id: unknown) {
      await linked(authUid, userToken)
      const r = await call(() => circle.request<{ challenge: { id: string; status: string; type: string; correlationIds?: string[]; errorCode?: number; errorMessage?: string } }>(
        'GET', `/v1/w3s/user/challenges/${needUuid(id, 'challengeId')}`, { userToken: userToken as string }))
      const c = r.challenge
      return { id: c.id, status: c.status, type: c.type, transactionIds: c.correlationIds ?? [], errorCode: c.errorCode ?? null, errorMessage: c.errorMessage ?? null }
    },

    /** A transaction's state and hash - only for this account's own wallet. */
    async transaction(authUid: string, userToken: unknown, id: unknown) {
      const { walletId } = await walletOf(authUid, userToken)
      const r = await call(() => circle.request<{ transaction?: { id: string; state: string; txHash?: string; walletId?: string; errorReason?: string; operation?: string } }>(
        'GET', `/v1/w3s/transactions/${needUuid(id, 'transaction id')}`, { userToken: userToken as string }))
      const t = r.transaction
      if (!t || (t.walletId && t.walletId !== walletId)) throw new CircleWalletError('bad-request', 'No such transaction for this wallet')
      return { id: t.id, state: t.state, txHash: t.txHash ?? null, operation: t.operation ?? null, errorReason: t.errorReason ?? null }
    },
  }
}

export type CircleWalletService = ReturnType<typeof createCircleWalletService>
