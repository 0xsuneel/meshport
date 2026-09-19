/**
 * Regression tests for backfillP2PActivity — the P2P → Activity catch-up that
 * runs on every ActivityPage mount.
 *
 * WHAT WENT WRONG IN PRODUCTION
 * One wallet accumulated 72 p2p_* activity rows across ~6 Activity visits: six
 * copies each of the same offer's sell_order and refund, five copies of a
 * cancelled trade's pair. Every duplicated row had tx_hash = NULL; all 27 rows
 * that carried a real hash were unique, because those go through saveActivity's
 * on_conflict path and `activity_tx_hash_wallet_address_key` arbitrates them.
 * The database guard worked. The client-side guard did not, for three reasons:
 *
 *   1. the dedup read failed OPEN (`existingRes.ok ? json : []`), so an
 *      unreadable set looked exactly like "no history yet";
 *   2. no mutual exclusion, so overlapping runs both snapshotted `covered`
 *      before either wrote (React.StrictMode double-invokes the effect);
 *   3. hashless rows have no DB uniqueness — a plain UNIQUE (tx_hash,
 *      wallet_address) treats NULLs as distinct.
 *
 * These tests pin the fix: a completed backfill latches, concurrent callers
 * share one run, an unreadable dedup set aborts rather than guesses, and every
 * row the backfill emits carries a tx_hash so the DB constraint is the backstop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// p2pService pulls in a Supabase client, the realtime helper and the escrow
// providers at module load. None are reachable from the backfill; stubbing them
// keeps these tests pure logic with no network and no env vars.
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
  ensureAnonSession: vi.fn(),
}))
vi.mock('@/lib/chatService', () => ({
  authHeaders: vi.fn(async () => ({ apikey: 'test', Authorization: 'Bearer test' })),
  subscribeWithRetry: vi.fn(() => () => {}),
}))
vi.mock('@/lib/p2pProviders', () => ({
  escrowProvider: {}, paymentProvider: {},
}))

const saveActivity = vi.fn(async (_p: any) => true)
vi.mock('@/lib/ActivityService', () => ({ saveActivity: (p: any) => saveActivity(p) }))

import { backfillP2PActivity } from '@/lib/p2pService'

const USER   = 'user-1'
const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'

// Real ids from the production incident, so the shapes under test are the ones
// that actually duplicated.
const OFFER_HASHED   = 'b92f0677-a1e0-4a04-bcad-eb539017f1f3'
const OFFER_HASHLESS = '176e7979-a4df-47ac-9dd8-d48acba0cce8'
const TRADE_CANCELLED = '0d4dbb30-4150-449f-a98a-e6020d26335d'

/** A p2p_offers row as PostgREST returns it. */
function offerRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: OFFER_HASHED, user_id: USER, wallet_address: WALLET, offer_type: 'sell',
    currency: 'INR', price_per_usdc: '90', min_amount: '1', max_amount: '100',
    payment_methods: [], country_region: 'IN', status: 'active',
    escrow_deposit_tx_hash: '0xdep1', escrow_withdraw_tx_hash: null,
    escrow_balance: null, created_at: '2026-07-28T10:00:00Z', updated_at: '2026-07-28T10:00:00Z',
    ...over,
  }
}

/** A p2p_trades row as PostgREST returns it. */
function tradeRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: TRADE_CANCELLED, offer_id: OFFER_HASHED, offer_type: 'buy',
    buyer_id: 'other-user', buyer_wallet: '0xbuyer', seller_id: USER, seller_wallet: WALLET,
    amount_usdc: '5', price_per_usdc: '90', amount_fiat: '450', currency: 'INR',
    payment_method: 'upi', status: 'cancelled', expires_at: null, tx_hash: null,
    created_at: '2026-07-29T10:00:00Z',
    ...over,
  }
}

/**
 * Routes the three requests the backfill makes. `existing` is what the dedup
 * read returns; `existingStatus` lets a test make that read fail.
 */
