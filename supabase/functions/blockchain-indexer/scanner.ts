// supabase/functions/blockchain-indexer/scanner.ts
//
// The chain-observation half of the indexer. It reads new blocks, derives
// chain events, and returns them with the cursor-advance decision. It has no
// database access and no business logic — it is a pure(ish) function from
// (chain, range) -> (events, safeCursor), which is what makes it testable and
// keeps the "indexer contains no business logic" rule structural.
//
// The native-block scan mirrors deposit-scan-all's approach (eth_getBlockByNumber
// with full transactions, matching tx.to against a known-wallet set) because
// that is how Arc deposits are detectable at all — plain native USDC transfers
// emit no logs, and USDC is Arc's native gas currency. The ERC-20 scan mirrors
// its eth_getLogs approach (unfiltered by recipient, matched in memory).
//
// REORG DETECTION (new in Phase 3, absent from deposit-scan-all):
// After scanning, the caller verifies the block AT the cursor by checking its
// parent hash against the recorded hash. That verification lives in index.ts
// (it needs the cursor row); this file returns the pieces it needs.
import { safeAdvance } from './cursorMath.ts'
import { decodeTransferLog, isMintTransfer, isSelfTransfer } from './decodeTransferLog.ts'

export interface ScannedResult {
  events: Array<Record<string, unknown>>
  /** Highest contiguous block fully processed; cursor may advance here. */
  safeUpTo: number
  /** The hash of safeUpTo, to persist for the next reorg check. */
  safeUpToHash: string | null
  /** Blocks whose events may now be marked 'confirmed'. */
  confirmableBlocks: number[]
}

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const NATIVE_DECIMALS = 18

// topicToAddress and MINT_FROM_TOPIC previously lived here — both were
// removed once the decodeTransferLog.ts extraction (docs/
// BULKPAY_RECONCILIATION_IMPLEMENTATION.md) made them dead code: every call
// site in this file now goes through decodeTransferLog()/isMintTransfer(),
// which carry their own copies (with the exact same fixed-width slice(-40)
// reasoning, quoted there). Not deleting them would have left two genuinely
// unused declarations behind — confirmed via `deno lint`, not assumed.

/**
 * HTTP statuses worth retrying.
 *
 * Deliberately a CLOSED whitelist. A JSON-RPC error body (thrown as a plain
 * object below) and any 4xx other than 429 are deterministic — retrying them
 * would burn the very quota that is already exhausted. Timeouts and network
 * errors are also NOT retried here: 24 h of production logs contained 8,492
 * RPC rejections, 100% of them HTTP 429 and zero timeouts, so widening this
 * set would add risk without addressing anything actually observed. Extending
 * it later is a one-line change if timeout evidence ever appears.
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

/**
 * Backoff before attempts 2, 3 and 4 — so four attempts in total.
 *
 * Sized from the measured failure mode, NOT a generic sub-second default.
 * deposit-scan-all logs 5-43 HTTP 429s EVERY minute, sustained overnight: the
 * shared dRPC quota is continuously saturated rather than bursty, so a 250 ms
 * retry lands inside the same exhausted window and buys nothing. This ladder
 * spans ~6.6 s of wall clock — long enough for a token-bucket limiter to
 * refill, and comfortably inside both the 2-minute cron interval and the
 * function time budget even when several blocks in a pass each retry.
 */
export const RPC_RETRY_BASE_MS: readonly number[] = [600, 1_800, 4_200]

/** Full-jitter bounds: delay = base × U(0.5, 1.5). */
export const RPC_JITTER_MIN = 0.5
export const RPC_JITTER_MAX = 1.5

/** Upper bound on an honored `Retry-After`, so one hostile header cannot stall a pass. */
export const RETRY_AFTER_CAP_MS = 30_000

/** Carries the HTTP status, so the retry decision can be made on it. */
export class RpcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`RPC ${status} from ${url}`)
    this.name = 'RpcHttpError'
  }
}

/**
 * Injection seam for tests ONLY. Production call sites pass nothing and get the
 * real fetch/timers/RNG, which is why every existing caller is unchanged.
 */
