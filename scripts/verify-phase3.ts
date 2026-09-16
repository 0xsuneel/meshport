/**
 * Phase 3 verification — pure cursor/reorg logic.
 *
 * No network, no database. These are the rules that fail SILENTLY in
 * production (a skipped block range logs nothing), so they are asserted here
 * rather than trusted.
 *
 * Run: npx tsx scripts/verify-phase3.ts
 */
import {
  safeFrontier, computeScanWindow, detectReorg, reorgRollbackBlock,
  chunkRange, safeAdvance, partitionByDepth,
} from '../supabase/functions/blockchain-indexer/cursorMath'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else    { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n── A. Safe frontier / confirmation depth ──')
check('frontier trails head by depth', safeFrontier(1000, 12) === 988, `${safeFrontier(1000, 12)}`)
check('frontier never negative on a young chain', safeFrontier(5, 12) === 0, `${safeFrontier(5, 12)}`)
check('depth 0 means head is final (Arc-style)', safeFrontier(1000, 0) === 1000)

console.log('\n── B. Scan window ──')
const w1 = computeScanWindow(100, 500, 3000)
check('normal pass scans cursor..head', w1.fromBlock === 100 && w1.toBlock === 500, `${w1.fromBlock}..${w1.toBlock}`)
const w2 = computeScanWindow(0, 1_000_000, 3000)
check('stale cursor is capped by maxBlocks', w2.toBlock === 3000, `toBlock=${w2.toBlock}`)
const w3 = computeScanWindow(500, 400, 3000)
check('never scans past head (cursor ahead of head)', w3.toBlock <= 400, `toBlock=${w3.toBlock}`)
const w4 = computeScanWindow(500, 500, 3000)
check('caught-up cursor re-scans its own tip (idempotent)', w4.fromBlock === 500 && w4.toBlock === 500)

console.log('\n── C. Reorg detection ──')
check('matching parent hash is not a reorg', detectReorg('0xAAA', '0xaaa') === false, 'case-insensitive')
check('mismatched parent hash IS a reorg', detectReorg('0xAAA', '0xbbb') === true)
check('first-ever pass (null hash) is not a reorg', detectReorg(null, '0xbbb') === false)
check('unavailable parent hash is not asserted as reorg', detectReorg('0xAAA', null) === false)

console.log('\n── D. Reorg rollback ──')
check('rolls back a full depth plus the suspect block', reorgRollbackBlock(1000, 12) === 987, `${reorgRollbackBlock(1000, 12)}`)
check('rollback clamps at genesis', reorgRollbackBlock(3, 12) === 0, `${reorgRollbackBlock(3, 12)}`)
check('rollback is strictly below the cursor', reorgRollbackBlock(1000, 0) < 1000, `${reorgRollbackBlock(1000, 0)}`)

console.log('\n── E. Chunking ──')
check('exact multiple chunks evenly', chunkRange(0, 9999, 5000).length === 2, `${chunkRange(0, 9999, 5000).length}`)
check('remainder gets its own chunk', chunkRange(0, 10000, 5000).length === 3)
check('single-block range yields one chunk', chunkRange(7, 7, 5000).length === 1)
check('inverted range yields nothing', chunkRange(10, 5, 5000).length === 0)
const cr = chunkRange(100, 250, 100)
check('chunks are contiguous and inclusive',
      cr[0][0] === 100 && cr[0][1] === 199 && cr[1][0] === 200 && cr[1][1] === 250,
      JSON.stringify(cr))

console.log('\n── F. safeAdvance — the silent-data-loss guard ──')
check('all chunks ok advances to the end',
      safeAdvance(100, [
        { chunk: [100, 199], ok: true },
        { chunk: [200, 299], ok: true },
      ]) === 299)
check('a GAP stops the cursor at the last contiguous success',
      safeAdvance(100, [
        { chunk: [100, 199], ok: true },
        { chunk: [200, 299], ok: false },
        { chunk: [300, 399], ok: true },   // succeeded, but must NOT count
      ]) === 199,
      'blocks 200-299 will be retried, not skipped')
check('first chunk failing advances nothing',
      safeAdvance(100, [{ chunk: [100, 199], ok: false }]) === 99,
      'stays below `from` so the range is fully retried')
check('out-of-order results are sorted before evaluation',
      safeAdvance(100, [
        { chunk: [300, 399], ok: true },
        { chunk: [100, 199], ok: true },
        { chunk: [200, 299], ok: false },
      ]) === 199,
      'order of completion must not change the outcome')

console.log('\n── G. Confirmation partitioning ──')
const p = partitionByDepth([980, 985, 990, 995, 1000], 1000, 12)
check('blocks at/below frontier are confirmable',
      p.confirmed.length === 2 && p.confirmed.every(b => b <= 988), JSON.stringify(p.confirmed))
check('blocks above frontier stay pending',
      p.pending.length === 3 && p.pending.every(b => b > 988), JSON.stringify(p.pending))
check('partition loses nothing', p.confirmed.length + p.pending.length === 5)

console.log('\n' + '='.repeat(58))
console.log(`Phase 3 cursor/reorg logic: ${pass}/${pass + fail} passed`)
console.log('='.repeat(58))
if (fail > 0) process.exit(1)
