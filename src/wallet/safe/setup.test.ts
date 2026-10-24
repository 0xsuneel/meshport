import { describe, it, expect } from 'vitest'
import { decodeFunctionData, hexToBigInt, hexToNumber, slice, size, type Hex } from 'viem'
import { SAFE, ARC_USDC_ERC20 } from './addresses'
import { allowanceCalls, encodeMultiSend, firstSetupTx, guardianCalls, usdcUnits } from './setup'

const DEVICE_KEY = '0x3333333333333333333333333333333333333333'
const OWNER_A = '0x1111111111111111111111111111111111111111'
const OWNER_B = '0x2222222222222222222222222222222222222222'
const G1 = '0x4444444444444444444444444444444444444444'
const G2 = '0x5555555555555555555555555555555555555555'
const G3 = '0x6666666666666666666666666666666666666666'

const abis = [
  { type: 'function', name: 'multiSend', stateMutability: 'payable', outputs: [], inputs: [{ name: 'transactions', type: 'bytes' }] },
  { type: 'function', name: 'addDelegate', stateMutability: 'nonpayable', inputs: [{ name: 'delegate', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setAllowance', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'delegate', type: 'address' }, { name: 'token', type: 'address' }, { name: 'allowanceAmount', type: 'uint96' }, { name: 'resetTimeMin', type: 'uint16' }, { name: 'resetBaseMin', type: 'uint32' }] },
  { type: 'function', name: 'addGuardianWithThreshold', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: '_guardian', type: 'address' }, { name: '_threshold', type: 'uint256' }] },
] as const

/** Unpack MultiSend bytes exactly as MultiSendCallOnly reads them. */
function unpack(transactions: Hex) {
  const out: { op: number; to: Hex; value: bigint; data: Hex }[] = []
  let i = 0
  while (i < size(transactions)) {
    const op = hexToNumber(slice(transactions, i, i + 1)); i += 1
    const to = slice(transactions, i, i + 20); i += 20
    const value = hexToBigInt(slice(transactions, i, i + 32)); i += 32
    const len = hexToNumber(slice(transactions, i, i + 32)); i += 32
    const data = len ? slice(transactions, i, i + len) : '0x'; i += len
    out.push({ op, to: to.toLowerCase() as Hex, value, data })
  }
  return out
}

describe('Safe first-use setup', () => {
  it('USDC amounts are exact 6-decimal units', () => {
    expect(usdcUnits('50')).toBe(50_000_000n)
    expect(usdcUnits('0.000001')).toBe(1n)
    expect(usdcUnits('12.5')).toBe(12_500_000n)
    expect(() => usdcUnits('1.0000001')).toThrow()
    expect(() => usdcUnits('-1')).toThrow()
  })

  it('batches addDelegate, setAllowance and guardians into one MultiSend delegatecall', () => {
    const tx = firstSetupTx({
      deviceKey: DEVICE_KEY, dailyLimit: '50', guardians: [G1, G2, G3], guardianThreshold: 2,
      owners: [OWNER_A, OWNER_B], startMinute: 29_000_000,
    })
    expect(tx.to).toBe(SAFE.multiSendCallOnly)
    expect(tx.operation).toBe(1)
    const calls = unpack(decodeFunctionData({ abi: abis, data: tx.data }).args[0] as Hex)
    expect(calls.map(c => [c.op, c.to, c.value])).toEqual([
      [0, SAFE.allowanceModule.toLowerCase(), 0n],
      [0, SAFE.allowanceModule.toLowerCase(), 0n],
      [0, SAFE.socialRecoveryModule.toLowerCase(), 0n],
      [0, SAFE.socialRecoveryModule.toLowerCase(), 0n],
      [0, SAFE.socialRecoveryModule.toLowerCase(), 0n],
    ])
    const decoded = calls.map(c => decodeFunctionData({ abi: abis, data: c.data }))
    expect(decoded[0]).toMatchObject({ functionName: 'addDelegate', args: [DEVICE_KEY] })
    expect(decoded[1]).toMatchObject({ functionName: 'setAllowance', args: [DEVICE_KEY, ARC_USDC_ERC20, 50_000_000n, 1440, 29_000_000] })
    // Threshold never exceeds the guardian count while they're being added.
    expect(decoded.slice(2).map(d => d.args)).toEqual([[G1, 1n], [G2, 2n], [G3, 2n]])
  })

  it('refuses setups the modules would reject', () => {
    expect(() => guardianCalls([G1, G1], 1)).toThrow(/unique/)
    expect(() => guardianCalls([G1], 2)).toThrow(/threshold/)
    expect(() => guardianCalls([OWNER_A], 1, [OWNER_A, OWNER_B])).toThrow(/owner/)
    expect(() => guardianCalls(['0x0000000000000000000000000000000000000000'], 1)).toThrow(/zero/)
    expect(() => allowanceCalls({ delegate: DEVICE_KEY, dailyLimit: '0', startMinute: 1 })).toThrow(/above 0/)
    expect(() => allowanceCalls({ delegate: DEVICE_KEY, dailyLimit: '5', resetMinutes: 0, startMinute: 1 })).toThrow(/Reset/)
    expect(() => encodeMultiSend([])).toThrow()
  })

  it('works without guardians (added later)', () => {
    const tx = firstSetupTx({ deviceKey: DEVICE_KEY, dailyLimit: '20', guardians: [], guardianThreshold: 1, owners: [OWNER_A, OWNER_B], startMinute: 1 })
    expect(unpack(decodeFunctionData({ abi: abis, data: tx.data }).args[0] as Hex)).toHaveLength(2)
  })
})
