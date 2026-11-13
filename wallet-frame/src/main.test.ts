import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage, bytesToHex, hexToBytes } from 'viem'
import { WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION, CONFIRM_CHANNEL } from '@/wallet/protocol'

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

// confirm.html, played by the test over its BroadcastChannel.
const confirmPage = new BroadcastChannel(CONFIRM_CHANNEL)
function fromPage(type: string, ticket: string) {
  return new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}`)), 3000)
    const on = (e: MessageEvent) => { if (e.data?.type === type && e.data.ticket === ticket) { clearTimeout(t); confirmPage.removeEventListener('message', on as any); resolve(e.data) } }
    confirmPage.addEventListener('message', on as any)
  })
}
/** The person approves on the wallet's own page - by default a 100 USDC spend limit. */
async function approveInWallet(address: string, passcode: string, what: Record<string, unknown> = { scope: { limits: [{ asset: 'USDC', amount: '100' }] } }) {
  const { ticket } = (await ask('confirm:begin', { address, ...what, summary: { label: 'Approve', name: 'this' } }))!.msg.result
  const req = fromPage('request', ticket); confirmPage.postMessage({ type: 'claim', ticket }); await req
  const checked = fromPage('checked', ticket); confirmPage.postMessage({ type: 'passcode', ticket, passcode })
  return { ...(await checked), ticket: ticket as string }
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
    await approveInWallet(address, '123456')
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
    // A spend limit can't cover a passkey signature: it's confirmed on its own.
    await approveInWallet(address, '123456')
    const request = { mode: 'sign', address, credentialId: 'abc', challenge, label: 'Pay 5 USDC' }
    expect((await ask('passkey:begin', request))!.msg.error.code).toBe('approval-required')
    const confirmed = await approveInWallet(address, '123456', { request: { method: 'passkey:begin', params: request } })
    const { ticket } = (await ask('passkey:begin', { ...request, confirmation: confirmed.ticket }))!.msg.result
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
    // No spend limit in force: said so (the app records why it had to ask).
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error).toMatchObject({ code: 'approval-required', reason: 'no-limit' })
    expect(await approveInWallet(address, '000000')).toMatchObject({ ok: false, code: 'bad-passcode' })
    // A passcode typed in the app is only checked: it approves nothing.
    expect((await ask('passcode:check', { address, passcode: '123456' }))!.msg.result).toEqual({ ok: true, set: false })
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('approve', { address, passcode: '123456' } as any))!.msg.error.code).toBe('unsupported')
    expect(await approveInWallet(address, '123456')).toMatchObject({ ok: true })
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
    // Only on Arc: elsewhere the fee is paid in that chain's own coin (ETH…).
    expect((await ask('sign:transaction', { address, transaction: { ...tx(address, 0n), chainId: 1 } }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:transaction', { address, transaction: { ...tx(address, 0n), chainId: undefined } }))!.msg.error.code).toBe('approval-required')
  })

  it('the approval lasts 2 minutes, and lock ends it', async () => {
    const address = await walletWithPasscode()
    await approveInWallet(address, '123456')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 121_000)
      expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    } finally { vi.useRealTimers() }
    await approveInWallet(address, '123456')
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

  it('a wallet with no passcode here signs nothing until it has one and the wallet page approves', async () => {
    const created = await ask('create', {})
    const address = created!.msg.result.address
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    // No passcode here: the wallet page can't confirm yet; the app's check sets one (approving nothing).
    expect((await ask('confirm:begin', { address, summary: { label: 'Approve', name: 'this' } }))!.msg.error.code).toBe('not-found')
    expect((await ask('passcode:check', { address, passcode: 'x' }))!.msg.error.code).toBe('invalid')
    expect((await ask('passcode:check', { address, passcode: '246810' }))!.msg.result).toEqual({ ok: true, set: true })
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.error.code).toBe('approval-required')
    expect(await approveInWallet(address, '246810')).toMatchObject({ ok: true })
    expect((await ask('sign:transaction', { address, transaction: tx(other, 1n) }))!.msg.result.serialized).toMatch(/^0x/)
    expect((await ask('status', { address }))!.msg.result.passcode).toBe(true)
  })

  it('the private key is revealed only with the passcode, never on a recent approval', async () => {
    const address = await walletWithPasscode()
    expect((await ask('reveal:grant', { address, what: 'privateKey' }))!.msg.error.code).toBe('bad-passcode')
    expect((await ask('reveal:grant', { address, what: 'privateKey', passcode: '123456' }))!.msg.result.ticket).toMatch(/^0x/)
    // An approval (which fingerprint / face can give) doesn't open the backup.
    await approveInWallet(address, '123456')
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

  it('the tap-the-words check (reveal.html verify) needs the phrase open or the passcode, like showing it', async () => {
    // Just created (before the passcode is set): the phrase is in memory.
    const created = (await ask('create', {}))!.msg.result.address
    expect((await ask('reveal:grant', { address: created, what: 'verify' }))!.msg.result.ticket).toMatch(/^0x/)
    // Later: only with the passcode.
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const address = (await ask('import', { kind: 'import-seed', secret: phrase, passcode: '123456' }))!.msg.result.address
    await ask('lock', { address }); await ask('unlock', { address, passcode: '123456' })
    expect((await ask('reveal:grant', { address, what: 'verify' }))!.msg.error.code).toBe('not-found')
    expect((await ask('reveal:grant', { address, what: 'verify', passcode: '123456' }))!.msg.result.ticket).toMatch(/^0x/)
    expect((await ask('reveal:grant', { address, what: 'other' }))!.msg.error.code).toBe('invalid')
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

// ── Confirm in the wallet (confirm.html) ────────────────────────────────────
// The page side of the BroadcastChannel is played by the test.
describe('confirmations', () => {
  const ARC = 5042002
  const claim = (ticket: string) => { const r = fromPage('request', ticket); confirmPage.postMessage({ type: 'claim', ticket }); return r }
  const enter = (ticket: string, passcode: string) => { const r = fromPage('checked', ticket); confirmPage.postMessage({ type: 'passcode', ticket, passcode }); return r }

  async function wallet() {
    const pk = generatePrivateKey()
    const { address } = privateKeyToAccount(pk)
    await ask('import', { kind: 'import-privkey', secret: pk, passcode: '123456' })
    return { pk, address }
  }
  const recipient = privateKeyToAccount(generatePrivateKey()).address
  const intent = { chainId: ARC, to: recipient, value: '2500000000000000000', data: '0x', maxFee: '50000000000000000' }
  const tx = (over: Record<string, unknown> = {}) => ({ type: 'eip1559', chainId: ARC, nonce: 7, to: recipient, value: 2_500_000_000_000_000_000n, gas: 25_200n, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...over })

  it('shows the payment read from the transaction, and signs exactly that one once', async () => {
    const { pk, address } = await wallet()
    const { ticket } = (await ask('confirm:begin', { address, intent, summary: { label: 'Paying', name: 'ravi.arc' } }))!.msg.result
    const req = await claim(ticket)
    expect(req.view).toMatchObject({ action: 'Send', amount: '2.5', token: 'USDC', to: recipient })
    expect(req.summary.name).toBe('ravi.arc')
    expect((await ask('confirm:result', { ticket }))!.msg.result.status).toBe('pending')

    expect(await enter(ticket, '000000')).toMatchObject({ ok: false, code: 'bad-passcode' })
    expect(await enter(ticket, '123456')).toMatchObject({ ok: true })
    expect((await ask('confirm:result', { ticket }))!.msg.result).toEqual({ status: 'approved', viaBiometric: false })

    // No approval window: the plain path still asks.
    expect((await ask('sign:transaction', { address, transaction: tx() }))!.msg.error.code).toBe('approval-required')
    // A different recipient, amount or fee is not what was confirmed.
    expect((await ask('sign:transaction', { address, transaction: tx({ to: address }), confirmation: ticket }))!.msg.error.code).toBe('mismatch')
    expect((await ask('sign:transaction', { address, transaction: tx({ value: 3n }), confirmation: ticket }))!.msg.error.code).toBe('mismatch')
    expect((await ask('sign:transaction', { address, transaction: tx({ gas: 10_000_000n }), confirmation: ticket }))!.msg.error.code).toBe('mismatch')
    // The confirmed one: signed, once.
    const r = await ask('sign:transaction', { address, transaction: tx(), confirmation: ticket })
    expect(r!.msg.result.serialized).toBe(await privateKeyToAccount(pk).signTransaction(tx() as any))
    expect((await ask('sign:transaction', { address, transaction: tx(), confirmation: ticket }))!.msg.error.code).toBe('mismatch')
  })

  // A page the app opened at once (confirm.html#slot=) claims the request by
  // its slot - asking again until the wallet has made it - then uses the ticket.
  it('a page opened before its request claims it by slot, once', async () => {
    const { address } = await wallet()
    const slot = 'ab'.repeat(16)
    const bySlot = () => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no request')), 3000)
      const on = (e: MessageEvent) => { if (e.data?.type === 'request' && e.data.slot === slot) { clearTimeout(t); confirmPage.removeEventListener('message', on as any); resolve(e.data) } }
      confirmPage.addEventListener('message', on as any)
      confirmPage.postMessage({ type: 'claim', slot })
    })
    // Asked before the request exists: no answer yet.
    await expect(Promise.race([bySlot(), new Promise(r => setTimeout(() => r('none'), 200))])).resolves.toBe('none')
    const { ticket } = (await ask('confirm:begin', { address, intent, slot, summary: { label: 'Paying', name: 'ravi.arc' } }))!.msg.result
    const req = await bySlot()
    expect(req.ticket).toBe(ticket)
    expect(req.view).toMatchObject({ action: 'Send', amount: '2.5', token: 'USDC', to: recipient })
    // One page only, by slot or by ticket.
    expect((await bySlot()).error).toBe('expired')
    expect((await claim(ticket)).error).toBe('expired')
    expect(await enter(ticket, '123456')).toMatchObject({ ok: true })
    // A slot that isn't 32 hex characters is ignored (the ticket still works).
    const odd = (await ask('confirm:begin', { address, intent, slot: 'nope' }))!.msg.result
    await claim(odd.ticket)
  })

  it('a ticket is shown by one page only, and cancelled ones never approve', async () => {
    const { address } = await wallet()
    const { ticket } = (await ask('confirm:begin', { address, intent }))!.msg.result
    await claim(ticket)
    expect((await claim(ticket)).error).toBe('expired')
    await ask('confirm:cancel', { ticket })
    expect((await ask('confirm:result', { ticket }))!.msg.result.status).toBe('error')
  })

  it("a summary alone approves nothing - the app's words are never the limit", async () => {
    const { address } = await wallet()
    expect((await ask('confirm:begin', { address, summary: { label: 'Swapping', name: 'USDC → EURC', amount: '10' } }))!.msg.error.code).toBe('invalid')
    // One thing at a time.
    expect((await ask('confirm:begin', { address, intent, scope: { limits: [{ asset: 'USDC', amount: '5' }] } }))!.msg.error.code).toBe('invalid')
  })

  it('a spend limit: the wallet shows it, then counts every signature against it for 2 minutes', async () => {
    const { address } = await wallet()
    const { ticket } = (await ask('confirm:begin', { address, scope: { limits: [{ asset: 'USDC', amount: '4' }] }, summary: { label: 'Swapping', name: 'USDC → EURC' } }))!.msg.result
    const req = await claim(ticket)
    expect(req.view).toMatchObject({ action: 'Up to', amount: '4 USDC', to: 'may leave your wallet' })
    expect(await enter(ticket, '123456')).toMatchObject({ ok: true })
    expect((await ask('confirm:result', { ticket }))!.msg.result.status).toBe('approved')
    // 2.5 USDC fits; another 2.5 would go over 4.
    expect((await ask('sign:transaction', { address, transaction: tx() }))!.msg.result.serialized).toMatch(/^0x/)
    expect((await ask('sign:transaction', { address, transaction: tx({ nonce: 8 }) }))!.msg.error.code).toBe('approval-required')
    // An ERC-20 USDC approval of 1 counts too (6 decimals on its contract): 1.5 left → fits.
    const approve = '0x095ea7b3' + '000000000000000000000000' + recipient.slice(2).toLowerCase() + (1_000_000n).toString(16).padStart(64, '0')
    expect((await ask('sign:transaction', { address, transaction: tx({ nonce: 8, to: '0x3600000000000000000000000000000000000000', value: 0n, data: approve }) }))!.msg.result.serialized).toMatch(/^0x/)
    // EURC isn't in the limit at all.
    const eurc = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'
    expect((await ask('sign:transaction', { address, transaction: tx({ nonce: 9, to: eurc, value: 0n, data: approve }) }))!.msg.error.code).toBe('approval-required')
  })

  it("a spend limit refuses what it can't read: unknown contracts, approvals for all, Permit2, Solana, other chains' coin", async () => {
    const { address } = await wallet()
    const escrow = '0x4444444444444444444444444444444444444444'
    await approveInWallet(address, '123456', { scope: { limits: [{ asset: 'USDC', amount: '50' }], contracts: [{ address: escrow, label: 'MeshPort P2P escrow' }] } })
    const call = (to: string, data: string, over: Record<string, unknown> = {}) => ask('sign:transaction', { address, transaction: tx({ to, value: 0n, data, ...over }) })
    // A contract the limit names, with a call that moves nothing by itself: allowed.
    expect((await call(escrow, '0x12345678'))!.msg.result.serialized).toMatch(/^0x/)
    // Any other contract: refused (confirmed on its own instead).
    expect((await call('0x5555555555555555555555555555555555555555', '0x12345678'))!.msg.error.code).toBe('approval-required')
    // Even the named contract can't be handed control of tokens.
    expect((await call(escrow, '0xa22cb465' + '00'.repeat(64)))!.msg.error.code).toBe('approval-required')
    expect((await call('0x000000000022D473030F116dDEE9F6B43aC78BA3', '0x12345678'))!.msg.error.code).toBe('approval-required')
    expect((await ask('solana:sign', { address, message: '0x010203' }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:transaction', { address, transaction: tx({ chainId: 1, value: 1n }) }))!.msg.error.code).toBe('approval-required')
    expect((await ask('sign:message', { address, message: { raw: '0x' + 'ab'.repeat(32) } }))!.msg.error.code).toBe('approval-required')
    // A limit can't name a token or Permit2 as "its" contract.
    expect((await ask('confirm:begin', { address, scope: { limits: [{ asset: 'USDC', amount: '1' }], contracts: [{ address: '0x3600000000000000000000000000000000000000' }] } }))!.msg.error.code).toBe('invalid')
    expect((await ask('confirm:begin', { address, scope: { limits: [{ asset: 'DAI', amount: '1' }] } }))!.msg.error.code).toBe('invalid')
  })

  it('an exact request signs that request, once - nothing else', async () => {
    const { address } = await wallet()
    const params = { address, message: { raw: '0x' + 'cd'.repeat(32) } }
    expect((await ask('sign:message', params))!.msg.error.code).toBe('approval-required')
    const { ticket } = (await ask('confirm:begin', { address, request: { method: 'sign:message', params } }))!.msg.result
    const req = await claim(ticket)
    expect(req.view.action).toBe('Sign raw data')
    expect(req.view.warnings.length).toBeGreaterThan(0)
    expect(await enter(ticket, '123456')).toMatchObject({ ok: true })
    // Another request with this ticket: refused, and the ticket stays for the real one.
    expect((await ask('sign:message', { address, message: { raw: '0x' + 'ce'.repeat(32) }, confirmation: ticket }))!.msg.error.code).toBe('mismatch')
    expect((await ask('sign:message', { ...params, confirmation: ticket }))!.msg.result.signature).toMatch(/^0x/)
    expect((await ask('sign:message', { ...params, confirmation: ticket }))!.msg.error.code).toBe('mismatch')
    // A request can only be for this wallet.
    expect((await ask('confirm:begin', { address, request: { method: 'sign:message', params: { ...params, address: recipient } } }))!.msg.error.code).toBe('invalid')
    expect((await ask('confirm:begin', { address, request: { method: 'reveal:grant', params } }))!.msg.error.code).toBe('invalid')
  })

  it('refuses what it cannot confirm', async () => {
    const { address } = await wallet()
    expect((await ask('confirm:begin', { address }))!.msg.error.code).toBe('invalid')
    expect((await ask('confirm:begin', { address, intent: { ...intent, chainId: 1 } }))!.msg.error.code).toBe('invalid')
    expect((await ask('confirm:begin', { address, intent: { ...intent, maxFee: '1000000000000000000' } }))!.msg.error.code).toBe('invalid')
    // No passcode on this device: the app's own sheet sets one first.
    const fresh = (await ask('create', {}))!.msg.result.address
    expect((await ask('confirm:begin', { address: fresh, intent }))!.msg.error.code).toBe('not-found')
  })
})
