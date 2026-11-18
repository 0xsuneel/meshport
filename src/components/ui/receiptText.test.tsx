import { describe, it, expect } from 'vitest'
import { receiptText } from './SuccessReceipt'

describe('receiptText (what Share sends)', () => {
  it('has the amount, status, details, full hash and both explorer links of a transfer', () => {
    const t = receiptText({
      amount: '$5 sent', line: <>to <b>Base</b></>, fallbackTitle: 'Transfer', status: 'success',
      rows: [{ label: 'Network', value: 'Arc Testnet' }, { label: 'Transaction', value: '0x1234…abcd' }],
      fullHash: '0x' + 'ab'.repeat(32),
      links: [
        { title: 'View Burn on Arc Explorer', href: 'https://testnet.arcscan.app/tx/0x1' },
        { title: 'View Mint on Base', href: 'https://sepolia.basescan.org/tx/0x2' },
      ],
    })
    expect(t).toContain('$5 sent')
    expect(t).toContain('to Base')
    expect(t).toContain('Status: Successful')
    expect(t).toContain('Network: Arc Testnet')
    expect(t).not.toContain('0x1234…abcd')
    expect(t).toContain('Transaction: 0x' + 'ab'.repeat(32))
    expect(t).toContain('https://testnet.arcscan.app/tx/0x1')
    expect(t).toContain('https://sepolia.basescan.org/tx/0x2')
  })
})
