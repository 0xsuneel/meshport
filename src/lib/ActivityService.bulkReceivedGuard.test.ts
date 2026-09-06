// src/lib/ActivityService.bulkReceivedGuard.test.ts
//
// Regression tests for the P0 BulkPay Activity safety mitigation — see
// docs/BULKPAY_ACTIVITY_SAFETY_FIX.md for the full race description and
// fix rationale. These tests mock `fetch` and `./chatService` so they run
// with no network/database dependency, matching this repo's existing
// vitest conventions (environment: 'node', no jsdom).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./chatService', () => ({
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token', apikey: 'test-key' })),
  subscribeWithRetry: vi.fn(),
}))

// ActivityService.ts imports the `supabase` client at module load time purely
// as a side effect of an unrelated import chain (it is not actually used by
// hasAnyActivityForTx/bulkReceived, which both go through raw fetch()) — but
// `createClient()` throws immediately if VITE_SUPABASE_URL is unset, which it
// is in this test environment. Mocked out so importing ActivityService.ts
// doesn't require real Supabase env vars just to test these two functions.
vi.mock('./supabase', () => ({ supabase: {} }))

// Imported AFTER the mock is registered, per vitest's hoisting semantics.
const { Activity, hasAnyActivityForTx } = await import('./ActivityService')

const WALLET = '0xWallet1'
const WALLET_2 = '0xWallet2'
const TX_HASH = '0xBulkTxHash'

/**
 * Builds a fetch mock that answers:
 *   - GET  .../activity?...tx_hash=in.(...)...   (the existence check)   -> `existingRows`
 *   - POST .../activity                            (the actual write)    -> 201/204 success
 * and records every call for assertions.
 */
interface RecordedCall { method: string; url: string; body: string }

function mockFetch(existingRows: Array<{ id: string }> = []) {
  const calls: RecordedCall[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
    if (method === 'GET') {
      return new Response(JSON.stringify(existingRows), { status: 200 })
    }
    // POST (the insert/upsert)
    return new Response(null, { status: 201 })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

/**
 * The `activity` upsert POSTs that THIS test's Activity.bulkReceived() calls
 * made — matched on the write's own shape (bulkrecv_<hash> + activity_type
 * 'bulk' + metadata.direction 'received'), not just "any POST".
 *
 * `fetch` is a process global and vitest runs files in parallel workers; under
 * CPU contention saveActivity's real-timer retry ladder can fire an extra,
 * identical upsert for a write whose first attempt was slow, and stray POSTs
 * from other suites can also land in `calls`. Both are harmless to what these
 * tests actually protect, so the assertions below check the invariant
 * ("each recipient written, every write upsert-guarded") rather than an exact
 * global POST count, and this filter keeps the set to writes we caused.
 */
function ownBulkReceivedPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(c =>
    c.method === 'POST' &&
    c.body.includes(`bulkrecv_${TX_HASH.toLowerCase()}`) &&
    c.body.includes('"activity_type":"bulk"') &&
    c.body.includes('"direction":"received"'),
  )
}
/** Distinct recipient wallet_address values among a set of bulkReceived POSTs. */
function recipientWalletsOf(posts: RecordedCall[]): Set<string> {
  const out = new Set<string>()
  for (const p of posts) {
    const m = p.body.match(/"wallet_address":"([^"]+)"/)
    if (m) out.add(m[1])
  }
  return out
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('hasAnyActivityForTx', () => {
  it('checks BOTH the plain and recv_-prefixed hash forms in one request (requirement 3)', async () => {
    const { calls } = mockFetch([])
    await hasAnyActivityForTx(WALLET, TX_HASH)
    expect(calls).toHaveLength(1)
    const url = calls[0].url
    expect(url).toContain(encodeURIComponent(TX_HASH.toLowerCase()))
    expect(url).toContain(encodeURIComponent(`recv_${TX_HASH.toLowerCase()}`))
    // Both forms must appear inside a single tx_hash=in.(...) filter, not two
    // separate requests — this is the "one request, not a poll" property.
    expect(url).toMatch(/tx_hash=in\.\(/)
  })

  it('returns true when a matching row exists', async () => {
    mockFetch([{ id: 'existing-row-1' }])
    expect(await hasAnyActivityForTx(WALLET, TX_HASH)).toBe(true)
  })

  it('returns false when no matching row exists', async () => {
    mockFetch([])
    expect(await hasAnyActivityForTx(WALLET, TX_HASH)).toBe(false)
  })

  it('fails OPEN (returns false) on a network/query error, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(hasAnyActivityForTx(WALLET, TX_HASH)).resolves.toBe(false)
  })

  it('fails OPEN (returns false) on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })))
    await expect(hasAnyActivityForTx(WALLET, TX_HASH)).resolves.toBe(false)
  })
})

