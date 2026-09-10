# BulkPay Indexer Forensic Audit

Status: read-only investigation, complete. No code modified, no migration, no deployment, no
Ledger/Activity/balance write of any kind.

**Access limitation, disclosed up front, not glossed over**: I could not fetch this transaction's
raw on-chain receipt or logs directly. `web_fetch` in this environment only permits URLs that
already appear in a prior search/fetch result, and this is a private testnet transaction — not
indexed by any search engine, so no query surfaced a fetchable link to `testnet.arcscan.app`'s
transaction API for this specific hash. I have no allow-listed RPC endpoint or authenticated Arc
RPC key available in this environment either. This means item 3 ("every Transfer log") below is
reconstructed from the best available evidence — the one real `chain_events` row, the real
`activity` rows for both recipients, and the actual scanner source — not read directly from the
chain. Where this matters, it's called out explicitly rather than presented as if I had read the
raw receipt.

Despite that limitation, the root cause was established with high confidence through a different,
equally rigorous method: direct proof from the `users` table, combined with the exact,
already-existing filter logic in `scanner.ts`/`index.ts`. This method doesn't require the raw
logs at all — the filter's behavior is deterministic given only the recipient's registration
status, which is directly queryable.

---

## 1. Exact tx hash

`0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c`, chain `arc`, block
`58592562`.

## 2. Full transaction receipt summary

Not directly readable in this environment (see access limitation above). Reconstructed from
real, corroborating evidence instead:

- The payer's own `activity` row (`activity_type: 'bulk'`, `direction: 'sent'`,
  `wallet_address: 0x05d00ab7…`) records `amount: 24.000000 USDC` total, with
  `metadata.recipients` explicitly listing two entries — `{label: "suvarna.arc", amount: 10,
  txHash: "0xb179c4f0…"}` and `{label: "0x9171d4f0d376019297d9598c33cdc6e92413f730.arc", amount:
  14, txHash: "0xb179c4f0…"}` — both referencing the same `tx_hash`, confirming this was one
  Multicall3 batch transaction paying two recipients, matching your own confirmation that
  Multicall3 produces exactly one hash for all recipients.
- This confirms the payer's own client observed both legs succeed on-chain —
  `BulkPayoutPage.tsx` only calls `Activity.bulk()`/`Activity.bulkReceived()` after the Multicall3
  transaction's receipt is read and its per-call success is confirmed (per the file's own logic,
  read in a prior session's audit) — so the total (24 USDC, two legs) is real, on-chain
  corroborated evidence, not merely a client-side assumption.
- A telling detail: recipient A's label is `"suvarna.arc"` (a real registered username).
  Recipient B's label is `"0x9171d4f0d376019297d9598c33cdc6e92413f730.arc"` — the raw wallet
  address with a `.arc` suffix appended, the client UI's fallback display for an address it does
  not recognize as a registered contact/user. This is a strong, independent corroborating signal
  pointing at the same conclusion reached in §7 below, visible before that conclusion was even
  confirmed.

## 3. Every Transfer log

Only one is directly confirmed (from `chain_events`, real data):

| log_index | from | to | amount | contract |
|---|---|---|---|---|
| 6 | `0xca11bde05977b3631167028862be2a173976ca11` (Multicall3) | `0xebe52519a38e857a744e65d01f23137e22fb784b` (suvarna.arc) | 10 USDC | `0xffffffffffffffffffffffffffffffffffffffffe` (native-transfer-log wrapper) |

The second leg's log (Multicall3 → `0x9171d4f0d376019297d9598c33cdc6e92413f730`, 14 USDC) is not
present in any table this environment can query, and — per the access limitation above — its raw
on-chain log entry itself could not be independently read. Its existence is inferred with high
confidence from the payer's own activity record and Multicall3's atomic-batch semantics (a
partial-success Multicall3 call would not match the payer's own recorded total, and would
represent a much more serious on-chain problem than an indexer coverage gap) — but this document
does not claim to have read it directly, and says so.

## 4. Expected chain_events

Two rows, both `event_type: 'deposit_detected'`, `via: 'native-transfer-log'`,
`contract_address: 0xffff…fffe`, same `tx_hash`, same `block_number`, distinct `log_index`
values (log_index 6 for recipient A, and a second, currently-unknown log_index for recipient B) —
per the exact identity model already established and validated in Phase 3
(`docs/LEDGER_RAW_IDENTITY_FIX.md`, `docs/PHASE_3_FIXES_APPLIED.md`).

## 5. Actual chain_events

