import { describe, it, expect } from 'vitest'
import { resolveAvailableMechanisms, resolveChainMechanism, isChainEnabledForTransfer, isChainEnabledForClaim } from './featureFilters'
import { canBringOverCctp } from './gaslessBridge'

const row = (enabled: boolean) => ({ enabled }) as any

describe('Solana routes, like the other chains', () => {
  it('Transfer offers both Unified Balance and CCTP until an admin turns one off', () => {
    expect(resolveAvailableMechanisms({}, 'sol')).toEqual(['ub', 'cctp'])
    expect(resolveChainMechanism({}, 'sol')).toBe('ub')
    expect(resolveAvailableMechanisms({ solana_cctp_enabled: row(false) }, 'sol')).toEqual(['ub'])
    expect(resolveAvailableMechanisms({ solana_ub_enabled: row(false) }, 'sol')).toEqual(['cctp'])
    expect(resolveChainMechanism({ solana_ub_enabled: row(false) }, 'sol')).toBe('cctp')
    // other chains unchanged: CCTP off without a row
    expect(resolveAvailableMechanisms({}, 'eth')).toEqual(['ub'])
  })
  it('admin switches for Transfer and Claim', () => {
    expect(isChainEnabledForTransfer({}, 'sol')).toBe(true)
    expect(isChainEnabledForTransfer({ solana_transfer_enabled: row(false) }, 'sol')).toBe(false)
    expect(isChainEnabledForClaim({ solana_claim_enabled: row(false) }, 'Solana_Devnet')).toBe(false)
  })
  it('Bring / Collect / Claim All accept Solana without an EVM router', () => {
    expect(canBringOverCctp('Solana_Devnet')).toBe(true)
    expect(canBringOverCctp('Morph_Testnet')).toBe(false)
  })
})
