import { describe, expect, it } from 'vitest'
import { offerKeyFor, offerIdHash, tradeBucketKeyFor, tradeKeyFor } from './p2pEscrowContract'

// Same vector as the contract test "offerKeyOf matches the key the app
// computes" (test/P2PMeshportEscrowV3.test.js) - keeps the app's keys and
// P2PMeshportEscrowV3.offerKeyOf() in lockstep.
const ID = '3f2c9a10-0000-4000-8000-000000000001'
const WALLET = '0x000000000000000000000000000000000000bEEF'

describe('P2P escrow keys (V3, bound to the depositor on-chain)', () => {
  it('offerKeyFor = offerKeyOf(keccak(id), seller)', () => {
    expect(offerIdHash(ID)).toBe('0x99da535f493e790254f5b0b946f2001e720f5b91200f95df976207399e08729e')
    expect(offerKeyFor(ID, WALLET)).toBe('0x48556409277b71f5abea3fa2fd46242b4638039c932d6b6a447bf1a746772e70')
  })

  it('a buy-offer trade bucket is the trade key bound to its depositor', () => {
    expect(tradeKeyFor(ID)).toBe(offerIdHash(ID))
    expect(tradeBucketKeyFor(ID, WALLET)).toBe(offerKeyFor(ID, WALLET))
    expect(tradeBucketKeyFor(ID, WALLET)).not.toBe(tradeKeyFor(ID))
  })

  it('a different depositor never gets the same key', () => {
    expect(offerKeyFor(ID, '0x000000000000000000000000000000000000dEaD')).not.toBe(offerKeyFor(ID, WALLET))
  })
})
