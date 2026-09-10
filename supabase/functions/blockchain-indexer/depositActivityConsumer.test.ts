// supabase/functions/blockchain-indexer/depositActivityConsumer.test.ts
import {
  assessDepositEligibility,
  buildDepositActivityRow,
  receiveTxHashKey,
  sweepDepositCandidateChainEvents,
} from './depositActivityConsumer.ts'
import type {
  DepositActivityRow,
  DepositActivityUpdateRepository,
  DepositCandidateChainEvent,
  DepositEligibilityLookup,
} from './depositActivityConsumer.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const EXTERNAL_SENDER = '0x1111111111111111111111111111111111111111'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

function candidate(overrides: Partial<DepositCandidateChainEvent> = {}): DepositCandidateChainEvent {
  return {
    chainEventId: 'ce-1', chainId: 'arc', txHash: '0xRealTx', walletAddress: WALLET,
    senderAddress: EXTERNAL_SENDER, amount: 5, tokenSymbol: 'USDC', ...overrides,
  }
}

function makeLookup(overrides: Partial<{ internal: boolean; feature: string | null }> = {}): DepositEligibilityLookup {
  return {
    isKnownInternalContractSender: () => Promise.resolve(overrides.internal ?? false),
    findCorrelatedTrackedFeature: () => Promise.resolve(overrides.feature ?? null),
  }
}

function makeRepo(existing: Set<string> = new Set()) {
  const inserted: DepositActivityRow[] = []
  const repo: DepositActivityUpdateRepository = {
    insertActivityIfAbsent: (row) => {
      const key = `${row.tx_hash}:${row.wallet_address}`
      if (existing.has(key)) return Promise.resolve('already_existed')
      existing.add(key)
      inserted.push(row)
      return Promise.resolve('inserted')
    },
  }
  return { repo, inserted, existing }
}

// ── 1. External incoming transfer -> creates Activity ──────────────────
Deno.test('1. a genuine external transfer is eligible and creates exactly one Activity row', async () => {
  const { repo, inserted } = makeRepo()
  const results = await sweepDepositCandidateChainEvents([candidate()], makeLookup(), repo, 'https://testnet.arcscan.app')
  assertEquals(results[0].outcome, 'created')
  assertEquals(inserted.length, 1)
  assertEquals(inserted[0].activity_type, 'receive')
})

// ── 2. Same chain_event processed twice -> exactly one Activity ────────
Deno.test('2. sweeping the same event twice produces exactly one Activity row (idempotent)', async () => {
  const { repo, inserted } = makeRepo()
  await sweepDepositCandidateChainEvents([candidate()], makeLookup(), repo, 'https://testnet.arcscan.app')
  const results2 = await sweepDepositCandidateChainEvents([candidate()], makeLookup(), repo, 'https://testnet.arcscan.app')
  assertEquals(results2[0].outcome, 'already_existed')
  assertEquals(inserted.length, 1, 'only one row was ever actually inserted across both sweeps')
})

// ── 3/4/5. Pay/BulkPay/Swap chain event -> NOT classified as external deposit ──
for (const feature of ['pay', 'bulkpay', 'swap']) {
  Deno.test(`3-5. a chain_event correlated to a tracked ${feature} attempt is never classified as an external deposit`, async () => {
    const { repo, inserted } = makeRepo()
    const results = await sweepDepositCandidateChainEvents([candidate()], makeLookup({ feature }), repo, 'https://testnet.arcscan.app')
    assertEquals(results[0].outcome, 'skipped')
    assertEquals(results[0].reason, `correlated_to_tracked_feature:${feature}`)
    assertEquals(inserted.length, 0)
  })
}

// ── 6. Internal/known contract transfer -> NOT incorrectly classified ──
Deno.test('6. a transfer from a known-internal-contract sender (e.g. Kit Adapter) is never classified as an external deposit, even with no attempt correlation', async () => {
  const { repo, inserted } = makeRepo()
  const results = await sweepDepositCandidateChainEvents(
    [candidate({ senderAddress: KIT_ADAPTER })], makeLookup({ internal: true }), repo, 'https://testnet.arcscan.app',
  )
  assertEquals(results[0].outcome, 'skipped')
  assertEquals(results[0].reason, 'known_internal_contract_sender')
  assertEquals(inserted.length, 0)
})

