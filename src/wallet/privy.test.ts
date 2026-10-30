import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/wallet/privy.ts with the Privy bridge faked: the signer, the
// transaction shape Privy gets, and how quickly a non-Privy account is told so.

vi.stubEnv('VITE_PRIVY_APP_ID', 'test-app-id')
// Reports (slow / stuck / failed Privy requests) are recorded, not sent.
vi.mock('@/lib/errorReport', () => ({ reportClientError: vi.fn() }))
const privy = await import('./privy')
const { setPrivyBridge, privyAccount, ensurePrivyWallet, restorePrivyAccount, jsonTypedData } = privy

const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
type Bridge = Parameters<typeof setPrivyBridge>[0] & object

function fakeBridge(over: Partial<Bridge> = {}): Bridge & { calls: unknown[][]; warms: unknown[][] } {
  const calls: unknown[][] = []
  const warms: unknown[][] = []
  const b: Bridge & { calls: unknown[][] } = {
    calls, ready: true, authenticated: true, wallets: [ADDR], linked: [],
    createWallet: async () => { calls.push(['create']); return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    signTransaction: async (tx, a) => { calls.push(['tx', tx, a]); return '0x02signed' },
    signMessage: async (m, a) => { calls.push(['msg', m, a]); return '0xsig' },
    signTypedData: async (t, a) => { calls.push(['typed', t, a]); return '0xtyped' },
    solanaWallets: [],
    solanaReady: true,
    createSolanaWallet: async () => { calls.push(['create-solana']); return 'SoLanaAddr1111111111111111111111111111111111' },
    signSolanaTransaction: async (t, a) => { calls.push(['sol-tx', t, a]); return t },
    ...over,
  }
  // The warm-up signature (privy.ts warmPrivySigner) is kept apart from the
  // app's own signatures, so the tests below see only those.
  const sign = b.signMessage
  b.signMessage = async (m, a) => {
    if (m === privy.PRIVY_WARM_MESSAGE) { warms.push(['warm', m, a]); if (over.signMessage && warmFails) return sign(m, a); return '0xsig' }
    return sign(m, a)
  }
  return Object.assign(b, { warms })
}
let warmFails = false

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

  it("opens from the account's record before the wallet iframe has connected it", async () => {
    setPrivyBridge(fakeBridge({ wallets: [], linked: [ADDR] }))
    expect((await restorePrivyAccount(ADDR))?.address).toBe(ADDR)
  })
})

describe('Solana wallet', () => {
  it('privySolanaAddress follows Privy and listeners hear about it', () => {
    let heard = 0
    const off = privy.onPrivyChange(() => { heard++ })
    expect(privy.privySolanaAddress()).toBeNull()
    setPrivyBridge(fakeBridge({ solanaWallets: ['So1anaWa11et111111111111111111111111111111'] }))
    expect(privy.privySolanaAddress()).toBe('So1anaWa11et111111111111111111111111111111')
    setPrivyBridge(fakeBridge({ authenticated: false, solanaWallets: ['So1anaWa11et111111111111111111111111111111'] }))
    expect(privy.privySolanaAddress()).toBeNull() // not until Privy is signed in
    off()
    expect(heard).toBe(2)
  })

  it('ensurePrivySolanaWallet returns the existing wallet, or creates one', async () => {
    setPrivyBridge(fakeBridge({ solanaWallets: ['So1anaWa11et111111111111111111111111111111'] }))
    expect(await privy.ensurePrivySolanaWallet()).toBe('So1anaWa11et111111111111111111111111111111')
    const b = fakeBridge(); setPrivyBridge(b)
    expect(await privy.ensurePrivySolanaWallet()).toBe('SoLanaAddr1111111111111111111111111111111111')
    expect(b.calls).toEqual([['create-solana']])
  })
})

