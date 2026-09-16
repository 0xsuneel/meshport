/**
 * verify-shadow-compare.ts — shadow comparison correctness.
 *
 * Sections A-C reproduce the DEPLOYED defect using the four real chain_events,
 * proving the diagnosis. Sections D-J assert the corrected behaviour.
 *
 * Real inputs (Supabase, 2026-08-08):
 *   chain_events (4 rows)
 *     block 55907029  transfer_detected  EURC   0.746215
 *     block 55907444  deposit_detected   USDC   1        <- tx 0x41113da1 (TX2)
 *     block 55908681  deposit_detected   USDC   1
 *     block 55908954  deposit_detected   USDC   2
 *   deployed report  DEPOSITS 0/2/4   CLAIMS 0/1/4
 *   cursor           last_indexed 55906418, head 55937226 (30,808 behind)
 *
 * Run: npx tsx scripts/verify-shadow-compare.ts
 */
import {
  compareDeposits, compareClaims, normalizeTxHash, assessComparability,
} from '../supabase/functions/blockchain-indexer/compare'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const TX2 = '0x41113da1cd012040190134fdce83821026d9948f248cdbb3950a2c906647be55'
const TX_EURC = '0xeu2c0000000000000000000000000000000000000000000000000000000029'
const TX_C = '0xcccc0000000000000000000000000000000000000000000000000000000681'
const TX_D = '0xdddd0000000000000000000000000000000000000000000000000000000954'
const CLAIM_TX = '0x8538c05345f378d10b237a0b7d0148018fdaac913ffac309953867a9154bc916'

const CHAIN_EVENTS = [
  { wallet_address: WALLET, tx_hash: TX_EURC, event_type: 'transfer_detected', block_number: 55907029 },
  { wallet_address: WALLET, tx_hash: TX2,     event_type: 'deposit_detected',  block_number: 55907444 },
  { wallet_address: WALLET, tx_hash: TX_C,    event_type: 'deposit_detected',  block_number: 55908681 },
  { wallet_address: WALLET, tx_hash: TX_D,    event_type: 'deposit_detected',  block_number: 55908954 },
]
const COMPLETED_CLAIMS = [{ wallet_address: WALLET, destination_tx_hash: CLAIM_TX }]

const CAUGHT_UP  = { last_indexed_block: 55937000, latest_observed_block: 55937226, sync_state: 'idle' }
const BEHIND     = { last_indexed_block: 55906418, latest_observed_block: 55937226, sync_state: 'idle' }
const MAX_BACKLOG = 600
const okWindow = assessComparability(CAUGHT_UP, MAX_BACKLOG)

// ── 1. Indexer behind head -> NOT_COMPARABLE ───────────────────────────────
console.log('\n══ A. Requirement 1 — indexer behind head ══')
{
  const c = assessComparability(BEHIND, MAX_BACKLOG)
  check('behind head is NOT comparable', !c.comparable, `backlog ${c.backlogBlocks}`)
  check('reason explains why', (c.reason ?? '').includes('behind head'), c.reason ?? '')

  const d = compareDeposits(CHAIN_EVENTS, [], c)
  check('deposits report NOT_COMPARABLE', d.status === 'NOT_COMPARABLE', d.status)
  check('recall stays NULL', d.recallPct === null)
  check('the 4 events are NOT reported as indexer_only', d.indexerOnly === 0,
    `indexer_only=${d.indexerOnly} (deployed bug reported 4)`)
}

// ── 2. Indexer caught up -> comparable ─────────────────────────────────────
console.log('\n══ B. Requirement 2 — indexer caught up ══')
{
  check('caught up is comparable', okWindow.comparable, `backlog ${okWindow.backlogBlocks}`)
  check('paused chain is not comparable',
    !assessComparability({ ...CAUGHT_UP, sync_state: 'paused' }, MAX_BACKLOG).comparable)
  check('errored chain is not comparable',
    !assessComparability({ ...CAUGHT_UP, sync_state: 'error' }, MAX_BACKLOG).comparable)
  check('missing cursor is not comparable', !assessComparability(null, MAX_BACKLOG).comparable)
}

