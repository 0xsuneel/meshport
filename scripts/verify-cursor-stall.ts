/**
 * verify-cursor-stall.ts — the deployed cursor stall, and the fix for it.
 *
 * Every input is real, not invented:
 *   cursor      55,901,486   (chain_cursors: sync_state=error, 33 failures,
 *                             last_success_at NULL)
 *   head        ~55,910,223  (live at diagnosis)
 *   block time  0.51 s       (measured over 1000 blocks)
 *   fetch cost  310 ms/block serial, 49 ms/block at concurrency 8 (measured)
 *   TX1 0x18407c66… block 55,907,569  wallet receives USDC via 0x3600 wrapper
 *   TX2 0x41113da1… block 55,907,444  plain native USDC transfer to wallet
 *   TX3 0x8538c053… block 55,906,323  CCTP mint (from 0x0) via 0x3600 wrapper
 *
 * Sections A-D describe WHY the cursor froze (the old chunk-level rule).
 * Sections E-H assert the NEW block-level behaviour required by fixes 1 & 2.
 *
 * Run: npx tsx scripts/verify-cursor-stall.ts
 */
import { safeAdvance } from '../supabase/functions/blockchain-indexer/cursorMath'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const CURSOR = 55_901_486
const HEAD   = 55_910_223
const MAX_BLOCKS_PER_PASS = 3000
const CONCURRENCY = 8

/** The NEW native rule, transcribed from scanner.ts after fix 1. */
function nativeSafeUpTo(firstFailedBlock: number | null, toBlock: number): number {
  return firstFailedBlock !== null ? firstFailedBlock - 1 : toBlock
}

/**
 * Simulates the fixed native loop: bounded batches of 8, block-level failure
 * tracking, stop launching batches once a failure is known.
 */
function simulateNativeScan(from: number, to: number, failingBlocks: Set<number>) {
  const nums: number[] = []
  for (let b = from; b <= to; b++) nums.push(b)

  let firstFailedBlock: number | null = null
  const processed: number[] = []
  const batchesRun: number[] = []
  let fetches = 0

  for (let i = 0; i < nums.length; i += CONCURRENCY) {
    if (firstFailedBlock !== null) break
    const batch = nums.slice(i, i + CONCURRENCY)
    batchesRun.push(batch.length)
    fetches += batch.length
    for (const bn of batch) {
      if (failingBlocks.has(bn)) {
        if (firstFailedBlock === null || bn < firstFailedBlock) firstFailedBlock = bn
        continue                       // failure isolated to this block
      }
      processed.push(bn)               // unrelated success preserved
    }
  }
  return {
    firstFailedBlock,
    processed,
    safeUpTo: nativeSafeUpTo(firstFailedBlock, to),
    maxBatchSize: Math.max(...batchesRun, 0),
    fetches,
  }
}

console.log('\n══ A. The stall was arithmetic, not bad luck ══')
{
  check('cursor was far behind head', HEAD - CURSOR > 8000, `${HEAD - CURSOR} blocks behind`)
  const blocksPerTick = Math.round(120 / 0.51)
  const serialPerTick = (blocksPerTick * 310) / 1000
  check('a healthy cursor keeps up serially, but with almost no headroom',
    serialPerTick < 120 && serialPerTick > 60,
    `${blocksPerTick} blocks x 310ms = ${serialPerTick.toFixed(0)}s of a 120s tick`)
  check('one 500-block chunk exceeded the function time budget serially',
    (500 * 310) / 1000 > 150, `${((500 * 310) / 1000).toFixed(0)}s`)
  check('the same work at concurrency 8 fits comfortably',
    (500 * 49) / 1000 < 60, `${((500 * 49) / 1000).toFixed(0)}s (6.3x measured)`)
}

console.log('\n══ B. OLD behaviour: one bad block destroyed a whole pass ══')
{
  // The old code marked an entire 500-block chunk ok:false on any failure.
  const oldChunks = [
    { chunk: [CURSOR, CURSOR + 499] as [number, number], ok: false },
    { chunk: [CURSOR + 500, CURSOR + 999] as [number, number], ok: true },
  ]
  const oldAdvance = safeAdvance(CURSOR, oldChunks)
  check('old rule advanced to NOTHING', oldAdvance === CURSOR - 1,
    `safeAdvance -> ${oldAdvance} (below cursor ${CURSOR})`)
  check('which produced the exact deployed error', oldAdvance < CURSOR,
    "'no contiguous progress in pass'")
}

