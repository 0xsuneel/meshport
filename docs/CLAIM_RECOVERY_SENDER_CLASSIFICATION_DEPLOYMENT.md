# Claim-Recovery Sender-Classification Fix — Deployment + Observation Report

Status: **Deployed. Live-invocation observation was not possible within this session** — disclosed
plainly below, not glossed over. Pre-deploy checks and the deployment itself are fully verified.

---

## FINAL PRE-DEPLOY CHECK (all 10 items)

1. **Exact production-safe contents of `knownInternalContracts.ts`**: read in full immediately
   before deploying (reproduced verbatim in the deploy payload) — 9-entry `Set`, one
   `isKnownInternalContract()` function, zero other exports, zero side effects.
2. **Every hardcoded address has documented evidence**: 8 addresses cite `compare.ts`'s existing
   list (verified against live source, not memory) as their source; the 9th (Multicall3) cites
   the specific `chain_events` transaction (`0x435d804c…`) that confirmed it, from the Phase 3
   forensic audit.
3. **Multicall3 explicitly documented as independently confirmed, not copied**: confirmed present
   verbatim in the file's own header comment — *"is NOT currently in compare.ts's list (verified
   directly against the live source before writing this file)"* — re-verified as still exactly
   this wording in the deployed source (fetched back independently after deploy, see below).
4. **P2P escrow not hardcoded**: confirmed — zero P2P addresses appear anywhere in
   `knownInternalContracts.ts`'s static `Set`; handled entirely via the `extra` parameter.
5. **Env var names match production**: re-verified with a direct `grep` immediately before
   deploying — `claim-recovery-scan/index.ts` reads exactly `P2P_ESCROW_CONTRACT` and
   `P2P_ESCROW_CONTRACTS_LEGACY`, byte-identical to the names `p2p-release-reconcile/index.ts`
   already reads in production.
6. **No secrets introduced**: re-confirmed — the only literal values in the new file are public
   testnet contract addresses (same class of data already public in `compare.ts`,
   `deposit-scan-all/index.ts`, `api/relay-rpc.js`).
7. **No browser/Vite imports**: `knownInternalContracts.ts` has zero imports at all (pure data +
   one pure function).
8. **CCTP claim-specific code untouched**: `resolveSourceChain`, `recordClaimActivity`,
   `reconcileFailedClaimActivity`, the claims-matching candidate-pool logic — all re-verified
   byte-identical against the pre-change live source fetched immediately before deploying.
9. **Only intended dependencies**: `claim-recovery-scan/index.ts` has exactly two imports —
   `jsr:@supabase/supabase-js@2` (pre-existing) and `../_shared/knownInternalContracts.ts` (new).
   Nothing else.
10. **Diff scope**: confirmed via file-modification-time check before deploying — exactly
    `supabase/functions/_shared/knownInternalContracts.ts`,
    `supabase/functions/claim-recovery-scan/index.ts`,
    `supabase/functions/_shared/knownInternalContracts.test.ts`, and
    `docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md`. Nothing else.

**Final local validation immediately before deploying** (re-run, not reused from the prior
session): `deno test knownInternalContracts.test.ts` — 10/10 passed. `deno test` on the full
`blockchain-indexer` suite — 45/45 passed (confirming zero indexer impact). `npx vitest run` —
192/192 passed. `npm run typecheck` — clean.

---

## DEPLOYMENT

Fetched the exact live pre-deploy source of `claim-recovery-scan` first (`get_edge_function`) —
confirmed it matched the version 38 baseline already traced in the audit, byte-for-byte, before
building the deploy payload. Deployed via `deploy_edge_function`:

- **File naming**: matched the proven, already-deployed convention used by `claim-submit` (the
  one other function in this project that already imports from `_shared/`) —
  `functions/claim-recovery-scan/index.ts` + `functions/_shared/knownInternalContracts.ts` —
  rather than guessing a structure.
- **`verify_jwt`**: explicitly passed as `true`, matching the pre-deploy configuration exactly
  (confirmed via `list_edge_functions` before deploying).
- **Result**: `version: 38 → 39`, `status: ACTIVE`, new `ezbr_sha256` confirming real content
  change.
- **Independently re-verified after deploy**: fetched the deployed source a second time
  (`get_edge_function`) and confirmed byte-for-byte match against what was intended to deploy —
  not just trusting the deploy call's own success response, same discipline as the Phase 3
  indexer deploy.

---

## POST-DEPLOY VERIFICATION — what could and could not be checked this session

**Honest disclosure up front**: `claim-recovery-scan` is invoked **per-wallet, from the client**
(`AppLayout.tsx`, on app mount/tab focus) — it is not cron-scheduled, and this environment has no
test user session/JWT to invoke a `verify_jwt: true` function directly. Unlike the Phase 3
`blockchain-indexer` deploy (where a cron-driven `index`/`compare` cycle could simply be waited
for), **there is no mechanism available in this session to trigger a real invocation of this
function**. Checks A-I below are reported exactly as they stand — verified, partially verified,
or not verified — not inflated.

