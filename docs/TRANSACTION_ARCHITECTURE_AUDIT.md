# MeshPort Transaction Architecture Audit

Status: **Phase 0 — audit only. No production code changed.**
Scope: Pay (Send), Receive, Swap, Multichain Transfer, Multichain Claim, BulkPay, ChatPay, P2P,
Activity, Balance, Notifications, Indexer, Supabase security.

---

## 1. Current architecture (as built today)

MeshPort is a wallet-first payments app (React/Vite frontend, Vercel serverless `api/`,
Supabase Postgres + Edge Functions, Circle Arc testnet + several EVM testnets).

Two account types exist:

- **Self-custodial**: mnemonic/private key generated or imported client-side, optionally
  passcode-encrypted locally. Server never sees the key.
- **Social-login (custodial-lite)**: `supabase/functions/wallet-key` generates the wallet
  **server-side**, envelope-encrypts the private key at rest (KEK→MEK→wallet-key layering,
  versioned, with a legacy-migration path and an audit log), and returns the plaintext key to
  the authenticated client on demand so all *signing* still happens locally. This is a
  deliberate, already-documented design (`docs/SECURITY_AUDIT_FINAL.md`,
  `docs/PRODUCTION_READINESS_REPORT.md` referenced in the file's own header) — it is **out of
  scope for this migration** (no feature/UX change requested) but is noted here because it's
  the only place a raw private key is expected to cross the network by design, and it already
  has real authorization, rate limiting and audit logging. It is not one of the problems below.

Today, every feature (Pay/Send, Swap, BulkPay, ChatPay, Rewards, P2P, Multichain Send/Claim)
independently:

1. Reads `privateKey` out of the Zustand `useAuthStore`.
2. Calls its own chain-specific send/sign function.
3. On perceived success, **directly inserts its own Activity row(s)** via
   `src/lib/ActivityService.ts` (`Activity.send`, `Activity.receive`, `Activity.swap`, etc.).
4. Independently triggers a balance refetch.
5. Independently decides whether to show success/failure to the user.

There is **no shared transaction intent, no shared state machine, and no ledger layer**.
`ActivityService.ts` itself is documented as "the SINGLE SOURCE OF TRUTH" — i.e. Activity is
currently playing the role that `ledger_events` + a projection should play.

There **is** a real, already-partially-built indexer:

- `supabase/functions/blockchain-indexer/` (`chain_cursors`, `chain_events`,
  `indexer_config`, `indexer_shadow_reports` — migrations `20260807120000` and
  `20260807130000`) runs in **shadow mode only**: it observes and records what it *would*
  detect, and compares itself against the legacy workers' output, but
  `indexer_config.authoritative` stays `false` and it "never writes activity, claims, or
  balances" (per its own header comment). This is real, recent, well-reasoned groundwork for
  exactly the canonical architecture requested — it should be **extended to become
  authoritative**, not replaced or duplicated.
- `supabase/functions/deposit-scan-all/`, `claim-worker/`, `claim-recovery-scan/`,
  `p2p-release-reconcile/`, `activity-consumer/` are the current *production* writers.

---

## 2. Duplicate / competing writers of financial state

Grep of every `.from('activity')`-style write site shows Activity is written from **both**
client feature pages and server functions, with no single authority:

| Writer | Location | Confirms before writing? |
|---|---|---|
| `Activity.send()` | `SendPage.tsx`, `ChatPage.tsx`, `ContactsPage.tsx`, `BulkPayoutPage.tsx`, `SwapPage.tsx`, `MultichainSendPage.tsx`, `rewards.ts` | No — fires the moment `result.txHash` exists, before any receipt confirmation |
| `Activity.receive()` (**for someone else's wallet**) | `SendPage.tsx` (sender writes the recipient's row directly), `HomePage.tsx`, `rewards.ts` | No |
| `swap-proxy.js` (`recordSwapActivity`) | `api/swap-proxy.js` | Server-side, after the Circle SDK call returns — best-effort, "never blocks the swap response" |
| `activity-consumer` Edge Function | `supabase/functions/activity-consumer/` | Server-side, event-driven |
| `claim-worker`, `claim-recovery-scan`, `deposit-scan-all` | respective Edge Functions | Server-side, against chain state |
| `p2pService.ts` | client | Mixed — some paths write before on-chain confirmation |

**Most significant single finding:** `SendPage.tsx` (`Activity.receive({...})`, ~line 500)
writes the **recipient's** Activity row directly from the **sender's own browser**, immediately
after broadcast, with an explicit code comment explaining this is intentional — to make receives
"feel instant" instead of waiting for the recipient's client or the indexer. This is precisely
the anti-pattern called out in the request: *"the sender must never create the receiver's
Activity"* and *"this must work even if the receiver's app is closed."* It happens to work today
because the sender's client is trusted to be honest and online; it is not durable, not
authoritative, and not something the future canonical model can keep.

There are already three migrations fighting the symptoms of this
(`fix_activity_duplicates_permanently`, `fix_double_prefixed_receive_rows`,
`admin_transaction_count_dedup`) — i.e. duplicate-write pain is already a known, recurring
operational problem, not a hypothetical one.

`ActivityService.ts` also contains ~100 lines of client-side reconciliation logic (backfilling
missed receives from chat messages, deduping send/receive pairs by tx hash) — this is
compensating, in the client, for the lack of a canonical ledger.

---

## 3. Security findings

### P0 — Raw private key sent to a backend API

`api/swap-proxy.js` (`module.exports = async function handler`) accepts
`{ action, privateKey, tokenIn, tokenOut, amountIn, slippageBps }` **directly in the POST body**,
and uses it server-side (`createEthersAdapterFromPrivateKey`, `new Wallet(normalizedKey)`) to
sign and broadcast the swap via the Circle SDK. `SwapPage.tsx` (client, ~line 535) sends the
user's real `privateKey` from `useAuthStore` in this request.

This is exactly the pattern the brief prohibits: *"Do not merely hide the field. Remove the
architectural dependency."* It is a genuine architectural dependency — the swap flow currently
cannot function without the client handing its key to a Vercel serverless function, where it is
logged-adjacent (via `console.log`/error paths) and passes through ordinary request
infrastructure.

Contrast with `api/relay-deposit.js` and `api/relay-gas.ts`, which are correctly designed: they
use a **server-owned** `RELAY_PRIVATE_KEY` (a sponsor/relay wallet, from `process.env`, never
from the request body) to pay gas or call `depositFor()` on the user's behalf. Those are fine
and are not part of this finding.

**Fix direction (Phase 9 — Swap):** move signing local, matching the pattern already used
everywhere else in the app (`p2pEscrowContract.ts`, `arcService.ts`, `SendPage.tsx`, etc., which
all call `privateKeyToAccount`/`createWalletClient` **in the browser**). The Circle SDK's
ethers-adapter needs an object satisfying its `Signer`-like interface; that can be constructed
client-side and used to sign+broadcast directly, with `swap-proxy.js` reduced to a
quote/estimate-only proxy (which some of its code paths already are) plus post-hoc activity/
reconciliation. This is flagged for Phase 9 and is **not being changed in Phase 0/1**.

### P0 — Wallet-address-only authorization on `/api/transactions`

`api/transactions.ts` explicitly documents its own design: *"Using the service key bypasses RLS
entirely — wallet-only users (no Supabase auth session) can save and read their own transactions
by wallet_address."* The `GET` handler takes `?address=0x...` as a plain query parameter with no
session/ownership check and returns that wallet's full transaction history. Any caller who knows
(or enumerates) a wallet address can read another user's transaction history. The `POST` path
should be checked the same way in Phase 1 implementation (not yet inspected in full).

**Fix direction (Phase 16):** require a verified Supabase session (or equivalent signed proof of
wallet ownership, e.g. a signed challenge) and scope the query to the authenticated identity's
own wallet(s) server-side, the same pattern `wallet-key`'s `supabase.auth.getUser(jwt)` already
uses correctly.

### Not a finding, needs confirmation in Phase 16 — RLS on `activity`/`transactions`

No `CREATE POLICY ... activity` statements were found in `supabase/migrations/`, which likely
means these tables are read via the service-role key from serverless functions (bypassing RLS
by design, as `transactions.ts` states) rather than being queried directly by the browser with
the anon key. This needs to be confirmed file-by-file in Phase 16 rather than assumed — if any
client code queries `activity`/`transactions` directly with the anon/publishable key, RLS must
correctly scope rows to the caller's own wallet(s).

### Working as intended — `wallet-key` custodial flow

Already covered in §1. Uses per-user session verification
(`supabase.auth.getUser(jwt)` → resolves to `public.users.id`, not a client-supplied id),
a real `login_type` check to keep self-custodial accounts out, rate limiting, audit logging, and
origin-aware CORS. No action requested or recommended here.

---

## 4. Transaction-truth / consistency issues

- **No `SUBMITTED_UNKNOWN` state anywhere.** Every feature's local error handling seems to
  treat "the confirmation RPC call failed/timed out" as a normal error path; `swap-proxy.js` at
  least surfaces a warning string to the user ("we couldn't confirm this finished... check
  Activity before retrying") but there is no durable state that a background process can later
  reconcile — it's a UI string, not a state machine state.
- **Activity is written before confirmation in most flows.** `SendPage.tsx` writes both the
  sender and recipient Activity rows the moment `result.txHash` exists (broadcast, not
  confirmation), then does a **best-effort background correction** if the tx later reverts. This
  is the opposite of the required ordering (confirm → ledger → activity).
- **No canonical idempotency key** on user-triggered financial actions. Duplicate-click
  protection, where it exists, is ad hoc per feature rather than a shared
  `(user_id, idempotency_key)` constraint.
- **No amount-atomic / decimals-first storage layer observed in Activity** — `ActivityRecord.amount`
  is `number` (floating point). This needs to be corrected in the new `ledger_events`/
  `transaction_intents` tables (store `amount_atomic` + `decimals`); existing `activity.amount`
  can stay as-is for now since it's a display projection, per the "don't rewrite everything"
  rule.
- **Swap Activity likely already stores actual output**, not just the quote (`swap-proxy.js`
  computes real amounts post-SDK-call) — this needs verification against `ActivityService.swap()`
  during Phase 4 implementation, but is not flagged as broken here.

---

## 5. Indexer / reconciler current state

- The **existing indexer is the right one to extend** (per skill rule "do not create a second
  competing indexer"). It already has: per-chain cursor with reorg detection
  (`last_indexed_hash` vs. observed hash), confirmation-depth gating, `pending`→`confirmed`→
  `reorged` event lifecycle, configurable retention, and a shadow-comparison harness
  (`compare.ts`, `indexer_shadow_reports`) that has presumably been collecting real accuracy
  data against the legacy `deposit-scan-all`/`claim-worker` output.
- It is explicitly **not authoritative yet** — `indexer_config.authoritative = false`, and it
  writes nothing consumable. Making it authoritative (with the shadow-report data as the
  go/no-go signal) is squarely Phase 3 work, not something to touch in Phase 1.
- `claim-worker` / `claim-recovery-scan` are separate, purpose-built, and already server-side
  and restart-safe per their own migrations (`claim_worker_hardening`,
  `claim_worker_cron`, `fix_claim_worker_sweep_missing_auth`) — keep, per Phase 11 guidance.

---

## 6. P0 / P1 / P2 summary

**P0 (security, fix before/alongside architecture migration):**
1. `api/swap-proxy.js` receives the user's raw `privateKey` over the network. (Phase 9)
2. `api/transactions.ts` GET is wallet-address-only, no ownership check — any caller can read
   any wallet's transaction history. (Phase 16, but cheap enough to consider fixing early)

**P1 (architecture/correctness):**
3. Sender client (`SendPage.tsx`) writes the recipient's Activity row directly — must become
   indexer/ledger-driven so receives work while the recipient's app is closed. (Phase 5/8)
4. Activity is written pre-confirmation across nearly every feature, with best-effort
   after-the-fact correction instead of "confirm first." (Phase 2/7)
5. No shared idempotency key on user-triggered financial actions. (Phase 1)
6. Indexer exists but is not authoritative — nothing currently guarantees Receive works with
   the receiver's app closed except the sender's optimistic write (see #3). (Phase 3/4)

**P2 (hygiene):**
7. `ActivityRecord.amount` is a JS `number`; new ledger tables should be atomic-integer from day
   one even though existing `activity.amount` is left alone for now.
8. RLS coverage on `activity`/`transactions` needs an explicit confirm-or-fix pass (Phase 16).
9. Confirm `POST /api/transactions` has the same wallet-only-auth issue as `GET` (not yet read
   in full).

---

## 7. What should NOT be changed right now

- `wallet-key` Edge Function and its envelope-encryption custodial design — already hardened,
  out of scope.
- `blockchain-indexer` shadow-mode logic and its comparison harness — extend, don't replace.
- `claim-worker` / `claim-recovery-scan` state machine — keep as the Multichain Claim engine
  per Phase 11.
- `relay-deposit.js` / `relay-gas.ts` relay-wallet gas sponsorship — correctly designed, not a
  private-key leak.
- `deposit-scan-all` — keep running until the indexer is proven authoritative via the existing
  shadow-comparison data; do not cut over early.
- P2P escrow contracts (`P2PEscrow.sol`, `P2PMeshportEscrow.sol`) — on-chain, out of scope for
  this backend/data-layer migration.

---

## 8. Recommended migration order (confirms Phase 17 of the brief)

1. **Database schema** — `transaction_intents`, `transaction_attempts`, `ledger_events`,
   `notification_events`. Reuse `chain_cursors`/`chain_events`/`indexer_config` rather than
   duplicating; `claims`, `multichain_transactions`, `transactions` tables already exist and
   should be reviewed for extension vs. superseding in Phase 1 design, not before.
2. Transaction state machine (shared module, used by all features going forward).
3. Indexer hardening — flip toward authoritative once shadow-report accuracy supports it;
   extend `chain_events` to cover BulkPay/Multicall3, escrow, CCTP if not already covered.
4. Reconciler — new server-side worker (or extend indexer) for `SUBMITTED_UNKNOWN` recovery.
5. Ledger.
6. Pay/Send (fixes the sender-writes-receiver-Activity issue as a side effect).
7. Receive (indexer-driven).
8. Swap (also fixes the P0 private-key-to-backend issue).
9. Multichain Transfer.
10. Multichain Claim (mostly keep, wire into ledger/notification layer).
11. BulkPay.
12. ChatPay (reuse Pay engine).
13. P2P (separate trade/escrow state machines).
14. Activity projection (cut over from direct writes to projection, verify against old data
    before removing old writers, per skill rule).
15. Notification projection.
16. Remove legacy direct Activity writers + fix `/api/transactions` authorization.

Each phase gets its own risk level and file list at implementation time, per the skill's
change-budget rule (5–8 files per focused change) rather than all being scoped here.

---

## 9. Risk levels (high-level, per phase)

| Phase | Risk | Why |
|---|---|---|
| 1. Schema | Low | Additive only, no writes redirected yet |
| 2. State machine | Low | New shared module, not wired in yet |
| 3. Indexer hardening | Medium | Touches a system already handling real funds detection, even in shadow mode |
| 4. Reconciler | Medium | New server process touching transaction state |
| 5. Ledger | Low–Medium | Additive, but defines the schema everything downstream depends on |
| 6. Pay | High | Touches the most-used, real-money flow; removes the sender's direct receiver-Activity write |
| 7. Receive | High | Must prove indexer-driven receive works before removing the sender-side shortcut |
| 8. Swap | High | Removes the privateKey-to-backend architecture; must be done carefully, can't leave a gap where swap signing has no path |
| 9. Multichain Transfer | Medium–High | Two providers (UB, CCTP), app-closed recovery already exists (`ubFundRecovery.ts`) — must not regress it |
| 10. Multichain Claim | Low–Medium | Mostly keep existing worker |
| 11. BulkPay | Medium | Multicall3 all-or-nothing semantics must be preserved exactly |
| 12. ChatPay | Medium | Depends on Pay engine being solid first |
| 13. P2P | High | Real escrowed funds, on-chain contract already fixed — trade/escrow split must be exact |
| 14. Activity projection cutover | High | Where duplicate-writer bugs have already happened three times (see existing dedup migrations) |
| 15. Notifications | Low–Medium | Additive, mostly new |
| 16. Remove legacy writers + fix `/api/transactions` auth | Medium | Must be last, after projection is verified |

---

## 10. Proposed final architecture (confirming the brief's diagram)

```
Frontend
   ↓
Transaction Intent  (transaction_intents, idempotency_key)
   ↓
Transaction Orchestrator  (shared state machine)
   ↓
Local Signing / Broadcast  (client-side signer for ALL features, including Swap post-fix)
   ↓
Blockchain
   ↓
Indexer / Reconciler  (extend existing blockchain-indexer, made authoritative; new reconciler for UNKNOWN states)
   ↓
Ledger Events  (new canonical financial event layer, deterministic event_key)
   ↓
 ┌──────────────┬──────────────┬──────────────┐
 Activity        Balance        Notifications
 Projection      Refresh        Projection
 (read-only,     (chain-derived (notification_events,
  from ledger)    cache)         deterministic key)
```

No frontend code path retains authority over transaction success/failure, receiver history,
balance mutation, notification creation, or cross-chain settlement once this migration
completes.

---

*End of Phase 0 audit. Awaiting approval before Phase 1 (canonical transaction model) begins.*
