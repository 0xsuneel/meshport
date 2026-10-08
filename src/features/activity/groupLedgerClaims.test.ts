import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { groupLedgerClaims } from './ActivityPage'
import type { ActivityRecord } from '@/lib/ActivityService'

const rec = (id: string, at: string, amount: number, extra: any = {}): ActivityRecord =>
  ({ id, activityType: 'claim', status: 'completed', amount, sourceChain: 'Ethereum_Sepolia', createdAt: at,
     metadata: { merchant: true }, ...extra }) as ActivityRecord

describe('groupLedgerClaims', () => {
  it('shows one Claim All as one row with the total', () => {
    const out = groupLedgerClaims([
      rec('a', '2026-10-08T10:00:30Z', 9.84), rec('b', '2026-10-08T10:00:20Z', 9.85), rec('c', '2026-10-08T10:00:00Z', 34.13),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBeCloseTo(53.82)
    expect((out[0] as any).metadata.ledgerGroup.map((r: any) => r.id)).toEqual(['a', 'b', 'c'])
  })
  it('keeps far-apart claims, other rows and non-merchant claims separate', () => {
    const out = groupLedgerClaims([
      rec('a', '2026-10-08T10:00:00Z', 1),
      rec('b', '2026-10-08T09:00:00Z', 2),
      rec('c', '2026-10-08T08:59:00Z', 3, { metadata: {} }),
      rec('d', '2026-10-08T08:58:00Z', 4, { activityType: 'receive' }),
    ])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
