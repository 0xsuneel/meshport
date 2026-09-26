/**
 * Phase 2.5 measurement — migrated read path vs the ACTUAL legacy entry points.
 *
 * Correctness notes for this harness (learned the hard way on the first pass):
 *
 *  - The legacy baseline must be balanceCache.getTokenBalance and
 *    scanAllChainBalances — the functions the pages really called. Comparing
 *    against raw arcService.getUSDCBalance would invent a reduction that never
 *    existed, because balanceCache ALREADY had dedup + a 4s TTL.
 *  - Neither legacy module exports a cache reset, so scenarios must be isolated
 *    the way each module's own key allows: externalChainBalances keys by
 *    address (use a fresh address per scenario), balanceCache keys by TOKEN
 *    ALONE (a fresh address does NOT bypass it — that is the wallet-switch bug
 *    — so the only way to cold-start it is to wait out its 4s TTL).
 *
 * Run: npx tsx scripts/measure-phase25.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'

let calls = 0
;(globalThis as any).fetch = async (_u: string, init?: any): Promise<any> => {
  calls++
  const body = init?.body ? JSON.parse(init.body) : {}
  await sleep(4)
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id ?? 1, result: '0xde0b6b3a7640000' }) }
}

const SETTINGS: any = {}
let addrSeq = 0
const freshAddr = () => '0x' + String(++addrSeq).padStart(40, '0')
const BALANCE_CACHE_TTL = 4_000

async function main() {
  const legacyExt = await import('../src/lib/externalChainBalances')
  const legacyArc = await import('../src/lib/balanceCache')
  const bm = await import('../src/blockchain/BlockchainManager')
  const { clearCache } = await import('../src/blockchain/cache')
  const { resetMetrics, snapshot } = await import('../src/blockchain/rpcMetrics')

  const rows: Array<[string, number, number, string]> = []
  const measure = async (fn: () => Promise<unknown>) => { calls = 0; await fn(); return calls }

  // ── 1. Three pages read the same Arc asset concurrently ───────────────────
  await sleep(BALANCE_CACHE_TTL + 200)
  const a1 = freshAddr()
  const legacy1 = await measure(() => Promise.all([
    legacyArc.getTokenBalance('USDC', a1),
    legacyArc.getTokenBalance('USDC', a1),
    legacyArc.getTokenBalance('USDC', a1),
  ]))
  clearCache(); resetMetrics()
  const new1 = await measure(() => Promise.all([
    bm.readArcBalance(a1, 'USDC'),
    bm.readArcBalance(a1, 'USDC'),
    bm.readArcBalance(a1, 'USDC'),
  ]))
  rows.push(['Arc USDC — 3 pages concurrent', legacy1, new1, 'both dedupe'])

  // ── 2. WALLET SWITCH mid-session (the legacy correctness bug) ─────────────
  await sleep(BALANCE_CACHE_TTL + 200)
  const wA = freshAddr(), wB = freshAddr()
  let legacyWrong = false, newWrong = false
  const legacy2 = await measure(async () => {
    await legacyArc.getTokenBalance('USDC', wA)
    const before = calls
    await legacyArc.getTokenBalance('USDC', wB)   // different wallet, same token
    legacyWrong = calls === before                // 0 new calls => served wA's value
  })
  clearCache(); resetMetrics()
  const new2 = await measure(async () => {
    await bm.readArcBalance(wA, 'USDC')
    const before = calls
    await bm.readArcBalance(wB, 'USDC')
    newWrong = calls === before
  })
  rows.push(['Arc USDC — wallet switch (A then B)', legacy2, new2,
             `legacy served stale: ${legacyWrong ? 'YES (bug)' : 'no'} | new: ${newWrong ? 'YES' : 'no'}`])

  // ── 3. Hub + Claim scan all chains concurrently ───────────────────────────
  const a3 = freshAddr()
  const legacy3 = await measure(() => Promise.all([
    legacyExt.scanAllChainBalances(a3, SETTINGS, true),
    legacyExt.scanAllChainBalances(a3, SETTINGS, true),
  ]))
  clearCache(); resetMetrics()
  const a3b = freshAddr()
  const new3 = await measure(() => Promise.all([
    bm.readExternalBalances(a3b, SETTINGS, true),
    bm.readExternalBalances(a3b, SETTINGS, true),
  ]))
  rows.push(['21-chain scan — Hub + Claim concurrent', legacy3, new3, 'both dedupe'])

  // ── 4. Home total + Hub + Claim, all three concurrent ─────────────────────
  const a4 = freshAddr()
  const legacy4 = await measure(() => Promise.all([
    legacyExt.scanTotalExternalBalance(a4, SETTINGS, true),
    legacyExt.scanAllChainBalances(a4, SETTINGS, true),
    legacyExt.scanAllChainBalances(a4, SETTINGS, true),
  ]))
  clearCache(); resetMetrics()
  const a4b = freshAddr()
  const new4 = await measure(() => Promise.all([
    bm.readExternalTotal(a4b, SETTINGS, true),
    bm.readExternalBalances(a4b, SETTINGS, true),
    bm.readExternalBalances(a4b, SETTINGS, true),
  ]))
  rows.push(['Home total + Hub + Claim concurrent', legacy4, new4, 'both dedupe'])

  // ── 5. Admin toggles a chain off (Finding 1) ──────────────────────────────
  const a5 = freshAddr()
  const NO_BASE: any = { base_claim_enabled: { enabled: false } }
  let legacyStale = false, newStale = false
  const legacy5 = await measure(async () => {
    const before = await legacyExt.scanAllChainBalances(a5, SETTINGS, true)
    const after  = await legacyExt.scanAllChainBalances(a5, NO_BASE, true)
    legacyStale = before.length === after.length   // same length => toggle ignored
  })
  clearCache(); resetMetrics()
  const a5b = freshAddr()
  const new5 = await measure(async () => {
    const before = await bm.readExternalBalances(a5b, SETTINGS, true)
    const after  = await bm.readExternalBalances(a5b, NO_BASE, true)
    newStale = before.chains.length === after.chains.length
  })
  rows.push(['Chain toggled off mid-session', legacy5, new5,
             `legacy ignored toggle: ${legacyStale ? 'YES (bug)' : 'no'} | new: ${newStale ? 'YES' : 'no'}`])

  // ── Report ────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log('\n' + '='.repeat(96))
  console.log('PHASE 2.5 — RPC CALLS vs ACTUAL LEGACY ENTRY POINTS')
  console.log('='.repeat(96))
  console.log(`${pad('Scenario', 40)}${pad('Legacy', 8)}${pad('New', 6)}Notes`)
  console.log('-'.repeat(96))
  for (const [name, l, n, note] of rows) {
    console.log(`${pad(name, 40)}${pad(String(l), 8)}${pad(String(n), 6)}${note}`)
  }
  console.log('='.repeat(96))
  const s = snapshot()
  console.log(`\nMetrics (last scenario): total=${s.total} cacheHits=${s.cacheHits} dedupeHits=${s.dedupeHits}`)
  console.log('\nHONEST READING: legacy already had dedup + a short TTL on BOTH of these')
  console.log('paths, so Phase 2.5 is at RPC PARITY for concurrent reads by design.')
  console.log('Its wins are correctness (rows 2 and 5), one unified cache instead of')
  console.log('two divergent ones, and observability. The large RPC reduction comes')
  console.log('from Phase 4 (polling removal) and retiring realtimeDeposits, not here.')
}

main().catch(e => { console.error(e); process.exit(1) })
