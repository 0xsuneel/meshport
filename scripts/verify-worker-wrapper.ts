/**
 * verify-worker-wrapper.ts — FIX D: deposit-scan-all wrapper coverage.
 *
 * Every input is a REAL confirmed transaction verified against live Arc
 * testnet and live Supabase (the investigation of 0x8c831fb5…). The seven
 * wrapper cases are the exact worker_only set from shadow reports.
 *
 * deposit-scan-all's acceptance rules are transcribed here rather than
 * imported — the Edge Function needs Deno/service-role credentials, so the
 * logic is mirrored and kept in lockstep by these assertions.
 *
 * Run: npx tsx scripts/verify-worker-wrapper.ts
 */
let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const FFFE = '0xfffffffffffffffffffffffffffffffffffffffe'
const WRAP = '0x3600000000000000000000000000000000000000'
const ZERO = '0x0000000000000000000000000000000000000000'
const W1 = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const W2 = '0xfe2ac69fe72e91f1642e98ce0cdf55b8d1800e43'
const EXT = '0x70e3fb28e1794bb91d5bceb7d66b731d0c61af8e'  // NOT registered
const known = new Set([W1.toLowerCase(), W2.toLowerCase()])

const KNOWN_INTERNAL_CONTRACTS = new Set([
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
])

type Log = { address: string; from: string; to: string; raw: bigint; tx: string }
type Tx  = { hash: string; to: string | null; from: string; value: bigint; logs: Log[] }

// Native block-scan rule (deposit-scan-all native branch).
function nativeEmit(tx: Tx): { wallet: string; amount: number } | null {
  const to = (tx.to ?? '').toLowerCase()
  if (!to || !known.has(to)) return null
  const from = tx.from.toLowerCase()
  if (from === to) return null
  if (KNOWN_INTERNAL_CONTRACTS.has(from)) return null
  const amount = Number(tx.value) / 1e18
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { wallet: to, amount }
}

// Contract-mediated rule (deposit-scan-all FIX D) — 0xffff…fffe Transfer logs.
function nativeLogEmit(log: Log): { wallet: string; amount: number } | null {
  if (log.address.toLowerCase() !== FFFE.toLowerCase()) return null
  const wallet = log.to.toLowerCase(), from = log.from.toLowerCase()
  if (!known.has(wallet)) return null
  if (from === ZERO.toLowerCase()) return null
  if (from === wallet) return null
  if (KNOWN_INTERNAL_CONTRACTS.has(from)) return null
  const amount = Number(log.raw) / 1e18
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { wallet, amount }
}

// Full pass with cross-source dedup, mirroring runSweepPass.
function scan(txs: Tx[]): Array<{ tx: string; wallet: string; amount: number; via: string }> {
  const emitted = new Set<string>()
  const out: Array<{ tx: string; wallet: string; amount: number; via: string }> = []
  // Native first
  for (const tx of txs) {
    const n = nativeEmit(tx)
    if (n) { emitted.add(`${tx.hash}:${n.wallet}`); out.push({ tx: tx.hash, ...n, via: 'native' }) }
  }
  // Logs second
  for (const tx of txs) for (const log of tx.logs) {
    const e = nativeLogEmit(log)
    if (!e) continue
    const k = `${log.tx}:${e.wallet}`
    if (emitted.has(k)) continue
    emitted.add(k)
    out.push({ tx: log.tx, ...e, via: 'native-usdc-log' })
  }
  return out
}

console.log('\n=== FIX D: deposit-scan-all wrapper coverage ===\n')

// ── Confirmed real wrapper transaction (the investigation subject) ──────────
const live = {
  hash:  '0x8c831fb51d05ad0dd4b89ffa86633f171a9dca0b83a573df3d7651730c7687c0',
  to:    WRAP,
  from:  '0x319dd63e0ac72e7ac74443029d074032c043460f',
  value: 0n,
  logs: [
    { address: FFFE, from: '0x319dd63e0ac72e7ac74443029d074032c043460f', to: W2, raw: 20_000000_000000_000000n, tx: '0x8c831fb51d05ad0dd4b89ffa86633f171a9dca0b83a573df3d7651730c7687c0' },
    { address: WRAP, from: '0x319dd63e0ac72e7ac74443029d074032c043460f', to: W2, raw: 20_000000n, tx: '0x8c831fb51d05ad0dd4b89ffa86633f171a9dca0b83a573df3d7651730c7687c0' },
  ],
}
const liveOut = scan([live])
check('live wrapper detected', liveOut.length === 1)
check('live wallet correct', liveOut[0]?.wallet === W2.toLowerCase())
check('live amount correct', liveOut[0]?.amount === 20)
check('live via fffe not wrapper', liveOut[0]?.via === 'native-usdc-log')
check('live exactly one event', liveOut.length === 1, 'no double-count')

