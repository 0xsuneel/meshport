import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/wallet/privy.ts with the Privy bridge faked: the signer, the
// transaction shape Privy gets, and how quickly a non-Privy account is told so.

vi.stubEnv('VITE_PRIVY_APP_ID', 'test-app-id')
const privy = await import('./privy')
const { setPrivyBridge, privyAccount, ensurePrivyWallet, restorePrivyAccount, jsonTypedData } = privy

const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
type Bridge = Parameters<typeof setPrivyBridge>[0] & object

function fakeBridge(over: Partial<Bridge> = {}): Bridge & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls, ready: true, authenticated: true, wallets: [ADDR],
    createWallet: async () => { calls.push(['create']); return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    signTransaction: async (tx, a) => { calls.push(['tx', tx, a]); return '0x02signed' },
    signMessage: async (m, a) => { calls.push(['msg', m, a]); return '0xsig' },
    signTypedData: async (t, a) => { calls.push(['typed', t, a]); return '0xtyped' },
    ...over,
  }
}

beforeEach(() => setPrivyBridge(null))
afterEach(() => vi.useRealTimers())

describe('privyAccount (the Privy signer)', () => {
  it('signs an EIP-1559 transaction with Privy-shaped fields', async () => {
    const b = fakeBridge(); setPrivyBridge(b)
    const raw = await privyAccount(ADDR).signTransaction({ chainId: 5042002, to: '0x2222222222222222222222222222222222222222', nonce: 7, gas: 21000n, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, value: 5n, type: 'eip1559' })
    expect(raw).toBe('0x02signed')
    expect(b.calls[0]).toEqual(['tx', {
      to: '0x2222222222222222222222222222222222222222', chainId: 5042002, nonce: '0x7', value: '0x5',
      gasLimit: '0x5208', maxFeePerGas: '0x1e', maxPriorityFeePerGas: '0x2', type: 2,
    }, ADDR])
  })

  it('a legacy transaction keeps gasPrice; messages and typed data go to the same wallet', async () => {
    const b = fakeBridge(); setPrivyBridge(b)
    const acct = privyAccount(ADDR)
    await acct.signTransaction({ chainId: 1, to: '0x2222222222222222222222222222222222222222', nonce: 0, gas: 21000n, gasPrice: 9n })
    expect(b.calls[0][1]).toMatchObject({ gasPrice: '0x9', type: 0 })
    expect(await acct.signMessage({ message: 'hi' })).toBe('0xsig')
    await acct.signMessage({ message: { raw: '0xdeadbeef' } })
    expect(b.calls[2]).toEqual(['msg', { raw: '0xdeadbeef' }, ADDR])
    expect(await acct.signTypedData({ domain: { chainId: 1 }, types: { A: [{ name: 'v', type: 'uint256' }] }, primaryType: 'A', message: { v: 1n } })).toBe('0xtyped')
  })

  it('waits for Privy to finish signing in before signing', async () => {
    const b = fakeBridge({ authenticated: false }); setPrivyBridge(b)
    const p = privyAccount(ADDR).signMessage({ message: 'later' })
    setPrivyBridge({ ...b, authenticated: true })
    expect(await p).toBe('0xsig')
  })
})

describe('typed data for Privy (swap permits)', () => {
  it('BigInts become decimal strings, nested too; the domain chainId stays a number; it survives JSON', async () => {
    const td = jsonTypedData({
      domain: { name: 'Permit2', chainId: 5042002n, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }] }, primaryType: 'PermitSingle',
      message: { details: { amount: 1461501637330902918203684832716283019655932542975n, nonces: [1n, 2n] }, sigDeadline: 1792905000n },
    })
    expect(td.domain).toEqual({ name: 'Permit2', chainId: 5042002, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' })
    expect(td.message).toEqual({ details: { amount: '1461501637330902918203684832716283019655932542975', nonces: ['1', '2'] }, sigDeadline: '1792905000' })
    expect(() => JSON.stringify(td)).not.toThrow()

    const b = fakeBridge(); setPrivyBridge(b)
    await privyAccount(ADDR).signTypedData({ domain: { chainId: 1 }, types: { A: [{ name: 'v', type: 'uint256' }] }, primaryType: 'A', message: { v: 10n ** 30n } })
    expect(b.calls[0][1]).toMatchObject({ message: { v: '1000000000000000000000000000000' } })
  })
})

describe('wallet set-up and reopening', () => {
  it('ensurePrivyWallet returns the existing wallet, or creates one', async () => {
    setPrivyBridge(fakeBridge())
    expect(await ensurePrivyWallet()).toBe(ADDR)
    const b = fakeBridge({ wallets: [] }); setPrivyBridge(b)
    expect(await ensurePrivyWallet()).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(b.calls).toEqual([['create']])
  })

  it("an account whose wallet isn't its Privy wallet is told so quickly, not after the full wait", async () => {
    setPrivyBridge(fakeBridge({ wallets: ['0xcccccccccccccccccccccccccccccccccccccccc'] }))
    const started = Date.now()
    expect(await restorePrivyAccount(ADDR, 10_000)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('reopens a Privy wallet once Privy lists it', async () => {
    setPrivyBridge(fakeBridge())
    expect((await restorePrivyAccount(ADDR))?.address).toBe(ADDR)
  })
})
