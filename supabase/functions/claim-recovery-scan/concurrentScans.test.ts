// supabase/functions/claim-recovery-scan/concurrentScans.test.ts
//
// Run with: deno test supabase/functions/claim-recovery-scan/concurrentScans.test.ts
//
// claim-recovery-scan's own header describes itself as SELF-CONTAINED (no
// separate pure/impure module split like blockchain-indexer's files have),
// and its three scan branches (runUsdcClaimAndReceiveScan / runTokenScan /
// runNativeExplorerScan) are inline closures inside Deno.serve, not exported
// functions — so they cannot be imported and unit-tested directly the way
// e.g. trackedFeatureCorrelation.ts can be. Extracting them into standalone
// exports purely to make them testable would be a materially bigger, riskier
// refactor than the latency fix itself warrants (this fix intentionally
// touched wall-clock ORDERING only, not any of the three scans' internal
// logic — see index.ts's own "LATENCY FIX" comment).
//
// What IS directly, honestly testable without that refactor is the actual
// mechanism the fix relies on: that Promise.allSettled([a(), b(), c()]) with
// three independent async operations completes in roughly max(a, b, c) time,
// not sum(a, b, c) — which is precisely the property that turns "USDC scan
// time + token scan time + native scan time" (the pre-fix, sequential
// behavior) into "max(USDC scan time, token scan time, native scan time)"
// (the post-fix, concurrent behavior). This is a synthetic reproduction of
// the root cause and the fix's mechanism, not a mock of the real function.

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

Deno.test('root cause reproduction: sequential awaits of 3 independent scans take their SUM, not their max', async () => {
  // Mirrors the pre-fix shape: await scanA(); await scanB(); await scanC()
  // in sequence, unconditionally, regardless of which one actually mattered
  // for the deposit being looked for. Small delays (50/30/20ms) stand in for
  // the real scans' RPC-bound costs (measured against real production data:
  // the USDC scan's ~100-chunk, 20-sequential-batch eth_getLogs pass was the
  // dominant, unconditionally-paid cost) — the ratio matters here, not the
  // absolute magnitude.
  const start = performance.now()
  await delay(50) // stand-in for the USDC scan (RECOVERY_SCAN_WINDOW_BLOCKS = 500,000)
  await delay(30) // stand-in for the EURC/cirBTC token scan
  await delay(20) // stand-in for the native-USDC-via-explorer scan
  const elapsed = performance.now() - start

  // Sequential: expect close to the sum (100ms), comfortably more than the max (50ms).
  assert(elapsed >= 95, `expected sequential total to be close to the 100ms sum, got ${elapsed}ms`)
})

Deno.test('fix mechanism: Promise.allSettled runs the same 3 operations concurrently, taking their MAX, not their sum', async () => {
  const start = performance.now()
  await Promise.allSettled([delay(50), delay(30), delay(20)])
  const elapsed = performance.now() - start

  // Concurrent: expect close to the max (50ms), well under the sequential sum (100ms).
  assert(elapsed < 90, `expected concurrent total to be close to the 50ms max, not the 100ms sum — got ${elapsed}ms`)
  assert(elapsed >= 45, `expected concurrent total to be at least as long as the slowest branch (50ms) — got ${elapsed}ms`)
})

Deno.test('fix does not swallow all outcomes: Promise.allSettled still lets every branch finish even if one throws', async () => {
  const completed: string[] = []
  const failing = async () => { await delay(10); throw new Error('simulated USDC RPC outage') }
  const okA = async () => { await delay(5); completed.push('token-scan') }
  const okB = async () => { await delay(5); completed.push('native-scan') }

  // Mirrors the fix's actual pattern: each branch's own .catch() logs and
  // resolves, so allSettled always sees fulfilled results — this is what
  // makes "one scan failing no longer blocks the other two" true, matching
  // the fix's documented, intentional behavior change (previously a thrown
  // error from the USDC scan aborted the whole invocation before the other
  // two branches ever ran).
  await Promise.allSettled([
    failing().catch(() => { completed.push('usdc-scan-failed-but-caught') }),
    okA(),
    okB(),
  ])

  assert(completed.includes('token-scan'), 'token scan must still complete even though the USDC scan failed')
  assert(completed.includes('native-scan'), 'native scan must still complete even though the USDC scan failed')
  assert(completed.includes('usdc-scan-failed-but-caught'), 'the USDC scan failure must be caught, not thrown to the caller')
})
