// Which mints the relayer pays for (audit 7 Nov H2) and one send at a time (H9).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ROUTER = '0x3010518f036ee1bf95da787eee3aaffad95a1794'
vi.stubEnv('BRIDGE_ROUTERS', JSON.stringify({ Base_Sepolia: ROUTER }))
vi.stubEnv('ARC_ROUTER', ROUTER)
vi.mock('@vercel/functions', () => ({ waitUntil: () => {} }))

const { cctpMessageParts, mintRefusal, serialSends } = await import('../../api/bridge-relay')

// A real CCTP V2 message shape: 148-byte header + burn body.
function message(o: { dest: number; sender: string; recipient: string }): string {
  const w = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const header = '00000001' + '0000001a' + o.dest.toString(16).padStart(8, '0') + '00'.repeat(32) + '00'.repeat(32 * 3) + '000003e8' + '000003e8'
  const body = '00000001' + w('0x3600000000000000000000000000000000000000') + w(o.recipient) + w('0x989680') + w(o.sender) + '00'.repeat(32 * 3)
  return '0x' + header + body
}
const USER = '0x0baf9b2c44f377208b3c5f833afbab8414d69d5d'
const STRANGER = '0x9999999999999999999999999999999999999999'

describe('mintRefusal', () => {
  it('reads destination, recipient and sender from the message', () => {
    expect(cctpMessageParts(message({ dest: 0, sender: ROUTER, recipient: USER }))).toEqual({ destinationDomain: 0, mintRecipient: USER, messageSender: ROUTER })
    expect(cctpMessageParts('0x1234')).toBeNull()
  })
  it('Arc mints are always allowed (a Bring; Arc gas is cents)', async () => {
    expect(await mintRefusal('Arc_Testnet', message({ dest: 26, sender: STRANGER, recipient: STRANGER }), USER)).toBeNull()
  })
  it("elsewhere: MeshPort's router or the caller's own burn - not someone else's", async () => {
    expect(await mintRefusal('Ethereum_Sepolia', message({ dest: 0, sender: ROUTER, recipient: STRANGER }), USER)).toBeNull()
    expect(await mintRefusal('Ethereum_Sepolia', message({ dest: 0, sender: USER, recipient: STRANGER }), USER)).toBeNull()
    expect(await mintRefusal('Ethereum_Sepolia', '0x1234', USER)).not.toBeNull()
  })
})

describe('serialSends', () => {
  beforeEach(() => { vi.useRealTimers() })
  it('one send at a time per chain, and a lost nonce is retried once without it', async () => {
    const order: string[] = []
    let first = true
    const wallet = serialSends('Test_Chain', {
      sendTransaction: async (a: any) => {
        order.push(`start ${a.id}${a.nonce != null ? ' n' : ''}`)
        await new Promise(r => setTimeout(r, 20))
        if (a.id === 'b' && a.nonce != null && first) { first = false; throw new Error('nonce too low') }
        order.push(`end ${a.id}`)
        return a.id
      },
    })
    const [x, y] = await Promise.all([wallet.sendTransaction({ id: 'a' }), wallet.sendTransaction({ id: 'b', nonce: 5 })])
    expect([x, y]).toEqual(['a', 'b'])
    expect(order).toEqual(['start a', 'end a', 'start b n', 'start b', 'end b'])
  })
})
