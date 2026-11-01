import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { encodeFunctionData, keccak256 } from 'viem'

// The destination step of a relayer-delivered Unified Balance transfer: Circle's
// kit signs a gatewayMint with a throwaway in-memory key (MultichainTransferPage
// mintAdapter); the relayed provider must hand only target + data to the relayer,
// and answer the kit's own hash with the relayer's receipt.
const RELAYER_TX = '0x' + 'cd'.repeat(32)
vi.mock('./supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))
vi.mock('ethers', async () => {
  const real: any = await vi.importActual('ethers')
  class FakeRpc {
    _send = async (payload: any) => {
      const list = Array.isArray(payload) ? payload : [payload]
      return list.map((r: any) => r.method === 'eth_getTransactionReceipt' && r.params[0] === RELAYER_TX
        ? { id: r.id, jsonrpc: '2.0', result: { transactionHash: RELAYER_TX, status: '0x1', blockNumber: '0x10', logs: [] } }
        : { id: r.id, jsonrpc: '2.0', result: null })
    }
  }
  return { ...real, JsonRpcProvider: FakeRpc }
})

describe('relayer-delivered mint signed by a throwaway key', () => {
  it('relays only the call, and the kit sees the relayer receipt under its own hash', async () => {
    const sent: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ txHash: RELAYER_TX }), { status: 200 })
    }))
    const { relayedProviderFor } = await import('./relayedProvider')
    const provider = await relayedProviderFor({ name: 'Ethereum Sepolia', chainId: 11155111, rpcEndpoints: ['https://eth.example'] })

    const throwaway = privateKeyToAccount(generatePrivateKey())
    const data = encodeFunctionData({
      abi: [{ type: 'function', name: 'gatewayMint', inputs: [{ type: 'bytes' }, { type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'gatewayMint', args: ['0x1234', '0x5678'],
    })
    const raw = await throwaway.signTransaction({ chainId: 11155111, type: 'eip1559', to: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B', data, nonce: 0, gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    const kitHash = keccak256(raw)

    const [sendRes] = await provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
    expect(sendRes.result).toBe(kitHash)
    expect(sent).toEqual([{ action: 'call', chain: 'Ethereum_Sepolia', to: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B', data }])
    expect(JSON.stringify(sent)).not.toContain(throwaway.address.slice(2).toLowerCase()) // the signer never leaves

    const [rcpt] = await provider._send({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [kitHash] })
    expect(rcpt.result).toMatchObject({ transactionHash: kitHash, status: '0x1' })
  })
})
