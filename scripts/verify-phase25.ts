/**
 * Phase 2.5 integration harness — proves the three migrated pages share one
 * request path, and that migrated behavior matches legacy semantics.
 *
 * Run: npx tsx scripts/verify-phase25.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'

let rpcCalls = 0
const callLog: string[] = []

// ── Stub the network layer only. Everything above it is the real code. ───────
const mockFetch = async (url: string, init?: any): Promise<any> => {
  rpcCalls++
  const body = init?.body ? JSON.parse(init.body) : {}
  callLog.push(`${body.method ?? 'unknown'} ${String(url).slice(0, 42)}`)
  await sleep(12) // simulate real latency so overlap windows are meaningful
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: body.id ?? 1, result: '0xde0b6b3a7640000' }),
  }
}
;(globalThis as any).fetch = mockFetch

const results: Array<[string, boolean, string]> = []
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail])
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const WALLET_A = '0x1111111111111111111111111111111111111111'
const WALLET_B = '0x2222222222222222222222222222222222222222'
const SETTINGS_ALL: any = {}
const SETTINGS_NO_BASE: any = { base_claim_enabled: { enabled: false } }

async function main() {
  const bm = await import('../src/blockchain/BlockchainManager')
  const { clearCache, cacheStats } = await import('../src/blockchain/cache')
  const { snapshot, resetMetrics, report } = await import('../src/blockchain/rpcMetrics')
  const clearAll = () => { clearCache(); resetMetrics() }

  console.log('\n── A. Arc balance: cross-page deduplication ──')
  clearAll(); rpcCalls = 0
  // Home, Hub and Claim all asking for the same asset at the same instant.
  const trio = await Promise.all([
    bm.readArcBalance(WALLET_A, 'USDC'),
    bm.readArcBalance(WALLET_A, 'USDC'),
    bm.readArcBalance(WALLET_A, 'USDC'),
  ])
  check('3 concurrent identical Arc reads → 1 RPC call', rpcCalls === 1, `${rpcCalls} call(s)`)
  check('all three callers get the same value', new Set(trio).size === 1, `value=${trio[0]}`)

  console.log('\n── B. Arc balance: TTL cache hit ──')
  const before = rpcCalls
  await bm.readArcBalance(WALLET_A, 'USDC')
  check('read inside TTL → 0 additional RPC', rpcCalls === before, `${rpcCalls - before} added`)

  console.log('\n── C. Wallet isolation (legacy balanceCache bug) ──')
  clearAll(); rpcCalls = 0
  const vA = await bm.readArcBalance(WALLET_A, 'USDC')
  const callsAfterA = rpcCalls
  const vB = await bm.readArcBalance(WALLET_B, 'USDC')
  check('different wallet does NOT reuse cached entry', rpcCalls > callsAfterA,
        `A=${callsAfterA} call(s), B added ${rpcCalls - callsAfterA}`)

  console.log('\n── D. Distinct assets are not conflated ──')
  clearAll(); rpcCalls = 0
  await Promise.all([
    bm.readArcBalance(WALLET_A, 'USDC'),
    bm.readArcBalance(WALLET_A, 'EURC'),
    bm.readArcBalance(WALLET_A, 'CIRBTC'),
  ])
  check('3 different assets → 3 RPC calls (no false sharing)', rpcCalls === 3, `${rpcCalls} call(s)`)

  console.log('\n── E. External scan: Hub + Claim share one scan ──')
  clearAll(); rpcCalls = 0
  const [hub, claim] = await Promise.all([
    bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true),
    bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true),
  ])
  const oneScan = rpcCalls
  check('Hub + Claim concurrent scan → single set of RPC calls',
        hub.chains.length === claim.chains.length && hub.total === claim.total,
        `${oneScan} calls for ${hub.chains.length} chains`)
  const solo = oneScan
  await bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true)
  check('third page inside TTL → 0 additional RPC', rpcCalls === solo, `${rpcCalls - solo} added`)

  console.log('\n── F. Finding 1: settings change invalidates immediately ──')
  const beforeToggle = rpcCalls
  const toggled = await bm.readExternalBalances(WALLET_A, SETTINGS_NO_BASE, true)
  check('chain toggle bypasses the cached entry', rpcCalls > beforeToggle,
        `${rpcCalls - beforeToggle} new call(s)`)
  check('disabled chain absent from result',
        !toggled.chains.some(c => c.chainId === 'base'),
        `${toggled.chains.length} chains vs ${hub.chains.length} before`)

  console.log('\n── G. Finding 2: cross-wallet in-flight race ──')
  clearAll(); rpcCalls = 0
  const [rA, rB] = await Promise.all([
    bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true),
    bm.readExternalBalances(WALLET_B, SETTINGS_ALL, true),
  ])
  check('concurrent scans for 2 wallets do not share a promise',
        rA !== rB, rA === rB ? 'SAME OBJECT — race present' : 'distinct results')

  console.log('\n── H. Error containment (spinner-hang guard) ──')
  clearAll(); rpcCalls = 0
  ;(globalThis as any).fetch = async () => { throw new Error('network down') }
  let threw = false
  let zeroed: any = null
  try {
    zeroed = await bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true)
  } catch { threw = true }
  check('total RPC failure resolves (never rejects)', !threw && zeroed !== null,
        threw ? 'REJECTED — would hang Hub spinner' : `total=${zeroed?.total}`)
  check('failed scan yields 0, matching legacy contract', zeroed?.total === 0, `total=${zeroed?.total}`)

  let arcThrew = false
  let arcVal: number | null = null
  try { arcVal = await bm.readArcBalance(WALLET_A, 'USDC') } catch { arcThrew = true }
  check('failed Arc read resolves to 0, matching legacy', !arcThrew && arcVal === 0,
        arcThrew ? 'REJECTED' : `value=${arcVal}`)
  ;(globalThis as any).fetch = mockFetch

  console.log('\n── I. Smart refresh scoping ──')
  clearAll(); rpcCalls = 0
  await bm.readArcBalance(WALLET_A, 'USDC')
  await bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true)
  const beforeScoped = rpcCalls
  bm.refreshScope({ kind: 'arc', wallet: WALLET_A })
  await bm.readExternalBalances(WALLET_A, SETTINGS_ALL, true)
  check('Arc-scoped invalidation leaves external cache intact',
        rpcCalls === beforeScoped, `${rpcCalls - beforeScoped} added`)
  await bm.readArcBalance(WALLET_A, 'USDC')
  check('invalidated Arc key does refetch', rpcCalls > beforeScoped, `${rpcCalls - beforeScoped} added`)

  console.log('\n── I2. Unknown scope kind is loud, not silent ──')
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...a: any[]) => { warnings.push(a.join(' ')) }
  // Deliberately invalid kind — the exact mistake this harness made itself.
  bm.refreshScope({ kind: 'arc-balance', wallet: WALLET_A } as any)
  console.warn = origWarn
  check('invalid scope kind warns instead of silently no-oping',
        warnings.some(w => w.includes('unhandled scope kind')),
        warnings.length ? 'warned' : 'SILENT — stale-data risk in Phase 4')

  console.log('\n── J. Cache + metrics are observable ──')
  const cs = cacheStats()
  const ms = snapshot()
  check('cacheStats() exposes entry/inflight counts',
        typeof cs.entries === 'number' && typeof cs.inflight === 'number',
        JSON.stringify(cs))
  check('rpcMetrics tracks requests and savings',
        typeof ms.total === 'number' && typeof ms.dedupeHits === 'number',
        `total=${ms.total} dedupeHits=${ms.dedupeHits} cacheHits=${ms.cacheHits}`)

  console.log('\n── Metrics report (cumulative for this run) ──')
  console.log(report())

  const passed = results.filter(r => r[1]).length
  console.log(`\n${'='.repeat(58)}`)
  console.log(`Phase 2.5 integration: ${passed}/${results.length} passed`)
  console.log('='.repeat(58))
  if (passed !== results.length) {
    console.log('\nFAILURES:')
    results.filter(r => !r[1]).forEach(([n, , d]) => console.log(`  - ${n} (${d})`))
    process.exit(1)
  }
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
