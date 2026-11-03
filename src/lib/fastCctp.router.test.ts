import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recoverTypedDataAddress, pad, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// Transfer USDC from Arc through MeshPortRouter (lib/fastCctp routerBurn):
// ONE signature (an EIP-3009 authorization for exactly amount + fee to the
// router), submitted by MeshPort's relayer - no approve, no wallet transaction.
const ROUTER = '0x7777777777777777777777777777777777777777' as Hex
vi.stubEnv('VITE_ARC_ROUTER', ROUTER)

const GAS_PRICE = 20_000_000_000n // 20 gwei (Arc gas is USDC, 18 dp)
const send = vi.fn()
const iris = vi.fn()
vi.mock('./arc', () => ({ arcRpcJson: async () => ({ result: '0x0' }) }))
vi.mock('./arcService', () => ({ relayArcSend: (...a: any[]) => send(...a), waitForConfirmation: async () => ({ state: 'success' }), currentGasPrice: async () => GAS_PRICE }))
vi.mock('./cctpTracker', async (orig) => ({ ...(await orig<any>()), fetchIrisMessage: (...a: any[]) => iris(...a) }))
vi.mock('./cctpRecovery', () => ({ finishCctpMintViaRelayer: async () => null }))
vi.mock('@/lib/supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))

let relayAnswer: () => Promise<Response>
const relayed: any[] = []
vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { relayed.push(JSON.parse(String(init.body))); return relayAnswer() }))

const { fastCctpTransfer, routerFee, ARC_USDC, FastCctpError } = await import('./fastCctp')
const { bridgeNonce, FORWARD_HOOK } = await import('./gaslessBridge')

const owner = privateKeyToAccount(generatePrivateKey())
const TO = '0x2222222222222222222222222222222222222222'
const H = (n: number) => ('0x' + String(n).padStart(64, '0')) as Hex
const base = (o: any = {}) => ({
  account: owner as any, destination: 'Base_Sepolia', recipient: TO, amount: '10', maxFee: '0.1',
  speed: 'FAST' as const, useForwarder: true, onStep: vi.fn(), pollMs: 1, ...o,
})

describe('Transfer from Arc through MeshPortRouter: one signature', () => {
  beforeEach(() => {
    send.mockReset(); iris.mockReset(); relayed.length = 0
    relayAnswer = async () => new Response(JSON.stringify({ txHash: H(9) }), { status: 200 })
    iris.mockResolvedValue({ status: 'complete', message: '0xab', attestation: '0xcd', forwardState: 'COMPLETE', forwardTxHash: H(3) })
  })

  it('signs one authorization for exactly amount + fee to the router; the relayer sends it; no wallet transaction', async () => {
    const onStep = vi.fn()
    const r = await fastCctpTransfer(base({ onStep }))
    expect(send).not.toHaveBeenCalled() // no approve, no burn transaction from the wallet
    expect(relayed).toHaveLength(1)
    const { bridge, authorization } = relayed[0]
    expect(relayed[0].action).toBe('arc_transfer')
    const fee = routerFee(GAS_PRICE, 10_000_000n)
    expect(bridge).toMatchObject({ token: ARC_USDC, destinationDomain: 6, fee: fee.toString(), maxFee: '100000', minFinalityThreshold: 1000, hookData: FORWARD_HOOK })
    expect(bridge.mintRecipient.toLowerCase()).toBe(pad(TO as Hex, { size: 32 }).toLowerCase())
    expect(authorization.value).toBe((10_000_000n + fee).toString())
    // The signature is the owner's, over a nonce that binds every parameter.
    const nonce = bridgeNonce({ ...bridge, fee: BigInt(bridge.fee), maxFee: BigInt(bridge.maxFee) }, 5042002, ROUTER)
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: ARC_USDC },
      types: { ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'ReceiveWithAuthorization',
      message: { from: owner.address, to: ROUTER, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce },
      signature: authorization.signature,
    })
    expect(signer).toBe(owner.address)
    expect(onStep.mock.calls.map(c => c[0])).toEqual(['approve', 'burn', 'attestation', 'mint'])
    expect(r.steps.find(s => s.name === 'burn')?.txHash).toBe(H(9))
  })

  it('the fee: 0.2% of the amount, min $0.05, cap $5 - never below the gas × 1.15', () => {
    expect(routerFee(GAS_PRICE, 10_000_000n)).toBe(50_000n)          // $10 → 0.2% = $0.02 → the $0.05 minimum
    expect(routerFee(GAS_PRICE, 1_000_000_000n)).toBe(2_000_000n)    // $1,000 → $2
    expect(routerFee(GAS_PRICE, 10_000_000_000n)).toBe(5_000_000n)   // $10,000 → $20 → the $5 cap
    // Gas alone above the cap (absurd gas price): the fee follows the gas, × 1.15 - never a loss.
    const hugeGas = 100_000_000_000_000n // 100k gwei: 300k gas = 30 USDC
    expect(routerFee(hugeGas, 10_000_000_000n)).toBe(34_500_000n)
  })

  it('refused by the relayer (bad fee, not signed in…): nothing was sent', async () => {
    relayAnswer = async () => new Response(JSON.stringify({ error: 'Fee too low - please try again' }), { status: 400 })
    const e = await fastCctpTransfer(base()).catch(x => x)
    expect(e).toBeInstanceOf(FastCctpError)
    expect(e.kind).toBe('not_sent')
    expect(e.message).toMatch(/Fee too low/)
  })

  it('the answer lost twice: it may have gone out - "check Activity", never "nothing was sent"', async () => {
    relayAnswer = async () => { throw new TypeError('Failed to fetch') }
    const e = await fastCctpTransfer(base()).catch(x => x)
    expect(e.kind).toBe('settling')
    expect(relayed).toHaveLength(2) // one retry with the same authorization (the relayer answers a repeat with the same tx)
    expect(relayed[0]).toEqual(relayed[1])
  })
})