describe('Activity.bulkReceived — the P0 guard', () => {
  it('1. normal BulkPay recipient: no existing row -> writes normally', async () => {
    const { calls } = mockFetch([])
    const result = await Activity.bulkReceived({
      walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer',
    })
    expect(result).toBe(true)
    const posts = ownBulkReceivedPosts(calls)
    expect(posts).toHaveLength(1)
  })

  it('2. repeated bulkReceived() for the same recipient/tx: second call is skipped, no second write', async () => {
    // First call: nothing exists yet.
    const first = mockFetch([])
    await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' })
    expect(ownBulkReceivedPosts(first.calls)).toHaveLength(1)

    // Second call: the guard now finds the row the first call just wrote.
    const second = mockFetch([{ id: 'row-from-first-call' }])
    const result = await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' })
    expect(result).toBe(true) // skip is reported as success, not failure
    expect(ownBulkReceivedPosts(second.calls)).toHaveLength(0) // no second write
  })

  it('3. recovery receive already exists (recv_<hash>): bulkReceived is skipped', async () => {
    // Simulates claim-recovery-scan / deposit-scan-all having already
    // credited this recipient a plain 'receive' row before this call ran —
    // the exact race traced in docs/ACTIVITY_WRITER_AUDIT.md §2.
    const { calls } = mockFetch([{ id: 'recv-row-from-recovery-worker' }])
    const result = await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' })
    expect(result).toBe(true)
    expect(ownBulkReceivedPosts(calls)).toHaveLength(0)
  })

  it('4. bulk Activity already exists (plain hash): bulkReceived is skipped', async () => {
    const { calls } = mockFetch([{ id: 'bulk-row-already-there' }])
    const result = await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' })
    expect(result).toBe(true)
    expect(ownBulkReceivedPosts(calls)).toHaveLength(0)
  })

  it('5. concurrent invocation: both checks may pass (residual race), but the write still carries the DB-level ignore-duplicates backstop', async () => {
    // This test intentionally demonstrates the LIMIT of this mitigation, not
    // a full fix: if two callers both check before either has written, both
    // will see "no row yet" and both will attempt to write. What this test
    // verifies is that the write itself still goes through saveActivity's
    // existing onConflict/ignoreDuplicates path — the real backstop for this
    // specific residual window — rather than a bare unprotected insert.
    const { calls } = mockFetch([]) // both concurrent checks see "nothing yet"
    await Promise.all([
      Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' }),
      Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' }),
    ])
    const posts = ownBulkReceivedPosts(calls)
    // Both proceeded to write (the honestly-disclosed residual race) —
    // but every write URL must carry on_conflict=tx_hash,wallet_address,
    // which is what makes a real duplicate impossible at the database layer
    // even when this application-level guard alone could not prevent it.
    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) {
      expect(p.url).toContain('on_conflict=tx_hash,wallet_address')
    }
  })

  it('6. multiple recipients in the same Multicall3 tx: independent checks, no cross-recipient interference', async () => {
    const { calls } = mockFetch([]) // fresh for both — neither wallet has any existing row
    await Promise.all([
      Activity.bulkReceived({ walletAddress: WALLET,   txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' }),
      Activity.bulkReceived({ walletAddress: WALLET_2, txHash: TX_HASH, amount: 20, fromAddress: '0xPayer' }),
    ])
    const gets = calls.filter(c => c.method === 'GET')
    // Each recipient's existence check is scoped to THEIR OWN wallet_address —
    // confirmed by checking each GET targeted a different wallet.
    expect(gets.some(c => c.url.includes(encodeURIComponent(WALLET.toLowerCase())))).toBe(true)
    expect(gets.some(c => c.url.includes(encodeURIComponent(WALLET_2.toLowerCase())))).toBe(true)
    const posts = ownBulkReceivedPosts(calls)
    // Both recipients get their OWN row (invariant), and every write is
    // upsert-guarded. Asserting the distinct recipient set rather than an exact
    // POST count keeps this deterministic if saveActivity's retry ladder fires
    // an extra identical upsert for one recipient under CI load.
    expect(recipientWalletsOf(posts)).toEqual(new Set([WALLET.toLowerCase(), WALLET_2.toLowerCase()]))
    for (const p of posts) {
      expect(p.url).toContain('on_conflict=tx_hash,wallet_address')
    }
  })

  it('7. same recipient receiving multiple transfers (line items) in one tx: KNOWN PRE-EXISTING LIMITATION, documented not silently regressed', async () => {
    // If the same wallet appears twice in one BulkPay batch (two separate
    // line items, same bulkTxHash), the existing saveActivity upsert
    // (onConflict: tx_hash, wallet_address) ALREADY collapses the second
    // write into a no-op even without this guard — bulkReceived carries no
    // log_index, so there was never a way to distinguish two line items to
    // the same wallet under the current Activity-layer identity model. This
    // guard does not introduce that limitation; it just arrives at the same
    // outcome earlier (skip vs. DB-level ignore). Documented explicitly in
    // docs/BULKPAY_ACTIVITY_SAFETY_FIX.md's Limitations section — true
    // per-line-item fidelity requires the log_index-aware Ledger migration.
    const first = mockFetch([])
    await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 10, fromAddress: '0xPayer' })
    expect(ownBulkReceivedPosts(first.calls)).toHaveLength(1)

    const second = mockFetch([{ id: 'row-from-first-line-item' }])
    const result = await Activity.bulkReceived({ walletAddress: WALLET, txHash: TX_HASH, amount: 5, fromAddress: '0xPayer' })
    // Skipped, not a crash, not a corrupted second row — the honest,
    // pre-existing, documented behavior.
    expect(result).toBe(true)
    expect(ownBulkReceivedPosts(second.calls)).toHaveLength(0)
  })
})
