import { describe, it, expect } from 'vitest'
import { ChannelError, identityFromSeed, newEphemeral, openChannel, signHello, toHex, verifyHello } from './channel'
import type { MpcMsg } from './protocol'

const sid = toHex(crypto.getRandomValues(new Uint8Array(32)))
const msgs: MpcMsg[] = [{ from: 1, to: 2, kind: 'frag', body: { secret: 'polynomial fragment' } }]

async function pair() {
  const phone = newEphemeral(), server = newEphemeral()
  return {
    phone: await openChannel('phone', phone.priv, server.pub, 'keygen', sid),
    server: await openChannel('server', server.priv, phone.pub, 'keygen', sid),
  }
}

describe('frame ↔ signing service channel', () => {
  it('carries messages both ways; the box reveals nothing to the app page carrying it', async () => {
    const { phone, server } = await pair()
    const box = await phone.seal(msgs, 1)
    expect(box).not.toContain('polynomial')
    expect(await server.open(box, 1)).toEqual(msgs)
    expect(await phone.open(await server.seal(msgs, 1), 1)).toEqual(msgs)
  })

  it('refuses a replayed, reordered, reflected or altered box', async () => {
    const { phone, server } = await pair()
    const box = await phone.seal(msgs, 2)
    await expect(server.open(box, 3)).rejects.toBeInstanceOf(ChannelError) // wrong step: replay / reorder
    await expect(phone.open(box, 2)).rejects.toBeInstanceOf(ChannelError)  // sent back to its sender
    const bytes = atob(box)
    const flipped = btoa(bytes.slice(0, 20) + String.fromCharCode(bytes.charCodeAt(20) ^ 1) + bytes.slice(21))
    await expect(server.open(flipped, 2)).rejects.toBeInstanceOf(ChannelError)
  })

  it('a box from another session does not open', async () => {
    const a = await pair(), b = await pair()
    await expect(b.server.open(await a.phone.seal(msgs, 1), 1)).rejects.toBeInstanceOf(ChannelError)
  })

  it("only the real server's identity key can vouch for the session key", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const id = await identityFromSeed(seed)
    expect((await identityFromSeed(seed)).pub).toBe(id.pub) // same secret, same identity
    const phone = newEphemeral(), server = newEphemeral(), impostor = newEphemeral()
    const sig = await signHello(id.priv, 'keygen', sid, phone.pub, server.pub)
    await verifyHello(id.pub, 'keygen', sid, phone.pub, server.pub, sig)
    // An app page swapping in its own key, another session, or another kind: refused.
    await expect(verifyHello(id.pub, 'keygen', sid, phone.pub, impostor.pub, sig)).rejects.toBeInstanceOf(ChannelError)
    await expect(verifyHello(id.pub, 'keygen', toHex(crypto.getRandomValues(new Uint8Array(32))), phone.pub, server.pub, sig)).rejects.toBeInstanceOf(ChannelError)
    await expect(verifyHello(id.pub, 'sign', sid, phone.pub, server.pub, sig)).rejects.toBeInstanceOf(ChannelError)
    const other = await identityFromSeed(crypto.getRandomValues(new Uint8Array(32)))
    await expect(verifyHello(other.pub, 'keygen', sid, phone.pub, server.pub, sig)).rejects.toBeInstanceOf(ChannelError)
  })
})