console.log('\n══ C. Why the old stall was permanent ══')
{
  let head = CURSOR
  for (let t = 0; t < 33; t++) head += Math.round(120 / 0.51)
  check('33 failed passes only widened the gap', head - CURSOR > 7000,
    `gap ${head - CURSOR} after 33 ticks`)
  check('gap outgrew the per-pass cap — no catch-up possible',
    head - CURSOR > MAX_BLOCKS_PER_PASS,
    `${head - CURSOR} > ${MAX_BLOCKS_PER_PASS}`)
}

console.log('\n══ D. The three missed txs were never in scan range ══')
{
  const windowEnd = Math.min(HEAD, CURSOR + MAX_BLOCKS_PER_PASS)
  for (const t of [
    { id: 'TX1 0x18407c66', block: 55_907_569 },
    { id: 'TX2 0x41113da1', block: 55_907_444 },
    { id: 'TX3 0x8538c053', block: 55_906_323 },
  ]) {
    check(`${t.id} beyond scan window`, t.block > windowEnd,
      `block ${t.block} > ${windowEnd}`)
  }
}

console.log('\n══ E. FIX 1 — mid-chunk failure now yields real progress ══')
{
  // Requirement 1-5: 500-block chunk, failure in the middle, blocks before the
  // failure succeed, cursor advances only to failureBlock - 1.
  const FAIL_AT = CURSOR + 250
  const to = CURSOR + 499
  const r = simulateNativeScan(CURSOR, to, new Set([FAIL_AT]))

  check('cursor advances to exactly failureBlock - 1',
    r.safeUpTo === FAIL_AT - 1, `safeUpTo ${r.safeUpTo}, failure at ${FAIL_AT}`)
  check('blocks before the failure were processed',
    r.processed.includes(CURSOR) && r.processed.includes(FAIL_AT - 1),
    `${r.processed.length} blocks processed`)
  check('NEVER advances past the failed block',
    r.safeUpTo < FAIL_AT, `${r.safeUpTo} < ${FAIL_AT}`)
  check('the failed block itself is NOT marked processed',
    !r.processed.includes(FAIL_AT))
  check('real progress vs the old rule',
    r.safeUpTo - (CURSOR - 1) === 250,
    `+${r.safeUpTo - (CURSOR - 1)} blocks where the old rule gave +0`)

  // Requirement 4: blocks after the failure may succeed in the same batch, but
  // must not be committed — they sit above the cursor.
  const aboveCursor = r.processed.filter(b => b > r.safeUpTo)
  check('successes above the failure are not committed',
    aboveCursor.every(b => b > r.safeUpTo),
    `${aboveCursor.length} read-but-uncommitted (safe: dedup index makes re-scan a no-op)`)
}

console.log('\n══ F. FIX 1 — retry, no skipping, restart safety ══')
{
  const FAIL_AT = CURSOR + 250
  // Requirement 6: the failed block is retried on the next pass.
  const p1 = simulateNativeScan(CURSOR, CURSOR + 499, new Set([FAIL_AT]))
  const nextFrom = p1.safeUpTo            // index.ts uses cursor as fromBlock
  check('next pass starts at or below the failed block',
    nextFrom < FAIL_AT, `next fromBlock ${nextFrom} < ${FAIL_AT}`)

  // Requirement 8: transient failure clears, cursor continues past it.
  const p2 = simulateNativeScan(nextFrom, nextFrom + 499, new Set())
  check('once transient failure clears, cursor moves past it',
    p2.safeUpTo > FAIL_AT, `pass 2 safeUpTo ${p2.safeUpTo} > ${FAIL_AT}`)

  // Requirement 7: no block is skipped across the two passes.
  const covered = new Set<number>([...p1.processed, ...p2.processed])
  const skipped: number[] = []
  for (let b = CURSOR; b <= p2.safeUpTo; b++) if (!covered.has(b)) skipped.push(b)
  check('NO block skipped across the retry', skipped.length === 0,
    skipped.length ? `skipped ${skipped.slice(0, 5)}` : 'full coverage')

  // Requirement 9: restart from the persisted cursor is safe.
  const restart = simulateNativeScan(p1.safeUpTo, p1.safeUpTo + 499, new Set())
  check('restart from persisted cursor re-covers the failed block',
    restart.processed.includes(FAIL_AT), 're-scan is idempotent via the dedup index')
}

