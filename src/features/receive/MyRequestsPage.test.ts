import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { requestStatus, requestBucket } from './MyRequestsPage'

const future = new Date(Date.now() + 3600_000).toISOString()
const past = new Date(Date.now() - 3600_000).toISOString()

describe('My requests grouping', () => {
  it('a pending request past its expiry is expired (closed)', () => {
    expect(requestStatus({ status: 'pending', expiresAt: past })).toBe('expired')
    expect(requestBucket({ status: 'pending', expiresAt: past })).toBe('closed')
  })
  it('waiting / paid / closed', () => {
    expect(requestBucket({ status: 'pending', expiresAt: future })).toBe('waiting')
    expect(requestBucket({ status: 'pending', expiresAt: null })).toBe('waiting')
    expect(requestBucket({ status: 'partially_paid', expiresAt: past })).toBe('waiting')
    expect(requestBucket({ status: 'paid', expiresAt: past })).toBe('paid')
    expect(requestBucket({ status: 'cancelled', expiresAt: null })).toBe('closed')
  })
})
