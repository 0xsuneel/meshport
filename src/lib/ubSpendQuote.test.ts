// Unified Balance spends are priced for the route actually used: a
// destination MeshPort's relayer mints (Ethereum Sepolia) pays no forwarding
// fee, so a $1 send there must not be refused for a ~1.5 USDC forwarder fee.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {}, authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

import { spendUnifiedTo } from './ubClaim'

const usdc = (type: string, amount: number) => ({ type, token: 'USDC', amount: String(amount) })

function fakeKit(opts: { selfMintQuoteFails?: boolean } = {}) {
  const quotes: any[] = [], spends: any[] = []
  const kit = {
    unifiedBalance: {
      estimateSpend: async (p: any) => {
        quotes.push(p.to)
        if (p.to.useForwarder) return { fees: [usdc('provider', 0.0001), usdc('gasFee', 0.001), usdc('forwarder', 1.52)] }
        if (opts.selfMintQuoteFails) throw new Error('quote failed')
        return { fees: [usdc('provider', 0.0001), usdc('gasFee', 0.001), { type: 'gasFee', token: 'ETH', amount: '0.0004' }] }
      },
      spend: async (p: any) => { spends.push(p); return { txHash: '0xabc' } },
    },
  }
  return { kit, quotes, spends }
}

describe('Unified Balance spend pricing', () => {
  beforeEach(() => store.clear())

  it('to Ethereum Sepolia (relayer mints): no forwarding fee - $1 goes through', async () => {
    const { kit, quotes, spends } = fakeKit()
    const out = await spendUnifiedTo({ kit, adapter: {}, fromChain: 'Arc_Testnet', amount: 1, toChain: 'Ethereum_Sepolia', recipient: '0x1' })
    expect(quotes[0].useForwarder).toBe(false)
    expect(spends[0].to.useForwarder).toBe(false)
    expect(out.received).toBeGreaterThan(0.98)
  })

  it('falls back to the forwarder quote if the relayer-route quote fails', async () => {
    const { kit, quotes } = fakeKit({ selfMintQuoteFails: true })
    await expect(spendUnifiedTo({ kit, adapter: {}, fromChain: 'Arc_Testnet', amount: 1, toChain: 'Ethereum_Sepolia', recipient: '0x1' }))
      .rejects.toThrow(/too small/)
    expect(quotes.map(q => q.useForwarder)).toEqual([false, true])
  })

  it('forwarder destinations are still priced with the forwarder', async () => {
    const { kit, quotes, spends } = fakeKit()
    const out = await spendUnifiedTo({ kit, adapter: {}, fromChain: 'Arc_Testnet', amount: 5, toChain: 'Base_Sepolia', recipient: '0x1' })
    expect(quotes[0].useForwarder).toBe(true)
    expect(spends[0].to.useForwarder).toBe(true)
    expect(out.received).toBeLessThan(5 - 1.5)
  })
})

describe('Unified Balance Bring: fee checked before anything moves', () => {
  beforeEach(() => store.clear())

  it('refuses a $1 Bring from Ethereum when the fee is ~$1.12 - no deposit', async () => {
    const { runUbClaim } = await import('./ubClaim')
    let deposited = false
    const kit = {
      unifiedBalance: {
        estimateSpend: async () => ({ fees: [usdc('provider', 0.00005), usdc('gasFee', 1.07), usdc('forwarder', 0.05)] }),
        deposit: async () => { deposited = true; return { txHash: '0x1' } },
        getBalances: async () => ({ balances: [] }),
      },
    }
    await expect(runUbClaim({ kit, adapter: {}, walletAddr: '0xabc', sdkChainId: 'Ethereum_Sepolia', chainLabel: 'Ethereum', amount: 1, onStep: () => {} }))
      .rejects.toThrow(/nothing was moved/)
    expect(deposited).toBe(false)
  })
})
