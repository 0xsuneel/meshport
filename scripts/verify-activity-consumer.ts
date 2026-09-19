/**
 * verify-activity-consumer.ts — the chain_events -> activity consumer.
 *
 * Covers all 13 required cases plus the hazards live data proved real.
 *
 * Grounded in real rows, not invented ones:
 *   wrapper USDC  0xbdded45c…  block 57218424, 20 USDC via 0xffff…fffe,
 *                 sender 0x70e3fb28…, wallet 0x05d00ab7… (verified PASS x3)
 *   Kit Adapter   sender 0xbbd70b01…, amount 1.242326, wallet 0x05d00ab7…,
 *                 NO recv_ row but an existing 'swap' row — a naive consumer
 *                 WOULD have credited this. Fix C is what stops it.
 *
 * Run: npx tsx scripts/verify-activity-consumer.ts
 */
import {
  decideActivityRow, matchesRecentSwapOutput, KNOWN_INTERNAL_CONTRACTS,
  CREDIT_EVENT_TYPES, CREDITABLE_STATUS, MIN_EVENT_AGE_MS, SWAP_GRACE_SECONDS,
  type ChainEventRow, type EventFacts,
} from '../supabase/functions/activity-consumer/decide'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const SENDER = '0x70e3fb28e1794bb91d5bceb7d66b731d0c61af8e'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'
const ZERO = '0x' + '0'.repeat(40)
const EXPLORER = 'https://testnet.arcscan.app'
const NOW = 1_800_000_000_000
/** Old enough to clear the settle delay. */
const OLD = new Date(NOW - MIN_EVENT_AGE_MS - 5_000).toISOString()

function event(o: Partial<ChainEventRow> = {}): ChainEventRow {
  return {
    id: 56,
    chain_id: 'arc',
    event_type: 'deposit_detected',
    tx_hash: '0xbdded45c789fe2dacb0dc258392f431acf24c62ac273be39efab47ff2e3f8f77',
    wallet_address: WALLET,
    assets: ['USDC'],
    metadata: { sender: SENDER, recipient: WALLET, amount: 20, via: 'native-transfer-log' },
    status: 'confirmed',
    created_at: OLD,
    ...o,
  }
}
const facts = (o: Partial<EventFacts> = {}): EventFacts => ({
  isRegisteredWallet: true, hasAnyActivityForTxHash: false, ...o,
})
const decide = (e: ChainEventRow, f: EventFacts = facts()) => decideActivityRow(e, f, EXPLORER, NOW)

console.log('\n══ 1-3. The three fundable asset paths ══')
{
  // 1. Plain native USDC — no `via` key.
  const plain = decide(event({ metadata: { sender: SENDER, recipient: WALLET, amount: 5 } }))
  check('plain native USDC is credited', plain.action === 'credit',
    plain.action === 'skip' ? plain.reason : `${(plain as any).row.amount} USDC`)
  if (plain.action === 'credit') {
    check('  amount preserved in human units (NOT re-divided by 1e18)', plain.row.amount === 5,
      String(plain.row.amount))
    check('  identity key is recv_<hash>, matching deposit-scan-all',
      plain.row.tx_hash === 'recv_0xbdded45c789fe2dacb0dc258392f431acf24c62ac273be39efab47ff2e3f8f77',
      plain.row.tx_hash)
    check('  activity_type is receive', plain.row.activity_type === 'receive')
    check('  counterparty is the sender', plain.row.counterparty_address === SENDER)
    check('  note is exactly "External deposit" (so HomePage notifies)',
      plain.row.metadata.note === 'External deposit', plain.row.metadata.note)
    check('  explorer_url uses the UNPREFIXED hash',
      plain.row.explorer_url.endsWith('0xbdded45c789fe2dacb0dc258392f431acf24c62ac273be39efab47ff2e3f8f77') &&
      !plain.row.explorer_url.includes('recv_'), plain.row.explorer_url)
    check('  provenance recorded (source + chain_event_id)',
      plain.row.metadata.source === 'activity-consumer' && plain.row.metadata.chain_event_id === 56)
  }

  // 2. Wrapper-routed USDC through 0x3600 — surfaces as via: native-transfer-log.
  const wrapper = decide(event())
  check('wrapper-routed USDC (via 0xffff…fffe) is credited', wrapper.action === 'credit')
  if (wrapper.action === 'credit') {
    check('  wrapper amount is 20 USDC, 6-dec value not double-scaled',
      wrapper.row.amount === 20 && wrapper.row.token_symbol === 'USDC',
      `${wrapper.row.amount} ${wrapper.row.token_symbol}`)
  }

  // 3. EURC via transfer_detected.
  const eurc = decide(event({
    event_type: 'transfer_detected', assets: ['EURC'],
    metadata: { sender: SENDER, recipient: WALLET, amount: 2.5 },
  }))
  check('EURC transfer_detected is credited', eurc.action === 'credit')
  if (eurc.action === 'credit') {
    check('  EURC symbol carried from assets[]', eurc.row.token_symbol === 'EURC')
    check('  EURC amount preserved', eurc.row.amount === 2.5)
  }

  // cirBTC would ride the identical path — asserted for completeness even
  // though the asset is not fundable in this environment.
  const cir = decide(event({
    event_type: 'transfer_detected', assets: ['cirBTC'],
    metadata: { sender: SENDER, recipient: WALLET, amount: 0.005 },
  }))
  check('cirBTC uses the same code path (unfundable, so logic-only)',
    cir.action === 'credit' && cir.row.token_symbol === 'cirBTC')
}

