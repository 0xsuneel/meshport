import { describe, it, expect } from 'vitest'
import { getBase58Decoder } from '@solana/kit'
import { base58Encode, solanaPayUri, solanaReference } from './solanaPay'
import { isSolanaAddress, SOLANA_USDC_MINT } from './solana'

describe('Solana Pay for MeshPort requests', () => {
  it('base58 matches @solana/kit, leading zero bytes included', () => {
    for (let i = 0; i < 100; i++) {
      const b = crypto.getRandomValues(new Uint8Array(32)); if (i % 5 === 0) { b[0] = 0; b[1] = 0 }
      expect(base58Encode(b)).toBe(getBase58Decoder().decode(b))
    }
  })
  it('the reference is a 32-byte key, the same for any letter case of the code', async () => {
    const r = await solanaReference('AbC123')
    expect(isSolanaAddress(r)).toBe(true)
    expect(r).toBe(await solanaReference('abc123'))
    expect(r).not.toBe(await solanaReference('abc124'))
  })
  it('URI: recipient, exact amount, USDC mint, reference', () => {
    const u = solanaPayUri({ to: '9CpKA758hD933rs3kRf2ntNoLkEgR5JErGrge5yp6B7T', amount: 5.5, reference: 'Ref111', label: 'Shop' })
    expect(u).toBe(`solana:9CpKA758hD933rs3kRf2ntNoLkEgR5JErGrge5yp6B7T?amount=5.5&spl-token=${SOLANA_USDC_MINT}&reference=Ref111&label=Shop`)
  })
})