One row only — id 125, exactly matching log_index 6 / recipient A above. Confirmed by direct
query: zero `chain_events` rows exist, ever, for `wallet_address =
'0x9171d4f0d376019297d9598c33cdc6e92413f730'` (recipient B) — not just for this transaction, for
this wallet's entire history in this database.

## 6. Missing event

Recipient B's leg — Multicall3 → `0x9171d4f0d376019297d9598c33cdc6e92413f730`, 14 USDC, same
`tx_hash`, same block.

## 7. Exact reason it was dropped — proven, not guessed

Recipient B is not a registered MeshPort user. Direct query:

```sql
select wallet_address, username from public.users
where wallet_address in ('0x9171d4f0d376019297d9598c33cdc6e92413f730',
                          '0xebe52519a38e857a744e65d01f23137e22fb784b');
```
returned exactly one row — `0xebe52519a38e857a744e65d01f23137e22fb784b` (`username: suvarna`,
recipient A). `0x9171d4f0d376019297d9598c33cdc6e92413f730` (recipient B) does not appear in
`users` at all.

`blockchain-indexer/index.ts`'s `loadKnownWallets()` (lines 68-83) builds the entire
`knownWallets` set exclusively from `users.wallet_address`:

```ts
const { data: users, error } = await supabase
  .from('users')
  .select('wallet_address')
  .not('wallet_address', 'is', null)
```

`scanner.ts`'s native-transfer-log scan loop (the exact path that produced recipient A's row,
confirmed by `via: 'native-transfer-log'` in its metadata) filters, at line 402:

```ts
if (!wallet || !knownWallets.has(wallet)) continue
```

Since `0x9171d4f0…` was never in `users`, it was never in `knownWallets`, so this line correctly,
deterministically skipped the log for recipient B — exactly matching the observed symptom,
independent of anything about the raw log's content, ordering, or parsing. This is not a
plausible explanation among several — it is a direct, provable consequence of the recipient's
registration status combined with code that is already known and unchanged.

This directly answers the critical question: Recipient A produced a `chain_events` row because
they are a registered user (`knownWallets.has(wallet)` = true). Recipient B did not, purely
because they are not registered (`knownWallets.has(wallet)` = false) — nothing else about the log
(its `log_index`, its parsing, its ordering, deduplication, or the Phase 3 identity fix) is
implicated at all.

## 8. Exact source file/function

`supabase/functions/blockchain-indexer/index.ts`, `loadKnownWallets()` (lines 68-83) — the data
source of the filter. `supabase/functions/blockchain-indexer/scanner.ts`, line 402
(native-transfer-log branch) — the exact filter that skipped this specific log. (Line 476, the
ERC-20 branch's identical filter, is not implicated here since this was a native-USDC transfer,
not an ERC-20 one — noted for completeness since both branches share the identical pattern.)

## 9. Exact code path

```
Multicall3.aggregate3Value(...)
  -> internal call, target.call{value: 14 USDC}("") to 0x9171d4f0...
  -> 0xffff...fffe wrapper contract emits Transfer(Multicall3, 0x9171d4f0..., 14e18)
  -> blockchain-indexer's native-transfer-log scan (scanner.ts, eth_getLogs on 0xffff...fffe)
  -> log decoded: wallet = 0x9171d4f0... (topics[2])
  -> if (!wallet || !knownWallets.has(wallet)) continue   <- DROPPED HERE, line 402
  -> (recipient A's log, wallet = 0xebe52519..., passes this same check since knownWallets.has()
     is true for them -- produces chain_events id 125)
```

## 10. Whether the Phase 3 log-index identity fix is involved

No. The Phase 3 fix (`ledger_events_raw_movement_key` / `chain_events_dedup_idx`) governs what
happens to an event once it reaches the point of being inserted — ensuring two distinct logs for
the same tx_hash get distinct identities instead of colliding. Recipient B's log never reached
that point at all; it was filtered out several steps earlier, before any event object was even
constructed. The identity fix is unrelated to this gap and is not implicated in any way.

## 11. Whether Activity is masking the problem

