# BulkPay Activity Safety Fix (P0 mitigation)

Status: **Implemented and verified.** Narrow, targeted mitigation only — Activity is not
redesigned, Ledger is not built, no other feature (Pay/Swap/P2P/Claim) or the
indexer/`activity-consumer` was touched.

---

## The exact old race

Traced in `docs/ACTIVITY_WRITER_AUDIT.md` §2/§3. `BulkPayoutPage.tsx` calls
`Activity.bulkReceived()` once per recipient, directly from the **payer's own browser**,
immediately after the Multicall3 transaction is perceived to succeed — with **no confirmation
wait and no existence check of any kind** before this fix.

Independently, two server-side recovery paths (`claim-recovery-scan`, invoked on tab
focus/mount; `deposit-scan-all` reconcile, cron every 10 min) can detect the exact same
recipient's incoming Transfer log and credit it as a plain `receive` row
(`tx_hash = recv_<hash>`) — because at the log level, a BulkPay recipient's leg is
indistinguishable from a genuine external deposit, exactly the same ambiguity already proven to
cause a real duplicate for Swap (the traced EURC case).

Because `bulkReceived()` stores the **plain** hash (`activity_type: 'bulk'`) while the recovery
path stores the **`recv_`-prefixed** hash (`activity_type: 'receive'`), the existing
`UNIQUE(tx_hash, wallet_address)` constraint — the only dedup mechanism `bulkReceived()` had —
provides **zero** protection: the two rows use different key strings by design, so the database
itself cannot see them as duplicates of each other.

## The exact fix

Two changes, both confined to `src/lib/ActivityService.ts` — **one production file**:

1. **New function `hasAnyActivityForTx(walletAddress, txHash)`.** A single (non-polling)
   PostgREST request that checks for **any** existing `activity` row for that wallet under
   **either** hash form in one query:
   `tx_hash=in.(<plainHash>,recv_<plainHash>)`. This directly satisfies "must not rely only on
   `tx_hash + wallet_address`" — it explicitly checks both identity forms the two competing
   writer families use.

2. **`Activity.bulkReceived()` now calls this check first.** If a matching row already exists
   (under either form, from either family of writer), the call is skipped — logged, and
   reported back to the caller as `true` (success), not a failure, since the recipient's history
   already correctly reflects the transaction, just under a different `activity_type`. If
   nothing exists yet, it proceeds to `saveActivity()` exactly as before.

```ts
bulkReceived: async (p: {...}): Promise<boolean> => {
  if (await hasAnyActivityForTx(p.walletAddress, p.txHash)) {
    console.log('[ActivityService] bulkReceived skipped — activity already exists...')
    return true
  }
  return saveActivity({ ...unchanged... })
}
```

**`BulkPayoutPage.tsx` required zero changes** — its call site already does
`Activity.bulkReceived({...}).catch(() => {})`, which is fully compatible with the new `async`
signature and its `Promise<boolean>` return type.

### Why a single check, not a copy of claim-recovery-scan's 3-second poll (requirement 5)

`claim-recovery-scan`'s poll-with-delay exists because *it* is racing an approximately-
synchronous client write it has no way to wait on directly, invoked independently on tab focus —
polling gives that in-flight client write time to land before conceding. `bulkReceived()` is the
opposite situation: it *is* the client write, called at the moment the payer's own flow is ready
to record it. There is nothing on this side of the race to wait for — a single immediate check
against whatever already exists at that instant is the correct primitive here, not a weaker
version of the server-side pattern. Blindly copying a multi-second poll would have added real,
per-recipient UX latency (requirement 6: preserve current UX) for no corresponding benefit.

## Why a duplicate cannot occur under the tested race (and where the honest limit is)

**Fully closed by this fix:** the case actually traced (`docs/ACTIVITY_WRITER_AUDIT.md`'s EURC
incident, and its BulkPay structural analogue) — a recovery worker credits the recipient
*before* `bulkReceived()` runs. The existence check finds that row (under either hash form) and
skips. Verified by tests #3/#4 (`ActivityService.bulkReceivedGuard.test.ts`).

