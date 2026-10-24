import { describe, it, expect } from 'vitest'
import { hashMessage, hashTypedData, keccak256, parseGwei, serializeTransaction, type Hex } from 'viem'
import { hashSignRequest } from './requests'

const arcTx = { type: 'eip1559' as const, chainId: 5042002, nonce: 3, to: '0x2222222222222222222222222222222222222222' as Hex, value: 5n, gas: 60000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'), data: '0xa9059cbb0000' as Hex }
const permit = {
  domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' as Hex },
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] },
  primaryType: 'Permit' as const,
  message: { owner: '0x1111111111111111111111111111111111111111' as Hex, value: 1n },
}

describe('what the MPC server agrees to co-sign', () => {
  it('a testnet transaction: hashes the unsigned bytes itself and summarises it', () => {
    const tx = serializeTransaction(arcTx)
    const r = hashSignRequest({ kind: 'tx', tx })
    expect(r.hash).toBe(keccak256(tx))
    expect(r.summary).toMatchObject({ chainId: 5042002, to: arcTx.to, value: '5', nonce: 3, selector: '0xa9059cbb' })
  })

  it('refuses mainnet, signed transactions and garbage', () => {
    expect(() => hashSignRequest({ kind: 'tx', tx: serializeTransaction({ ...arcTx, chainId: 1 }) })).toThrow(/testnet/)
    const signed = serializeTransaction(arcTx, { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, yParity: 0 })
    expect(() => hashSignRequest({ kind: 'tx', tx: signed })).toThrow(/unsigned/)
    expect(() => hashSignRequest({ kind: 'tx', tx: '0xdeadbeef' })).toThrow(/valid transaction/)
    expect(() => hashSignRequest({ kind: 'tx', tx: 'hello' })).toThrow(/serialized/)
    expect(() => hashSignRequest({ hash: `0x${'aa'.repeat(32)}` })).toThrow(/Unknown request/) // never a bare hash
  })

  it('messages: text or raw bytes, hashed the personal_sign way', () => {
    expect(hashSignRequest({ kind: 'message', message: 'hello' }).hash).toBe(hashMessage('hello'))
    expect(hashSignRequest({ kind: 'message', message: { raw: '0x1234' } }).hash).toBe(hashMessage({ raw: '0x1234' }))
    expect(() => hashSignRequest({ kind: 'message', message: { raw: 'zz' } })).toThrow(/text or/)
  })

  it('typed data (e.g. a USDC permit) only on a testnet', () => {
    expect(hashSignRequest({ kind: 'typed', typedData: permit }).hash).toBe(hashTypedData(permit))
    expect(() => hashSignRequest({ kind: 'typed', typedData: { ...permit, domain: { ...permit.domain, chainId: 8453 } } })).toThrow(/testnet/)
    expect(() => hashSignRequest({ kind: 'typed', typedData: { domain: { chainId: 5042002 } } })).toThrow(/EIP-712/)
  })
})
