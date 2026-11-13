// The passcode page's check of a passcode typed before the wallet's reading
// arrived (confirmMatch.agrees): a payment to an address never goes through
// on the app's words alone - the person sees who gets paid first.
import { describe, it, expect } from 'vitest'
import { agrees, compare } from './confirmMatch'
import type { IntentView } from './intent'

const ATTACKER = '0x000000000000000000000000000000000000dEaD'
const view = (o: Partial<IntentView>): IntentView => ({ action: 'Send', amount: '5', token: 'USDC', to: ATTACKER, rows: [], warnings: [], ...o })
const paying5 = { label: 'Paying', name: 'ravi.arc', amount: '5', unit: 'USDC' }

describe('agrees (passcode typed before the wallet read the request)', () => {
  it('a payment to an address: never on a matching amount alone - the recipient must be seen', () => {
    // The app said "Paying ravi.arc 5 USDC"; the wallet read 5 USDC to another address.
    expect(agrees(view({}), paying5)).toBe(false)
    expect(agrees(view({ action: 'Pay order' }), paying5)).toBe(false)
    expect(agrees(view({ action: 'Contract call' }), paying5)).toBe(false)
  })

  it('a spend limit (no recipient, the limit is enforced) may go ahead when it covers the amount', () => {
    const scope = view({ to: 'may leave your wallet', amount: '5.40', token: 'USDC' })
    expect(agrees(scope, paying5)).toBe(true)
    // More than the amount plus fees: the person sees the wallet's figure first.
    expect(agrees(view({ to: 'may leave your wallet', amount: '50', token: 'USDC' }), paying5)).toBe(false)
  })

  it('anything with a warning, or a different amount, waits for the person', () => {
    expect(agrees(view({ to: 'may leave your wallet', amount: '5', warnings: ['Unlimited approval'] }), paying5)).toBe(false)
    // Above the fee allowance (10% + 1): 7 on a 5 payment.
    expect(agrees(view({ to: 'may leave your wallet', amount: '7' }), paying5)).toBe(false)
  })

  it('nothing read yet: as shown', () => {
    expect(agrees(null, paying5)).toBe(true)
  })
})

describe('compare', () => {
  it('the same amount and token is the same; another token is not', () => {
    expect(compare(view({}), paying5).same).toBe(true)
    expect(compare(view({ token: 'EURC' }), paying5).same).toBe(false)
  })
})