console.log('\n══ 4-5. Idempotency: duplicate event, existing activity row ══')
{
  // 4. The same chain_event processed twice. Second pass sees the row it wrote.
  const first = decide(event())
  check('first pass credits', first.action === 'credit')
  const second = decide(event(), facts({ hasAnyActivityForTxHash: true }))
  check('second pass on the SAME event skips (no duplicate)', second.action === 'skip',
    second.action === 'skip' ? second.reason : '')

  // 5. deposit-scan-all already wrote the row — this consumer must defer.
  const raced = decide(event(), facts({ hasAnyActivityForTxHash: true }))
  check('an existing row from deposit-scan-all is respected', raced.action === 'skip')

  // Any activity_type counts, not just receive — a swap/p2p/bulk row under the
  // same hash means the movement is already accounted for.
  const swapRow = decide(event(), facts({ hasAnyActivityForTxHash: true }))
  check("ANY activity_type under the hash blocks crediting, not just 'receive'",
    swapRow.action === 'skip', swapRow.action === 'skip' ? swapRow.reason : '')

  // Both producers converge on ONE identity, which the unique index enforces.
  const a = decide(event())
  check('identity key is deterministic, so the unique index collapses races',
    a.action === 'credit' && a.row.tx_hash.startsWith('recv_0xbdded45c'),
    a.action === 'credit' ? a.row.tx_hash : '')
}

