// indexer-fast's in-memory cursors: the database is read once and written at
// most every 30 s per chain (plus at the end), never backwards - except a
// reorg rollback, saved at once.
import { describe, it, expect } from 'vitest'
import { createCursorCache, type CursorDb } from '../../supabase/functions/blockchain-indexer/cursorCache'
import type { CursorRow } from '../../supabase/functions/blockchain-indexer/cursors'

function fakeDb(start: Partial<CursorRow> | null) {
  let row: CursorRow | null = start ? ({ chain_id: 'base-sepolia', ...start } as CursorRow) : null
  const log = { reads: 0, writes: [] as Array<{ block: number | undefined; notBackwards: boolean }> }
  const db: CursorDb = {
    async read() { log.reads++; return row ? { ...row } : null },
    async write(_id, r, notBackwards) {
      log.writes.push({ block: r.last_indexed_block, notBackwards })
      if (!row || !notBackwards || (r.last_indexed_block ?? 0) >= row.last_indexed_block) row = { ...(row ?? {}), ...r } as CursorRow
    },
  }
  return { db, log, row: () => row }
}

describe('cursor cache (indexer-fast)', () => {
  it('reads the database once, then answers from memory', async () => {
    const f = fakeDb({ last_indexed_block: 100 })
    const c = createCursorCache(f.db, { now: () => 0 })
    expect((await c.get('base-sepolia'))?.last_indexed_block).toBe(100)
    for (let i = 0; i < 14; i++) await c.get('base-sepolia')
    expect(f.log.reads).toBe(1)
  })

  it('a minute of 4 s passes writes twice (once mid-run, once at the end), not fifteen times', async () => {
    let t = 0
    const f = fakeDb({ last_indexed_block: 100 })
    const c = createCursorCache(f.db, { now: () => t })
    await c.get('base-sepolia')
    for (let i = 1; i <= 15; i++) {
      t = i * 4_000
      await c.set('base-sepolia', { last_indexed_block: 100 + i }, 'lazy')
    }
    expect(f.log.writes.length).toBe(1)          // at 32 s (the next would be due at 62 s)
    await c.flushAll()                             // end of run: the last position saved
    expect(f.log.writes.length).toBe(2)
    expect(f.row()?.last_indexed_block).toBe(115)
  })

  it('nothing new: no write at all until 30 s have passed', async () => {
    let t = 0
    const f = fakeDb({ last_indexed_block: 100 })
    const c = createCursorCache(f.db, { now: () => t })
    await c.get('base-sepolia')
    for (let i = 1; i <= 7; i++) { t = i * 4_000; await c.set('base-sepolia', { latest_observed_block: 100, sync_state: 'idle' }, 'lazy') }
    expect(f.log.writes.length).toBe(0)
  })

  it('never moves a cursor backwards (the minute pass got further), but a reorg rollback does', async () => {
    let t = 0
    const f = fakeDb({ last_indexed_block: 100 })
    const c = createCursorCache(f.db, { now: () => t })
    await c.get('base-sepolia')
    t = 31_000
    // Meanwhile the minute pass advanced the row to 150.
    await f.db.write('base-sepolia', { last_indexed_block: 150 }, false)
    await c.set('base-sepolia', { last_indexed_block: 120 }, 'lazy')
    expect(f.row()?.last_indexed_block).toBe(150)
    expect(f.log.writes.at(-1)?.notBackwards).toBe(true)
    await c.set('base-sepolia', { last_indexed_block: 90, sync_state: 'reorg' }, 'force')
    expect(f.row()?.last_indexed_block).toBe(90)
  })

  it('cold start and failures are saved at once', async () => {
    const f = fakeDb(null)
    const c = createCursorCache(f.db, { now: () => 0 })
    expect(await c.get('base-sepolia')).toBeNull()
    await c.set('base-sepolia', { last_indexed_block: 500, sync_state: 'idle' }, 'now')
    expect(f.row()?.last_indexed_block).toBe(500)
    await c.set('base-sepolia', { sync_state: 'error', consecutive_failures: 1 }, 'now')
    expect(f.row()?.sync_state).toBe('error')
    expect(f.log.writes.length).toBe(2)
  })
})
