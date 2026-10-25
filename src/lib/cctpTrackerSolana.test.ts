import { describe, it, expect } from 'vitest'
import { isBurnTxId, CCTP_DOMAINS } from './cctpTracker'

describe('CCTP tracking of Solana burns', () => {
  it('Solana is domain 5 and its burns are base58 signatures', () => {
    expect(CCTP_DOMAINS.Solana_Devnet).toBe(5)
    const sig = '5'.repeat(44) + 'abcdefghijkmnopqrstuvwxyzABCDEFGHJ'
    expect(isBurnTxId('Solana_Devnet', sig)).toBe(true)
    expect(isBurnTxId('Solana_Devnet', '0x' + 'a'.repeat(64))).toBe(false)
    expect(isBurnTxId('Base_Sepolia', '0x' + 'a'.repeat(64))).toBe(true)
    expect(isBurnTxId('Base_Sepolia', sig)).toBe(false)
  })
})