describe('a Privy request that never answers', () => {
  it('is reported while waiting, then given up on - so a screen never hangs', async () => {
    vi.useFakeTimers()
    const { reportClientError } = await import('@/lib/errorReport')
    const spy = vi.mocked(reportClientError)
    spy.mockClear()
    setPrivyBridge(fakeBridge({ signTransaction: () => new Promise<never>(() => {}) }))
    const p = privyAccount(ADDR).signTransaction({ to: ADDR, value: 1n, gas: 21000n, nonce: 1, chainId: 5042002, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' } as any)
    const settled = p.then(() => 'signed', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(privy.PRIVY_STILL_WAITING_MS + 10)
    await vi.advanceTimersByTimeAsync(privy.PRIVY_GIVE_UP_MS)
    expect(await settled).toBe(privy.PRIVY_NO_ANSWER)
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 50)) // the reports are sent from a dynamic import
    const reports = spy.mock.calls.map(c => (c[1] as Error).message)
    expect(reports.some(r => r.includes('[privy signTransaction] still waiting'))).toBe(true)
    expect(reports.some(r => r.includes('[privy signTransaction] failed') && r.includes(privy.PRIVY_NO_ANSWER))).toBe(true)

  })
})

describe('opening a known Privy wallet after the app resumes', () => {
  it('waits for the wallet list that fills in after sign-in (it used to give up at 1.5 s)', async () => {
    vi.useFakeTimers()
    setPrivyBridge(fakeBridge({ wallets: [] }))            // signed in, list still empty
    const quick = restorePrivyAccount(ADDR)                    // sign-in check: 1.5 s
    const known = restorePrivyAccount(ADDR, 30_000, 20_000)    // known Privy account
    await vi.advanceTimersByTimeAsync(3_000)
    setPrivyBridge(fakeBridge({ wallets: [ADDR] }))           // the wallet arrives 3 s later
    expect(await quick).toBeNull()
    expect((await known)?.address.toLowerCase()).toBe(ADDR)
  })
})

describe('chat key for a Privy wallet', () => {
  it('comes from its signature: the same every time, once per session', async () => {
    let calls = 0
    setPrivyBridge(fakeBridge({ signMessage: async () => { calls++; return '0x' + 'ab'.repeat(65) as `0x${string}` } }))
    const a = await privy.privyChatSeed(ADDR)
    const b = await privy.privyChatSeed(ADDR.toUpperCase().replace('0X', '0x'))
    expect(a).toHaveLength(32)
    expect(Buffer.from(a)).toEqual(Buffer.from(b))
    expect(calls).toBe(2) // signed twice (the check), then cached
  })

  it('is refused when Privy signatures differ - the chat key would not be stable', async () => {
    const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc'
    let n = 0
    setPrivyBridge(fakeBridge({ wallets: [OTHER], signMessage: async () => ('0x' + (n++ ? 'cd' : 'ef').repeat(65)) as `0x${string}` }))
    await expect(privy.privyChatSeed(OTHER)).rejects.toThrow(/stable chat key/)
  })
})

describe("Privy giving up on its own request", () => {
  it('shows as "nothing was sent", not "signal is aborted without reason"', async () => {
    setPrivyBridge(fakeBridge({ signTransaction: async () => { throw new DOMException('signal is aborted without reason', 'AbortError') } }))
    await expect(privyAccount(ADDR).signTransaction({ to: ADDR, value: 1n, gas: 21000n, nonce: 1, chainId: 5042002, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' } as any))
      .rejects.toThrow(privy.PRIVY_NO_ANSWER)
  })
})

describe('Arc readiness does not wait for Solana', () => {
  it('the Arc wallet opens and can sign while Privy has not loaded Solana yet', async () => {
    const b = fakeBridge({ solanaReady: false, solanaWallets: [] })
    setPrivyBridge(b)
    await new Promise(r => setTimeout(r, 0)) // the warm-up signature
    expect(privy.privySignerConnected(ADDR)).toBe(true)
    const account = await restorePrivyAccount(ADDR, 1_000, 500)
    expect(account).not.toBeNull()
    await account!.signMessage({ message: 'hi' })
    expect(b.calls.some(c => c[0] === 'msg')).toBe(true)
  })

  it('listed on the account but its iframe not connected: not a connected signer yet', () => {
    setPrivyBridge(fakeBridge({ wallets: [], linked: [ADDR] }))
    expect(privy.privySignerConnected(ADDR)).toBe(false)
  })
})

describe('warm-up: the wallet is authenticated before the first payment', () => {
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('signs one fixed message as soon as Privy connects the wallet - then it is ready to sign', async () => {
    const b = fakeBridge()
    setPrivyBridge(b)
    expect(privy.privySignerConnected(ADDR)).toBe(false) // connected, not authenticated yet
    await flush()
    const warm = b.warms
    expect(warm).toEqual([['warm', privy.PRIVY_WARM_MESSAGE, ADDR]])
    expect(privy.privySignerConnected(ADDR)).toBe(true)
    // Privy's state changing again doesn't sign again.
    setPrivyBridge({ ...b }); await flush()
    expect(b.warms.length).toBe(1)
  })

  it('a rebuilt Privy (new iframe) is warmed up again', async () => {
    const b1 = fakeBridge(); setPrivyBridge(b1); await flush()
    setPrivyBridge(null) // PrivyRoot rebuilds
    expect(privy.privySignerConnected(ADDR)).toBe(false)
    const b2 = fakeBridge(); setPrivyBridge(b2); await flush()
    expect(b2.warms.length).toBe(1)
    expect(privy.privySignerConnected(ADDR)).toBe(true)
  })

  it('a failed warm-up leaves it "not ready" (payments still sign, just without the head start)', async () => {
    warmFails = true
    try {
      const b = fakeBridge({ signMessage: async () => { throw new Error('signal is aborted without reason') } })
      setPrivyBridge(b); await flush(); await flush()
      expect(privy.privySignerConnected(ADDR)).toBe(false)
    } finally { warmFails = false }
  })

  it('back from the background: the same Privy is checked again (one warm-up), not replaced - ready once it answers', async () => {
    const b = fakeBridge(); setPrivyBridge(b); await flush()
    const checks = privy.recheckPrivySigners()
    expect(checks).toHaveLength(1)
    expect(privy.privySignerConnected(ADDR)).toBe(false) // not ready until it answers
    expect(await checks[0]).toBe(true)
    expect(b.warms.length).toBe(2)
    expect(privy.privySignerConnected(ADDR)).toBe(true)
  })

  it('nothing to check before Privy has signed in', () => {
    setPrivyBridge(fakeBridge({ authenticated: false }))
    expect(privy.recheckPrivySigners()).toEqual([])
  })

  it('a failed warm-up is tried again on its own - ready once a retry answers', async () => {
    vi.useFakeTimers()
    let failures = 1
    const b = fakeBridge()
    const sign = b.signMessage
    b.signMessage = async (m, a) => {
      if (m === privy.PRIVY_WARM_MESSAGE && failures > 0) { failures--; throw new Error('iframe not answering') }
      return sign(m, a)
    }
    setPrivyBridge(b)
    await vi.advanceTimersByTimeAsync(0)
    expect(privy.privySignerConnected(ADDR)).toBe(false)
    await vi.advanceTimersByTimeAsync(privy.PRIVY_WARM_RETRY_MS[0])
    expect(privy.privySignerConnected(ADDR)).toBe(true)
  })

  it('retries are bounded, and a rebuilt Privy cancels them', async () => {
    vi.useFakeTimers()
    let warmCalls = 0
    const b = fakeBridge()
    b.signMessage = async m => { if (m === privy.PRIVY_WARM_MESSAGE) warmCalls++; throw new Error('down') }
    setPrivyBridge(b)
    for (const ms of privy.PRIVY_WARM_RETRY_MS) await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(warmCalls).toBe(1 + privy.PRIVY_WARM_RETRY_MS.length)
    // A new failing Privy schedules again; dropping it cancels the retry.
    warmCalls = 0
    setPrivyBridge(null); setPrivyBridge(b)
    await vi.advanceTimersByTimeAsync(0)
    setPrivyBridge(null)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(warmCalls).toBe(1)
  })

  it("a real payment's signature counts as warm - readiness doesn't stay 'not ready' after it", async () => {
    warmFails = true
    try {
      const b = fakeBridge({ signMessage: async () => { throw new Error('warm failed') } })
      setPrivyBridge(b); await flush(); await flush()
      expect(privy.privySignerConnected(ADDR)).toBe(false)
      await privyAccount(ADDR).signTransaction({ chainId: 1, to: '0x2222222222222222222222222222222222222222', nonce: 0, gas: 21000n, gasPrice: 1n })
      expect(privy.privySignerConnected(ADDR)).toBe(true)
    } finally { warmFails = false }
  })

  it('the warm-up is a plain message - never a transaction', async () => {
    const b = fakeBridge(); setPrivyBridge(b); await flush()
    expect(b.calls.some(c => c[0] === 'tx' || c[0] === 'typed')).toBe(false)
  })
})
