import { describe, it, expect } from 'vitest'
import { createPublicClient, encodeFunctionData, hashDomain, http, maxUint256, parseSignature, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  ARC_USDC_ERC20, PERMIT2, permit2Abi, permit2Domain, permitSingleTypes, usdcAbi, usdcPermitDomain, usdcPermitTypes,
  permitBatchTypes, tokenPermitDomain, FAST_TOKENS, ARC_EURC, ARC_CIRBTC,
} from './fastPay'

// Read-only checks against Arc testnet: the typed data Fast Pay asks the Circle
// wallet to sign is accepted by the real USDC and Permit2 contracts. Signed by
// throwaway keys, run with eth_call only - nothing is sent.
// Opt-in (network): ARC_RPC=https://rpc.testnet.arc.io npx vitest run src/lib/fastPay.arc.integration.test.ts
const RPC = process.env.ARC_RPC
const maybe = RPC ? describe : describe.skip

maybe('Fast Pay typed data on Arc testnet (read-only simulation)', () => {
  let cached: ReturnType<typeof createPublicClient> | undefined
  const arc = () => (cached ??= createPublicClient({ transport: http(RPC) }))
  const domainTypes = (d: Record<string, unknown>) => ({ EIP712Domain: Object.keys(d).map(k => ({
    name: k, type: k === 'chainId' ? 'uint256' : k === 'verifyingContract' ? 'address' : 'string',
  })) })

  it('both EIP-712 domains hash to the contracts\' own DOMAIN_SEPARATOR', async () => {
    const abi = [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }] as const
    const usdcOnChain = await (arc() as any).readContract({ address: ARC_USDC_ERC20, abi, functionName: "DOMAIN_SEPARATOR" })
    const p2OnChain = await (arc() as any).readContract({ address: PERMIT2, abi, functionName: "DOMAIN_SEPARATOR" })
    expect(hashDomain({ domain: usdcPermitDomain, types: domainTypes(usdcPermitDomain) as any })).toBe(usdcOnChain)
    expect(hashDomain({ domain: permit2Domain, types: domainTypes(permit2Domain) as any })).toBe(p2OnChain)
  }, 30_000)

  it('a USDC EIP-2612 permit for Permit2, signed like the Circle wallet will, is accepted by Arc USDC', async () => {
    const owner = privateKeyToAccount(generatePrivateKey())
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800)
    const sig = await owner.signTypedData({ domain: usdcPermitDomain, types: usdcPermitTypes, primaryType: 'Permit',
      message: { owner: owner.address, spender: PERMIT2, value: maxUint256, nonce: 0n, deadline } })
    const { v, yParity, r, s } = parseSignature(sig)
    const data = encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
      args: [owner.address, PERMIT2, maxUint256, deadline, Number(v ?? BigInt(yParity + 27)), r, s] })
    await expect(arc().call({ to: ARC_USDC_ERC20, data })).resolves.toBeDefined()
    // A wrong signer is refused - the check is real.
    const other = privateKeyToAccount(generatePrivateKey())
    const bad = encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
      args: [other.address, PERMIT2, maxUint256, deadline, Number(v ?? BigInt(yParity + 27)), r, s] })
    await expect(arc().call({ to: ARC_USDC_ERC20, data: bad })).rejects.toThrow()
  }, 30_000)

  it('a Permit2 PermitSingle session grant (amount + expiry) is accepted by Arc\'s Permit2', async () => {
    const owner = privateKeyToAccount(generatePrivateKey())
    const sessionKey = privateKeyToAccount(generatePrivateKey())
    const now = Math.floor(Date.now() / 1000)
    const permitSingle = {
      details: { token: ARC_USDC_ERC20, amount: 100_000_000n, expiration: now + 7200, nonce: 0 },
      spender: sessionKey.address, sigDeadline: BigInt(now + 1800),
    }
    const sig = await owner.signTypedData({ domain: permit2Domain, types: permitSingleTypes, primaryType: 'PermitSingle', message: permitSingle })
    const data = encodeFunctionData({ abi: permit2Abi, functionName: 'permit', args: [owner.address, permitSingle, sig as Hex] })
    await expect(arc().call({ account: sessionKey.address, to: PERMIT2, data })).resolves.toBeDefined()
    // Signed by someone else: Permit2 refuses (InvalidSigner).
    const bad = encodeFunctionData({ abi: permit2Abi, functionName: 'permit',
      args: [privateKeyToAccount(generatePrivateKey()).address, permitSingle, sig as Hex] })
    await expect(arc().call({ account: sessionKey.address, to: PERMIT2, data: bad })).rejects.toThrow()
  }, 30_000)

  it('EURC and cirBTC: their permit domains hash to the contracts\' own DOMAIN_SEPARATOR, and their permits are accepted', async () => {
    const abi = [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }] as const
    for (const t of ['EURC', 'cirBTC'] as const) {
      const d = tokenPermitDomain(t)
      const onChain = await (arc() as any).readContract({ address: FAST_TOKENS[t].address, abi, functionName: 'DOMAIN_SEPARATOR' })
      expect(hashDomain({ domain: d, types: domainTypes(d) as any })).toBe(onChain)
      const owner = privateKeyToAccount(generatePrivateKey())
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800)
      const sig = await owner.signTypedData({ domain: d, types: usdcPermitTypes, primaryType: 'Permit',
        message: { owner: owner.address, spender: PERMIT2, value: maxUint256, nonce: 0n, deadline } })
      const { v, yParity, r, s } = parseSignature(sig)
      const data = encodeFunctionData({ abi: usdcAbi, functionName: 'permit',
        args: [owner.address, PERMIT2, maxUint256, deadline, Number(v ?? BigInt(yParity + 27)), r, s] })
      await expect(arc().call({ to: FAST_TOKENS[t].address, data })).resolves.toBeDefined()
    }
  }, 30_000)

  it('one Permit2 PermitBatch grant for USDC + EURC + cirBTC is accepted by Arc\'s Permit2', async () => {
    const owner = privateKeyToAccount(generatePrivateKey())
    const sessionKey = privateKeyToAccount(generatePrivateKey())
    const now = Math.floor(Date.now() / 1000)
    const permitBatch = {
      details: [
        { token: ARC_USDC_ERC20, amount: 100_000_000n, expiration: now + 7200, nonce: 0 },
        { token: ARC_EURC, amount: 92_000_000n, expiration: now + 7200, nonce: 0 },
        { token: ARC_CIRBTC, amount: 100_000n, expiration: now + 7200, nonce: 0 },
      ],
      spender: sessionKey.address, sigDeadline: BigInt(now + 1800),
    }
    const sig = await owner.signTypedData({ domain: permit2Domain, types: permitBatchTypes, primaryType: 'PermitBatch', message: permitBatch })
    const data = encodeFunctionData({ abi: permit2Abi, functionName: 'permit', args: [owner.address, permitBatch, sig as Hex] })
    await expect(arc().call({ account: sessionKey.address, to: PERMIT2, data })).resolves.toBeDefined()
    const bad = encodeFunctionData({ abi: permit2Abi, functionName: 'permit',
      args: [privateKeyToAccount(generatePrivateKey()).address, permitBatch, sig as Hex] })
    await expect(arc().call({ account: sessionKey.address, to: PERMIT2, data: bad })).rejects.toThrow()
  }, 30_000)

  it('Permit2.lockdown (turning Fast Pay off) is accepted from the wallet itself', async () => {
    const owner = privateKeyToAccount(generatePrivateKey())
    const sessionKey = privateKeyToAccount(generatePrivateKey())
    const data = encodeFunctionData({ abi: permit2Abi, functionName: 'lockdown', args: [[
      { token: ARC_USDC_ERC20, spender: sessionKey.address }, { token: ARC_EURC, spender: sessionKey.address },
    ]] })
    expect(data.slice(0, 10)).toBe('0xcc53287f')
    await expect(arc().call({ account: owner.address, to: PERMIT2, data })).resolves.toBeDefined()
  }, 30_000)
})
