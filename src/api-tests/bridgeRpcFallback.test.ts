// /api/bridge-relay: every relay client used ONE RPC per chain (15 s timeout,
// no fallback) - a slow or dead node stalled quotes and failed submissions
// although another node for the chain worked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('bridge-relay RPC list', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

  it("override first, then the relay's primary, then the app registry's backups - no duplicates", async () => {
    vi.stubEnv('BRIDGE_RPC_ETHEREUM_SEPOLIA', 'https://my-node.example')
    const { rpcListFor } = await import('../../api/bridge-relay')
    expect(rpcListFor('Ethereum_Sepolia', 'https://ethereum-sepolia-rpc.publicnode.com')).toEqual([
      'https://my-node.example', 'https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org',
    ])
  })

  it('a chain with one known RPC keeps just that one', async () => {
    const { rpcListFor } = await import('../../api/bridge-relay')
    expect(rpcListFor('Monad_Testnet', 'https://testnet-rpc.monad.xyz')).toEqual(['https://testnet-rpc.monad.xyz'])
  })
})
