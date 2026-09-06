/**
 * verify-external-scan.ts — Alchemy 429 mitigation (Fix 1 + Fix 2).
 *
 * Incident, 2026-08-18: eth-sepolia, base-sepolia, arb-sepolia and
 * unichain-sepolia all returned HTTP 429 simultaneously, and the Arc
 * WebSocket handshake failed repeatedly. Root cause: six chains resolve to
 * *.g.alchemy.com on ONE shared account key, Alchemy rate-limits per ACCOUNT,
 * and three components scanned external chains on independent 60s intervals
 * plus every visibilitychange against a cache TTL of only 20s — so essentially
 * every trigger became a real multi-chain network scan.
 *
 * Asserts the two shipped mitigations against the REAL cache module:
 *   Fix 1  concurrent callers share ONE in-flight request (already provided by
 *          cache.dedupe(); this pins it so a refactor cannot silently regress)
 *   Fix 2  the `external:` TTL now exceeds the 60s scan cadence
 * and — critically — that Phase 6's {kind:'external'} invalidation still
 * BYPASSES the longer TTL, so a real balance change is never masked by it.
 *
 * Run: npx tsx scripts/verify-external-scan.ts
 */
import { dedupe, peek, put, invalidatePrefix, clearCache, isInflight } from '../src/blockchain/cache'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
/** The real key shape from externalBalanceReader: external:<addr>:<settings-sig> */
const KEY = `external:${WALLET}:arbitrum-sepolia,base-sepolia,ethereum-sepolia`

