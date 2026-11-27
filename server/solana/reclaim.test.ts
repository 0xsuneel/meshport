import { describe, it, expect } from 'vitest'
import { reclaimData, readEventAccount, RECLAIM_EVENT_ACCOUNT } from './reclaim'

describe('reclaim_event_account', () => {
  it('encodes Borsh { attestation, destination_message } after the discriminator', () => {
    const d = reclaimData(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]))
    expect([...d.slice(0, 8)]).toEqual(RECLAIM_EVENT_ACCOUNT)
    expect([...d.slice(8)]).toEqual([2, 0, 0, 0, 1, 2, 3, 0, 0, 0, 3, 4, 5])
  })
  it('reads rent payer and created_at from a MessageSent account', () => {
    const a = new Uint8Array(48)
    a.fill(9, 8, 40)
    new DataView(a.buffer).setBigInt64(40, 1_764_000_000n, true)
    const ev = readEventAccount(a)!
    expect(ev.createdAt).toBe(1_764_000_000)
    expect(ev.rentPayer.every(b => b === 9)).toBe(true)
    expect(readEventAccount(new Uint8Array(10))).toBeNull()
  })
})
