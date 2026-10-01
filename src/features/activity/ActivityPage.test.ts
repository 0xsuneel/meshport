// src/features/activity/ActivityPage.test.ts
//
// Regression tests for dedupeAndSortActivityRecords — the dedup + ordering
// logic behind the Activity list. Two real bugs pinned here, both found
// during a 2026-09-02 forensic audit:
//
//   BUG 1 — a self-included bulk payout (you're one of your own batch's
//     recipients) writes two rows sharing the same activityType ('bulk')
//     AND the same stripped on-chain hash (a sent-summary leg and a
//     received leg, distinguished only by metadata.direction). The old
//     dedup key was `${activityType}:${txHash}` with no direction, so the
//     two collided and one silently vanished from the list — intermittently,
//     depending on array order. This is what "self paid and self received
//     sometimes disappear" actually was.
//
//   BUG 2 — the list was sorted purely by createdAt with no tiebreaker.
//     Postgres stores microsecond precision but JS's Date truncates to
//     milliseconds, so two rows written back-to-back (again, a bulk
//     payout's two legs) can genuinely tie — and without a deterministic
//     secondary key, their relative order wasn't guaranteed to stay the
//     same across renders even though nothing about the data changed.

import { describe, it, expect, vi } from 'vitest'

// ActivityPage.tsx transitively imports @/lib/supabase (via ActivityService,
// p2pService, etc.), which constructs a real Supabase client at module load
// time and throws without env vars. Mocked here for the same reason
// useActivity.test.ts mocks its own Supabase-touching imports — this test
// only needs the pure dedupeAndSortActivityRecords export, not a live client.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    channel: () => ({ on: () => ({ subscribe: () => {} }) }),
    removeChannel: () => {},
  },
}))

import { dedupeAndSortActivityRecords } from './ActivityPage'
import type { ActivityRecord } from '@/lib/ActivityService'

const WALLET = '0x1111111111111111111111111111111111111111'

