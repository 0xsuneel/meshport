import { describe, it, expect } from 'vitest'
import { quoteAccount, isWalletAccount } from './account'

describe('quoteAccount: the address for fee quotes, never a signer', () => {
  const A = '0x1111111111111111111111111111111111111111'
  it('has the address and refuses every signature', async () => {
    const q = quoteAccount(A)
    expect(q.address.toLowerCase()).toBe(A)
    expect(isWalletAccount(q)).toBe(true)
    await expect(q.signMessage({ message: 'x' })).rejects.toThrow(/never signs/)
    await expect(q.signTransaction({ to: A, value: 1n, chainId: 1 } as any)).rejects.toThrow(/never signs/)
    await expect(q.signTypedData({ domain: {}, types: { T: [{ name: 'a', type: 'uint256' }] }, primaryType: 'T', message: { a: 1n } } as any)).rejects.toThrow(/never signs/)
  })
})