| Check | Result |
|---|---|
| A. Unknown external EOA → generic RECEIVE still works | **Not observed live.** Verified at the code level: the classification check only returns `true` for addresses in the static list or `extra`; every other path is byte-identical to the pre-change code. Confirmed by `deno check` and the unit tests (`isKnownInternalContract` returns `false` for unknown addresses). |
| B. Known swap/router sender → generic RECEIVE skipped | **Not observed live.** Verified in the deployed source (re-fetched) and by `knownInternalContracts.test.ts` test #1/#9 (10/10 passing pre-deploy). |
| C. Known Multicall3 sender → generic RECEIVE skipped | **Not observed live.** Verified the same way, test #2. |
| D. Configured P2P escrow sender → generic RECEIVE skipped | **Not observed live, and not verifiable live even in principle without knowing whether `P2P_ESCROW_CONTRACT` is actually set as a project secret** (no tool access to secret values). Verified structurally via test #3 (uses an injected test address through `extra`, proving the mechanism works if a real address is ever configured). |
| E. Unknown contract sender → generic RECEIVE remains eligible | **Not observed live.** Verified by test #6 and direct code inspection — no heuristic exists that could accidentally broaden exclusion. |
| F. Genuine CCTP mint still reaches claim-specific logic | **Not observed live** (no mint occurred during the window). Verified by direct diff inspection — `isMint`/`resolveSourceChain`/claims-matching code is untouched, confirmed byte-identical against the pre-deploy source. |
| G. Existing Activity timing guard remains as secondary defense | **Confirmed by code inspection** — `existsActivityForTxHash` is still called, in the same position relative to the write, in every branch; only now reached after the new check rather than being the first check. |
| H. No new claim-recovery errors | **No errors observed** — but this is a weak signal given zero invocations occurred; absence of errors from zero attempts is not evidence of correctness under load. |
| I. No duplicate Activity rows created by the new classification | **No new rows of any kind were created** (`activity`/`claims` latest `created_at` unchanged throughout the entire observation window) — so there is nothing to check for duplication yet, honestly reported as "not yet exercised," not "confirmed clean." |

---

## EURC REGRESSION (naturally occurring)

**None observed.** No EURC (or any other) transfer occurred during the observation window at
all — confirmed by `activity.created_at` staying fixed at `2026-08-23 12:44:03` (the same EURC
swap row already traced in the prior audit, predating this deploy) throughout the entire
post-deploy observation period. Per your instructions, no transaction was manufactured to force
this check. This remains an open item, to be checked whenever the next naturally-occurring
swap-output event happens to occur and a real user's `claim-recovery-scan` invocation processes
it.

---

## OBSERVATION

- **Window observed**: `2026-08-23 16:56:24 UTC` through `2026-08-23 17:08:38 UTC` (~12 minutes
  of active polling), plus the gap since the prior message in this session (no activity in that
  gap either, confirmed by the unchanged `12:44:03` timestamp spanning the whole multi-hour
  period since the EURC transaction).
- **Invocations**: **0 confirmed.** No mechanism exists in this session to directly invoke this
  `verify_jwt: true`, client-triggered function, and no organic (real-user) invocation happened
  to occur during the window.
- **Generic receives**: 0 (nothing ran).
- **Internal transfers excluded**: 0 (nothing ran).
- **CCTP claims**: 0 new (`claims.created_at` unchanged at `2026-08-23 02:49:28`, predating this
  deploy).
- **Errors**: 0 observed, but from 0 attempts — not meaningful as a health signal.
- **Duplicate Activity rows**: 0 new rows of any kind, so none possible to have occurred.
- **EURC/swap-output observations**: none — see above.

**Per your instructions, this is explicitly NOT classified as a successful live regression
check.** "No traffic" is reported as exactly that — an inconclusive window — not a pass.

---

## What IS confirmed, precisely

- The correct code is deployed and the function is `ACTIVE` (independently re-verified, not
  assumed from the deploy call's response).
- The function did not fail to load/crash on deploy — `status: ACTIVE` with a fresh
  `ezbr_sha256` is at least evidence the new `import` resolved and the file parsed correctly at
  deploy time (a broken relative import path would be expected to surface as a deploy or
  first-invocation failure).
- All classification logic is verified deterministically via the 10 unit tests, run immediately
  before this deploy.
- All CCTP-safety and diff-scope claims are verified via direct, repeated source comparison
  against the live pre-deploy baseline — not assumption.

## What is NOT yet confirmed

- Real-world behavior of the deployed code under an actual invocation — checks A-I remain open
  until either a real user triggers this function (organically, on their own device) or a future
  session has access to a way to invoke it directly (e.g. a test JWT).
- The EURC regression specifically remains unverified against live traffic, per your own
  instruction not to manufacture one.

---

**Not removing the generic-receive branches. Not removing `existsActivityForTxHash`. Not
building Ledger.** Stopping here for review, per your instructions. Recommend re-running the
observation queries in this report (or the ones from `docs/PHASE_3_PRODUCTION_OBSERVATION.md`'s
§11-style pattern) after real user traffic has had a chance to occur, to close out checks A-I
and the EURC regression with genuine live evidence.
