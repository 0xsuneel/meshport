/**
 * Regression tests for lib/arcDepositWatcher.ts — the real-time Arc
 * eth_subscribe(logs) deposit layer that closes the "balance updates before
 * the incoming transfer appears in Activity History" gap.
 *
 * Two halves:
 *   1. The pure decode/classify/shape helpers — exhaustively, since the
 *      decimal handling (native USDC 18, EURC 6, cirBTC 8) and the
 *      swap/bridge/self/mint exclusions are where a real deposit would be
 *      dropped or a spurious one surfaced.
 *   2. The watcher wired to a fake WebSocket + fake JSON-RPC proxy, covering
 *      the scenarios from the task's own list: external native/EURC/cirBTC
 *      transfers, two in quick succession, duplicate socket frames,
 *      disconnect→reconnect with eth_getLogs catch-up, self-transfer, swap
 *      output, bridge/mint output, malformed frames, and stop().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TRANSFER_TOPIC0,
  WATCHED_STREAMS,
  topicToAddress,
  paddedAddressTopic,
  decodeDepositLog,
  classifyDeposit,
  decodedToOnchainTx,
  logDedupeKey,
  createArcDepositWatcher,
  arcDepositWatcher,
  getRecentArcDeposits,
  clearRecentArcDeposits,
  hydrateRecentDeposits,
  type WatchedStream,
} from '@/lib/arcDepositWatcher'

const WALLET  = '0x1111111111111111111111111111111111111111'
const SENDER  = '0x2222222222222222222222222222222222222222'
const ZERO    = '0x0000000000000000000000000000000000000000'
// Kit Adapter — a swap output leg's `from` (in KNOWN_INTERNAL_CONTRACTS).
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

const USDC_STREAM   = WATCHED_STREAMS.find(s => s.tokenSymbol === 'USDC')!   as WatchedStream
const EURC_STREAM   = WATCHED_STREAMS.find(s => s.tokenSymbol === 'EURC')!   as WatchedStream
const CIRBTC_STREAM = WATCHED_STREAMS.find(s => s.tokenSymbol === 'cirBTC')! as WatchedStream

/** A 32-byte, left-padded address topic. */
const addrTopic = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
/** A uint256 as a 32-byte hex data field. */
const uintData  = (v: bigint) => '0x' + v.toString(16).padStart(64, '0')

