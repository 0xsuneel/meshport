import { describe, it, expect } from 'vitest'
import { buildClaimDestTarget } from './backgroundBridge'

// Regression guard for the actual fix: claims used to hardcode
// useForwarder:true for every source chain, which silently stalled claims
// from chains Circle's Forwarding Service doesn't cover (the claim burns
// successfully, then the mint is never submitted, and the claim sits in
// 'bridging' forever since that stage has no timeout). buildClaimDestTarget
// now picks the right `to` target per chain instead.
describe('buildClaimDestTarget', () => {
  const walletAddr = '0xabc0000000000000000000000000000000000a'
  const adapter = { fake: 'adapter' }

  it('forwarder-eligible chains use useForwarder:true with no adapter on `to`', () => {
    const t = buildClaimDestTarget('Ethereum_Sepolia', 'Ethereum_Sepolia', walletAddr, adapter)
    expect(t.useForwarder).toBe(true)
    expect(t.chain).toBe('Arc_Testnet')
    expect(t.recipientAddress).toBe(walletAddr)
    expect('adapter' in t).toBe(false)
  })

  it('non-forwarder-eligible chains fall back to adapter submitting the mint on Arc', () => {
    for (const [internalId, sdkId] of [
      ['Morph_Testnet', 'Morph_Testnet'],
      ['Pharos_Testnet', 'Pharos_Testnet'],
      ['Injective_Testnet', 'Injective_Testnet'],
    ] as const) {
      const t: any = buildClaimDestTarget(internalId, sdkId, walletAddr, adapter)
      expect(t.useForwarder, `${internalId} should NOT use the forwarder`).toBe(false)
      expect(t.chain).toBe('Arc_Testnet')
      expect(t.adapter).toBe(adapter)
      // recipientAddress kept alongside adapter, same pattern
      // MultichainTransferPage.tsx uses for its own non-forwarder fallback.
      expect(t.recipientAddress).toBe(walletAddr)
    }
  })

  it('falls back to the internal chain id when no sdkChainId is given', () => {
    const t = buildClaimDestTarget('Morph_Testnet', undefined, walletAddr, adapter)
    expect(t.useForwarder).toBe(false)
  })
})
