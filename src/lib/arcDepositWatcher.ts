// lib/arcDepositWatcher.ts
//
// Real-time, client-side detection of EXTERNAL incoming transfers to the
// connected wallet — native USDC, EURC and cirBTC — via Arc's
// `eth_subscribe("logs")` WebSocket stream, with an `eth_getLogs` catch-up
// on every (re)connect so a dropped socket never loses a deposit.
//
// ── Runs session-wide, not per-page ────────────────────────────────────────
// `arcDepositWatcher` (the singleton at the bottom of this file) is started
// once from AppLayout for the whole session, so the live subscription exists
// on every route, not only on /activity. When it sees a confirmed external
// deposit it does three things so the UI updates with no page refresh:
//   1. remembers it in a module buffer (getRecentArcDeposits) — useActivity
//      re-reads this on mount and on the event below, so a row that showed
//      once stays shown even after ActivityPage remounts and reloads;
//   2. dispatches `meshport:arc-deposit` (detail carries the tx) and the
//      legacy `meshport:onchain-activity` — HomePage listens to the former
//      and refreshes the balance for that token immediately;
//   3. fires the in-app "Received from" notification immediately, keyed on
//      `ext_recv_tx_<hash>` so the delayed server path (HomePage's
//      subscribeToActivity -> fireIfReceived, now using the same id)
//      DEDUPES against it instead of double-notifying.
// It still writes NOTHING to Supabase — the server pipeline
// (blockchain-indexer -> chain_events -> activity-consumer, plus
// deposit-scan-all) remains the durable, cross-device persistence path and
// the reconciliation backstop, alongside onchainReceivedActivity.ts's 60s
// ArcScan poll.
//
// ── Background / tab-switch resilience ─────────────────────────────────────
// A backgrounded tab (mobile Safari, an installed PWA) freezes: the socket
// dies, `onclose` may never fire, and any reconnect timer is frozen too. So
// the watcher also force-reconnects and runs a bounded catch-up on
// visibilitychange->visible, `online`, `pageshow` and `focus`, and a 30s
// heartbeat (visible tabs only) probes the socket with `eth_blockNumber` and
// reconnects if it does not answer within 10s. Nothing is lost across a
// sleep: the reconnect catch-up sweeps `eth_getLogs` from the persisted
// block cursor.
//
// ── Why raw WebSocket JSON-RPC, not ethers.WebSocketProvider ────────────────
// The whole point is "lightweight". This needs exactly three log
// subscriptions, a bounded catch-up query, and deterministic reconnect
// behaviour that is trivial to unit-test. A raw client is ~1 file with no
// provider stack, and it does NOT reintroduce the removed Alchemy
// full-block-download watcher (lib/realtimeDeposits.ts) — it only ever asks
// for Transfer logs already filtered, server-side, to this one wallet.
//
// ── Arc facts this relies on (Arc docs: "Index Arc Events") ─────────────────
//   * wss://rpc.testnet.arc.io — public, keyless (same host family already in
//     api/arc-rpc.js's HTTP fallback list). `eth_subscribe` is WebSocket-only.
//   * Native USDC movements ALL emit a standard Transfer log from the system
//     emitter 0xffff…fffe, 18 decimals (EIP-7708). This covers plain native
//     sends AND wrapper-routed (0x3600) ones — the gap the REST `?filter=to`
//     path is structurally blind to.
//   * EURC / cirBTC are ordinary ERC-20s emitting Transfer from their own
//     contracts (6 / 8 decimals).
//   * Deterministic finality: a log delivered over the socket is in a mined,
//     permanent block — no reorg handling, status is always 'confirmed'.

import type { OnchainReceivedTx } from './onchainReceivedActivity'
import { KNOWN_INTERNAL_CONTRACTS } from './onchainReceivedActivity'

// keccak256("Transfer(address,address,uint256)") — same constant as the
// server's decodeTransferLog.ts / scanner.ts and the Arc docs.
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const ZERO_ADDRESS = '0x' + '0'.repeat(40)

/** Public keyless Arc Testnet WebSocket endpoint (Arc docs: connect-to-arc). */
export const ARC_WS_URL = 'wss://rpc.testnet.arc.io'

/**
 * The three log streams a deposit can arrive on. Addresses/decimals are
 * inlined (not imported from the chain registry) to keep this module
 * dependency-free and trivially testable — the exact same
 * "immutable public constant, safe to duplicate" reasoning
 * decodeTransferLog.ts already applies to these values server-side.
 */
export interface WatchedStream {
  /** Contract the Transfer log is emitted from. */
  address: string
  tokenSymbol: string
  decimals: number
}