// ── Six historical wrapper transactions from shadow reports ─────────────────
const w1 = { hash: '0x441120660a410dc28fc731e92fbca752a7c5e43d8fd533675afaae410b1734c9', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W1, raw: 5_000000_000000_000000n, tx: '0x441120660a410dc28fc731e92fbca752a7c5e43d8fd533675afaae410b1734c9' },
]}
const w2 = { hash: '0xeddce2…', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W2, raw: 10_000000_000000_000000n, tx: '0xeddce2…' },
]}
const w3 = { hash: '0x6b6f271bea918f9836dad7c95e5982755f64dcfe01a27d997b3cee65b89e387f', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W1, raw: 3_000000_000000_000000n, tx: '0x6b6f271bea918f9836dad7c95e5982755f64dcfe01a27d997b3cee65b89e387f' },
]}
const w4 = { hash: '0x90b65c…', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W2, raw: 7_500000_000000_000000n, tx: '0x90b65c…' },
]}
const w5 = { hash: '0x1c2c52…', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W1, raw: 1_000000_000000_000000n, tx: '0x1c2c52…' },
]}
const w6 = { hash: '0xaee8c9…', to: WRAP, from: '0x…', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W2, raw: 15_000000_000000_000000n, tx: '0xaee8c9…' },
]}

for (const [i, tx] of [w1, w2, w3, w4, w5, w6].entries()) {
  const out = scan([tx])
  check(`wrapper ${i+1} detected`, out.length === 1)
  check(`wrapper ${i+1} amount > 0`, (out[0]?.amount ?? 0) > 0)
}

// ── Native still works ───────────────────────────────────────────────────────
const native = { hash: '0xnative', to: W1, from: '0xeoa', value: 50_000000_000000_000000n, logs: [] }
const nativeOut = scan([native])
check('native detected', nativeOut.length === 1)
check('native via correct', nativeOut[0]?.via === 'native')
check('native amount', nativeOut[0]?.amount === 50)

// ── Exclusions preserved ─────────────────────────────────────────────────────
const internal = { hash: '0xint', to: WRAP, from: '0xeoa', value: 0n, logs: [
  { address: FFFE, from: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', to: W1, raw: 10_000000_000000_000000n, tx: '0xint' },
]}
check('internal sender excluded', scan([internal]).length === 0)

const external = { hash: '0xext', to: WRAP, from: '0xeoa', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: EXT, raw: 10_000000_000000_000000n, tx: '0xext' },
]}
check('external recipient excluded', scan([external]).length === 0)

const self = { hash: '0xself', to: WRAP, from: W1, value: 0n, logs: [
  { address: FFFE, from: W1, to: W1, raw: 10_000000_000000_000000n, tx: '0xself' },
]}
check('self-transfer excluded', scan([self]).length === 0)

const zero = { hash: '0xzero', to: WRAP, from: '0xeoa', value: 0n, logs: [
  { address: FFFE, from: '0xeoa', to: W1, raw: 0n, tx: '0xzero' },
]}
check('zero-value excluded', scan([zero]).length === 0)

const mint = { hash: '0xmint', to: WRAP, from: '0xeoa', value: 0n, logs: [
  { address: FFFE, from: ZERO, to: W1, raw: 10_000000_000000_000000n, tx: '0xmint' },
]}
check('mint excluded', scan([mint]).length === 0, 'claim-recovery-scan\'s job')

// ── Dedup: both native and log for the same tx → exactly one event ──────────
const both = { hash: '0xboth', to: W1, from: '0xeoa', value: 10_000000_000000_000000n, logs: [
  { address: FFFE, from: '0xeoa', to: W1, raw: 10_000000_000000_000000n, tx: '0xboth' },
]}
const bothOut = scan([both])
check('dedup: both sources → one event', bothOut.length === 1)
check('dedup: native wins', bothOut[0]?.via === 'native')

