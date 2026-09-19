/**
 * blockchain/cursorMath.ts — pure block-cursor + confirmation logic
 *
 * Phase 3. The math behind durable cursors and reorg safety, kept as pure
 * functions with no I/O so it can be unit-tested without a network or
 * database — the same reasoning as cursorMath.test.ts existing at all.
 *
 * TESTNET ONLY, but the logic is chain-agnostic (it only reasons about
 * block numbers and hashes, which work identically on every EVM chain).
 */

/** What a scan pass decided, in terms a caller can act on. */
export interface ScanWindow {
  /** First block this pass should scan. */
  fromBlock: number
  /** Last block this pass should scan (inclusive). */
  toBlock: number
  /** Chain head as observed this pass. */
  head: number
}

/**
 * The safe frontier: the highest block that has crossed confirmation depth.
 * Only blocks at or below this are treated as final. Everything above it is
 * tentative — the indexer may publish 'pending' events for it but must never
 * treat them as confirmed, and must be prepared to retract them on a reorg.
 */
export function safeFrontier(head: number, confirmationDepth: number): number {
  return Math.max(0, head - confirmationDepth)
}

/**
 * Compute the scan window for one pass.
 *
 * Rules (each one exists because a real failure mode motivated it):
 *  1. fromBlock starts at the last successfully indexed block. Scanning that
 *     block again is deliberate and harmless: the event insert is idempotent
 *     (partial unique index in the migration), so re-processing a block the
 *     previous pass just finished cannot double-publish. It also self-heals a
 *     cursor that advanced past a block whose events were never written.
 *  2. maxBlocks caps one pass so a very stale cursor (long downtime) cannot
 *     make a single invocation run unboundedly long — it catches up over
 *     several passes. Same intent as deposit-scan-all's per-pass caps.
 *  3. toBlock never exceeds head. Never scan into the future.
 */
export function computeScanWindow(
  lastIndexedBlock: number,
  head: number,
  maxBlocks: number,
): ScanWindow {
  const from = Math.max(0, lastIndexedBlock)
  const to = Math.min(head, from + Math.max(0, maxBlocks))
  return { fromBlock: from, toBlock: to, head }
}

/**
 * Whether a reorg has occurred, given the last block we indexed and the hash
 * we recorded for it.
 *
 * A reorg is detected by the parent-hash chain, not by comparing block hashes
 * directly: we fetch the block AT our cursor height and check that its parent
 * hash matches the hash we recorded for the block BELOW it. If it does not,
 * the chain has diverged below us and the cursor must roll back.
 */
export function detectReorg(lastIndexedHash: string | null, parentHashOfCurrent: string | null): boolean {
  if (!lastIndexedHash || !parentHashOfCurrent) return false
  return lastIndexedHash.toLowerCase() !== parentHashOfCurrent.toLowerCase()
}

/**
 * How far back to roll the cursor after a reorg is detected.
 *
 * confirmationDepth is the buffer: the reorg we detected may be deeper than
 * the single block we happened to notice. Rolling back a full depth past the
 * safe frontier guarantees we re-scan everything that might have changed,
 * even if the reorg is deeper than the one block that tipped us off. The
 * extra `+ 1` is because the block we detected the mismatch at is itself
 * suspect.
 */
export function reorgRollbackBlock(currentCursor: number, confirmationDepth: number): number {
  return Math.max(0, currentCursor - confirmationDepth - 1)
}

/**
 * Split a block range into chunks, for RPCs that cap eth_getLogs range.
 * Mirrors deposit-scan-all's LOG_CHUNK_SIZE loop.
 */
export function chunkRange(from: number, to: number, chunkSize: number): Array<[number, number]> {
  if (to < from || chunkSize <= 0) return []
  const chunks: Array<[number, number]> = []
  for (let f = from; f <= to; f += chunkSize) {
    chunks.push([f, Math.min(f + chunkSize - 1, to)])
  }
  return chunks
}

/**
 * How far the cursor may safely advance when some chunks of a pass failed.
 *
 * This is the single most important correctness rule in the whole indexer, and
 * it is copied deliberately from deposit-scan-all's `safeUpTo` behaviour
 * rather than reinvented. If chunks [100-199] and [300-399] succeed but
 * [200-299] fails on every endpoint, the cursor MUST stop at 199 — advancing
 * to 399 because "most of it worked" would silently skip blocks 200-299
 * forever, and no later pass would ever revisit them. A missed deposit that
 * nothing retries is exactly the class of bug that erodes trust in a payments
 * app, and it is invisible in logs because nothing errored at the end.
 *
 * Returns the highest contiguous block reached from `from`, so a transient
 * failure costs latency (the next pass retries from there) and never data.
 */
export function safeAdvance(
  from: number,
  results: Array<{ chunk: [number, number]; ok: boolean }>,
): number {
  const sorted = [...results].sort((a, b) => a.chunk[0] - b.chunk[0])
  let safe = Math.max(0, from - 1)
  for (const { chunk, ok } of sorted) {
    if (!ok) break          // stop at the FIRST gap, not the last success
    safe = chunk[1]
  }
  return safe
}

/**
 * Partition a set of indexed blocks into those at or below the safe frontier
 * (eligible to be marked 'confirmed') and those above it (stay 'pending').
 */
export function partitionByDepth(
  blocks: number[],
  head: number,
  confirmationDepth: number,
): { confirmed: number[]; pending: number[] } {
  const frontier = safeFrontier(head, confirmationDepth)
  return {
    confirmed: blocks.filter(b => b <= frontier),
    pending:   blocks.filter(b => b > frontier),
  }
}