function installFetch(opts: {
  offers?: Record<string, any>[]
  trades?: Record<string, any>[]
  existing?: any
  existingStatus?: number
}) {
  const { offers = [], trades = [], existing = [], existingStatus = 200 } = opts
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/p2p_trades?')) return jsonRes(trades)
    if (url.includes('/p2p_offers?')) return jsonRes(offers)
    if (url.includes('/activity?')) {
      return existingStatus === 200
        ? jsonRes(existing)
        : { ok: false, status: existingStatus, json: async () => { throw new Error('no body') } }
    }
    return jsonRes([])
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const jsonRes = (body: any) => ({ ok: true, status: 200, json: async () => body })

/** In-memory localStorage — node has none, and the latch depends on it. */
function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  return store
}

const writes = () => saveActivity.mock.calls.map(c => (c as any[])[0] as any)
/** The identity a duplicate would share: type + the offer/trade it references. */
const writeKeys = () => writes().map(w => `${w.activityType}:${w.metadata?.tradeId ?? w.metadata?.offerId}`)

beforeEach(() => {
  // mockReset (not mockClear) — mockClear leaves queued mockResolvedValueOnce
  // values in place, which would leak a forced failure into the next test.
  saveActivity.mockReset()
  saveActivity.mockImplementation(async (_p: any) => true)
  installLocalStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Idempotence across repeated mounts ───────────────────────────────────────

describe('backfillP2PActivity — repeated ActivityPage mounts cannot duplicate', () => {
  it('writes on the first mount and NOTHING on five further mounts', async () => {
    // The exact production shape: six visits to Activity.
    installFetch({ offers: [offerRow()], trades: [] })

    await backfillP2PActivity(USER, WALLET)
    const afterFirst = writes().length
    expect(afterFirst).toBe(1)

    for (let mount = 2; mount <= 6; mount++) await backfillP2PActivity(USER, WALLET)

    // Previously this produced six copies of the same offer's sell_order.
    expect(writes()).toHaveLength(afterFirst)
    expect(writeKeys()).toEqual([`p2p_sell_order:${OFFER_HASHED}`])
  })

  it('collapses concurrent mounts onto a single run (StrictMode double-invoke)', async () => {
    installFetch({ offers: [offerRow()], trades: [] })

    // StrictMode invokes the effect twice with no await in between.
    await Promise.all([
      backfillP2PActivity(USER, WALLET),
      backfillP2PActivity(USER, WALLET),
    ])

    expect(writes()).toHaveLength(1)
  })

  it('collapses many simultaneous callers onto a single run', async () => {
    installFetch({ offers: [offerRow()], trades: [] })

    await Promise.all(Array.from({ length: 8 }, () => backfillP2PActivity(USER, WALLET)))

    expect(writes()).toHaveLength(1)
    expect(new Set(writeKeys()).size).toBe(writes().length)
  })

  it('emits no duplicate keys even when the dedup read reports nothing every time', async () => {
    // The RLS-shaped failure: HTTP 200 with an empty array, indistinguishable
    // from "no history yet". The latch stops the re-run; the tx_hash on every
    // emitted row means the DB constraint would catch anything that slipped.
    installFetch({ offers: [offerRow()], trades: [], existing: [] })

    for (let mount = 1; mount <= 4; mount++) await backfillP2PActivity(USER, WALLET)

    expect(new Set(writeKeys()).size).toBe(writes().length)
    expect(writes()).toHaveLength(1)
  })

  it('skips rows the dedup read already covers', async () => {
    installFetch({
      offers:   [offerRow()],
      trades:   [],
      existing: [{ activity_type: 'p2p_sell_order', metadata: { offerId: OFFER_HASHED } }],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(0)
  })
})

// ── Fail closed ──────────────────────────────────────────────────────────────

describe('backfillP2PActivity — an unreadable dedup set aborts instead of guessing', () => {
  it('writes nothing when the existing-activity read returns 500', async () => {
    installFetch({ offers: [offerRow()], trades: [], existingStatus: 500 })

    await backfillP2PActivity(USER, WALLET)

    // The old code treated this as "no history" and re-inserted everything.
    expect(writes()).toHaveLength(0)
  })

  it('writes nothing when the read is forbidden (RLS / expired token)', async () => {
    installFetch({ offers: [offerRow()], trades: [], existingStatus: 403 })

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(0)
  })

  it('does not latch after a failed read, so a transient failure retries', async () => {
    installFetch({ offers: [offerRow()], trades: [], existingStatus: 500 })
    await backfillP2PActivity(USER, WALLET)
    expect(writes()).toHaveLength(0)

    // Next visit, the read works — the backfill must still be allowed to run.
    installFetch({ offers: [offerRow()], trades: [] })
    await backfillP2PActivity(USER, WALLET)
    expect(writes()).toHaveLength(1)
  })
})

// ── Only provable, money-moved events are emitted ────────────────────────────

describe('backfillP2PActivity — emits only events with on-chain proof', () => {
  it('every emitted row carries a tx_hash, so the DB constraint can dedupe it', async () => {
    installFetch({
      offers: [offerRow({ status: 'cancelled', escrow_withdraw_tx_hash: '0xwd1' })],
      trades: [tradeRow({ status: 'completed', tx_hash: '0xrel1', buyer_id: USER, buyer_wallet: WALLET })],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes().length).toBeGreaterThan(0)
    for (const w of writes()) {
      expect(w.txHash, `${w.activityType} must carry a hash`).toBeTruthy()
    }
  })

  it('does NOT create a sell order for an offer that never deposited escrow', async () => {
    // Honor-system mode: no contract, no deposit, no funds locked. The old code
    // wrote "-100 USDC Sell Order Created" here regardless.
    installFetch({ offers: [offerRow({ id: OFFER_HASHLESS, escrow_deposit_tx_hash: null })], trades: [] })

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(0)
  })

  it('does NOT create a refund for a cancelled offer with no withdrawal hash', async () => {
    installFetch({
      offers: [offerRow({ status: 'cancelled', escrow_deposit_tx_hash: null, escrow_withdraw_tx_hash: null })],
      trades: [],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes().filter(w => w.activityType === 'p2p_refund')).toHaveLength(0)
  })

  it('does NOT create hashless trade_accepted / trade_cancelled rows', async () => {
    // Both hardcoded txHash: undefined and were pure workflow markers rendered
    // as ± USDC. This is the shape behind the screenshot's 5 USDC entries.
    installFetch({
      offers: [],
      trades: [tradeRow({ status: 'cancelled', offer_type: 'buy', tx_hash: null })],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(0)
  })

  it('still backfills a genuine buyer purchase that has a release hash', async () => {
    installFetch({
      offers: [],
      trades: [tradeRow({ status: 'completed', tx_hash: '0xrelease', buyer_id: USER, buyer_wallet: WALLET })],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(1)
    expect(writes()[0].activityType).toBe('p2p_purchase')
    expect(writes()[0].txHash).toBe('0xrelease')
  })
})

// ── The latch must never hide a failed write ─────────────────────────────────

describe('backfillP2PActivity — a failed write cannot permanently latch the backfill', () => {
  it('does NOT latch when saveActivity returns false, and retries next visit', async () => {
    // The exact sequence: write fails, error is absorbed, latch must stay unset.
    installFetch({ offers: [offerRow()], trades: [] })
    saveActivity.mockResolvedValueOnce(false)

    await backfillP2PActivity(USER, WALLET)
    expect(writes()).toHaveLength(1)          // attempted
    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBeNull()

    // Next mount: the wallet is NOT stranded — it tries again and succeeds.
    await backfillP2PActivity(USER, WALLET)
    expect(writes()).toHaveLength(2)
    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBe('1')

    // And now that it is latched, further mounts do nothing.
    await backfillP2PActivity(USER, WALLET)
    expect(writes()).toHaveLength(2)
  })

  it('does NOT latch when saveActivity throws', async () => {
    installFetch({ offers: [offerRow()], trades: [] })
    saveActivity.mockRejectedValueOnce(new Error('network down'))

    await backfillP2PActivity(USER, WALLET)

    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBeNull()
  })

  it('withholds the latch when only ONE of several writes fails', async () => {
    // A partial run must not be recorded as complete.
    installFetch({
      offers: [
        offerRow({ id: OFFER_HASHED,   escrow_deposit_tx_hash: '0xdep1' }),
        offerRow({ id: OFFER_HASHLESS, escrow_deposit_tx_hash: '0xdep2' }),
      ],
      trades: [],
    })
    saveActivity.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(2)
    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBeNull()
  })

  it('latches only after a fully clean run', async () => {
    installFetch({ offers: [offerRow()], trades: [] })

    await backfillP2PActivity(USER, WALLET)

    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBe('1')
  })

  it('retrying after a partial failure cannot duplicate — every row carries a hash', async () => {
    // Why retrying is safe: the DB constraint absorbs the repeat, so the retry
    // is a no-op server-side rather than a second row.
    installFetch({ offers: [offerRow()], trades: [] })
    saveActivity.mockResolvedValueOnce(false)

    await backfillP2PActivity(USER, WALLET)
    await backfillP2PActivity(USER, WALLET)

    expect(writes()).toHaveLength(2)
    // Same (tx_hash, wallet) both times => on_conflict makes the second inert.
    expect(writes()[0].txHash).toBe(writes()[1].txHash)
    for (const w of writes()) expect(w.txHash).toBeTruthy()
  })

  it('never latches when there is nothing to write but the read failed', async () => {
    installFetch({ offers: [offerRow()], trades: [], existingStatus: 500 })

    await backfillP2PActivity(USER, WALLET)

    expect(localStorage.getItem(`meshport_p2p_backfill_v2_${WALLET}`)).toBeNull()
  })
})


describe('backfillP2PActivity — refund amount fidelity', () => {  it('subtracts what actually sold instead of refunding the offer ceiling', async () => {
    // 100 offered, 30 sold => 70 genuinely came back. The old code wrote 100.
    installFetch({
      offers: [offerRow({ status: 'cancelled', escrow_withdraw_tx_hash: '0xwd1', max_amount: '100' })],
      trades: [
        tradeRow({ id: 't-sold', status: 'completed', amount_usdc: '30', tx_hash: '0xa' }),
      ],
    })

    await backfillP2PActivity(USER, WALLET)

    const refund = writes().find(w => w.activityType === 'p2p_refund')
    expect(refund).toBeTruthy()
    expect(refund.amount).toBe(70)
  })

  it('omits the refund entirely when the whole offer sold (nothing to return)', async () => {
    installFetch({
      offers: [offerRow({ status: 'cancelled', escrow_withdraw_tx_hash: '0xwd1', max_amount: '100' })],
      trades: [tradeRow({ id: 't-all', status: 'completed', amount_usdc: '100', tx_hash: '0xa' })],
    })

    await backfillP2PActivity(USER, WALLET)

    expect(writes().filter(w => w.activityType === 'p2p_refund')).toHaveLength(0)
  })

  it('ignores escrow_balance, which is NULL for pre-2026-07-30 offers', async () => {
    installFetch({
      offers: [offerRow({
        status: 'cancelled', escrow_withdraw_tx_hash: '0xwd1',
        max_amount: '100', escrow_balance: null,   // column added after these offers existed
      })],
      trades: [],
    })

    await backfillP2PActivity(USER, WALLET)

    const refund = writes().find(w => w.activityType === 'p2p_refund')
    // A NULL escrow_balance must not collapse the refund to 0 or crash.
    expect(refund.amount).toBe(100)
  })
})
