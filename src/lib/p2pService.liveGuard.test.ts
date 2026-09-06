/**
 * Regression tests for the "no on-chain hash, no P2P Activity row" invariant.
 *
 * WHAT THIS PROTECTS
 * A P2P activity row asserts that USDC moved. Without a tx_hash there is nothing
 * to verify it against, and the row is also structurally undedupable — every
 * unique index on `activity` is over (tx_hash, wallet_address), and Postgres
 * treats NULLs as distinct, so each hashless insert is an unguarded new row.
 * Production proof: one wallet held 45 hashless rows, including six copies each
 * of the same event and a "-100 USDC Sell Order Created" for an offer whose
 * escrow was never funded (getRemaining() = 0 on both deployed escrow
 * contracts, and no deposit transaction for its offerKey on either).
 *
 * THE INVARIANT
 * Every P2P write in p2pService.ts routes through saveP2PActivity(), which
 * refuses to write when txHash is absent. Critically it does NOT gate the P2P
 * action itself: the offer is still created, the top-up still lands, the trade
 * still completes. Only the unverifiable feed entry is withheld.
 *
 * Honor-system mode is the case that reaches the guard without a hash — with
 * VITE_P2P_ESCROW_CONTRACT unset, HonorSystemFallbackEscrowProvider returns
 * `{ success: true }` and no txHash, because nothing was locked on-chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const saveActivity = vi.fn(async (_p: any) => true)
vi.mock('@/lib/ActivityService', () => ({ saveActivity: (p: any) => saveActivity(p) }))

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
  ensureAnonSession: vi.fn(),
}))
vi.mock('@/lib/chatService', () => ({
  authHeaders: vi.fn(async () => ({ apikey: 'test', Authorization: 'Bearer test' })),
  subscribeWithRetry: vi.fn(() => () => {}),
}))

// Configurable escrow provider — `depositTxHash = undefined` models honor-system
// mode (success, but nothing actually moved on-chain).
const escrow = {
  depositTxHash: undefined as string | undefined,
  depositSucceeds: true,
}
vi.mock('@/lib/p2pProviders', () => ({
  escrowProvider: {
    depositForOffer: vi.fn(async () => ({
      success: escrow.depositSucceeds,
      txHash: escrow.depositTxHash,
      message: escrow.depositSucceeds ? 'ok' : 'deposit rejected',
    })),
    depositForTrade: vi.fn(async () => ({
      success: escrow.depositSucceeds, txHash: escrow.depositTxHash, message: 'ok',
    })),
    lockFunds: vi.fn(async () => ({ success: true, message: 'ok' })),
    release:   vi.fn(async () => ({ success: true, txHash: escrow.depositTxHash, message: 'ok' })),
    refund:    vi.fn(async () => ({ success: true, txHash: escrow.depositTxHash, message: 'ok' })),
  },
  paymentProvider: {},
}))

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ load: vi.fn(async () => {}), isEnabled: () => true }),
  },
}))

import { saveP2PActivity, createOffer, topUpOfferEscrow } from '@/lib/p2pService'
import type { P2POffer } from '@/lib/p2pService'

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const USER   = 'user-1'

const jsonRes = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => '' })

/** Routes the handful of REST calls the paths under test make. */
function installFetch(over: { offerInsert?: any } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    if (url.includes('/p2p_banned_users')) return jsonRes([])          // not banned
    if (url.includes('/p2p_offers?') && init?.method === 'PATCH') return jsonRes([])
    if (url.includes('/p2p_offers')) return jsonRes(over.offerInsert ?? [{
      id: 'offer-new', user_id: USER, wallet_address: WALLET, offer_type: 'sell',
      currency: 'INR', price_per_usdc: '90', min_amount: '1', max_amount: '100',
      payment_methods: [], country_region: 'IN', status: 'active',
      escrow_deposit_tx_hash: escrow.depositTxHash ?? null,
      created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z',
    }])
    return jsonRes([])
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sellOffer(over: Partial<P2POffer> = {}): P2POffer {
  return {
    id: '77a75512-8714-402b-96aa-18ebfdd55158', userId: USER, walletAddress: WALLET,
    offerType: 'sell', currency: 'INR', pricePerUsdc: 90, minAmount: 1, maxAmount: 10,
    paymentMethods: [], countryRegion: 'IN', status: 'active', isVerifiedMerchant: false,
    escrowBalance: 10, createdAt: '2026-08-01T03:45:39Z', updatedAt: '2026-08-01T03:45:39Z',
    ...over,
  } as P2POffer
}

const p2pWrites = () => saveActivity.mock.calls.map(c => (c as any[])[0] as any)

beforeEach(() => {
  saveActivity.mockReset()
  saveActivity.mockImplementation(async (_p: any) => true)
  escrow.depositTxHash = undefined
  escrow.depositSucceeds = true
  installFetch()
})
afterEach(() => { vi.unstubAllGlobals() })

// ── The choke point itself ───────────────────────────────────────────────────

describe('saveP2PActivity — the guard every P2P write routes through', () => {
  it('refuses to write when txHash is undefined', async () => {
    const ok = await saveP2PActivity({
      walletAddress: WALLET, activityType: 'p2p_sell_order', amount: 100,
      metadata: { offerId: 'o1', kind: 'offer_created' },
    })
    expect(ok).toBe(false)
    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('refuses to write when txHash is an empty string', async () => {
    const ok = await saveP2PActivity({
      walletAddress: WALLET, txHash: '', activityType: 'p2p_refund', amount: 100,
      metadata: { offerId: 'o1', kind: 'offer_cancelled' },
    })
    expect(ok).toBe(false)
    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('writes and returns true when a txHash is present', async () => {
    const ok = await saveP2PActivity({
      walletAddress: WALLET, txHash: '0xabc', activityType: 'p2p_purchase', amount: 5,
      metadata: { tradeId: 't1' },
    })
    expect(ok).toBe(true)
    expect(saveActivity).toHaveBeenCalledTimes(1)
    expect(p2pWrites()[0].txHash).toBe('0xabc')
  })

  it('returns false (never throws) when the underlying write fails', async () => {
    saveActivity.mockResolvedValueOnce(false)
    await expect(saveP2PActivity({
      walletAddress: WALLET, txHash: '0xabc', activityType: 'p2p_purchase', amount: 5,
    })).resolves.toBe(false)
  })

  it('returns false (never throws) when the underlying write rejects', async () => {
    saveActivity.mockRejectedValueOnce(new Error('network down'))
    await expect(saveP2PActivity({
      walletAddress: WALLET, txHash: '0xabc', activityType: 'p2p_purchase', amount: 5,
    })).resolves.toBe(false)
  })

  it('passes every field through unchanged when it does write', async () => {
    await saveP2PActivity({
      walletAddress: WALLET, userId: USER, txHash: '0xdead',
      activityType: 'p2p_sell_order', amount: 40, status: 'completed',
      metadata: { offerId: 'o9', kind: 'offer_created' },
    })
    const w = p2pWrites()[0]
    expect(w).toMatchObject({
      walletAddress: WALLET, userId: USER, txHash: '0xdead',
      activityType: 'p2p_sell_order', amount: 40, status: 'completed',
    })
    expect(w.metadata).toEqual({ offerId: 'o9', kind: 'offer_created' })
  })
})

// ── Live path: createOffer (the path that produced the ghost sell orders) ────

describe('createOffer — offer still created, unverifiable row withheld', () => {
  it('honor-system deposit (no hash): offer IS created, NO activity row', async () => {
    escrow.depositTxHash = undefined

    const res = await createOffer({
      userId: USER, walletAddress: WALLET, offerType: 'sell', currency: 'INR',
      pricePerUsdc: 90, minAmount: 1, maxAmount: 100,
      paymentMethods: ['upi'], countryRegion: 'IN',
    })

    // The P2P action itself must be unaffected.
    expect(res.error).toBeUndefined()
    expect(res.offer).not.toBeNull()
    // ...but no unverifiable financial row.
    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('real escrow deposit (hash present): offer created AND row written', async () => {
    escrow.depositTxHash = '0xdeposit1'

    const res = await createOffer({
      userId: USER, walletAddress: WALLET, offerType: 'sell', currency: 'INR',
      pricePerUsdc: 90, minAmount: 1, maxAmount: 100,
      paymentMethods: ['upi'], countryRegion: 'IN',
    })

    expect(res.offer).not.toBeNull()
    expect(saveActivity).toHaveBeenCalledTimes(1)
    expect(p2pWrites()[0]).toMatchObject({
      activityType: 'p2p_sell_order', txHash: '0xdeposit1', amount: 100,
    })
    expect(p2pWrites()[0].metadata.kind).toBe('offer_created')
  })

  it('a BUY offer writes no row either way (nothing escrowed at creation)', async () => {
    escrow.depositTxHash = '0xdeposit1'

    const res = await createOffer({
      userId: USER, walletAddress: WALLET, offerType: 'buy', currency: 'INR',
      pricePerUsdc: 90, minAmount: 1, maxAmount: 100,
      paymentMethods: ['upi'], countryRegion: 'IN',
    })

    expect(res.offer).not.toBeNull()
    expect(saveActivity).not.toHaveBeenCalled()
  })
})

// ── Live path: topUpOfferEscrow (the 3 legitimate top-ups) ──────────────────

describe('topUpOfferEscrow — top-up still applied, unverifiable row withheld', () => {
  it('honor-system top-up (no hash): top-up SUCCEEDS, NO activity row', async () => {
    escrow.depositTxHash = undefined

    const res = await topUpOfferEscrow(sellOffer(), USER, 5)

    expect(res.success).toBe(true)          // the action is not blocked
    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('real top-up (hash present): row written with the deposit hash', async () => {
    escrow.depositTxHash = '0x13991c7b'

    const res = await topUpOfferEscrow(sellOffer(), USER, 10)

    expect(res.success).toBe(true)
    expect(saveActivity).toHaveBeenCalledTimes(1)
    expect(p2pWrites()[0]).toMatchObject({
      activityType: 'p2p_sell_order', txHash: '0x13991c7b', amount: 10,
    })
    expect(p2pWrites()[0].metadata.kind).toBe('offer_topped_up')
  })

  it('PRESERVES three legitimate top-ups on ONE offer with different hashes', async () => {
    // The exact production shape that must never be treated as duplicates:
    // 10 / 5 / 10 USDC against offer 77a75512…, three distinct tx hashes.
    const offer = sellOffer()
    const hashes = ['0x13991c7b', '0x7bfd490c', '0x4cd8fc74']
    const amounts = [10, 5, 10]

    for (let i = 0; i < 3; i++) {
      escrow.depositTxHash = hashes[i]
      const res = await topUpOfferEscrow(offer, USER, amounts[i])
      expect(res.success).toBe(true)
    }

    expect(saveActivity).toHaveBeenCalledTimes(3)
    expect(p2pWrites().map(w => w.txHash)).toEqual(hashes)
    expect(p2pWrites().map(w => w.amount)).toEqual(amounts)
    // Same offer, same type, same kind — distinguished ONLY by tx_hash.
    expect(new Set(p2pWrites().map(w => w.metadata.offerId)).size).toBe(1)
    expect(new Set(p2pWrites().map(w => w.metadata.kind))).toEqual(new Set(['offer_topped_up']))
    expect(new Set(p2pWrites().map(w => w.txHash)).size).toBe(3)
  })

  it('a failed deposit writes no row and reports failure', async () => {
    escrow.depositSucceeds = false
    escrow.depositTxHash = undefined

    const res = await topUpOfferEscrow(sellOffer(), USER, 5)

    expect(res.success).toBe(false)
    expect(saveActivity).not.toHaveBeenCalled()
  })
})

// ── Source assertion: covers ALL ten live paths at once ─────────────────────

describe('p2pService source — no P2P write may bypass the guard', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/p2pService.ts'), 'utf8')

  it('has no direct saveActivity() call carrying a p2p_* activityType', () => {
    // Scan each saveActivity({ … }) block for a p2p_ type. Any hit is a bypass.
    const offenders: string[] = []
    const re = /saveActivity\(\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const block = src.slice(m.index, m.index + 400)
      if (/activityType:\s*'p2p_/.test(block)) {
        offenders.push(`offset ${m.index}: ${block.split('\n').slice(0, 4).join(' ')}`)
      }
    }
    expect(offenders, `direct P2P saveActivity call(s) found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('routes at least the ten known live write sites through saveP2PActivity', () => {
    const sites = src.match(/await saveP2PActivity\(\{/g) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(10)
  })

  it('calls the raw saveActivity exactly once — inside the guard', () => {
    // Matches the real call expression only. A bare `saveActivity()` in prose
    // does not qualify, so doc comments cannot skew this count.
    const raw = src.match(/saveActivity\(params\)/g) ?? []
    expect(raw).toHaveLength(1)               // `return saveActivity(params)`
  })

  it('the guard still short-circuits on a missing txHash', () => {
    expect(src).toMatch(/export async function saveP2PActivity/)
    expect(src).toMatch(/if \(!params\.txHash\)/)
  })

  it('the backfill emits through the guard, not through saveActivity', () => {
    const emit = src.slice(src.indexOf('const emit = async'), src.indexOf('const emit = async') + 400)
    expect(emit).toMatch(/await saveP2PActivity\(params\)/)
  })
})