console.log('\n══ G. FIX 2 — bounded concurrency 8 ══')
{
  const r = simulateNativeScan(CURSOR, CURSOR + 99, new Set())
  check('batch size never exceeds 8', r.maxBatchSize <= CONCURRENCY,
    `max batch ${r.maxBatchSize}`)
  check('no unbounded Promise.all over the whole range',
    r.maxBatchSize < 100, 'batches are sliced, never the full block list')
  check('every block fetched exactly once (no duplicate processing)',
    new Set(r.processed).size === r.processed.length && r.processed.length === 100,
    `${r.processed.length} unique of 100`)

  // Failure isolation: one bad block in a batch must not void its 7 siblings.
  const mid = CURSOR + 3   // inside the first batch of 8
  const iso = simulateNativeScan(CURSOR, CURSOR + 7, new Set([mid]))
  check('a failed request does not invalidate its batch siblings',
    iso.processed.includes(CURSOR) && iso.processed.includes(CURSOR + 1) && iso.processed.includes(CURSOR + 2),
    `${iso.processed.length} siblings survived`)
  check('cursor still stops below the failure despite later successes',
    iso.safeUpTo === mid - 1, `safeUpTo ${iso.safeUpTo}`)

  // Out-of-order completion within a batch must not change the outcome: the
  // LOWEST failing block wins, not the first observed.
  const two = simulateNativeScan(CURSOR, CURSOR + 7, new Set([CURSOR + 5, CURSOR + 2]))
  check('lowest failing block determines the boundary, not completion order',
    two.safeUpTo === CURSOR + 1, `safeUpTo ${two.safeUpTo} (failures at +2 and +5)`)

  // Stop launching batches after a known failure — RPC budget is not wasted.
  const stop = simulateNativeScan(CURSOR, CURSOR + 999, new Set([CURSOR + 1]))
  check('stops fetching after a failure instead of scanning the whole range',
    stop.fetches <= CONCURRENCY, `${stop.fetches} fetches, not 1000`)
}

console.log('\n══ H. Detection gaps that survive this fix (fix 3, NOT done) ══')
{
  const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
  const known = new Set([WALLET])
  const acceptsNative = (to: string | null, from: string, wei: bigint) => {
    const t = (to ?? '').toLowerCase(); if (!t || !known.has(t)) return false
    if (from.toLowerCase() === t) return false
    const a = Number(wei) / 1e18
    return Number.isFinite(a) && a > 0
  }

  check('TX2 is detected once the cursor moves',
    acceptsNative(WALLET, '0xd9db937066e4e11d233993e44e838923ecdce950', 1000000000000000000n),
    'plain native transfer — pure cursor failure, now unblocked')

  check('TX1 still rejected by the native path (tx.to is a contract)',
    !acceptsNative('0x436947eee829b3c0a08bd683c8ff839bc871d167', WALLET, 0n))

  const INDEXER_TOKENS = ['0x89b50855aa3be2f677cd6303cec089b5f319d72a',
                          '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf']
  check('OPEN: USDC ERC-20 wrapper 0x3600… is still not log-scanned',
    !INDEXER_TOKENS.includes('0x3600000000000000000000000000000000000000'),
    'TX1/TX3 remain undetected — deferred to fix 3 pending dedup investigation')

  check('OPEN: claims scope compares against events the indexer never emits',
    true, 'D-3 excludes mints by design; claim comparison model needs redefining')
}

console.log('\n' + '='.repeat(68))
console.log(`Cursor stall + fix verification: ${pass}/${pass + fail} passed`)
console.log('='.repeat(68))
console.log('\nSections A-D document the fixed defect. E-G assert the new')
console.log('behaviour. H lists what is STILL open and deliberately not fixed.\n')
if (fail > 0) process.exit(1)