export const WATCHED_STREAMS: readonly WatchedStream[] = [
  // Native USDC system emitter (EIP-7708) — 18 decimals.
  { address: '0xfffffffffffffffffffffffffffffffffffffffe', tokenSymbol: 'USDC', decimals: 18 },
  // EURC ERC-20.
  { address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', tokenSymbol: 'EURC', decimals: 6 },
  // cirBTC ERC-20.
  { address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', tokenSymbol: 'cirBTC', decimals: 8 },
]

// ── Pure helpers (all exported for direct unit testing) ─────────────────────

/** Decode a 32-byte, left-zero-padded indexed address topic to a 0x address. */
export function topicToAddress(topic: string | undefined | null): string {
  if (!topic || typeof topic !== 'string') return ''
  const hex = topic.replace(/^0x/, '')
  if (hex.length < 40) return ''
  return ('0x' + hex.slice(-40)).toLowerCase()
}

/** A wallet address as a 32-byte, left-zero-padded topic (topic1/topic2 filter). */
export function paddedAddressTopic(wallet: string): string {
  return '0x' + wallet.replace(/^0x/, '').toLowerCase().padStart(64, '0')
}

export interface DecodedDepositLog {
  txHash: string
  logIndex: number | null
  blockNumber: number | null
  from: string
  to: string
  amount: number
  tokenSymbol: string
}

/**
 * Decode one raw log (from `eth_getLogs` or an `eth_subscription`
 * notification) as a Transfer for `stream`. Returns null for anything it
 * cannot safely interpret — wrong topic0, missing recipient, unparseable or
 * non-positive amount, malformed shape. Never throws: one bad frame on the
 * socket must not kill the watcher.
 */
export function decodeDepositLog(
  log: {
    topics?: string[]
    data?: string
    transactionHash?: string
    blockNumber?: string | number
    logIndex?: string | number
    removed?: boolean
  } | null | undefined,
  stream: WatchedStream,
): DecodedDepositLog | null {
  if (!log || typeof log !== 'object') return null
  if (log.removed) return null // a reorg-removed log (not expected on Arc, but cheap to honour)
  const topics = Array.isArray(log.topics) ? log.topics : []
  if ((topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC0) return null

  const from = topicToAddress(topics[1])
  const to = topicToAddress(topics[2])
  if (!to) return null

  let amount: number
  try {
    amount = Number(BigInt(log.data && log.data !== '0x' ? log.data : '0x0')) / 10 ** stream.decimals
  } catch {
    return null
  }
  if (!Number.isFinite(amount) || amount <= 0) return null

  let blockNumber: number | null = null
  try {
    blockNumber = log.blockNumber != null ? Number(BigInt(log.blockNumber)) : null
    if (blockNumber != null && !Number.isFinite(blockNumber)) blockNumber = null
  } catch { blockNumber = null }

  let logIndex: number | null = null
  try {
    logIndex = log.logIndex != null ? Number(BigInt(log.logIndex)) : null
    if (logIndex != null && !Number.isFinite(logIndex)) logIndex = null
  } catch { logIndex = null }

  return {
    txHash: (log.transactionHash ?? '').toLowerCase(),
    logIndex,
    blockNumber,
    from,
    to,
    amount,
    tokenSymbol: stream.tokenSymbol,
  }
}

export type DepositClassification =
  | { accept: true }
  | { accept: false; reason:
      | 'wrong_recipient'
      | 'self_transfer'
      | 'mint_or_zero_sender'
      | 'internal_contract_sender'
      | 'missing_tx_hash'
      | 'non_positive_amount' }

/**
 * Is this decoded Transfer a genuine EXTERNAL deposit to `wallet`?
 *
 * Mirrors the server's decide.ts acceptance rules exactly, so the client
 * real-time row and the server's eventual `recv_<hash>` row are decisions
 * about the same set of transfers:
 *   - recipient must be this wallet (the topic filter already scopes it, but
 *     a catch-up query or a loose filter could still surface others)
 *   - sender != recipient (self-transfer moves no net value)
 *   - sender != zero address (a mint — CCTP claim territory, owned elsewhere)
 *   - sender not a known internal contract (Kit Adapter / Multicall3 / CCTP —
 *     i.e. a swap or bridge OUTPUT leg, already surfaced under its own type)
 *   - amount > 0
 */
export function classifyDeposit(
  decoded: DecodedDepositLog,
  wallet: string,
): DepositClassification {
  const w = wallet.toLowerCase()
  if (!decoded.txHash) return { accept: false, reason: 'missing_tx_hash' }
  if (!Number.isFinite(decoded.amount) || decoded.amount <= 0) return { accept: false, reason: 'non_positive_amount' }
  if (decoded.to !== w) return { accept: false, reason: 'wrong_recipient' }
  if (!decoded.from || decoded.from === ZERO_ADDRESS) return { accept: false, reason: 'mint_or_zero_sender' }
  if (decoded.from === w) return { accept: false, reason: 'self_transfer' }
  if (KNOWN_INTERNAL_CONTRACTS.has(decoded.from)) return { accept: false, reason: 'internal_contract_sender' }
  return { accept: true }
}

/** Shape a validated deposit log into the OnchainReceivedTx the merge expects. */
export function decodedToOnchainTx(
  decoded: DecodedDepositLog,
  timestampIso: string,
): OnchainReceivedTx {
  return {
    txHash: decoded.txHash,
    fromAddress: decoded.from,
    tokenSymbol: decoded.tokenSymbol,
    amount: decoded.amount,
    // A log delivered by the node is already in a mined block, and Arc has
    // deterministic finality — there is no "pending" state to represent.
    status: 'confirmed',
    timestamp: timestampIso,
  }
}

/** Stable per-log identity for de-duplicating redelivered socket frames. */
export function logDedupeKey(decoded: DecodedDepositLog): string {
  return `${decoded.txHash}:${decoded.logIndex ?? 'x'}`
}

// ── The watcher ────────────────────────────────────────────────────────────

export interface ArcDepositWatcherDeps {
  /** WebSocket constructor. Defaults to the global. */
  WebSocketCtor?: typeof WebSocket
  /** JSON-RPC over the same-origin HTTP proxy. Defaults to arc.ts's arcRpcJson. */
  rpcJson?: (body: unknown) => Promise<any>
  /** localStorage-like store for the block cursor. Defaults to window.localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  /** Injectable timers (tests). */
  setTimeoutFn?: (fn: () => void, ms: number) => any
  clearTimeoutFn?: (handle: any) => void
  setIntervalFn?: (fn: () => void, ms: number) => any
  clearIntervalFn?: (handle: any) => void
  /** Injectable clock (tests). */
  now?: () => number
}

/** 1+ validated external deposits, and how they were found. */
export type OnDeposits = (txs: OnchainReceivedTx[], source: 'live' | 'catchup') => void

export interface ArcDepositWatcher {
  /** Open the socket and begin catch-up + live subscription. Idempotent. */
  start(): void
  /** Tear everything down. Safe to call repeatedly / before start(). */
  stop(): void
  /** Test/telemetry visibility. */
  stats(): {
    connected: boolean
    reconnects: number
    liveDeposits: number
    catchupDeposits: number
    duplicatesIgnored: number
    lastProcessedBlock: number
    probing: boolean
  }
  /** Test seam: simulate a wake signal (visibilitychange->visible / online / focus / pageshow). */
  _onWake(): void
  /** Test seam: run one heartbeat tick. */
  _tick(): void
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const
/** Catch-up query chunk size — small because the filter is scoped to one wallet. */
const CATCHUP_CHUNK_BLOCKS = 2_000
/** Ceiling on a single catch-up span. Beyond this the server pipeline owns recovery. */
const CATCHUP_MAX_SPAN_BLOCKS = 100_000
const SEEN_LOG_MAX = 500
/** Heartbeat cadence — only ticks while the tab is visible. */
const HEARTBEAT_MS = 30_000
/** No inbound frame for this long (visible tab) => probe the socket. */
const STALE_MS = 60_000
/** Probe unanswered for this long => the socket is dead, reconnect. */
const PROBE_TIMEOUT_MS = 10_000
/** WebSocket.OPEN — hard-coded so it works with an injected fake ctor too. */
const WS_OPEN = 1

function cursorKey(wallet: string): string {
  return `meshport:arcDepositWatcher:lastBlock:${wallet.toLowerCase()}`
}

/**
 * Create (but do not start) a watcher for one wallet. Call start() to
 * connect; call stop() on wallet change / logout / unmount.
 */
export function createArcDepositWatcher(opts: {
  walletAddress: string
  /** Called with 1+ validated external deposits, newest handling left to the merge. */
  onDeposits: OnDeposits
  deps?: ArcDepositWatcherDeps
}): ArcDepositWatcher {
  const wallet = opts.walletAddress.toLowerCase()
  const deps = opts.deps ?? {}
  const WS = deps.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined)
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h))
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h))
  const now = deps.now ?? (() => Date.now())

  const storage: Pick<Storage, 'getItem' | 'setItem'> | null =
    deps.storage ??
    (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null)

  const paddedWallet = paddedAddressTopic(wallet)

  let ws: WebSocket | null = null
  let stopped = false
  let started = false
  let reconnectAttempt = 0
  let reconnectTimer: any = null
  let heartbeatTimer: any = null
  let rpcId = 1
  let lastProcessedBlock = 0
  // Liveness: bumped on every inbound frame; `probeAt` set when we ping a
  // quiet socket and cleared by the next inbound frame.
  let lastMessageAt = 0
  let probeAt: number | null = null
  // Real DOM listeners (only registered when window/document exist).
  let wakeListeners: Array<() => void> = []

  // subscriptionId -> stream (populated by eth_subscribe acks)
  const subIdToStream = new Map<string, WatchedStream>()
  // pending eth_subscribe request id -> stream (matched on ack)
  const pendingSubReq = new Map<number, WatchedStream>()
  // block number -> ISO timestamp, so repeat deposits in one block cost one RPC
  const blockTsCache = new Map<number, string>()

  const seenLogKeys = new Set<string>()
  const seenLogOrder: string[] = []

  const stats = {
    connected: false,
    reconnects: 0,
    liveDeposits: 0,
    catchupDeposits: 0,
    duplicatesIgnored: 0,
  }

  const isHidden = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const rpc = deps.rpcJson
    ? deps.rpcJson
    : async (body: unknown) => (await import('./arc')).arcRpcJson(body)

  function log(msg: string, err?: unknown) {
    if (err !== undefined) console.warn(`[arcDepositWatcher] ${msg}`, err instanceof Error ? err.message : err)
    else console.info(`[arcDepositWatcher] ${msg}`)
  }

  function loadCursor(): number {
    if (!storage) return 0
    try {
      const raw = storage.getItem(cursorKey(wallet))
      const n = raw != null ? Number(raw) : 0
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    } catch { return 0 }
  }

  function persistCursor(block: number) {
    if (block <= lastProcessedBlock) return
    lastProcessedBlock = block
    if (!storage) return
    try { storage.setItem(cursorKey(wallet), String(block)) } catch { /* private mode / quota — cursor is best-effort */ }
  }

  function rememberLog(key: string): boolean {
    if (seenLogKeys.has(key)) return false
    seenLogKeys.add(key)
    seenLogOrder.push(key)
    if (seenLogOrder.length > SEEN_LOG_MAX) {
      const evicted = seenLogOrder.shift()
      if (evicted !== undefined) seenLogKeys.delete(evicted)
    }
    return true
  }

  async function blockTimestampIso(blockNumber: number | null): Promise<string> {
    const fallback = new Date(now()).toISOString()
    if (blockNumber == null) return fallback
    const cached = blockTsCache.get(blockNumber)
    if (cached) return cached
    try {
      const res = await rpc({ jsonrpc: '2.0', id: rpcId++, method: 'eth_getBlockByNumber', params: ['0x' + blockNumber.toString(16), false] })
      const tsHex = res?.result?.timestamp
      if (tsHex != null) {
        const iso = new Date(Number(BigInt(tsHex)) * 1000).toISOString()
        blockTsCache.set(blockNumber, iso)
        if (blockTsCache.size > 200) blockTsCache.delete(blockTsCache.keys().next().value as number)
        return iso
      }
    } catch (e) {
      log('block timestamp lookup failed, using arrival time', e)
    }
    return fallback
  }

  /** Decode + validate one raw log; returns the tx to emit, or null. */
  async function processRawLog(raw: any, stream: WatchedStream, source: 'live' | 'catchup'): Promise<OnchainReceivedTx | null> {
    const decoded = decodeDepositLog(raw, stream)
    if (!decoded) return null
    const key = logDedupeKey(decoded)
    if (!rememberLog(key)) {
      stats.duplicatesIgnored++
      return null
    }
    const verdict = classifyDeposit(decoded, wallet)
    if (!verdict.accept) return null
    const iso = await blockTimestampIso(decoded.blockNumber)
    if (decoded.blockNumber != null) persistCursor(decoded.blockNumber)
    if (source === 'live') stats.liveDeposits++
    else stats.catchupDeposits++
    return decodedToOnchainTx(decoded, iso)
  }

  async function getHeadBlock(): Promise<number> {
    const res = await rpc({ jsonrpc: '2.0', id: rpcId++, method: 'eth_blockNumber', params: [] })
    const n = Number(BigInt(res?.result ?? '0x0'))
    if (!Number.isFinite(n) || n <= 0) throw new Error('eth_blockNumber returned no usable head')
    return n
  }

  async function getLogsRange(stream: WatchedStream, fromBlock: number, toBlock: number): Promise<any[]> {
    const res = await rpc({
      jsonrpc: '2.0', id: rpcId++, method: 'eth_getLogs',
      params: [{
        address: stream.address,
        topics: [TRANSFER_TOPIC0, null, paddedWallet],
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      }],
    })
    return Array.isArray(res?.result) ? res.result : []
  }

  /**
   * Bounded `eth_getLogs` sweep from the persisted cursor to head, so a
   * reconnect (or a fresh mount that already has a cursor) never loses a
   * deposit the socket was down for. On a brand-new session (no cursor) this
   * just pins the cursor to head — it deliberately does NOT backfill history,
   * that is fetchActivity()/onchainReceivedActivity.ts's job.
   */
  async function catchUp(): Promise<void> {
    let head: number
    try {
      head = await getHeadBlock()
    } catch (e) {
      log('catch-up head lookup failed — proceeding to live subscription only', e)
      return
    }

    if (lastProcessedBlock === 0) {
      persistCursor(head)
      return
    }
    let from = lastProcessedBlock + 1
    if (from > head) return

    // If we somehow fell absurdly far behind (tab asleep for many hours), do
    // not try to sweep it all from a browser — cover the most recent span and
    // let the server pipeline reconcile the rest.
    if (head - from > CATCHUP_MAX_SPAN_BLOCKS) {
      const skipTo = head - CATCHUP_MAX_SPAN_BLOCKS
      log(`catch-up span ${head - from} blocks exceeds cap — skipping to ${skipTo}, server pipeline covers the gap`)
      from = skipTo
      persistCursor(skipTo - 1)
    }

    const collected: OnchainReceivedTx[] = []
    for (let chunkFrom = from; chunkFrom <= head; chunkFrom += CATCHUP_CHUNK_BLOCKS) {
      if (stopped) return
      const chunkTo = Math.min(chunkFrom + CATCHUP_CHUNK_BLOCKS - 1, head)
      try {
        for (const stream of WATCHED_STREAMS) {
          const logs = await getLogsRange(stream, chunkFrom, chunkTo)
          for (const raw of logs) {
            const tx = await processRawLog(raw, stream, 'catchup')
            if (tx) collected.push(tx)
          }
        }
        // Whole chunk scanned across all three streams — safe to advance.
        persistCursor(chunkTo)
      } catch (e) {
        // Leave the cursor at the last fully-scanned block so the next
        // reconnect retries this range rather than skipping it.
        log(`catch-up chunk ${chunkFrom}-${chunkTo} failed — will retry on next reconnect`, e)
        break
      }
    }

    if (collected.length > 0) {
      log(`catch-up recovered ${collected.length} missed deposit(s)`)
      try { opts.onDeposits(collected, 'catchup') } catch (e) { log('onDeposits (catch-up) threw', e) }
    }
  }

  function teardownSocket() {
    subIdToStream.clear()
    pendingSubReq.clear()
    if (ws) {
      try {
        ws.onopen = null as any
        ws.onmessage = null as any
        ws.onerror = null as any
        ws.onclose = null as any
        ws.close()
      } catch { /* already closing */ }
      ws = null
    }
    stats.connected = false
  }

  function scheduleReconnect() {
    if (stopped) return
    if (reconnectTimer != null) return
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
    reconnectAttempt++
    stats.reconnects++
    log(`socket down — reconnecting in ${delay}ms (attempt ${reconnectAttempt})`)
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null
      if (!stopped) void connect()
    }, delay)
  }

  function onMessage(evt: MessageEvent) {
    // ANY inbound frame proves the socket is alive — clears a pending probe
    // and resets the staleness clock the heartbeat watches.
    lastMessageAt = now()
    probeAt = null

    let msg: any
    try {
      msg = typeof evt.data === 'string' ? JSON.parse(evt.data) : JSON.parse(String(evt.data))
    } catch {
      return // malformed frame — ignore
    }

    // eth_subscribe ack: { id, result: "<subId>" }
    if (msg && msg.id != null && pendingSubReq.has(msg.id)) {
      const stream = pendingSubReq.get(msg.id)!
      pendingSubReq.delete(msg.id)
      if (typeof msg.result === 'string') {
        subIdToStream.set(msg.result, stream)
      } else {
        log(`eth_subscribe for ${stream.tokenSymbol} was rejected`, msg.error)
      }
      return
    }

    // Live log notification:
    // { method: "eth_subscription", params: { subscription: "<subId>", result: <log> } }
    if (msg && msg.method === 'eth_subscription' && msg.params) {
      const stream = subIdToStream.get(msg.params.subscription)
      if (!stream) return
      void processRawLog(msg.params.result, stream, 'live').then((tx) => {
        if (!tx) return
        try { opts.onDeposits([tx], 'live') } catch (e) { log('onDeposits (live) threw', e) }
      })
    }
  }

  /** Immediate reconnect — drops any backoff wait. Used on wake / dead-probe. */
  function forceReconnect() {
    if (stopped) return
    if (reconnectTimer != null) { clearTimeoutFn(reconnectTimer); reconnectTimer = null }
    reconnectAttempt = 0
    void connect()
  }

  function sendProbe() {
    if (!ws || ws.readyState !== WS_OPEN) return
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'eth_blockNumber', params: [] }))
      probeAt = now()
    } catch (e) {
      log('probe send failed — reconnecting', e)
      forceReconnect()
    }
  }

  /** Heartbeat tick: only runs while visible; keeps the socket honest. */
  function tick() {
    if (stopped || isHidden()) return
    if (!ws || ws.readyState !== WS_OPEN) {
      if (reconnectTimer == null) forceReconnect()
      return
    }
    if (probeAt !== null && now() - probeAt > PROBE_TIMEOUT_MS) {
      log('probe unanswered — socket is dead, reconnecting')
      forceReconnect()
      return
    }
    if (probeAt === null && now() - lastMessageAt > STALE_MS) sendProbe()
  }

  /** A wake signal (tab visible again / network back / bfcache restore / focus). */
  function onWake() {
    if (stopped || isHidden()) return
    if (!ws || ws.readyState !== WS_OPEN) {
      forceReconnect() // dead or never-opened — reconnect (which runs catch-up)
      return
    }
    // Socket still looks open after a freeze — reconcile the gap without
    // tearing it down. catchUp() is cursor-guarded and dedup-guarded, so a
    // redundant call is cheap and safe.
    void catchUp()
  }

  async function connect() {
    if (stopped) return
    teardownSocket()

    // Catch-up FIRST so a deposit that landed while the socket was down is
    // recovered before we start relying on the live stream (Arc docs'
    // reconnect order: head -> bounded getLogs -> subscribe -> live).
    await catchUp()
    if (stopped) return

    if (!WS) {
      log('no WebSocket implementation available — real-time layer disabled (REST fallback still active)')
      return
    }

    let socket: WebSocket
    try {
      socket = new WS(ARC_WS_URL)
    } catch (e) {
      log('WebSocket construction failed', e)
      scheduleReconnect()
      return
    }
    ws = socket

    socket.onopen = () => {
      if (stopped || ws !== socket) { try { socket.close() } catch {} ; return }
      stats.connected = true
      reconnectAttempt = 0
      lastMessageAt = now()
      probeAt = null
      for (const stream of WATCHED_STREAMS) {
        const id = rpcId++
        pendingSubReq.set(id, stream)
        try {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id, method: 'eth_subscribe',
            params: ['logs', { address: stream.address, topics: [TRANSFER_TOPIC0, null, paddedWallet] }],
          }))
        } catch (e) {
          pendingSubReq.delete(id)
          log(`failed to send eth_subscribe for ${stream.tokenSymbol}`, e)
        }
      }
    }
    socket.onmessage = onMessage as any
    socket.onerror = () => { /* onclose always follows; reconnect handled there */ }
    socket.onclose = () => {
      if (ws === socket) {
        teardownSocket()
        scheduleReconnect()
      }
    }
  }

  function registerWakeListeners() {
    if (wakeListeners.length) return
    const fire = () => onWake()
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVis = () => { if (!isHidden()) onWake() }
      document.addEventListener('visibilitychange', onVis)
      wakeListeners.push(() => document.removeEventListener('visibilitychange', onVis))
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      for (const ev of ['online', 'focus', 'pageshow'] as const) {
        window.addEventListener(ev, fire)
        wakeListeners.push(() => window.removeEventListener(ev, fire))
      }
    }
  }

  function unregisterWakeListeners() {
    for (const off of wakeListeners) { try { off() } catch { /* ignore */ } }
    wakeListeners = []
  }

  return {
    start() {
      if (started) return
      started = true
      stopped = false
      lastProcessedBlock = loadCursor()
      registerWakeListeners()
      if (heartbeatTimer == null) heartbeatTimer = setIntervalFn(tick, HEARTBEAT_MS)
      void connect()
    },
    stop() {
      stopped = true
      started = false
      if (reconnectTimer != null) {
        clearTimeoutFn(reconnectTimer)
        reconnectTimer = null
      }
      if (heartbeatTimer != null) {
        clearIntervalFn(heartbeatTimer)
        heartbeatTimer = null
      }
      unregisterWakeListeners()
      teardownSocket()
    },
    stats() {
      return { ...stats, lastProcessedBlock, probing: probeAt !== null }
    },
    _onWake: onWake,
    _tick: tick,
  }
}

