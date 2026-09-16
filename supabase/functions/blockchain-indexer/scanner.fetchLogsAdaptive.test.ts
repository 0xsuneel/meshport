// supabase/functions/blockchain-indexer/scanner.fetchLogsAdaptive.test.ts
import { fetchLogsAdaptive, MIN_LOG_CHUNK_SIZE } from './scanner.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

// ── 1. Normal contiguous progress ───────────────────────────────────────
Deno.test('1. a fully healthy range succeeds in exactly one call, one ok segment covering the whole range', async () => {
  let calls = 0
  const result = await fetchLogsAdaptive(
    (f, t) => { calls++; return Promise.resolve([{ from: f, to: t }]) },
    1000, 3999, 100,
  )
  assertEquals(calls, 1, 'a healthy range must not be bisected at all')
  assertEquals(result.segments, [{ chunk: [1000, 3999], ok: true }])
  assertEquals(result.logs.length, 1)
})

// ── 5. Empty blocks ──────────────────────────────────────────────────────
Deno.test('5. an empty-logs range is still a successful, contiguous segment', async () => {
  const result = await fetchLogsAdaptive(() => Promise.resolve([]), 1000, 1999, 100)
  assertEquals(result.segments, [{ chunk: [1000, 1999], ok: true }])
  assertEquals(result.logs, [])
})

// ── 4/6. Heavy/high-throughput range: too-large-to-fetch-at-once, must shrink ──
Deno.test('4. a range that fails as a whole but succeeds once bisected recovers full log coverage (simulates an RPC result-size cap)', async () => {
  const SIZE_LIMIT = 500 // simulate a provider that only tolerates <=500-block spans
  const seenRanges: Array<[number, number]> = []
  const result = await fetchLogsAdaptive(
    (f, t) => {
      seenRanges.push([f, t])
      if (t - f + 1 > SIZE_LIMIT) return Promise.reject(new Error('query returned more than 10000 results'))
      return Promise.resolve([{ block: f }])
    },
    1000, 2999, 100, // 2000-block span, must shrink below 500 to succeed
  )
  // Every segment must be a genuine sub-range that was actually queried and
  // succeeded -- never a block range wider than what SIZE_LIMIT allows.
  for (const seg of result.segments) {
    const span = seg.chunk[1] - seg.chunk[0] + 1
    if (seg.ok) { if (span > SIZE_LIMIT) throw new Error(`ok segment ${JSON.stringify(seg)} exceeds the simulated size limit`) }
  }
  assertEquals(result.segments.every(s => s.ok), true, 'every leaf sub-range eventually succeeds once small enough')
  // Total coverage must exactly reconstruct the original range with no gaps and no overlap.
  const covered = result.segments.map(s => s.chunk).sort((a, b) => a[0] - b[0])
  let cursor = 1000
  for (const [from, to] of covered) { assertEquals(from, cursor, 'segments must be contiguous, no skipped blocks'); cursor = to + 1 }
  assertEquals(cursor, 3000, 'segments must exactly cover the full requested range')
})

// ── 7. No-progress detection: a persistent fault never fabricates success ──
Deno.test('7. a persistent, un-shrinkable failure is reported as ok:false down to the minimum chunk size -- never silently treated as success', async () => {
  const result = await fetchLogsAdaptive(() => Promise.reject(new Error('persistent RPC fault')), 1000, 1199, MIN_LOG_CHUNK_SIZE)
  assertEquals(result.logs, [])
  assertEquals(result.segments.every(s => !s.ok), true)
  // Bisection must have actually been attempted down to the floor, not given
  // up early at the original (larger) span.
  const spans = result.segments.map(s => s.chunk[1] - s.chunk[0] + 1)
  assertEquals(spans.every(s => s <= MIN_LOG_CHUNK_SIZE), true)
})

// ── 6. Partial pass: one region genuinely broken, rest recovers ──────────
Deno.test('6. one genuinely-broken minimal sub-range is isolated as ok:false while the rest of a wide range still succeeds', async () => {
  const BROKEN_BLOCK = 1500
  const result = await fetchLogsAdaptive(
    (f, t) => (f <= BROKEN_BLOCK && BROKEN_BLOCK <= t) ? Promise.reject(new Error('bad block')) : Promise.resolve([{ f, t }]),
    1000, 1999, 50,
  )
  const failing = result.segments.filter(s => !s.ok)
  const succeeding = result.segments.filter(s => s.ok)
  assertEquals(failing.length > 0, true, 'the broken sub-range must be reported, not silently dropped')
  assertEquals(succeeding.length > 0, true, 'healthy sub-ranges must still succeed independently')
  for (const seg of failing) {
    if (!(seg.chunk[0] <= BROKEN_BLOCK && BROKEN_BLOCK <= seg.chunk[1])) throw new Error('a failing segment must actually contain the broken block')
  }
})

// ── 8. Recovery after no-progress: a stateful fault that later clears ────
Deno.test('8. once the underlying fault clears, a later independent call for the same kind of range succeeds normally (recovery is just "call it again", no special-cased state)', async () => {
  let shouldFail = true
  const failingAttempt = await fetchLogsAdaptive(() => shouldFail ? Promise.reject(new Error('down')) : Promise.resolve([]), 1000, 1099, 100)
  assertEquals(failingAttempt.segments, [{ chunk: [1000, 1099], ok: false }])

  shouldFail = false // simulates the RPC provider recovering before the next pass
  const recoveredAttempt = await fetchLogsAdaptive(() => shouldFail ? Promise.reject(new Error('down')) : Promise.resolve([{ ok: true }]), 1000, 1099, 100)
  assertEquals(recoveredAttempt.segments, [{ chunk: [1000, 1099], ok: true }])
  assertEquals(recoveredAttempt.logs.length, 1)
})

// ── 9. Cursor must never jump over unprocessed blocks ────────────────────
Deno.test('9. no ok:true segment is ever reported for a range that was not itself directly, successfully queried', async () => {
  const queriedAndSucceeded: Array<[number, number]> = []
  const result = await fetchLogsAdaptive(
    (f, t) => {
      if (t - f + 1 > 300) return Promise.reject(new Error('too big'))
      queriedAndSucceeded.push([f, t])
      return Promise.resolve([])
    },
    1000, 1999, 100,
  )
  for (const seg of result.segments) {
    if (seg.ok) {
      const matched = queriedAndSucceeded.some(([f, t]) => f === seg.chunk[0] && t === seg.chunk[1])
      if (!matched) throw new Error(`segment ${JSON.stringify(seg)} claims success but was never actually queried successfully`)
    }
  }
})

Deno.test('non-array fetchLogs result is normalized to an empty array, never fabricated content', async () => {
  const result = await fetchLogsAdaptive(() => Promise.resolve(undefined as unknown as unknown[]), 1000, 1099, 100)
  assertEquals(result.logs, [])
  assertEquals(result.segments, [{ chunk: [1000, 1099], ok: true }])
})
