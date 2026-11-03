import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, maxUint256, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// Fast Pay session rules (lib/fastPay.ts): what goes the fast way, what the
// Circle wallet is asked to sign, and what the session key sends - with the
// chain, the relay and Circle faked.

const lc = (x: string) => x.toLowerCase()
const OWNER = '0x0baf9b2c44f377208b3c5f833afbab8414d69d5d' as Hex
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Hex
const RELAYER = '0x9999999999999999999999999999999999999999' as Hex
const GAS_PRICE = 20_500_000_000n

// One ordered log of everything that happens (gas float, signatures, sends).
const events: string[] = []

// Chain reads (arcRpcJson): allowances, nonces, gas estimates, balances.
let usdcAllowanceToPermit2 = 0n
// Permit2's allowance for a session key (what's left, expiry) - for resumed sessions.
let p2Left = 0n
let p2Expiration = 0
vi.mock('./arc', () => ({
  arcRpcJson: async (body: { method: string; params: any[] }) => {
    if (body.method === 'eth_estimateGas') return { result: '0x11170' } // 70,000
    if (body.method === 'eth_getBalance') return { result: '0x2386f26fc10000' } // 0.01 USDC
    if (body.method === 'eth_getTransactionCount') return { result: '0x5' }
    const data: string = body.params[0].data
    if (data.startsWith('0xdd62ed3e')) return { result: encodeAbiParameters([{ type: 'uint256' }], [usdcAllowanceToPermit2]) }
    if (data.startsWith('0x7ecebe00')) return { result: encodeAbiParameters([{ type: 'uint256' }], [12n]) }
    if (data.startsWith('0x927da105')) return { result: encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [p2Left, p2Expiration, 0]) }
    throw new Error('unexpected read ' + data.slice(0, 10))
  },
}))

