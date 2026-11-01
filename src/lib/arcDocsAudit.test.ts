import { describe, it, expect } from 'vitest'
import { parseGwei } from 'viem'
import { codeIsEoa } from './merchantPay'
import { replacementFeeCap } from './stuckPayments'

// Rules from Arc's docs, checked in code (audit 1 Nov).
describe('Arc Memo: only an EOA may call it (docs: transaction-memos, unsupported wallets)', () => {
  it('plain account and EIP-7702 account: memo; contract wallet: plain send', () => {
    expect(codeIsEoa('0x')).toBe(true)
    expect(codeIsEoa(null)).toBe(true)
    expect(codeIsEoa('0xef0100' + 'ab'.repeat(20))).toBe(true)   // EIP-7702 delegation
    expect(codeIsEoa('0x6080604052')).toBe(false)                  // Safe / smart wallet bytecode
  })
})

describe('Cancelling a stuck payment always outbids it (replacements need +10%)', () => {
  it('twice the cap a send signs now, never under 60 gwei', () => {
    expect(replacementFeeCap(parseGwei('25'))).toBe(parseGwei('60'))
    expect(replacementFeeCap(parseGwei('56'))).toBe(parseGwei('112'))   // gas at 28 gwei: 60 would be refused
    // Always at least +10% over the cap a payment signed at the same price.
    for (const cap of [25, 40, 56, 100, 400].map(g => parseGwei(String(g)))) {
      expect(replacementFeeCap(cap) * 10n >= cap * 11n).toBe(true)
    }
  })
})
