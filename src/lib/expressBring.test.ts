// Express Bring: setup once per chain (two Circle signatures), then the passcode only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Hex } from 'viem'

const OWNER = '0x0baf9b2c44f377208b3c5f833afbab8414d69d5d' as Hex
const ROUTER = '0x60EDB201D34C504ee2B2795B31112CB55E7d1B0C' as Hex
const KEY = '0x1111111111111111111111111111111111111111' as Hex
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex

let covers = true, approved = true
const counted: number[] = []
vi.mock('./fastPay', () => ({
  fastPayEnabled: () => true,
  expressCoversUsd: () => covers,
  expressApprove: async () => approved,
  expressCountUsd: (_o: string, usd: number) => { counted.push(usd) },
  expressLimitUsd: () => 100,
}))
const frame: string[] = []
vi.mock('@/wallet/frameClient', () => ({
  callWallet: async (m: string) => {
    frame.push(m)
    if (m === 'bring:key') return { address: KEY }
    if (m === 'bring:sign') return { signature: '0x' + 'ab'.repeat(65) }
    throw new Error('unexpected ' + m)
  },
}))
vi.mock('./supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))
vi.mock('./errorReport', () => ({ reportPerf: () => {} }))

let chainState: any
let bringResponse: { status: number; body: any } = { status: 200, body: { txHash: '0x' + 'cd'.repeat(32), mint: 'relayer' } }
const posts: any[] = []
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).includes('express_state')) return new Response(JSON.stringify(chainState), { status: 200 })
  const body = JSON.parse(String(init?.body))
  posts.push(body)
  if (body.action === 'express_setup') { chainState = { ...chainState, key: KEY, expiry: Math.floor(Date.now() / 1000) + 30 * 86400, allowance: '100000000' }; return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
  return new Response(JSON.stringify(bringResponse.body), { status: bringResponse.status })
}))
vi.useFakeTimers({ toFake: ['setTimeout'] })

const typed: any[] = []
const signer = { address: OWNER, signTypedData: async (td: any) => { typed.push(td); return '0x' + '11'.repeat(65) } } as any
const quote = { fee: 50_000n, maxFee: 1_200n, hookData: '0x' as Hex, usdcName: 'USDC', usdcVersion: '2' }
const { bringExpress } = await import('./expressBring')
const run = (amountUsdc = 10) => bringExpress({ chainId: 'Base_Sepolia', amountUsdc, signer, walletAddress: OWNER, usdc: USDC, chainNum: 84532, quote })

describe('Express Bring', () => {
  beforeEach(() => {
    covers = true; approved = true; counted.length = 0; frame.length = 0; posts.length = 0; typed.length = 0
    chainState = { router: ROUTER, key: '0x0000000000000000000000000000000000000000', expiry: 0, keyNonce: '0', allowance: '0', permitNonce: '3', chainId: 84532 }
    bringResponse = { status: 200, body: { txHash: '0x' + 'cd'.repeat(32), mint: 'relayer' } }
  })

  it('first time on a chain: two Circle signatures (USDC permit for the router, the Bring key), then the Bring', async () => {
    const r = await run()
    expect(typed.map(t => t.primaryType)).toEqual(['Permit', 'SetBringKey'])
    expect(typed[0].message).toMatchObject({ owner: OWNER, spender: ROUTER, value: 100_000_000n, nonce: 3n })
    expect(typed[1].domain).toMatchObject({ name: 'MeshPortRouter', chainId: 84532, verifyingContract: ROUTER })
    expect(typed[1].message).toMatchObject({ owner: OWNER, key: KEY, nonce: 0n })
    expect(posts.map(p => p.action)).toEqual(['express_setup', 'express_bring'])
    expect(posts[1].bring).toMatchObject({ owner: OWNER, token: USDC, amount: '9950000', fee: '50000', maxFee: '1200', hookData: '0x' })
    expect(frame).toContain('bring:sign')
    expect(r).toMatchObject({ txHash: '0x' + 'cd'.repeat(32), fee: 0.05, mint: 'relayer' })
    expect(counted).toEqual([10])
  })

  it('already set up: no Circle signature at all - the passcode and the Bring key', async () => {
    chainState = { ...chainState, key: KEY, expiry: Math.floor(Date.now() / 1000) + 10 * 86400, allowance: '100000000' }
    await run()
    expect(typed).toEqual([])
    expect(posts.map(p => p.action)).toEqual(['express_bring'])
  })

  it('the normal way (null) when: over the shared limit, no passcode, an older router, or the relayer refuses', async () => {
    covers = false
    expect(await run()).toBeNull(); expect(posts).toEqual([])
    covers = true
    chainState = { router: ROUTER, unsupported: true }
    expect(await run()).toBeNull()
    chainState = { router: ROUTER, key: KEY, expiry: Math.floor(Date.now() / 1000) + 10 * 86400, allowance: '100000000' }
    approved = false
    expect(await run()).toBeNull(); expect(frame).not.toContain('bring:sign')
    approved = true
    bringResponse = { status: 400, body: { error: 'Bring would fail' } }
    expect(await run()).toBeNull()
    expect(counted).toEqual([10, -10]) // counted, then given back
  })
})
