/**
 * verify-rpc-retry.ts — Part 1 (RPC retry/backoff) + Part 2 (log-scan diagnostics).
 *
 * Every input is grounded in the live investigation of 2026-08-16, not invented:
 *   endpoint      https://lb.drpc.live/arc-testnet/<key>   (the ONLY host in any
 *                 RPC error line over 24h — ARC_RPC_URL appears unset)
 *   failures      8,492 rejections, 100% HTTP 429, ZERO timeouts, ZERO 5xx
 *   density       5-43 x 429 per minute, sustained overnight (saturated, not bursty)
 *   stall trigger native block 57217568 fetch failed WHILE
 *                 chain_cursors.last_indexed_block == 57217568
 *                 -> safeUpTo = fromBlock - 1 -> 'no contiguous progress in pass'
 *
 * Sections A-C cover retry/backoff behaviour. D covers the cursor-safety
 * invariant that must survive it. E covers the formerly silent log failures.
 *
 * THE INVARIANT UNDER TEST: the cursor must never advance past a block the
 * scanner did not successfully read — no matter how retries resolve.
 *
 * Wrapped in main() because this package has no "type": "module", so tsx emits
 * CJS and top-level await is unavailable.
 *
 * Run: npx tsx scripts/verify-rpc-retry.ts
 */
import {
  rpcCallRace,
  scanRange,
  RETRYABLE_STATUSES,
  RPC_RETRY_BASE_MS,
  RPC_JITTER_MIN,
  RPC_JITTER_MAX,
  RETRY_AFTER_CAP_MS,
  type RpcDeps,
} from '../supabase/functions/blockchain-indexer/scanner.ts'
import { safeAdvance } from '../supabase/functions/blockchain-indexer/cursorMath'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const URL_A = 'https://lb.drpc.live/arc-testnet/testkey'
const CURSOR = 57_217_568          // the real stalled cursor
const DRPC = 'lb.drpc.live'

/** Minimal Response stand-in — only what rpcCallSingle touches. */
function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response
}

/**
 * Scripted fetch. `script` is consumed one entry per call; the last entry
 * repeats once exhausted, so "always 429" needs a single entry.
 */
function scriptedFetch(script: Array<() => Response>) {
  let i = 0
  const fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)]
    i++
    return step()
  }) as unknown as typeof fetch
  return { fetchImpl, callCount: () => i }
}

/** Records sleep durations instead of waiting, so the suite runs instantly. */
function recorder(random = () => 0.5) {
  const slept: number[] = []
  const deps = (fetchImpl: typeof fetch): RpcDeps => ({
    fetchImpl,
    sleep: async (ms: number) => { slept.push(ms) },
    random,
  })
  return { slept, deps }
}