// ── 7. Missing sender / non-positive amount -> no Activity fabricated ──
Deno.test('7. a chain_event with no recorded sender is never treated as eligible -- no Activity fabricated', () => {
  const result = assessDepositEligibility(candidate({ senderAddress: null }), false, null)
  assertEquals(result, { eligible: false, reason: 'missing_sender' })
})

Deno.test('7b. a non-positive amount is never treated as eligible', () => {
  const result = assessDepositEligibility(candidate({ amount: 0 }), false, null)
  assertEquals(result.eligible, false)
})

// ── 8. Correct wallet/user association ──────────────────────────────────
Deno.test('8. the Activity row is attributed to the exact recipient wallet from the chain_event', () => {
  const row = buildDepositActivityRow(candidate({ walletAddress: '0xABCDEF0000000000000000000000000000000A' }), 'https://testnet.arcscan.app')
  assertEquals(row.wallet_address, '0xabcdef0000000000000000000000000000000a')
})

// ── 9. Correct token and amount ─────────────────────────────────────────
Deno.test('9. token symbol and amount are taken directly from the chain_event, not invented', () => {
  const row = buildDepositActivityRow(candidate({ amount: 3.439132, tokenSymbol: 'EURC' }), 'https://testnet.arcscan.app')
  assertEquals(row.amount, 3.439132)
  assertEquals(row.usd_value, 3.439132)
  assertEquals(row.token_symbol, 'EURC')
})

// ── 10. Correct tx_hash / chain correlation ─────────────────────────────
Deno.test('10. tx_hash uses the recv_ prefix convention, matching deposit-scan-all\'s own key so both writers can never double-record the same event', () => {
  assertEquals(receiveTxHashKey('0xABC123'), 'recv_0xabc123')
  const row = buildDepositActivityRow(candidate({ txHash: '0xDeadBeef' }), 'https://testnet.arcscan.app')
  assertEquals(row.tx_hash, 'recv_0xdeadbeef')
  assertEquals(row.explorer_url, 'https://testnet.arcscan.app/tx/0xDeadBeef')
})

// ── 11. Retry after partial failure -> safe and idempotent ─────────────
Deno.test('11. one event throwing does not stop the rest of the batch, and a retry sweep is safe', async () => {
  const { repo, inserted } = makeRepo()
  const lookup: DepositEligibilityLookup = {
    isKnownInternalContractSender: () => Promise.resolve(false),
    findCorrelatedTrackedFeature: (chainId, txHash) => txHash === '0xBad' ? Promise.reject(new Error('boom')) : Promise.resolve(null),
  }
  const results = await sweepDepositCandidateChainEvents(
    [candidate({ chainEventId: 'bad', txHash: '0xBad' }), candidate({ chainEventId: 'good', txHash: '0xGood' })],
    lookup, repo, 'https://testnet.arcscan.app',
  )
  assertEquals(results.find(r => r.chainEventId === 'bad')?.outcome, 'skipped')
  assertEquals(results.find(r => r.chainEventId === 'good')?.outcome, 'created')
  assertEquals(inserted.length, 1)
  // Retry: the bad one still throws every time (simulating a persistent
  // correlation-lookup error) -- must remain safe, never partially insert,
  // never duplicate the good one.
  const retry = await sweepDepositCandidateChainEvents(
    [candidate({ chainEventId: 'bad', txHash: '0xBad' }), candidate({ chainEventId: 'good', txHash: '0xGood' })],
    lookup, repo, 'https://testnet.arcscan.app',
  )
  assertEquals(retry.find(r => r.chainEventId === 'good')?.outcome, 'already_existed')
  assertEquals(inserted.length, 1, 'no duplicate created on retry')
})

// ── 12. Existing Activity semantics remain intact ───────────────────────
Deno.test('12. metadata.note is exactly "External deposit" -- HomePage.tsx\'s legacy notification fallback depends on this exact string for pre-fix rows; metadata.receiveKind is the new canonical, explicit classification', () => {
  const row = buildDepositActivityRow(candidate(), 'https://testnet.arcscan.app')
  assertEquals(row.metadata.note, 'External deposit')
  assertEquals(row.metadata.receiveKind, 'external_deposit')
  assertEquals(row.activity_type, 'receive')
  assertEquals(row.status, 'completed')
  assertEquals(row.metadata.recovered, false)
})

Deno.test('empty candidate list -> no-op', async () => {
  const { repo, inserted } = makeRepo()
  const results = await sweepDepositCandidateChainEvents([], makeLookup(), repo, 'https://testnet.arcscan.app')
  assertEquals(results, [])
  assertEquals(inserted.length, 0)
})
