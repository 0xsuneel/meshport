// When Circle's forwarder fails a mint on a chain, later transfers to that
// chain skip it (and go to MeshPort's relayer) for 24 hours, then try Circle
// again. Unit tests run in node, so localStorage is a small in-memory stub.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {}, authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))

const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

import {
  circleForwarderMintsTo, forwarderMintFailing, noteForwarderMintFailed, FORWARDER_FAILURE_MEMORY_MS,
} from '@/blockchain/chains'
import { gatewaySelfMintsTo } from './ubClaim'

describe('learned forwarder failures', () => {
  beforeEach(() => store.clear())

  it('a chain whose forwarder just failed is minted by MeshPort, for both CCTP and Unified Balance', () => {
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(true)
    expect(gatewaySelfMintsTo('Base_Sepolia')).toBe(false)
    noteForwarderMintFailed('Base_Sepolia')
    expect(forwarderMintFailing('Base_Sepolia')).toBe(true)
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(false)
    expect(gatewaySelfMintsTo('Base_Sepolia')).toBe(true)
    // Other chains are untouched.
    expect(circleForwarderMintsTo('Arbitrum_Sepolia')).toBe(true)
  })

  it('Circle’s forwarder is tried again once the memory runs out', () => {
    const t = Date.parse('2026-10-08T00:00:00Z')
    noteForwarderMintFailed('Optimism_Sepolia', t)
    expect(forwarderMintFailing('Optimism_Sepolia', t + FORWARDER_FAILURE_MEMORY_MS - 1)).toBe(true)
    expect(forwarderMintFailing('Optimism_Sepolia', t + FORWARDER_FAILURE_MEMORY_MS + 1)).toBe(false)
  })

  it('ignores chains Circle’s forwarder doesn’t serve, and keeps the listed ones', () => {
    noteForwarderMintFailed('Morph_Testnet')
    expect(forwarderMintFailing('Morph_Testnet')).toBe(false)
    expect(forwarderMintFailing('Ethereum_Sepolia')).toBe(true) // listed in FORWARDER_MINT_FAILING_SDK_CHAINS
    expect(gatewaySelfMintsTo('Sei_Testnet')).toBe(true)
  })

  it('a broken stored value never breaks routing', () => {
    store.set('meshport_forwarder_mint_failing_v1', '{not json')
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(true)
    noteForwarderMintFailed('Base_Sepolia')
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(false)
  })
})

describe('finishCctpMintViaRelayer remembers the failure', () => {
  beforeEach(() => store.clear())

  it('Iris says forwarding FAILED → the destination is remembered while the relayer finishes it', async () => {
    const { finishCctpMintViaRelayer } = await import('./cctpRecovery')
    const iris = (m: any) => new Response(JSON.stringify({ messages: [m] }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/v2/messages/26')) return iris({ status: 'complete', message: '0x' + '00'.repeat(40), attestation: '0x' + '9e'.repeat(65), forwardState: 'FAILED' })
      if (url === '/api/bridge-relay') return new Response(JSON.stringify({ txHash: '0xmint' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const out = await finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: 'Base_Sepolia', burnTxHash: '0x' + 'e1'.repeat(32), timeoutMs: 1000 })
    expect(out).toEqual({ mintTxHash: '0xmint' })
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(false)
    vi.unstubAllGlobals()
  })
})
