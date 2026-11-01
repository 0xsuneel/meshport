import { describe, it, expect, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: {} }))
const { officialArcExplorer } = await import('./ActivityService')

describe('saved explorer links use Arc\'s official explorer', () => {
  it('rewrites old arcscan links, keeps the path, leaves others alone', () => {
    expect(officialArcExplorer('https://testnet.arcscan.app/tx/0xab')).toBe('https://explorer.testnet.arc.io/tx/0xab')
    expect(officialArcExplorer('https://arcscan.app/tx/0xab')).toBe('https://explorer.arc.io/tx/0xab')
    expect(officialArcExplorer('https://sepolia.etherscan.io/tx/0xab')).toBe('https://sepolia.etherscan.io/tx/0xab')
    expect(officialArcExplorer('https://testnet.arcscan.app.evil.com/tx/0xab')).toBe('https://testnet.arcscan.app.evil.com/tx/0xab')
    expect(officialArcExplorer(undefined)).toBeUndefined()
  })
})
