import { describe, it, expect, vi, beforeEach } from 'vitest'

const W = '0x4cb2ff6492d51edfb54f0cff3b517d7f207d80a1'
const wallet = { balance: 10, _currentAddr: W, setBalance: vi.fn((v: number) => { wallet.balance = v }) }
vi.mock('@/store', () => ({ useWalletStore: { getState: () => wallet } }))
vi.mock('@/blockchain/BlockchainManager', () => ({ refreshScope: () => {} }))
let chainUsdc = 10 // a node a block behind still says 10
vi.mock('@/lib/arcService', () => ({ readUSDCBalanceOrThrow: async () => chainUsdc }))
const slot: Record<string, unknown> = {}
vi.mock('./assetSlot', () => ({ saveAssetSlot: (_a: string, p: object) => Object.assign(slot, p) }))

import { refreshBalancesAfterTx, pendingTxBalance, isLaggingRead } from './balanceRefresh'

describe('balances after a swap', () => {
  beforeEach(() => { wallet.balance = 10; wallet.setBalance.mockClear(); chainUsdc = 10 })

  it('shows the new amounts at once: USDC in the store, EURC in the saved slot', () => {
    refreshBalancesAfterTx(W, { balances: { USDC: { before: 10, after: 7 }, EURC: { before: 1, after: 3.6 } } })
    expect(wallet.balance).toBe(7)
    expect(slot.eurc).toBe(3.6)
    expect(pendingTxBalance(W, 'EURC')).toEqual({ before: 1, after: 3.6 })
  })

  it('a read still showing the amount before the swap is a lagging node', () => {
    refreshBalancesAfterTx(W, { balances: { EURC: { before: 1, after: 3.6 } } })
    expect(isLaggingRead(W, 'EURC', 1)).toBe(true)      // old figure: ignored
    expect(isLaggingRead(W, 'EURC', 3.59)).toBe(false)  // the chain moved: shown
    expect(isLaggingRead(W, 'CIRBTC', 0)).toBe(false)   // not part of this swap
    expect(isLaggingRead('0x0000000000000000000000000000000000000001', 'EURC', 1)).toBe(false)
  })

  it("a lagging USDC read doesn't put the old amount back", async () => {
    refreshBalancesAfterTx(W, { balances: { USDC: { before: 10, after: 7 } } })
    await new Promise(r => setTimeout(r, 10))
    expect(wallet.balance).toBe(7)
  })
})