export interface RpcDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/**
 * Fetches eth_getLogs over [fromBlock, toBlock], shrinking the range on
 * failure instead of giving up on the whole span.
 *
 * ROOT CAUSE (docs referenced in the surrounding comments identified this but
 * left it as diagnostic-only logging): logChunkSize was a FIXED 5000-block
 * span, larger than maxBlocksPerPass (3000), so a pass's log scan ran exactly
 * ONE eth_getLogs call over the whole window. Arc runs ~18 tx/sec (measured
 * via the public explorer), so even a few-thousand-block span routinely
 * produces more Transfer logs than a public RPC's per-call result cap allows
 * -- the call fails, `ok=false` for the ENTIRE window, safeAdvance returns
 * `fromBlock - 1`, and index.ts takes the "no contiguous progress in pass"
 * branch. Since the cursor never moves, the next pass retries the identical
 * range and fails the identical way -- a permanent stall, not a transient one
 * that time or rpcCallRace's retry ladder could ever resolve (retrying an
 * inherently-too-large query just reproduces the same error).
 *
 * FIX: on failure, bisect [fromBlock, toBlock] and retry each half
 * independently, recursively, down to MIN_LOG_CHUNK_SIZE. This requires no
 * fixed chunk size to be "right" for current throughput -- it adapts to
 * whatever range size actually succeeds, and only the genuinely-failing
 * minimal sub-range (a real RPC/network fault, not a size problem) is ever
 * reported as unprocessed. Every recorded segment is used by the EXISTING
 * safeAdvance (cursorMath.ts) exactly as the old fixed-size chunks were --
 * this only makes the segments finer-grained when a wide span fails, never
 * changes what "safe to advance past" means.
 *
 * CURSOR SAFETY: a segment is only ever recorded `ok:true` after its own
 * direct eth_getLogs call actually succeeded for exactly that sub-range --
 * there is no path that infers success for blocks that were not queried.
 */
export async function fetchLogsAdaptive(
  fetchLogs: (fromBlock: number, toBlock: number) => Promise<unknown[]>,
  fromBlock: number,
  toBlock: number,
  minChunkSize: number = MIN_LOG_CHUNK_SIZE,
  onFailure?: (fromBlock: number, toBlock: number, error: unknown) => void,
): Promise<{ logs: unknown[]; segments: Array<{ chunk: [number, number]; ok: boolean }> }> {
  try {
    const logs = await fetchLogs(fromBlock, toBlock)
    return { logs: Array.isArray(logs) ? logs : [], segments: [{ chunk: [fromBlock, toBlock], ok: true }] }
  } catch (e) {
    const size = toBlock - fromBlock + 1
    if (size <= minChunkSize) {
      // Cannot shrink further -- a genuine failure isolated to this minimal
      // span (real RPC/network fault). Report it and stop; the cursor will
      // correctly halt at/below this range and retry it next pass.
      onFailure?.(fromBlock, toBlock, e)
      return { logs: [], segments: [{ chunk: [fromBlock, toBlock], ok: false }] }
    }
    const mid = fromBlock + Math.floor(size / 2) - 1
    const left = await fetchLogsAdaptive(fetchLogs, fromBlock, mid, minChunkSize, onFailure)
    const right = await fetchLogsAdaptive(fetchLogs, mid + 1, toBlock, minChunkSize, onFailure)
    return { logs: [...left.logs, ...right.logs], segments: [...left.segments, ...right.segments] }
  }
}

/**
 * Floor for fetchLogsAdaptive's bisection. Small enough to isolate a genuine
 * per-range fault from a volume-driven one within a couple of halvings even
 * at Arc's measured throughput; large enough that a fully-healthy pass still
 * completes in a small, bounded number of eth_getLogs calls (worst case
 * maxBlocksPerPass / MIN_LOG_CHUNK_SIZE = 3000 / 100 = 30 calls).
 */
export const MIN_LOG_CHUNK_SIZE = 100

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** `Retry-After` in RFC 7231 delta-seconds form -> ms, or null when absent/invalid. */
function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(String(raw).trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `: ${reason.message}`
  if (reason === null || reason === undefined) return ''
  try { return `: ${JSON.stringify(reason)}` } catch { return `: ${String(reason)}` }
}

async function rpcCallSingle(
  url: string, method: string, params: unknown[], deps: RpcDeps = {},
): Promise<any> {
  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  // Was `new Error(...)`, which discarded the status and made every failure
  // indistinguishable in logs ("failed on all endpoints"). The message text is
  // unchanged so existing log greps still match.
  if (!res.ok) throw new RpcHttpError(res.status, url, parseRetryAfterMs(res))
  const json = await res.json()
  if (json.error) throw json.error
  return json.result
}

