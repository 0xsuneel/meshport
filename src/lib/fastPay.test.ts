import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, maxUint256, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// Fast Pay session rules (lib/fastPay.ts): what goes the fast way, what the
// Circle wallet is asked to sign, and what the session key sends - with the
// chain, the relay and Circle faked.

const OWNER = '0x0baf9b2c44f377208b3c5f833afbab8414d69d5d' as Hex
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Hex

// Chain reads (arcRpcJson): allowances, nonces, gas estimates.
let usdcAllowanceToPermit2 = 0n
const reads: string[] = []
vi.mock('./arc', () => ({
  arcRpcJson: async (body: { method: string; params: any[] }) => {
    if (body.method === 'eth_estimateGas') return { result: '0x11170' } // 70,000
    const data: string = body.params[0].data
    reads.push(data.slice(0, 10))
    if (data.startsWith('0xdd62ed3e')) return { result: encodeAbiParameters([{ type: 'uint256' }], [usdcAllowanceToPermit2]) }
    if (data.startsWith('0x7ecebe00')) return { result: encodeAbiParameters([{ type: 'uint256' }], [12n]) }
    if (data.startsWith('0x927da105')) return { result: encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [0n, 0, 0]) }
    throw new Error('unexpected read ' + data.slice(0, 10))
  },
}))

// The Circle wallet: records what it is asked to sign.
const typedSigned: any[] = []
const circleSigner = {
  address: OWNER, circleWallet: true,
  signTypedData: async (td: any) => { typedSigned.push(td); return privateKeyToAccount(generatePrivateKey()).signTypedData(td) },
}
const auth: any = { walletSource: 'circle', isLocked: false, walletAddress: OWNER, signer: circleSigner }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
vi.mock('@/wallet/circle', () => ({ isCircleAccount: (v: any) => v?.circleWallet === true }))
vi.mock('./supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))
const perf: string[] = []
vi.mock('./errorReport', () => ({ reportPerf: (l: string) => perf.push(l) }))

// The relay: what the session key sends.
const sent: Array<{ from: string; to: string; data: Hex; nonce: number; gas: bigint }> = []
let relayFails = false
vi.mock('./arcService', () => ({
  sendFeeCap: async () => 41_000_000_000n,
  waitForConfirmation: async () => ({ state: 'success', blockNumber: '7' }),
  relayArcSend: async (account: any, tx: any) => { sent.push({ from: account.address, ...tx }); return { txHash: '0x' + 'aa'.repeat(32), state: 'success' } },
  relaySend: async (account: any, tx: any, onSent: (h: string) => void) => {
    if (relayFails) throw new Error('Transaction rejected')
    sent.push({ from: account.address, ...tx })
    const h = ('0x' + String(sent.length).padStart(64, '0')) as Hex
    onSent(h)
    return { txHash: h, state: 'success', blockNumber: '9', nonce: tx.nonce }
  },
}))
const fetchCalls: any[] = []
vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { fetchCalls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ funded: true }), { status: 200 }) }))
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } })

const fp = await import('./fastPay')
const { PERMIT2, ARC_USDC_ERC20, permit2Abi, usdcAbi } = fp

