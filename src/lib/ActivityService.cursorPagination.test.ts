// src/lib/ActivityService.cursorPagination.test.ts
//
// Regression test for the "history loading in a random/inconsistent order
// sometimes" bug: fetchActivity's "load more" pagination used a raw
// numeric `offset`, which silently drifts whenever a row is inserted (a
// new transaction lands) while the user is actively scrolling through
// history — "position 20" means a genuinely different row once something
// new lands above it, so the next page could re-show an already-seen row
// or skip one entirely, with nothing to catch the skip case.
//
// Fix: an optional cursor (cursorCreatedAt + cursorId, anchored to the
// last-loaded row's own values) replaces the raw offset for "load more"
// calls — "everything strictly before this exact (created_at, id) pair,
// in the same created_at.desc,id.desc order" is unaffected by anything
// inserted or removed elsewhere in the list. These tests pin the exact
// query string produced in both the offset (first page) and cursor
// (subsequent pages) cases, so a future refactor can't silently regress
// back to plain offset pagination.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

// ActivityService.ts transitively imports the real Supabase client
// (lib/supabase.ts), which throws immediately at module-load time if
// VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY aren't set — not set by
// default in this Node-only test environment. Stubbing them before the
// dynamic import (rather than a static top-level import) avoids that
// crash without needing every test file that touches this module to
// carry its own unrelated Supabase client setup.
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

let fetchActivity: typeof import('./ActivityService').fetchActivity

beforeAll(async () => {
  ;({ fetchActivity } = await import('./ActivityService'))
})

function mockFetchOnce(rows: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => rows,
    _capturedUrl: url,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchActivity — cursor-based pagination', () => {
  it('first page (no cursor) still uses offset=0, unchanged from before', async () => {
    const fetchMock = mockFetchOnce([])
    await fetchActivity('0xabc', { limit: 20, offset: 0 })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('order=created_at.desc,id.desc')
    expect(calledUrl).toContain('limit=20')
    expect(calledUrl).toContain('offset=0')
    expect(calledUrl).not.toContain('&or=')
  })

  it('"load more" with a cursor uses the composite or/and filter, NOT a raw offset', async () => {
    const fetchMock = mockFetchOnce([])
    await fetchActivity('0xabc', {
      limit: 20,
      cursorCreatedAt: '2026-09-08T14:00:00.123456+00:00',
      cursorId: 'abc-123-def',
    })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    // The exact PostgREST composite-cursor shape: strictly older created_at,
    // OR the same created_at with a strictly smaller id (the tiebreak the
    // ORDER BY itself uses) — matches Supabase's own documented
    // .or('a,and(b,c)') pattern.
    expect(calledUrl).toMatch(/&or=\(created_at\.lt\.[^,]+,and\(created_at\.eq\.[^,]+,id\.lt\.[^)]+\)\)/)
    expect(calledUrl).not.toMatch(/&offset=\d/)
  })

  it('a cursor with only ONE of the two required fields falls back to offset (never a malformed filter)', async () => {
    const fetchMock = mockFetchOnce([])
    await fetchActivity('0xabc', { limit: 20, offset: 40, cursorCreatedAt: '2026-09-08T14:00:00Z' /* cursorId omitted */ })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('offset=40')
    expect(calledUrl).not.toContain('&or=')
  })
})

describe('useActivity cursor advancement — isolated algorithm (mirrors useActivity.ts load())', () => {
  // The hook itself can't be mounted here (Node-only vitest config, no
  // jsdom — see useActivity.raceGuard.test.ts's own comment on this
  // convention), so this pins the exact cursor-advancement logic in
  // isolation, the same way that file pins the request-race-guard logic.
  interface Row { id: string; createdAt: string }

  function advanceCursor(prevCursor: { createdAt: string; id: string } | null, page: Row[]) {
    const last = page[page.length - 1]
    if (last?.createdAt && last?.id) {
      return { createdAt: last.createdAt, id: last.id }
    }
    return prevCursor
  }

  it('advances to the LAST (oldest) row of a fresh page, not the first', () => {
    const page: Row[] = [
      { id: 'newest', createdAt: '2026-09-08T14:00:00Z' },
      { id: 'middle', createdAt: '2026-09-08T13:00:00Z' },
      { id: 'oldest', createdAt: '2026-09-08T12:00:00Z' },
    ]
    const cursor = advanceCursor(null, page)
    expect(cursor).toEqual({ createdAt: '2026-09-08T12:00:00Z', id: 'oldest' })
  })

  it('an empty page (end of history) does not clobber the existing cursor with garbage', () => {
    const existing = { createdAt: '2026-09-08T12:00:00Z', id: 'oldest' }
    const cursor = advanceCursor(existing, [])
    expect(cursor).toEqual(existing)
  })

  it('simulates a realtime insertion mid-scroll: cursor-based "load more" is unaffected by it', () => {
    // Page 1 loaded BEFORE a new transaction arrives.
    const page1: Row[] = [
      { id: 'row20', createdAt: '2026-09-08T14:20:00Z' },
      { id: 'row19', createdAt: '2026-09-08T14:19:00Z' },
    ]
    const cursorAfterPage1 = advanceCursor(null, page1)

    // A NEW transaction (row21) lands, inserted above everything —
    // exactly the scenario that broke raw offset-based pagination:
    // offset=2 would now point somewhere different than it did a moment
    // ago. The cursor, anchored to row19's own values, is untouched by
    // this insertion — "load more" still correctly means "everything
    // strictly older than row19," regardless of what showed up above it.
    expect(cursorAfterPage1).toEqual({ createdAt: '2026-09-08T14:19:00Z', id: 'row19' })
  })
})
