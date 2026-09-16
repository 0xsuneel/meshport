/**
 * Regression tests for mergeOnchainIntoRecords — the merge behind useActivity's
 * direct on-chain received layer (see the hook's own file header for why that
 * layer exists at all).
 *
 * Two bugs are pinned here.
 *
 *   FIX 1 — rows with no tx_hash were dropped.
 *     The merge keys existing records by lowercased txHash, and its return
 *     value REPLACES the whole record list. Any row whose txHash was falsy
 *     therefore never entered the map and vanished from state on every poll,
 *     visibility change and onchain-activity event — reappearing only when the
 *     next full load() refetched it. Real wallets carry plenty of these:
 *     p2p_sell_order and p2p_refund rows have no on-chain hash of their own.
 *
 *   FIX 2 — output followed Map INSERTION order, not chronological order.
 *     A newly merged on-chain deposit was appended last however recent it was,
 *     so ActivityPage's TODAY/YESTERDAY/THIS WEEK grouping rendered a
 *     just-arrived deposit underneath older entries, or in the wrong day group.
 *
 * Scope: the merge's own semantics — which records survive, what dedupes, what
 * order comes back. The hook's wiring (polling interval, visibilitychange, the
 * meshport:onchain-activity listener) is deliberately not under test here.
 */

import { describe, it, expect, vi } from 'vitest'

// useActivity imports ActivityService, which constructs a real Supabase client
// at module load, and onchainReceivedActivity, which talks to the explorer.
// Both are stubbed so these stay pure-logic tests with no network, no env vars
// and no client — the merge under test reaches neither of them.
vi.mock('@/lib/ActivityService', () => ({
  fetchActivity:       vi.fn(),
  subscribeToActivity: vi.fn(() => () => {}),
}))
vi.mock('@/lib/onchainReceivedActivity', () => ({
  fetchRecentOnchainReceived: vi.fn(),
}))

import { mergeOnchainIntoRecords } from '@/hooks/useActivity'
import type { ActivityRecord } from '@/lib/ActivityService'
import type { OnchainReceivedTx } from '@/lib/onchainReceivedActivity'

const WALLET = '0x1111111111111111111111111111111111111111'
const SENDER = '0x2222222222222222222222222222222222222222'

/** A Supabase-shaped activity row. `updatedAt` mirrors `createdAt` unless set. */
function row(
  over: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'createdAt'>,
): ActivityRecord {
  return {
    walletAddress: WALLET,
    activityType:  'receive',
    tokenSymbol:   'USDC',
    amount:        1,
    usdValue:      1,
    status:        'completed',
    metadata:      {},
    updatedAt:     over.createdAt,
    ...over,
  }
}

/** An on-chain read result, as fetchRecentOnchainReceived would return it. */
function tx(
  over: Partial<OnchainReceivedTx> & Pick<OnchainReceivedTx, 'txHash'>,
): OnchainReceivedTx {
  return {
    fromAddress: SENDER,
    tokenSymbol: 'USDC',
    amount:      1,
    status:      'confirmed',
    timestamp:   '2026-08-20T12:00:00.000Z',
    ...over,
  }
}

const ids = (records: ActivityRecord[]) => records.map(r => r.id)

/** True when every record is at least as new as the one after it. */
function isNewestFirst(records: ActivityRecord[]): boolean {
  for (let i = 1; i < records.length; i++) {
    const prev = new Date(records[i - 1].createdAt).getTime()
    const curr = new Date(records[i].createdAt).getTime()
    if (prev < curr) return false
  }
  return true
}

// ── FIX 1 — rows without a txHash survive ────────────────────────────────────

