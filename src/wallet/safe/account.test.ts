import { describe, it, expect } from 'vitest'
import { decodeFunctionData, encodeFunctionData, toHex } from 'viem'
import { SAFE } from './addresses'
import {
  DEFAULT_MODULES, createSafeCalldata, meshportSafeConfig, passkeyVerifiers, predictSafeAddress, safeInitializer,
} from './account'

// Offline checks of what the account builder encodes. The address itself is
// checked against Safe's real factory on Arc by scripts/safe-verify-arc.mjs.
const PASSKEY_OWNER = '0x1111111111111111111111111111111111111111'
const WALLET_KEY = '0x2222222222222222222222222222222222222222'
// Any bytes stand in for the factory's creation code offline.
const FAKE_CREATION_CODE = '0x6080604052348015600f57600080fd5b50'

const setupAbi = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ],
}] as const
const enableAbi = [{ type: 'function', name: 'enableModules', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'modules', type: 'address[]' }] }] as const

describe('MeshPort Safe account builder', () => {
  it('sets up passkey + wallet key, threshold 2, the three modules, 4337 fallback handler', () => {
    const { args } = decodeFunctionData({ abi: setupAbi, data: safeInitializer(meshportSafeConfig(PASSKEY_OWNER, WALLET_KEY)) })
    const [owners, threshold, to, data, fallback, payToken, payment, receiver] = args
    expect(owners).toEqual([PASSKEY_OWNER, WALLET_KEY])
    expect(threshold).toBe(2n)
    expect(to).toBe(SAFE.moduleSetup)
    expect(decodeFunctionData({ abi: enableAbi, data }).args[0]).toEqual([...DEFAULT_MODULES])
    expect(fallback).toBe(SAFE.module4337)
    expect([payToken, payment, receiver]).toEqual(['0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000'])
  })

  it('refuses unsafe configs', () => {
    expect(() => safeInitializer({ owners: [], threshold: 1 })).toThrow(/at least one owner/)
    expect(() => safeInitializer({ owners: [PASSKEY_OWNER], threshold: 2 })).toThrow(/Threshold/)
    expect(() => safeInitializer({ owners: [PASSKEY_OWNER, PASSKEY_OWNER], threshold: 1 })).toThrow(/unique/)
  })

  it('packs the P-256 verifiers as uint16(precompile 0x100) << 160 | FCL fallback', () => {
    const v = passkeyVerifiers()
    expect(v >> 160n).toBe(0x100n)
    expect(toHex(v & ((1n << 160n) - 1n), { size: 20 }).toLowerCase()).toBe(SAFE.fclP256Verifier.toLowerCase())
  })

  it('address is deterministic and changes with owners or salt', () => {
    const a = predictSafeAddress(meshportSafeConfig(PASSKEY_OWNER, WALLET_KEY), FAKE_CREATION_CODE)
    expect(predictSafeAddress(meshportSafeConfig(PASSKEY_OWNER, WALLET_KEY), FAKE_CREATION_CODE)).toBe(a)
    expect(predictSafeAddress(meshportSafeConfig(WALLET_KEY, PASSKEY_OWNER), FAKE_CREATION_CODE)).not.toBe(a)
    expect(predictSafeAddress(meshportSafeConfig(PASSKEY_OWNER, WALLET_KEY, 1n), FAKE_CREATION_CODE)).not.toBe(a)
  })

  it('factory calldata creates the SafeL2 singleton with the same initializer', () => {
    const cfg = meshportSafeConfig(PASSKEY_OWNER, WALLET_KEY)
    const { to, data } = createSafeCalldata(cfg)
    expect(to).toBe(SAFE.proxyFactory)
    expect(data).toBe(encodeFunctionData({
      abi: [{ type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }], outputs: [{ name: 'proxy', type: 'address' }] }],
      functionName: 'createProxyWithNonce', args: [SAFE.singletonL2, safeInitializer(cfg), 0n],
    }))
  })
})