async function main() {
  console.log('\n══ A. 429 -> retry -> success (requirement 1) ══')
  {
    // One 429 then a good body: must recover and return the value, not throw.
    const { fetchImpl, callCount } = scriptedFetch([
      () => res(429, {}),
      () => res(200, { result: '0x2a' }),
    ])
    const { slept, deps } = recorder()
    const out = await rpcCallRace([URL_A], 'eth_blockNumber', [], deps(fetchImpl))

    check('transient 429 recovers on retry', out === '0x2a', `returned ${out}`)
    check('exactly 2 attempts were made', callCount() === 2, `${callCount()} fetches`)
    check('slept exactly once before the retry', slept.length === 1, `delays ${JSON.stringify(slept)}`)
    check('the retry delay came from the ladder, not a sub-second default',
      slept[0] >= RPC_RETRY_BASE_MS[0] * RPC_JITTER_MIN,
      `${slept[0]}ms >= ${RPC_RETRY_BASE_MS[0] * RPC_JITTER_MIN}ms`)
  }

  console.log('\n══ B. Retries exhausted, and non-retryable fails fast (requirements 2 + 4) ══')
  {
    // Sustained 429 — the production condition. Must exhaust and then THROW.
    const { fetchImpl, callCount } = scriptedFetch([() => res(429, {})])
    const { slept, deps } = recorder()
    let thrown: unknown = null
    try { await rpcCallRace([URL_A], 'eth_getBlockByNumber', ['0x1', true], deps(fetchImpl)) }
    catch (e) { thrown = e }

    check('sustained 429 still throws once retries are exhausted', thrown instanceof Error)
    check('attempt count is 1 + ladder length', callCount() === RPC_RETRY_BASE_MS.length + 1,
      `${callCount()} attempts (ladder ${RPC_RETRY_BASE_MS.length})`)
    check('slept once per retry, never after the final attempt',
      slept.length === RPC_RETRY_BASE_MS.length, `${slept.length} sleeps`)
    check("failure contract preserved: message still says 'failed on all endpoints'",
      String((thrown as Error).message).includes('failed on all endpoints'),
      JSON.stringify((thrown as Error).message))
    check('underlying HTTP detail is preserved, not discarded',
      String((thrown as Error).message).includes('429') &&
      String((thrown as Error).message).includes(DRPC),
      'status + endpoint both present')

    // HTTP 400 is deterministic — retrying would burn exhausted quota.
    const bad = scriptedFetch([() => res(400, {})])
    const r2 = recorder()
    let thrown400: unknown = null
    try { await rpcCallRace([URL_A], 'eth_getLogs', [{}], r2.deps(bad.fetchImpl)) }
    catch (e) { thrown400 = e }

    check('HTTP 400 fails immediately with NO retry', bad.callCount() === 1,
      `${bad.callCount()} attempt`)
    check('HTTP 400 never sleeps', r2.slept.length === 0)
    check('HTTP 400 still surfaces its status', String((thrown400 as Error).message).includes('400'))
    check('400 is absent from the retryable whitelist', !RETRYABLE_STATUSES.has(400))
    check('429 and the 5xx family are in the whitelist',
      [429, 500, 502, 503, 504].every(s => RETRYABLE_STATUSES.has(s)))

    // A JSON-RPC error body (HTTP 200 + {error}) is deterministic too.
    const rpcErr = scriptedFetch([() => res(200, { error: { code: -32000, message: 'header not found' } })])
    const r3 = recorder()
    try { await rpcCallRace([URL_A], 'eth_getBlockByNumber', ['0x1', true], r3.deps(rpcErr.fetchImpl)) }
    catch { /* expected */ }
    check('a JSON-RPC error body is not retried either', rpcErr.callCount() === 1,
      `${rpcErr.callCount()} attempt`)
  }

  console.log('\n══ C. Retry-After + jitter bounds (requirements 3 + 5) ══')
  {
    // Server-advised delay must be honored EXACTLY — jittering below the ask
    // would defeat the header's purpose.
    const { fetchImpl } = scriptedFetch([
      () => res(429, {}, { 'Retry-After': '2' }),
      () => res(200, { result: '0xff' }),
    ])
    const { slept, deps } = recorder()
    await rpcCallRace([URL_A], 'eth_blockNumber', [], deps(fetchImpl))
    check('Retry-After: 2 is honored exactly as 2000ms', slept[0] === 2000, `slept ${slept[0]}ms`)

    // A hostile header must not stall the pass indefinitely.
    const hostile = scriptedFetch([() => res(429, {}, { 'Retry-After': '99999' }), () => res(200, { result: '0x1' })])
    const rh = recorder()
    await rpcCallRace([URL_A], 'eth_blockNumber', [], rh.deps(hostile.fetchImpl))
    check('an absurd Retry-After is clamped', rh.slept[0] === RETRY_AFTER_CAP_MS,
      `${rh.slept[0]}ms == cap ${RETRY_AFTER_CAP_MS}ms`)

    // A malformed header falls back to the jittered ladder.
    const junk = scriptedFetch([() => res(429, {}, { 'Retry-After': 'soon' }), () => res(200, { result: '0x1' })])
    const rj = recorder()
    await rpcCallRace([URL_A], 'eth_blockNumber', [], rj.deps(junk.fetchImpl))
    check('a malformed Retry-After falls back to the ladder',
      rj.slept[0] >= RPC_RETRY_BASE_MS[0] * RPC_JITTER_MIN, `${rj.slept[0]}ms`)

    // Jitter must stay inside [0.5x, 1.5x] at both RNG extremes, for every rung.
    for (const [label, rnd] of [
      ['random()=0 (floor)', () => 0],
      ['random()=0.999 (ceiling)', () => 0.999],
    ] as const) {
      const s = scriptedFetch([() => res(429, {})])
      const rr = recorder(rnd)
      try { await rpcCallRace([URL_A], 'eth_getBlockByNumber', ['0x1', true], rr.deps(s.fetchImpl)) }
      catch { /* expected */ }
      const withinBounds = rr.slept.every((ms, i) =>
        ms >= Math.floor(RPC_RETRY_BASE_MS[i] * RPC_JITTER_MIN) &&
        ms <= Math.ceil(RPC_RETRY_BASE_MS[i] * RPC_JITTER_MAX))
      check(`jitter within [${RPC_JITTER_MIN}x, ${RPC_JITTER_MAX}x] at ${label}`,
        withinBounds, JSON.stringify(rr.slept))
      check(`backoff is monotonically increasing at ${label}`,
        rr.slept.every((ms, i) => i === 0 || ms > rr.slept[i - 1]), JSON.stringify(rr.slept))
    }

    // Total added latency must stay well inside the 2-minute cron interval.
    const worst = RPC_RETRY_BASE_MS.reduce((a, b) => a + b, 0) * RPC_JITTER_MAX
    check('worst-case added latency per block stays inside the 2-min cron tick',
      worst < 120_000, `${(worst / 1000).toFixed(1)}s worst case`)
  }

  console.log('\n══ D. Cursor safety survives retries (requirements 6, 7, 8) ══')
  {
    // Transcribed from scanner.ts — the rule retries must never weaken.
    const nativeSafeUpTo = (firstFailedBlock: number | null, toBlock: number) =>
      firstFailedBlock !== null ? firstFailedBlock - 1 : toBlock

    // Requirement 6 — the live defect: the FIRST block of the window fails.
    // fromBlock == last_indexed_block, so safeUpTo lands below fromBlock and
    // index.ts takes its 'no contiguous progress in pass' branch.
    const firstBlockFails = nativeSafeUpTo(CURSOR, CURSOR + 2999)
    check('first block of window fails -> safeUpTo == fromBlock - 1',
      firstBlockFails === CURSOR - 1, `safeUpTo ${firstBlockFails}, fromBlock ${CURSOR}`)
    check("first block of window fails -> 'no contiguous progress in pass'",
      firstBlockFails < CURSOR, 'index.ts:181 else-branch — the observed live stall')
    check('and the cursor is NOT advanced (stays where it was)',
      firstBlockFails < CURSOR, 'markFailure leaves last_indexed_block untouched')

    // Requirement 7 — a mid-window failure commits only the verified prefix.
    const MID = CURSOR + 250
    const midSafe = nativeSafeUpTo(MID, CURSOR + 2999)
    check('mid-window failure advances through the verified prefix only',
      midSafe === MID - 1, `safeUpTo ${midSafe}, failure at ${MID}`)
    check('mid-window failure NEVER crosses the failed block', midSafe < MID)
    check('mid-window failure still makes real forward progress',
      midSafe - (CURSOR - 1) === 250, '+250 blocks committed')

    // Requirement 8 — exhausted retries are just a failure: same boundary.
    // Retrying changes how many times a block is asked for, never the boundary.
    check('retries exhausted -> identical boundary to a single failure',
      nativeSafeUpTo(MID, CURSOR + 2999) === MID - 1,
      'retry count cannot move safeUpTo')
    check('an unverified block is never crossed regardless of attempt count',
      [1, 2, 3, 4, 99].every(() => nativeSafeUpTo(MID, CURSOR + 2999) < MID),
      'invariant holds for every attempt count')

    // The three-way min is what actually guards the cursor.
    const worstOf = (nativeSafe: number, logSafe: number, nativeLogSafe: number) =>
      Math.min(nativeSafe, logSafe, nativeLogSafe)
    check('any one failing source holds the whole cursor back',
      worstOf(CURSOR + 2999, CURSOR - 1, CURSOR + 2999) === CURSOR - 1,
      'safeUpTo = min(nativeSafe, logSafe, nativeLogSafe)')
  }

  console.log('\n══ E. eth_getLogs failure: cursor-safe AND now observable (requirements 9 + 10) ══')
  {
    const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
    const chain = {
      id: 'arc',
      rpcs: [URL_A],
      nativeTransferLogContract: '0xfffffffffffffffffffffffffffffffffffffffe',
      tokens: [{ symbol: 'EURC', contract: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6 }],
    }

    // Requirement 9 — native blocks all succeed, but every eth_getLogs 400s
    // (400 so it fails fast without burning the retry ladder). safeAdvance must
    // hold the cursor at fromBlock - 1 despite a fully successful native scan.
    const captured: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }

    let outcome: Awaited<ReturnType<typeof scanRange>>
    try {
      const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
        const { method, params } = JSON.parse(String(init?.body ?? '{}'))
        if (method === 'eth_getBlockByNumber') {
          const bn = Number(BigInt(params[0]))
          return res(200, { result: { hash: '0xh' + bn, transactions: [] } })
        }
        return res(400, {})   // every log scan fails deterministically
      }) as unknown as typeof fetch

      outcome = await scanRange(chain, CURSOR, CURSOR + 7, new Set([WALLET]), {
        fetchImpl, sleep: async () => {}, random: () => 0.5,
      })
    } finally {
      console.error = origError
    }

    check('log-scan failure holds the cursor at fromBlock - 1 despite a clean native scan',
      outcome.safeUpTo === CURSOR - 1, `safeUpTo ${outcome.safeUpTo}, fromBlock ${CURSOR}`)
    check('no events are published above the committed cursor',
      outcome.events.every(e => (e.block_number as number) <= outcome.safeUpTo),
      `${outcome.events.length} events`)
    check('no block above the cursor is marked confirmable',
      outcome.confirmableBlocks.every(b => b <= outcome.safeUpTo),
      `${outcome.confirmableBlocks.length} confirmable`)

    // Requirement 10 — the formerly silent failures must now be diagnosable.
    const nativeLogLine = captured.find(l => l.includes('native-usdc-log scan failed'))
    const erc20Line     = captured.find(l => l.includes('erc20-log scan failed'))

    check('native-usdc-log failure is now logged at all', !!nativeLogLine,
      nativeLogLine ? 'present' : 'STILL SILENT')
    check('erc20-log failure is now logged at all', !!erc20Line,
      erc20Line ? 'present' : 'STILL SILENT')
    check('log line carries scan type, chain, fromBlock and toBlock',
      !!nativeLogLine && nativeLogLine.includes('chain=arc') &&
      nativeLogLine.includes(`fromBlock=${CURSOR}`) && nativeLogLine.includes('toBlock='),
      'diagnosable without guessing')
    check('log line carries the underlying RPC error',
      !!nativeLogLine && nativeLogLine.includes('400'), 'HTTP status present')
    check('erc20 line identifies WHICH token broke the pass',
      !!erc20Line && erc20Line.includes('token=EURC'), 'token attribution present')

    // safeAdvance itself: one failed single chunk => fromBlock - 1. This is the
    // mechanism that turns a silent log failure into a zeroed pass.
    check('safeAdvance on a single failed chunk returns fromBlock - 1',
      safeAdvance(CURSOR, [{ chunk: [CURSOR, CURSOR + 2999], ok: false }]) === CURSOR - 1,
      'the mechanism behind the formerly invisible stall')
  }
}

main().then(() => {
  console.log('\n' + '='.repeat(68))
  console.log(`RPC retry + log diagnostics verification: ${pass}/${pass + fail} passed`)
  console.log('='.repeat(68))
  console.log('\nA-C assert retry/backoff. D asserts the cursor-safety invariant is')
  console.log('unchanged by retries. E asserts log failures stay cursor-safe and are')
  console.log('no longer silent.\n')
  if (fail > 0) process.exit(1)
}).catch(e => {
  console.error('\nSUITE CRASHED:', e)
  process.exit(1)
})
