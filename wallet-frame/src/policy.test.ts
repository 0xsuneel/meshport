// What a spend limit counts, read by the wallet itself (policy.ts).
import { describe, it, expect } from 'vitest'
import { encodeFunctionData, erc20Abi, maxUint256, pad, parseAbi } from 'viem'
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
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [them, 5_000_000n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ chainId: 11155111, to: SEPOLIA_USDC, data: approve }) }))).toEqual({ USDC: 5n * 10n ** 18n })
    // Someone else's tokens moved by transferFrom cost this wallet nothing.
    const pull = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [them, me, 9n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ to: ARC_USDC, data: pull }) }))).toEqual({ USDC: 0n })
  })

  // A Unified Balance transfer / Bring: approve Gateway, deposit to your own
  // balance, then a burn intent spends it. Only the burn intent leaves.
  it('a deposit to your own Gateway balance is not counted - the burn intent that spends it is', () => {
    const gw = parseAbi(['function deposit(address token, uint256 value)', 'function depositFor(address token, address depositor, uint256 value)', 'function addDelegate(address token, address delegate)'])
    const on = (data: `0x${string}`, to = GATEWAY) => classify(me, 'sign:transaction', { transaction: tx({ chainId: 11155111, to, data }) })
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GATEWAY, 1_000_000n] })
    expect(spends(classify(me, 'sign:transaction', { transaction: tx({ chainId: 11155111, to: SEPOLIA_USDC, data: approve }) }))).toEqual({ USDC: 0n })
    expect(spends(on(encodeFunctionData({ abi: gw, functionName: 'deposit', args: [SEPOLIA_USDC, 1_000_000n] })))).toEqual({})
    expect(spends(on(encodeFunctionData({ abi: gw, functionName: 'depositFor', args: [SEPOLIA_USDC, me, 1_000_000n] })))).toEqual({})
    // Credited to someone else: it leaves.
    expect(spends(on(encodeFunctionData({ abi: gw, functionName: 'depositFor', args: [SEPOLIA_USDC, them, 1_000_000n] })))).toEqual({ USDC: 10n ** 18n })
    // Anyone else allowed to spend the balance: confirmed on its own.
    expect(on(encodeFunctionData({ abi: gw, functionName: 'addDelegate', args: [SEPOLIA_USDC, them] })).ok).toBe(false)
    // So a 1 USDC limit covers the whole route: approve + deposit + the burn intent.
    const scope = parseScope({ limits: [{ asset: 'USDC', amount: '1.5' }] })
    let left = { ...scope.limits }
    for (const c of [classify(me, 'sign:transaction', { transaction: tx({ chainId: 11155111, to: SEPOLIA_USDC, data: approve }) }), on(encodeFunctionData({ abi: gw, functionName: 'deposit', args: [SEPOLIA_USDC, 1_000_000n] }))]) {
      const next = c.ok ? fits(scope, left, c) : null
      expect(next).not.toBeNull(); left = next!
    }
    const burn = classify(me, 'sign:typed-data', { typedData: { primaryType: 'BurnIntent', domain: { name: 'GatewayWallet' }, message: { maxBlockHeight: '1', maxFee: '50000', spec: { sourceToken: pad(SEPOLIA_USDC.toLowerCase() as `0x${string}`), value: '1000000' } } } })
    expect(burn.ok && fits(scope, left, burn)).not.toBeNull()
  })

  // Circle's kit on Arc: a permit to Gateway + depositWithPermit, then the
  // burn intent. Field 11 Nov: asked for the passcode three times.
  it('a permit-based deposit to your own Gateway balance needs no extra passcode', () => {
    const gw = parseAbi([
      'function depositWithPermit(address token, address owner, uint256 value, uint256 deadline, bytes signature)',
      'function depositWithPermit(address token, address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
      'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
    ])
    const sig = ('0x' + '11'.repeat(65)) as `0x${string}`
    const permitTo = (spender: string, value = '1000000') => ({ primaryType: 'Permit', domain: { verifyingContract: ARC_USDC }, message: { owner: me, spender, value, nonce: '0', deadline: '9999999999' } })
    expect(spends(classify(me, 'sign:typed-data', { typedData: permitTo(GATEWAY) }))).toEqual({})
    expect(spends(classify(me, 'sign:typed-data', { typedData: permitTo(them) }))).toEqual({ USDC: 10n ** 18n })
    expect(spends(classify(me, 'sign:typed-data', { typedData: permitTo(GATEWAY, maxUint256.toString()) }))).not.toEqual({})
    const call = (data: `0x${string}`) => classify(me, 'sign:transaction', { transaction: tx({ to: GATEWAY, data }) })
    expect(spends(call(encodeFunctionData({ abi: gw, functionName: 'depositWithPermit', args: [ARC_USDC, me, 1_000_000n, 9_999_999_999n, sig] })))).toEqual({})
    expect(spends(call(encodeFunctionData({ abi: gw, functionName: 'depositWithPermit', args: [ARC_USDC, me, 1_000_000n, 9_999_999_999n, 27, pad('0x01'), pad('0x02')] })))).toEqual({})
    expect(spends(call(encodeFunctionData({ abi: gw, functionName: 'depositWithAuthorization', args: [ARC_USDC, me, 1_000_000n, 0n, 9_999_999_999n, pad('0x03'), sig] })))).toEqual({})
    expect(spends(call(encodeFunctionData({ abi: gw, functionName: 'depositWithPermit', args: [ARC_USDC, them, 1_000_000n, 9_999_999_999n, sig] })))).toEqual({ USDC: 10n ** 18n })
    // The whole route fits a limit of the amount + its fee: permit, deposit, burn intent.
    const scope = parseScope({ limits: [{ asset: 'USDC', amount: '1.1' }] })
    let left = { ...scope.limits }
    const burn = classify(me, 'sign:typed-data', { typedData: { primaryType: 'BurnIntent', domain: { name: 'GatewayWallet' }, message: { maxBlockHeight: '1', maxFee: '50000', spec: { sourceToken: pad(ARC_USDC.toLowerCase() as `0x${string}`), value: '1000000' } } } })
    for (const c of [classify(me, 'sign:typed-data', { typedData: permitTo(GATEWAY) }), call(encodeFunctionData({ abi: gw, functionName: 'depositWithPermit', args: [ARC_USDC, me, 1_000_000n, 9_999_999_999n, sig] })), burn]) {
      const next = c.ok ? fits(scope, left, c) : null
      expect(next).not.toBeNull(); left = next!
    }
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

  // Arc -> Solana over CCTP (13 Nov): kit.bridge() approves Circle's Bridge Kit
  // contract and then calls it to burn. Both fit the one spend limit the person
  // approved - no second passcode mid-burn - while an unknown contract still asks.
  it("Circle's Bridge Kit contract fits a spend limit; an unknown contract doesn't", () => {
    const KIT = '0xC5567a5E3370d4DBfB0540025078e283e36A363d'
    const scope = parseScope({ limits: [{ asset: 'USDC', amount: '1.2' }] })
    let left = { ...scope.limits }
    const approve = classify(me, 'sign:transaction', { transaction: tx({ to: ARC_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KIT, 1_100_000n] }) }) })
    const afterApprove = approve.ok ? fits(scope, left, approve) : null
    expect(afterApprove).not.toBeNull()
    left = afterApprove!
    // The burn call itself (its own selector, no value): moves USDC only through the counted approval.
    const burn = classify(me, 'sign:transaction', { transaction: tx({ to: KIT, data: '0x12345678' + '00'.repeat(64) }) })
    expect(burn.ok && fits(scope, left, burn)).not.toBeNull()
    const unknown = classify(me, 'sign:transaction', { transaction: tx({ to: them, data: '0x12345678' + '00'.repeat(64) }) })
    expect(unknown.ok ? fits(scope, left, unknown) : null).toBeNull()
  })
})