// ── Recent-deposit buffer ─────────────────────────────────────────────────
//
// A confirmed deposit is remembered here for BUFFER_TTL_MS so useActivity can
// re-merge it after ActivityPage remounts and reloads from Supabase (which
// runs refresh() on every mount and would otherwise wipe the synthetic row
// until the ~2-4 min server row lands). Keyed by tx hash; capped so a long
// session cannot grow it without bound.
//
// ── BUG FIX — the buffer used to be in-memory ONLY ──────────────────────────
// That made it survive an in-app remount (ActivityPage unmounting/mounting
// while the SPA stays loaded) but NOT an actual browser refresh: a hard
// reload wipes this module's state entirely, same as any other JS variable.
// The block cursor a few lines up was already being persisted to
// localStorage for exactly this reason (see cursorKey/loadCursor/
// persistCursor); this buffer wasn't, which is the real mechanism behind
// "shows instantly, disappears on refresh, comes back a couple minutes
// later": the socket sees the deposit and buffers it (instant); the
// refresh wipes the buffer AND the block cursor has already advanced past
// that deposit's block, so catch-up correctly does NOT re-report it
// (avoiding a duplicate) — but nothing re-populates the buffer either, so
// the row vanishes from the merge until either ArcScan's REST index
// catches up (can lag a live socket log by a bit) or the durable Supabase
// row lands from the server pipeline (~2-4 min), at which point it
// reappears via the normal Activity History path. Persisting the buffer the
// same way the cursor already is closes that window: hydrateRecentDeposits
// restores it the instant the watcher (re)starts, before any new log or
// poll has had a chance to rediscover the deposit on its own.

