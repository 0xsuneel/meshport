// supabase/functions/blockchain-indexer/scanner.test.ts
//
// Phase 3 tests for the chain-observation scanner: event decoding, the
// event-identity fix (log_index/wallet_address in the emitted event shape —
// see docs/PHASE_3_INDEXER_AUDIT.md §6/§7 for the production bug this
// guards against), and RPC retry/failure behavior via the RpcDeps injection
// seam (no real network calls). Run with:
//   deno test supabase/functions/blockchain-indexer/scanner.test.ts
//
// Zero external imports — see cursorMath.test.ts's header for why.
import { scanRange, getHead, rpcCallRace, RpcHttpError, RETRYABLE_STATUSES } from './scanner.ts'
import type { RpcDeps } from './scanner.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg ? msg + ': ' : ''}assertEquals failed\n  actual:   ${a}\n  expected: ${e}`)
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
async function assertRejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn()
  } catch {
    return
  }
  throw new Error(`expected rejection: ${msg}`)
}

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WALLET1 = '0x1111111111111111111111111111111111111111'.slice(0, 42)
const WALLET2 = '0x2222222222222222222222222222222222222222'.slice(0, 42)
const WALLET3 = '0x3333333333333333333333333333333333333333'.slice(0, 42)
const SENDER = '0x9999999999999999999999999999999999999999'.slice(0, 42)
const noSleep: RpcDeps = { sleep: async () => {} } // tests must not actually wait out backoff ladders

function pad32(addr: string): string {
  return '0x' + addr.slice(2).padStart(64, '0')
}

/** Builds a fake fetch that returns canned JSON-RPC responses in sequence per call, per URL. */
function fakeRpc(handlers: Record<string, (method: string, params: unknown[]) => unknown>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const body = JSON.parse(String(init?.body ?? '{}'))
    const handler = handlers[u]
    if (!handler) throw new Error(`fakeRpc: no handler for ${u}`)
    const result = handler(body.method, body.params)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })
  }) as unknown as typeof fetch
}

const RPC_URL = 'https://fake-rpc.test/arc'

Deno.test('scanRange: a BulkPay-shaped tx (one tx, 3 Transfer logs to 3 different wallets) emits 3 DISTINCT events with distinct log_index', async () => {
  const tokenContract = '0xTokenContract'
  const chain = {
    id: 'arc',
    rpcs: [RPC_URL],
    nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: tokenContract, decimals: 6 }],
  }
  const knownWallets = new Set([WALLET1, WALLET2, WALLET3])

  const fetchImpl = fakeRpc({
    [RPC_URL]: (method) => {
      if (method === 'eth_getLogs') {
        return [WALLET1, WALLET2, WALLET3].map((w, i) => ({
          address: tokenContract,
          topics: [TRANSFER_TOPIC0, pad32(SENDER), pad32(w)],
          data: '0x' + (1_000_000).toString(16), // 1.0 USDC @ 6 decimals
          transactionHash: '0xbulkpaytx',
          blockNumber: '0x64', // 100
          blockHash: '0xblockhash100',
          logIndex: '0x' + i.toString(16),
          transactionIndex: '0x0',
        }))
      }
      // scanRange always runs the native block scan too, regardless of
      // token config — must answer it, or the whole range is (correctly,
      // per safeAdvance) held back as unverified and every event gets
      // filtered out by the final safeUpTo cut, which is not what this test
      // is checking. An empty transactions array is a genuine "nothing
      // native happened in this block", not a failure.
      if (method === 'eth_getBlockByNumber') return { hash: '0xblockhash100', transactions: [] }
      throw new Error(`unexpected method ${method}`)
    },
  })

  const outcome = await scanRange(chain, 100, 100, knownWallets, { fetchImpl, ...noSleep })

  assertEquals(outcome.events.length, 3, 'expected 3 distinct transfer_detected events, one per recipient')

  const logIndices = outcome.events.map(e => e.log_index).sort()
  assertEquals(logIndices, [0, 1, 2], 'each event must carry its own log_index')

  const wallets = outcome.events.map(e => e.wallet_address).sort()
  assertEquals(wallets, [WALLET1, WALLET2, WALLET3].sort())

  // This is the concrete property that makes the chain_events dedup index
  // fix correct: all 3 events share (event_type, chain_id, tx_hash,
  // block_number) — the OLD index's full key — but are still 3 GENUINELY
  // DIFFERENT events. Only log_index (+ wallet_address) tells them apart.
  const oldIndexKeys = outcome.events.map(e => `${e.event_type}:${e.chain_id}:${e.tx_hash}:${e.block_number}`)
  assert(new Set(oldIndexKeys).size === 1, 'sanity check: all 3 events must collide under the OLD (pre-fix) index key')
  const newIndexKeys = outcome.events.map(e => `${e.event_type}:${e.chain_id}:${e.tx_hash}:${e.wallet_address}:${e.log_index}`)
  assert(new Set(newIndexKeys).size === 3, 'the NEW index key must distinguish all 3 events')

  for (const e of outcome.events) {
    assertEquals(e.contract_address, tokenContract)
    assertEquals(e.event_signature, 'Transfer(address,address,uint256)')
    assertEquals(e.block_hash, '0xblockhash100')
  }
})

