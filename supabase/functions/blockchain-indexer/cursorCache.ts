// supabase/functions/blockchain-indexer/cursorCache.ts
//
// indexer-fast's chain cursors, kept in memory between its 4-second passes.
//
// WHY (14 Nov 2026): every pass of every external chain read its cursor row
// and wrote it back - even with no new block - about 6,400 reads and 6,200
// upserts an hour on chain_cursors, nearly half the project's database
// traffic. On the Nano instance that drained the disk IO budget (100% → 10%
// in four days) until Supabase throttled the disk and queries timed out.
//
// WHAT CHANGES: only the bookkeeping. Scanning still happens every 4 s and
// events still go to chain_events at once (insertEvents is untouched).
//   * get: the database is read once per chain per run, then the copy here.
//   * 'lazy' writes (nothing new / scanned forward): kept here, saved at most
//     every FLUSH_MS per chain, and on flushAll() when the run ends.
//   * 'now' writes (cold start, failure): saved at once, as before.
//   * 'force' writes (reorg rollback): saved at once, even though the block
//     goes backwards.
//   * A save never moves a cursor backwards otherwise: blockchain-indexer's
//     minute pass also advances these rows, and a stale copy here must not
//     undo it. Behind it, this run only re-reads blocks already done -
//     chain_events is unique per (tx, wallet, log), so a repeat inserts nothing.
//
// If a run dies between saves, the next one starts from the last saved block:
// at most FLUSH_MS of blocks are scanned again, nothing is missed.

import type { CursorRow } from './cursorRow.ts'

export type CursorWrite = 'lazy' | 'now' | 'force'

/** How the indexer reads and writes a chain's cursor (default: straight to the database). */
export interface CursorStore {
  get(chainId: string): Promise<CursorRow | null>
  set(chainId: string, patch: Partial<CursorRow>, how: CursorWrite): Promise<void>
}

/** The database side, injected so the cache is testable without Supabase. */
export interface CursorDb {
  read(chainId: string): Promise<CursorRow | null>
  /** Upsert. With notBackwards, an existing row whose last_indexed_block is ahead is left alone. */
  write(chainId: string, row: Partial<CursorRow>, notBackwards: boolean): Promise<void>
}

export const FLUSH_MS = 30_000

export interface CursorCache extends CursorStore {
  /** Save every chain with unsaved changes (end of run). */
  flushAll(): Promise<void>
  /** For tests / logs: database writes made so far. */
  readonly writes: number
}

export function createCursorCache(db: CursorDb, opts: { flushMs?: number; now?: () => number } = {}): CursorCache {
  const flushMs = opts.flushMs ?? FLUSH_MS
  const now = opts.now ?? (() => Date.now())
  const rows = new Map<string, CursorRow>()
  const savedAt = new Map<string, number>()
  const dirty = new Set<string>()
  let writes = 0

  const save = async (chainId: string, notBackwards: boolean) => {
    const row = rows.get(chainId)
    if (!row) return
    dirty.delete(chainId)
    savedAt.set(chainId, now())
    writes++
    await db.write(chainId, { ...row }, notBackwards)
  }

  return {
    get writes() { return writes },
    async get(chainId) {
      const have = rows.get(chainId)
      if (have) return { ...have }
      const row = await db.read(chainId)
      if (row) { rows.set(chainId, { ...row }); savedAt.set(chainId, now()) }
      return row ? { ...row } : null
    },
    async set(chainId, patch, how) {
      const base = rows.get(chainId) ?? ({ chain_id: chainId } as CursorRow)
      rows.set(chainId, { ...base, ...patch, chain_id: chainId })
      if (how === 'lazy') {
        dirty.add(chainId)
        if (now() - (savedAt.get(chainId) ?? 0) < flushMs) return
      }
      await save(chainId, how !== 'force')
    },
    async flushAll() {
      await Promise.all([...dirty].map(id => save(id, true)))
    },
  }
}