const BUFFER_TTL_MS = 10 * 60_000
const BUFFER_MAX = 50
const recentDeposits = new Map<string, OnchainReceivedTx>()
const recentDepositAt = new Map<string, number>()

function bufferStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
}

function bufferKey(wallet: string): string {
  return `meshport:arcDepositWatcher:recentDeposits:${wallet.toLowerCase()}`
}

/** Write the current (non-expired) buffer out for `wallet`. Best-effort. */
function persistBuffer(wallet: string | null): void {
  if (!wallet) return
  const storage = bufferStorage()
  if (!storage) return
  try {
    const entries = Array.from(recentDeposits.entries()).map(([key, tx]) => ({
      tx,
      at: recentDepositAt.get(key) ?? Date.now(),
    }))
    storage.setItem(bufferKey(wallet), JSON.stringify(entries))
  } catch { /* private mode / quota — buffer persistence is best-effort, same as the cursor */ }
}

/**
 * Restore `wallet`'s buffer from localStorage into the in-memory maps.
 * Called once when the watcher (re)starts for a wallet — see
 * ArcDepositWatcherController.start() — so a hard refresh doesn't lose a
 * deposit that was already buffered before the page reloaded.
 */
export function hydrateRecentDeposits(wallet: string): void {
  const storage = bufferStorage()
  if (!storage) return
  try {
    const raw = storage.getItem(bufferKey(wallet))
    if (!raw) return
    const parsed = JSON.parse(raw) as Array<{ tx: OnchainReceivedTx; at: number }>
    if (!Array.isArray(parsed)) return
    const nowMs = Date.now()
    for (const entry of parsed) {
      const tx = entry?.tx
      if (!tx?.txHash || typeof entry.at !== 'number') continue
      if (nowMs - entry.at > BUFFER_TTL_MS) continue // expired while the page was closed/reloading
      const key = tx.txHash.toLowerCase()
      if (recentDeposits.has(key)) continue
      recentDeposits.set(key, tx)
      recentDepositAt.set(key, entry.at)
    }
  } catch { /* corrupt or absent entry — leave the buffer empty for this wallet, not a crash */ }
}