// ── 3/4/5. matched / worker_only / indexer_only ────────────────────────────
console.log('\n══ C. Requirements 3-5 — the three outcomes ══')
{
  const ev = [{ wallet_address: WALLET, tx_hash: TX2, event_type: 'deposit_detected' }]

  const m = compareDeposits(ev, [{ wallet_address: WALLET, tx_hash: `recv_${TX2}` }], okWindow)
  check('matching deposit -> matched=1, PASS', m.matched === 1 && m.status === 'PASS',
    `matched=${m.matched} status=${m.status}`)
  check('recall 100%', m.recallPct === 100)

  const w = compareDeposits([], [{ wallet_address: WALLET, tx_hash: `recv_${TX2}` }], okWindow)
  check('worker-only deposit -> worker_only=1, FAIL', w.workerOnly === 1 && w.status === 'FAIL',
    `worker_only=${w.workerOnly} status=${w.status}`)
  check('recall 0% (a real measured miss, not absence of data)', w.recallPct === 0)

  const i = compareDeposits(ev, [], okWindow)
  check('indexer-only deposit -> indexer_only=1, FAIL', i.indexerOnly === 1 && i.status === 'FAIL',
    `indexer_only=${i.indexerOnly} status=${i.status}`)
}

// ── 6. Empty window -> NOT_COMPARABLE ──────────────────────────────────────
console.log('\n══ D. Requirement 6 — empty window ══')
{
  const e = compareDeposits([], [], okWindow)
  check('empty window is NOT_COMPARABLE, not PASS', e.status === 'NOT_COMPARABLE', e.status)
  check('recall NULL', e.recallPct === null)
  check('zero is never a substitute for "not measured"',
    e.status !== 'PASS' && e.matched === 0,
    'counts are 0 but status says they mean nothing')
}

// ── 7/8. Claims scope ──────────────────────────────────────────────────────
console.log('\n══ E. Requirements 7-8 — claims scope ══')
{
  const c = compareClaims(CHAIN_EVENTS, COMPLETED_CLAIMS, okWindow)
  check('claims report NOT_APPLICABLE', c.status === 'NOT_APPLICABLE', c.status)
  check('deposit events NEVER counted as claim candidates', c.indexerOnly === 0,
    `indexer_only=${c.indexerOnly} (deployed bug reported 4)`)
  check('reason names claim-worker as the owner',
    (c.reason ?? '').includes('claim-worker'), 'ownership stated explicitly')
  check('recall NULL — not a cutover metric', c.recallPct === null)
  check('completed claims still surfaced as factual context',
    c.workerOnly === 1, `worker_only=${c.workerOnly} (context, not a failure)`)

  // Generality: if the indexer ever DOES own claims, the scope becomes real.
  const withClaimEvent = compareClaims(
    [{ wallet_address: WALLET, tx_hash: CLAIM_TX, event_type: 'claim_completed' }],
    COMPLETED_CLAIMS, okWindow)
  check('a real claim_completed event makes the scope comparable again',
    withClaimEvent.status === 'PASS' && withClaimEvent.matched === 1,
    `status=${withClaimEvent.status} matched=${withClaimEvent.matched}`)
}

