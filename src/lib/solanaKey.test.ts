import { describe, it, expect } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { deriveSolanaSeed, solanaPublicKey, solanaSign } from './solanaKey'
import { deriveChatSeed } from './chatIdentity'

const KEY = '0x' + 'ab'.repeat(32)

describe('Solana key of a created / imported wallet', () => {
  it('is deterministic per wallet and differs between wallets', () => {
    expect(Buffer.from(solanaPublicKey(KEY))).toEqual(Buffer.from(solanaPublicKey(KEY)))
    expect(Buffer.from(solanaPublicKey(KEY))).not.toEqual(Buffer.from(solanaPublicKey('0x' + 'cd'.repeat(32))))
  })

  it('is domain-separated: not the wallet key, not the chat seed', () => {
    const seed = deriveSolanaSeed(KEY)
    expect(Buffer.from(seed).toString('hex')).not.toBe(KEY.slice(2))
    expect(Buffer.from(seed)).not.toEqual(Buffer.from(deriveChatSeed(KEY)))
  })

  it('signs messages that verify against its public key', () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5])
    const sig = solanaSign(KEY, msg)
    expect(sig).toHaveLength(64)
    expect(ed25519.verify(sig, msg, solanaPublicKey(KEY))).toBe(true)
    expect(ed25519.verify(sig, new Uint8Array([9]), solanaPublicKey(KEY))).toBe(false)
  })
})
