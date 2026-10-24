import { describe, it, expect, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// The app-side signer must produce exactly what signing with the key itself
// would - for viem callers and, through the ethers bridge, for Circle's
// EthersAdapter. The frame is stood in for by a handler that signs with a
// real key, as wallet-frame/src/main.ts does.
const pk = generatePrivateKey()
const keyAccount = privateKeyToAccount(pk)
const seen: Array<{ method: string; params: any }> = []

vi.mock('./frameClient', () => ({
  callWallet: async (method: string, params: any) => {
    seen.push({ method, params: structuredClone(params) }) // what postMessage would carry
    if (method === 'sign:message') return { signature: await keyAccount.signMessage({ message: params.message }) }
    if (method === 'sign:typed-data') return { signature: await keyAccount.signTypedData(params.typedData) }
    if (method === 'sign:transaction') return { serialized: await keyAccount.signTransaction(params.transaction) }
    throw new Error('unexpected ' + method)
  },
  WalletFrameError: class extends Error {},
  walletOrigin: () => 'http://localhost:5174',
}))

const { walletAccount, toEthersSigner, plainTransaction } = await import('./account')
const { Wallet, Transaction } = await import('ethers')

describe('wallet account (signs through the frame)', () => {
  const account = walletAccount(keyAccount.address)

  it('signs messages and raw bytes the same as the key would', async () => {
    expect(await account.signMessage({ message: 'MeshPort sign-in' })).toBe(await keyAccount.signMessage({ message: 'MeshPort sign-in' }))
    const raw = new Uint8Array(32).fill(7)
    expect(await account.signMessage({ message: { raw } })).toBe(await keyAccount.signMessage({ message: { raw } }))
  })

  it('posts only plain transaction fields (no account object or functions)', async () => {
    const tx: any = { type: 'eip1559', chainId: 5042002, nonce: 3, to: keyAccount.address, value: 5n, gas: 21000n,
      maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, account: keyAccount, chain: { formatters: { x: () => 1 } } }
    expect(Object.keys(plainTransaction(tx)).sort()).toEqual(['chainId', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'to', 'type', 'value'])
    expect(await account.signTransaction(tx)).toBe(await keyAccount.signTransaction(plainTransaction(tx) as any))
    expect(() => structuredClone(seen[seen.length - 1].params)).not.toThrow()
  })

  it('as an ethers Signer: signed transactions are byte-identical to ethers Wallet', async () => {
    const signer = await toEthersSigner(account)
    const wallet = new Wallet(pk)
    for (const tx of [
      { type: 2, chainId: 5042002, nonce: 7, to: '0x2222222222222222222222222222222222222222', value: 123n, gasLimit: 60000n, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, data: '0xa9059cbb' },
      { type: 0, chainId: 84532, nonce: 1, to: '0x3333333333333333333333333333333333333333', value: 0n, gasLimit: 21000n, gasPrice: 5n },
    ]) {
      const ours = await signer.signTransaction(tx)
      expect(ours).toBe(await wallet.signTransaction(tx))
      expect(Transaction.from(ours).from).toBe(keyAccount.address)
    }
    expect(await signer.getAddress()).toBe(keyAccount.address)
  })

  it('as an ethers Signer: messages and EIP-712 (e.g. USDC permit) match ethers Wallet', async () => {
    const signer = await toEthersSigner(account)
    const wallet = new Wallet(pk)
    expect(await signer.signMessage('hello')).toBe(await wallet.signMessage('hello'))
    const domain = { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' }
    const types = { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] }
    const value = { owner: keyAccount.address, spender: '0x4444444444444444444444444444444444444444', value: 1000000n, nonce: 0n, deadline: 9999999999n }
    expect(await signer.signTypedData(domain, types, value)).toBe(await wallet.signTypedData(domain, types, value))
  })

  it('refuses a transaction "from" another address', async () => {
    const signer = await toEthersSigner(account)
    await expect(signer.signTransaction({ from: '0x5555555555555555555555555555555555555555', chainId: 1, nonce: 0, gasLimit: 21000n, gasPrice: 1n }))
      .rejects.toThrow(/different address/)
  })
})
