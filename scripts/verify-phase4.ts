/**
 * Phase 4 verification — shadow comparison logic.
 *
 * The comparison decides the production cutover, so its failure modes are
 * asserted rather than assumed. The dangerous ones are SILENT:
 *   - forgetting the recv_ prefix makes every deposit look like a mismatch
 *     (shadow mode screams, nobody trusts it)
 *   - or, worse, a matching bug that reports 100% when nothing was compared
 *     (shadow mode looks perfect, cutover breaks production)
 * Both are covered below.
 *
 * Run: npx tsx scripts/verify-phase4.ts
 */
import {
  compareDeposits, compareClaims, normalizeTxHash, internalSenderOf, KNOWN_INTERNAL_CONTRACTS,
} from '../supabase/functions/blockchain-indexer/compare'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else    { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const W1 = '0xaaaa000000000000000000000000000000000001'
const W2 = '0xbbbb000000000000000000000000000000000002'
const TX1 = '0x1111111111111111111111111111111111111111111111111111111111111111'
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222'
const TX3 = '0x3333333333333333333333333333333333333333333333333333333333333333'
const TX4 = '0x4444444444444444444444444444444444444444444444444444444444444444'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

console.log('\n── A. tx_hash normalization (the recv_ prefix trap) ──')
check('strips recv_ prefix', normalizeTxHash(`recv_${TX1}`) === TX1)
check('leaves a bare hash alone', normalizeTxHash(TX1) === TX1)
check('lowercases', normalizeTxHash(TX1.toUpperCase()) === TX1)
check('null/empty is empty', normalizeTxHash(null) === '' && normalizeTxHash('') === '')
check('recv_ + uppercase both handled', normalizeTxHash(`recv_${TX1.toUpperCase()}`) === TX1)

console.log('\n── B. Deposits: perfect agreement ──')
{
  const events = [
    { wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' },
    { wallet_address: W2, tx_hash: TX2, event_type: 'transfer_detected' },
  ]
  const worker = [
    { wallet_address: W1, tx_hash: `recv_${TX1}` },
    { wallet_address: W2, tx_hash: `recv_${TX2}` },
  ]
  const r = compareDeposits(events, worker)
  check('both matched across the prefix boundary', r.matched === 2, `matched=${r.matched}`)
  check('no worker-only', r.workerOnly === 0, `workerOnly=${r.workerOnly}`)
  check('no indexer-only', r.indexerOnly === 0, `indexerOnly=${r.indexerOnly}`)
  check('recall is 100%', r.recallPct === 100, `${r.recallPct}%`)
}

console.log('\n── C. Deposits: indexer MISSED one (the cutover blocker) ──')
{
  const events = [{ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' }]
  const worker = [
    { wallet_address: W1, tx_hash: `recv_${TX1}` },
    { wallet_address: W2, tx_hash: `recv_${TX2}` }, // indexer never saw this
  ]
  const r = compareDeposits(events, worker)
  check('miss is counted as worker-only', r.workerOnly === 1, `workerOnly=${r.workerOnly}`)
  check('recall drops below 100', r.recallPct === 50, `${r.recallPct}%`)
  check('the missed key is reported for investigation',
    r.workerOnlyKeys.length === 1 && r.workerOnlyKeys[0].tx === TX2,
    JSON.stringify(r.workerOnlyKeys))
}

console.log('\n── D. Deposits: indexer saw MORE (not necessarily a fault) ──')
{
  const events = [
    { wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' },
    { wallet_address: W1, tx_hash: TX3, event_type: 'deposit_detected' },
  ]
  const worker = [{ wallet_address: W1, tx_hash: `recv_${TX1}` }]
  const r = compareDeposits(events, worker)
  check('extra detection is indexer-only, not a miss', r.indexerOnly === 1 && r.workerOnly === 0,
    `indexerOnly=${r.indexerOnly} workerOnly=${r.workerOnly}`)
  check('recall stays 100% (recall measures misses, not extras)', r.recallPct === 100, `${r.recallPct}%`)
}

console.log('\n── E. Same hash, DIFFERENT wallet must not match ──')
{
  const events = [{ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' }]
  const worker = [{ wallet_address: W2, tx_hash: `recv_${TX1}` }]
  const r = compareDeposits(events, worker)
  check('wallet is part of the key', r.matched === 0 && r.workerOnly === 1 && r.indexerOnly === 1,
    `matched=${r.matched} workerOnly=${r.workerOnly} indexerOnly=${r.indexerOnly}`)
}

console.log('\n── F. Empty input reports null recall, NOT 100% ──')
{
  const r = compareDeposits([], [])
  check('nothing compared => recall null', r.recallPct === null, `${r.recallPct}`)
  check('counts are zero', r.matched === 0 && r.workerOnly === 0 && r.indexerOnly === 0)
  // This is the dangerous one: a quiet period must not read as "100% accurate".
  check('quiet window is distinguishable from perfect accuracy', r.recallPct !== 100)
}

console.log('\n── G. Irrelevant event types are ignored ──')
{
  const events = [
    { wallet_address: W1, tx_hash: TX1, event_type: 'balance_changed' },
    { wallet_address: W1, tx_hash: TX2, event_type: 'transaction_confirmed' },
  ]
  const worker = [{ wallet_address: W1, tx_hash: `recv_${TX3}` }]
  const r = compareDeposits(events, worker)
  check('non-deposit events are not counted as detections',
    r.indexerOnly === 0, `indexerOnly=${r.indexerOnly}`)
  check('the real worker row still registers as a miss', r.workerOnly === 1, `workerOnly=${r.workerOnly}`)
}

console.log('\n── H. Malformed rows are skipped, not crashed on ──')
{
  const events = [
    { wallet_address: null, tx_hash: TX1, event_type: 'deposit_detected' },
    { wallet_address: W1, tx_hash: null, event_type: 'deposit_detected' },
  ]
  const worker = [{ wallet_address: '', tx_hash: '' }]
  const r = compareDeposits(events as never, worker)
  check('rows without a usable key are ignored',
    r.matched === 0 && r.workerOnly === 0 && r.indexerOnly === 0,
    JSON.stringify({ m: r.matched, w: r.workerOnly, i: r.indexerOnly }))
}

console.log('\n── I. Claims compare against destination_tx_hash ──')
{
  // REVISED. This section previously asserted that a `transfer_detected` event
  // should match a completed claim — the original design, and the defect that
  // produced indexer_only = 4 on deployed data by treating four ordinary
  // USDC/EURC deposits as rogue claim events. claim-worker owns the claim
  // lifecycle and the indexer deliberately skips CCTP mints (D-3), so a
  // transfer event is NOT a claim candidate and the scope is NOT_APPLICABLE.
  // The old assertions encoded the bug; these assert the corrected contract.
  const events = [{ wallet_address: W1, tx_hash: TX1, event_type: 'transfer_detected' }]
  const claims = [{ wallet_address: W1, destination_tx_hash: TX1, status: 'completed' }]
  const r = compareClaims(events, claims)
  check('a transfer event is NOT treated as a claim candidate', r.indexerOnly === 0,
    `indexer_only=${r.indexerOnly}`)
  check('claims scope is NOT_APPLICABLE (claim-worker owns it)', r.status === 'NOT_APPLICABLE', r.status)
  check('recall NULL — not a cutover metric', r.recallPct === null)
}
{
  const claims = [{ wallet_address: W1, destination_tx_hash: TX2, status: 'completed' }]
  const r = compareClaims([], claims)
  check('completed claims surface as factual context', r.workerOnly === 1, `workerOnly=${r.workerOnly}`)
  check('but never as a measured indexer miss', r.status === 'NOT_APPLICABLE' && r.recallPct === null,
    `status=${r.status} recall=${r.recallPct}`)
}
{
  // The scope becomes real if the indexer is ever given claim ownership.
  const r = compareClaims(
    [{ wallet_address: W1, tx_hash: TX1, event_type: 'claim_completed' }],
    [{ wallet_address: W1, destination_tx_hash: TX1, status: 'completed' }])
  check('a genuine claim_completed event IS compared', r.matched === 1 && r.status === 'PASS',
    `matched=${r.matched} status=${r.status}`)
}

console.log('\n── J. Duplicate events do not inflate the match count ──')
{
  const events = [
    { wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' },
    { wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' }, // dup
  ]
  const worker = [{ wallet_address: W1, tx_hash: `recv_${TX1}` }]
  const r = compareDeposits(events, worker)
  check('duplicate indexer events still reconcile to one worker row',
    r.workerOnly === 0, `workerOnly=${r.workerOnly}`)
}

console.log('\n── K. Fix C: Circle Kit/CCTP internal-contract swap outputs ──')
{
  // The exact live shape that held Phase 4 at FAIL: two indexer events with no
  // worker counterpart, both sent by the Kit Adapter Contract. deposit-scan-all
  // skipped them by design, so they are a scope difference, not a defect.
  // NOTE the two DIFFERENT metadata keys — this mirrors scanner.ts, which
  // writes `sender` on the native/log paths and `from` on the wrapper path.
  // A fix that reads only one key leaves the other event counted and Phase 4
  // still failing, so both shapes are asserted here rather than assumed.
  const events = [
    { wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected' },
    { wallet_address: W1, tx_hash: TX2, event_type: 'deposit_detected',
      metadata: { via: 'native-transfer-log', amount: 1.242326, sender: KIT_ADAPTER, recipient: W1 } },
    { wallet_address: W1, tx_hash: TX3, event_type: 'transfer_detected',
      metadata: { to: W1, from: KIT_ADAPTER, amount: 8.072964 } },
  ]
  const worker = [{ wallet_address: W1, tx_hash: `recv_${TX1}` }]
  const r = compareDeposits(events, worker)
  check('both swap outputs are excluded, not counted as indexer_only',
    r.indexerOnly === 0, `indexerOnly=${r.indexerOnly}`)
  check('the `sender` key AND the `from` key are both honoured',
    r.internalExcluded === 2, `internalExcluded=${r.internalExcluded}`)
  check('the genuine deposit still matches', r.matched === 1, `matched=${r.matched}`)
  check('window now PASSes', r.status === 'PASS', r.status)
  check('recall stays 100%', r.recallPct === 100, `${r.recallPct}%`)
}
{
  // The safety property. Suppression must never remove a MISS, only an extra.
  // A worker row the indexer never emitted is still worker_only even though an
  // unrelated internal event is present in the same window.
  const events = [
    { wallet_address: W1, tx_hash: TX2, event_type: 'deposit_detected',
      metadata: { sender: KIT_ADAPTER } },
  ]
  const worker = [
    { wallet_address: W1, tx_hash: `recv_${TX1}` },   // a genuine, unmatched deposit
  ]
  const r = compareDeposits(events, worker)
  check('a real indexer miss survives the exclusion', r.workerOnly === 1, `workerOnly=${r.workerOnly}`)
  check('recall still reports the miss', r.recallPct === 0, `${r.recallPct}%`)
  check('the exclusion cannot fabricate a PASS', r.status === 'FAIL', r.status)
}
{
  // Ordering guard: matching happens BEFORE suppression. If a worker row does
  // exist for an internal-sender transaction, the pair must match — filtering
  // the indexer side up front would delete its half and invent a worker_only.
  const events = [{ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected',
    metadata: { sender: KIT_ADAPTER } }]
  const worker = [{ wallet_address: W1, tx_hash: `recv_${TX1}` }]
  const r = compareDeposits(events, worker)
  check('an internal-sender event WITH a worker row still matches',
    r.matched === 1 && r.workerOnly === 0, `matched=${r.matched} workerOnly=${r.workerOnly}`)
  check('and is not double-counted as excluded', (r.internalExcluded ?? 0) === 0,
    `internalExcluded=${r.internalExcluded}`)
}
{
  // A window containing ONLY suppressed events measured nothing. It must not
  // report FAIL with three zero counts — that is "not measured" disguised as a
  // discrepancy, the exact ambiguity this file exists to prevent.
  const events = [
    { wallet_address: W1, tx_hash: TX2, event_type: 'deposit_detected',
      metadata: { sender: KIT_ADAPTER } },
  ]
  const r = compareDeposits(events, [])
  check('an all-internal window is NOT_COMPARABLE, not a zero-count FAIL',
    r.status === 'NOT_COMPARABLE', r.status)
  check('recall is null, never 100%', r.recallPct === null, `${r.recallPct}`)
}
{
  // Genuine senders must be untouched — the set is a hard allow-list of Circle
  // infrastructure, not a general "sender looks like a contract" heuristic.
  const events = [
    { wallet_address: W1, tx_hash: TX4, event_type: 'deposit_detected',
      metadata: { sender: '0x319dd63e0ac72e7ac74443029d074032c043460f' } },
  ]
  const r = compareDeposits(events, [])
  check('an ordinary sender is still reported as indexer_only',
    r.indexerOnly === 1 && (r.internalExcluded ?? 0) === 0,
    `indexerOnly=${r.indexerOnly} internalExcluded=${r.internalExcluded}`)
}
{
  check('address matching is case-insensitive',
    internalSenderOf({ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected',
      metadata: { sender: KIT_ADAPTER.toUpperCase() } }) === KIT_ADAPTER)
  check('surrounding whitespace is tolerated',
    internalSenderOf({ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected',
      metadata: { sender: `  ${KIT_ADAPTER}  ` } }) === KIT_ADAPTER)
  // Malformed payloads must not kill a comparison run.
  for (const meta of [null, undefined, {}, { sender: 42 }, { sender: null }, 'nonsense']) {
    check(`malformed metadata (${JSON.stringify(meta)}) is skipped, not thrown on`,
      internalSenderOf({ wallet_address: W1, tx_hash: TX1, event_type: 'deposit_detected',
        metadata: meta as never }) === null)
  }
  check('the set mirrors deposit-scan-all (Kit Adapter present)',
    KNOWN_INTERNAL_CONTRACTS.has(KIT_ADAPTER))
}

console.log('\n' + '='.repeat(60))
console.log(`Phase 4 shadow comparison: ${pass}/${pass + fail} passed`)
console.log('='.repeat(60))
if (fail > 0) process.exit(1)
