import { describe, it, expect } from 'vitest'
import { parsePersonalPayLink } from './payLinks'
import { codeFromLink, paymentLink } from './merchantPay'

// Payment links moved from /pay/… to /paylink/…; links shared before the
// rename (in chat history, printed QR codes) must keep working.
describe('payment link paths', () => {
  it('parses a new /paylink/<username> link with amount', () => {
    expect(parsePersonalPayLink('pay me https://meshport.xyz/paylink/sunil.arc?amount=12.5')).toMatchObject({ username: 'sunil', amount: '12.5' })
  })
  it('still parses an old /pay/<username> link', () => {
    expect(parsePersonalPayLink('https://meshport.xyz/pay/sunil')).toMatchObject({ username: 'sunil', amount: null })
  })
  it('does not read a merchant link as a personal one', () => {
    expect(parsePersonalPayLink('https://meshport.xyz/paylink/r/abc123def')).toBeNull()
    expect(parsePersonalPayLink('https://meshport.xyz/pay/r/abc123def')).toBeNull()
  })
  it('reads merchant codes from new and old links', () => {
    expect(codeFromLink('https://meshport.xyz/paylink/r/AbC123def')).toBe('abc123def')
    expect(codeFromLink('https://meshport.xyz/pay/r/abc123def')).toBe('abc123def')
  })
  it('builds merchant links on the new path', () => {
    expect(paymentLink('abc123def')).toMatch(/\/paylink\/r\/abc123def$/)
  })
})