function row(over: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'createdAt'>): ActivityRecord {
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

describe('dedupeAndSortActivityRecords — bulk self-pay: both legs survive', () => {
  it('keeps both the sent and received leg of a self-included bulk payout', () => {
    const sent = row({
      id: 'bulk-sent', createdAt: '2026-08-30T10:05:02.395Z',
      txHash: '0xbulk1', activityType: 'bulk',
      metadata: { direction: 'sent', recipientCount: 1 },
    })
    const received = row({
      id: 'bulk-received', createdAt: '2026-08-30T10:05:02.643Z',
      txHash: '0xbulk1', activityType: 'bulk',
      metadata: { direction: 'received', fromUsername: 'sunil.arc' },
    })

    const result = dedupeAndSortActivityRecords([sent, received])

    expect(result).toHaveLength(2)
    expect(result.map(r => r.id).sort()).toEqual(['bulk-received', 'bulk-sent'])
  })

  it('is stable regardless of which leg appears first in the input', () => {
    const sent = row({
      id: 'bulk-sent', createdAt: '2026-08-30T10:05:02.395Z',
      txHash: '0xbulk2', activityType: 'bulk', metadata: { direction: 'sent' },
    })
    const received = row({
      id: 'bulk-received', createdAt: '2026-08-30T10:05:02.643Z',
      txHash: '0xbulk2', activityType: 'bulk', metadata: { direction: 'received' },
    })

    const resultA = dedupeAndSortActivityRecords([sent, received])
    const resultB = dedupeAndSortActivityRecords([received, sent])

    expect(resultA).toHaveLength(2)
    expect(resultB).toHaveLength(2)
  })

  it('still dedupes two genuinely identical rows (same type, same hash, same direction)', () => {
    const a = row({ id: 'dup-a', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xsame', activityType: 'bulk', metadata: { direction: 'sent' } })
    const b = row({ id: 'dup-b', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xsame', activityType: 'bulk', metadata: { direction: 'sent' } })

    const result = dedupeAndSortActivityRecords([a, b])
    expect(result).toHaveLength(1)
  })

  it('still dedupes ordinary send/receive rows unaffected by the direction key', () => {
    const a = row({ id: 'r1', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xabc', activityType: 'receive' })
    const b = row({ id: 'r2', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xabc', activityType: 'receive' })

    const result = dedupeAndSortActivityRecords([a, b])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('r1') // first one wins, unchanged behavior
  })
})

describe('dedupeAndSortActivityRecords — deterministic ordering', () => {
  it('sorts newest first', () => {
    const older = row({ id: 'old', createdAt: '2026-08-20T10:00:00.000Z', txHash: '0x1' })
    const newer = row({ id: 'new', createdAt: '2026-08-25T10:00:00.000Z', txHash: '0x2' })

    const result = dedupeAndSortActivityRecords([older, newer])
    expect(result.map(r => r.id)).toEqual(['new', 'old'])
  })

  it('breaks a true createdAt tie deterministically, regardless of input order', () => {
    const a = row({ id: 'aaa', createdAt: '2026-08-30T10:05:02.000Z', txHash: '0x1' })
    const b = row({ id: 'bbb', createdAt: '2026-08-30T10:05:02.000Z', txHash: '0x2' })

    const result1 = dedupeAndSortActivityRecords([a, b])
    const result2 = dedupeAndSortActivityRecords([b, a])

    expect(result1.map(r => r.id)).toEqual(result2.map(r => r.id))
  })

  it('keeps a bulk self-pay pair adjacent and ordered even with other records interleaved', () => {
    const sent = row({ id: 'bulk-sent', createdAt: '2026-08-30T10:05:02.395Z', txHash: '0xbulk3', activityType: 'bulk', metadata: { direction: 'sent' } })
    const received = row({ id: 'bulk-received', createdAt: '2026-08-30T10:05:02.643Z', txHash: '0xbulk3', activityType: 'bulk', metadata: { direction: 'received' } })
    const other = row({ id: 'other', createdAt: '2026-08-29T09:00:00.000Z', txHash: '0xother', activityType: 'send' })

    const result = dedupeAndSortActivityRecords([other, sent, received])
    expect(result).toHaveLength(3)
    // received leg (10:05:02.643) is newer than sent leg (10:05:02.395), both newer than 'other'.
    expect(result.map(r => r.id)).toEqual(['bulk-received', 'bulk-sent', 'other'])
  })
})

describe('dedupeAndSortActivityRecords — swap-output quiet filter unaffected', () => {
  it('still hides a receive that exactly matches a recent swap output', () => {
    const swap = row({
      id: 'swap-1', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xswap',
      activityType: 'swap', metadata: { amountOut: 100, tokenOut: 'EURC' },
    })
    const swapLeg = row({
      id: 'receive-1', createdAt: '2026-08-30T10:00:01.000Z', txHash: '0xswapleg',
      activityType: 'receive', tokenSymbol: 'EURC', amount: 100,
    })

    const result = dedupeAndSortActivityRecords([swap, swapLeg])
    expect(result.map(r => r.id)).toEqual(['swap-1'])
  })

  it('does not hide an unrelated receive that merely happens to be nearby', () => {
    const swap = row({
      id: 'swap-1', createdAt: '2026-08-30T10:00:00.000Z', txHash: '0xswap',
      activityType: 'swap', metadata: { amountOut: 100, tokenOut: 'EURC' },
    })
    const unrelated = row({
      id: 'receive-1', createdAt: '2026-08-30T10:00:01.000Z', txHash: '0xother',
      activityType: 'receive', tokenSymbol: 'USDC', amount: 50,
    })

    const result = dedupeAndSortActivityRecords([swap, unrelated])
    expect(result.map(r => r.id).sort()).toEqual(['receive-1', 'swap-1'])
  })
})
