/**
 * Regression tests for the stuck-release bug.
 *
 * THE BUG
 * Releasing is two steps: claim the trade ('payment_sent' -> 'released'), then
 * move funds on-chain. Two production trades ended up permanently at
 *
 *   status='released', released_at=NULL, completed_at=NULL, tx_hash=NULL
 *
 * with their offers still pinned by locked_by_trade_id. Verified on Arc that
 * neither buyer was ever paid: the contract's own tradeReleased flag reads false
 * for both, no release transaction exists, and no direct transfer was made.
 *
 * Three defects combined:
 *   1. updateTradeStatus() did `await fetch(...)` with no res.ok check and a void
 *      return, so a failed compensating PATCH was silently discarded.
 *   2. releaseTrade() had no try/catch, so a throw between the claim and the
 *      revert skipped the revert entirely.
 *   3. Nothing server-side ever detected the resulting state, and unlockOffer()
 *      swallowed its own failures too, so the offer stayed locked forever.
 *
 * THE FIX
 * updateTradeStatus/unlockOffer now report success; releaseTrade compensates on
 * every path including a throw, and never reverts a claim once funds have
 * actually moved; and reconcileStuckReleases() repairs the state afterwards
 * using the contract as the oracle — classifyStuckRelease() is the pure decision
 * function, tested exhaustively here, whose governing rule is that "unknown" is
 * never treated as "zero" and no verdict ever moves funds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const saveActivity = vi.fn(async (_p: any) => true)
vi.mock('@/lib/ActivityService', () => ({ saveActivity: (p: any) => saveActivity(p) }))
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } }, ensureAnonSession: vi.fn(),
}))
vi.mock('@/lib/chatService', () => ({
  authHeaders: vi.fn(async () => ({ apikey: 't', Authorization: 'Bearer t' })),
  subscribeWithRetry: vi.fn(() => () => {}),
}))

// Controllable escrow provider + on-chain probes.
const chain = {
  releaseSucceeds: true,
  releaseThrows: false,
  releaseTxHash: '0xreleased' as string | undefined,
  onChainReleased: null as boolean | null,
  escrowRemaining: null as number | null,
}
vi.mock('@/lib/p2pProviders', () => ({
  escrowProvider: {
    release: vi.fn(async () => {
      if (chain.releaseThrows) throw new Error('wallet unavailable')
      return chain.releaseSucceeds
        ? { success: true, txHash: chain.releaseTxHash, message: 'ok' }
        : { success: false, message: 'escrow release reverted' }
    }),
    refund: vi.fn(async () => ({ success: true, message: 'ok' })),
    depositForOffer: vi.fn(async () => ({ success: true, message: 'ok' })),
    depositForTrade: vi.fn(async () => ({ success: true, message: 'ok' })),
    lockFunds: vi.fn(async () => ({ success: true, message: 'ok' })),
  },
  paymentProvider: {},
}))
vi.mock('@/lib/p2pEscrowContract', () => ({
  probeTradeReleasedOnChain: vi.fn(async () => chain.onChainReleased),
  probeEscrowRemaining: vi.fn(async () => chain.escrowRemaining),
  isEscrowContractDeployed: vi.fn(() => true),
  isEscrowPaused: vi.fn(async () => false),
}))
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ load: vi.fn(async () => {}), isEnabled: () => true }) },
}))
vi.mock('@/lib/notificationService', () => ({ sendPushToUser: vi.fn(async () => {}) }))

import {
  releaseTrade, classifyStuckRelease, reconcileStuckReleases,
  type P2PTrade,
} from '@/lib/p2pService'

const SELLER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const BUYER  = '0xfe2ac69fe72e91f1642e98ce0cdf55b8d1800e43'
// Activation cutoff for these tests: before the fixture trade (Aug 7) so it is
// in scope. The sweep is dormant without one — asserted separately below.
const ACTIVATION = '2026-08-01T00:00:00.000Z'

function trade(over: Partial<P2PTrade> = {}): P2PTrade {
  return {
    id: '568baca0-9f25-4138-8a70-af28055e35d3',
    offerId: '77a75512-8714-402b-96aa-18ebfdd55158',
    offerType: 'sell', buyerId: 'buyer-1', buyerWallet: BUYER,
    sellerId: 'seller-1', sellerWallet: SELLER,
    amountUsdc: 5, pricePerUsdc: 90, amountFiat: 450, currency: 'INR',
    paymentMethod: 'upi', status: 'payment_sent', expiresAt: '2026-12-01T00:00:00Z',
    adminFrozen: false, disputeStatus: 'none',
    createdAt: '2026-08-07T02:13:51Z',
    ...over,
  } as P2PTrade
}

// ── Request recorder ────────────────────────────────────────────────────────
interface Rec { url: string; method: string; body: any }
const recorded: Rec[] = []
const failPatch = { tradeStatus: false, unlockOffer: false }

function installFetch(opts: { stuckTrades?: any[] } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    recorded.push({ url, method, body })

    // conditional claim PATCH: ?id=eq.X&status=in.(payment_sent)
    if (url.includes('/p2p_trades?') && url.includes('status=in.') && method === 'PATCH') {
      return { ok: true, status: 200, json: async () => [{ id: 'claimed' }] }
    }
    // plain trade status PATCH (finalize / revert / reconcile)
    if (url.includes('/p2p_trades?id=eq.') && method === 'PATCH') {
      return failPatch.tradeStatus
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 204, json: async () => [] }
    }
    if (url.includes('/p2p_offers?id=eq.') && method === 'PATCH') {
      return failPatch.unlockOffer
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 204, json: async () => [] }
    }
    if (url.includes('/p2p_offers?id=eq.')) {
      return { ok: true, status: 200, json: async () => [{
        id: '77a75512-8714-402b-96aa-18ebfdd55158', user_id: 'seller-1', wallet_address: SELLER,
        offer_type: 'sell', currency: 'INR', price_per_usdc: '90', min_amount: '1', max_amount: '35',
        payment_methods: [], country_region: 'IN', status: 'active',
        escrow_deposit_tx_hash: '0xdeposit', escrow_balance: '35',
        created_at: '2026-08-01T03:45:39Z', updated_at: '2026-08-01T03:45:39Z',
      }] }
    }
    if (url.includes('/p2p_trades?or=')) return { ok: true, status: 200, json: async () => opts.stuckTrades ?? [] }
    return { ok: true, status: 200, json: async () => [] }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const tradePatches = () => recorded.filter(r => r.url.includes('/p2p_trades?id=eq.') && r.method === 'PATCH')
const offerUnlocks = () => recorded.filter(r => r.url.includes('/p2p_offers?id=eq.') && r.method === 'PATCH'
                                             && r.body && 'locked_by_trade_id' in r.body)

/** A stuck trade row as PostgREST returns it. */
function stuckRow(over: Record<string, any> = {}) {
  return {
    id: '568baca0-9f25-4138-8a70-af28055e35d3',
    offer_id: '77a75512-8714-402b-96aa-18ebfdd55158', offer_type: 'sell',
    buyer_id: 'buyer-1', buyer_wallet: BUYER, seller_id: 'seller-1', seller_wallet: SELLER,
    amount_usdc: '5', price_per_usdc: '90', amount_fiat: '450', currency: 'INR',
    payment_method: 'upi', status: 'released', expires_at: null, tx_hash: null,
    created_at: '2026-08-07T02:13:51Z', released_at: null, completed_at: null,
    ...over,
  }
}

