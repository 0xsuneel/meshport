# Claim-Recovery / Generic-Receive Audit

Status: **audit only**. No production code was modified — `claim-recovery-scan`, the indexer,
and `ActivityService` are all unchanged. Every claim below is quoted or cited to an exact line
in `supabase/functions/claim-recovery-scan/index.ts` (941 lines, read in full for this audit) —
nothing here is inferred.

---

## 1. Current flow

`claim-recovery-scan` is a single `Deno.serve` handler (line 602), invoked **per-wallet, from the
client, on app mount and tab refocus** (confirmed: `grep`'d for its call site — invoked from
`AppLayout.tsx`, not cron). One invocation does, in this exact order:

1. Scans `ARC_USDC_CONTRACT` (`0x3600…0000`, the ERC-20 wrapper view of native USDC) for every
   `Transfer` log to the wallet (line 620-623).
2. For each log, branches on whether the sender is `address(0)` (`isMint`, line 630):
   - **Not a mint** (line 641-663): treated as a generic external transfer — the faucet-drop /
     ordinary-payment case.
   - **Is a mint, but resolves to NOT actually being a CCTP mint** (line 691-698, `!isCctpMint`):
     also treated as a generic external transfer — the code's own comment (679-690) explains
     this was itself a bug fix, so a real external deposit with a coincidentally-similar amount
     to an unrelated claim wouldn't get silently absorbed into completing that claim.
   - **Is a genuine CCTP mint** (line 700 onward, not fully re-quoted here — out of this audit's
     scope, this is the actual claim-recovery logic): matched against `claims` by burn tx hash /
     amount / source chain, and recorded via `recordClaimActivity` (a different function, writes
     `activity_type: 'claim'`, not relevant to the receive/swap collision).
3. Scans the EURC and cirBTC contracts (lines 848-902) for `Transfer` logs to the wallet — no
   mint branch at all here (line 871: "no mint case for these tokens; skip defensively"),
   unconditionally treated as a generic external transfer.
4. Scans native USDC via the Blockscout explorer API (lines 905-933) for plain top-level value
   transfers to the wallet — same treatment.

**Every one of steps 2 (non-mint case), 3, and 4** funnels into the same two functions:
`existsActivityForTxHash` (the TOCTOU guard, line 514-527) and `recordExternalReceive` (the
actual write, line 535-554).

## 2. All Activity writers in this file