describe('Fast Pay session', () => {
  beforeEach(() => {
    fp._resetFastPay(); mem.clear(); typedSigned.length = 0; sent.length = 0; fetchCalls.length = 0; reads.length = 0; perf.length = 0
    usdcAllowanceToPermit2 = 0n; relayFails = false
    Object.assign(auth, { walletSource: 'circle', isLocked: false, walletAddress: OWNER, signer: circleSigner })
  })

  it('does nothing while switched off, or for a non-Circle wallet', async () => {
    expect(await fp.maybeStartFastPay()).toBe(false)
    fp.setFastPayEnabled(true)
    auth.walletSource = 'create'
    expect(await fp.maybeStartFastPay()).toBe(false)
    expect(typedSigned).toEqual([])
  })

  it('first session: the Circle wallet signs the USDC permit for Permit2 and the session grant - nothing else - then the key puts both on-chain', async () => {
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(true)
    // 1. USDC EIP-2612 permit: owner → Permit2, the wallet's current nonce.
    expect(typedSigned[0].primaryType).toBe('Permit')
    expect(typedSigned[0].domain).toEqual({ name: 'USDC', version: '2', chainId: 5042002, verifyingContract: ARC_USDC_ERC20 })
    expect(typedSigned[0].message).toMatchObject({ owner: OWNER, spender: PERMIT2, value: maxUint256, nonce: 12n })
    // 2. Permit2 grant: USDC, $100, expiring in 2 h, to the session key.
    const grant = typedSigned[1]
    expect(grant.primaryType).toBe('PermitSingle')
    expect(grant.domain).toEqual({ name: 'Permit2', chainId: 5042002, verifyingContract: PERMIT2 })
    expect(grant.message.details).toMatchObject({ token: ARC_USDC_ERC20, amount: 100_000_000n, nonce: 0 })
    const ttl = grant.message.details.expiration - Date.now() / 1000
    expect(ttl).toBeGreaterThan(7100); expect(ttl).toBeLessThanOrEqual(7200)
    expect(typedSigned.length).toBe(2) // no transaction signed by the Circle wallet
    // The relayer funds the key's gas; the key submits USDC.permit (nonce 0), then Permit2.permit (nonce 1).
    expect(fetchCalls[0]).toEqual({ action: 'fastpay_gas', address: grant.message.spender })
    expect(sent.map(t => [t.to, t.nonce])).toEqual([[ARC_USDC_ERC20, 0], [PERMIT2, 1]])
    expect(decodeFunctionData({ abi: usdcAbi, data: sent[0].data }).functionName).toBe('permit')
    expect(decodeFunctionData({ abi: permit2Abi, data: sent[1].data }).functionName).toBe('permit')
    expect(sent.every(t => t.from === grant.message.spender)).toBe(true)
    expect(fp.useFastPay.getState()).toMatchObject({ phase: 'ready', remaining: 100 })
    await vi.waitFor(() => expect(perf.length).toBe(1))
    expect(perf[0]).toMatch(/^\[perf fastpay setup\] reads .*grant-onchain .*ready .*first-time Permit2 approval/)
  })

  it('later sessions skip the USDC permit (Permit2 already approved): one Circle signature', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    await fp.maybeStartFastPay()
    expect(typedSigned.map(t => t.primaryType)).toEqual(['PermitSingle'])
    expect(sent.map(t => t.to)).toEqual([PERMIT2])
  })

  it('locked or another account by the time it is ready: no session', async () => {
    fp.setFastPayEnabled(true)
    const p = fp.maybeStartFastPay()
    auth.isLocked = true
    expect(await p).toBe(false)
    expect(fp.fastPayCovers(OWNER, 1)).toBe(false)
  })

  describe('payments', () => {
    beforeEach(async () => { usdcAllowanceToPermit2 = maxUint256; fp.setFastPayEnabled(true); await fp.maybeStartFastPay(); sent.length = 0 })

    it('covers only this wallet, within what is left, not about to expire', () => {
      expect(fp.fastPayCovers(OWNER, 5)).toBe(true)
      expect(fp.fastPayCovers(OWNER, 100)).toBe(true)
      expect(fp.fastPayCovers(OWNER, 100.01)).toBe(false)
      expect(fp.fastPayCovers(RECIPIENT, 5)).toBe(false)
      expect(fp.fastPayCovers(OWNER, 0)).toBe(false)
    })

    it('a payment: the session key sends Permit2.transferFrom(owner → recipient, exact amount, USDC); what is left goes down', async () => {
      const out = await fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 12.34, idempotencyKey: 'k1' })
      expect(out.state).toBe('success')
      expect(sent[0].to).toBe(PERMIT2)
      expect(sent[0].nonce).toBe(1) // after the grant (nonce 0)
      const call = decodeFunctionData({ abi: permit2Abi, data: sent[0].data })
      expect(call.functionName).toBe('transferFrom')
      const [from, to, amount, token] = call.args as [string, string, bigint, string]
      expect([from.toLowerCase(), to.toLowerCase(), amount, token.toLowerCase()]).toEqual([OWNER, RECIPIENT, 12_340_000n, ARC_USDC_ERC20.toLowerCase()])
      expect(fp.useFastPay.getState().remaining).toBeCloseTo(87.66, 6)
      // The next one uses the next nonce; a bigger one than is left is not covered.
      await fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 50 })
      expect(sent[1].nonce).toBe(2)
      expect(fp.fastPayCovers(OWNER, 40)).toBe(false)
    })

    it('the same payment retried (same idempotency key) is never sent twice', async () => {
      const a = await fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1, idempotencyKey: 'same' })
      const b = await fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1, idempotencyKey: 'same' })
      expect(b.txHash).toBe(a.txHash)
      expect(sent.length).toBe(1)
    })

    it('refused by every node (nothing sent): FastPayNotSent, and the amount is back', async () => {
      relayFails = true
      await expect(fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 30 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      expect(fp.useFastPay.getState().remaining).toBe(100)
    })

    it('lock / sign-out / switch off: the key is gone, nothing is covered', () => {
      fp.endFastPaySession()
      expect(fp.fastPayCovers(OWNER, 1)).toBe(false)
      expect(fp.useFastPay.getState().phase).toBe('off')
    })
  })
})
