# MeshPort Architecture

This document goes one level deeper than the README's architecture summary. It's aimed at someone about to modify a cross-cutting system (ledger, transaction state machine, multichain, or indexing) and needs the real reasoning, not just the file map.

For product-level feature descriptions, see the main [README.md](./README.md). For the original, much more detailed engineering write-ups this document is distilled from, see the linked files under `docs/` throughout.

---

## 1. System layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ Frontend (src/)                                                        │
│  React SPA — Zustand (local state), TanStack Query (async cache)      │
│  Talks to Arc ONLY via /api/arc-rpc (never a raw RPC URL client-side) │
└───────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
┌───────────────┐  ┌───────────────────┐  ┌────────────────────────┐
│ api/           │  │ supabase/         │  │ Blockchain              │
│ Vercel Node/   │  │  - Postgres       │  │  - Arc Testnet (home)   │
│ Edge functions │◄─┤  - Auth           │──►  - 20+ external EVM     │
│ RPC proxy,     │  │  - Realtime       │  │    testnets              │
│ relay, swap    │  │  - Edge Functions │  │  - Circle CCTP V2        │
│ proxy, push,   │  │    (Deno)         │  │  - Circle Gateway        │
│ OG previews    │  │                   │  │    (Unified Balance)     │
└───────────────┘  └─────────┬─────────┘  └────────────────────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ server/            │
                    │ Pure TS, no I/O:   │
                    │  - ledger/         │
                    │  - transaction     │
                    │    StateMachine/   │
                    │ Unit tested        │
                    │ independent of DB  │
                    │ or RPC             │
                    └────────────────────┘
```

**Why `server/` is separate from `supabase/functions/`:** the ledger classifier/interpreter and transaction state machine are written as pure, dependency-injected TypeScript with no direct Postgres or Deno runtime dependency. That lets them be unit-tested in isolation (`classifiers.test.ts`, `interpreter.test.ts`, `apply.test.ts`, `transitions.test.ts`) and then imported into whichever Edge Function actually needs them (`ledger-interpret`, `activity-consumer`) — correctness is proven once, in a fast test suite, rather than re-verified against a live database every time.

**Why Edge Functions are frequently self-contained instead of importing shared modules:** several functions (`claim-worker`, `claim-recovery-scan`, `wallet-key`, `bulkpay-intent`) inline copies of "shared" logic (CORS headers, chain registries, RPC helpers) rather than importing from `supabase/functions/_shared/`. This is a deliberate, documented workaround: the Supabase Dashboard's single-file code editor does not reliably deploy separate shared files alongside a function edited there, so a fix to a shared file can silently fail to reach a function that imports it if that function is later re-deployed from the dashboard. Inlining guarantees a single paste-and-deploy always ships every fix. If you're editing shared logic, **grep for every inlined copy** and update them all, or you will fix the bug in one function and leave it live in another.

**Why three separate chain/token registries exist** (`src/blockchain/chains.ts`, `api/arc-rpc.js`'s own list, `supabase/functions/_shared/chains.ts`): these run in three genuinely different runtimes (browser bundle, Vercel Node, Deno edge) that cannot share imports across a deploy boundary. `chains.ts` is the canonical *client-side* registry (consolidated from five previously-duplicated copies — see its own header comment); the other two are intentionally-separate mirrors for their runtimes. When adding or fixing a chain, update all three, and check for known, deliberate divergences (e.g. HyperEVM's RPC ordering differs between `EXTERNAL_CHAINS` and `SDK_CHAIN_RPCS` for documented reasons) before "reconciling" something that was left different on purpose.

## 2. Transaction state machine

`server/transactionStateMachine/` defines the canonical states and legal transitions between them (`types.ts`, `transitions.ts`, `apply.ts`). The states exist specifically to distinguish "definitely failed" from "we genuinely don't know yet":

```
DRAFT → REVIEWED → AUTHORIZING → SIGNED → SUBMITTED → CONFIRMING → CONFIRMED → SETTLED
                                              │
                                              ├─→ SUBMITTED_UNKNOWN
                                              ├─→ FAILED
                                              ├─→ REPLACED
                                              └─→ DROPPED
