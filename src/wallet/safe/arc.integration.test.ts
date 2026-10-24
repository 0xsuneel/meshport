import { describe, it, expect } from 'vitest'
import { createPublicClient, http } from 'viem'
import { p256 } from '@noble/curves/p256'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  createSafeCalldata, meshportSafeConfig, passkeySignerAddress, predictSafeAddress, proxyCreationCode, type ChainReader,
} from './account'

// Read-only checks against the real Safe deployments on Arc testnet.
// Opt-in (network): ARC_RPC=https://rpc.testnet.arc.io npx vitest run src/wallet/safe/arc.integration.test.ts
// Uses eth_call only - simulates, never sends a transaction, deploys nothing.
const RPC = process.env.ARC_RPC
const maybe = RPC ? describe : describe.skip

maybe('MeshPort Safe on Arc testnet (read-only simulation)', () => {
  const client = createPublicClient({ transport: http(RPC) })

  it('predicted Safe address = the address Safe\'s factory would create', async () => {
    // A throwaway passkey public key and wallet key - never funded, never used.
    const pub = p256.getPublicKey(p256.utils.randomPrivateKey(), false)
    const x = BigInt('0x' + Buffer.from(pub.slice(1, 33)).toString('hex'))
    const y = BigInt('0x' + Buffer.from(pub.slice(33, 65)).toString('hex'))
    const passkeyOwner = await passkeySignerAddress(client as unknown as ChainReader, { x, y })
    const walletKey = privateKeyToAccount(generatePrivateKey()).address
    const cfg = meshportSafeConfig(passkeyOwner, walletKey)

    const predicted = predictSafeAddress(cfg, await proxyCreationCode(client as unknown as ChainReader))
    const { to, data } = createSafeCalldata(cfg)
    const sim = await client.call({ to, data })
    const simulated = ('0x' + (sim.data ?? '').slice(-40)) as `0x${string}`

    expect(passkeyOwner).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(simulated.toLowerCase()).toBe(predicted.toLowerCase())
    // Nothing exists there yet - this was only a simulation.
    expect(await client.getCode({ address: predicted })).toBeUndefined()
  }, 30_000)

  it('the passkey signer factory answers for the Arc verifier config', async () => {
    const sameKey = { x: 1n, y: 2n }
    const a = await passkeySignerAddress(client as unknown as ChainReader, sameKey)
    const b = await passkeySignerAddress(client as unknown as ChainReader, sameKey)
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
  }, 30_000)
})