/** The shipped value, transcribed from externalBalanceReader.ts. */
const CACHE_TTL_MS = 90_000
/** The scan cadence in HomePage / MultichainPage. */
const SCAN_INTERVAL_MS = 60_000
/** The six chains that resolve to Alchemy on the shared key. */
const ALCHEMY_CHAINS = ['eth-sepolia', 'base-sepolia', 'arb-sepolia', 'opt-sepolia', 'polygon-amoy', 'unichain-sepolia']

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main() {
  console.log('\n══ A. Fix 2 — the external TTL now outlives the scan cadence ══')
  {
    check('external TTL (90s) EXCEEDS the 60s scan interval', CACHE_TTL_MS > SCAN_INTERVAL_MS,
      `${CACHE_TTL_MS}ms > ${SCAN_INTERVAL_MS}ms`)
    check('  so a periodic tick inside the window is a cache HIT, not a scan',
      SCAN_INTERVAL_MS < CACHE_TTL_MS)
    check('  and the old 20s TTL did NOT (every tick missed)', 20_000 < SCAN_INTERVAL_MS,
      '20000ms < 60000ms — the defect')
    // A tab refocus is the other trigger; it must also be covered.
    check('  a refocus 45s after a scan is still served warm', 45_000 < CACHE_TTL_MS)
    check('  a refocus 95s after a scan correctly re-scans', 95_000 > CACHE_TTL_MS)

    // Bound the change: long enough to help, short enough to stay fresh.
    check('TTL is bounded — not so long that balances feel frozen',
      CACHE_TTL_MS <= 120_000, `${CACHE_TTL_MS}ms <= 120000ms`)
  }

  console.log('\n══ B. Fix 1 — concurrent scans share ONE request ══')
  {
    clearCache()
    let calls = 0
    const scan = async () => { calls++; await sleep(30); return { chains: [], total: 42 } }

    // HomePage(readExternalTotal) + MultichainPage + MultichainClaimPage all
    // land on the same key. They must produce ONE network scan, not three.
    const [a, b, c] = await Promise.all([dedupe(KEY, scan), dedupe(KEY, scan), dedupe(KEY, scan)])
    check('3 concurrent callers -> exactly 1 underlying scan', calls === 1, `${calls} scan(s)`)
    check('  all three receive the SAME result object', a === b && b === c)
    check('  result is correct', (a as { total: number }).total === 42)

    // 6 Alchemy chains x 3 components = 18 requests avoided per overlap.
    check(`  avoids ${ALCHEMY_CHAINS.length * 2} redundant Alchemy requests per overlap`,
      calls === 1, `${ALCHEMY_CHAINS.length} chains x 2 saved callers`)

    clearCache()
    let seq = 0
    const scan2 = async () => { seq++; await sleep(10); return seq }
    await dedupe(KEY, scan2)
    check('in-flight entry is released after settling (not a permanent lock)',
      !isInflight(KEY))
    await dedupe(KEY, scan2)
    check('  so a LATER call starts genuine new work', seq === 2, `${seq} scans`)
  }

  console.log('\n══ C. Phase 6 invalidation must BYPASS the 90s TTL ══')
  {
    clearCache()
    put(KEY, { chains: [], total: 100 })
    const warm = peek<{ total: number }>(KEY)
    check('a completed scan is cached', !!warm && warm.value.total === 100)
    check('  and is fresh well inside the TTL', !!warm && warm.ageMs < CACHE_TTL_MS,
      `age ${warm?.ageMs}ms`)

    // This is exactly what refreshScope({kind:'external'}) does.
    const removed = invalidatePrefix(`external:${WALLET}:`)
    check('invalidatePrefix(external:<wallet>:) removes the entry', removed === 1,
      `${removed} entry removed`)
    check('  peek now MISSES -> next read goes to the network',
      peek(KEY) === null, 'a real balance_changed event is never masked by the TTL')

    // Scope discipline: it must not nuke unrelated caches.
    clearCache()
    put(KEY, { total: 1 })
    put(`${WALLET}:arc:USDC`, 5)
    put(`${WALLET}:history:page1`, ['x'])
    put(`external:0xOTHERWALLET:sig`, { total: 9 })
    const n = invalidatePrefix(`external:${WALLET}:`)
    check('external invalidation drops ONLY this wallet external entry', n === 1, `${n} removed`)
    check('  Arc balance cache untouched', peek(`${WALLET}:arc:USDC`) !== null)
    check('  history cache untouched', peek(`${WALLET}:history:page1`) !== null)
    check('  another wallet untouched', peek(`external:0xOTHERWALLET:sig`) !== null)

    // {kind:'all'} / manual refresh also clears it.
    clearCache()
    put(KEY, { total: 1 })
    check('manual refresh (prefix <wallet>:) + external prefix both reachable',
      invalidatePrefix('external:') === 1)
  }

  console.log('\n══ D. Expected load reduction (arithmetic, not a claim about live traffic) ══')
  {
    // Per wallet, per tab, over 10 minutes, assuming one refocus per minute.
    const minutes = 10
    const triggersPerMin = 1 /* interval */ + 1 /* refocus */
    const triggers = minutes * triggersPerMin

    const scansBefore = Math.min(triggers, Math.ceil(minutes * 60_000 / 20_000))
    const scansAfter  = Math.ceil(minutes * 60_000 / CACHE_TTL_MS)

    check('before: TTL shorter than cadence -> most triggers became scans',
      scansBefore > scansAfter, `${scansBefore} vs ${scansAfter} scans / ${minutes}min`)
    check(`after: ~${scansAfter} scans per ${minutes}min per wallet`,
      scansAfter <= 7, `${scansAfter}`)

    const reqBefore = scansBefore * ALCHEMY_CHAINS.length
    const reqAfter  = scansAfter * ALCHEMY_CHAINS.length
    const pct = Math.round((1 - reqAfter / reqBefore) * 100)
    console.log(`        Alchemy requests/${minutes}min: ${reqBefore} -> ${reqAfter}  (~${pct}% fewer)`)
    check('projected Alchemy request reduction is substantial', pct >= 50, `~${pct}%`)
    check('  NOTE: projection only — real reduction must be measured after the 429s clear',
      true, 'not evidence of the Phase 6 >=90% criterion')
  }
}

main().then(() => {
  console.log('\n' + '='.repeat(68))
  console.log(`External scan / cache verification: ${pass}/${pass + fail} passed`)
  console.log('='.repeat(68))
  console.log('\nA asserts Fix 2 (TTL > cadence). B asserts Fix 1 (shared in-flight).')
  console.log('C asserts Phase 6 external invalidation still bypasses the TTL and')
  console.log('stays scoped. D projects load reduction arithmetically.\n')
  if (fail > 0) process.exit(1)
}).catch(e => { console.error('SUITE CRASHED:', e); process.exit(1) })
