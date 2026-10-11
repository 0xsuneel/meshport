import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {}, searchUsersPartialDb: async () => [] }))
import { recordMovesToken } from './ActivityPage'

const rec = (activityType: string, tokenSymbol: string, metadata: Record<string, unknown> = {}) =>
  ({ id: 'x', walletAddress: '0x', activityType, tokenSymbol, amount: 1, usdValue: 1, status: 'completed', metadata, createdAt: '', updatedAt: '' }) as any

describe('recordMovesToken (asset page + Activity token filter)', () => {
  it('a swap belongs to both its tokens', () => {
    const swap = rec('swap', 'EURC', { tokenIn: 'EURC', tokenOut: 'cirBTC' })
    expect(recordMovesToken(swap, 'EURC')).toBe(true)
    expect(recordMovesToken(swap, 'cirBTC')).toBe(true)
    expect(recordMovesToken(swap, 'USDC')).toBe(false)
  })
  it('other rows by their own token (USDC when unset)', () => {
    expect(recordMovesToken(rec('send', 'cirBTC'), 'cirbtc')).toBe(true)
    expect(recordMovesToken(rec('receive', ''), 'USDC')).toBe(true)
    expect(recordMovesToken(rec('send', 'EURC'), 'USDC')).toBe(false)
  })
})