beforeEach(() => {
  recorded.length = 0
  saveActivity.mockReset(); saveActivity.mockImplementation(async (_p: any) => true)
  chain.releaseSucceeds = true; chain.releaseThrows = false; chain.releaseTxHash = '0xreleased'
  chain.onChainReleased = null; chain.escrowRemaining = null
  failPatch.tradeStatus = false; failPatch.unlockOffer = false
  installFetch()
})
afterEach(() => { vi.unstubAllGlobals() })

// ── releaseTrade ────────────────────────────────────────────────────────────

describe('releaseTrade — successful release', () => {
  it('finalizes the trade, unlocks the offer and writes a hashed activity row', async () => {
    const res = await releaseTrade(trade())

    expect(res.success).toBe(true)
    const final = tradePatches().find(p => p.body?.status === 'completed')
    expect(final).toBeTruthy()
    expect(final!.body.released_at).toBeTruthy()
    expect(final!.body.completed_at).toBeTruthy()
    expect(final!.body.tx_hash).toBe('0xreleased')
    expect(offerUnlocks()).toHaveLength(1)
    expect(saveActivity).toHaveBeenCalledTimes(1)
  })
})

describe('releaseTrade — contract release FAILURE reverts the claim', () => {
  it('returns the trade to payment_sent and writes no activity row', async () => {
    chain.releaseSucceeds = false

    const res = await releaseTrade(trade())

    expect(res.success).toBe(false)
    expect(tradePatches().some(p => p.body?.status === 'payment_sent')).toBe(true)
    expect(tradePatches().some(p => p.body?.status === 'completed')).toBe(false)
    expect(saveActivity).not.toHaveBeenCalled()
  })
})

