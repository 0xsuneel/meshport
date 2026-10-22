import { describe, it, expect } from 'vitest'
import { merchantRefundInfo } from './ActivityService'

describe('merchantRefundInfo', () => {
  it('reads a refund merchant-refund marked', () => {
    expect(merchantRefundInfo({ activityType: 'receive', counterpartyAddress: '0x53E5C71290DC5147089B7B40679F3D6A164C8C2B',
      metadata: { receiveKind: 'merchant_refund', merchantName: 'Karan Resort', merchantOrder: 'ORD-100130', refundReason: 'Wrong amount' } }))
      .toEqual({ from: 'Karan Resort', order: 'ORD-100130', reason: 'Wrong amount' })
  })
  it('knows a refund by its sender before it is marked', () => {
    expect(merchantRefundInfo({ activityType: 'receive', counterpartyAddress: '0x53e5c71290dc5147089b7b40679f3d6a164c8c2b', metadata: { receiveKind: 'external_deposit' } }))
      .toEqual({ from: 'a business', order: null, reason: null })
  })
  it('leaves every other row alone', () => {
    expect(merchantRefundInfo({ activityType: 'receive', counterpartyAddress: '0x' + '1'.repeat(40), metadata: { receiveKind: 'external_deposit' } })).toBeNull()
    expect(merchantRefundInfo({ activityType: 'send', counterpartyAddress: '0x53e5c71290dc5147089b7b40679f3d6a164c8c2b', metadata: {} })).toBeNull()
  })
})