/** A raw Transfer log as an Arc node delivers it (getLogs item / subscription result). */
function transferLog(over: {
  from?: string; to?: string; value?: bigint
  txHash?: string; blockNumber?: number; logIndex?: number
  topic0?: string; data?: string; removed?: boolean
} = {}) {
  return {
    topics: [
      over.topic0 ?? TRANSFER_TOPIC0,
      addrTopic(over.from ?? SENDER),
      addrTopic(over.to ?? WALLET),
    ],
    // Default to a non-zero 1-unit-of-18-decimals value so a log built with
    // no explicit `value` still decodes; zero-value tests pass `value: 0n`.
    data: over.data ?? uintData(over.value ?? 1_000_000_000_000_000_000n),
    transactionHash: over.txHash ?? '0xabc0000000000000000000000000000000000000000000000000000000000001',
    blockNumber: '0x' + (over.blockNumber ?? 100).toString(16),
    logIndex: '0x' + (over.logIndex ?? 0).toString(16),
    ...(over.removed !== undefined ? { removed: over.removed } : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('topicToAddress / paddedAddressTopic', () => {
  it('round-trips a padded address topic back to a 0x address', () => {
    expect(topicToAddress(addrTopic(WALLET))).toBe(WALLET.toLowerCase())
  })
  it('pads a wallet to a 66-char (0x + 64) topic, lower-cased', () => {
    const t = paddedAddressTopic('0xAbCdEf0000000000000000000000000000000001')
    expect(t).toHaveLength(66)
    expect(t).toBe('0x000000000000000000000000abcdef0000000000000000000000000000000001')
  })
  it('returns "" for a malformed / short topic', () => {
    expect(topicToAddress('0x1234')).toBe('')
    expect(topicToAddress(undefined)).toBe('')
    expect(topicToAddress(null)).toBe('')
  })
})

describe('decodeDepositLog — decimals per token', () => {
  it('native USDC uses 18 decimals', () => {
    // 20.5 USDC = 20.5 * 1e18
    const d = decodeDepositLog(transferLog({ value: 20_500_000_000_000_000_000n }), USDC_STREAM)
    expect(d).not.toBeNull()
    expect(d!.amount).toBe(20.5)
    expect(d!.tokenSymbol).toBe('USDC')
    expect(d!.from).toBe(SENDER.toLowerCase())
    expect(d!.to).toBe(WALLET.toLowerCase())
  })
  it('EURC uses 6 decimals', () => {
    const d = decodeDepositLog(transferLog({ value: 10_250_000n }), EURC_STREAM) // 10.25
    expect(d!.amount).toBe(10.25)
    expect(d!.tokenSymbol).toBe('EURC')
  })
  it('cirBTC uses 8 decimals, small amounts keep precision', () => {
    const d = decodeDepositLog(transferLog({ value: 10_000n }), CIRBTC_STREAM) // 0.0001
    expect(d!.amount).toBe(0.0001)
    expect(d!.amount).toBeGreaterThan(0)
    expect(d!.tokenSymbol).toBe('cirBTC')
  })
  it('carries block number and log index through as numbers', () => {
    const d = decodeDepositLog(transferLog({ blockNumber: 4096, logIndex: 7 }), USDC_STREAM)
    expect(d!.blockNumber).toBe(4096)
    expect(d!.logIndex).toBe(7)
  })
})

describe('decodeDepositLog — malformed / non-Transfer input returns null (never throws)', () => {
  it('null / non-object', () => {
    expect(decodeDepositLog(null, USDC_STREAM)).toBeNull()
    expect(decodeDepositLog(undefined, USDC_STREAM)).toBeNull()
  })
  it('wrong topic0 (a different event)', () => {
    expect(decodeDepositLog(transferLog({ topic0: '0xdeadbeef' }), USDC_STREAM)).toBeNull()
  })
  it('missing recipient topic', () => {
    const raw: any = transferLog()
    raw.topics = [TRANSFER_TOPIC0, addrTopic(SENDER)] // no topics[2]
    expect(decodeDepositLog(raw, USDC_STREAM)).toBeNull()
  })
  it('zero-value transfer', () => {
    expect(decodeDepositLog(transferLog({ value: 0n }), USDC_STREAM)).toBeNull()
  })
  it('unparseable data', () => {
    expect(decodeDepositLog(transferLog({ data: '0xnothex' }), USDC_STREAM)).toBeNull()
  })
  it('a reorg-removed log', () => {
    expect(decodeDepositLog(transferLog({ value: 1n, removed: true }), USDC_STREAM)).toBeNull()
  })
})

describe('classifyDeposit — mirrors the server decide.ts acceptance rules', () => {
  const decoded = (over: Partial<ReturnType<typeof decodeDepositLog>> = {}) => ({
    txHash: '0xhash', logIndex: 0, blockNumber: 100,
    from: SENDER.toLowerCase(), to: WALLET.toLowerCase(),
    amount: 5, tokenSymbol: 'USDC', ...over,
  }) as NonNullable<ReturnType<typeof decodeDepositLog>>

  it('accepts a genuine external deposit from another EOA', () => {
    expect(classifyDeposit(decoded(), WALLET)).toEqual({ accept: true })
  })
  it('rejects a self-transfer (from === wallet)', () => {
    expect(classifyDeposit(decoded({ from: WALLET.toLowerCase() }), WALLET))
      .toEqual({ accept: false, reason: 'self_transfer' })
  })
  it('rejects a mint / zero-address sender (CCTP claim / bridge output)', () => {
    expect(classifyDeposit(decoded({ from: ZERO }), WALLET))
      .toEqual({ accept: false, reason: 'mint_or_zero_sender' })
  })
  it('rejects a known internal-contract sender (swap output leg)', () => {
    expect(classifyDeposit(decoded({ from: KIT_ADAPTER }), WALLET))
      .toEqual({ accept: false, reason: 'internal_contract_sender' })
  })
  it('rejects a transfer whose recipient is a different wallet', () => {
    expect(classifyDeposit(decoded({ to: SENDER.toLowerCase() }), WALLET))
      .toEqual({ accept: false, reason: 'wrong_recipient' })
  })
  it('rejects a non-positive amount', () => {
    expect(classifyDeposit(decoded({ amount: 0 }), WALLET))
      .toEqual({ accept: false, reason: 'non_positive_amount' })
  })
  it('rejects a missing tx hash', () => {
    expect(classifyDeposit(decoded({ txHash: '' }), WALLET))
      .toEqual({ accept: false, reason: 'missing_tx_hash' })
  })
})

describe('decodedToOnchainTx / logDedupeKey', () => {
  it('shapes an OnchainReceivedTx the merge expects, always confirmed', () => {
    const d = decodeDepositLog(transferLog({ value: 3_000_000n }), EURC_STREAM)!
    const tx = decodedToOnchainTx(d, '2026-09-06T00:00:00.000Z')
    expect(tx).toEqual({
      txHash: d.txHash,
      fromAddress: SENDER.toLowerCase(),
      tokenSymbol: 'EURC',
      amount: 3,
      status: 'confirmed',
      timestamp: '2026-09-06T00:00:00.000Z',
    })
  })
  it('dedupe key combines tx hash and log index', () => {
    const d = decodeDepositLog(transferLog({ txHash: '0xdead', logIndex: 4 }), USDC_STREAM)!
    expect(logDedupeKey(d)).toBe('0xdead:4')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Watcher — fake WebSocket + fake JSON-RPC proxy
// ─────────────────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  url: string
  sent: any[] = []
  readyState = 0 // CONNECTING
  onopen: ((e?: any) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e?: any) => void) | null = null
  onclose: ((e?: any) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(payload: string) { this.sent.push(JSON.parse(payload)) }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({}) }

  // ── test drivers ──
  open() { this.readyState = 1; this.onopen?.({}) }
  message(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  rawMessage(data: string) { this.onmessage?.({ data }) }
  error() { this.onerror?.({}) }
  /** Ack every pending eth_subscribe with a distinct subscription id. */
  ackAllSubscribes() {
    for (const req of this.sent.filter(m => m.method === 'eth_subscribe')) {
      this.message({ jsonrpc: '2.0', id: req.id, result: `0xsub-${req.id}` })
    }
  }
  subIdForStreamAddress(address: string): string | null {
    const req = this.sent.find(m => m.method === 'eth_subscribe' && m.params?.[1]?.address?.toLowerCase() === address.toLowerCase())
    return req ? `0xsub-${req.id}` : null
  }
}

/** A JSON-RPC proxy stub. `logsByRange` lets a test seed catch-up results. */
function makeRpc(opts: { head?: number; blockTimestamp?: number; getLogs?: (params: any) => any[] } = {}) {
  const head = opts.head ?? 1000
  const calls: any[] = []
  const rpc = vi.fn(async (body: any) => {
    calls.push(body)
    switch (body.method) {
      case 'eth_blockNumber':
        return { result: '0x' + head.toString(16) }
      case 'eth_getBlockByNumber':
        return { result: { timestamp: '0x' + (opts.blockTimestamp ?? 1_757_000_000).toString(16) } }
      case 'eth_getLogs':
        return { result: opts.getLogs ? opts.getLogs(body.params?.[0]) : [] }
      default:
        return { result: null }
    }
  })
  return { rpc, calls }
}

/**
 * Let the watcher's async connect()/catchUp() chain settle. Uses real
 * macrotask ticks (the injected setTimeoutFn only captures the watcher's OWN
 * reconnect timer, not global setTimeout) so a multi-await RPC chain fully
 * drains before assertions run.
 */
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) }

interface Recorded { txs: any[]; source: 'live' | 'catchup' }

function makeDeps(opts: { rpcOpts?: Parameters<typeof makeRpc>[0] } = {}) {
  FakeWebSocket.instances = []
  const { rpc, calls } = makeRpc(opts.rpcOpts)
  const store = new Map<string, string>()
  const timers: Array<{ fn: () => void; ms: number }> = []
  const intervals: Array<{ fn: () => void; ms: number }> = []
  let clock = 1_757_000_000_000

  const deps = {
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    rpcJson: rpc,
    storage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    },
    setTimeoutFn: (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimeoutFn: (h: any) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    setIntervalFn: (fn: () => void, ms: number) => { const t = { fn, ms }; intervals.push(t); return t },
    clearIntervalFn: (h: any) => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1) },
    now: () => clock,
  }
  return { deps, rpc, rpcCalls: calls, store, timers, intervals, advance: (ms: number) => { clock += ms }, sockets: FakeWebSocket.instances }
}

function setup(rpcOpts?: Parameters<typeof makeRpc>[0]) {
  const base = makeDeps({ rpcOpts })
  const deposits: any[][] = []
  const recorded: Recorded[] = []
  const watcher = createArcDepositWatcher({
    walletAddress: WALLET,
    onDeposits: (txs, source) => { deposits.push(txs); recorded.push({ txs, source }) },
    deps: base.deps,
  })
  return { ...base, watcher, deposits, recorded }
}

/** Bring a fresh watcher fully online: connect → open → subscribe acks. */
async function online(s: ReturnType<typeof setup>) {
  s.watcher.start()
  await flush()
  const ws = s.sockets[s.sockets.length - 1]
  ws.open()
  ws.ackAllSubscribes()
  await flush()
  return ws
}

/** Emit a live Transfer notification for a given stream on the socket. */
function emitTransfer(ws: FakeWebSocket, stream: WatchedStream, log: ReturnType<typeof transferLog>) {
  const subId = ws.subIdForStreamAddress(stream.address)!
  ws.message({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: subId, result: log } })
}

describe('createArcDepositWatcher — live subscription', () => {
  it('subscribes to all three streams with the wallet-scoped Transfer filter', async () => {
    const s = setup()
    await online(s)
    const subs = s.sockets[0].sent.filter(m => m.method === 'eth_subscribe')
    expect(subs).toHaveLength(3)
    for (const sub of subs) {
      expect(sub.params[0]).toBe('logs')
      expect(sub.params[1].topics[0]).toBe(TRANSFER_TOPIC0)
      expect(sub.params[1].topics[2]).toBe(paddedAddressTopic(WALLET))
    }
    expect(subs.map(x => x.params[1].address.toLowerCase()).sort())
      .toEqual(WATCHED_STREAMS.map(x => x.address.toLowerCase()).sort())
  })

  it('surfaces an external native USDC transfer from another EOA immediately', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 42_000_000_000_000_000_000n, txHash: '0xnative1' }))
    await flush()
    expect(s.deposits).toHaveLength(1)
    expect(s.deposits[0][0]).toMatchObject({
      txHash: '0xnative1', tokenSymbol: 'USDC', amount: 42, fromAddress: SENDER.toLowerCase(), status: 'confirmed',
    })
  })

  it('surfaces an external EURC transfer', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, EURC_STREAM, transferLog({ value: 7_500_000n, txHash: '0xeurc1' }))
    await flush()
    expect(s.deposits[0][0]).toMatchObject({ tokenSymbol: 'EURC', amount: 7.5, txHash: '0xeurc1' })
  })

  it('surfaces an external cirBTC transfer', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, CIRBTC_STREAM, transferLog({ value: 250_000n, txHash: '0xbtc1' })) // 0.0025
    await flush()
    expect(s.deposits[0][0]).toMatchObject({ tokenSymbol: 'cirBTC', amount: 0.0025, txHash: '0xbtc1' })
  })

  it('handles two deposits in quick succession', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xq1', logIndex: 0 }))
    emitTransfer(ws, EURC_STREAM, transferLog({ value: 2_000_000n, txHash: '0xq2', logIndex: 0 }))
    await flush()
    expect(s.deposits.flat().map(d => d.txHash).sort()).toEqual(['0xq1', '0xq2'])
  })

  it('ignores a duplicate socket frame for the same log', async () => {
    const s = setup()
    const ws = await online(s)
    const log = transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xdup', logIndex: 3 })
    emitTransfer(ws, USDC_STREAM, log)
    emitTransfer(ws, USDC_STREAM, log)
    await flush()
    expect(s.deposits.flat()).toHaveLength(1)
    expect(s.watcher.stats().duplicatesIgnored).toBe(1)
  })

  it('does not surface a self-transfer', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ from: WALLET, value: 1_000_000_000_000_000_000n, txHash: '0xself' }))
    await flush()
    expect(s.deposits).toHaveLength(0)
  })

  it('does not surface a swap output leg (internal-contract sender)', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ from: KIT_ADAPTER, value: 5_000_000_000_000_000_000n, txHash: '0xswapout' }))
    await flush()
    expect(s.deposits).toHaveLength(0)
  })

  it('does not surface a bridge/CCTP mint (zero-address sender)', async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ from: ZERO, value: 9_000_000_000_000_000_000n, txHash: '0xmint' }))
    await flush()
    expect(s.deposits).toHaveLength(0)
  })

  it('stays alive on a malformed socket frame', async () => {
    const s = setup()
    const ws = await online(s)
    ws.rawMessage('not json at all {{{')
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xafterjunk' }))
    await flush()
    expect(s.deposits.flat().map(d => d.txHash)).toEqual(['0xafterjunk'])
  })

  it('uses the real block timestamp when available', async () => {
    const s = setup({ blockTimestamp: 1_757_123_456 })
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xts', blockNumber: 555 }))
    await flush()
    expect(s.deposits[0][0].timestamp).toBe(new Date(1_757_123_456 * 1000).toISOString())
  })
})