describe('releaseTrade — an EXCEPTION after the claim still compensates', () => {
  it('does not propagate, and reverts the claim to payment_sent', async () => {
    chain.releaseThrows = true

    // Previously the throw escaped and the revert never ran.
    const res = await releaseTrade(trade())

    expect(res.success).toBe(false)
    expect(tradePatches().some(p => p.body?.status === 'payment_sent')).toBe(true)
    expect(saveActivity).not.toHaveBeenCalled()
  })
})

describe('releaseTrade — the revert PATCH itself failing is surfaced', () => {
  it('reports that the trade could not be restored, instead of failing silently', async () => {
    chain.releaseSucceeds = false
    failPatch.tradeStatus = true

    const res = await releaseTrade(trade())

    expect(res.success).toBe(false)
    // The user must be told; previously this was swallowed entirely.
    expect(res.message).toMatch(/could not be returned to its previous state/i)
  })
})

describe('releaseTrade — funds moved but finalize failed: never revert', () => {
  it('does NOT revert to payment_sent when the on-chain release succeeded', async () => {
    chain.releaseSucceeds = true
    failPatch.tradeStatus = true          // finalize PATCH fails

    await releaseTrade(trade())

    // Reverting here would invite a SECOND release of the same funds.
    expect(tradePatches().some(p => p.body?.status === 'payment_sent')).toBe(false)
  })
})

describe('releaseTrade — no double release', () => {
  it('a second caller loses the claim race and never touches escrow', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET'
      if (url.includes('status=in.') && method === 'PATCH') {
        return { ok: true, status: 200, json: async () => [] }   // claim matched 0 rows
      }
      return { ok: true, status: 200, json: async () => [] }
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await releaseTrade(trade({ status: 'released' }))

    expect(res.success).toBe(false)
    expect(res.message).toMatch(/already been released/i)
    expect(saveActivity).not.toHaveBeenCalled()
  })
})

// ── classifyStuckRelease — the safety-critical decision ─────────────────────

describe('classifyStuckRelease', () => {
  it('FINALIZES when the contract says the release happened', () => {
    const r = classifyStuckRelease({ onChainReleased: true, escrowRemaining: 0, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('finalize')
  })

  it('RESTORES when it did not happen and the funds are still escrowed', () => {
    const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: 23, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('restore')
  })

  it('CANCELS only when nothing was ever escrowed', () => {
    const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: 0, everDeposited: false, amountUsdc: 2 })
    expect(r.verdict).toBe('cancel')
  })

  it('INVESTIGATES when the release flag cannot be read — never guesses', () => {
    const r = classifyStuckRelease({ onChainReleased: null, escrowRemaining: 23, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('investigate')
  })

  it('INVESTIGATES when the escrow balance cannot be read', () => {
    const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: null, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('investigate')
  })

  it('INVESTIGATES on partial funds rather than cancelling', () => {
    const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: 3, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('investigate')
  })

  it('INVESTIGATES when escrow was funded but is now empty and unreleased', () => {
    // Money went in and left, but not via this trade's release. Unexplained.
    const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: 0, everDeposited: true, amountUsdc: 5 })
    expect(r.verdict).toBe('investigate')
  })

  it('NO FALSE CANCELLATION: never cancels while funds exist', () => {
    for (const remaining of [0.000001, 1, 4.99, 5, 23, 1000]) {
      const r = classifyStuckRelease({ onChainReleased: false, escrowRemaining: remaining, everDeposited: true, amountUsdc: 5 })
      expect(r.verdict, `remaining=${remaining}`).not.toBe('cancel')
    }
  })

  it('never returns a verdict that moves funds', () => {
    const verdicts = new Set<string>()
    for (const rel of [true, false, null]) {
      for (const rem of [null, 0, 3, 23]) {
        for (const dep of [true, false]) {
          verdicts.add(classifyStuckRelease({
            onChainReleased: rel, escrowRemaining: rem, everDeposited: dep, amountUsdc: 5,
          }).verdict)
        }
      }
    }
    // Only these four exist; none of them sends a transaction.
    expect([...verdicts].sort()).toEqual(['cancel', 'finalize', 'investigate', 'restore'])
  })
})

// ── reconcileStuckReleases ──────────────────────────────────────────────────

describe('reconcileStuckReleases — detection', () => {
  it('detects a stale released trade with null released_at', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out).toHaveLength(1)
    expect(out[0].tradeId).toBe('568baca0-9f25-4138-8a70-af28055e35d3')
  })

  it('ignores healthy trades and ones still inside the grace window', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [
      stuckRow({ id: 'ok-1', status: 'completed', released_at: '2026-08-07T02:20:00Z', completed_at: '2026-08-07T02:20:00Z' }),
      stuckRow({ id: 'fresh', created_at: new Date().toISOString() }),   // too recent
    ] })

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out).toHaveLength(0)
  })
})