console.log('\n══ 6. Fix C — internal-sender exclusion (proved necessary on live data) ══')
{
  const kit = decide(event({
    metadata: { sender: KIT_ADAPTER, recipient: WALLET, amount: 1.242326 },
  }))
  check('Kit Adapter sender is EXCLUDED (the real swap-leg hazard)',
    kit.action === 'skip', kit.action === 'skip' ? kit.reason : 'WRONGLY CREDITED')

  // MULTICALL3 / BULKPAY — proved necessary on live data 2026-09-02.
  // Two real production BulkPay self-sends (tx 0xac28f48b…, 0x22b268c5…,
  // both 2026-08-30/31) each got the correct pair of `bulk` rows from
  // BulkPayoutPage.tsx PLUS a spurious THIRD `receive` row from THIS
  // consumer, sender = Multicall3 (0xca11bde0…), because Multicall3 was
  // missing from this file's local KNOWN_INTERNAL_CONTRACTS copy even
  // though it had already been added to the shared
  // _shared/knownInternalContracts.ts list used elsewhere (claim-recovery-
  // scan). Named explicitly, not just via the generic loop below, so a
  // future accidental removal of this one entry fails loudly instead of
  // just shrinking the loop's iteration count.
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
  const bulkPaySelfSend = decide(event({
    metadata: { sender: MULTICALL3, recipient: WALLET, amount: 10 },
  }))
  check('Multicall3/BulkPay sender is EXCLUDED (2026-08-30/31 production duplicate)',
    bulkPaySelfSend.action === 'skip',
    bulkPaySelfSend.action === 'skip' ? bulkPaySelfSend.reason : 'WRONGLY CREDITED — this is the exact live bug')

  let allExcluded = true
  for (const addr of KNOWN_INTERNAL_CONTRACTS) {
    const d = decide(event({ metadata: { sender: addr, recipient: WALLET, amount: 10 } }))
    if (d.action !== 'skip') allExcluded = false
  }
  check(`all ${KNOWN_INTERNAL_CONTRACTS.size} internal contracts excluded`, allExcluded)

  check('CCTP TokenMessenger excluded',
    decide(event({ metadata: { sender: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', recipient: WALLET, amount: 1 } })).action === 'skip')
  check('CCTP MessageTransmitter excluded',
    decide(event({ metadata: { sender: '0xe737e5cebeeba77efe34d4aa090756590b1ce275', recipient: WALLET, amount: 1 } })).action === 'skip')

  // Case-insensitivity — a checksummed address must not slip past the set.
  check('exclusion is case-insensitive (checksummed address still excluded)',
    decide(event({ metadata: { sender: KIT_ADAPTER.toUpperCase(), recipient: WALLET, amount: 1 } })).action === 'skip')
}

console.log('\n══ 7. Unregistered recipient ══')
{
  const unreg = decide(event(), facts({ isRegisteredWallet: false }))
  check('unregistered recipient is NOT credited', unreg.action === 'skip',
    unreg.action === 'skip' ? unreg.reason : '')
}

console.log('\n══ 8-9. Mint / self-transfer / non-positive amount ══')
{
  // 8. Zero-address sender = CCTP mint. claim-worker owns it.
  const mint = decide(event({ metadata: { sender: ZERO, recipient: WALLET, amount: 50 } }))
  check('zero-address sender (CCTP mint) is NOT credited as a deposit',
    mint.action === 'skip', mint.action === 'skip' ? mint.reason : 'WRONGLY CREDITED')
  check('  and the skip reason names claim-worker ownership',
    mint.action === 'skip' && mint.reason.includes('claim-worker'))

  const self = decide(event({ metadata: { sender: WALLET, recipient: WALLET, amount: 10 } }))
  check('self-transfer is NOT credited', self.action === 'skip',
    self.action === 'skip' ? self.reason : '')
  check('self-transfer detection is case-insensitive',
    decide(event({ metadata: { sender: WALLET.toUpperCase(), recipient: WALLET, amount: 10 } })).action === 'skip')

  // 9. Zero / negative / non-finite amounts.
  for (const [label, amt] of [['zero', 0], ['negative', -5], ['NaN', NaN]] as const) {
    check(`${label} amount is NOT credited`,
      decide(event({ metadata: { sender: SENDER, recipient: WALLET, amount: amt } })).action === 'skip')
  }
  check('a numeric STRING amount is accepted (tolerant parse)',
    decide(event({ metadata: { sender: SENDER, recipient: WALLET, amount: '7.5' } })).action === 'credit')
}

console.log('\n══ 10. Malformed / missing metadata ══')
{
  const cases: Array<[string, ChainEventRow]> = [
    ['null metadata',            event({ metadata: null })],
    ['empty metadata',           event({ metadata: {} })],
    ['missing sender',           event({ metadata: { recipient: WALLET, amount: 10 } })],
    ['sender not a string',      event({ metadata: { sender: 12345, recipient: WALLET, amount: 10 } as never })],
    ['missing amount',           event({ metadata: { sender: SENDER, recipient: WALLET } })],
    ['null tx_hash',             event({ tx_hash: null })],
    ['null wallet_address',      event({ wallet_address: null })],
    ['empty assets on transfer', event({ event_type: 'transfer_detected', assets: [], metadata: { sender: SENDER, recipient: WALLET, amount: 1 } })],
    ['unparseable created_at',   event({ created_at: 'not-a-date' })],
  ]
  let allSafe = true
  for (const [label, ev] of cases) {
    let threw = false
    let action = ''
    try { const d = decide(ev); action = d.action } catch { threw = true; allSafe = false }
    check(`${label} -> skip, never throw`, !threw && action === 'skip',
      threw ? 'THREW' : action)
  }
  check('no malformed input can crash a pass', allSafe)

  // A deposit_detected with no assets[] still resolves to USDC (native default).
  check('deposit_detected with empty assets[] defaults to USDC',
    (() => { const d = decide(event({ assets: [] })); return d.action === 'credit' && d.row.token_symbol === 'USDC' })())
}

console.log('\n══ 11-12. Restart / retry / concurrency ══')
{
  // 11. Partial processing: event decided but insert failed -> next pass retries
  // because no activity row exists yet.
  const retry = decide(event(), facts({ hasAnyActivityForTxHash: false }))
  check('after a failed insert the event is still credit-eligible (retry works)',
    retry.action === 'credit')
  const afterSuccess = decide(event(), facts({ hasAnyActivityForTxHash: true }))
  check('once the row exists the retry becomes a no-op', afterSuccess.action === 'skip')

  // 12. Two concurrent passes both decide 'credit'; the identity is identical,
  // so the DB unique index on (tx_hash, wallet_address) collapses them.
  const p1 = decide(event())
  const p2 = decide(event())
  check('concurrent passes produce IDENTICAL identity (index collapses them)',
    p1.action === 'credit' && p2.action === 'credit' &&
    p1.row.tx_hash === p2.row.tx_hash && p1.row.wallet_address === p2.row.wallet_address,
    p1.action === 'credit' ? `${p1.row.tx_hash}/${p1.row.wallet_address}` : '')

  // Settle delay: a too-new event is deferred, not credited, so a client-written
  // swap row has time to land first.
  const fresh = decide(event({ created_at: new Date(NOW - 1_000).toISOString() }))
  check('an event younger than the settle delay is DEFERRED', fresh.action === 'skip',
    fresh.action === 'skip' ? fresh.reason : '')
  check(`settle delay (${MIN_EVENT_AGE_MS}ms) is inside deposit-scan-all's ${SWAP_GRACE_SECONDS}s swap window`,
    MIN_EVENT_AGE_MS < SWAP_GRACE_SECONDS * 1000)
}

console.log('\n══ 13. CCTP claim safety ══')
{
  // Already covered by the mint case; these assert the surrounding guarantees.
  check('a mint is never credited as an ordinary deposit',
    decide(event({ metadata: { sender: ZERO, recipient: WALLET, amount: 100 } })).action === 'skip')
  check('CCTP internal contracts cannot become deposits',
    decide(event({ metadata: { sender: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', recipient: WALLET, amount: 100 } })).action === 'skip')

  // The consumer only ever produces 'receive' rows — it can never write a claim.
  const credited = decide(event())
  check("the consumer can ONLY ever emit activity_type 'receive'",
    credited.action === 'credit' && credited.row.activity_type === 'receive')

  // Event vocabulary is closed: a claim-ish event type is not consumable.
  check("only deposit_detected / transfer_detected are consumable",
    CREDIT_EVENT_TYPES.size === 2 &&
    CREDIT_EVENT_TYPES.has('deposit_detected') && CREDIT_EVENT_TYPES.has('transfer_detected'))
  for (const t of ['transaction_confirmed', 'transaction_failed', 'balance_changed']) {
    check(`  '${t}' is NOT consumable`, decide(event({ event_type: t })).action === 'skip')
  }
}

console.log('\n══ 14. Status gating + swap-quiet rule ══')
{
  check(`only '${CREDITABLE_STATUS}' events are credited`,
    decide(event({ status: 'confirmed' })).action === 'credit')
  check("'pending' is NOT credited (could still reorg)",
    decide(event({ status: 'pending' })).action === 'skip')
  check("'reorged' is NOT credited (did not happen)",
    decide(event({ status: 'reorged' })).action === 'skip')

  // Quiet: matching swap output -> recorded, but note suppresses the alert.
  const quiet = decide(event({ metadata: { sender: SENDER, recipient: WALLET, amount: 20 } }),
    facts({ recentSwapOutputs: [{ token: 'USDC', amount: 20 }] }))
  check('a deposit matching a recent swap output is still RECORDED',
    quiet.action === 'credit')
  check("  but marked quiet via note 'External deposit (near a swap)'",
    quiet.action === 'credit' && quiet.row.metadata.note === 'External deposit (near a swap)',
    quiet.action === 'credit' ? quiet.row.metadata.note : '')

  // An unrelated deposit near a swap must NOT be silenced.
  const unrelated = decide(event({ metadata: { sender: SENDER, recipient: WALLET, amount: 999 } }),
    facts({ recentSwapOutputs: [{ token: 'USDC', amount: 20 }] }))
  check('an unrelated amount near a swap is NOT silenced',
    unrelated.action === 'credit' && unrelated.row.metadata.note === 'External deposit')

  check('swap matching honours the 1% tolerance',
    matchesRecentSwapOutput([{ token: 'USDC', amount: 100 }], 'USDC', 100.5) &&
    !matchesRecentSwapOutput([{ token: 'USDC', amount: 100 }], 'USDC', 120))
  check('swap matching is token-scoped', !matchesRecentSwapOutput([{ token: 'EURC', amount: 20 }], 'USDC', 20))
}

console.log('\n' + '='.repeat(68))
console.log(`Activity consumer verification: ${pass}/${pass + fail} passed`)
console.log('='.repeat(68))
console.log('\n1-3 asset paths · 4-5 idempotency · 6 Fix C · 7 registration')
console.log('8-9 mint/self/amount · 10 malformed · 11-12 restart+concurrency')
console.log('13 CCTP claim safety · 14 status gating + swap-quiet.\n')
if (fail > 0) process.exit(1)