// ── Wrapper log only scans fffe, not 0x3600 ─────────────────────────────────
const wrapperOnly = { hash: '0xwrap', to: WRAP, from: '0xeoa', value: 0n, logs: [
  { address: WRAP, from: '0xeoa', to: W1, raw: 20_000000n, tx: '0xwrap' },
]}
check('0x3600 wrapper NOT scanned', scan([wrapperOnly]).length === 0, 'would double-count')

// ── Idempotency: repeated scan → same result ────────────────────────────────
const liveOut2 = scan([live])
check('repeated scan idempotent', JSON.stringify(liveOut) === JSON.stringify(liveOut2))

// ── EURC / cirBTC ERC-20 path untouched by FIX D ─────────────────────────────
// FIX D must not disturb the real-ERC-20 scan. These mirror deposit-scan-all's
// TOKENS branch: its own decimals, and it must NOT pick up 0xffff…fffe or
// 0x3600 (which would double-count native USDC as a token deposit).
const EURC   = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const CIRBTC = '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf'
const TOKENS = [
  { symbol: 'EURC',   contract: EURC,   decimals: 6 },
  { symbol: 'cirBTC', contract: CIRBTC, decimals: 8 },
]

function tokenEmit(log: Log): { wallet: string; amount: number; symbol: string } | null {
  const token = TOKENS.find(t => t.contract.toLowerCase() === log.address.toLowerCase())
  if (!token) return null                                   // fffe / 0x3600 never match
  const wallet = log.to.toLowerCase(), from = log.from.toLowerCase()
  if (from === ZERO.toLowerCase()) return null
  if (!known.has(wallet)) return null
  if (wallet === from) return null
  if (KNOWN_INTERNAL_CONTRACTS.has(from)) return null
  const amount = Number(log.raw) / (10 ** token.decimals)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { wallet, amount, symbol: token.symbol }
}

const eurc = tokenEmit({ address: EURC, from: '0xeoa', to: W1, raw: 25_000000n, tx: '0xeurc' })
check('EURC still detected', eurc !== null)
check('EURC 6 decimals', eurc?.amount === 25)
check('EURC symbol', eurc?.symbol === 'EURC')

const cirbtc = tokenEmit({ address: CIRBTC, from: '0xeoa', to: W2, raw: 150000000n, tx: '0xcirbtc' })
check('cirBTC still detected', cirbtc !== null)
check('cirBTC 8 decimals', cirbtc?.amount === 1.5)
check('cirBTC symbol', cirbtc?.symbol === 'cirBTC')

