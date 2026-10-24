// src/wallet/safe/setup.ts
//
// The Safe's first transaction: configure the modules enabled at creation.
// One batch (MultiSendCallOnly, delegatecalled by the Safe), signed by both
// owners like any other Safe transaction:
//
//   AllowanceModule.addDelegate(deviceKey)
//   AllowanceModule.setAllowance(deviceKey, USDC, dailyLimit, 1 day, now)
//   SocialRecoveryModule.addGuardianWithThreshold(guardian, threshold)   × N
//
// "deviceKey" is the per-device spending key: a plain secp256k1 key kept
// sealed in the wallet frame and opened by Face ID at the start of a session.
// The AllowanceModule only accepts ECDSA signatures from its delegates, so a
// passkey can't be one directly; this key carries tap-to-pay, and the Safe
// itself caps what it can spend.

import { concat, encodeFunctionData, encodePacked, size } from 'viem'
import type { Hex } from '../protocol'
import { SAFE, ARC_USDC_ERC20 } from './addresses'

const allowanceAbi = [
  { type: 'function', name: 'addDelegate', stateMutability: 'nonpayable', inputs: [{ name: 'delegate', type: 'address' }], outputs: [] },
  {
    type: 'function', name: 'setAllowance', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'delegate', type: 'address' }, { name: 'token', type: 'address' }, { name: 'allowanceAmount', type: 'uint96' },
      { name: 'resetTimeMin', type: 'uint16' }, { name: 'resetBaseMin', type: 'uint32' },
    ],
  },
] as const

// SocialRecoveryModule as deployed on Arc (safe-fndn/candide-contracts @ 113d3c0).
const recoveryAbi = [{
  type: 'function', name: 'addGuardianWithThreshold', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: '_guardian', type: 'address' }, { name: '_threshold', type: 'uint256' }],
}] as const

const multiSendAbi = [{
  type: 'function', name: 'multiSend', stateMutability: 'payable', outputs: [],
  inputs: [{ name: 'transactions', type: 'bytes' }],
}] as const

export interface Call { to: Hex; value?: bigint; data: Hex }

/** Safe operation: 0 = call, 1 = delegatecall (MultiSend must be delegatecalled). */
export interface SafeTx extends Call { operation: 0 | 1 }

const USDC_DECIMALS = 6
const MAX_UINT96 = (1n << 96n) - 1n

/** USDC amount in token units (6 decimals) from a decimal string - no float rounding. */
export function usdcUnits(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim())
  if (!m) throw new Error(`Not a USDC amount: ${amount}`)
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0')
}

/**
 * The AllowanceModule calls that let `delegate` spend up to `dailyLimit` USDC,
 * resetting every `resetMinutes` (default one day) from `startMinute`.
 */
export function allowanceCalls(p: { delegate: Hex; dailyLimit: string; resetMinutes?: number; startMinute: number }): Call[] {
  const amount = usdcUnits(p.dailyLimit)
  if (amount <= 0n || amount > MAX_UINT96) throw new Error('Daily limit must be above 0 and fit the allowance module')
  const reset = p.resetMinutes ?? 24 * 60
  if (!Number.isInteger(reset) || reset < 1 || reset > 0xffff) throw new Error('Reset period must be 1 to 65535 minutes')
  if (!Number.isInteger(p.startMinute) || p.startMinute < 0 || p.startMinute > 0xffffffff) throw new Error('Bad start minute')
  return [
    { to: SAFE.allowanceModule, data: encodeFunctionData({ abi: allowanceAbi, functionName: 'addDelegate', args: [p.delegate] }) },
    {
      to: SAFE.allowanceModule,
      data: encodeFunctionData({ abi: allowanceAbi, functionName: 'setAllowance', args: [p.delegate, ARC_USDC_ERC20, amount, reset, p.startMinute] }),
    },
  ]
}

/**
 * Guardians, each added with the final threshold. The module requires the
 * threshold to stay ≤ the guardian count as they're added, so the threshold
 * passed with guardian i is min(threshold, i + 1).
 */
export function guardianCalls(guardians: readonly Hex[], threshold: number, owners: readonly Hex[] = []): Call[] {
  if (guardians.length === 0) return []
  const unique = new Set(guardians.map(g => g.toLowerCase()))
  if (unique.size !== guardians.length) throw new Error('Guardians must be unique')
  // The module reverts on these; fail before anyone signs.
  const ownerSet = new Set(owners.map(o => o.toLowerCase()))
  for (const g of guardians) {
    if (/^0x0{40}$/i.test(g)) throw new Error('A guardian cannot be the zero address')
    if (ownerSet.has(g.toLowerCase())) throw new Error('A guardian cannot also be an owner of the Safe')
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > guardians.length) {
    throw new Error('Guardian threshold must be between 1 and the number of guardians')
  }
  return guardians.map((g, i) => ({
    to: SAFE.socialRecoveryModule,
    data: encodeFunctionData({ abi: recoveryAbi, functionName: 'addGuardianWithThreshold', args: [g, BigInt(Math.min(threshold, i + 1))] }),
  }))
}

/** MultiSend packing: operation(1) ‖ to(20) ‖ value(32) ‖ dataLength(32) ‖ data, per call. */
export function encodeMultiSend(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new Error('Nothing to batch')
  const packed = concat(calls.map(c => encodePacked(
    ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
    [0, c.to, c.value ?? 0n, BigInt(size(c.data)), c.data],
  )))
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packed] })
}

export interface FirstSetup {
  /** Device spending key for tap-to-pay (the session key's long-lived form). */
  deviceKey: Hex
  /** e.g. "50" - USDC the device key may spend per day without both owners. */
  dailyLimit: string
  guardians: readonly Hex[]
  guardianThreshold: number
  /** The Safe's owners - a guardian may not be one of them. */
  owners: readonly Hex[]
  /** Minutes since epoch to start the allowance period from (default: now). */
  startMinute?: number
}

/** The whole first-use configuration as one Safe transaction (delegatecall to MultiSendCallOnly). */
export function firstSetupTx(s: FirstSetup): SafeTx {
  const calls = [
    ...allowanceCalls({ delegate: s.deviceKey, dailyLimit: s.dailyLimit, startMinute: s.startMinute ?? Math.floor(Date.now() / 60_000) }),
    ...guardianCalls(s.guardians, s.guardianThreshold, s.owners),
  ]
  return { to: SAFE.multiSendCallOnly, value: 0n, data: encodeMultiSend(calls), operation: 1 }
}
