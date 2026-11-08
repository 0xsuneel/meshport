import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage, bytesToHex, hexToBytes } from 'viem'
import { WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION } from '@/wallet/protocol'

// The frame's message boundary: who it answers, what it answers with.
// window is stubbed: `parent` is the embedding app; in tests (DEV) the
// allowed parent origins are the app's dev server.
const listeners: Array<(e: any) => unknown> = []
const parent = { postMessage: vi.fn() }
vi.stubGlobal('window', { addEventListener: (_t: string, f: any) => listeners.push(f), parent })
// Frame-origin storage (node has none): passcode copies need somewhere to live.
class MemStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}
vi.stubGlobal('localStorage', new MemStorage())
vi.stubGlobal('sessionStorage', new MemStorage())

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
    const created = await ask('create', {})
    const address = created!.msg.result.address
    expect(Object.keys(created!.msg.result)).toEqual(['address'])
    const message = `MeshPort sign-in\nAccount: x\nSession: y\nTime: z`
    const signed = await ask('sign:message', { address, message })
    expect(Object.keys(signed!.msg.result)).toEqual(['signature'])
    expect(await verifyMessage({ address, message, signature: signed!.msg.result.signature })).toBe(true)
    // Nothing the frame posted contains a 32-byte hex secret other than the signature.
    const posted = JSON.stringify(parent.postMessage.mock.calls.map(c => c[0]))
    expect(posted).not.toMatch(/"0x[0-9a-f]{64}"/)
  })

  it('imports a key, then signs a transaction for it once approved; the reply holds only the signed bytes', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    const imported = await ask('import', { kind: 'import-privkey', secret: pk, passcode: '123456' })
    expect(imported!.msg.result).toEqual({ address })
    await ask('approve', { address, passcode: '123456' })
    const tx = { type: 'eip1559', chainId: 5042002, nonce: 0, to: address, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }
    const r = await ask('sign:transaction', { address, transaction: tx })
    expect(r!.msg.result.serialized).toBe(await privateKeyToAccount(pk).signTransaction(tx as any))
    expect(JSON.stringify(r!.msg.result)).not.toContain(pk.slice(2))
  })

  it('refuses to sign while locked, and refuses unknown methods and bad addresses', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    expect((await ask('sign:message', { address, message: 'MeshPort sign-in\nx' }))!.msg.error.code).toBe('locked')
    expect((await ask('export-key', { address }))!.msg.error.code).toBe('unsupported')
    expect((await ask('__proto__', {}))!.msg.error.code).toBe('unsupported')
    expect((await ask('status', { address: 'nope' }))!.msg.error.code).toBe('invalid')
  })

  it('chat (audit M15): the chat key never leaves the frame; it seals and opens message keys', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    // Locked wallet: no chat key either.
    expect((await ask('chat:pub', { address }))!.msg.error.code).toBe('locked')
    await ask('import', { kind: 'import-privkey', secret: pk, passcode: '123456' })
    // The seed itself can't be asked for any more.
    expect((await ask('chat:seed', { address }))!.msg.error.code).toBe('unsupported')

    const { deriveChatSeed } = await import('@/lib/chatIdentity')
    const w = await import('@/lib/chatWrap')
    const seed = deriveChatSeed(pk)
    const pub = (await ask('chat:pub', { address }))!.msg.result.pub
    expect(pub).toBe(bytesToHex(w.chatPublicKey(seed)))

    // A contact; a message key sealed for them by the frame opens on their side.
    const bob = deriveChatSeed(generatePrivateKey())
    const bobPub = w.chatPublicKey(bob)
    const key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const sealed = (await ask('chat:wrap', { address, rpk: bytesToHex(bobPub), key }))!.msg.result
    expect(sealed.spk).toBe(pub)
    const atBob = await w.unwrapMessageKey(bob, hexToBytes(sealed.spk), bobPub, hexToBytes(sealed.iv), hexToBytes(sealed.wrapped))
    expect(bytesToHex(atBob!)).toBe(key)

    // ...and the frame opens it back, but only with the real other side.
    const back = { address, spk: sealed.spk, rpk: bytesToHex(bobPub), iv: sealed.iv, wrapped: sealed.wrapped }
    expect((await ask('chat:unwrap', { ...back, peer: bytesToHex(bobPub) }))!.msg.result.key).toBe(key)
    const eve = bytesToHex(w.chatPublicKey(deriveChatSeed(generatePrivateKey())))
    expect((await ask('chat:unwrap', { ...back, peer: eve }))!.msg.result.key).toBeNull()

    // Bad params are refused, and no reply ever carries the chat seed.
    expect((await ask('chat:wrap', { address, rpk: '0x12', key }))!.msg.error.code).toBe('invalid')
    const posted = JSON.stringify(parent.postMessage.mock.calls.map(c => c[0]))
    expect(posted).not.toContain(bytesToHex(seed).slice(2))
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

  it('a passkey signature needs an approval like any signature', async () => {
    const created = await ask('create', {})
    const address = created!.msg.result.address
    expect((await ask('passkey:begin', { mode: 'sign', address, credentialId: 'abc', challenge }))!.msg.error.code).toBe('approval-required')
  })

  it('hands the request to the first page only, and the outcome to the app once', async () => {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    await ask('import', { kind: 'import-privkey', secret: pk, passcode: '123456' })
    await ask('approve', { address, passcode: '123456' })
    const { ticket } = (await ask('passkey:begin', { mode: 'sign', address, credentialId: 'abc', challenge, label: 'Pay 5 USDC' }))!.msg.result
    expect(ticket).toMatch(/^0x[0-9a-f]{32}$/)
    expect((await ask('passkey:result', { ticket }))!.msg.result).toEqual({ status: 'pending' })

    const first = await page(ticket, { status: 'signed', signature: '0x1234' })
    expect(first.request).toEqual({ mode: 'sign', address, credentialId: 'abc', challenge, label: 'Pay 5 USDC' })
    expect((await page(ticket)).error).toBe('expired') // a second page can't take it over

    expect((await ask('passkey:result', { ticket }))!.msg.result).toEqual({ status: 'signed', signature: '0x1234' })
    expect((await ask('passkey:result', { ticket }))!.msg.result.status).toBe('error') // single use
  })
})

