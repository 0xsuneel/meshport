// src/wallet/safe/account.ts
//
// A MeshPort user's account = a stock Safe 1.4.1 (SafeL2) on Arc:
//
//   owners     passkey signer (Face ID, hardware-bound)  +  wallet key
//   threshold  2  - large payments and every setting need both
//   modules    Safe4337Module (gasless userOps), AllowanceModule (small
//              single-signer payments), SocialRecoveryModule (guardians)
//
// "wallet key" is the wallet frame's key today (Phase 1) and is swapped for
// the threshold-MPC key later with the Safe's own swapOwner - same address.
//
// This file only computes: the setup calldata, the passkey owner's address
// and the Safe's counterfactual address. Deploying happens elsewhere, and
// only with the user's (and our) explicit go-ahead.

import {
  encodeFunctionData, encodePacked, getContractAddress, keccak256,
} from 'viem'
import type { Hex } from '../protocol'
import { SAFE, ARC_P256_PRECOMPILE } from './addresses'

const safeSetupAbi = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ],
}] as const

const enableModulesAbi = [{
  type: 'function', name: 'enableModules', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'modules', type: 'address[]' }],
}] as const

const proxyFactoryAbi = [
  { type: 'function', name: 'proxyCreationCode', stateMutability: 'pure', inputs: [], outputs: [{ type: 'bytes' }] },
  {
    type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable',
    inputs: [{ name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
] as const

const webAuthnSignerFactoryAbi = [{
  type: 'function', name: 'getSigner', stateMutability: 'view',
  inputs: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }, { name: 'verifiers', type: 'uint176' }],
  outputs: [{ name: 'signer', type: 'address' }],
}] as const

const ZERO = '0x0000000000000000000000000000000000000000' as const

/** Anything that can read a contract - a viem PublicClient, or a stub in tests. */
export interface ChainReader {
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>
}

/**
 * P256.Verifiers for passkey owners: uint16(precompile) << 160 | uint160(fallback).
 * Arc's 0x100 precompile first, Safe's FCL Solidity verifier as the fallback.
 */
export function passkeyVerifiers(): bigint {
  return (ARC_P256_PRECOMPILE << 160n) | BigInt(SAFE.fclP256Verifier)
}

export interface PasskeyPublicKey { x: bigint; y: bigint }

/** The passkey's owner address on the Safe (its signer contract, deployed or not). */
export async function passkeySignerAddress(client: ChainReader, key: PasskeyPublicKey): Promise<Hex> {
  return await client.readContract({
    address: SAFE.webAuthnSignerFactory, abi: webAuthnSignerFactoryAbi, functionName: 'getSigner',
    args: [key.x, key.y, passkeyVerifiers()],
  }) as Hex
}

/** Modules switched on when the Safe is created (configured by its first transaction). */
export const DEFAULT_MODULES: readonly Hex[] = [SAFE.module4337, SAFE.allowanceModule, SAFE.socialRecoveryModule]

export interface SafeConfig {
  owners: readonly Hex[]
  threshold: number
  modules?: readonly Hex[]
  /** Distinguishes several Safes for the same owners; MeshPort uses 0. */
  saltNonce?: bigint
}

/** Safe.setup(...) calldata: owners, threshold, modules, 4337 fallback handler. */
export function safeInitializer(cfg: SafeConfig): Hex {
  if (cfg.owners.length === 0) throw new Error('A Safe needs at least one owner')
  if (cfg.threshold < 1 || cfg.threshold > cfg.owners.length) throw new Error('Threshold must be between 1 and the number of owners')
  const seen = new Set(cfg.owners.map(o => o.toLowerCase()))
  if (seen.size !== cfg.owners.length) throw new Error('Owners must be unique')
  const modules = cfg.modules ?? DEFAULT_MODULES
  return encodeFunctionData({
    abi: safeSetupAbi, functionName: 'setup',
    args: [
      [...cfg.owners], BigInt(cfg.threshold),
      modules.length ? SAFE.moduleSetup : ZERO,
      modules.length ? encodeFunctionData({ abi: enableModulesAbi, functionName: 'enableModules', args: [[...modules]] }) : '0x',
      SAFE.module4337, ZERO, 0n, ZERO,
    ],
  })
}

/** SafeProxy creation code, read from the factory (no bytecode copied into the app). */
export async function proxyCreationCode(client: ChainReader): Promise<Hex> {
  return await client.readContract({ address: SAFE.proxyFactory, abi: proxyFactoryAbi, functionName: 'proxyCreationCode' }) as Hex
}

/**
 * The Safe's address before it exists - SafeProxyFactory.createProxyWithNonce's
 * CREATE2: salt = keccak256(keccak256(initializer) ‖ saltNonce),
 * code = creationCode ‖ uint256(singleton).
 */
export function predictSafeAddress(cfg: SafeConfig, creationCode: Hex): Hex {
  const initializer = safeInitializer(cfg)
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), cfg.saltNonce ?? 0n]))
  const bytecode = encodePacked(['bytes', 'uint256'], [creationCode, BigInt(SAFE.singletonL2)])
  return getContractAddress({ opcode: 'CREATE2', from: SAFE.proxyFactory, salt, bytecode })
}

/** Factory calldata that creates the Safe (used as the userOp's factoryData, or sent directly). */
export function createSafeCalldata(cfg: SafeConfig): { to: Hex; data: Hex } {
  return {
    to: SAFE.proxyFactory,
    data: encodeFunctionData({
      abi: proxyFactoryAbi, functionName: 'createProxyWithNonce',
      args: [SAFE.singletonL2, safeInitializer(cfg), cfg.saltNonce ?? 0n],
    }),
  }
}

/** MeshPort's account: passkey + wallet key, both required for anything beyond allowances. */
export function meshportSafeConfig(passkeyOwner: Hex, walletKeyOwner: Hex, saltNonce = 0n): SafeConfig {
  return { owners: [passkeyOwner, walletKeyOwner], threshold: 2, modules: DEFAULT_MODULES, saltNonce }
}
