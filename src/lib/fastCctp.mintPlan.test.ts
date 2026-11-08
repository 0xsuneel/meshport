// Transfer: who mints on the destination, and MeshPort's fee when its relayer does.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/blockchain/chains', async (orig) => ({ ...(await orig() as any), circleForwarderMintsTo: (c: string) => !['Ethereum_Sepolia', 'Unichain_Sepolia'].includes(c) }))
let answer: any = null
vi.stubGlobal('fetch', vi.fn(async () => answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 500 })))

const { transferMintPlan, routerFee } = await import('./fastCctp')

describe('transferMintPlan', () => {
  beforeEach(() => { answer = null })
  it("the relayer when it's cheaper: no forwarder, its destination gas charged", async () => {
    answer = { relayer: true, destGas: '4200', forwardFee: '20000' }
    expect(await transferMintPlan('Base_Sepolia')).toEqual({ forward: false, destMintGas: 4200n })
  })
  it("Circle's forwarder when the relayer isn't cheaper: nothing extra charged", async () => {
    answer = { relayer: false, destGas: '90000', forwardFee: '20000' }
    expect(await transferMintPlan('Arbitrum_Sepolia')).toEqual({ forward: true, destMintGas: 0n })
  })
  it("a chain Circle's forwarder can't serve still gets the relayer, with its gas charged", async () => {
    answer = { relayer: false, destGas: '70000' }
    expect(await transferMintPlan('Ethereum_Sepolia')).toEqual({ forward: false, destMintGas: 70000n })
  })
  it("relayer out of gas: Circle's forwarder, even where it is usually skipped", async () => {
    answer = { relayer: false, relayerUnavailable: true, destGas: '70000' }
    expect(await transferMintPlan('Unichain_Sepolia')).toEqual({ forward: true, destMintGas: 0n })
  })
  it('no answer from the relayer: the app default, nothing extra', async () => {
    expect(await transferMintPlan('Optimism_Sepolia')).toEqual({ forward: true, destMintGas: 0n })
  })
})

describe('routerFee', () => {
  it("includes the destination mint gas in the floor (never below gas x 1.15)", () => {
    const amount = 10_000_000n // $10: 0.2% = $0.02, min $0.05
    expect(routerFee(0n, amount)).toBe(50_000n)
    // $1 of destination gas (an Ethereum mainnet mint): the fee covers it.
    expect(routerFee(0n, amount, 1_000_000n)).toBeGreaterThanOrEqual(1_150_000n)
  })
})