describe('MeshPort rewards claim', () => {
  const REWARDS = '0x8921FaE7322305011AFF1C7409472F5C74EAAF15'
  const claim = encodeFunctionData({
    abi: parseAbi(['function claimRewards(uint256 points, bytes32 claimId, bytes signature) returns (uint256)']),
    functionName: 'claimRewards', args: [100n, pad('0xbb4a', { size: 32 }), '0x1234'],
  })
  it('reads as "Claim rewards · 100 points" from MeshPort Rewards - no unknown-contract warning', () => {
    const v = describeRequest('sign:transaction', { transaction: tx({ to: REWARDS, data: claim }) })
    expect(v).toMatchObject({ action: 'Claim rewards', amount: '100', token: 'points' })
    expect(v.to).toContain('MeshPort Rewards')
    expect(v.warnings).toEqual([])
  })
  it('any other contract still warns', () => {
    const v = describeRequest('sign:transaction', { transaction: tx({ to: '0x1111111111111111111111111111111111111111', data: claim }) })
    expect(v.warnings.join(' ')).toMatch(/does not recognise/)
  })
  it('naming it never lets a spend limit cover it', () => {
    const me = '0x2222222222222222222222222222222222222222'
    const c = classify(me, 'sign:transaction', { transaction: tx({ to: REWARDS, data: claim }) })
    const scope = parseScope({ limits: [{ asset: 'USDC', amount: '5' }] })
    expect(c.ok ? fits(scope, { ...scope.limits }, c) : null).toBeNull()
  })
})