Deno.test('scanRange: SAME recipient receiving TWO separate Transfer logs in ONE tx are two distinct events, distinguished only by log_index', async () => {
  const tokenContract = '0xTokenContract'
  const chain = { id: 'arc', rpcs: [RPC_URL], nativeTransferLogContract: null, tokens: [{ symbol: 'USDC', contract: tokenContract, decimals: 6 }] }
  const knownWallets = new Set([WALLET1])

  const fetchImpl = fakeRpc({
    [RPC_URL]: (method) => {
      if (method === 'eth_getLogs') {
        // Two separate transfer() calls to the SAME wallet in the same tx —
        // e.g. a contract that pays out in two installments within one
        // transaction. Real, distinct on-chain events, not a duplicate.
        return [0, 1].map(i => ({
          address: tokenContract,
          topics: [TRANSFER_TOPIC0, pad32(SENDER), pad32(WALLET1)],
          data: '0x' + (500_000).toString(16), // 0.5 USDC each
          transactionHash: '0xtwolegstx',
          blockNumber: '0x64',
          blockHash: '0xblockhash100',
          logIndex: '0x' + i.toString(16),
          transactionIndex: '0x0',
        }))
      }
      if (method === 'eth_getBlockByNumber') return { hash: '0xblockhash100', transactions: [] }
      throw new Error(`unexpected method ${method}`)
    },
  })

  const outcome = await scanRange(chain, 100, 100, knownWallets, { fetchImpl, ...noSleep })

  assertEquals(outcome.events.length, 2, 'two separate Transfer logs to the same wallet must produce two events, not be collapsed into one')
  const logIndices = outcome.events.map(e => e.log_index).sort()
  assertEquals(logIndices, [0, 1])
  // Both events share every field EXCEPT log_index — this is exactly the
  // case the chain_events dedup index fix depends on: without log_index in
  // the identity, these two legitimate events would collide and one would
  // be silently dropped at the database layer.
  const oldIndexKeys = outcome.events.map(e => `${e.event_type}:${e.chain_id}:${e.tx_hash}:${e.wallet_address}`)
  assert(new Set(oldIndexKeys).size === 1, 'sanity check: both events share every field except log_index')
})


Deno.test('scanRange: native top-level transfer has log_index null (no log exists), still captures block_hash/transaction_index for free', async () => {
  // A benign token is included so the ERC-20 log-scan loop actually runs
  // once (producing a real, successful chunk result) rather than leaving
  // logResults empty — safeAdvance(from, []) resolves to `from - 1` by
  // design (an unscanned range must never read as a verified one), which
  // would otherwise hold safeUpTo below this test's block and filter out
  // the very event being tested for reasons unrelated to what this test
  // checks. Production's one enabled chain (Arc) always has real tokens
  // configured, so this is a test-fixture correction, not a production fix.
  const tokenContract = '0xTokenContract'
  const chain = { id: 'arc', rpcs: [RPC_URL], nativeTransferLogContract: null, tokens: [{ symbol: 'EURC', contract: tokenContract, decimals: 6 }] }
  const knownWallets = new Set([WALLET1])

  const fetchImpl = fakeRpc({
    [RPC_URL]: (method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          hash: '0xblockhash200',
          transactions: [
            { to: WALLET1, from: SENDER, value: '0x' + (2_000000000000000000n).toString(16), hash: '0xnativetx', transactionIndex: '0x3' },
          ],
        }
      }
      if (method === 'eth_getLogs') return [] // nothing on the EURC contract in this range
      throw new Error(`unexpected method ${method}`)
    },
  })

  const outcome = await scanRange(chain, 200, 200, knownWallets, { fetchImpl, ...noSleep })
  assertEquals(outcome.events.length, 1)
  const e = outcome.events[0]
  assertEquals(e.log_index, null)
  assertEquals(e.contract_address, null)
  assertEquals(e.event_signature, null)
  assertEquals(e.block_hash, '0xblockhash200')
  assertEquals(e.transaction_index, 3)
})

