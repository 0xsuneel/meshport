import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION } from '@/wallet/protocol'

// The frame's message boundary: who it answers, what it answers with.
// window is stubbed: `parent` is the embedding app; in tests (DEV) the
// allowed parent origins are the app's dev server.
const listeners: Array<(e: any) => unknown> = []
const parent = { postMessage: vi.fn() }
vi.stubGlobal('window', { addEventListener: (_t: string, f: any) => listeners.push(f), parent })

await import('./main')
const onMessage = listeners[0]
const APP = 'http://localhost:5173'

async function ask(method: string, params: unknown, opts: { origin?: string; source?: unknown } = {}) {
  parent.postMessage.mockClear()
  const id = Math.random().toString(36).slice(2)
  await onMessage({ origin: opts.origin ?? APP, source: opts.source ?? parent, data: { tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, id, method, params } })
  const call = parent.postMessage.mock.calls.find(c => c[0]?.id === id)
  return call ? { msg: call[0], targetOrigin: call[1] } : null
}

describe('wallet frame transport', () => {
  beforeEach(() => parent.postMessage.mockClear())

  it('answers the allowed parent, replying to that exact origin', async () => {
    const r = await ask('ping', {})
    expect(r?.msg.result).toEqual({ version: WALLET_PROTOCOL_VERSION })
    expect(r?.targetOrigin).toBe(APP)
  })

  it('ignores any other origin', async () => {
    expect(await ask('ping', {}, { origin: 'https://evil.example' })).toBeNull()
    expect(await ask('ping', {}, { origin: 'http://localhost:5174' })).toBeNull()
  })

  it('ignores the right origin from a window that is not its parent (popup, sibling frame)', async () => {
    expect(await ask('ping', {}, { source: { postMessage: vi.fn() } })).toBeNull()
  })

  it('never returns key material: create → address only, sign → signature only', async () => {
    const created = await ask('create', { kind: 'social-auto' })
    const address = created!.msg.result.address
    expect(Object.keys(created!.msg.result)).toEqual(['address'])
    const signed = await ask('sign:message', { address, message: 'hello' })
    expect(Object.keys(signed!.msg.result)).toEqual(['signature'])
    expect(await verifyMessage({ address, message: 'hello', signature: signed!.msg.result.signature })).toBe(true)
    // Nothing the frame posted contains a 32-byte hex secret other than the signature.
    const posted = JSON.stringify(parent.postMessage.mock.calls.map(c => c[0]))
    expect(posted).not.toMatch(/"0x[0-9a-f]{64}"/)
  })

  it('imports a key, then signs a transaction for it; the reply holds only the signed bytes', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    const imported = await ask('import', { kind: 'import-privkey', secret: pk })
    expect(imported!.msg.result).toEqual({ address })
    const tx = { type: 'eip1559', chainId: 5042002, nonce: 0, to: address, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }
    const r = await ask('sign:transaction', { address, transaction: tx })
    expect(r!.msg.result.serialized).toBe(await privateKeyToAccount(pk).signTransaction(tx as any))
    expect(JSON.stringify(r!.msg.result)).not.toContain(pk.slice(2))
  })

  it('refuses to sign while locked, and refuses unknown methods', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    expect((await ask('sign:message', { address, message: 'x' }))!.msg.error.code).toBe('locked')
    expect((await ask('export-key', { address }))!.msg.error.code).toBe('unsupported')
    expect((await ask('__proto__', {}))!.msg.error.code).toBe('unsupported')
  })

  it('rejects an invalid phrase without echoing it', async () => {
    const r = await ask('import', { kind: 'import-seed', secret: 'test test test test test test test test test test test test' })
    expect(r!.msg.error.code).toBe('invalid')
    expect(r!.msg.error.message).not.toContain('test test')
  })
})

describe('passkey ceremonies (passkey.html ↔ frame)', () => {
  const challenge = ('0x' + 'ab'.repeat(32)) as `0x${string}`
  // passkey.html's side of the same-origin channel.
  async function page(ticket: string, outcome?: unknown) {
    const { PASSKEY_CHANNEL } = await import('@/wallet/protocol')
    const ch = new BroadcastChannel(PASSKEY_CHANNEL)
    const reply = new Promise<any>(res => { ch.onmessage = (e) => { if (e.data?.type === 'request' && e.data.ticket === ticket) res(e.data) } })
    ch.postMessage({ type: 'claim', ticket })
    const got = await reply
    if (outcome && got.request) ch.postMessage({ type: 'outcome', ticket, outcome })
    await new Promise(r => setTimeout(r, 20))
    ch.close()
    return got
  }

  it('validates requests', async () => {
    expect((await ask('passkey:begin', { mode: 'sign', credentialId: 'abc', challenge: '0x1234' }))!.msg.error.code).toBe('invalid')
    expect((await ask('passkey:begin', { mode: 'create', userId: '', userName: 'a' }))!.msg.error.code).toBe('invalid')
    expect((await ask('passkey:begin', { mode: 'export' }))!.msg.error.code).toBe('invalid')
  })

  it('hands the request to the first page only, and the outcome to the app once', async () => {
    const { ticket } = (await ask('passkey:begin', { mode: 'sign', credentialId: 'abc', challenge, label: 'Pay 5 USDC' }))!.msg.result
    expect(ticket).toMatch(/^0x[0-9a-f]{32}$/)
    expect((await ask('passkey:result', { ticket }))!.msg.result).toEqual({ status: 'pending' })

    const first = await page(ticket, { status: 'signed', signature: '0x1234' })
    expect(first.request).toEqual({ mode: 'sign', credentialId: 'abc', challenge, label: 'Pay 5 USDC' })
    expect((await page(ticket)).error).toBe('expired') // a second page can't take it over

    expect((await ask('passkey:result', { ticket }))!.msg.result).toEqual({ status: 'signed', signature: '0x1234' })
    expect((await ask('passkey:result', { ticket }))!.msg.result.status).toBe('error') // single use
  })
})
