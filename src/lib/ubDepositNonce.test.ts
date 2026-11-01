// Field 1 Nov 05:43 and 06:07: the second Unified Balance deposit on a page
// hung on "deposit". Circle's adapter counts nonces itself for the session
// (adapter-ethers-v6 SHARED_NONCE_STATES); MeshPort's own Arc sends (Pay, the
// direct USDC transfer) move the chain on, so the next kit deposit reused a
// nonce. The relay answered that "nonce too low" as "sent" and the kit waited
// forever for its receipt. Now the relay rejects it (api/arc-rpc sendAndWait)
// and Circle's adapter re-syncs and sends again - run here through Circle's
// real kit, our adapter and the page's Arc provider, on a simulated Arc.
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { keccak256, encodeAbiParameters, parseTransaction } from 'viem'

vi.mock('@/lib/errorReport', () => ({ reportClientError: vi.fn() }))
const et = new EventTarget()
vi.stubGlobal('window', Object.assign(et, { location: { origin: 'https://meshport.xyz' } }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))


const log: string[] = []
let nonce = 0, block = 1000
const receipts = new Map<string, any>()
const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s])
function answer(method: string, params: any[]): any {
  switch (method) {
    case 'eth_chainId': return '0x4cef52'
    case 'eth_blockNumber': return '0x' + (block++).toString(16)
    case 'eth_getBlockByNumber': return { number: '0x' + block.toString(16), hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), baseFeePerGas: '0x4a817c800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', nonce: '0x0000000000000000', extraData: '0x' }
    case 'eth_gasPrice': return '0x4a817c800'
    case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
    case 'eth_getTransactionCount': return '0x' + nonce.toString(16)
    case 'eth_estimateGas': return '0x30000'
    case 'eth_getBalance': return '0x' + (10n ** 21n).toString(16)
    case 'eth_getCode': return '0x'
    case 'eth_call': {
      const d: string = params[0].data ?? params[0].input ?? '0x'
      const sel = d.slice(0, 10)
      if (sel === '0x70a08231') return word(1000_000_000n)  // balanceOf
      if (sel === '0x06fdde03') return str('USDC')          // name
      if (sel === '0x54fd4d50') return str('2')             // version
      if (sel === '0x7ecebe00') return word(BigInt(nonce))  // nonces
      if (sel === '0x313ce567') return word(6n)             // decimals
      return word(0n)
    }
    case 'eth_sendRawTransaction':
    case 'meshport_sendRawTransactionAndWait': {
      const raw = params[0]; const hash = keccak256(raw)
      const txNonce = parseTransaction(raw).nonce ?? 0
      if (txNonce < nonce && !receipts.has(hash)) {
        // Arc: this nonce is already used by another transaction.
        if (method === 'eth_sendRawTransaction') throw Object.assign(new Error('nonce too low'), { rpc: { code: -32000, message: 'nonce too low' } })
        // The relay's answer for a nonce another transaction used (api/arc-rpc sendAndWait).
        throw Object.assign(new Error('nonce too low'), { rpc: { code: -32003, message: 'nonce too low: next nonce ' + nonce } }) // new relay
      }
      nonce++
      receipts.set(hash, { transactionHash: hash, blockNumber: '0x' + block.toString(16), blockHash: '0x' + '33'.repeat(32), status: '0x1', logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: '0x' + '00'.repeat(20), to: '0x' + '00'.repeat(20), transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), contractAddress: null, type: '0x2' })
      return method === 'eth_sendRawTransaction' ? hash : { hash, status: 'success', blockNumber: '0x' + block.toString(16), broadcast: 'sent' }
    }
    case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null
    case 'eth_getTransactionByHash': { const r = receipts.get(params[0]); return r ? { hash: params[0], blockNumber: r.blockNumber, blockHash: r.blockHash, from: r.from, to: r.to, nonce: '0x0', gas: '0x30000', value: '0x0', input: '0x', transactionIndex: '0x0', type: '0x2', chainId: '0x4cef52', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', v: '0x0', r: '0x1', s: '0x1' } : null }
    default: return null
  }
}
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body)
  const one = (b: any) => {
    log.push(`${String(url).replace(/^https?:\/\/[^/]+/, '')} ${b.method}`)
    try { return { jsonrpc: '2.0', id: b.id, result: answer(b.method, b.params ?? []) } } catch (e: any) { log.push('   -> ' + e.rpc.message); return { jsonrpc: '2.0', id: b.id, error: e.rpc } }
  }
  const out = Array.isArray(body) ? body.map(one) : one(body)
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
}))

describe('UB deposit twice on one page', () => {
  it('the second deposit completes after an outside Arc send (stale nonce re-synced)', async () => {
    nonce = 0; receipts.clear()
    const { createWalletAdapter } = await import('@/wallet/account')
    const { arcKitProvider } = await import('@/lib/arcRelaySend')
    const { JsonRpcProvider } = await import('ethers')
    const { AppKit } = await import('@circle-fin/app-kit')
    const local = privateKeyToAccount(generatePrivateKey())
    const account = Object.assign(local, { meshportWallet: true }) as any
    const provider = arcKitProvider(new JsonRpcProvider('https://meshport.xyz/api/arc-rpc', { chainId: 5042002, name: 'arc-testnet' }, { staticNetwork: true, pollingInterval: 200 }))
    const kit = new AppKit({ disableErrorReporting: true, disableAnalytics: true } as any)
    const results: string[] = []
    for (const n of [1, 2]) {
      // Between the two: MeshPort's own direct transfer (approve + burn) uses two nonces.
      if (n === 2) nonce += 2
      const adapter = await createWalletAdapter({ account, getProvider: () => provider })
      log.length = 0
      const t = Date.now()
      const r = await Promise.race([
        kit.unifiedBalance.deposit({ from: { adapter, chain: 'Arc_Testnet' as any }, amount: '1.000000', token: 'USDC', allowanceStrategy: 'permit' } as any).then(() => 'ok', (e: any) => 'error: ' + (e?.message ?? e)),
        new Promise(r => setTimeout(() => r('HUNG'), 15_000)),
      ])
      void t
      results.push(String(r))
    }
    expect(results).toEqual(['ok', 'ok'])
  }, 60_000)
})