Deno.test('scanRange: a mid-range chunk failure holds safeUpTo BELOW the failure — never skips it', async () => {
  const tokenContract = '0xTokenContract'
  const chain = { id: 'arc', rpcs: [RPC_URL], nativeTransferLogContract: null, tokens: [{ symbol: 'EURC', contract: tokenContract, decimals: 6 }] }
  const knownWallets = new Set([WALLET1])

  // Block 101 always fails; everything else succeeds.
  const fetchImpl = fakeRpc({
    [RPC_URL]: (method, params) => {
      if (method === 'eth_getBlockByNumber') {
        const bn = parseInt(String((params as any[])[0]), 16)
        if (bn === 101) throw new Error('simulated RPC failure at block 101')
        return { hash: `0xblockhash${bn}`, transactions: [] }
      }
      if (method === 'eth_getLogs') return []
      throw new Error(`unexpected method ${method}`)
    },
  })

  const outcome = await scanRange(chain, 100, 103, knownWallets, { fetchImpl, ...noSleep })
  // Must stop strictly below 101 — the failed block — regardless of 102/103
  // having succeeded independently in their own concurrent batch slot.
  assert(outcome.safeUpTo < 101, `expected safeUpTo < 101 (the failed block), got ${outcome.safeUpTo}`)
})

Deno.test('rpcCallRace: retries a 429 and succeeds on a later attempt, without ever advancing past what it could not read', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    if (calls < 3) return new Response('rate limited', { status: 429 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x64' }), { status: 200 })
  }) as unknown as typeof fetch

  const result = await rpcCallRace([RPC_URL], 'eth_blockNumber', [], { fetchImpl, ...noSleep })
  assertEquals(result, '0x64')
  assert(calls === 3, `expected exactly 3 attempts, got ${calls}`)
})

Deno.test('rpcCallRace: a deterministic 400 fails fast — no retry ladder burned on a non-retryable error', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response('bad request', { status: 400 })
  }) as unknown as typeof fetch

  await assertRejects(
    () => rpcCallRace([RPC_URL], 'eth_blockNumber', [], { fetchImpl, ...noSleep }),
    'expected rpcCallRace to reject on a deterministic 400',
  )
  assertEquals(calls, 1, 'a 400 is not retryable — must fail on the first attempt, not retry')
})

Deno.test('rpcCallRace: exhausting the retry ladder on a retryable status still throws (cursor safety — caller must see failure)', async () => {
  const fetchImpl = (async () => new Response('server error', { status: 503 })) as unknown as typeof fetch
  await assertRejects(
    () => rpcCallRace([RPC_URL], 'eth_blockNumber', [], { fetchImpl, ...noSleep }),
    'expected rpcCallRace to eventually throw when every attempt returns a retryable failure',
  )
})

Deno.test('RETRYABLE_STATUSES: exactly the closed whitelist documented in scanner.ts', () => {
  assertEquals([...RETRYABLE_STATUSES].sort(), [429, 500, 502, 503, 504])
})

Deno.test('getHead: best-effort max across endpoints, one endpoint failing does not fail the call', async () => {
  const goodUrl = 'https://fake-rpc.test/good'
  const badUrl = 'https://fake-rpc.test/bad'
  const fetchImpl = (async (url: string | URL) => {
    if (String(url) === badUrl) throw new Error('endpoint down')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1f4' }), { status: 200 }) // 500
  }) as unknown as typeof fetch

  const head = await getHead([badUrl, goodUrl], { fetchImpl, ...noSleep })
  assertEquals(head, 500)
})

Deno.test('getHead: throws only when EVERY endpoint fails', async () => {
  const fetchImpl = (async () => { throw new Error('down') }) as unknown as typeof fetch
  await assertRejects(() => getHead(['https://a.test', 'https://b.test'], { fetchImpl, ...noSleep }), 'expected getHead to throw when all endpoints fail')
})