Only two, both already covered in `docs/ACTIVITY_WRITER_AUDIT.md` (writers #13/#14) — restated
here with exact line numbers for this audit's precision requirement:

| Function | Line | Writes | Purpose |
|---|---|---|---|
| `recordExternalReceive` | 535 | `activity_type: 'receive'`, `tx_hash: recv_<hash>` | **Generic receive** — called from 4 separate call sites (lines 660, 695, 896, 928) |
| `recordClaimActivity` | not shown above (outside this audit's scope — genuine claim path) | `activity_type: 'claim'` | Claim-specific, not implicated in the swap/receive collision |
| `reconcileFailedClaimActivity` | 460s (context around line 484) | `UPDATE` on an existing claim row | Claim-specific reconciliation, not a fresh insert, not implicated |

## 3. Claim detection logic (for contrast with §4)

A mint is matched to a real claim only via `resolveSourceChain` (decodes the mint's own
`MessageReceived` log from Circle's `MessageTransmitter` contract, line 677) plus a lookup
against the `claims` table by burn tx hash/amount/chain (logic beyond line 700, not requoted —
irrelevant to this audit's question, included only to show it's a **distinct, narrower, better-
identified** code path than the generic-receive branches).

## 4. Generic receive detection logic — exactly why it exists and what it accepts

**Why `claim-recovery-scan` creates generic RECEIVE Activity at all**: per the code's own header
comment (lines 7-16, quoted): *"A claim only ever gets durably tracked from the moment its burn
transaction CONFIRMS... If the app is closed in the narrow window after approval but before the
burn confirms, the burn can still go through... there's no `claims` row... but the money is
real."* This justifies the **claim-recovery** logic. It does **not** justify the generic-receive
branches (§1 steps 2 non-mint / 3 / 4) at all — those exist for a different, undocumented-at-the-
top reason, made explicit only in inline comments: line 638 calls it *"the faucet-drop / generic
external-deposit case"*, and line 905's comment says the native-USDC branch exists because *"the
ERC20-log scan above structurally can't [see it]"* — i.e., **coverage completeness for
ordinary payments**, not claim recovery. **The function does two genuinely different jobs under
one name.**

**Which events it considers eligible**: any `Transfer` log (or, for the native branch, any
plain top-level value transfer) landing in the scanned wallet, from any sender that (a) isn't
the wallet itself (self-transfer excluded) and (b) doesn't already have a matching `activity`
row under either hash form. **No restriction to claim-specific senders, contracts, or context.**

**How it identifies a claim** vs. **how it distinguishes CCTP claim / normal receive / swap
output / UB destination / P2P release / BulkPay**: it does not distinguish most of these at all.
Precisely:

| Category | Distinguished how? |
|---|---|
| CCTP claim | Yes — `from = address(0)` **and** a matching `MessageReceived` log resolves it (line 677, `isCctpMint`) |
| Normal (external, e.g. faucet/exchange) receive | The **default** — anything not a mint and not already recorded |
| Swap output | **Not distinguished at the event level at all.** Caught only indirectly, after the fact, by `existsActivityForTxHash` finding a `swap`-type row that already exists under the plain hash — i.e. it relies entirely on a *race it might lose*, not on any structural signal that the transfer came from a swap |
| UB destination | **Not distinguished.** No UB-specific logic anywhere in this file. If a UB spend's destination leg lands as a plain Transfer, it would be treated identically to a generic receive, protected only by the same after-the-fact `existsActivityForTxHash` check if a UB-specific Activity row happens to already exist by the time this runs |
| P2P release | **Not distinguished**, same as UB — relies entirely on `existsActivityForTxHash` finding a `p2p_purchase`/similar row first |
| BulkPay | **Not distinguished**, same reasoning — relies on `existsActivityForTxHash` finding a `bulk`-type row first (this is the exact mechanism the BulkPay safety fix's own residual-race disclosure already flagged as still-open on the BulkPay side) |

**Does it have access to transaction/event/log metadata that could distinguish these?** It has
the full log object (`log.topics`, `log.data`, `log.transactionHash`) and could in principle
check `internalSenderOf`-style sender-contract matching the same way `compare.ts`'s Fix C does —
**but does not**. The only exclusion logic present is the mint-address(0) check. It never checks
whether the sender is a known Kit Adapter/swap-router contract, a Multicall3 contract, or a P2P
escrow contract — all addresses that `compare.ts`'s `KNOWN_INTERNAL_CONTRACTS` set (in a
completely different file) already maintains for exactly this purpose. **The data to do this
properly is available; the code simply doesn't use it.**

**Can it restrict itself to claim-specific recovery?** Structurally yes — the claim-specific
logic (mint detection + `resolveSourceChain` + `claims` table matching) is already a self-
contained code path (line 665-829) that does not depend on the three generic-receive branches
at all. Removing the non-mint/EURC/cirBTC/native-explorer branches would not break the claim-
matching logic — they are additively bolted on, not intertwined.

## 5. Known EURC trace — exact, not inferred

Transaction: `0xed2868e6d034e65d2a0063816906dd2d69604102ce9a7a71a08fbf78c7492312`.

- **Exact event/log**: an EURC (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`) `Transfer` log to
  wallet `0x05d00ab7…64ee126e0`, amount `0.881746` (6 decimals). This is the swap's own output
  leg — the router sending the purchased EURC to the user.
- **Exact claim-recovery query**: `fetchLogsBounded({ address: token.contract, topics:
  [TRANSFER_TOPIC0, null, recipientTopic] }, PAYMENT_SCAN_WINDOW_BLOCKS)` for `token = EURC`,
  called from the `otherTokenResults` block (line 852-859), inside the loop starting line 861.
- **Exact function that wrote RECEIVE**: `recordExternalReceive` (line 900), called from inside
  the EURC/cirBTC loop (line 861-903).
- **Exact classification logic**: line 871 (`if (fromTopic.toLowerCase() === MINT_FROM_TOPIC...)
  continue // no mint case for these tokens; skip defensively`) — not a mint, so it falls straight
  through to the generic-transfer path with **no further classification of what kind of transfer
  it is**.
- **Exact reason it was considered a generic receive**: there is no "swap output" concept
  anywhere in this code path. Line 885-894's comment states the intended safeguard directly: *"A
  swap's output-token leg... emits the exact same on-chain Transfer event this scan is watching
  for... That swap is already recorded client-side as its own 'swap' activity row... Any
  activity row already existing under this exact tx hash for this wallet — regardless of type —
  means it's already been accounted for."* — i.e. the ONLY thing standing between this branch
  and every swap output ever being misclassified is `existsActivityForTxHash`'s timing-dependent
  check at line 896.
- **Exact data available at decision time**: `log.topics[1]` (the sender/router address —
  present, but never checked against a known-swap-router list), `log.data` (amount),
  `log.transactionHash`. Everything needed to apply a `KNOWN_INTERNAL_CONTRACTS`-style exclusion
  (as `compare.ts` already does, in a different file, for the exact same purpose) is present in
  the log object at this exact point — it is simply not used here.
- **Why the guard lost this specific race**: already established in
  `docs/ACTIVITY_WRITER_AUDIT.md` §2 Q4 — the `receive` row landed at `12:44:01.606`, the
  `swap` row at `12:44:03.198`, a ~1.6s gap. `existsActivityForTxHash`'s 3-check/~3s-total
  window (line 515: `DELAYS_MS = [0, 1200, 1800]`) evidently began early enough, and the swap
  write landed late enough, that all 3 checks completed before the swap row existed.

## 6. Compare with indexer — does the canonical indexer already detect the same event?

**Yes, for all three generic-receive branches, confirmed by direct comparison of contract
addresses across both files:**

| `claim-recovery-scan` branch | Watches | `blockchain-indexer`/`scanner.ts` watches | Same event? |
|---|---|---|---|
| EURC/cirBTC (lines 848-902) | `0x89B50855…` (EURC), `0xf0C4a4CE…` (cirBTC) | **Identical addresses** (`chains.ts` `tokens` array) | **Yes — literally the same contract, same topic0, same log.** This is a direct, exact duplicate detector, not just an overlapping one. |
| USDC-wrapper non-mint (lines 641-663) | `0x3600…0000` | `0xffffffffffffffffffffffffffffffffffffffffe` (a *different* contract) | Same underlying transfers, different representation — `chains.ts`'s own comment (quoted in the Phase 3 indexer audit) documents a 3,000-block empirical study showing near-total overlap between the two views of the same native-USDC movement. **Functionally the same event, structurally a different log.** |
| Native-via-explorer (lines 905-933) | Blockscout REST API, plain value transfers | Direct RPC `eth_getBlockByNumber` native block scan | Same underlying transfers, different detection mechanism (indexed API vs. raw RPC). **Same event class.** |

**Conclusion**: `claim-recovery-scan`'s generic-receive branches are, today, **duplicate
detection of coverage the canonical indexer (now live and healthy — confirmed by the Phase 3
production observation) already provides**, not a unique capability. This was not always true —
before `blockchain-indexer`/`activity-consumer` existed (deployed 2026-08-08), these branches
were the *only* fast, on-focus detection path for exactly this class of event. The redundancy is
a consequence of the indexer's more recent arrival, not a design error in `claim-recovery-scan`
at the time it was written.

## 7. Recovery gaps — what would be lost if generic-receive were removed

**Speed, specifically**: `claim-recovery-scan` runs synchronously on tab focus — sub-second to
a few seconds of actual scan time. `activity-consumer` runs on a 1-minute cron with a 30-second
settle delay, and depends on `blockchain-indexer`'s own 2-minute cron having already picked up
the block. Worst case, indexer-driven detection can take **up to ~3-4 minutes** end to end
(measured in the Phase 3 observation window), versus `claim-recovery-scan`'s near-instant
on-focus detection. Removing the generic-receive branches would make a user who deposits funds
and immediately reopens the app see their balance *before* they see the corresponding Activity
row — a real, if minor, UX regression, not a financial-safety one.

**A genuine recovery gap would exist only if the indexer/`activity-consumer` pipeline is down,
disabled, or lagging significantly.** Given `activity-consumer` is a much younger, less
battle-tested system than `claim-recovery-scan` (deployed 2026-08-08 vs. earlier), removing the
redundancy entirely today would mean trusting the newer system as the *sole* detector for these
event classes — a real risk shift worth naming explicitly, not assumed away.

## 8. Which existing worker already covers generic receive detection

**`blockchain-indexer` → `chain_events` → `activity-consumer`**, confirmed live and healthy
(Phase 3 production observation: zero errors, correctly credited two real deposits during the
observed window, one of which was on the EURC contract specifically). This is the system §6
shows already covers everything the three generic-receive branches in `claim-recovery-scan`
attempt.

---

## 9. Race conditions (restated precisely for this file)

Exactly one, already traced in full in §5: `existsActivityForTxHash`'s timing-dependent guard
(3 checks over ~3s) can lose against a client-side write (Swap, and structurally also BulkPay/
P2P/UB, per §4's table) that lands later than that window. This is the **same class** of race
the BulkPay safety fix closed for the *recovery-worker-wins* direction on the BulkPay side — but
`claim-recovery-scan`'s own guard, examined here, is the *other* direction of the same problem:
it's the recovery-worker-side code, and its polling window is simply too short relative to real
client-write latency in at least one observed case.

## 10. Risk analysis: P0 / P1 / P2

**P0 — none newly identified in this audit.** The known EURC race is already documented
(`docs/ACTIVITY_WRITER_AUDIT.md`); this audit adds precision, not a new severity finding.

**P1:**
- The generic-receive branches' complete lack of sender-based classification (§4) means **any**
  future feature whose output lands as a plain Transfer (UB, P2P release, a not-yet-built
  feature) is exposed to the same race, protected only by the timing-dependent guard — not
  structurally prevented, only usually-avoided.
- Could removing generic receive cause missed funds? **No, not today** — §6/§8 establish the
  indexer path already covers the same events. **This answer would flip to "possibly" the
  moment the indexer/`activity-consumer` pipeline has an outage**, since that redundancy is
  exactly what currently backstops it.
- Could it duplicate Activity? **This is the existing, known problem** — not created or worsened
  by anything in this audit, but not solved either (audit-only, per your instructions).
- Could it affect CCTP claims? **No** — §3/§4 confirm the claim-matching logic is a structurally
  separate code path from the three generic-receive branches; removing the latter doesn't touch
  the former.
- Could it affect app-closed recovery? **No** — `claim-recovery-scan`'s *actual* claim-recovery
  purpose (the header comment's stated reason for the file existing) is untouched by anything
  proposed here; only the *bolted-on* generic-receive branches are in scope for a future fix.
- Could it affect existing `claim-worker` behavior? **No** — `claim-worker` is a separate file/
  cron entirely, not called by or dependent on `claim-recovery-scan`'s generic-receive branches.

**P2:**
- The generic-receive branches' `existsActivityForTxHash` guard adds real latency (up to ~3s per
  transfer, sequentially per log in a loop) to every `claim-recovery-scan` invocation — a minor
  performance cost unrelated to correctness, worth noting for any future rework.

---

## Recommended fix (design only — not implemented, per your instructions)

Matches the target architecture you specified almost exactly, with one refinement based on §7's
finding:

```
Generic blockchain receive
    ↓
blockchain-indexer → chain_events → activity-consumer → RECEIVE
    (already live, already covers every event class claim-recovery-scan's
     generic branches attempt — §6/§8)

Claim-specific recovery
    ↓
claim-recovery-scan (mint-detection + claims-table matching ONLY)
    ↓
claim Activity, reconciliation of stuck/failed claims
```

**Refinement, not a change of direction**: given §7's finding that `activity-consumer` is
younger and has a longer detection latency than `claim-recovery-scan`'s on-focus trigger, a
**direct removal** of the generic-receive branches should not happen until:
1. `activity-consumer`'s health/coverage is proven over a longer observation window than the one
   `docs/PHASE_3_PRODUCTION_OBSERVATION.md` captured (per that report's own stated limitation —
   the multi-log check remains open, and swap-output coverage specifically should be watched,
   since that's the exact case this audit traces).
2. A decision is made about the UX latency tradeoff (§7) — whether losing the sub-second
   on-focus detection speed is acceptable, or whether a narrower, faster-but-still-safe
   replacement (e.g. `claim-recovery-scan` querying `chain_events` directly instead of
   re-scanning RPC logs itself, still triggered on-focus but reading the indexer's own already-
   fresher-than-cron-cadence data) is worth building instead of a straight removal.

A middle-ground alternative worth naming: **apply the same sender-based classification
`compare.ts`'s `KNOWN_INTERNAL_CONTRACTS` already uses** to `claim-recovery-scan`'s
generic-receive branches, structurally excluding known swap-router/Multicall3/P2P-escrow senders
instead of relying entirely on the timing-dependent existence check. This would meaningfully
narrow the race (the same class of improvement `compare.ts`'s Fix C already made for the
*comparison* layer) without removing the fast on-focus detection UX at all, and without waiting
for `activity-consumer`'s coverage to be separately proven. **Also not implemented — a
narrower option to weigh alongside full removal, not a recommendation to pick one over the
other without your input.**

## Migration/cutover plan (design only)

1. Add sender-based exclusion (the middle-ground option above) as a narrow, low-risk first step
   — mirrors the already-proven `KNOWN_INTERNAL_CONTRACTS` pattern, testable the same way the
   BulkPay fix was.
2. Extend the production observation window specifically for swap-output and (once it exists)
   BulkPay/P2P/UB traffic on the indexer path, to build real confidence in §7's "no gap today"
   conclusion holding under more volume.
3. Only after both of the above: consider narrowing or removing the generic-receive branches
   entirely, keeping `claim-recovery-scan` scoped to claim-specific recovery as its name implies.
4. Retire `existsActivityForTxHash`'s polling pattern once the generic-receive branches it
   protects are gone — it has no purpose once nothing calls `recordExternalReceive` from a
   racy, unclassified path.

## Tests required (for whichever fix is eventually chosen — not written in this pass)

- Sender-based exclusion (if chosen): a `Transfer` from a known swap-router/Multicall3/P2P-
  escrow contract is excluded from `recordExternalReceive` at the classification level, not
  after-the-fact via the existence check — mirroring `compare.test.ts`'s existing
  `internalSenderOf` test pattern.
- Regression test proving claim-matching logic (§3) is completely unaffected by any change to
  the generic-receive branches — they should be provably independent code paths.
- If narrowing/removing: a test proving the indexer/`activity-consumer` path alone correctly
  credits an EURC-shaped and a native-USDC-shaped deposit with no `claim-recovery-scan`
  involvement at all (an integration-style test against the existing `decide.ts`/`compare.ts`
  test suites, extended rather than duplicated).

---

**No production code was modified in this audit.** `claim-recovery-scan`, the indexer, and
`ActivityService` are all exactly as they were before this pass. Stopping here for your review,
per your instructions — not building Ledger, not implementing any of the above.