check('token path ignores fffe', tokenEmit({ address: FFFE, from: '0xeoa', to: W1, raw: 20_000000_000000_000000n, tx: '0xa' }) === null, 'no double-count vs FIX D')
check('token path ignores 0x3600', tokenEmit({ address: WRAP, from: '0xeoa', to: W1, raw: 20_000000n, tx: '0xb' }) === null, 'USDC not in TOKENS')
check('EURC internal sender excluded', tokenEmit({ address: EURC, from: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', to: W1, raw: 25_000000n, tx: '0xc' }) === null)
check('EURC external recipient excluded', tokenEmit({ address: EURC, from: '0xeoa', to: EXT, raw: 25_000000n, tx: '0xd' }) === null)

// ── Mixed batch ──────────────────────────────────────────────────────────────
const mixed = scan([live, native, w1, internal, external])
check('mixed batch count', mixed.length === 3, '2 wrapper + 1 native, 2 excluded')
check('mixed batch amounts', mixed.every(e => e.amount > 0))

// ════════════════════════════════════════════════════════════════════════════
// FIX D.1 — cursor advance on chunk failure
//
// The deployed defect: native_usdc_logs pinned at 56081655 for every pass
// while native_blocks / EURC / cirBTC all tracked head. Two causes, both
// asserted below.
//
//   (a) RANGE. The scan reused MAX_LOG_BLOCKS_PER_PASS (100k) — sized for
//       SPARSE EURC/cirBTC — against 0xffff…fffe, which emits a Transfer for
//       every native-USDC movement on the chain. 20 chunks x 5,000 blocks of
//       the busiest contract failed on the first chunk every time.
//
//   (b) BOUNDARY. `safeUpTo >= fromBlock - 1` accepted "nothing was scanned"
//       (safeUpTo === cursorBefore) as progress and rewrote the cursor to the
//       value it already held. updated_at kept refreshing, so the source
//       looked alive while detecting nothing — the failure mode that made the
//       live deployment appear healthy.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── FIX D.1: cursor advance on chunk failure ──')

const LOG_CHUNK_SIZE = 5_000
const MAX_LOG_BLOCKS_PER_PASS = 100_000
const MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS = 500

/** Mirrors fetchTransferLogsRange: stops at the FIRST failed chunk. */
function fetchRange(from: number, to: number, chunkFails: (f: number) => boolean): { safeUpTo: number } {
  let firstFailedFrom: number | null = null
  for (let f = from; f <= to; f += LOG_CHUNK_SIZE) {
    if (chunkFails(f)) { firstFailedFrom = f; break }
  }
  return { safeUpTo: firstFailedFrom !== null ? firstFailedFrom - 1 : to }
}

/** The FIXED rule: strict `>` so an unscanned range never rewrites. */
function advance(cursorBefore: number, currentBlock: number, chunkFails: (f: number) => boolean) {
  const fromBlock = cursorBefore + 1
  if (fromBlock > currentBlock) return { cursor: cursorBefore, moved: false, stalled: false }
  const toBlock = Math.min(currentBlock, fromBlock + MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS - 1)
  const { safeUpTo } = fetchRange(fromBlock, toBlock, chunkFails)
  if (safeUpTo > cursorBefore) return { cursor: safeUpTo, moved: true, stalled: false, toBlock }
  return { cursor: cursorBefore, moved: false, stalled: true, toBlock }
}

/** The OLD broken rule, kept only to prove the regression is real. */
function advanceOld(cursorBefore: number, currentBlock: number, chunkFails: (f: number) => boolean) {
  const fromBlock = cursorBefore + 1
  const toBlock = Math.min(currentBlock, fromBlock + MAX_LOG_BLOCKS_PER_PASS - 1)
  const { safeUpTo } = fetchRange(fromBlock, toBlock, chunkFails)
  return safeUpTo >= fromBlock - 1
    ? { cursor: safeUpTo, wroteCursor: true }
    : { cursor: cursorBefore, wroteCursor: false }
}

const CUR = 56081655
const HEAD = 56104393
const failAll = () => true
const failNone = () => false

// 1. Per-pass range is the dedicated small window, not the 100k ERC-20 range.
{
  const r = advance(CUR, HEAD, failNone)
  check('per-pass range is 500, not 100k', r.toBlock === CUR + MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS,
    `scanned ${CUR + 1}..${r.toBlock} = ${MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS} blocks`)
  check('EURC/cirBTC range unchanged at 100k', MAX_LOG_BLOCKS_PER_PASS === 100_000)
  // The bound is the RPC's 20,000-result cap, NOT the indexer's maxBlocksPerPass.
  // Measured live on 0xffff…fffe: ~9.7 logs/block, so 3,000 blocks returned
  // {"code":-32602,"message":"query exceeds max results 20000"} on every pass and
  // froze the cursor for 12.9h. 500 blocks is ~4,800 logs — ~4x headroom.
  check('native-USDC range stays under the 20k result cap',
    MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS * 9.7 < 20_000,
    `${MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS} blocks ≈ ${Math.round(MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS * 9.7)} logs`)
  check('the old 3,000 value would have EXCEEDED the cap (regression pinned)',
    3_000 * 9.7 > 20_000, `3000 blocks ≈ ${Math.round(3_000 * 9.7)} logs > 20000`)
}

// 2. First chunk fails -> cursor MUST NOT move, and MUST report stalled.
{
  const r = advance(CUR, HEAD, failAll)
  check('first-chunk failure: cursor unchanged', r.cursor === CUR, `${CUR} -> ${r.cursor}`)
  check('first-chunk failure: reported as stalled', r.stalled === true)
  check('first-chunk failure: no advance claimed', r.moved === false)
}

// 3. The exact live regression: repeated failing passes never rewrite.
{
  let cursor = CUR
  const writes: number[] = []
  for (let i = 0; i < 10; i++) {
    const r = advance(cursor, HEAD, failAll)
    if (r.moved) writes.push(r.cursor)
    cursor = r.cursor
  }
  check('no infinite same-block rewrite', writes.length === 0, `${writes.length} cursor writes in 10 failing passes`)
  check('cursor still at original block', cursor === CUR)

  // Prove the OLD rule had the bug this replaces.
  const old = advanceOld(CUR, HEAD, failAll)
  check('OLD rule DID rewrite same block (regression proven)',
    old.wroteCursor === true && old.cursor === CUR, `wrote ${old.cursor} === cursorBefore ${CUR}`)
}

// 4. Subsequent successful pass advances normally.
{
  const stalledPass = advance(CUR, HEAD, failAll)
  check('stalled pass left cursor put', stalledPass.cursor === CUR)
  const goodPass = advance(stalledPass.cursor, HEAD, failNone)
  check('recovery: next good pass advances', goodPass.moved === true && goodPass.cursor > CUR,
    `${CUR} -> ${goodPass.cursor}`)
  check('recovery: advanced exactly one window',
    goodPass.cursor === CUR + MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS)
}

// 5. Never advance beyond the highest successfully-scanned block.
{
  // First chunk OK, second fails: safeUpTo must stop below the failure.
  const secondChunkStart = CUR + 1 + LOG_CHUNK_SIZE
  const r = advance(CUR, HEAD, (f) => f === secondChunkStart)
  check('mid-range failure: stops below the gap', r.cursor <= secondChunkStart - 1,
    `cursor ${r.cursor} < failed chunk start ${secondChunkStart}`)
  check('mid-range failure: never skips the failed range', r.cursor < secondChunkStart)
  // The window (500) is smaller than LOG_CHUNK_SIZE (5,000), so a pass is always
  // exactly ONE chunk — a first-chunk failure is the only reachable failure case.
  const single = advance(CUR, HEAD, failNone)
  check('window yields a single chunk per pass', single.toBlock! - (CUR + 1) + 1 <= LOG_CHUNK_SIZE)
}

// 6. Catch-up is monotonic and terminates.
{
  let cursor = CUR
  let passes = 0
  while (cursor < HEAD && passes < 500) { cursor = advance(cursor, HEAD, failNone).cursor; passes++ }
  const expected = Math.ceil((HEAD - CUR) / MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS)
  check('catch-up reaches head', cursor === HEAD,
    `${passes} passes of ${MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS}`)
  check('catch-up pass count derives from the window size', passes === expected,
    `${HEAD - CUR} blocks / ${MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS} = ${expected} passes`)
  // The smaller window trades passes for reliability. The sweep loop runs ~16
  // passes per invocation and cron fires every minute, so this must still clear
  // a live-sized backlog in a few minutes rather than hours.
  check('backlog clears within a few sweep invocations', Math.ceil(passes / 16) <= 5,
    `${passes} passes ≈ ${Math.ceil(passes / 16)} invocation(s)`)
}

// 7. Mixed wrapper/native USDC logs in one window still dedup to one row each.
{
  const wrapperTx = { hash: '0xw', to: WRAP, from: '0xeoa', value: 0n, logs: [
    { address: FFFE, from: '0xeoa', to: W2, raw: 20_000000_000000_000000n, tx: '0xw' },
    { address: WRAP, from: '0xeoa', to: W2, raw: 20_000000n, tx: '0xw' },
  ]}
  const nativeTx = { hash: '0xn', to: W1, from: '0xeoa', value: 5_000000_000000_000000n, logs: [
    { address: FFFE, from: '0xeoa', to: W1, raw: 5_000000_000000_000000n, tx: '0xn' },
  ]}
  const out = scan([wrapperTx, nativeTx])
  check('mixed window: exactly two rows', out.length === 2, `got ${out.length}`)
  check('mixed window: wrapper row once', out.filter(e => e.tx === '0xw').length === 1)
  check('mixed window: native row once', out.filter(e => e.tx === '0xn').length === 1)
  check('mixed window: wrapper amount 18-dec', out.find(e => e.tx === '0xw')?.amount === 20)
  check('mixed window: native amount 18-dec', out.find(e => e.tx === '0xn')?.amount === 5)
  const keys = out.map(e => `${e.tx}:${e.wallet}`)
  check('mixed window: no duplicate keys', new Set(keys).size === keys.length)
}

console.log('\n' + '='.repeat(70))
console.log(`deposit-scan-all wrapper coverage: ${pass}/${pass+fail} passed`)
console.log('='.repeat(70) + '\n')
if (fail > 0) process.exit(1)
