import { describe, it, expect } from 'vitest'
import { relayTimingLine } from './relayTiming'

describe('relay timing line', () => {
  it('splits a relayed mint into the wait for Circle, the network, and the relayer\'s own steps', () => {
    const line = relayTimingLine('cctp-mint', 'Ethereum_Sepolia', {
      waitMs: 1200, requestMs: 13_000, ok: true,
      server: { fn: 'receiveMessage', outcome: 'mined', cold: false, checksMs: 300, simulateMs: 400, sendMs: 500, receiptMs: 11_300, totalMs: 12_500, blocks: 1, tipGwei: 2 },
    })
    expect(line).toBe('[perf relay] cctp-mint Ethereum_Sepolia: wait 1.20, request 13.00, net 0.50 | server receiveMessage mined: checks 0.30, simulate 0.40, send 0.50, receipt 11.30, blocks 1, tip 2 gwei, cold false (ok)')
  })

  it('still reports when the relayer gave no timing (an older relayer, or a refusal before it)', () => {
    expect(relayTimingLine('gateway-mint', 'Ethereum_Sepolia', { requestMs: 2500, server: null, ok: false }))
      .toBe('[perf relay] gateway-mint Ethereum_Sepolia: wait -, request 2.50, net - | server - (failed)')
  })
})