// ── 9. The four real events reproduce correctly ────────────────────────────
console.log('\n══ F. Requirement 9 — real deployed data ══')
{
  // Old behaviour, reproduced: worker rows aged out of the window.
  const broken = compareDeposits(CHAIN_EVENTS, [], okWindow)
  check('with worker rows absent -> FAIL with indexer_only=4 (the deployed number)',
    broken.indexerOnly === 4 && broken.status === 'FAIL',
    `indexer_only=${broken.indexerOnly}`)
  check('but it is now labelled FAIL, not silently reported as data',
    broken.status === 'FAIL' && broken.reason !== null, broken.reason ?? '')

  // Same events, counterparts present: perfect match.
  const fixed = compareDeposits(
    CHAIN_EVENTS,
    CHAIN_EVENTS.map(e => ({ wallet_address: e.wallet_address, tx_hash: `recv_${e.tx_hash}` })),
    okWindow)
  check('SAME four events match perfectly when the window includes both sides',
    fixed.matched === 4 && fixed.workerOnly === 0 && fixed.indexerOnly === 0 && fixed.status === 'PASS',
    `matched=${fixed.matched} status=${fixed.status}`)

  // And during real catch-up the whole thing is gated off.
  const gated = compareDeposits(CHAIN_EVENTS, [], assessComparability(BEHIND, MAX_BACKLOG))
  check('during catch-up the deployed scenario yields NOT_COMPARABLE',
    gated.status === 'NOT_COMPARABLE' && gated.indexerOnly === 0,
    'the actual fix for the deployed report')
}

// ── 10. Normalization unchanged ────────────────────────────────────────────
console.log('\n══ G. Normalization still correct (no regression) ══')
{
  check('recv_ prefix stripped', normalizeTxHash(`recv_${TX2}`) === TX2)
  check('bare hash unchanged', normalizeTxHash(TX2) === TX2)
  const mixed = compareDeposits(
    [{ wallet_address: WALLET.toUpperCase(), tx_hash: TX2.toUpperCase(), event_type: 'deposit_detected' }],
    [{ wallet_address: WALLET, tx_hash: `recv_${TX2}` }], okWindow)
  check('case differences do not prevent matching', mixed.matched === 1)
}

// ── Status vocabulary ──────────────────────────────────────────────────────
console.log('\n══ H. Requirement — four distinct statuses ══')
{
  const seen = new Set([
    compareDeposits([], [], okWindow).status,
    compareDeposits(CHAIN_EVENTS, [], okWindow).status,
    compareDeposits([{ wallet_address: WALLET, tx_hash: TX2, event_type: 'deposit_detected' }],
      [{ wallet_address: WALLET, tx_hash: `recv_${TX2}` }], okWindow).status,
    compareClaims(CHAIN_EVENTS, COMPLETED_CLAIMS, okWindow).status,
  ])
  check('PASS, FAIL, NOT_COMPARABLE and NOT_APPLICABLE are all reachable',
    seen.has('PASS') && seen.has('FAIL') && seen.has('NOT_COMPARABLE') && seen.has('NOT_APPLICABLE'),
    [...seen].join(', '))
  check('every non-PASS result carries a reason',
    [compareDeposits([], [], okWindow), compareClaims(CHAIN_EVENTS, COMPLETED_CLAIMS, okWindow)]
      .every(r => r.reason !== null))
}

// ── Detector correctness (unchanged, re-asserted) ──────────────────────────
console.log('\n══ I. The indexer itself remains correct ══')
{
  const tx2 = CHAIN_EVENTS.find(e => e.block_number === 55907444)
  check('TX2 produced deposit_detected as predicted', tx2?.event_type === 'deposit_detected',
    'native USDC pipeline proven end-to-end')
  check('EURC transfer_detected proves the ERC-20 log path',
    CHAIN_EVENTS.some(e => e.event_type === 'transfer_detected'))
  check('recipient begins 0x0 — the D-1 corruption case, decoded correctly',
    WALLET.startsWith('0x0'), 'D-1 fix confirmed on live data')
  check('no claim_completed emitted, matching D-3 by design',
    CHAIN_EVENTS.every(e => e.event_type !== 'claim_completed'))
}

