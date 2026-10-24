import { describe, it, expect } from 'vitest'
import { createPublicClient, http, keccak256, toBytes } from 'viem'
import { p256 } from '@noble/curves/p256'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  createSafeCalldata, meshportSafeConfig, passkeySignerAddress, passkeyVerifiers, predictSafeAddress, proxyCreationCode, type ChainReader,
} from './account'
import { SAFE } from './addresses'
import { fakeAuthenticator } from './fakeAuthenticator'
import { encodePasskeySignature, p256FromSpki } from './passkeySignature'

// Read-only checks against the real Safe deployments on Arc testnet.
// Opt-in (network): ARC_RPC=https://rpc.testnet.arc.io npx vitest run src/wallet/safe/arc.integration.test.ts
// Uses eth_call only - simulates, never sends a transaction, deploys nothing.
const RPC = process.env.ARC_RPC
const maybe = RPC ? describe : describe.skip

maybe('MeshPort Safe on Arc testnet (read-only simulation)', () => {
  // Built on first use: describe.skip still collects this block when ARC_RPC is unset.
  let cached: ReturnType<typeof createPublicClient> | undefined
  const arc = () => (cached ??= createPublicClient({ transport: http(RPC) }))

  it('predicted Safe address = the address Safe\'s factory would create', async () => {
    // A throwaway passkey public key and wallet key - never funded, never used.
    const pub = p256.getPublicKey(p256.utils.randomPrivateKey(), false)
    const x = BigInt('0x' + Buffer.from(pub.slice(1, 33)).toString('hex'))
    const y = BigInt('0x' + Buffer.from(pub.slice(33, 65)).toString('hex'))
    const passkeyOwner = await passkeySignerAddress(arc() as unknown as ChainReader, { x, y })
    const walletKey = privateKeyToAccount(generatePrivateKey()).address
    const cfg = meshportSafeConfig(passkeyOwner, walletKey)

    const predicted = predictSafeAddress(cfg, await proxyCreationCode(arc() as unknown as ChainReader))
    const { to, data } = createSafeCalldata(cfg)
    const sim = await arc().call({ to, data })
    const simulated = ('0x' + (sim.data ?? '').slice(-40)) as `0x${string}`

    expect(passkeyOwner).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(simulated.toLowerCase()).toBe(predicted.toLowerCase())
    // Nothing exists there yet - this was only a simulation.
    expect(await arc().getCode({ address: predicted })).toBeUndefined()
  }, 30_000)

  it('a passkey signature encoded by MeshPort verifies in Safe\'s signer on Arc\'s P-256 precompile', async () => {
    const auth = fakeAuthenticator()
    const { x, y } = p256FromSpki(auth.spki)
    const challenge = keccak256(toBytes(`meshport ${Date.now()}`))
    const signature = encodePasskeySignature(auth.sign(challenge), challenge)
    const factoryAbi = [{
      type: 'function', name: 'isValidSignatureForSigner', stateMutability: 'view',
      inputs: [{ name: 'message', type: 'bytes32' }, { name: 'signature', type: 'bytes' }, { name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }, { name: 'verifiers', type: 'uint176' }],
      outputs: [{ name: 'magicValue', type: 'bytes4' }],
    }] as const
    const check = (sig: `0x${string}`, msg = challenge) => (arc() as unknown as ChainReader).readContract({
      address: SAFE.webAuthnSignerFactory, abi: factoryAbi, functionName: 'isValidSignatureForSigner',
      args: [msg, sig, x, y, passkeyVerifiers()],
    })
    expect(await check(signature)).toBe('0x1626ba7e')                               // ERC-1271 magic: valid
    expect(await check(signature, keccak256(toBytes('another op')))).not.toBe('0x1626ba7e') // wrong message: rejected
  }, 30_000)

  it('the passkey signer factory answers for the Arc verifier config', async () => {
    const sameKey = { x: 1n, y: 2n }
    const a = await passkeySignerAddress(arc() as unknown as ChainReader, sameKey)
    const b = await passkeySignerAddress(arc() as unknown as ChainReader, sameKey)
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
  }, 30_000)
})
