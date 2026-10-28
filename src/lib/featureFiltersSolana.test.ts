import { describe, it, expect } from 'vitest'
import {
  transferRoutes, isChainEnabledForTransfer, bringRoutes, isChainEnabledForBring,
  isChainEnabledForSettle, isChainEnabledForClaim, transferKeys, bringKeys, settleKey,
} from './featureFilters'
import { canBringOverCctp } from './gaslessBridge'

const row = (enabled: boolean) => ({ enabled }) as any

describe('Solana routes, like the other chains', () => {
  it('Transfer offers both Unified Balance and CCTP until an admin turns one off', () => {
    expect(transferRoutes({}, 'sol')).toEqual(['ub', 'cctp'])
    expect(transferRoutes({ solana_cctp_enabled: row(false) }, 'sol')).toEqual(['ub'])
    expect(transferRoutes({ solana_ub_enabled: row(false) }, 'sol')).toEqual(['cctp'])
    // other Unified Balance chains: CCTP starts off without a row
    expect(transferRoutes({}, 'eth')).toEqual(['ub'])
  })
  it('admin switches for Transfer and Bring', () => {
    expect(isChainEnabledForTransfer({}, 'sol')).toBe(true)
    expect(isChainEnabledForTransfer({ solana_transfer_enabled: row(false) }, 'sol')).toBe(false)
    expect(isChainEnabledForBring({ solana_claim_enabled: row(false) }, 'Solana_Devnet')).toBe(false)
  })
  it('Bring / Collect / Claim All accept Solana without an EVM router', () => {
    expect(canBringOverCctp('Solana_Devnet')).toBe(true)
    expect(canBringOverCctp('Morph_Testnet')).toBe(false)
  })
})

describe('No override, no fallback', () => {
  it('both Transfer routes off = the chain is off (no silent CCTP)', () => {
    const s = { ethereum_ub_enabled: row(false), ethereum_cctp_enabled: row(false) }
    expect(transferRoutes(s, 'eth')).toEqual([])
    expect(isChainEnabledForTransfer(s, 'eth')).toBe(false)
  })
  it('CCTP on does not hide Unified Balance (both are offered)', () => {
    expect(transferRoutes({ ethereum_cctp_enabled: row(true) }, 'eth')).toEqual(['ub', 'cctp'])
  })
  it('a CCTP-only chain is controlled by its chain switch alone', () => {
    expect(transferRoutes({}, 'linea')).toEqual(['cctp'])
    expect(transferRoutes({ linea_transfer_enabled: row(false) }, 'linea')).toEqual([])
  })
  it('Bring routes: only what the chain supports and the admin has on', () => {
    expect(bringRoutes({}, 'Base_Sepolia', 'personal', { ub: true, cctp: true })).toEqual(['ub', 'cctp'])
    expect(bringRoutes({ base_claim_ub_enabled: row(false) }, 'Base_Sepolia', 'personal', { ub: true, cctp: true })).toEqual(['cctp'])
    expect(bringRoutes({}, 'Base_Sepolia', 'personal', { ub: false, cctp: true })).toEqual(['cctp'])
    expect(bringRoutes({ base_claim_cctp_enabled: row(false) }, 'Base_Sepolia', 'personal', { ub: false, cctp: true })).toEqual([])
  })
})

describe('Personal and business switches are separate', () => {
  it('keys', () => {
    expect(transferKeys('personal', 'eth')).toEqual({ chain: 'ethereum_transfer_enabled', ub: 'ethereum_ub_enabled', cctp: 'ethereum_cctp_enabled' })
    expect(transferKeys('business', 'eth')).toEqual({ chain: 'biz_ethereum_transfer_enabled', ub: 'biz_ethereum_ub_enabled', cctp: 'biz_ethereum_cctp_enabled' })
    expect(transferKeys('business', 'linea')).toEqual({ chain: 'biz_linea_transfer_enabled', ub: null, cctp: null })
    expect(bringKeys('business', 'World_Chain_Sepolia')).toEqual({ chain: 'biz_world_chain_claim_enabled', ub: 'biz_world_chain_claim_ub_enabled', cctp: 'biz_world_chain_claim_cctp_enabled' })
    expect(bringKeys('personal', 'Polygon_Amoy_Testnet').chain).toBe('polygon_claim_enabled')
    expect(settleKey('Base_Sepolia')).toBe('biz_base_settle_enabled')
  })
  it('turning a personal chain off does not touch business, and the other way round', () => {
    const personalOff = { base_transfer_enabled: row(false), base_claim_enabled: row(false) }
    expect(isChainEnabledForTransfer(personalOff, 'base', 'personal')).toBe(false)
    expect(isChainEnabledForTransfer(personalOff, 'base', 'business')).toBe(true)
    expect(isChainEnabledForBring(personalOff, 'Base_Sepolia', 'business')).toBe(true)
    expect(isChainEnabledForSettle(personalOff, 'Base_Sepolia')).toBe(true)

    const businessOff = { biz_base_transfer_enabled: row(false), biz_base_claim_enabled: row(false), biz_base_settle_enabled: row(false) }
    expect(isChainEnabledForTransfer(businessOff, 'base', 'business')).toBe(false)
    expect(isChainEnabledForTransfer(businessOff, 'base', 'personal')).toBe(true)
    expect(isChainEnabledForBring(businessOff, 'Base_Sepolia', 'personal')).toBe(true)
    expect(isChainEnabledForSettle(businessOff, 'Base_Sepolia')).toBe(false)
  })
  it('business routes are their own', () => {
    expect(transferRoutes({ biz_ethereum_ub_enabled: row(false), biz_ethereum_cctp_enabled: row(true) }, 'eth', 'business')).toEqual(['cctp'])
    expect(transferRoutes({ biz_ethereum_ub_enabled: row(false), biz_ethereum_cctp_enabled: row(true) }, 'eth', 'personal')).toEqual(['ub'])
  })
  it('balance scan: a business reads chains it can Bring or Settle from', () => {
    const s = { biz_base_claim_enabled: row(false), biz_base_settle_enabled: row(true) }
    expect(isChainEnabledForClaim(s, 'Base_Sepolia', 'business')).toBe(true)
    expect(isChainEnabledForClaim({ ...s, biz_base_settle_enabled: row(false) }, 'Base_Sepolia', 'business')).toBe(false)
    expect(isChainEnabledForClaim(s, 'Base_Sepolia', 'personal')).toBe(true)
  })
})