Yes, in the sense that Activity is fully correct and complete while `chain_events` is not — but
"masking" undersells what's actually happening: `BulkPayoutPage.tsx`'s client-side
`Activity.bulkReceived()` write is the only path that recorded recipient B's payment at all,
anywhere in this system. Without it, this 14 USDC payment would have no record whatsoever — not
in Activity, not in chain_events, nowhere — despite genuinely happening on-chain (per §2's
corroborating evidence). This is precisely the architectural risk already named in
`docs/ACTIVITY_WRITER_AUDIT.md` (writer #8: "the payer's browser being the sole, unconfirmed
writer of another user's financial history") — now concretely demonstrated: it is not just an
unconfirmed/racy writer, for a non-registered recipient it is the only writer, full stop.

## 12. Financial impact

None to the recipient or payer's own record — Activity correctly shows both legs, the correct
amounts, and the correct total (24 USDC = 10 + 14). No money was misrepresented to either party
using the app today. The impact is entirely on any future system that treats `chain_events`/a
Ledger built from it as authoritative or complete: such a system would currently and permanently
be blind to any BulkPay (or, by the same logic, ordinary Pay) payment to a wallet that isn't a
registered MeshPort user — not a transient gap that self-heals, a structural one, for as long as
`knownWallets` is scoped to `users.wallet_address` only.

## 13. Recommended minimal fix

Important reframing, per the actual root cause found: this is not a scanner defect (no parsing
bug, no dedup bug, no log-index bug) — it is the intentional, already-documented `knownWallets`
scope decision (`loadKnownWallets`'s own header comment: "Every wallet address the indexer
watches... Source is `users.wallet_address`") now shown to also apply to BulkPay recipients, not
previously confirmed for this specific feature. There may be no "bug" to fix in the traditional
sense — there is a scope decision to make, which is a product/architecture choice, not a
code-correctness one:

- **Option A (no code change)**: accept that `chain_events`/the Ledger will never cover payments
  to non-registered wallets, for any feature, and treat Activity as the necessary source for
  those cases indefinitely (consistent with how external-sender deposits already work today).
- **Option B**: widen `knownWallets` (or add a separate, narrower "watch this specific recipient
  for this specific pending BulkPay batch" mechanism) so a BulkPay's recipients are monitored
  even if unregistered — a real scanner change, meaningfully larger in scope than a simple bug
  fix, and one that raises its own questions (watching arbitrary addresses indefinitely vs. only
  transiently around a known BulkPay transaction; RPC cost implications).
- **Option C**: keep `chain_events` scoped as today, but have the Ledger Interpreter explicitly
  treat "BulkPay recipient not independently confirmable on-chain" as its own first-class,
  honestly-reported state (similar to today's `not_applicable`/`SWAP_NOT_COMPARABLE` outcomes)
  rather than silently under-reporting.

Not chosen or implemented here — this is a decision for you to make before any BulkPay Ledger
work begins, exactly as this investigation was scoped to surface, not resolve.

## 14. Regression test required (once a fix direction is chosen)

Whichever option is chosen, the regression test that matters is the same: a real or realistic
BulkPay-shaped batch with at least one registered and at least one unregistered recipient, run
through the indexer (or its test harness), asserting the registered recipient produces a
`chain_events` row and — depending on the chosen option — either asserting the unregistered
recipient correctly produces none (Option A/C, documenting current behavior) or correctly does
produce one (Option B, proving the widened coverage). `scanner.test.ts`'s existing BulkPay-shaped
multi-recipient test (`docs/PHASE_3_FIXES_APPLIED.md`) already proves log-index independence for
multiple *registered* recipients — it does not currently cover a mixed registered/unregistered
batch, which is the exact gap this specific investigation found. Not written in this pass, per
your explicit "do not implement the fix yet" instruction.

---

## Summary

Root cause, proven: recipient B (`0x9171d4f0d376019297d9598c33cdc6e92413f730`) is not a
registered MeshPort user. `blockchain-indexer`'s `knownWallets` filter — already existing,
unchanged, and correctly documented since its introduction — only ever watches registered
wallets. This is not a scanner bug, not a Phase 3 identity-fix issue, not a log-parsing or
deduplication defect. It is the same, already-known "external recipient" scope limitation
already documented for ordinary Pay (`docs/PHASE_3_REAL_STATE_AUDIT.md`'s `0x70e3fb28…` case),
now confirmed to apply identically to BulkPay.

What remains genuinely unverified: the raw on-chain log for recipient B's leg itself, due to this
environment's access limitations — disclosed explicitly, not glossed over. The conclusion above
does not depend on reading it, since the filter's behavior is fully determined by the recipient's
registration status regardless of what the raw log contains.

No code was modified. No fix was implemented. Stopping here for your review of the proposed
options in §13, per your explicit instruction not to touch `scanner.ts` until the root cause is
reviewed. Not starting CCTP, not modifying Ledger Core, not applying migrations, not deploying.
