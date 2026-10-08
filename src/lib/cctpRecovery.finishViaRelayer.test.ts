// Circle's forwarder stopped delivering mints on Ethereum Sepolia (its mint
// runs out of gas). These cover the routing away from it and the relayer
// finish that replaces it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {}, authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))

import { circleForwarderMintsTo, chainSupportsForwarder, FORWARDER_MINT_FAILING_SDK_CHAINS } from '@/blockchain/chains'
import { GATEWAY_SELF_MINT_CHAINS, forwarderMintRetry } from './ubClaim'
import { finishCctpMintViaRelayer } from './cctpRecovery'

const BURN = '0x' + 'e1'.repeat(32)
const MSG = '0x' + '00'.repeat(40)
const ATT = '0x' + '9e'.repeat(65)

describe('routing away from a failing forwarder', () => {
  it('Ethereum Sepolia is supported by Circle but minted by MeshPort', () => {
    expect(chainSupportsForwarder('Ethereum_Sepolia')).toBe(true)
    expect(circleForwarderMintsTo('Ethereum_Sepolia')).toBe(false)
    expect(GATEWAY_SELF_MINT_CHAINS.has('Ethereum_Sepolia')).toBe(true)
  })
  it('other forwarder chains still use Circle’s forwarder', () => {
    expect(circleForwarderMintsTo('Base_Sepolia')).toBe(true)
    expect(circleForwarderMintsTo('Arbitrum_Sepolia')).toBe(true)
    expect(GATEWAY_SELF_MINT_CHAINS.has('Base_Sepolia')).toBe(false)
    for (const c of FORWARDER_MINT_FAILING_SDK_CHAINS) expect(GATEWAY_SELF_MINT_CHAINS.has(c)).toBe(true)
  })
  it('a forwarder ON_CHAIN_FAILURE with an attestation can be resumed even when not flagged RESUMABLE', () => {
    const err = { message: 'Forwarder transfer failed: ON_CHAIN_FAILURE', cause: { trace: { attestation: '0xa', signature: '0xs' } } }
    expect(forwarderMintRetry(err)).toEqual({ attestation: '0xa', signature: '0xs' })
    expect(forwarderMintRetry({ message: 'Forwarder transfer failed: ON_CHAIN_FAILURE' })).toBeNull()
  })
})

describe('finishCctpMintViaRelayer', () => {
  let calls: Array<{ url: string; body?: any }>
  const iris = (m: any) => new Response(JSON.stringify({ messages: [m] }), { status: 200 })
  beforeEach(() => { calls = [] })

  it('forwarding failed + attested → relayer submits receiveMessage on the destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      if (url.includes('/v2/messages/26')) return iris({ status: 'complete', message: MSG, attestation: ATT, forwardState: 'FAILED' })
      if (url === '/api/bridge-relay') return new Response(JSON.stringify({ txHash: '0xmint' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const out = await finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: 'Ethereum_Sepolia', burnTxHash: BURN, timeoutMs: 1000 })
    expect(out).toEqual({ mintTxHash: '0xmint' })
    const relay = calls.find(c => c.url === '/api/bridge-relay')!
    expect(relay.body.action).toBe('call')
    expect(relay.body.chain).toBe('Ethereum_Sepolia')
    expect(relay.body.to).toBe('0xe737e5cebeeba77efe34d4aa090756590b1ce275')
    expect(relay.body.data.startsWith('0x57ecfd28')).toBe(true) // receiveMessage(bytes,bytes)
  })

  it('already delivered by Circle → returns its mint, sends nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url })
      return iris({ status: 'complete', message: MSG, attestation: ATT, forwardState: 'COMPLETE', forwardTxHash: '0xcircle' })
    }))
    expect(await finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: 'Ethereum_Sepolia', burnTxHash: BURN, timeoutMs: 1000 }))
      .toEqual({ mintTxHash: '0xcircle' })
    expect(calls.some(c => c.url === '/api/bridge-relay')).toBe(false)
  })

  it('not attested yet within the wait → null (nothing sent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push({ url }); return iris({ status: 'pending_confirmations', attestation: 'PENDING' }) }))
    expect(await finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: 'Ethereum_Sepolia', burnTxHash: BURN, timeoutMs: 1 })).toBeNull()
    expect(calls.some(c => c.url === '/api/bridge-relay')).toBe(false)
  })

  it('relayer refuses but Circle meanwhile delivered → returns Circle’s mint', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/bridge-relay') return new Response(JSON.stringify({ error: 'Call would fail' }), { status: 400 })
      n++
      return n === 1
        ? iris({ status: 'complete', message: MSG, attestation: ATT, forwardState: 'FAILED' })
        : iris({ status: 'complete', message: MSG, attestation: ATT, forwardState: 'COMPLETE', forwardTxHash: '0xlate' })
    }))
    expect(await finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: 'Ethereum_Sepolia', burnTxHash: BURN, timeoutMs: 1000 }))
      .toEqual({ mintTxHash: '0xlate' })
  })
})
