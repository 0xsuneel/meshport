import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { unifyLedgerItems, type ActivityItem } from './MultichainPage'

const claim = (id: string, t: number, amount: number, extra: Partial<ActivityItem> = {}): ActivityItem =>
  ({ id, type: 'claim', merchant: true, status: 'success', amount, chain: 'Ethereum_Sepolia', chainLabel: 'Ethereum', timestamp: t, ...extra }) as ActivityItem

describe('unifyLedgerItems', () => {
  it('folds the claims of one Claim All into one Moved-to-Arc row', () => {
    const out = unifyLedgerItems([claim('a', 10_000, 10), claim('b', 9_000, 5.5, { chain: 'Sei_Testnet' })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ amount: 15.5, groupCount: 2, ledgerUnified: true, claimedAmount: undefined })
  })
  it('keeps claims far apart, own vs customer, and receipts separate; pending wins', () => {
    const t = 100 * 60_000
    const out = unifyLedgerItems([
      claim('a', t, 1, { status: 'pending' }), claim('b', t - 1000, 2),
      claim('c', t - 30 * 60_000, 3),
      claim('d', t - 30 * 60_000 - 1000, 4, { ownClaim: true }),
      { id: 'r', type: 'claim', merchant: true, chainReceipt: 'received', status: 'success', amount: 9, chain: 'Ethereum_Sepolia', timestamp: t - 31 * 60_000 } as ActivityItem,
    ])
    expect(out.map(i => [i.id, i.amount, i.status])).toEqual([['a', 3, 'pending'], ['c', 3, 'success'], ['d', 4, 'success'], ['r', 9, 'success']])
    expect(out.every(i => i.ledgerUnified)).toBe(true)
  })
})