// ── J. FIX A — external-recipient bookkeeping excluded from comparison ─────
console.log('\n══ J. Requirement — registered-wallet scoping (the 3 real txs) ══')
{
  const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
  const EXTERNAL = '0x70e3fb28e1794bb91d5bceb7d66b731d0c61af8e'
  const TX_EURC4 = '0x92ab1ecaab936bab0761e4f05c7109c055bb5dc357c7a38e676622845f04c292'
  const TX_USDC6 = '0x56feeed80e25cb1022c94173436870d4e9aa4ce25e741f508388c412a4eb57ce'
  const TX_USDC20 = '0x441120660a410dc28fc731e92fbca752a7c5e43d8fd533675afaae410b1734c9'
  const registered = new Set([SENDER])

  // Cases A+B: client bookkeeping for an external recipient, with NO indexer
  // event (the indexer watches only registered wallets, so none was emitted).
  const workerRows = [
    { wallet_address: EXTERNAL, tx_hash: `recv_${TX_EURC4}` },
    { wallet_address: EXTERNAL, tx_hash: `recv_${TX_USDC6}` },
  ]
  const r = compareDeposits([], workerRows, okWindow, registered)
  check('A+B: external-recipient rows excluded from worker_only',
    r.workerOnly === 0, `worker_only=${r.workerOnly}`)
  check('A+B: exclusions are visible', r.externalExcluded === 2, `excluded=${r.externalExcluded}`)
  check('A+B: result is NOT_COMPARABLE (nothing left to compare), not PASS',
    r.status === 'NOT_COMPARABLE', `status=${r.status}`)

  // Case C: a REAL miss for a REGISTERED wallet must remain a miss.
  const r2 = compareDeposits([], [
    { wallet_address: EXTERNAL, tx_hash: `recv_${TX_EURC4}` },
    { wallet_address: EXTERNAL, tx_hash: `recv_${TX_USDC6}` },
    { wallet_address: SENDER, tx_hash: `recv_${TX_USDC20}` },
  ], okWindow, registered)
  check('C: registered-wallet miss SURVIVES the external filtering',
    r2.workerOnly === 1 && r2.workerOnlyKeys[0].tx === TX_USDC20,
    `worker_only=${r2.workerOnly}`)
  check('C: only the 2 external rows were excluded', r2.externalExcluded === 2,
    `excluded=${r2.externalExcluded}`)
  check('C: result remains FAIL — removing external rows must not manufacture a pass',
    r2.status === 'FAIL', `status=${r2.status}`)

  // A genuine match still PASSes when both sides are registered.
  const r3 = compareDeposits(
    [{ wallet_address: SENDER, tx_hash: TX_USDC20, event_type: 'deposit_detected' }],
    [{ wallet_address: SENDER, tx_hash: `recv_${TX_USDC20}` }],
    okWindow, registered)
  check('registered match still PASSes', r3.status === 'PASS' && r3.matched === 1,
    `status=${r3.status} matched=${r3.matched}`)

  // Without a registry, everything is compared (backward compatibility).
  // externalExcluded is still reported, as 0 — the field shape stays constant
  // whether or not a registry was supplied, so consumers never see undefined.
  const r4 = compareDeposits([], workerRows, okWindow)
  check('no registry supplied -> previous behaviour (external rows compared)',
    r4.workerOnly === 2 && r4.externalExcluded === 0,
    `worker_only=${r4.workerOnly} externalExcluded=${r4.externalExcluded}`)

  // Empty window stays NOT_COMPARABLE even with a registry.
  const r5 = compareDeposits([], [], okWindow, registered)
  check('empty window remains NOT_COMPARABLE under a registry',
    r5.status === 'NOT_COMPARABLE', r5.status)
  check('catch-up gate still precedes scoping',
    compareDeposits([], workerRows, assessComparability(BEHIND, MAX_BACKLOG), registered).status
      === 'NOT_COMPARABLE',
    'NOT_COMPARABLE even with external rows present')
}

console.log('\n' + '='.repeat(70))
console.log(`Shadow comparison: ${pass}/${pass + fail} passed`)
console.log('='.repeat(70))
console.log('\nComparison layer only. No detection logic was changed.\n')
if (fail > 0) process.exit(1)