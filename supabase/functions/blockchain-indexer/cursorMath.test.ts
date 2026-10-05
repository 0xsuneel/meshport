// supabase/functions/blockchain-indexer/cursorMath.test.ts
//
// Phase 3 tests for the pure cursor/reorg/confirmation-depth math. Run with:
//   deno test supabase/functions/blockchain-indexer/cursorMath.test.ts
//
// Deliberately zero external imports (no jsr:/npm: specifiers, not even
// jsr:@std/assert) — this sandbox's network policy blocks jsr.io, and more
// generally a shared test-helper module shouldn't need network access to
// assert on values it already has in memory. assertEquals below is a
// minimal deep-equal, sufficient for the plain numbers/arrays/objects these
// tests compare.
import {
  safeFrontier,
  computeScanWindow,
  detectReorg,
  reorgRollbackBlock,
  chunkRange,
  safeAdvance,
  partitionByDepth,
} from './cursorMath.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`${msg ? msg + ': ' : ''}assertEquals failed\n  actual:   ${a}\n  expected: ${e}`)
  }
}

Deno.test('safeFrontier: head minus depth, floored at 0', () => {
  assertEquals(safeFrontier(100, 12), 88)
  assertEquals(safeFrontier(5, 12), 0) // never negative
})

Deno.test('computeScanWindow: starts at lastIndexedBlock, caps at maxBlocks and head', () => {
  assertEquals(computeScanWindow(100, 200, 50), { fromBlock: 100, toBlock: 150, head: 200 })
  // Near head: toBlock never exceeds head even if maxBlocks would allow more.
  assertEquals(computeScanWindow(190, 200, 50), { fromBlock: 190, toBlock: 200, head: 200 })
})

Deno.test('detectReorg: true only when hashes genuinely differ', () => {
  assertEquals(detectReorg('0xabc', '0xabc'), false)
  assertEquals(detectReorg('0xABC', '0xabc'), false) // case-insensitive
  assertEquals(detectReorg('0xabc', '0xdef'), true)
  assertEquals(detectReorg(null, '0xdef'), false) // nothing recorded yet — not a reorg
  assertEquals(detectReorg('0xabc', null), false) // could not verify — not a reorg
})

Deno.test('reorgRollbackBlock: rolls back a full confirmation depth plus one', () => {
  assertEquals(reorgRollbackBlock(1000, 12), 987)
  assertEquals(reorgRollbackBlock(5, 12), 0) // never negative
})

Deno.test('chunkRange: splits into inclusive chunks of the given size', () => {
  assertEquals(chunkRange(100, 249, 50), [[100, 149], [150, 199], [200, 249]])
  assertEquals(chunkRange(100, 100, 50), [[100, 100]])
  assertEquals(chunkRange(200, 100, 50), []) // to < from
})

Deno.test('safeAdvance: THE critical rule — stop at the FIRST gap, not the last success', () => {
  // [100-199] ok, [200-299] FAILS, [300-399] ok (out of order in the array on
  // purpose, to prove the function sorts before deciding).
  const results = [
    { chunk: [300, 399] as [number, number], ok: true },
    { chunk: [100, 199] as [number, number], ok: true },
    { chunk: [200, 299] as [number, number], ok: false },
  ]
  // Must stop at 199 — NOT 399, even though "most of it" succeeded. Advancing
  // to 399 would silently and permanently skip blocks 200-299.
  assertEquals(safeAdvance(100, results), 199)
})

Deno.test('safeAdvance: all chunks ok advances to the very end', () => {
  const results = [
    { chunk: [100, 199] as [number, number], ok: true },
    { chunk: [200, 299] as [number, number], ok: true },
  ]
  assertEquals(safeAdvance(100, results), 299)
})

Deno.test('safeAdvance: first chunk fails — no progress at all, returns from - 1', () => {
  const results = [{ chunk: [100, 199] as [number, number], ok: false }]
  assertEquals(safeAdvance(100, results), 99)
})

Deno.test('partitionByDepth: splits blocks at the confirmation-depth frontier', () => {
  const result = partitionByDepth([90, 95, 99, 100, 101], 100, 5) // frontier = 95
  assertEquals(result.confirmed, [90, 95])
  assertEquals(result.pending, [99, 100, 101])
})