// The Circle wallet: records what it is asked to sign.
const typedSigned: any[] = []
const circleSigner = {
  address: OWNER, circleWallet: true,
  signTypedData: async (td: any) => { typedSigned.push(td); events.push('sign:' + td.primaryType); return privateKeyToAccount(generatePrivateKey()).signTypedData(td) },
}
const auth: any = { walletSource: 'circle', isLocked: false, walletAddress: OWNER, signer: circleSigner }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
vi.mock('@/wallet/circle', () => ({ isCircleAccount: (v: any) => v?.circleWallet === true }))
vi.mock('./supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))
const perf: string[] = []
vi.mock('./errorReport', () => ({ reportPerf: (l: string) => perf.push(l) }))

// The relay: what the session key sends.
const sent: Array<{ from: string; to: string; data?: Hex; value?: bigint; nonce: number; gas: bigint }> = []
let relayFails = false
let failNextSetupSend = false
vi.mock('./arcService', () => ({
  sendFeeCap: async () => 41_000_000_000n,
  currentGasPrice: async () => GAS_PRICE,
  waitForConfirmation: async () => ({ state: 'success', blockNumber: '7' }),
  relayArcSend: async (account: any, tx: any) => {
    if (failNextSetupSend) { failNextSetupSend = false; throw new Error('connection lost') }
    await account.signTransaction({ type: 'eip1559', chainId: 5042002, maxPriorityFeePerGas: 1n, value: 0n, ...tx }) // like the real relay: the key signs
    sent.push({ from: account.address, ...tx }); events.push('send:' + tx.to)
    return { txHash: '0x' + 'aa'.repeat(32), state: 'success' }
  },
  relaySend: async (account: any, tx: any, onSent: (h: string) => void) => {
    if (relayFails) throw new Error('Transaction rejected')
    await account.signTransaction({ type: 'eip1559', chainId: 5042002, maxPriorityFeePerGas: 1n, value: 0n, ...tx })
    sent.push({ from: account.address, ...tx })
    const h = ('0x' + String(sent.length).padStart(64, '0')) as Hex
    onSent(h)
    return { txHash: h, state: 'success', blockNumber: '9', nonce: tx.nonce }
  },
}))
const fetchCalls: any[] = []
vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
  fetchCalls.push(JSON.parse(String(init.body))); events.push('gas')
  return new Response(JSON.stringify({ funded: true, from: RELAYER }), { status: 200 })
}))
// The wallet frame: either it supports Fast Pay session keys (a key it keeps,
// signing for the app, a payment only with a passcode approval it checked),
// or it's an older frame that answers 'unsupported'.
let frameSupports = true
const PIN = '123456'
let framePin: string | null = PIN // the frame's Fast Pay passcode check (set when turned on)
let frameApproved = false
const frameCalls: string[] = []
const frameKeys = new Map<string, ReturnType<typeof privateKeyToAccount>>()
const frameKept = new Set<string>() // sealed to the device: survives an app restart
vi.mock('@/wallet/frameClient', () => ({
  callWallet: async (method: string, params: any) => {
    frameCalls.push(method)
    if (!frameSupports) throw Object.assign(new Error('Unknown request ' + method), { code: 'unsupported' })
    if (method === 'fastpay:set-passcode') { if (framePin && params.oldPasscode !== framePin) throw Object.assign(new Error('Wrong passcode'), { code: 'bad-passcode' }); framePin = params.passcode; return { ok: true } }
    if (method === 'fastpay:check') return { ok: true }
    if (method === 'fastpay:approve') {
      if (!framePin) throw Object.assign(new Error('no check'), { code: 'not-found' })
      if (params.passcode !== framePin) throw Object.assign(new Error('Wrong passcode'), { code: 'bad-passcode' })
      frameApproved = true; return { approved: true, validForMs: 60_000 }
    }
    if (method === 'fastpay:forget') { framePin = null; frameKeys.clear(); frameKept.clear(); return { ok: true } }
    if (method === 'session:create' && (!framePin || !params.owner)) throw Object.assign(new Error('Turn Fast Pay on again'), { code: 'not-found' })
    if (method === 'session:sign' && String(params.transaction.data ?? '').startsWith('0x0d58b1db')) {
      if (!frameApproved) throw Object.assign(new Error('Enter your passcode'), { code: 'approval-required' })
      frameApproved = false
    }
    if (method === 'session:create') { const k = privateKeyToAccount(generatePrivateKey()); frameKeys.set(lc(k.address), k); if (params.keep) frameKept.add(lc(k.address)); return { address: k.address, kept: !!params.keep } }
    if (method === 'session:restore') return { restored: frameKeys.has(lc(params.address)) && frameKept.has(lc(params.address)) }
    if (method === 'session:sign') return { serialized: await frameKeys.get(lc(params.address))!.signTransaction(params.transaction) }
    if (method === 'session:end') { frameKeys.delete(lc(params.address)); frameKept.delete(lc(params.address)); return { ok: true } }
    throw new Error('unexpected ' + method)
  },
}))
vi.mock('@/wallet/account', () => ({ plainTransaction: (tx: any) => ({ ...tx }) }))
// Passcodes that pass in the app (security.ts verifyPasscode) reach Fast Pay through this hook.
const pinHooks: Array<(pin: string) => unknown> = []
vi.mock('./security', () => ({ onPasscodeVerified: (f: (pin: string) => unknown) => { pinHooks.push(f) } }))
const screen = { pathname: '/pay' }
vi.stubGlobal('window', { location: screen, addEventListener: () => {} })
/** The person types their passcode on the payment's PIN sheet, then it pays. */
async function enterPin(pin = PIN) { for (const f of pinHooks) await f(pin) }
async function pay(p: Parameters<typeof fp.sendFastPay>[0]) { await enterPin(); return fp.sendFastPay(p) }
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } })

const fp = await import('./fastPay')
const { PERMIT2, ARC_USDC_ERC20, permit2Abi, usdcAbi } = fp

