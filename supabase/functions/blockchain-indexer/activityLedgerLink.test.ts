// supabase/functions/blockchain-indexer/activityLedgerLink.test.ts
import { sweepUnlinkedActivityRows } from './activityLedgerLink.ts'
import type { ActivityLinkUpdateRepository, CanonicalLedgerEventLookup, UnlinkedActivityRow } from './activityLedgerLink.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

function row(overrides: Partial<UnlinkedActivityRow> = {}): UnlinkedActivityRow {
  return { id: 'activity-1', txHash: '0xTx', walletAddress: '0xWallet', ...overrides }
}

function makeLookup(map: Record<string, string | null>): CanonicalLedgerEventLookup {
  return { findSwapDebitLedgerEventId: (txHash) => Promise.resolve(map[txHash] ?? null) }
}

function makeUpdateRepo() {
  const linked: Array<{ activityId: string; ledgerEventId: string }> = []
  const repo: ActivityLinkUpdateRepository = {
    linkLedgerEvent: (activityId, ledgerEventId) => { linked.push({ activityId, ledgerEventId }); return Promise.resolve() },
  }
  return { repo, linked }
}

Deno.test('a swap Activity row with an existing SWAP_DEBIT ledger event is linked', async () => {
  const lookup = makeLookup({ '0xTx': 'ledger-abc' })
  const { repo, linked } = makeUpdateRepo()
  const results = await sweepUnlinkedActivityRows([row()], lookup, repo)
  assertEquals(results, [{ activityId: 'activity-1', outcome: 'linked', ledgerEventId: 'ledger-abc' }])
  assertEquals(linked, [{ activityId: 'activity-1', ledgerEventId: 'ledger-abc' }])
})

Deno.test('no ledger event yet (ledger-interpret has not run for this tx) -> left unlinked, never fabricated', async () => {
  const lookup = makeLookup({})
  const { repo, linked } = makeUpdateRepo()
  const results = await sweepUnlinkedActivityRows([row()], lookup, repo)
  assertEquals(results, [{ activityId: 'activity-1', outcome: 'no_ledger_event_yet' }])
  assertEquals(linked.length, 0)
})

Deno.test('CRITICAL: never creates a ledger event -- only ever calls the read-only lookup and the link write', async () => {
  let lookupCalls = 0
  const lookup: CanonicalLedgerEventLookup = { findSwapDebitLedgerEventId: () => { lookupCalls++; return Promise.resolve('ledger-xyz') } }
  const { repo, linked } = makeUpdateRepo()
  await sweepUnlinkedActivityRows([row()], lookup, repo)
  assertEquals(lookupCalls, 1)
  assertEquals(linked.length, 1)
})

Deno.test('idempotent: sweeping the same already-resolvable row twice calls link twice at the pure layer -- the live repo WHERE-guard (ledger_event_id IS NULL) is the real backstop, same documented pattern as swapBroadcastRecovery/attemptReaper', async () => {
  const lookup = makeLookup({ '0xTx': 'ledger-abc' })
  const { repo, linked } = makeUpdateRepo()
  await sweepUnlinkedActivityRows([row()], lookup, repo)
  await sweepUnlinkedActivityRows([row()], lookup, repo)
  assertEquals(linked.length, 2, 'pure layer calls once per invocation; the live repo WHERE-guard is the actual idempotency backstop')
})

Deno.test('one row failing does not stop the rest of the batch', async () => {
  const lookup: CanonicalLedgerEventLookup = {
    findSwapDebitLedgerEventId: (txHash) => txHash === '0xBad' ? Promise.reject(new Error('boom')) : Promise.resolve('ledger-ok'),
  }
  const { repo, linked } = makeUpdateRepo()
  const results = await sweepUnlinkedActivityRows(
    [row({ id: 'bad', txHash: '0xBad' }), row({ id: 'good', txHash: '0xGood' })], lookup, repo,
  )
  assertEquals(results.find(r => r.activityId === 'bad')?.outcome, 'no_ledger_event_yet')
  assertEquals(results.find(r => r.activityId === 'good')?.outcome, 'linked')
  assertEquals(linked, [{ activityId: 'good', ledgerEventId: 'ledger-ok' }])
})

Deno.test('empty worklist -> no-op', async () => {
  const lookup = makeLookup({})
  const { repo, linked } = makeUpdateRepo()
  const results = await sweepUnlinkedActivityRows([], lookup, repo)
  assertEquals(results, [])
  assertEquals(linked.length, 0)
})