**Not fully closed — disclosed, not hidden (requirement 7 acknowledges this fix is temporary):**
a true atomic guarantee would require either unifying the `receive`/`bulk` identity scheme or an
atomic check-and-insert (a database function), neither of which is in scope for a narrow
mitigation. The residual window is: both the guard's check *and* a competing recovery worker's
own write happen to interleave within the same few-hundred-millisecond gap between this check
and `bulkReceived()`'s own insert completing. In that specific (narrow, timing-dependent)
scenario, both could still write. Test #5 demonstrates this honestly — both writes are allowed
to proceed when both checks race clean — **and verifies the actual backstop that then applies**:
`saveActivity()`'s existing `onConflict: tx_hash, wallet_address` upsert, which the payer's
`bulk`-type write always carries (a `bulkTxHash` is always present). That backstop prevents a
literal *same-type* duplicate but — exactly as documented in the audit — does **not** prevent
the cross-type case if both writes are for different `tx_hash` string forms. So: this fix makes
the **already-observed, most-likely failure mode** (recovery-worker-wins) impossible, and
narrows the remaining race to a much smaller, harder-to-hit timing window, without claiming to
eliminate it entirely. Full elimination is explicitly deferred to the Ledger migration, per your
instructions.

## Limitations

1. **Residual sub-second race window**, described above — not fully closed, by design, pending
   Ledger migration.
2. **Same-recipient, multiple line items, one transaction**: if a payer lists the same wallet
   twice in one BulkPay batch (two separate amounts, same `bulkTxHash`), the second
   `bulkReceived()` call is skipped by this guard — **but this is a pre-existing limitation, not
   introduced by this fix.** `saveActivity()`'s own `onConflict: tx_hash, wallet_address` upsert
   already collapsed this exact case into a no-op before this change, since `bulkReceived()`
   carries no `log_index` or other per-line-item identity to distinguish two legs to the same
   wallet. Verified explicitly by test #7, which documents (not silently accepts) this as a
   known gap — true per-line-item fidelity requires the log_index-aware identity model the
   Phase 3 `chain_events` fix already established at the indexer layer, ported up to the Activity/
   Ledger layer in a future phase.
3. This fix does **not** address the underlying architectural issue (the payer's browser being
   the sole, unconfirmed writer of another user's financial history) — it only closes the
   duplicate-row symptom. The real fix is the Ledger migration's confirmed-only projection
   model, per the roadmap.

## Compatibility with the Phase 3 chain_events identity fix (requirement 9)

Confirmed by construction: `src/lib/ActivityService.ts` contains zero references to
`chain_events`, `blockchain-indexer`, `scanner.ts`, or `activity-consumer` — this fix operates
entirely within the client-side Activity-writing layer and cannot interact with the indexer's
identity/dedup logic in any way. The two areas are fully independent.

## Tests

New file: `src/lib/ActivityService.bulkReceivedGuard.test.ts`, 12 tests, all passing:

| # | Test | Verifies |
|---|---|---|
| — | `hasAnyActivityForTx` checks both hash forms in one request | requirement 3 |
| — | returns true/false correctly | core logic |
| — | fails open on network error / non-ok response | never blocks a legitimate credit on a transient failure |
| 1 | normal BulkPay recipient | unaffected happy path |
| 2 | repeated `bulkReceived()` | idempotent re-invocation |
| 3 | recovery receive already exists | **the traced race, closed** |
| 4 | bulk Activity already exists | duplicate invocation guard |
| 5 | concurrent invocation | honest demonstration of the residual window + confirms the DB-level backstop still applies |
| 6 | multiple recipients, same Multicall3 tx | no cross-recipient interference — each wallet checked independently |
| 7 | same recipient, multiple line items | pre-existing limitation, explicitly documented, not silently changed |

## Test results (actually run)

- `npx vitest run src/lib/ActivityService.bulkReceivedGuard.test.ts`: **12/12 passed**.
- `npx vitest run` (full suite): **192/192 passed** (180 pre-existing + 12 new, zero
  regressions).
- `npm run typecheck`: clean.
- `npm run typecheck:server`: clean (unaffected — this fix never touches `server/`).

## Files changed

- `src/lib/ActivityService.ts` — added `hasAnyActivityForTx()`, updated `Activity.bulkReceived()`
  to call it first. **1 production file.**
- `src/lib/ActivityService.bulkReceivedGuard.test.ts` — new, 12 tests.
- `docs/BULKPAY_ACTIVITY_SAFETY_FIX.md` — this file.

**`src/features/bulkpayout/BulkPayoutPage.tsx` was not modified** — its existing call site is
already compatible with the new guarded, async `bulkReceived()`.

No other production file was touched. No indexer, `activity-consumer`, Pay, Swap, P2P, or Claim
code was modified. No Activity row was deleted. No Ledger work was started.

---

**Stopping here per your instructions** — not proceeding to the claim-recovery-scan generic-
receive audit/fix, not starting Ledger.