describe('approval: value-moving signatures need the passcode, checked by the frame', () => {
  const other = '0x2222222222222222222222222222222222222222'
  const tx = (to: string, value: bigint, data?: string) => ({ type: 'eip1559', chainId: 5042002, nonce: 0, to, value, data, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })
  async function walletWithPasscode() {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    await ask('import', { kind: 'import-privkey', secret: pk, passcode: '123456' })
    return address
  }

  it('a payment needs the passcode, checked here - from the very first signature', async () => {
    const address = await walletWithPasscode()
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('approve', { address, passcode: '000000' }))!.msg.error.code).toBe('bad-passcode')
    expect((await ask('approve', { address, passcode: '123456' }))!.msg.result).toEqual({ approved: true, required: true, validForMs: 120_000 })
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.result.serialized).toMatch(/^0x/)
  })

  it('typed data, Solana, raw hashes and other messages need it; MeshPort texts, name registration and a cheap self-cancel do not', async () => {
    const address = await walletWithPasscode()
    const permit = { domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: other }, types: { Permit: [{ name: 'value', type: 'uint256' }] }, primaryType: 'Permit', message: { value: 1n } }
    expect((await ask('sign:typed-data', { address, typedData: permit }))!.msg.error.code).toBe('approval-required')
    expect((await ask('solana:sign', { address, message: '0x010203' }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:message', { address, message: { raw: '0x' + 'ab'.repeat(32) } }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:message', { address, message: 'hello' }))!.msg.error.code).toBe('approval-required')
    const register = [
      { name: 'name', type: 'string' }, { name: 'account', type: 'address' }, { name: 'kind', type: 'uint8' },
      { name: 'displayName', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ]
    const name = (account: string, chainId = 5042002) => ({ domain: { name: 'MeshPortNames', version: '1', chainId, verifyingContract: other }, types: { Register: register }, primaryType: 'Register', message: { name: 'alice', account, kind: 0, displayName: '', nonce: 0n, deadline: 1n } })
    expect((await ask('sign:typed-data', { address, typedData: name(address) }))!.msg.result.signature).toMatch(/^0x/)
    // Only for this wallet, on Arc, with the real Register shape.
    expect((await ask('sign:typed-data', { address, typedData: name(other) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:typed-data', { address, typedData: name(address, 1) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:message', { address, message: 'MeshPort chat key\nWallet: x\nKey: y' }))!.msg.result.signature).toMatch(/^0x/)
    expect((await ask('sign:transaction', { address, transaction: tx(address, 0n) }))!.msg.result.serialized).toMatch(/^0x/)
    // A self-transfer that carries value, calls something or burns a big fee is not a cancel.
    expect((await ask('sign:transaction', { address, transaction: tx(address, 1n) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:transaction', { address, transaction: tx(address, 0n, '0xa9059cbb') }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:transaction', { address, transaction: { ...tx(address, 0n), maxFeePerGas: 10n ** 18n } }))!.msg.error.code).toBe('approval-required')
  })

  it('the approval lasts 2 minutes, and lock ends it', async () => {
    const address = await walletWithPasscode()
    await ask('approve', { address, passcode: '123456' })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 121_000)
      expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    } finally { vi.useRealTimers() }
    await ask('approve', { address, passcode: '123456' })
    await ask('lock', { address })
    await ask('unlock', { address, passcode: '123456' })
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
  })

  it('changing the passcode always needs the current one', async () => {
    const address = await walletWithPasscode()
    expect((await ask('set-passcode', { address, passcode: '111111' }))!.msg.error.code).toBe('bad-passcode')
    expect((await ask('set-passcode', { address, passcode: '111111', oldPasscode: '123456' }))!.msg.result).toEqual({ ok: true })
    expect((await ask('set-passcode', { address, passcode: '12' }))!.msg.error.code).toBe('invalid')
  })

  it('a wallet with no passcode here signs nothing until an approval gives it one', async () => {
    const created = await ask('create', {})
    const address = created!.msg.result.address
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('approve', { address, passcode: 'x' }))!.msg.error.code).toBe('invalid')
    expect((await ask('approve', { address, passcode: '246810' }))!.msg.result.required).toBe(true)
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.result.serialized).toMatch(/^0x/)
    expect((await ask('status', { address }))!.msg.result.passcode).toBe(true)
  })

  it('the private key is revealed only with the passcode, never on a recent approval', async () => {
    const address = await walletWithPasscode()
    expect((await ask('reveal:grant', { address, what: 'privateKey' }))!.msg.error.code).toBe('bad-passcode')
    expect((await ask('reveal:grant', { address, what: 'privateKey', passcode: '123456' }))!.msg.result.ticket).toMatch(/^0x/)
    // An approval (which fingerprint / face can give) doesn't open the backup.
    await ask('approve', { address, passcode: '123456' })
    expect((await ask('reveal:grant', { address, what: 'privateKey' }))!.msg.error.code).toBe('bad-passcode')
  })

  it('wiping a wallet needs its passcode', async () => {
    const address = await walletWithPasscode()
    expect((await ask('forget', { address, everything: true }))!.msg.error.code).toBe('bad-passcode')
    expect((await ask('status', { address }))!.msg.result.passcode).toBe(true)
    expect((await ask('forget', { address, everything: true, passcode: '123456' }))!.msg.result).toEqual({ ok: true })
    expect((await ask('status', { address }))!.msg.result.passcode).toBe(false)
  })
})