describe('mergeOnchainIntoRecords — FIX 1: rows without a txHash survive', () => {
  it('keeps a row whose txHash is null', () => {
    // tx_hash IS NULL in Postgres, reaching state via a path that passes the
    // raw value through rather than ActivityService's null -> undefined mapping.
    const nullHashRow = row({
      id:           'p2p-sell-1',
      createdAt:    '2026-08-19T09:00:00.000Z',
      activityType: 'p2p_sell_order',
      txHash:       null as unknown as string,
    })

    const result = mergeOnchainIntoRecords(WALLET, [nullHashRow], [
      tx({ txHash: '0xaaa1', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(ids(result)).toContain('p2p-sell-1')
    expect(result).toHaveLength(2)
  })

  it('keeps a row whose txHash is undefined (how ActivityService maps NULL)', () => {
    const undefHashRow = row({
      id:           'p2p-refund-1',
      createdAt:    '2026-08-19T09:00:00.000Z',
      activityType: 'p2p_refund',
      txHash:       undefined,
    })

    const result = mergeOnchainIntoRecords(WALLET, [undefHashRow], [
      tx({ txHash: '0xaaa2', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(ids(result)).toContain('p2p-refund-1')
    expect(result).toHaveLength(2)
  })

  it('keeps a row whose txHash is an empty string', () => {
    const emptyHashRow = row({
      id:        'empty-hash-1',
      createdAt: '2026-08-19T09:00:00.000Z',
      txHash:    '',
    })

    const result = mergeOnchainIntoRecords(WALLET, [emptyHashRow], [
      tx({ txHash: '0xaaa3', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(ids(result)).toContain('empty-hash-1')
    expect(result).toHaveLength(2)
  })

  it('keeps ALL null-txHash rows, not just one — each keyed by its own id', () => {
    // Mirrors the shape of the wallet that surfaced this: 45 hashless rows
    // (28 p2p_sell_order + 17 p2p_refund) alongside hash-bearing history.
    const sellOrders = Array.from({ length: 28 }, (_, i) =>
      row({
        id:           `p2p-sell-${i}`,
        createdAt:    `2026-08-1${(i % 9) + 1}T08:00:00.000Z`,
        activityType: 'p2p_sell_order',
        txHash:       null as unknown as string,
      }),
    )
    const refunds = Array.from({ length: 17 }, (_, i) =>
      row({
        id:           `p2p-refund-${i}`,
        createdAt:    `2026-08-1${(i % 9) + 1}T09:00:00.000Z`,
        activityType: 'p2p_refund',
        txHash:       undefined,
      }),
    )
    const prev = [...sellOrders, ...refunds]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xbbb1', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    // Every hashless row still present, plus the one new on-chain record.
    expect(result).toHaveLength(46)
    for (const r of prev) expect(ids(result)).toContain(r.id)
  })

  it('is idempotent across repeated merges — the old bug erased rows on every poll', () => {
    // The regression's actual signature: state shrank each time the poll fired.
    const prev = [
      row({ id: 'hashless-a', createdAt: '2026-08-19T08:00:00.000Z', txHash: null as unknown as string }),
      row({ id: 'hashless-b', createdAt: '2026-08-19T07:00:00.000Z', txHash: undefined }),
      row({ id: 'hashed-c',   createdAt: '2026-08-19T06:00:00.000Z', txHash: '0xccc1' }),
    ]
    const onchain = [tx({ txHash: '0xddd1', timestamp: '2026-08-20T10:00:00.000Z' })]

    const first  = mergeOnchainIntoRecords(WALLET, prev,  onchain)
    const second = mergeOnchainIntoRecords(WALLET, first, onchain)
    const third  = mergeOnchainIntoRecords(WALLET, second, onchain)

    expect(first).toHaveLength(4)
    expect(second).toHaveLength(4)
    expect(third).toHaveLength(4)
    expect(ids(third)).toEqual(ids(first))
  })

  it('introduces no duplicates for records that DO have a txHash', () => {
    const prev = [
      row({ id: 'hashed-1',   createdAt: '2026-08-19T08:00:00.000Z', txHash: '0xeee1' }),
      row({ id: 'hashed-2',   createdAt: '2026-08-19T07:00:00.000Z', txHash: '0xeee2' }),
      row({ id: 'hashless-1', createdAt: '2026-08-19T06:00:00.000Z', txHash: null as unknown as string }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xeee1', timestamp: '2026-08-19T08:00:00.000Z' }), // already known
      tx({ txHash: '0xeee2', timestamp: '2026-08-19T07:00:00.000Z' }), // already known
    ])

    expect(result).toHaveLength(3)
    expect(new Set(ids(result)).size).toBe(3)
    // The hashless row did not acquire a phantom hash-keyed twin.
    expect(ids(result).filter(id => id === 'hashless-1')).toHaveLength(1)
  })

  it('keeps the hashless keyspace disjoint from the hash keyspace', () => {
    // An `id:<uuid>` key can never collide with a 0x-prefixed hash key.
    const prev = [
      row({ id: '0xeee1', createdAt: '2026-08-19T08:00:00.000Z', txHash: null as unknown as string }),
      row({ id: 'other',  createdAt: '2026-08-19T07:00:00.000Z', txHash: '0xeee1' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [])

    // Two distinct records, even though one row's *id* equals the other's hash.
    expect(result).toHaveLength(2)
    expect(ids(result).sort()).toEqual(['0xeee1', 'other'])
  })
})

// ── Hash-keyed dedup: unchanged by FIX 1 ─────────────────────────────────────

describe('mergeOnchainIntoRecords — existing txHash rows still dedupe case-insensitively', () => {
  it('dedupes when the stored hash is upper-case and the chain returns lower-case', () => {
    const stored = row({
      id:        'supabase-row',
      createdAt: '2026-08-20T10:00:00.000Z',
      txHash:    '0xABCDEF0123456789',
      metadata:  { senderUsername: 'alice' },
    })

    const result = mergeOnchainIntoRecords(WALLET, [stored], [
      tx({ txHash: '0xabcdef0123456789', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    // The Supabase row wins — it carries the richer metadata.
    expect(result[0].id).toBe('supabase-row')
    expect(result[0].metadata.senderUsername).toBe('alice')
  })

  it('dedupes when the stored hash is lower-case and the chain returns upper-case', () => {
    const stored = row({
      id:        'supabase-row',
      createdAt: '2026-08-20T10:00:00.000Z',
      txHash:    '0xabcdef0123456789',
    })

    const result = mergeOnchainIntoRecords(WALLET, [stored], [
      tx({ txHash: '0xABCDEF0123456789', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('supabase-row')
  })

  it('dedupes on-chain reads of the same hash in differing cases against each other', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xAbCdEf', timestamp: '2026-08-20T10:00:00.000Z' }),
      tx({ txHash: '0xabcdef', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
  })

  it('still promotes a pending record to completed once the chain confirms', () => {
    // Pre-existing behaviour — pinned so the lifted-out merge keeps it.
    const pending = row({
      id:        'pending-row',
      createdAt: '2026-08-20T10:00:00.000Z',
      txHash:    '0xFFF1',
      status:    'pending',
    })

    const result = mergeOnchainIntoRecords(WALLET, [pending], [
      tx({ txHash: '0xfff1', status: 'confirmed', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('pending-row')
    expect(result[0].status).toBe('completed')
  })

  it('adds an on-chain transaction that is genuinely new', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xnew1', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('onchain_0xnew1')
    expect(result[0].activityType).toBe('receive')
    expect(result[0].walletAddress).toBe(WALLET)
    expect(result[0].counterpartyAddress).toBe(SENDER)
  })
})

// ── FIX 2 — chronological ordering ───────────────────────────────────────────

describe('mergeOnchainIntoRecords — FIX 2: newest-first ordering', () => {
  it('places a newly merged on-chain deposit first when it is the newest', () => {
    const prev = [
      row({ id: 'older-1', createdAt: '2026-08-19T10:00:00.000Z', txHash: '0x111' }),
      row({ id: 'older-2', createdAt: '2026-08-18T10:00:00.000Z', txHash: '0x222' }),
      row({ id: 'older-3', createdAt: '2026-08-17T10:00:00.000Z', txHash: '0x333' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xnewest', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    // Before the fix this landed at index 3 — last — because Map.values()
    // yields insertion order and existing records are inserted first.
    expect(result[0].id).toBe('onchain_0xnewest')
    expect(isNewestFirst(result)).toBe(true)
  })

  it('does not move older records above the new one, and keeps their relative order', () => {
    const prev = [
      row({ id: 'older-1', createdAt: '2026-08-19T10:00:00.000Z', txHash: '0x111' }),
      row({ id: 'older-2', createdAt: '2026-08-18T10:00:00.000Z', txHash: '0x222' }),
      row({ id: 'older-3', createdAt: '2026-08-17T10:00:00.000Z', txHash: '0x333' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xnewest', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(ids(result)).toEqual(['onchain_0xnewest', 'older-1', 'older-2', 'older-3'])
  })

  it('slots a mid-history on-chain transaction into its correct position', () => {
    const prev = [
      row({ id: 'newest',  createdAt: '2026-08-20T10:00:00.000Z', txHash: '0x111' }),
      row({ id: 'oldest',  createdAt: '2026-08-10T10:00:00.000Z', txHash: '0x222' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xmiddle', timestamp: '2026-08-15T10:00:00.000Z' }),
    ])

    expect(ids(result)).toEqual(['newest', 'onchain_0xmiddle', 'oldest'])
    expect(isNewestFirst(result)).toBe(true)
  })

  it('returns newest -> oldest even when the input arrives out of order', () => {
    const prev = [
      row({ id: 'c', createdAt: '2026-08-12T10:00:00.000Z', txHash: '0xc' }),
      row({ id: 'a', createdAt: '2026-08-20T10:00:00.000Z', txHash: '0xa' }),
      row({ id: 'e', createdAt: '2026-08-05T10:00:00.000Z', txHash: '0xe' }),
      row({ id: 'b', createdAt: '2026-08-18T10:00:00.000Z', txHash: '0xb' }),
      row({ id: 'd', createdAt: '2026-08-08T10:00:00.000Z', txHash: '0xd' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xf', timestamp: '2026-08-14T10:00:00.000Z' }),
    ])

    expect(ids(result)).toEqual(['a', 'b', 'onchain_0xf', 'c', 'd', 'e'])
    expect(isNewestFirst(result)).toBe(true)
  })

  it('sorts a mixed batch of hashless rows, hashed rows and new deposits', () => {
    // Both fixes together: hashless rows survive AND land in the right slot.
    const prev = [
      row({ id: 'hashed-old',   createdAt: '2026-08-10T10:00:00.000Z', txHash: '0x111' }),
      row({ id: 'hashless-mid', createdAt: '2026-08-16T10:00:00.000Z', txHash: null as unknown as string, activityType: 'p2p_refund' }),
      row({ id: 'hashed-mid',   createdAt: '2026-08-13T10:00:00.000Z', txHash: '0x222' }),
      row({ id: 'hashless-new', createdAt: '2026-08-19T10:00:00.000Z', txHash: undefined, activityType: 'p2p_sell_order' }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xdeposit', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(ids(result)).toEqual([
      'onchain_0xdeposit',
      'hashless-new',
      'hashless-mid',
      'hashed-mid',
      'hashed-old',
    ])
    expect(isNewestFirst(result)).toBe(true)
  })

  it('holds the newest-first invariant when several deposits merge at once', () => {
    const prev = [
      row({ id: 'existing-1', createdAt: '2026-08-14T10:00:00.000Z', txHash: '0x111' }),
      row({ id: 'existing-2', createdAt: '2026-08-11T10:00:00.000Z', txHash: null as unknown as string }),
    ]

    const result = mergeOnchainIntoRecords(WALLET, prev, [
      tx({ txHash: '0xd1', timestamp: '2026-08-13T10:00:00.000Z' }),
      tx({ txHash: '0xd2', timestamp: '2026-08-20T10:00:00.000Z' }),
      tx({ txHash: '0xd3', timestamp: '2026-08-12T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(5)
    expect(result[0].id).toBe('onchain_0xd2')
    expect(isNewestFirst(result)).toBe(true)
  })

  it('holds the newest-first invariant on an empty on-chain read', () => {
    const prev = [
      row({ id: 'b', createdAt: '2026-08-10T10:00:00.000Z', txHash: '0xb' }),
      row({ id: 'a', createdAt: '2026-08-20T10:00:00.000Z', txHash: null as unknown as string }),
    ]

    // The hook short-circuits before calling the merge on an empty read, but
    // the merge itself must still be total.
    const result = mergeOnchainIntoRecords(WALLET, prev, [])

    expect(ids(result)).toEqual(['a', 'b'])
    expect(isNewestFirst(result)).toBe(true)
  })
})

// ── Token coverage ───────────────────────────────────────────────────────────

describe('mergeOnchainIntoRecords — token coverage', () => {
  it('merges a USDC receive', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xusdc1', tokenSymbol: 'USDC', amount: 25.5, timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].tokenSymbol).toBe('USDC')
    expect(result[0].amount).toBe(25.5)
    expect(result[0].activityType).toBe('receive')
    expect(result[0].status).toBe('completed')
    expect(result[0].metadata.source).toBe('onchain_direct')
    expect(result[0].createdAt).toBe('2026-08-20T10:00:00.000Z')
  })

  it('merges an EURC receive', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xeurc1', tokenSymbol: 'EURC', amount: 10.25, timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].tokenSymbol).toBe('EURC')
    expect(result[0].amount).toBe(10.25)
    expect(result[0].activityType).toBe('receive')
  })

  it('merges a cirBTC receive', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xbtc1', tokenSymbol: 'cirBTC', amount: 0.005, timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].tokenSymbol).toBe('cirBTC')
    expect(result[0].amount).toBe(0.005)
    expect(result[0].activityType).toBe('receive')
  })

  it('merges a cirBTC receive of 0.0001 without losing precision', () => {
    // cirBTC has 8 decimals, so small amounts are the normal case, not an edge.
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xbtc2', tokenSymbol: 'cirBTC', amount: 0.0001, timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].amount).toBe(0.0001)
    expect(result[0].amount).toBeGreaterThan(0)
    // usdValue mirrors amount here by existing design in
    // onchainTxToActivityRecord (no price lookup in this layer). Pinned as
    // current behaviour, not endorsed as correct for non-USD tokens.
    expect(result[0].usdValue).toBe(0.0001)
  })

  it('does not confuse a pending cirBTC receive for a confirmed one', () => {
    const result = mergeOnchainIntoRecords(WALLET, [], [
      tx({ txHash: '0xbtc3', tokenSymbol: 'cirBTC', amount: 0.0001, status: 'pending', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result[0].status).toBe('pending')
  })

  it('merges USDC, EURC and cirBTC receives together, newest first', () => {
    const result = mergeOnchainIntoRecords(WALLET, [
      row({ id: 'old-send', createdAt: '2026-08-01T10:00:00.000Z', txHash: '0xsend1', activityType: 'send' }),
      row({ id: 'hashless', createdAt: '2026-08-02T10:00:00.000Z', txHash: null as unknown as string, activityType: 'p2p_refund' }),
    ], [
      tx({ txHash: '0xusdc2',  tokenSymbol: 'USDC',   amount: 100,    timestamp: '2026-08-18T10:00:00.000Z' }),
      tx({ txHash: '0xeurc2',  tokenSymbol: 'EURC',   amount: 50,     timestamp: '2026-08-20T10:00:00.000Z' }),
      tx({ txHash: '0xbtc4',   tokenSymbol: 'cirBTC', amount: 0.0001, timestamp: '2026-08-19T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(5)
    expect(ids(result)).toEqual([
      'onchain_0xeurc2',
      'onchain_0xbtc4',
      'onchain_0xusdc2',
      'hashless',
      'old-send',
    ])
    expect(result.map(r => r.tokenSymbol)).toEqual(['EURC', 'cirBTC', 'USDC', 'USDC', 'USDC'])
    expect(isNewestFirst(result)).toBe(true)
  })

  it('dedupes a cirBTC deposit already recorded in Supabase', () => {
    const stored = row({
      id:          'supabase-btc',
      createdAt:   '2026-08-20T10:00:00.000Z',
      txHash:      '0xBTC5',
      tokenSymbol: 'cirBTC',
      amount:      0.0001,
    })

    const result = mergeOnchainIntoRecords(WALLET, [stored], [
      tx({ txHash: '0xbtc5', tokenSymbol: 'cirBTC', amount: 0.0001, timestamp: '2026-08-20T10:00:00.000Z' }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('supabase-btc')
    expect(result[0].amount).toBe(0.0001)
  })
})

// ── FIX 3 — bulk self-pay: sent + received legs share type AND hash ─────────

describe('mergeOnchainIntoRecords — FIX 3: bulk self-payout legs both survive', () => {
  it('keeps both the sent and received leg of a self-included bulk payout', () => {
    // Real shape: Activity.bulk() writes one 'bulk' row (direction: 'sent')
    // and Activity.bulkReceived() writes another 'bulk' row (direction:
    // 'received') on the SAME wallet when you're one of your own batch's
    // recipients — both under the same stripped on-chain hash. Before FIX
    // 3, the second of these silently overwrote the first in the merge map.
    const sent = row({
      id:        'bulk-sent',
      createdAt: '2026-08-30T10:05:02.395Z',
      txHash:    '0xbulk1',
      activityType: 'bulk',
      metadata:  { direction: 'sent', recipientCount: 1 },
    })
    const received = row({
      id:        'bulk-received',
      createdAt: '2026-08-30T10:05:02.643Z',
      txHash:    '0xbulk1',
      activityType: 'bulk',
      metadata:  { direction: 'received', fromUsername: 'sunil.arc' },
    })

    const result = mergeOnchainIntoRecords(WALLET, [sent, received], [])

    expect(result).toHaveLength(2)
    expect(ids(result).sort()).toEqual(['bulk-received', 'bulk-sent'])
  })

  it('still dedupes two ordinary receive rows sharing a hash (no direction set)', () => {
    // Sanity check: FIX 3 must not weaken the existing hash-dedup for
    // types/rows that never set metadata.direction — a 'receive' row here
    // and a synthetic onchain 'receive' for the same hash should still
    // collapse to one, exactly as every test above this point expects.
    const stored = row({ id: 'r1', createdAt: '2026-08-20T10:00:00.000Z', txHash: '0xabc' })
    const result = mergeOnchainIntoRecords(WALLET, [stored], [
      tx({ txHash: '0xabc', timestamp: '2026-08-20T10:00:00.000Z' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('r1')
  })

  it('breaks a true createdAt tie deterministically by id', () => {
    const a = row({ id: 'aaa', createdAt: '2026-08-30T10:05:02.000Z', txHash: '0x1' })
    const b = row({ id: 'bbb', createdAt: '2026-08-30T10:05:02.000Z', txHash: '0x2' })

    const result1 = mergeOnchainIntoRecords(WALLET, [a, b], [])
    const result2 = mergeOnchainIntoRecords(WALLET, [b, a], [])

    // Same order regardless of input order — a pure function of the
    // records themselves, not of array arrival order.
    expect(ids(result1)).toEqual(ids(result2))
  })
})
