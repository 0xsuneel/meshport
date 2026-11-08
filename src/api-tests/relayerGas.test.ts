// The relayer out of gas must not read as "already minted" (8 Nov, Base Sepolia).
import { describe, it, expect, vi } from 'vitest'

vi.mock('@vercel/functions', () => ({ waitUntil: () => {} }))
const { isOutOfGasError, destMintNeedsWei, relayerOutOfGas } = await import('../../api/bridge-relay')

describe('isOutOfGasError', () => {
  it("recognises the node's and viem's no-gas errors seen on 8 Nov", () => {
    expect(isOutOfGasError('Execution reverted with reason: gas required exceeds allowance (0).')).toBe(true)
    expect(isOutOfGasError('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.')).toBe(true)
    expect(isOutOfGasError('insufficient funds for gas * price + value')).toBe(true)
  })
  it('leaves a real revert (an already-received message) alone', () => {
    expect(isOutOfGasError('Execution reverted with reason: Nonce already used.')).toBe(false)
    expect(isOutOfGasError('execution reverted')).toBe(false)
  })
})

describe('destMintNeedsWei', () => {
  it("is the mint's gas at 3x the current price", () => {
    expect(destMintNeedsWei(1_000_000_000n)).toBe(300_000n * 1_000_000_000n * 3n)
  })
})

it('the out-of-gas message names the chain (the app matches "out of gas")', () => {
  expect(relayerOutOfGas('Base Sepolia')).toMatch(/out of gas on Base Sepolia/)
})