describe('reconcileStuckReleases — repair', () => {
  it('successfully restores a stuck trade whose funds are intact', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out[0].verdict).toBe('restore')
    expect(out[0].applied).toBe(true)
    expect(tradePatches().some(p => p.body?.status === 'payment_sent')).toBe(true)
    // Trade is live again, so the offer must STAY locked.
    expect(offerUnlocks()).toHaveLength(0)
  })

  it('finalizes and unlocks when the contract proves the release happened', async () => {
    chain.onChainReleased = true; chain.escrowRemaining = 0
    installFetch({ stuckTrades: [stuckRow()] })

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out[0].verdict).toBe('finalize')
    const fin = tradePatches().find(p => p.body?.status === 'completed')
    expect(fin!.body.released_at).toBeTruthy()
    expect(fin!.body.completed_at).toBeTruthy()
    expect(offerUnlocks()).toHaveLength(1)
    // No hash is known, so no activity row may be fabricated.
    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('cancels and unlocks when nothing was ever escrowed', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 0
    installFetch({ stuckTrades: [stuckRow({ offer_id: 'unfunded-offer' })] })
    // offer lookup returns a deposit hash by default, so override to unfunded
    const prev = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url.includes('/p2p_offers?id=eq.') && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => [{
          id: 'unfunded-offer', user_id: 'seller-1', wallet_address: SELLER, offer_type: 'sell',
          currency: 'INR', price_per_usdc: '90', min_amount: '1', max_amount: '10',
          payment_methods: [], country_region: 'IN', status: 'active',
          escrow_deposit_tx_hash: null, escrow_balance: null,
          created_at: '2026-07-29T09:34:45Z', updated_at: '2026-07-29T09:34:45Z',
        }] }
      }
      return prev(url, init)
    }))

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out[0].verdict).toBe('cancel')
    expect(tradePatches().some(p => p.body?.status === 'cancelled')).toBe(true)
    expect(offerUnlocks()).toHaveLength(1)
  })

  it('changes NOTHING when the chain state is unreadable', async () => {
    chain.onChainReleased = null; chain.escrowRemaining = null
    installFetch({ stuckTrades: [stuckRow()] })

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out[0].verdict).toBe('investigate')
    expect(out[0].applied).toBe(false)
    expect(tradePatches()).toHaveLength(0)
    expect(offerUnlocks()).toHaveLength(0)
  })

  it('reports applied=false when the repair PATCH fails', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })
    failPatch.tradeStatus = true

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(out[0].verdict).toBe('restore')
    expect(out[0].applied).toBe(false)
  })

  it('never writes a duplicate activity row while reconciling', async () => {
    chain.onChainReleased = true; chain.escrowRemaining = 0
    installFetch({ stuckTrades: [stuckRow()] })

    await reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })

    expect(saveActivity).not.toHaveBeenCalled()
  })

  it('never throws, even if the trade fetch blows up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(reconcileStuckReleases('seller-1', { cutoffIso: ACTIVATION })).resolves.toEqual([])
  })
})

// ── The client sweep is also gated by the activation boundary ────────────────

describe('reconcileStuckReleases — activation boundary applies to the client sweep too', () => {
  it('is DORMANT with no cutoff configured, even with a stuck trade present', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })

    // No cutoffIso and no VITE_P2P_RECONCILE_AFTER in the test env.
    const out = await reconcileStuckReleases('seller-1')

    expect(out).toEqual([])
    expect(tradePatches()).toHaveLength(0)
    expect(offerUnlocks()).toHaveLength(0)
  })

  it('ignores a trade that predates the configured cutoff', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })   // created 2026-08-07

    const out = await reconcileStuckReleases('seller-1', { cutoffIso: '2026-08-20T00:00:00.000Z' })

    expect(out).toEqual([])
    expect(tradePatches()).toHaveLength(0)
  })

  it('honours an explicit skip list even when the cutoff would allow it', async () => {
    chain.onChainReleased = false; chain.escrowRemaining = 23
    installFetch({ stuckTrades: [stuckRow()] })

    const out = await reconcileStuckReleases('seller-1', {
      cutoffIso: ACTIVATION,
      skipTradeIds: ['568baca0-9f25-4138-8a70-af28055e35d3'],
    })

    expect(out).toEqual([])
    expect(tradePatches()).toHaveLength(0)
  })
})