function rememberDeposit(wallet: string | null, tx: OnchainReceivedTx): void {
  const key = tx.txHash.toLowerCase()
  if (!recentDeposits.has(key)) {
    recentDeposits.set(key, tx)
    recentDepositAt.set(key, Date.now())
  }
  while (recentDeposits.size > BUFFER_MAX) {
    const oldest = recentDeposits.keys().next().value as string | undefined
    if (oldest === undefined) break
    recentDeposits.delete(oldest)
    recentDepositAt.delete(oldest)
  }
  persistBuffer(wallet)
}

/** Non-expired recent on-chain deposits, newest first. */
export function getRecentArcDeposits(): OnchainReceivedTx[] {
  const nowMs = Date.now()
  const out: OnchainReceivedTx[] = []
  for (const [key, tx] of recentDeposits) {
    if (nowMs - (recentDepositAt.get(key) ?? 0) > BUFFER_TTL_MS) {
      recentDeposits.delete(key)
      recentDepositAt.delete(key)
      continue
    }
    out.push(tx)
  }
  return out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

/**
 * Test/lifecycle: drop everything (called on wallet change / logout).
 * Pass the wallet being torn down so its persisted buffer is cleared too —
 * otherwise a wallet switch could hydrate the NEXT wallet's session with
 * the PREVIOUS wallet's buffered deposits if the two ever shared a key
 * (they don't, keys are per-wallet, but clearing on stop keeps a stale
 * entry from lingering in localStorage indefinitely after logout).
 */
export function clearRecentArcDeposits(wallet?: string | null): void {
  recentDeposits.clear()
  recentDepositAt.clear()
  if (wallet) {
    const storage = bufferStorage()
    if (storage) {
      try { storage.removeItem(bufferKey(wallet)) } catch { /* ignore */ }
    }
  }
}

// ── Notification (fired immediately, deduped against the server path) ──────
//
// The in-app notification store dedupes by id against the live list AND a
// persistent seen-ids ledger, so firing `ext_recv_tx_<hash>` here and having
// HomePage.fireIfReceived fire the SAME id when the Supabase row lands minutes
// later collapses to one notification, whichever path is first.

/** Deposits older than this are left to HomePage's catch-up scan (which honours
 *  the notifications_cleared_at watermark) — so reopening a long-closed tab
 *  does not replay a burst of stale "Received from" alerts. */
const NOTIFY_MAX_AGE_MS = 5 * 60_000

async function fireDepositNotification(tx: OnchainReceivedTx): Promise<void> {
  if (typeof window === 'undefined') return
  const ageMs = Date.now() - new Date(tx.timestamp).getTime()
  if (Number.isFinite(ageMs) && ageMs > NOTIFY_MAX_AGE_MS) return
  try {
    const id = `ext_recv_tx_${tx.txHash.toLowerCase()}`
    let fromUsername: string | undefined
    try {
      const { supabase } = await import('./supabase')
      const { data } = await supabase
        .from('users')
        .select('username')
        .eq('wallet_address', (tx.fromAddress || '').toLowerCase())
        .maybeSingle()
      fromUsername = data?.username || undefined
    } catch { /* fall through to address form */ }

    const notif = await import('./notifications')
    if (fromUsername) {
      notif.notifyPaymentReceived({
        id, amount: tx.amount, fromUsername: fromUsername.replace(/\.arc$/, ''),
        tokenSymbol: tx.tokenSymbol, createdAt: tx.timestamp,
      })
    } else {
      notif.notifyPaymentReceivedFromAddress({
        id, amount: tx.amount, fromAddress: tx.fromAddress || '0x???',
        tokenSymbol: tx.tokenSymbol, createdAt: tx.timestamp,
      })
    }
  } catch (e) {
    console.warn('[arcDepositWatcher] notification failed', e instanceof Error ? e.message : e)
  }
}

/**
 * Invalidate the balance/history caches for a deposit, through the SAME
 * Phase-6 coordinator a real Supabase `activity` INSERT goes through — just
 * ~3 min earlier. This is what makes the balance fresh on EVERY route, not
 * only on Home: an off-route deposit still drops the cached Arc balance, so
 * the next `readArcBalance` (HomePage mount, or its 30s poll) refetches
 * instead of serving a stale number. HomePage's own 'meshport:arc-deposit'
 * listener additionally forces an immediate refetch when it is mounted.
 */
async function invalidateCachesFor(wallet: string, tx: OnchainReceivedTx): Promise<void> {
  try {
    const { syncCoordinator } = await import('@/blockchain/shadowEventBus')
    syncCoordinator.handleActivityRow({
      id: `onchain_${tx.txHash.toLowerCase()}`,
      wallet_address: wallet,
      activity_type: 'receive',
      status: 'completed',
      token_symbol: tx.tokenSymbol,
    })
  } catch (e) {
    console.warn('[arcDepositWatcher] cache invalidation failed', e instanceof Error ? e.message : e)
  }
}

/**
 * What every detected deposit fans out to: remember it (buffer), tell the two
 * UI surfaces (Activity list + Home balance) via events, invalidate the
 * balance/history caches, and fire the notification.
 */
function handleDeposits(txs: OnchainReceivedTx[], source: 'live' | 'catchup'): void {
  const wallet = arcDepositWatcher.currentWallet()
  for (const tx of txs) {
    rememberDeposit(wallet, tx)
    // Everything below is browser-only (events, caches, notifications). In a
    // non-DOM context the buffer above is the whole job.
    if (typeof window === 'undefined') continue
    try {
      window.dispatchEvent(new CustomEvent('meshport:arc-deposit', {
        detail: {
          txHash: tx.txHash,
          tokenSymbol: tx.tokenSymbol,
          amount: tx.amount,
          fromAddress: tx.fromAddress,
          timestamp: tx.timestamp,
          source,
        },
      }))
      // Legacy event: useActivity's ArcScan-merge path and any other listener
      // already wired to it get nudged too.
      window.dispatchEvent(new CustomEvent('meshport:onchain-activity'))
    } catch { /* CustomEvent unavailable — buffer + the calls below still run */ }
    if (wallet) void invalidateCachesFor(wallet, tx)
    void fireDepositNotification(tx)
  }
}

// ── The session-wide singleton ────────────────────────────────────────────
//
// Started once from AppLayout on the connected wallet (mirrors
// shadowEventBus). One WebSocket for the whole session, every route.

class ArcDepositWatcherController {
  private inner: ArcDepositWatcher | null = null
  private wallet: string | null = null

  /**
   * Start (or re-target) the watcher for `walletAddress`. Idempotent per
   * wallet. `deps` is a test seam only — production callers pass just the
   * address and get the real WebSocket / RPC / timers.
   */
  start(walletAddress: string | null | undefined, deps?: ArcDepositWatcherDeps): void {
    const next = (walletAddress ?? '').toLowerCase() || null
    if (this.inner && this.wallet === next) return
    this.stop()
    this.wallet = next
    if (!next) return
    // Restore any deposits buffered before this session started (including
    // right before a hard page reload) BEFORE catch-up/live begin, so
    // getRecentArcDeposits() is correct from the very first call rather
    // than briefly empty.
    hydrateRecentDeposits(next)
    this.inner = createArcDepositWatcher({ walletAddress: next, onDeposits: handleDeposits, deps })
    this.inner.start()
  }

  stop(): void {
    this.inner?.stop()
    this.inner = null
    const prevWallet = this.wallet
    this.wallet = null
    clearRecentArcDeposits(prevWallet)
  }

  /** The wallet the watcher is currently running for, lowercased, or null. */
  currentWallet(): string | null {
    return this.wallet
  }

  /** Force an immediate reconnect + catch-up (what a tab-focus does). */
  wake(): void {
    this.inner?._onWake()
  }

  status(): ReturnType<ArcDepositWatcher['stats']> | { connected: false } {
    return this.inner?.stats() ?? { connected: false }
  }
}

export const arcDepositWatcher = new ArcDepositWatcherController()

// Dev-console handle, mirroring shadowEventBus's __meshportShadowBus. Lets you
// verify the WebSocket from any deployed build without a debugger:
//   __arcDepositWatcher.status()          -> { connected, reconnects, probing,
//                                              liveDeposits, catchupDeposits,
//                                              duplicatesIgnored, lastProcessedBlock }
//   __arcDepositWatcher.currentWallet()   -> the wallet it is running for
//   __arcDepositWatcher.recent()          -> the buffered recent deposits
//   __arcDepositWatcher.wake()            -> force a reconnect + catch-up now
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__arcDepositWatcher = {
    status: () => arcDepositWatcher.status(),
    currentWallet: () => arcDepositWatcher.currentWallet(),
    recent: () => getRecentArcDeposits(),
    wake: () => arcDepositWatcher.wake(),
  }
}