```

The single most important invariant here: **a broadcast transaction whose receipt-wait timed out is `SUBMITTED_UNKNOWN`, never auto-marked `FAILED`.** A dropped RPC connection or a slow block doesn't mean the transaction didn't land — it might confirm a minute later. Marking it `FAILED` prematurely risks a user (or the app) retrying and double-spending. `SUBMITTED_UNKNOWN` transactions are reconciled by checking the chain directly (the indexer, or claim-worker's own event-based confirmation) before any further action is taken.

Claims run a narrower, CCTP-specific version of this idea directly on the `claims` table: `submitted → bridging → verifying → settling → completed` / `failed`, with `needsReview` and `lastErrorAt` columns that can be set on *non-terminal* states to surface diagnostic detail without prematurely calling something a failure.

Further reading: `docs/TRANSACTION_STATE_MACHINE.md`, `docs/TRANSACTION_ARCHITECTURE_AUDIT.md`, `docs/TRANSACTION_SERVICE_BOUNDARY.md`.

## 3. Ledger and Activity projection

Financial truth flows one direction only:

```
Blockchain
   │
   ▼
Indexer / Reconciler        (supabase/functions/blockchain-indexer, deposit-scan-all, claim-worker)
   │
   ▼
Ledger Event                (server/ledger/classifiers.ts + interpreter.ts → ledger_events table)
   │
   ▼
Activity Projection         (activity-consumer → activity table → Realtime → ActivityPage.tsx)
```

Two rules this pipeline enforces that are easy to accidentally violate when adding a new feature:

1. **The frontend never writes a confirmed Activity row for money someone else received.** A sender's client must never call `Activity.receive(receiver)` directly — the receiver's Activity entry is always produced by the indexer picking up the actual on-chain event. This is what makes receiving work even when the recipient's app is completely closed at the time of the transfer (an exchange withdrawal straight to a MeshPort address, for instance).
2. **Ledger events are append-only and are the single source of truth Activity is projected from** — Activity itself is never mutated directly to "fix" a display issue; a discrepancy is fixed upstream, in classification or indexing, and re-projected.

`docs/LEDGER_CANONICAL_EVENT_DESIGN.md`, `docs/LEDGER_CORE_IMPLEMENTATION.md`, `docs/LEDGER_FEATURE_MAPPING.md`, and `docs/ACTIVITY_WRITER_AUDIT.md` cover the full reasoning, including several real bugs this design was built to fix (see `docs/BULKPAY_LEDGER_CLASSIFICATION_AUDIT.md` and `docs/CLAIM_RECOVERY_AUDIT.md` for concrete historical examples of what goes wrong without it).

## 4. Multichain: CCTP V2 vs. Unified Balance, in depth

MeshPort's multichain movement is genuinely two different systems, chosen per-chain and per-direction — not a single abstraction with a UI label swapped.

### CCTP V2 (both directions)

| Step | What happens | Where |
|---|---|---|
| Burn | USDC is burned on the source chain via Circle's TokenMessenger contract | Client (transfer-out) or the user's own prior transaction (claim-in) |
| Source confirm | Burn transaction is confirmed on the source chain | `claim-worker`'s `bridgeFunds()` (claim-in) / client polling (transfer-out) |
| Attestation | Circle's attestation service signs off on the burn (~20–90s observed on testnet) | `claim-worker`'s `waitForBridge()` / client polling against Circle's attestation API |
| Mint | The attested message is submitted to Arc's (or the destination's) MessageTransmitter, minting equivalent USDC | `claim-worker` (claim-in, server-signed) / client or relay (transfer-out) |
| Destination confirm | Mint transaction confirms | Same as above |
| Arrival detection | **Event-based**: matches the actual `MessageReceived` log or a specific incoming Transfer by recipient + amount — not a wallet-wide balance-delta snapshot, which broke under any concurrent wallet activity | `claim-worker`'s `confirmArrival()` |

Claim-in (external → Arc) is entirely server-driven through `claim-worker`, invoked immediately on submission and kept alive by a `pg_cron` sweep every minute as a self-healing safety net — a claim keeps progressing with zero open browser tabs. Transfer-out (Arc → external) runs its burn/mint steps from the client, since it's the user's own Arc wallet signing, with a step-timer UI calibrated to CCTP V2's real attestation latency rather than assuming instant confirmation.

### Circle Gateway — Unified Balance (Arc → external only, allow-listed chains)

| Step | What happens |
|---|---|
| Deposit | User's Arc USDC moves into their Circle Unified Balance (fast — Arc's own sub-second confirmation) |
| Spend | The Unified Balance is spent directly to the destination chain/address, without a burn/attest/mint round-trip |

This path is materially faster (well under CCTP's tens-of-seconds attestation wait) but only available for chains explicitly flagged `ub: true` in the chain registry — itself overridable per-chain from the admin panel (`resolveChainMechanism`). Its fee model is different from a plain transfer (Circle's protocol fee + relevant gas are deducted from the Unified Balance itself), and this is surfaced to the user before they confirm, not discovered after the fact.

**Resumability matters here specifically because it's two steps with real money at each one:** if a deposit already landed but the spend step didn't complete (tab closed, network drop), the UI detects the existing Unified Balance on return and resumes from the spend step — it does not deposit a second time.

Further reading: `docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md`, `docs/CLAIM_RECOVERY_AUDIT.md`, `docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md`, `docs/CHAIN_TRANSFER_WEBHOOK_SETUP.md`.

## 5. Bulk Pay + Multicall3

Bulk Pay is deliberately **one transaction, not N transactions**:

```
Recipients (usernames/addresses + amounts)
   │
   ▼