describe('Fast Pay session', () => {
  beforeEach(() => {
    fp._resetFastPay(); mem.clear(); typedSigned.length = 0; sent.length = 0; fetchCalls.length = 0; perf.length = 0; events.length = 0
    usdcAllowanceToPermit2 = 0n; relayFails = false; failNextSetupSend = false; frameSupports = true; frameCalls.length = 0
    framePin = PIN; frameApproved = false; screen.pathname = '/pay'
    p2Left = 0n; p2Expiration = 0; frameKept.clear(); frameKeys.clear()
    Object.assign(auth, { walletSource: 'circle', isLocked: false, walletAddress: OWNER, signer: circleSigner })
  })

  it('does nothing while switched off, or for a non-Circle wallet', async () => {
    expect(await fp.maybeStartFastPay()).toBe(false)
    fp.setFastPayEnabled(true)
    auth.walletSource = 'create'
    expect(await fp.maybeStartFastPay()).toBe(false)
    expect(typedSigned).toEqual([])
  })

  it('first session: gas float first, then each Circle signature goes on-chain at once', async () => {
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(events).toEqual(['gas', 'sign:Permit', `send:${ARC_USDC_ERC20}`, 'sign:PermitSingle', `send:${PERMIT2}`])
    // USDC EIP-2612 permit: owner → Permit2, the wallet's current nonce.
    expect(typedSigned[0].domain).toEqual({ name: 'USDC', version: '2', chainId: 5042002, verifyingContract: ARC_USDC_ERC20 })
    expect(typedSigned[0].message).toMatchObject({ owner: OWNER, spender: PERMIT2, value: maxUint256, nonce: 12n })
    // Permit2 grant: USDC, $100, expiring in 2 h, to the session key.
    const grant = typedSigned[1]
    expect(grant.domain).toEqual({ name: 'Permit2', chainId: 5042002, verifyingContract: PERMIT2 })
    expect(grant.message.details).toMatchObject({ token: ARC_USDC_ERC20, amount: 100_000_000n, nonce: 0 })
    const ttl = grant.message.details.expiration - Date.now() / 1000
    expect(ttl).toBeGreaterThan(7100); expect(ttl).toBeLessThanOrEqual(7200)
    expect(fetchCalls[0]).toEqual({ action: 'fastpay_gas', address: grant.message.spender })
    expect(sent.map(t => t.nonce)).toEqual([0, 1])
    expect(decodeFunctionData({ abi: usdcAbi, data: sent[0].data! }).functionName).toBe('permit')
    expect(decodeFunctionData({ abi: permit2Abi, data: sent[1].data! }).functionName).toBe('permit')
    expect(fp.useFastPay.getState()).toMatchObject({ phase: 'ready', remaining: 99.95 }) // 0.05 kept for gas refunds
    await vi.waitFor(() => expect(perf.length).toBe(1))
    expect(perf[0]).toMatch(/^\[perf fastpay setup\] reads .*gas .*usdc-permit-onchain .*grant-onchain .*ready .*first-time Permit2 approval/)
    expect(mem.has(`meshport:fastpay-usdc-permit:${lc(OWNER)}`)).toBe(false) // used: dropped
  })

  it('set-up interrupted after Circle signed the USDC permit: the next set-up reuses it (Circle is not asked twice)', async () => {
    fp.setFastPayEnabled(true)
    failNextSetupSend = true // e.g. the app reloaded before it went on-chain
    expect(await fp.maybeStartFastPay()).toBe(false)
    expect(typedSigned.map(t => t.primaryType)).toEqual(['Permit'])
    expect(mem.has(`meshport:fastpay-usdc-permit:${lc(OWNER)}`)).toBe(true)
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(typedSigned.map(t => t.primaryType)).toEqual(['Permit', 'PermitSingle']) // only the new grant
    expect(decodeFunctionData({ abi: usdcAbi, data: sent[0].data! }).functionName).toBe('permit')
  })

  it('later sessions skip the USDC permit (Permit2 already approved): one Circle signature', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    await fp.maybeStartFastPay()
    expect(typedSigned.map(t => t.primaryType)).toEqual(['PermitSingle'])
    expect(sent.map(t => t.to)).toEqual([PERMIT2])
  })

  it('locked by the time it is ready: no session', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    const p = fp.maybeStartFastPay()
    auth.isLocked = true
    expect(await p).toBe(false)
    expect(fp.fastPayCovers(OWNER, 1)).toBe(false)
  })

  it('the session key lives in the wallet frame when the frame supports it; dropped there at the end', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(frameCalls).toEqual(['session:create', 'session:sign']) // the grant went on-chain, signed in the frame
    expect(frameKeys.size).toBe(1)
    const [frameKey] = [...frameKeys.keys()]
    expect(lc(sent[0].from)).toBe(frameKey)
    await vi.waitFor(() => expect(perf.length).toBe(1))
    expect(perf[0]).toMatch(/key in frame/)
    // A payment is signed in the frame too.
    await pay({ owner: OWNER, to: RECIPIENT, amount: 2 })
    expect(frameCalls.filter(m => m === 'session:sign').length).toBe(2)
    fp.endFastPaySession()
    await vi.waitFor(() => expect(frameKeys.size).toBe(0))
    expect(frameCalls).toContain('session:end')
  })

  it('app closed and reopened: the kept session resumes from the frame - no Circle signature, what is left read from the chain', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(typedSigned.length).toBe(1)
    const keyAddr = [...frameKeys.keys()][0]
    await vi.waitFor(() => expect(perf.length).toBe(1)) // the first set-up's line
    // On-chain now: 97 USDC left, 90 minutes to go.
    p2Left = 97_000_000n; p2Expiration = Math.floor(Date.now() / 1000) + 90 * 60
    fp._resetFastPay() // the app's memory is gone (restart); the frame kept the sealed key
    typedSigned.length = 0; perf.length = 0
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(typedSigned).toEqual([]) // no Circle signature
    expect(frameCalls).toContain('session:restore')
    expect(fp.useFastPay.getState()).toMatchObject({ phase: 'ready', remaining: 96.95 })
    await vi.waitFor(() => expect(perf.length).toBe(1))
    expect(perf[0]).toMatch(/^\[perf fastpay setup\] resumed .* 97\.00 left, key in frame/)
    // It pays with the same key, at the chain's next nonce.
    sent.length = 0
    await pay({ owner: OWNER, to: RECIPIENT, amount: 3 })
    expect(lc(sent[0].from)).toBe(keyAddr)
    expect(sent[0].nonce).toBe(5)
  })

  it('a kept session that has expired (or is nearly used up) is not resumed: it is dropped and a new one set up', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    await fp.maybeStartFastPay()
    const oldKey = [...frameKeys.keys()][0]
    p2Left = 97_000_000n; p2Expiration = Math.floor(Date.now() / 1000) + 5 * 60 // under 10 minutes left
    fp._resetFastPay()
    typedSigned.length = 0
    p2Left = 0n; p2Expiration = 0
    expect(await fp.maybeStartFastPay()).toBe(true)
    expect(typedSigned.map(t => t.primaryType)).toEqual(['PermitSingle']) // a new grant
    expect(frameKeys.has(oldKey)).toBe(false) // the old key dropped
  })

  it('the lock screen does not end it; logout / switching off does (and the saved copy goes)', async () => {
    usdcAllowanceToPermit2 = maxUint256
    fp.setFastPayEnabled(true)
    await fp.maybeStartFastPay()
    expect(mem.has(`meshport:fastpay-session:${lc(OWNER)}`)).toBe(true)
    fp.setFastPayEnabled(false)
    expect(mem.has(`meshport:fastpay-session:${lc(OWNER)}`)).toBe(false)
    await vi.waitFor(() => expect(frameKeys.size).toBe(0))
  })

  it('an older frame (no session keys, no passcode check): no Fast Pay - never a key out in the app', async () => {
    usdcAllowanceToPermit2 = maxUint256
    frameSupports = false
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(false)
    expect(typedSigned).toEqual([]) // Circle never asked
    expect(fp.fastPayCovers(OWNER, 1)).toBe(false)
  })

  it('no passcode check in the frame yet (turned on before it existed): no session until turned on again', async () => {
    usdcAllowanceToPermit2 = maxUint256
    framePin = null
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(false)
    expect(typedSigned).toEqual([])
  })

  it('turning it on hands the passcode to the frame; off makes the frame forget it and its keys', async () => {
    usdcAllowanceToPermit2 = maxUint256
    framePin = null
    await fp.enableFastPay(OWNER, '654321')
    expect(framePin).toBe('654321')
    await vi.waitFor(() => expect(fp.fastPayCovers(OWNER, 1)).toBe(true))
    // The passcode changed (Change passcode): the frame's check follows it.
    await fp.fastPayPasscodeChanged(OWNER, '654321', '111222')
    expect(framePin).toBe('111222')
    // Turned on again with a check from an older passcode: it starts clean.
    framePin = '999999'
    await fp.enableFastPay(OWNER, '111222')
    expect(framePin).toBe('111222')
    await fp.disableFastPay(OWNER)
    expect(framePin).toBeNull()
    expect(frameKeys.size).toBe(0)
    expect(fp.fastPayEnabled()).toBe(false)
  })

  it('a set-up that fails leaves no key behind in the frame', async () => {
    usdcAllowanceToPermit2 = maxUint256
    failNextSetupSend = true
    fp.setFastPayEnabled(true)
    expect(await fp.maybeStartFastPay()).toBe(false)
    await vi.waitFor(() => expect(frameKeys.size).toBe(0))
  })

  it('the refund: a payment\'s gas at today\'s price, rounded up to whole USDC units', () => {
    expect(fp.refundUnits(70_000n, GAS_PRICE, 0n)).toBe(1435n)            // 0.001435 USDC
    expect(fp.refundUnits(70_000n, GAS_PRICE, 140_000n * GAS_PRICE)).toBe(4305n) // + the set-up's gas
    expect(fp.refundUnits(1n, 1n, 0n)).toBe(1n)                            // never rounds down to nothing
  })

  describe('payments', () => {
    beforeEach(async () => { fp.setFastPayEnabled(true); await fp.maybeStartFastPay(); sent.length = 0 })

    it('covers only this wallet, within what is left (minus the refund reserve), not about to expire', () => {
      expect(fp.fastPayCovers(OWNER, 5)).toBe(true)
      expect(fp.fastPayCovers(OWNER, 99.95)).toBe(true)
      expect(fp.fastPayCovers(OWNER, 99.96)).toBe(false)
      expect(fp.fastPayCovers(RECIPIENT, 5)).toBe(false)
      expect(fp.fastPayCovers(OWNER, 0)).toBe(false)
    })

    it('a payment: one Permit2 batch - the amount to the recipient, its gas (and the set-up\'s) back to the key', async () => {
      const out = await pay({ owner: OWNER, to: RECIPIENT, amount: 12.34, idempotencyKey: 'k1' })
      expect(out.state).toBe('success')
      expect(sent[0].to).toBe(PERMIT2)
      expect(sent[0].nonce).toBe(2) // after the two set-up transactions
      const call = decodeFunctionData({ abi: permit2Abi, data: sent[0].data! })
      expect(call.functionName).toBe('transferFrom')
      const [details] = call.args as unknown as [Array<{ from: string; to: string; amount: bigint; token: string }>]
      const key = sent[0].from
      expect(details.map(d => [lc(d.from), lc(d.to), lc(d.token)])).toEqual([
        [lc(OWNER), lc(RECIPIENT), lc(ARC_USDC_ERC20)],
        [lc(OWNER), lc(key), lc(ARC_USDC_ERC20)],
      ])
      expect(details[0].amount).toBe(12_340_000n)
      const firstRefund = details[1].amount
      expect(firstRefund).toBe(fp.refundUnits(70_000n, GAS_PRICE, 140_000n * GAS_PRICE)) // pay + set-up (2 × 70k)
      // The second payment refunds only its own gas.
      await pay({ owner: OWNER, to: RECIPIENT, amount: 1 })
      const [details2] = decodeFunctionData({ abi: permit2Abi, data: sent[1].data! }).args as unknown as [Array<{ amount: bigint }>]
      expect(details2[1].amount).toBe(fp.refundUnits(70_000n, GAS_PRICE, 0n))
      expect(sent[1].nonce).toBe(3)
    })

    it('a payment needs this payment\'s passcode, checked by the frame: none, or a wrong one, sends nothing', async () => {
      // No passcode typed for it.
      await expect(fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      // A passcode typed to unlock (not on a payment screen) does not approve a payment.
      screen.pathname = '/home'
      await enterPin()
      await expect(fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      screen.pathname = '/pay'
      // The frame refuses a passcode that isn't the one it checks.
      await enterPin('000000')
      await expect(fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      // One passcode, one payment.
      await enterPin()
      await fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1 })
      await expect(fp.sendFastPay({ owner: OWNER, to: RECIPIENT, amount: 1 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      expect(sent.length).toBe(1)
      expect(fp.useFastPay.getState().remaining).toBeCloseTo(98.95)
    })

    it('the same payment retried (same idempotency key) is never sent twice', async () => {
      const a = await pay({ owner: OWNER, to: RECIPIENT, amount: 1, idempotencyKey: 'same' })
      const b = await pay({ owner: OWNER, to: RECIPIENT, amount: 1, idempotencyKey: 'same' })
      expect(b.txHash).toBe(a.txHash)
      expect(sent.length).toBe(1)
    })

    it('refused by every node (nothing sent): FastPayNotSent, and the amount and the owed set-up gas are back', async () => {
      relayFails = true
      await expect(pay({ owner: OWNER, to: RECIPIENT, amount: 30 })).rejects.toBeInstanceOf(fp.FastPayNotSent)
      expect(fp.useFastPay.getState().remaining).toBe(99.95)
      relayFails = false
      await pay({ owner: OWNER, to: RECIPIENT, amount: 1 })
      const [details] = decodeFunctionData({ abi: permit2Abi, data: sent[0].data! }).args as unknown as [Array<{ amount: bigint }>]
      expect(details[1].amount).toBe(fp.refundUnits(70_000n, GAS_PRICE, 140_000n * GAS_PRICE)) // still repays the set-up
    })

    it('session end: the key sends its leftover gas back to the relayer, then nothing is covered', async () => {
      fp.endFastPaySession()
      expect(fp.fastPayCovers(OWNER, 1)).toBe(false)
      expect(fp.useFastPay.getState().phase).toBe('off')
      await vi.waitFor(() => expect(sent.length).toBe(1))
      expect(lc(sent[0].to)).toBe(lc(RELAYER))
      expect(sent[0].value).toBe(10_000_000_000_000_000n - 21_000n * 41_000_000_000n) // 0.01 minus the transfer's gas
      expect(sent[0].data).toBeUndefined()
    })
  })
})
