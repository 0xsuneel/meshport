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
        // As App Kit reports it: the forwarding fee is part of gasFee (the
        // signed maxFee) and is also listed on its own.
        if (p.to.useForwarder) return { fees: [usdc('provider', 0.0001), usdc('gasFee', 1.521), usdc('forwarder', 1.52)] }
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

  it('the forwarding fee is taken once: send = amount − maxFee − headroom', async () => {
    const { kit, spends } = fakeKit()
    const out = await spendUnifiedTo({ kit, adapter: {}, fromChain: 'Arc_Testnet', amount: 5, toChain: 'Base_Sepolia', recipient: '0x1' })
    const maxFee = 0.0001 + 1.521
    expect(out.received).toBeCloseTo(5 - maxFee - 0.01, 6) // headroom: 3% of maxFee, capped at 0.01
    expect(Number(spends[0].amount)).toBeCloseTo(out.received, 6)
  })

  it('dust already in the Unified Balance replaces the headroom', async () => {
    const { kit } = fakeKit()
    const out = await spendUnifiedTo({ kit, adapter: {}, fromChain: 'Arc_Testnet', amount: 5, toChain: 'Base_Sepolia', recipient: '0x1', cushion: 0.02 })
    expect(out.received).toBeCloseTo(5 - (0.0001 + 1.521), 6)
  })
})

describe('Unified Balance Bring: fee checked before anything moves', () => {
  beforeEach(() => store.clear())

  it('refuses a $1 Bring from Ethereum when the fee is ~$1.12 - no deposit', async () => {
    const { runUbClaim } = await import('./ubClaim')
    let deposited = false
    const kit = {
      unifiedBalance: {
        estimateSpend: async () => ({ fees: [usdc('provider', 0.00005), usdc('gasFee', 1.12), usdc('forwarder', 0.05)] }),
        deposit: async () => { deposited = true; return { txHash: '0x1' } },
        getBalances: async () => ({ balances: [] }),
      },
    }
    await expect(runUbClaim({ kit, adapter: {}, walletAddr: '0xabc', sdkChainId: 'Ethereum_Sepolia', chainLabel: 'Ethereum', amount: 1, onStep: () => {} }))
      .rejects.toThrow(/nothing was moved/)
    expect(deposited).toBe(false)
  })

  it('no live quote before the deposit (empty Unified Balance): Circle\'s published fee decides - $1 from Ethereum refused, no deposit', async () => {
    const { runUbClaim } = await import('./ubClaim')
    let deposited = false
    const kit = {
      unifiedBalance: {
        estimateSpend: async () => { throw new Error('Insufficient balance on Ethereum_Sepolia') },
        deposit: async () => { deposited = true; return { txHash: '0x1' } },
        getBalances: async () => ({ balances: [] }),
      },
    }
    await expect(runUbClaim({ kit, adapter: {}, walletAddr: '0xabc', sdkChainId: 'Ethereum_Sepolia', chainLabel: 'Ethereum', amount: 1, onStep: () => {} }))
      .rejects.toThrow(/nothing was moved/)
    expect(deposited).toBe(false)
  })

  it('no live quote from a cheap chain still lets a $1 Bring through', async () => {
    const { estimateUbClaimFee } = await import('./ubClaim')
    const kit = { unifiedBalance: { estimateSpend: async () => { throw new Error('Insufficient balance') } } }
    const r = await estimateUbClaimFee({ kit, adapter: {}, walletAddr: '0xabc', fromChain: 'Base_Sepolia', amount: 1 })
    expect(r.approx).toBe(true)
    expect(r.receiveAtLeast).toBeGreaterThan(0.98)
  })
})

describe('Unified Balance Bring: leftover dust goes back to the user', () => {
  beforeEach(() => store.clear())

  it('dust already in that chain is sent along to the own Arc wallet, at the same fee', async () => {
    const { spendUnifiedToArc } = await import('./ubClaim')
    const spends: any[] = []
    const kit = { unifiedBalance: {
      estimateSpend: async () => ({ fees: [usdc('provider', 0.0005), usdc('gasFee', 0.025889), usdc('forwarder', 0.016389)] }),
      spend: async (p: any) => { spends.push(p); return { txHash: '0xabc' } },
    } }
    const out = await spendUnifiedToArc({ kit, adapter: {}, walletAddr: '0x1', fromChain: 'Base_Sepolia', amount: 10, dust: 0.03 })
    const maxFee = 0.026389
    expect(out.received).toBeCloseTo(10 + 0.03 - maxFee - 0.0008, 4) // headroom: 3% of maxFee
    // Value + maxFee never exceed what is in the Unified Balance.
    expect(Number(spends[0].amount) + maxFee).toBeLessThanOrEqual(10.03)
  })

  it('a balance of 0.5+ is an unfinished claim, not dust - never swept along', async () => {
    const { claimDust } = await import('./ubClaim')
    expect(claimDust(0.03)).toBe(0.03)
    expect(claimDust(0.5)).toBe(0)
    expect(claimDust(4)).toBe(0)
    expect(claimDust(undefined)).toBe(0)
  })
})

describe('Auto-finish only moves held funds when the fee is small', () => {
  it('a held $1.09 on Ethereum (fee ~0.6) stays for Recover; $10 on Base (fee 0.026) is moved', async () => {
    const { autoFinishWorthIt } = await import('./ubClaim')
    expect(autoFinishWorthIt({ total: 0.6, receiveAtLeast: 0.48 }, 1.09)).toBe(false)
    expect(autoFinishWorthIt({ total: 0.026389, receiveAtLeast: 9.97 }, 10)).toBe(true)
    // A published-fee fallback (no live quote) never moves anything by itself.
    expect(autoFinishWorthIt({ total: 0.01, receiveAtLeast: 9.9, approx: true }, 10)).toBe(false)
  })
})