/**
 * Try every endpoint in parallel, first success wins; on TOTAL failure retry the
 * whole set with jittered backoff for as long as the failures look transient.
 *
 * ── CURSOR SAFETY (unchanged) ──────────────────────────────────────────────
 * Once retries are exhausted this still THROWS, exactly as it did before. The
 * caller turns that throw into `firstFailedBlock` (native path) or `ok:false`
 * (log paths), and the cursor still stops strictly BELOW the unverified block.
 * Retrying changes only how many times a block is asked for before being
 * declared failed — never whether the cursor may advance past it. There is no
 * path through this function that reports success for a block it did not read.
 */
export async function rpcCallRace(
  urls: string[], method: string, params: unknown[], deps: RpcDeps = {},
): Promise<any> {
  // Guard: `[].every()`/`[].some()` on an empty result set must not be mistaken
  // for a retryable outcome and sleep through the whole ladder for nothing.
  if (urls.length === 0) {
    throw new Error(`${method} failed on all endpoints: no endpoints configured`)
  }

  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random
  let lastReason: unknown = null
  let attempts = 0

  for (let attempt = 0; attempt <= RPC_RETRY_BASE_MS.length; attempt++) {
    attempts++
    const results = await Promise.allSettled(
      urls.map(u => rpcCallSingle(u, method, params, deps)),
    )
    const fulfilled = results.find(
      (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    if (fulfilled) return fulfilled.value

    const rejections = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected')
    lastReason = rejections[0]?.reason ?? lastReason

    if (attempt === RPC_RETRY_BASE_MS.length) break

    // Retry while ANY endpoint failed transiently — only one needs to recover.
    // A lone deterministic failure (400, or a JSON-RPC error object) therefore
    // fails fast instead of sleeping through the ladder.
    const anyTransient = rejections.some(
      r => r.reason instanceof RpcHttpError && RETRYABLE_STATUSES.has(r.reason.status))
    if (!anyTransient) break

    // An explicit Retry-After is honored EXACTLY — jittering it below what the
    // endpoint asked for would defeat the point of the header.
    const advised = rejections
      .map(r => (r.reason instanceof RpcHttpError ? r.reason.retryAfterMs : null))
      .find((v): v is number => v !== null) ?? null

    await sleep(advised !== null
      ? advised
      : Math.round(RPC_RETRY_BASE_MS[attempt] *
          (RPC_JITTER_MIN + random() * (RPC_JITTER_MAX - RPC_JITTER_MIN))))
  }

  // Failure contract preserved: same 'failed on all endpoints' substring the
  // previous message used, now carrying the underlying HTTP detail.
  throw new Error(
    `${method} failed on all endpoints after ${attempts} attempt(s)${describeReason(lastReason)}`)
}

/** Best-effort (no throw): max block number across all endpoints. */
export async function getHead(urls: string[], deps: RpcDeps = {}): Promise<number> {
  const results = await Promise.allSettled(
    urls.map(u => rpcCallSingle(u, 'eth_blockNumber', [], deps).then(h => Number(BigInt(h)))),
  )
  const values = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(n => Number.isFinite(n) && n > 0)
  if (values.length === 0) throw new Error('eth_blockNumber failed on all endpoints')
  return Math.max(...values)
}

export interface ScanOutcome {
  events: Array<Record<string, unknown>>
  safeUpTo: number
  safeUpToHash: string | null
  confirmableBlocks: number[]
}

/**
 * Scan a [from, to] block range on one chain.
 *
 * Native block scan: every block, full transactions, tx.to in known-wallet
 * set -> deposit event. ERC-20 log scan: every token, eth_getLogs, incoming
 * Transfer matched in memory -> transfer event. Both are the deposit-scan-all
 * proven strategies.
 */
export async function scanRange(
  chain: {
    id: string
    rpcs: string[]
    nativeTransferLogContract?: string | null
    tokens: Array<{ symbol: string; contract: string; decimals: number }>
  },
  fromBlock: number,
  toBlock: number,
  knownWallets: Set<string>,
  deps: RpcDeps = {},
): Promise<ScanOutcome> {
  const events: Array<Record<string, unknown>> = []
  const confirmableBlocks: number[] = []

  /**
   * Guards against emitting two events for one on-chain credit.
   *
   * A contract-mediated USDC transfer is visible BOTH as a top-level tx (when
   * tx.to is the wallet) and as a Transfer log on the native-transfer contract.
   * Keying on (tx_hash, wallet) means whichever path sees it first wins and the
   * second is dropped. Within a pass this is authoritative; ACROSS passes the
   * chain_events partial unique index is the real backstop, so a re-scan after
   * a cursor rollback stays idempotent.
   */
  const emitted = new Set<string>()
  const emitKey = (txHash: string, wallet: string) => `${txHash}:${wallet}`

  // ── Native block scan (Arc USDC = native gas) ─────────────────────────────
  //
  // FIX 1 — block-level failure granularity. This previously wrapped an entire
  // 500-block chunk in one try/catch and marked the whole chunk ok:false on any
  // failure, so a single transient RPC hiccup at block 250 of 500 discarded 249
  // successfully-fetched blocks and advanced the cursor by ZERO. safeAdvance
  // then returned `from - 1`, which is below the scan window, and index.ts took
  // its "no contiguous progress in pass" branch. Deployed result: 33 consecutive
  // failures, last_success_at NULL, cursor frozen at cold start while the chain
  // moved 8,737 blocks ahead — so the three missed transactions were never in
  // scan range at all.
  //
  // Now tracks firstFailedBlock at BLOCK granularity and advances to
  // firstFailedBlock - 1, exactly as deposit-scan-all's fetchNativeDepositsRange
  // has always done. A failed block is never skipped and never passed over: the
  // cursor stops below it and the next pass retries from there.
  //
  // FIX 2 — concurrency 8, matching deposit-scan-all's NATIVE_BLOCK_CONCURRENCY.
  // Measured on Arc: 310ms/block serial vs 49ms/block at 8 (6.3x). Serial made a
  // transient failure near-certain over a 155s chunk, which under the old
  // all-or-nothing rule meant permanent zero progress. Bounded batches, never an
  // unbounded Promise.all over the whole range.
  const NATIVE_BLOCK_CONCURRENCY = 8

  const blockNumbers: number[] = []
  for (let b = fromBlock; b <= toBlock; b++) blockNumbers.push(b)

  let firstFailedBlock: number | null = null

  for (let i = 0; i < blockNumbers.length; i += NATIVE_BLOCK_CONCURRENCY) {
    // Stop launching new batches once a failure is known — blocks beyond it
    // cannot be committed anyway, so fetching them is wasted RPC budget.
    if (firstFailedBlock !== null) break

    const batch = blockNumbers.slice(i, i + NATIVE_BLOCK_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(bn => rpcCallRace(chain.rpcs, 'eth_getBlockByNumber', ['0x' + bn.toString(16), true], deps)),
    )

    for (let j = 0; j < results.length; j++) {
      const bn = batch[j]
      const r = results[j]

      // A rejected fetch OR a malformed body both mean "this block was not
      // read". Recording the LOWEST such block keeps the advance contiguous
      // even though results within a batch complete out of order.
      if (r.status !== 'fulfilled' || !Array.isArray(r.value?.transactions)) {
        console.error(
          `[blockchain-indexer] native block ${bn} fetch failed:`,
          r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : 'malformed block',
        )
        if (firstFailedBlock === null || bn < firstFailedBlock) firstFailedBlock = bn
        continue
      }

      const txs: any[] = r.value.transactions

      // Acceptance filters mirror deposit-scan-all's native path exactly
      // (fetchNativeDepositsRange). Any divergence here shows up as a
      // spurious indexer_only/worker_only row and would be read as a real
      // detection difference rather than as the comparison artifact it is.
      for (const tx of txs) {
        const to = (tx?.to ?? '').toLowerCase()
        if (!to) continue                             // contract creation
        if (!knownWallets.has(to)) continue           // not one of ours
        const from = (tx?.from ?? '').toLowerCase()
        if (from === to) continue                     // self-send: no net transfer
        let amount: number
        try { amount = Number(BigInt(tx.value ?? '0x0')) / 10 ** NATIVE_DECIMALS } catch { continue }
        if (!Number.isFinite(amount) || amount <= 0) continue  // 0-value contract call
        const txh = (tx.hash ?? '').toLowerCase()
        emitted.add(emitKey(txh, to))
        events.push({
          chain_id: chain.id,
          block_number: bn,
          tx_hash: txh,
          event_type: 'deposit_detected',
          wallet_address: to,
          assets: ['USDC'],
          metadata: { recipient: to, sender: from, amount },
          status: 'pending',
          // No log at all for a plain top-level native-value transfer — there is
          // no contract, no log_index, no event signature. block_hash and
          // transaction_index ARE available on the tx object this came from
          // (eth_getBlockByNumber with full transactions), captured here at
          // zero extra RPC cost. See docs/PHASE_3_INDEXER_AUDIT.md §6/§7.
          log_index: null,
          contract_address: null,
          event_signature: null,
          block_hash: (r.value?.hash as string | undefined)?.toLowerCase() ?? null,
          transaction_index: tx.transactionIndex != null ? Number(BigInt(tx.transactionIndex)) : null,
        })
      }
      confirmableBlocks.push(bn)
    }
  }

  // Highest block the native scan can vouch for. Identical rule to
  // deposit-scan-all: stop strictly BELOW the first failure so it is retried,
  // never skipped.
  const nativeSafe = firstFailedBlock !== null ? firstFailedBlock - 1 : toBlock

  // ── Contract-mediated native-USDC scan (FIX B) ────────────────────────────
  // The native block scan above can only see a credit when `tx.to` IS the
  // wallet. A transfer routed through the 0x3600 ERC-20 wrapper has
  // tx.to = 0x3600…, tx.value = 0, so the wallet is genuinely credited but the
  // transaction is invisible to that scan. Six such 20-USDC deposits to
  // registered wallets were confirmed missed on live data.
  //
  // 0xffff…fffe emits a Transfer log for EVERY native-USDC movement, wrapper-
  // routed or plain, in 18 decimals. See the measurement recorded in chains.ts
  // for why this single contract is authoritative and why scanning the 0x3600
  // wrapper as well would double-count.
  //
  // Runs only up to nativeSafe: emitting for a block the native scan could not
  // vouch for would put events above the committed cursor.
  const nativeLogResults: Array<{ chunk: [number, number]; ok: boolean }> = []
  const nativeLogContract = chain.nativeTransferLogContract

  if (nativeLogContract && nativeSafe >= fromBlock) {
    const { logs, segments } = await fetchLogsAdaptive(
      async (f, end) => {
        const result = await rpcCallRace(chain.rpcs, 'eth_getLogs', [{
          address: nativeLogContract,
          topics: [TRANSFER_TOPIC0],
          fromBlock: '0x' + f.toString(16),
          toBlock:   '0x' + end.toString(16),
        }], deps)
        return Array.isArray(result) ? result : []
      },
      fromBlock, nativeSafe, MIN_LOG_CHUNK_SIZE,
      (f, end, e) => console.error(
        `[blockchain-indexer] native-usdc-log scan failed: chain=${chain.id} ` +
        `contract=${nativeLogContract} fromBlock=${f} toBlock=${end}:`,
        e instanceof Error ? e.message : String(e),
      ),
    )
    nativeLogResults.push(...segments)
    for (const log of logs) {
        // Identical acceptance rules to the native branch, so the two paths
        // can never disagree about what counts as a deposit.
        {
          const decoded = decodeTransferLog(log as any, NATIVE_DECIMALS, nativeLogContract)
          if (!decoded) continue
          const { wallet, from } = decoded
          if (!wallet || !knownWallets.has(wallet)) continue
          if (isMintTransfer(decoded)) continue   // mint: claim-worker owns
          if (isSelfTransfer(decoded)) continue   // self-transfer

          const txh = decoded.txHash
          const k = emitKey(txh, wallet)
          if (emitted.has(k)) continue   // already emitted by the native scan
          emitted.add(k)

          events.push({
            chain_id: chain.id,
            block_number: decoded.blockNumber,
            tx_hash: txh,
            event_type: 'deposit_detected',
            wallet_address: wallet,
            assets: ['USDC'],
            metadata: { recipient: wallet, sender: from, amount: decoded.amount, via: 'native-transfer-log' },
            status: 'pending',
            // Captured directly from the eth_getLogs response already being
            // read — no extra RPC call. See docs/PHASE_3_INDEXER_AUDIT.md §6/§7
            // for why log_index in particular matters: this is the field that
            // makes the dedup identity correct when a tx produces more than
            // one Transfer log.
            log_index: decoded.logIndex,
            contract_address: nativeLogContract,
            event_signature: 'Transfer(address,address,uint256)',
            block_hash: decoded.blockHash,
            transaction_index: decoded.transactionIndex,
          })
        }
    }
  }

  // ── ERC-20 log scan (EURC / cirBTC) ───────────────────────────────────────
  const logResults: Array<{ chunk: [number, number]; ok: boolean }> = []

  for (const token of chain.tokens) {
    const { logs, segments } = await fetchLogsAdaptive(
      async (f, end) => {
        const filter = {
          address: token.contract,
          topics: [TRANSFER_TOPIC0],
          fromBlock: '0x' + f.toString(16),
          toBlock:   '0x' + end.toString(16),
        }
        const result = await rpcCallRace(chain.rpcs, 'eth_getLogs', [filter], deps)
        return Array.isArray(result) ? result : []
      },
      fromBlock, toBlock, MIN_LOG_CHUNK_SIZE,
      (f, end, e) => console.error(
        `[blockchain-indexer] erc20-log scan failed: chain=${chain.id} ` +
        `token=${token.symbol} contract=${token.contract} fromBlock=${f} toBlock=${end}:`,
        e instanceof Error ? e.message : String(e),
      ),
    )
    logResults.push(...segments)
    // Filters mirror deposit-scan-all's log path exactly — same reason as
    // the native branch above.
    for (const log of logs) {
      const decoded = decodeTransferLog(log as any, token.decimals, token.contract)
      if (!decoded) continue
      const { wallet, from } = decoded
      if (!wallet || !knownWallets.has(wallet)) continue
      // A zero-address sender is a MINT, which is a CCTP claim arriving —
      // claim-recovery-scan owns that, and the legacy deposit scan skips
      // it. Emitting it here would look like an indexer_only find.
      if (isMintTransfer(decoded)) continue
      if (isSelfTransfer(decoded)) continue // self-transfer
      events.push({
        chain_id: chain.id,
        block_number: decoded.blockNumber,
        tx_hash: decoded.txHash,
        event_type: 'transfer_detected',
        wallet_address: wallet,
        assets: [token.symbol],
        metadata: { to: wallet, from, amount: decoded.amount },
        status: 'pending',
        // Same reasoning as the native-transfer-log branch above — this is
        // the field that makes multi-recipient transactions (BulkPay/
        // Multicall3, once that coverage is added) dedup correctly instead
        // of colliding with each other. See
        // docs/PHASE_3_INDEXER_AUDIT.md §6/§7.
        log_index: decoded.logIndex,
        contract_address: token.contract,
        event_signature: 'Transfer(address,address,uint256)',
        block_hash: decoded.blockHash,
        transaction_index: decoded.transactionIndex,
      })
    }
  }

  // ── Safe advance + hash of the tip ────────────────────────────────────────
  // safeUpTo is the min of what the native scan and the log scan each reached
  // contiguously. If EITHER had a gap, the cursor must stop before it.
  //
  // nativeSafe is now computed at BLOCK granularity above (firstFailedBlock - 1)
  // rather than via safeAdvance over 500-block chunks — that chunk-level rule is
  // what froze the deployed cursor. The log scan keeps chunk granularity because
  // eth_getLogs is inherently range-based: a failed range yields no per-block
  // information, so there is no finer boundary available to stop at.
  const logSafe = safeAdvance(fromBlock, logResults)
  // The contract-mediated pass is a third source that can gap independently.
  // If it failed partway, the cursor must stop below that failure too —
  // otherwise a wrapper-routed deposit in the skipped range is lost forever.
  const nativeLogSafe = nativeLogContract
    ? safeAdvance(fromBlock, nativeLogResults)
    : Number.MAX_SAFE_INTEGER
  const safeUpTo = Math.min(nativeSafe, logSafe, nativeLogSafe)

  // A block is only confirmable if the cursor actually reached it. The native
  // loop pushes every block it successfully read, but a failure at a LOWER block
  // (or a gap in the log scan) holds safeUpTo back while higher blocks in the
  // same batch may already have succeeded — so this list can legitimately
  // contain blocks above the cursor. Marking those 'confirmed' would finalize
  // events in a range the next pass is going to re-scan, which is precisely the
  // cursor/status inconsistency the reorg design exists to prevent.
  const confirmable = confirmableBlocks.filter(b => b <= safeUpTo)

  let safeUpToHash: string | null = null
  if (safeUpTo >= fromBlock) {
    try {
      const block = await rpcCallRace(chain.rpcs, 'eth_getBlockByNumber', ['0x' + safeUpTo.toString(16), false], deps)
      safeUpToHash = block?.hash ?? null
    } catch {
      safeUpToHash = null // next pass re-derives it
    }
  }

  // Events above the cursor are dropped for the same reason: the next pass
  // re-scans that range, and the DB's dedup index makes re-emission harmless.
  // Keeping them would publish events for blocks we did not commit to.
  const committedEvents = events.filter(e => (e.block_number as number) <= safeUpTo)

  return { events: committedEvents, safeUpTo, safeUpToHash, confirmableBlocks: confirmable }
}
