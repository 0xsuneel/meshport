// On Arc every swap sends its own approval first: USDC through
// increaseAllowance(), EURC/cirBTC through approve(). Both must be read as the
// approval, never as the swap transaction.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {}, authApiHeaders: async () => ({}) }))
import { isApprovalCalldata } from './swapService'

const ARGS = '0'.repeat(128)

describe('isApprovalCalldata', () => {
  it('reads approve() as the approval', () => {
    expect(isApprovalCalldata('0x095ea7b3' + ARGS)).toBe(true)
  })
  it('reads USDC increaseAllowance() as the approval', () => {
    expect(isApprovalCalldata('0x39509351' + ARGS)).toBe(true)
    expect(isApprovalCalldata('0x39509351'.toUpperCase().replace('0X', '0x') + ARGS)).toBe(true)
  })
  it('reads anything else as the swap', () => {
    expect(isApprovalCalldata('0x12345678' + ARGS)).toBe(false)
    expect(isApprovalCalldata('')).toBe(false)
    expect(isApprovalCalldata(undefined)).toBe(false)
  })
})