Validate (resolve usernames, dedupe, sum vs. balance)
   │
   ▼
Review (flat single-tx gas estimate)
   │
   ▼
Build Multicall3 aggregate3Value calldata
   (one { target, value, allowFailure:false } entry per recipient)
   │
   ▼
bulkpay-intent Edge Function records an idempotent intent
   BEFORE the call is built/sent
   │
   ▼
One signed transaction → Multicall3 (canonical CREATE2 address, same on every EVM chain)
   │
   ▼
Receipt → per-recipient Transfer/value logs
   │
   ▼
Payer debit + N recipient credits via the indexer/ledger pipeline
   (Multicall3 itself is excluded from "who sent this" attribution —
    see onchainReceivedActivity.ts's known-internal-contracts list)
```

If the Multicall3 transaction reverts, the whole batch failed — the app does not infer or display partial success from a reverted transaction. Because every individual transfer is *forwarded by* Multicall3, its logs show `from = Multicall3`, which is why the indexer/activity layer maintains an explicit allow-list of "known internal contracts" (Multicall3, the Circle Kit adapter, CCTP message transmitters) to exclude from naive sender attribution — omitting a contract from that list has previously caused recipients to see "Received from Multicall3" instead of the real bulk-payout attribution (see `docs/BULKPAY_ACTIVITY_SAFETY_FIX.md`, `docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md`).

## 6. P2P trading and escrow

**Deployed address (Arc Testnet):** `0xB3D37ff64A3c9E740e9d49efE346657944729F09` (`P2PMeshportEscrowV2`) — see [Deployed Contracts](./README.md#deployed-contracts) in the README.

`P2PMeshportEscrowV2.sol` is a from-scratch security-hardened rewrite of an earlier escrow contract (no longer kept in this repository — see the note below), with the vulnerabilities and fixes documented directly in the contract's own header comments:

- **First-depositor offer hijack (fixed):** the original derived an offer's escrow key as `keccak256(offerId)` alone, so whoever's deposit transaction landed first for that key became the offer's seller — visible and front-runnable in the mempool. V2 derives the key as `keccak256(abi.encode(offerId, sellerAddress))`, making it cryptographically infeasible for an attacker to produce the same key from a different address.
- **Trusted caller-supplied release parameters (fixed):** the original's `release(offerKey, tradeKey, buyer, amount)` trusted whatever `buyer`/`amount` the caller passed, with `msg.sender == admin` accepted on the same unguarded function. V2 ties release to on-chain recorded trade state instead of caller-supplied arguments.
- **Role model:** V2 adds an INVESTIGATOR role (for dispute handling) alongside the previously-existing PAUSER/ADMIN roles, and uses OpenZeppelin's `ReentrancyGuard` with checks-effects-interactions ordering on every value-sending function.
- **Currency handling:** USDC is Arc's native currency, so the contract moves value via `payable`/`.call{value: amount}("")`, not ERC-20 `approve`/`transferFrom` — there is no ERC-20 wrapper involved in escrow itself.

Off-chain, `p2p-release-reconcile` periodically reconciles on-chain escrow release events against the `p2p_trades` table so a trade's recorded status can't drift from what the contract actually did — trade completion in the UI requires a confirmed on-chain release, never just a "release requested" client action.

**Note on legacy contract source:** the pre-hardening escrow contract's Solidity source is no longer kept in this repository. This does not affect already-deployed instances of it on Arc Testnet — their bytecode is immutable and unaffected by what's in this repo. `p2pService.ts` and `p2p-release-reconcile` still know how to read trade state from any address listed in `P2P_ESCROW_CONTRACTS_LEGACY` (via raw ABI selectors, not by importing the removed source file), so historical trades created against a legacy deployment keep reconciling correctly. Only the source file was removed, not support for the contracts it already produced.

## 7. Idempotency and intents

Every user-triggered financial action that can plausibly be retried (network blip, double-tap, app restart mid-flow) has a corresponding "intent" recorded server-side **before** the on-chain call is built: `pay-intent`, `swap-intent`, `bulkpay-intent`. These exist to make retries safe — a retried request can be recognized as a duplicate of an in-flight or already-executed intent rather than resulting in a second real transfer. This is distinct from, and complementary to, the transaction state machine above: intents are about "did the user already ask for this," while the state machine is about "what actually happened to the transaction once submitted."

## 8. Shadow validation

Several docs (`docs/SHADOW_VALIDATION_REPORT.md`, `docs/PHASE_4_SHADOW_VALIDATION.md`, `docs/LEDGER_REAL_TRANSACTION_SHADOW_VALIDATION.md`) and the `indexer_shadow_reports` table describe a pattern used while migrating to the current ledger/indexer pipeline: the new pipeline ran alongside the old one, comparing outputs on real production data before the old pipeline was retired (`docs/SHADOW_DEPLOYMENT_RUNBOOK.md`, migration `20260830080000_retire_redundant_deposit_activity_consumer_sweep.sql`). `src/blockchain/shadowEventBus.ts` and `shadowEventMap.ts` are the client-side half of this comparison mechanism. If you're touching indexing or ledger logic, these documents contain real historical discrepancies that were caught this way — worth reading before assuming a new change is safe to ship without a similar comparison period.

## 9. Where correctness reasoning actually lives

This repository's `docs/` folder is unusually thorough and is the authoritative source for *why* something is built the way it is — this file and the README summarize it, they don't replace it. Particularly worth reading in full before large changes:

- `docs/TRANSACTION_STATE_MACHINE.md`, `docs/TRANSACTION_SERVICE_BOUNDARY.md` — state machine contract and boundaries
- `docs/LEDGER_CANONICAL_EVENT_DESIGN.md`, `docs/LEDGER_SCHEMA_GAP_AUDIT.md` — ledger schema and design gaps found along the way
- `docs/SECURITY_ARCHITECTURE.md`, `docs/SECURITY_AUDIT_FINAL.md` — security model and internal audit findings
- `docs/DISASTER_RECOVERY.md` — recovery procedures
- `docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md` — the original proposal that led to consolidating `chains.ts`
- `docs/PRODUCTION_READINESS_REPORT.md` — a snapshot assessment of readiness as of its writing (treat as historical, not a live status page)
