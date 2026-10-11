import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same @/lib/supabase stub as notifications.duplicateReceive.test.ts.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }), maybeSingle: async () => ({ data: null }) }),
        ilike: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  },
}))

import { useNotificationStore } from '@/store'
import { notifyRewardClaimed } from './notifications'

describe('rewards claim notification', () => {
  beforeEach(() => { useNotificationStore.getState()._resetForAddress(null) })

  it('reads like a normal receive: "Received" · amount from MeshPort Rewards', () => {
    notifyRewardClaimed({ usdcAmount: 5, points: 500, txHash: '0xABC' })
    const [n] = useNotificationStore.getState().notifications
    expect(n.title).toBe('Received')
    expect(n.body).toBe('$5 from MeshPort Rewards')
    expect(n.id).toBe('ext_recv_tx_0xabc')
  })

  it('the claim and the on-chain watcher share one id - shown once', () => {
    notifyRewardClaimed({ usdcAmount: 5, points: 500, txHash: '0xabc' })   // rewards.ts
    notifyRewardClaimed({ usdcAmount: 5, txHash: '0xABC' })               // arcDepositWatcher
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
  })
})
