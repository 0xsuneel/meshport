// What a spend limit counts, read by the wallet itself (policy.ts).
import { describe, it, expect } from 'vitest'
import { encodeFunctionData, erc20Abi, maxUint256, pad } from 'viem'
import { classify, describeRequest, fits, parseScope, canonical } from './policy'

const me = '0x1111111111111111111111111111111111111111'
const them = '0x2222222222222222222222222222222222222222'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const GATEWAY = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const tx = (over: Record<string, unknown>) => ({ type: 'eip1559', chainId: 5042002, nonce: 0, to: them, value: 0n, gas: 100_000n, maxFeePerGas: 1_000_000_000n, ...over })
const spends = (c: ReturnType<typeof classify>) => (c.ok ? c.spends : c.reason)

describe('spend limit policy', () => {
  it('counts native USDC, token transfers and approvals in one 18-decimal unit', () => {
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ value: 10n ** 18n }) }))).toEqual({ USDC: 10n ** 18n })
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [them, 2_000_000n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ to: ARC_USDC, data: transfer }) }))).toEqual({ USDC: 2n * 10n ** 18n })
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GATEWAY, 5_000_000n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ chainId: 11155111, to: SEPOLIA_USDC, data: approve }) }))).toEqual({ USDC: 5n * 10n ** 18n })
    // Someone else's tokens moved by transferFrom cost this wallet nothing.
    const pull = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [them, me, 9n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ to: ARC_USDC, data: pull }) }))).toEqual({ USDC: 0n })
  })

  it('an unlimited approval never fits a limit, and the exact view warns about it', () => {
    const scope = parseScope({ limits: [{ asset: 'USDC', amount: '1000000' }] })
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GATEWAY, maxUint256] })
    const c = classify(me, 'sign:transaction', { transaction: tx({ to: ARC_USDC, data }) })
    expect(c.ok && fits(scope, { ...scope.limits }, c)).toBeNull()
    const view = describeRequest('sign:transaction', { transaction: tx({ to: ARC_USDC, data }) })
    expect(view).toMatchObject({ action: 'Allow spending', amount: 'Unlimited', token: 'USDC' })
    expect(view.warnings[0]).toContain('any amount')
  })

  it('permits and transfer authorizations count their value; for another owner they are refused', () => {
    const permit = (owner: string) => ({ domain: { name: 'USDC', version: '2', chainId: 11155111, verifyingContract: SEPOLIA_USDC }, primaryType: 'Permit', message: { owner, spender: them, value: 3_000_000n, nonce: 0n, deadline: 1n } })
    expect(spends(classify(me, 'sign:typed-data', { typedData: permit(me) }))).toEqual({ USDC: 3n * 10n ** 18n })
    expect(classify(me, 'sign:typed-data', { typedData: permit(them) }).ok).toBe(false)
    const auth = { domain: { verifyingContract: ARC_USDC }, primaryType: 'ReceiveWithAuthorization', message: { from: me, to: them, value: 1_500_000n } }
    expect(spends(classify(me, 'sign:typed-data', { typedData: auth }))).toEqual({ USDC: 15n * 10n ** 17n })
    // A permit for a token the wallet doesn't know can't be counted.
    expect(classify(me, 'sign:typed-data', { typedData: { ...permit(me), domain: { verifyingContract: them } } }).ok).toBe(false)
  })

  it('a Gateway burn intent counts its value plus the most it may pay in fees', () => {
    const spec = { sourceToken: pad(SEPOLIA_USDC.toLowerCase() as `0x${string}`), destinationRecipient: pad(me), value: 4_000_000n }
    const set = { domain: { name: 'GatewayWallet', version: '1' }, primaryType: 'BurnIntentSet', message: { intents: [{ maxBlockHeight: 1n, maxFee: 500_000n, spec }, { maxBlockHeight: 1n, maxFee: 0n, spec }] } }
    expect(spends(classify(me, 'sign:typed-data', { typedData: set }))).toEqual({ USDC: 85n * 10n ** 17n })
    expect(describeRequest('sign:typed-data', { typedData: set })).toMatchObject({ action: 'Gateway transfer', amount: '8.5', token: 'USDC' })
  })

  it("typed data it can't read is refused, and shown with a warning", () => {
    const order = { domain: { name: 'Seaport' }, primaryType: 'OrderComponents', message: { offerer: me } }
    expect(classify(me, 'sign:typed-data', { typedData: order }).ok).toBe(false)
    expect(describeRequest('sign:typed-data', { typedData: order }).warnings.length).toBe(1)
  })

  it('fees and delegations: an expensive or 7702 transaction is never covered', () => {
    expect(classify(me, 'sign:transaction', { transaction: tx({ gas: 10n ** 9n, maxFeePerGas: 10n ** 12n }) }).ok).toBe(false)
    expect(classify(me, 'sign:transaction', { transaction: tx({ authorizationList: [] }) }).ok).toBe(false)
  })

  it('the confirmation binding ignores key order and the confirmation itself, not the contents', () => {
    const a = canonical('sign:transaction', { address: me, transaction: { to: them, value: 1n } })
    expect(canonical('sign:transaction', { transaction: { value: 1n, to: them.toUpperCase().replace('0X', '0x') }, address: me, confirmation: 'x' })).toBe(a)
    expect(canonical('sign:transaction', { address: me, transaction: { to: them, value: 2n } })).not.toBe(a)
    // A nested field named "confirmation" is part of what was confirmed.
    expect(canonical('sign:typed-data', { address: me, typedData: { confirmation: 1 } })).not.toBe(canonical('sign:typed-data', { address: me, typedData: {} }))
  })
})
