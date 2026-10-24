import { describe, it, expect } from 'vitest'
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers'
import { generateMnemonic, english } from 'viem/accounts'
import { fromPhrase, fromKey, KeyError } from './keys'

// The app used ethers' HDNodeWallet at m/44'/60'/0'/0/0 for every phrase it
// made or imported (lib/arc.ts before the wallet frame). The frame derives
// with viem / @scure instead - these must give the very same key, or a
// returning user's phrase would open a different, empty wallet.
function ethersDerive(phrase: string) {
  const w = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim().toLowerCase()), "m/44'/60'/0'/0/0")
  return { privateKey: w.privateKey.toLowerCase(), address: w.address }
}

describe('wallet frame key derivation', () => {
  it('matches the app\'s previous (ethers) derivation for known phrases', () => {
    for (const phrase of [
      'test test test test test test test test test test test junk',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    ]) {
      const ours = fromPhrase(phrase)
      const theirs = ethersDerive(phrase)
      expect(ours.address).toBe(theirs.address)
      expect(ours.privateKey).toBe(theirs.privateKey)
    }
  })

  it('matches for freshly generated 12- and 24-word phrases', () => {
    for (const strength of [128, 256]) {
      for (let i = 0; i < 5; i++) {
        const phrase = generateMnemonic(english, strength)
        expect(fromPhrase(phrase).address).toBe(ethersDerive(phrase).address)
      }
    }
  })

  it('normalises spacing and case the way the old import did', () => {
    const phrase = 'test test test test test test test test test test test junk'
    expect(fromPhrase(`  TEST test\ttest  test test test test test test test test JUNK `).address).toBe(fromPhrase(phrase).address)
  })

  it('rejects a phrase with a bad checksum or a wrong word count', () => {
    expect(() => fromPhrase('test test test test test test test test test test test test')).toThrow(KeyError)
    expect(() => fromPhrase('test test test')).toThrow(KeyError)
    expect(() => fromPhrase('notaword test test test test test test test test test test junk')).toThrow(KeyError)
  })

  it('imports a raw private key with or without 0x, same address as ethers', () => {
    const w = Wallet.createRandom()
    expect(fromKey(w.privateKey).address).toBe(w.address)
    expect(fromKey(w.privateKey.slice(2)).address).toBe(w.address)
    expect(() => fromKey('0x1234')).toThrow(KeyError)
    expect(() => fromKey('zz'.repeat(32))).toThrow(KeyError)
  })
})