describe('confirm-word check', () => {
  it('answers pass / fail for the whole set only, needs 3 words, and limits tries', async () => {
    const created = await ask('create', {})
    const address = created!.msg.result.address
    // One word at a time is refused (that would read the phrase word by word).
    expect((await ask('mnemonic:check', { address, answers: { 0: 'abandon' } }))!.msg.error.code).toBe('invalid')
    const wrong = await ask('mnemonic:check', { address, answers: { 0: 'a', 1: 'b', 2: 'c' } })
    expect(wrong!.msg.result).toEqual({ ok: false, wrong: [] })
    for (let i = 0; i < 4; i++) await ask('mnemonic:check', { address, answers: { 0: 'a', 1: 'b', 2: 'c' } })
    expect((await ask('mnemonic:check', { address, answers: { 0: 'a', 1: 'b', 2: 'c' } }))!.msg.error.code).toBe('rate-limited')
  })

  it('later (Back up wallet), opens the saved phrase with the passcode to check it', async () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const imported = await ask('import', { kind: 'import-seed', secret: phrase, passcode: '123456' })
    const address = imported!.msg.result.address
    await ask('lock', { address })                    // phrase no longer in memory
    await ask('unlock', { address, passcode: '123456' })
    const right = { 0: 'abandon', 5: 'abandon', 11: 'about' }
    expect((await ask('mnemonic:check', { address, answers: right }))!.msg.error.code).toBe('locked')
    expect((await ask('mnemonic:check', { address, answers: right, passcode: '123456' }))!.msg.result.ok).toBe(true)
    expect((await ask('mnemonic:check', { address, answers: { ...right, 11: 'zoo' }, passcode: '123456' }))!.msg.result.ok).toBe(false)
    expect((await ask('mnemonic:check', { address, answers: right, passcode: '999999' }))!.msg.error.code).toBe('bad-passcode')
  })
})
