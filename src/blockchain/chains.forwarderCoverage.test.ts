import { describe, it, expect } from 'vitest'
import { FORWARDER_SUPPORTED_SDK_CHAINS, chainSupportsForwarder } from './chains'

// Regression guard for the claim-direction "some chains not working" bug:
// backgroundBridge.ts now branches on chainSupportsForwarder() for every
// claim's Arc-side destination (see buildClaimDestTarget in
// src/lib/backgroundBridge.ts), the same way MultichainTransferPage.tsx
// already does for Send. Morph_Testnet, Pharos_Testnet and Injective_Testnet
// are the 3 of 21 claim-eligible chains NOT on Circle's Forwarding Service
// allow-list — if they were ever silently added back to this set without
// actually being forwarder-eligible, or removed while genuinely eligible,
// that's the exact class of drift that broke Plume on Send before it was
// added here. Lock in the known-false set explicitly.
describe('FORWARDER_SUPPORTED_SDK_CHAINS coverage', () => {
  it('excludes the 3 chains known not to be forwarder-eligible', () => {
    expect(chainSupportsForwarder('Morph_Testnet')).toBe(false)
    expect(chainSupportsForwarder('Pharos_Testnet')).toBe(false)
    expect(chainSupportsForwarder('Injective_Testnet')).toBe(false)
  })

  it('includes every other claim-eligible chain', () => {
    const shouldBeSupported = [
      'Ethereum_Sepolia', 'Base_Sepolia', 'Arbitrum_Sepolia', 'Optimism_Sepolia',
      'Polygon_Amoy_Testnet', 'Avalanche_Fuji', 'HyperEVM_Testnet', 'Sei_Testnet',
      'Sonic_Testnet', 'Unichain_Sepolia', 'World_Chain_Sepolia', 'Linea_Sepolia',
      'Ink_Testnet', 'Monad_Testnet', 'Plume_Testnet', 'XDC_Apothem',
      'Codex_Testnet', 'Edge_Testnet',
    ]
    for (const id of shouldBeSupported) {
      expect(chainSupportsForwarder(id), `expected ${id} to be forwarder-supported`).toBe(true)
    }
  })

  it('the allow-list has exactly 18 entries (21 claim chains minus the 3 known gaps)', () => {
    expect(FORWARDER_SUPPORTED_SDK_CHAINS.size).toBe(18)
  })
})