describe('createArcDepositWatcher — reconnect & catch-up', () => {
  it('a brand-new session pins the cursor to head and does NOT backfill history', async () => {
    const getLogs = vi.fn(() => [transferLog({ value: 1n, txHash: '0xold' })])
    const s = setup({ head: 5000, getLogs })
    await online(s)
    // No stored cursor → catchUp() must not have queried logs at all.
    expect(getLogs).not.toHaveBeenCalled()
    expect(s.watcher.stats().lastProcessedBlock).toBe(5000)
    expect(s.store.get('meshport:arcDepositWatcher:lastBlock:' + WALLET)).toBe('5000')
  })

  it('on socket close, schedules a reconnect with backoff', async () => {
    const s = setup()
    const ws = await online(s)
    ws.close()
    await flush()
    expect(s.timers).toHaveLength(1)
    expect(s.timers[0].ms).toBe(1000) // first backoff step
  })

  it('recovers a deposit missed while the socket was down via eth_getLogs catch-up', async () => {
    // Session 1: come online at head 100, advancing the cursor to 100.
    const missed = transferLog({ value: 3_000_000_000_000_000_000n, txHash: '0xmissed', blockNumber: 142, logIndex: 1 })
    const getLogs = vi.fn((p: any) => {
      // Only the native USDC emitter range that spans block 142 returns the log.
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16)
      const isUsdc = p.address.toLowerCase() === USDC_STREAM.address.toLowerCase()
      return isUsdc && from <= 142 && 142 <= to ? [missed] : []
    })
    const s = setup({ head: 100, getLogs })
    const ws1 = await online(s)
    expect(s.watcher.stats().lastProcessedBlock).toBe(100)

    // Socket drops.
    ws1.close()
    await flush()
    expect(s.timers).toHaveLength(1)

    // Chain advances to 200 while we were down; the reconnect timer fires.
    ;(s.rpc as any).mockImplementation(async (body: any) => {
      if (body.method === 'eth_blockNumber') return { result: '0x' + (200).toString(16) }
      if (body.method === 'eth_getBlockByNumber') return { result: { timestamp: '0x' + (1_757_000_000).toString(16) } }
      if (body.method === 'eth_getLogs') return { result: getLogs(body.params[0]) }
      return { result: null }
    })
    s.timers[0].fn()          // reconnect → connect() → catchUp() over blocks 101..200
    await flush()

    expect(getLogs).toHaveBeenCalled()
    expect(s.deposits.flat().map(d => d.txHash)).toContain('0xmissed')
    expect(s.deposits.flat().find(d => d.txHash === '0xmissed')).toMatchObject({ amount: 3, tokenSymbol: 'USDC' })
    // Cursor advanced past the recovered range.
    expect(s.watcher.stats().lastProcessedBlock).toBeGreaterThanOrEqual(200)

    // And the live socket is back up.
    const ws2 = s.sockets[s.sockets.length - 1]
    expect(ws2).not.toBe(ws1)
    ws2.open(); ws2.ackAllSubscribes(); await flush()
    expect(s.watcher.stats().connected).toBe(true)
  })

  it('stop() tears the socket down and delivers nothing afterward', async () => {
    const s = setup()
    const ws = await online(s)
    s.watcher.stop()
    expect(ws.closed).toBe(true)
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xafterstop' }))
    await flush()
    expect(s.deposits).toHaveLength(0)
    // A close that arrives after stop() must not schedule a reconnect.
    expect(s.timers).toHaveLength(0)
  })

  it('a duplicate delivered by BOTH catch-up and the live socket only surfaces once', async () => {
    const shared = transferLog({ value: 2_000_000_000_000_000_000n, txHash: '0xshared', blockNumber: 150, logIndex: 0 })
    const getLogs = vi.fn((p: any) => {
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16)
      return p.address.toLowerCase() === USDC_STREAM.address.toLowerCase() && from <= 150 && 150 <= to ? [shared] : []
    })
    const s = setup({ head: 100, getLogs })
    const ws1 = await online(s)
    ws1.close(); await flush()
    ;(s.rpc as any).mockImplementation(async (body: any) => {
      if (body.method === 'eth_blockNumber') return { result: '0x' + (160).toString(16) }
      if (body.method === 'eth_getBlockByNumber') return { result: { timestamp: '0x68b8c000' } }
      if (body.method === 'eth_getLogs') return { result: getLogs(body.params[0]) }
      return { result: null }
    })
    s.timers[0].fn(); await flush()
    const ws2 = s.sockets[s.sockets.length - 1]
    ws2.open(); ws2.ackAllSubscribes(); await flush()

    // Same log now also arrives live.
    emitTransfer(ws2, USDC_STREAM, shared)
    await flush()

    expect(s.deposits.flat().filter(d => d.txHash === '0xshared')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Background / tab-switch resilience — heartbeat + wake
// ─────────────────────────────────────────────────────────────────────────────

describe('createArcDepositWatcher — heartbeat & wake', () => {
  it('registers a 30s heartbeat interval on start and clears it on stop', async () => {
    const s = setup()
    await online(s)
    expect(s.intervals).toHaveLength(1)
    expect(s.intervals[0].ms).toBe(30_000)
    s.watcher.stop()
    expect(s.intervals).toHaveLength(0)
  })

  it('probes a quiet visible socket with eth_blockNumber after the stale window', async () => {
    const s = setup()
    const ws = await online(s)
    expect(s.watcher.stats().probing).toBe(false)
    s.advance(61_000)           // > STALE_MS since the last inbound frame
    s.intervals[0].fn()         // heartbeat tick
    expect(ws.sent.some(m => m.method === 'eth_blockNumber')).toBe(true)
    expect(s.watcher.stats().probing).toBe(true)
  })

  it('clears the pending probe on the next inbound frame', async () => {
    const s = setup()
    const ws = await online(s)
    s.advance(61_000); s.intervals[0].fn()
    expect(s.watcher.stats().probing).toBe(true)
    ws.message({ jsonrpc: '2.0', id: 999, result: '0x1234' })
    expect(s.watcher.stats().probing).toBe(false)
  })

  it('reconnects when a probe goes unanswered past the timeout', async () => {
    const s = setup()
    const ws1 = await online(s)
    const before = s.sockets.length
    s.advance(61_000); s.intervals[0].fn()     // sends the probe
    expect(s.watcher.stats().probing).toBe(true)
    s.advance(11_000); s.intervals[0].fn()     // probe unanswered > PROBE_TIMEOUT_MS
    await flush()
    expect(s.sockets.length).toBe(before + 1)
    expect(s.sockets[s.sockets.length - 1]).not.toBe(ws1)
  })

  it('_onWake with a dead socket forces an immediate reconnect, jumping the backoff', async () => {
    const s = setup()
    const ws1 = await online(s)
    ws1.close(); await flush()
    expect(s.timers).toHaveLength(1)           // backoff reconnect scheduled
    const before = s.sockets.length
    s.watcher._onWake()
    await flush()
    expect(s.timers).toHaveLength(0)           // backoff timer cancelled
    expect(s.sockets.length).toBe(before + 1)  // reconnected right now
    expect(s.sockets[s.sockets.length - 1]).not.toBe(ws1)
  })

  it('_onWake with a live socket reconciles the gap via eth_getLogs without tearing it down', async () => {
    const getLogs = vi.fn((_p?: any) => [] as any[])
    const s = setup({ head: 500, getLogs })
    const ws = await online(s)                 // fresh session -> cursor pinned to 500
    ;(s.rpc as any).mockImplementation(async (b: any) => {
      if (b.method === 'eth_blockNumber') return { result: '0x' + (900).toString(16) }
      if (b.method === 'eth_getLogs') return { result: getLogs(b.params[0]) }
      if (b.method === 'eth_getBlockByNumber') return { result: { timestamp: '0x68b8c000' } }
      return { result: null }
    })
    const socketsBefore = s.sockets.length
    s.watcher._onWake()
    await flush()
    expect(getLogs).toHaveBeenCalled()
    expect(s.sockets.length).toBe(socketsBefore)
    expect(ws.closed).toBe(false)
  })

  it('_tick / _onWake are no-ops after stop()', async () => {
    const s = setup()
    await online(s)
    s.watcher.stop()
    const sockets = s.sockets.length
    s.watcher._tick()
    s.watcher._onWake()
    await flush()
    expect(s.sockets.length).toBe(sockets)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// onDeposits source tag + module buffer + session singleton
// ─────────────────────────────────────────────────────────────────────────────

describe('onDeposits source tag', () => {
  it("tags a live socket delivery 'live'", async () => {
    const s = setup()
    const ws = await online(s)
    emitTransfer(ws, USDC_STREAM, transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xlive' }))
    await flush()
    expect(s.recorded[s.recorded.length - 1].source).toBe('live')
  })

  it("tags a catch-up delivery 'catchup'", async () => {
    const missed = transferLog({ value: 1_000_000_000_000_000_000n, txHash: '0xcu', blockNumber: 120, logIndex: 0 })
    const getLogs = vi.fn((p: any) => {
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16)
      return p.address.toLowerCase() === USDC_STREAM.address.toLowerCase() && from <= 120 && 120 <= to ? [missed] : []
    })
    const s = setup({ head: 100, getLogs })
    const ws1 = await online(s)
    ws1.close(); await flush()
    ;(s.rpc as any).mockImplementation(async (b: any) => {
      if (b.method === 'eth_blockNumber') return { result: '0x' + (200).toString(16) }
      if (b.method === 'eth_getBlockByNumber') return { result: { timestamp: '0x68b8c000' } }
      if (b.method === 'eth_getLogs') return { result: getLogs(b.params[0]) }
      return { result: null }
    })
    s.timers[0].fn(); await flush()
    expect(s.recorded.some(r => r.source === 'catchup' && r.txs.some((t: any) => t.txHash === '0xcu'))).toBe(true)
  })
})

describe('recent-deposit buffer + session singleton', () => {
  beforeEach(() => { arcDepositWatcher.stop(); clearRecentArcDeposits() })

  it('a deposit the singleton sees is readable via getRecentArcDeposits and cleared on stop', async () => {
    const d = makeDeps()
    arcDepositWatcher.start(WALLET, d.deps as any)
    await flush()
    const ws = d.sockets[d.sockets.length - 1]
    ws.open(); ws.ackAllSubscribes(); await flush()
    emitTransfer(ws, EURC_STREAM, transferLog({ value: 5_000_000n, txHash: '0xbuf1' }))
    await flush()

    const buf = getRecentArcDeposits()
    expect(buf.map(t => t.txHash)).toContain('0xbuf1')
    expect(buf.find(t => t.txHash === '0xbuf1')).toMatchObject({ tokenSymbol: 'EURC', amount: 5 })

    arcDepositWatcher.stop()
    expect(getRecentArcDeposits()).toHaveLength(0)
  })

  describe('buffer survives a hard page reload (not just an in-app remount)', () => {
    // Regression test for: deposit shows instantly, a real browser refresh
    // makes it disappear, and it only reappears a couple minutes later once
    // the server-side Supabase row lands. The in-memory buffer alone can't
    // survive a hard reload (this test simulates one by wiping ONLY the
    // in-memory maps via clearRecentArcDeposits() with no wallet arg — a
    // real reload also destroys the singleton controller itself, but the
    // module-level buffer is the piece this fix targets); a real
    // `window.localStorage` stub proves the fix persists across that wipe.
    let fakeLocalStorage: Storage

    beforeEach(() => {
      const store = new Map<string, string>()
      fakeLocalStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      } as unknown as Storage
      vi.stubGlobal('window', { localStorage: fakeLocalStorage })
    })

    afterEach(() => { vi.unstubAllGlobals() })

    it('a buffered deposit is restored by hydrateRecentDeposits after the in-memory buffer is wiped', async () => {
      const d = makeDeps()
      arcDepositWatcher.start(WALLET, d.deps as any)
      await flush()
      const ws = d.sockets[d.sockets.length - 1]
      ws.open(); ws.ackAllSubscribes(); await flush()
      emitTransfer(ws, EURC_STREAM, transferLog({ value: 5_000_000n, txHash: '0xreload1' }))
      await flush()
      expect(getRecentArcDeposits().map(t => t.txHash)).toContain('0xreload1')

      // Simulate the hard reload: in-memory state gone, localStorage intact.
      clearRecentArcDeposits()
      expect(getRecentArcDeposits()).toHaveLength(0)

      // What ArcDepositWatcherController.start() does on the next page load.
      hydrateRecentDeposits(WALLET)
      const buf = getRecentArcDeposits()
      expect(buf.map(t => t.txHash)).toContain('0xreload1')
      expect(buf.find(t => t.txHash === '0xreload1')).toMatchObject({ tokenSymbol: 'EURC', amount: 5 })
    })

    it('does not restore an entry older than the buffer TTL', () => {
      const stale = { txHash: '0xstale', fromAddress: SENDER, tokenSymbol: 'USDC', amount: 1, status: 'confirmed' as const, timestamp: new Date().toISOString() }
      fakeLocalStorage.setItem(
        `meshport:arcDepositWatcher:recentDeposits:${WALLET.toLowerCase()}`,
        JSON.stringify([{ tx: stale, at: Date.now() - 11 * 60_000 }]), // 11 min old, TTL is 10 min
      )
      hydrateRecentDeposits(WALLET)
      expect(getRecentArcDeposits().map(t => t.txHash)).not.toContain('0xstale')
    })

    it('clearRecentArcDeposits(wallet) removes the persisted entry so it cannot be re-hydrated', async () => {
      const d = makeDeps()
      arcDepositWatcher.start(WALLET, d.deps as any)
      await flush()
      const ws = d.sockets[d.sockets.length - 1]
      ws.open(); ws.ackAllSubscribes(); await flush()
      emitTransfer(ws, EURC_STREAM, transferLog({ value: 5_000_000n, txHash: '0xlogout1' }))
      await flush()

      arcDepositWatcher.stop() // real logout / wallet switch — clears in-memory AND persisted
      hydrateRecentDeposits(WALLET)
      expect(getRecentArcDeposits().map(t => t.txHash)).not.toContain('0xlogout1')
    })
  })

  it('start() is idempotent for the same wallet and re-targets on a wallet change', async () => {
    const d1 = makeDeps()
    arcDepositWatcher.start(WALLET, d1.deps as any)
    await flush()
    const n1 = d1.sockets.length
    arcDepositWatcher.start(WALLET, d1.deps as any) // same wallet — no restart
    expect(d1.sockets.length).toBe(n1)

    const d2 = makeDeps()
    arcDepositWatcher.start('0x9999999999999999999999999999999999999999', d2.deps as any)
    await flush()
    expect(d2.sockets.length).toBeGreaterThan(0)   // different wallet — new socket
    arcDepositWatcher.stop()
  })
})
