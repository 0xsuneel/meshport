# MeshPort — Production Blockchain Architecture Audit & Redesign

Status: **proposal, not implemented.** No production code has been changed.
Scope: every blockchain-touching path in the repository (client, `api/`, `supabase/functions/`).
Basis: full read of `src/`, `api/`, `supabase/`, `contracts/`, `scripts/` at v57.0.0 (57,374 LOC).

---

## 0. Executive summary

MeshPort's blockchain layer is **correct but uncoordinated**. The individual
pieces are well engineered — the Arc RPC proxy (`api/arc-rpc.js`) has real
health-scored failover, `claim-worker` is a properly locked server-side state
machine, `externalChainBalances.ts` already consolidated three drifted copies
of the multichain scan. The problem is at the seams: **there is no single owner
of chain access.** 40+ call sites construct providers, read balances, and
schedule their own timers independently.

Three structural consequences:

1. **Steady-state RPC cost is dominated by polling, not by user actions.** A
   single idle tab on Home with one open Activity page issues roughly
   **3,300 upstream requests/hour** with the user doing nothing.
2. **Correctness depends on timer coincidence.** Home, the Hub and Claim each
   scan 21 chains on their own 60s interval; consistency between the numbers
   they show is a function of a shared 20s cache window, not of a shared
   source of truth. The `$555 on Home vs $177 here` incident documented at
   `src/features/multichain/MultichainPage.tsx:120-126` is this class of bug.
3. **Every navigation refetches.** The global store holds exactly one
   blockchain field (`balance: number`, `src/store/index.ts:283`). EURC,
   cirBTC, external balances, claimable totals and history all live in
   per-page `useState`, so unmounting a page discards them.

The redesign introduces four owned layers — **ProviderManager**,
**BlockchainManager**, **BlockchainStore**, **SyncCoordinator** — plus one
server-side **BlockchainIndexer** that absorbs `deposit-scan-all` and the
deposit half of `claim-recovery-scan`. `claim-worker`, `claim-submit` and
`wallet-key` stay independent, with justification in §21.

Projected: **~92% fewer client RPC requests, ~95% fewer Alchemy compute units**,
driven mostly by deleting one specific hot path (`newHeads` →
`eth_getBlockByNumber` with full transaction bodies, per block, per open tab)
and by making refresh event-driven instead of interval-driven.

Migration is **incremental and non-breaking**: 6 phases, each independently
shippable and revertible, no feature removed, no rewrite of the Circle AppKit
integration or the claim state machine.

---

## PART I — CURRENT ARCHITECTURE

## 1. Current architecture diagram

```
                            ┌─────────────────────── BROWSER ───────────────────────┐
                            │                                                       │
  ┌──────────┐  ┌────────┐  ┌────────┐  ┌───────┐  ┌──────┐  ┌──────┐  ┌─────────┐  │
  │ HomePage │  │ Multi- │  │ Multi- │  │ Multi-│  │ Swap │  │ Send │  │ Chat /  │  │
  │  2686 ln │  │ chain  │  │ chain  │  │ chain │  │ Page │  │ Page │  │Contacts │  │
  │          │  │  Hub   │  │ Claim  │  │ Send  │  │      │  │      │  │         │  │
  └────┬─────┘  └───┬────┘  └───┬────┘  └───┬───┘  └──┬───┘  └──┬───┘  └────┬────┘  │
       │            │           │           │         │         │           │       │
       │  each page owns its own timers, providers, caches and useState     │       │
       ▼            ▼           ▼           ▼         ▼         ▼           ▼       │
  ┌──────────────────────────────────────────────────────────────────────────────┐  │
  │ SCATTERED ACCESS LAYER (no owner)                                            │  │
  │                                                                              │  │
  │  balanceCache.ts    externalChainBalances.ts   arcService.ts    arc.ts       │  │
  │  (3 Arc tokens,     (21 chains, 20s TTL,       (viem clients   (arcTransport │  │
  │   4s TTL, token-     addr-keyed, staggered)     per call)       arcRpcJson)  │  │
  │   keyed only)                                                                │  │
  │                                                                              │  │
  │  onchainReceivedActivity.ts   realtimeDeposits.ts   rewards / p2pEscrow /    │  │
  │  (ArcScan REST, 12s poll)     (Alchemy WS + block   ubFundRecovery /         │  │
  │                                fetch per block)      BulkPayout (own clients)│  │
  └───────┬───────────────────────┬──────────────────────────┬───────────────────┘  │
          │                       │                          │                      │
          ▼                       ▼                          ▼                      │
   ┌────────────┐        ┌─────────────────┐         ┌──────────────┐               │
   │ ARC (proxy)│        │ 21 EXTERNAL     │         │ ALCHEMY ARC  │               │
   │ /api/arc-  │        │ CHAINS — direct │         │ WSS (client  │               │
   │  rpc       │        │ browser → public│         │  key in      │               │
   └─────┬──────┘        │ RPC, no proxy   │         │  bundle)     │               │
         │               └─────────────────┘         └──────────────┘               │
         │                                                                          │
         └──────────────────────────────────────────────────────────────────────────┘
           │
           ▼  (Vercel serverless, health-scored, 10 upstreams)
   ┌───────────────────────────────────────────────────────────┐
   │ dRPC(auth) · Alchemy Arc · rpc.testnet.arc.io ×4 · .network ×4 │
   └───────────────────────────────────────────────────────────┘

                    ┌──────────── SUPABASE ────────────┐
                    │  claim-worker      (cron 1min)   │
                    │  deposit-scan-all  (cron 1min +  │
                    │                     10min recon) │
                    │  claim-recovery-scan (client-    │
                    │                       invoked)   │
                    │  claim-submit, wallet-key        │
                    │  Realtime: activity, claims,     │
                    │   messages, notifications, p2p   │
                    └──────────────────────────────────┘
```

## 2. Complete dependency map

### 2.1 Provider / client construction sites

| # | File:line | Construct | Cached? | Notes |
|---|---|---|---|---|
| 1 | `src/lib/arc.ts:51` | viem `fallback(http)` over `ARC_RPCS` | **No** | new transport per `arcTransport()` call |
| 2 | `src/lib/arcService.ts:77,129,205,253` | `createPublicClient` / `createWalletClient` | No | 4 sites, one per operation |
| 3 | `src/lib/p2pChain.ts:37` | `createPublicClient` | No | |
| 4 | `src/lib/p2pEscrowContract.ts:154,290,304,314,333` | `createPublicClient`/`WalletClient` | No | 5 sites |
| 5 | `src/lib/rewards.ts:269,273` | both | No | |
| 6 | `src/features/bulkpayout/BulkPayoutPage.tsx:282` | both | No | in component |
| 7 | `src/lib/ubFundRecovery.ts:67-73` | ethers `JsonRpcProvider`+`FallbackProvider` | **Yes** (module) | `_arcProvider` |
| 8 | `src/features/multichain/MultichainSendPage.tsx:74-195` | ethers, 3 factories | **Yes** (module, 3 maps) | plus poison-eviction |
| 9 | `src/features/multichain/MultichainClaimPage.tsx:315,413` | ethers, per-call | **No** | rebuilt each invocation |
| 10 | `src/components/ui/ClaimFundsWidget.tsx:80-93` | ethers | Yes (`_cache`) | **component unmounted — dead** |
| 11 | `api/relay-deposit.js:141` | ethers server-side | per-invocation | |
| 12 | `api/swap-proxy.js:344-380` | ethers + custom subclass | per-invocation | |
| 13 | `api/relay-gas.ts:107` | viem wallet client | per-invocation | |
| 14 | `supabase/functions/*` | raw `fetch` JSON-RPC | n/a | `rpcCall(urls,…)` |

**Finding:** 9 distinct provider-construction strategies for the same Arc chain.
Three independent module-level caches (`ubFundRecovery`, `MultichainSendPage`,
`ClaimFundsWidget`) that never share an instance.

### 2.2 RPC endpoint sources — four separate lists

| List | Location | Chains | Consumed by |
|---|---|---|---|
| `ARC_RPCS = ['/api/arc-rpc']` | `src/lib/arc.ts:31` | Arc | all client Arc traffic |
| `ARC_RPCS` (10 upstreams) | `api/arc-rpc.js:68-83` | Arc | the proxy itself |
| `CHAIN_CONFIG` (21 chains, 1-3 RPC each) | `src/lib/externalChainBalances.ts:38` | external | balance scans |
| `RPC_BY_CHAIN_NAME` (28 keys) | `src/lib/chainRpcs.ts:32` | external | Send/Claim providers |
| `CHAIN_RPCS` (dRPC-authed) | `supabase/functions/_shared/chains.ts:23` | external | workers |

`api/swap-proxy.js:378` and `api/relay-deposit.js:141` each hold a **fourth and
fifth manually-synced copy** of the Arc list — the code comments at
`src/lib/chainRpcs.ts:18-20` acknowledge these have already drifted.

### 2.3 Client timers touching the chain

| Interval | Source | Cost per fire | Notes |
|---|---|---|---|
| **per block (~2s)** | `realtimeDeposits.ts:136,173` | 1 `eth_getBlockByNumber(full=true)` **direct to Alchemy** | biggest single cost |
| 12s | `useActivity.ts:175` | 2 ArcScan REST | Activity mounted |
| 20s | `SwapPage.tsx:702` | 1 swap-proxy quote | Swap mounted |
| 30s | `HomePage.tsx:1744` | 1 `eth_getBalance` | |
| 30s | `useArcWallet.ts:34` | 1 `eth_getBalance` | **hook never imported — dead** |
| 60s | `HomePage.tsx:1782` | 21 `eth_call` | external scan |
| 60s | `MultichainPage.tsx:127` | 21 `eth_call` | external scan (dedup by 20s TTL) |
| 60s (+15s offset) | `HomePage.tsx:1747` | 2 `eth_call` + 2 price APIs | portfolio |
| 6s | `claimService.ts:238,320` | 1 Supabase read | per claim + per wallet |
| 5s | `MultichainClaimPage.tsx:637` | 1 `claim-worker` invoke | per pending claim |
| 20s | `AppLayout.tsx:150` | key restore retry | only while key missing |
| 15s | `App.tsx:456` | passcode arm check | no RPC |
| 60s | `App.tsx:531` | broadcast notif | no RPC |

Plus **visibilitychange** handlers that re-fire scans: `HomePage.tsx:1784`,
`MultichainPage.tsx:129`, `AppLayout.tsx:110,132,222`, `claimService.ts:261,330`,
`useActivity.ts:178`, `chatService.ts:167`.

### 2.4 Server-side workers

| Worker | Trigger | Loop | Responsibility |
|---|---|---|---|
| `claim-worker` | pg_cron `* * * * *` + `claim-submit` + client kick | 50s internal, 8s tick | claim state machine `submitted→…→completed` |
| `deposit-scan-all` | pg_cron `* * * * *` (sweep) + `*/10` (reconcile) + client WS trigger | 50s internal, 8s tick | native USDC block scan + ERC20 `eth_getLogs` for **all** wallets |
| `claim-recovery-scan` | client, on mount + refocus, **per wallet** | none | untracked-mint recovery + external receive backstop |
| `claim-submit` | client | none | insert `claims` row, kick worker |
| `wallet-key` | client | none | server-side key derivation |
| `claim-attention-scan` | **removed** (`20260720160000`) | — | cron unscheduled, table dropped |

### 2.5 Feature → data-source matrix

| Feature | Arc native | Arc ERC20 | 21 chains | ArcScan | Supabase | Realtime |
|---|---|---|---|---|---|---|
| Home balance | ✓ 30s | ✓ 60s | ✓ 60s | — | ✓ | ✓ activity+messages |
| Multichain Hub | ✓ on demand | — | ✓ 60s | — | ✓ | ✓ claims |
| Claim | ✓ post-claim | — | ✓ on mount | — | ✓ | ✓ claims |
| Multichain Send | ✓ post-send | — | ✓ per tx | — | ✓ | — |
| Activity | — | — | — | ✓ 12s | ✓ paginated | ✓ activity |
| Swap | ✓ pre/post | ✓ | — | — | ✓ | — |
| Send | ✓ post-send | — | — | — | ✓ | — |
| Chat | ✓ post-pay | ✓ post-pay | — | — | ✓ | ✓ messages |
| Contacts | ✓ post-pay | — | — | — | ✓ | — |
| Rewards | ✓ contract | — | — | — | ✓ | — |
| P2P | ✓ escrow | — | — | — | ✓ | ✓ trades |
| Insights | store read | — | — | — | ✓ | — |
| Treasury | **none** | — | — | — | — | — |
| Receive | **none** | — | — | — | — | — |

Treasury and Receive are already pure — they need no migration.

## 3. Current RPC flow

```
Arc reads (balances, eth_call):
  page → balanceCache/arcService → arcRpcJson() → POST /api/arc-rpc
       → health-score sort → stagger 150ms → race up to 10 upstreams
       → quarantine failures (10s→2min backoff) → return

Arc writes (send, swap, escrow, rewards):
  page → arcService/p2pEscrow → viem createPublicClient(arcTransport())
       → same /api/arc-rpc → nonce → estimateGas → sendTransaction
       → confirmTransactionInBackground() (non-blocking receipt poll)

External chain reads (21 chains):
  page → externalChainBalances.scanAllChainBalances()
       → staggeredMap(batch 5, 400ms gap)
       → fetch(publicRPC) DIRECT FROM BROWSER — no proxy, Alchemy key in bundle

External chain writes (bridge/claim):
  page → Circle AppKit → ethers provider (per-page factory) → public RPC

Realtime deposit detection:
  browser → wss://arc-testnet.g.alchemy.com (key in bundle)
       → newHeads (every block) → eth_getBlockByNumber(block, TRUE)
       → filter tx.to client-side → POST deposit-scan-all
```

**Critical observation on the last path.** `realtimeDeposits.ts:173-197` fetches
**every block with full transaction bodies** to check whether any `tx.to`
matches one address. On Arc's ~2s block time that is ~1,800 full-block fetches
per hour per open tab, billed at Alchemy's highest per-call weight
(`eth_getBlockByNumber` with `true` is 16 CU vs 11 for `eth_getBalance`).
`deposit-scan-all` already performs this identical scan server-side, once, for
every wallet simultaneously (`supabase/functions/deposit-scan-all/index.ts:50-56`).
The client path is a **per-user duplicate of a per-fleet job**.

## 4. Current event flow

```
EVENT SOURCE            → CONSUMER                          → EFFECT

Supabase Realtime
  activity INSERT       → ActivityService.subscribeToActivity → useActivity list
                        → HomePage:1233 (messages channel)    → refreshBalanceForToken()
  claims  UPDATE        → claimService.subscribeToClaim       → MultichainClaimPage
                        → subscribeToWalletClaims             → MultichainPage
  messages INSERT       → ChatPage, BottomNav, HomePage       → unread + balance
  p2p_trades            → p2pService, p2pNotifications        → P2P UI
  notifications         → p2pNotifications                    → bell

Alchemy WebSocket
  newHeads              → realtimeDeposits (block fetch)      → CustomEvent
  logs(Transfer,to=me)  → realtimeDeposits                    → CustomEvent

window CustomEvent 'meshport:onchain-activity'
                        → useActivity.ts:184                  → ArcScan refetch
  (dispatched by realtimeDeposits:68 AND HomePage:1641 on balance-increase)

document visibilitychange
                        → 8 independent handlers              → assorted rescans

Timers (§2.3)           → direct fetch                        → setState
```

There is **one** app-level custom event (`meshport:onchain-activity`) and it has
exactly one consumer. Everything else is point-to-point. There is no
"chain X changed for wallet Y" signal anywhere in the system — which is precisely
why every consumer polls.

## 5. Current synchronization model

| Domain | Authority | Propagation | Gap |
|---|---|---|---|
| Claim status | `claims` table, `claim-worker` | Realtime + 6s poll | none — this is the good one |
| Arc balance | the chain | 30s poll + 600ms debounced realtime | up to 30s stale |
| External balances | the chain | 60s poll ×3 pages, 20s shared TTL | up to 60s stale, cross-page divergence |
| Activity | `activity` table + ArcScan | Realtime + 12s poll | dual-source dedup by txHash |
| Deposits | `deposit-scan-all` cursor | cron 1min / 8s internal | ~8s typical |
| Pending tx | none — fire-and-forget | `confirmTransactionInBackground` | **no store record; refresh loses it** |

The claim pipeline is the only domain with a real authority + push model. It is
the template the rest should follow.

## 6. Current caching

| Cache | Location | Key | TTL | Scope |
|---|---|---|---|---|
| Arc token balance | `balanceCache.ts:42` | token only | 4s | module; **address not in key** |
| External scan | `externalChainBalances.ts:189` | address | 20s | module, whole-scan granularity |
| BTC price | `HomePage.tsx:1725` | — | session | sessionStorage |
| Provider (Send) | `MultichainSendPage.tsx:71-88` | rpcUrl | ∞ | module |
| Provider (UB) | `ubFundRecovery.ts:60` | — | ∞ | module |
| Conversations | `chatService.ts` | — | invalidated | |
| Persisted balance | `store/index.ts:21` | address | ∞ | localStorage, USDC only |

Two real defects:

- **`balanceCache.ts:42` keys by token, not by address.** A wallet switch inside
  the 4s window returns the previous wallet's balance. Practically narrow (the
  store resets on switch) but it is a correctness bug, not a tuning issue.
- **External cache is all-or-nothing.** One chain's fresh value cannot be
  reused without re-running or re-caching all 21.

## 7. Current polling inventory

Steady state, one tab, Home + Activity mounted, one pending claim:

| Source | Requests/hour |
|---|---|
| `newHeads` block fetches (~2s blocks) | **~1,800** |
| ArcScan 12s ×2 endpoints | 600 |
| External scan 60s ×21 chains | 1,260 |
| Home balance 30s | 120 |
| Portfolio 60s (2 RPC + 2 price) | 240 |
| Claim fallback poll 6s ×2 channels | 1,200 (Supabase) |
| Claim worker kick 5s | 720 (function invokes) |
| **Chain-facing total** | **≈ 4,020/hr/tab** |

With the Hub also mounted, add another 1,260/hr (partially absorbed by the 20s TTL).

## 8. Current Supabase flow

```
WRITES
  claim-submit      → claims INSERT → kick claim-worker
  claim-worker      → claims UPDATE, activity INSERT, notifications INSERT
  deposit-scan-all  → activity INSERT (recordExternalReceive), cursor UPDATE
  claim-recovery    → claims INSERT (recovered), activity INSERT
  client            → activity, messages, p2p_*, users, support_tickets

READS
  fetchActivity (paginated), fetchClaimsForWallet, get_and_mark_unnotified_claims (RPC),
  mark_claim_notified (RPC), app_settings, users, contacts

REALTIME CHANNELS (per session)
  activity:{addr} · claim-{id}×N · claims-wallet-{addr} · nav-unread-{uid}
  · recv-{uid}-{addr} · chat conv · p2p_offers · p2p_trades · notifications
  · app_settings_changes · support_tickets_{uid}
  → 8-12 concurrent channels typical
```

RLS is correctly restrictive: the client cannot write `claims` — hence the
`get_and_mark_unnotified_claims` RPC (`AppLayout.tsx:211`), added after a silent
zero-row-update bug. This is the right pattern and the indexer must follow it.

## 9. Duplicate requests — confirmed instances

| # | Duplication | Evidence | Current mitigation |
|---|---|---|---|
| D1 | Home + Hub + Claim each scan 21 chains on independent 60s timers | `HomePage:1782`, `MultichainPage:127`, `MultichainClaimPage:797` | 20s TTL absorbs *some* |
| D2 | Client block-scan duplicates server block-scan | `realtimeDeposits:173` vs `deposit-scan-all:50-56` | **none** |
| D3 | ArcScan 12s poll duplicates Realtime `activity` INSERT | `useActivity:175` vs `:122` | dedup by txHash after both fired |
| D4 | Post-transaction balance refetch in 8 pages | Send:546, Swap:825, Chat:2052/2172, Contacts:263, MCSend:1476/1864, MCClaim:657, bgBridge:395 | 4s `balanceCache` window only |
| D5 | Two `visibilitychange` handlers → 2 concurrent 21-chain scans | `HomePage:1784` + `MultichainPage:129` | `inFlight` flag is *per component* |
| D6 | `useArcWallet` 30s poll would double Home's | `useArcWallet.ts:34` | **hook is never imported — dead code** |
| D7 | Claim page 5s worker kick + 6s claim poll + Realtime | `MCClaim:637`, `claimService:238` | three paths to one status |
| D8 | Chat + BottomNav both subscribe `messages` and both refetch unread | `ChatPage:184`, `BottomNav:129` | none |
| D9 | Balance-increase dispatches the same event the WS already dispatches | `HomePage:1641` vs `realtimeDeposits:68` | debounce only |

## 10. Bottlenecks

**B1 — `newHeads` full-block fetch (`realtimeDeposits.ts:173`).**
Highest-cost path in the app; scales linearly with concurrent users × block rate;
duplicates server work; requires `VITE_ALCHEMY_ARC_KEY` **in the client bundle**,
which the file's own header (lines 37-44) flags as unacceptable for mainnet.

**B2 — 21-chain fan-out from the browser (`externalChainBalances.ts:202`).**
21 sequential-batched `eth_call`s to public RPCs, no proxy, no auth, no shared
budget. `staggeredMap(5, 400ms)` means a full scan takes ≥1.6s wall-clock and
occupies browser connection slots. Runs on 3 pages.

**B3 — Provider construction per call.** `arcTransport()` builds a new viem
`fallback` transport on every invocation; `arcService` builds a fresh
`createPublicClient` per operation. No connection reuse, no shared nonce view,
no shared block cache.

**B4 — No pending-transaction registry.** `confirmTransactionInBackground`
(`arcService.ts:73`) resolves into a closure. A page refresh between submit and
confirm loses the pending state entirely; the UI has no durable "in flight" list.

**B5 — Page-local state.** Navigating Home → Hub → Home refetches everything
because state lived in `useState`.

**B6 — Cache key omits address (`balanceCache.ts:42`).**

**B7 — Five drifting copies of the Arc RPC list** (§2.2).

**B8 — 8-12 Realtime channels/session.** At scale this is the Supabase-side
scaling limit, before RPC ever becomes the constraint.

## 11. Scalability limits

| Dimension | Today | Ceiling |
|---|---|---|
| RPC/user/hr (idle) | ~4,000 | dRPC/Alchemy quota at ~2-5k concurrent users |
| Alchemy CU/user/hr | ~30k (block fetches dominate) | free tier ≈ 1 user-hour |
| External RPC | unauthenticated public endpoints | rate-limited per-IP; **already** produced dead-endpoint incidents (`chainRpcs.ts:38-60`) |
| Realtime channels | 8-12/session | Supabase connection cap |
| `deposit-scan-all` | scans **all** wallets per pass | O(wallets × blocks); no sharding |
| Client secrets | `VITE_ALCHEMY_KEY`, `VITE_ALCHEMY_ARC_KEY` in bundle | **mainnet blocker** |
| Chain onboarding | edit 5 lists | linear maintenance cost |

---

## PART II — PROPOSED ARCHITECTURE

## 12. Design principles

Drawn from how production wallets solve this, applied originally to MeshPort:

1. **One chain-access owner.** UI never imports a provider (MetaMask's
   controller/UI split).
2. **Push over poll.** The server observes the chain; clients receive events
   (Rainbow/Zerion indexer model).
3. **Surgical invalidation.** Refresh `(wallet, chain, asset)`, never "everything".
4. **In-flight coalescing + batching** (Rabby's request layer).
5. **Stale-while-revalidate.** Render cached instantly, refresh underneath.
6. **Provider health as a first-class concern** — already true in
   `api/arc-rpc.js`; generalize it to all chains.
7. **Keys and quotas server-side.** No provider credential in the bundle.

## 13. Proposed architecture diagram

```
┌───────────────────────────── BROWSER ─────────────────────────────┐
│                                                                   │
│  Home  Hub  Claim  Activity  Send  Receive  Swap  Chat  Contacts  │
│  Treasury                                                         │
│     │ read-only selectors + intent calls (send/claim/swap)        │
│     ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ BlockchainStore (zustand)                                   │  │
│  │  balances{wallet:chain:asset} pending[] claims[] history[]  │  │
│  │  claimable{} status{} errors{} timestamps{}                 │  │
│  └───────────────▲─────────────────────────────────────────────┘  │
│                  │ writes only from manager                       │
│  ┌───────────────┴─────────────────────────────────────────────┐  │
│  │ BlockchainManager  — sole chain entry point                 │  │
│  │  dedupe · batch · TTL+SWR cache · retry · optimistic ·      │  │
│  │  pending-tx registry · receipt watcher                      │  │
│  └───────┬──────────────────────────────┬──────────────────────┘  │
│          │                              │                         │
│  ┌───────▼────────┐            ┌────────▼─────────┐               │
│  │ ProviderManager│            │ SyncCoordinator  │               │
│  │ 1 client/chain │            │ triggers only:   │               │
│  │ singleton      │            │ launch·login·    │               │
│  │ health+failover│            │ wallet·tx·event· │               │
│  │ multicall3     │            │ manual·resume>5m │               │
│  └───────┬────────┘            └────────▲─────────┘               │
└──────────┼──────────────────────────────┼─────────────────────────┘
           │                              │ chain_events (Realtime)
           ▼                              │
   ┌───────────────┐            ┌─────────┴──────────────────────┐
   │ /api/rpc/:chain│           │        SUPABASE                │
   │ (proxy, keys   │           │  BlockchainIndexer (cron)      │
   │  server-side,  │◄──────────┤   Arc head + ERC20 logs +      │
   │  health-scored)│           │   external balance deltas      │
   └───────┬────────┘           │      ↓ writes                  │
           │                    │   activity · balances_cache ·  │
           ▼                    │   chain_events  → Realtime     │
  Arc + 21 external chains      │  claim-worker (independent)    │
                                │  claim-submit · wallet-key     │
                                └────────────────────────────────┘
```

## 14. BlockchainIndexer

Single authoritative synchronization service. Absorbs `deposit-scan-all`
wholesale and the external-receive backstop half of `claim-recovery-scan`.

**Responsibilities:** follow Arc head; detect native transfers, ERC-20 transfers,
CCTP mints; resolve `(wallet, chain, asset)` affected; persist; emit one
`chain_events` row per logical change.

**Flow (implements the requested pipeline literally):**

```
Arc chain
   ↓ cursor-windowed block scan (reuses deposit-scan-all's proven logic)
BlockchainIndexer
   ↓ match tx.to / Transfer topic against known-wallet set (in-memory)
Determine affected wallet   → wallet_address
Determine affected chain    → 'Arc_Testnet' | source chain
   ↓
Persist  → activity INSERT (idempotent on tx_hash)
         → balances_cache UPSERT (wallet, chain, asset, amount, block)
   ↓
Publish  → INSERT chain_events {wallet, chain, assets[], kind, tx_hash, block}
   ↓ Supabase Realtime (filter: wallet_address=eq.<addr>)
BlockchainManager.onChainEvent(evt)
   ↓
invalidate(wallet, chain, assets) → refresh ONLY those keys
   ↓
BlockchainStore.patch()
   ↓
UI re-renders (subscribed selectors only)
```

**Proposed `chain_events` schema**

```sql
create table chain_events (
  id           bigserial primary key,
  wallet_address text not null,
  chain        text not null,
  kind         text not null,   -- deposit|transfer_in|transfer_out|claim_completed
                                -- |bridge_completed|balance_changed|tx_confirmed|tx_failed
  assets       text[] not null default '{}',
  tx_hash      text,
  block_number bigint,
  metadata     jsonb default '{}',
  created_at   timestamptz not null default now()
);
create index on chain_events (wallet_address, created_at desc);
create unique index on chain_events (tx_hash, kind, wallet_address)
  where tx_hash is not null;               -- idempotency
-- RLS: select where wallet_address = own; insert service_role only.
-- Retention: delete where created_at < now() - interval '7 days' (cron).
```

The partial unique index makes re-processing a block harmless — the core
property that lets the indexer restart, catch up, or overlap safely.

**Why this replaces the client WebSocket.** Today each tab independently
discovers deposits. With `chain_events`, one server-side observer serves every
user, and clients need only a Realtime subscription they already maintain a
connection for. Kills B1 and removes `VITE_ALCHEMY_ARC_KEY` from the bundle.

**Modes:** `sweep` (cron, self-looping ~8s ×50s — same shape as today),
`reconcile` (10min ArcScan backstop, unchanged), `wallet` (on-demand catch-up
for one wallet at login).

## 15. BlockchainManager

Sole client-side owner of chain access. No UI component may import a provider,
`arcService`, `balanceCache` or `externalChainBalances` after migration.

```ts
// src/blockchain/BlockchainManager.ts  (interface sketch — not final code)
interface BlockchainManager {
  // reads — always resolve from cache first (SWR), refresh underneath
  getBalance(wallet, chain, asset): Promise<Amount>
  getBalances(wallet, chain, assets[]): Promise<Record<Asset, Amount>>   // multicall
  getClaimableBalances(wallet): Promise<ChainBalance[]>                   // 21-chain scan
  getHistory(wallet, opts): Promise<ActivityRecord[]>
  getTransaction(chain, hash): Promise<TxStatus>

  // writes — optimistic, registers pending tx, watches receipt
  sendNative(p): Promise<TxHandle>
  sendToken(p):  Promise<TxHandle>

  // invalidation
  invalidate(wallet, chain?, assets?): void
  refresh(scope: RefreshScope): Promise<void>

  // lifecycle
  onChainEvent(evt: ChainEvent): void
  start(wallet): void
  stop(): void
}
```

**Responsibilities and how each is met**

| Requirement | Mechanism |
|---|---|
| Deduplication | `Map<CacheKey, Promise>` of in-flight reads; second caller awaits the same promise |
| Batching | 16ms microtask window collects `getBalance` calls per chain → one Multicall3 `eth_call`, or a JSON-RPC batch array where Multicall3 is absent |
| Caching | TTL + SWR (§18) |
| Synchronization | `SyncCoordinator` is the only thing that decides *when* |
| Optimistic updates | on submit: patch store immediately (`balance − amount`, pending row); on receipt: reconcile; on revert: roll back |
| Retry | exponential backoff, jitter; **never** retry a signed send (idempotency) — only reads and receipt lookups |
| SWR | `stale` served instantly, revalidation deduped |
| Provider selection | delegated to ProviderManager |
| Balance/tx/chain refresh | `refresh(scope)` with scoped keys (§19) |

**Cache key.** `${wallet}:${chain}:${asset}` — fixes B6 by construction.

**Pending-tx registry** (fixes B4). Persisted to localStorage under
`meshport-pending-tx-v1-<wallet>`; rehydrated on launch; each entry re-attaches
a receipt watcher. Survives refresh — currently impossible.

## 16. ProviderManager

```ts
interface ProviderManager {
  get(chain: ChainId): PublicClient           // singleton per chain
  getSigner(chain, account): WalletClient
  health(chain): { endpoint, successRate, avgLatencyMs, quarantinedUntil }[]
  report(chain, endpoint, ok, latencyMs): void
}
```

- **One instance per chain**, module-level `Map<ChainId, PublicClient>`, created
  lazily, never rebuilt per call.
- **Fallback + failover**: port `api/arc-rpc.js`'s health scoring (success rate
  primary, latency secondary, exponential quarantine 10s→2min) into a reusable
  transport used for **all** chains, not just Arc. That logic is already
  production-proven here — this generalizes rather than invents.
- **Static network descriptors** everywhere (`ARC_NETWORK` pattern,
  `src/lib/arc.ts:45`) so no `eth_chainId` probe and no ethers v6 infinite
  retry loop.
- **Connection reuse**: one transport per chain ⇒ HTTP keep-alive holds.
- **Single chain registry** `src/blockchain/chains.ts` replacing the five lists
  in §2.2; server functions import a generated mirror so they cannot drift.
- **All external chains proxied** through `/api/rpc/:chain` so provider keys
  leave the bundle (mainnet requirement).

## 17. Global Blockchain Store

```ts
interface BlockchainState {
  balances: Record<`${Wallet}:${Chain}:${Asset}`, {
    amount: number; updatedAt: number; status: 'fresh'|'stale'|'loading'|'error'; error?: string
  }>
  unified: Record<Wallet, { arcTotalUsd: number; externalTotalUsd: number; updatedAt: number }>
  claimable: Record<Wallet, { chains: ChainBalance[]; updatedAt: number; scanning: boolean }>
  pending:   PendingTx[]          // persisted
  claims:    Record<ClaimId, Claim>
  history:   Record<Wallet, { items: ActivityRecord[]; cursor?: string; hasMore: boolean }>
  sync:      Record<Chain, { lastSyncAt: number; inFlight: boolean; lastError?: string }>
  prices:    Record<Asset, { usd: number; change24h: number|null; updatedAt: number }>
}
```

Covers every field the brief lists: Arc balances, native balances, USDC, EURC,
cirBTC, external, unified, pending tx, pending claims, history, claimable,
loading, errors, timestamps, sync status.

**Selectors** (the only thing UI imports):

```ts
useArcBalance(asset)            useUnifiedBalance()
useExternalBalances()           useClaimable()
usePendingTxs()                 useClaimStatus(id)
useActivityFeed(filter)         useSyncStatus(chain)
```

Existing `useWalletStore.balance` is kept as a **derived alias** during
migration — no page breaks on day one.

## 18. Cache flow

```
read(key)
  ├─ fresh (age < TTL)              → return cached, NO network
  ├─ stale (TTL < age < staleMax)   → return cached NOW
  │                                   + revalidate in background (deduped)
  ├─ in-flight                      → await existing promise (no 2nd request)
  └─ miss                           → fetch, populate, notify store

invalidate(wallet, chain, assets)   → mark stale (NOT delete)
                                      → next read serves last-known instantly
                                        while refreshing → no UI flash
```

| Data | TTL | Stale-max | Invalidated by |
|---|---|---|---|
| Arc native/ERC20 | 15s | 5min | `chain_events`, own tx confirm, manual |
| External per-chain | 60s | 10min | `chain_events` for that chain, claim complete |
| Claimable aggregate | 60s | 10min | any external change, claim complete |
| Tx receipt | until terminal | — | receipt watcher |
| Prices | 60s | 15min | timer while visible |
| History page | 30s | 5min | activity Realtime INSERT |

Deleting on invalidate causes the balance-flash-to-zero problem. Marking stale
keeps the last good value on screen — this is why `invalidate` never evicts.

## 19. Smart refresh strategy

`RefreshScope` is a discriminated union — there is no "refresh everything" call:

```ts
type RefreshScope =
  | { kind: 'asset';      wallet; chain; asset }
  | { kind: 'chain';      wallet; chain }
  | { kind: 'arc' ;       wallet }
  | { kind: 'external';   wallet; chains?: Chain[] }
  | { kind: 'claims';     wallet }
  | { kind: 'history';    wallet }
  | { kind: 'all';        wallet }      // launch / login / wallet-import ONLY
```

| Event | Scope refreshed |
|---|---|
| Arc deposit detected | `{asset, Arc, USDC}` + history |
| EURC transfer in | `{asset, Arc, EURC}` + history |
| Base deposit detected | `{chain, Base}` + claimable |
| Claim completed | `{asset, Arc, USDC}` + `{chain, sourceChain}` + claims |
| Own send confirmed | `{asset}` for the sent asset + history |
| Swap completed | both legs' assets only |
| Bridge completed | source chain + Arc |
| App resume < 5min | **nothing** |
| App resume ≥ 5min | `{arc}` + `{claims}`; external only if ≥ 10min |
| Manual pull-to-refresh | `{all}` |
| Login / wallet import | `{all}` |

**Full 21-chain scans occur only on**: login, wallet import, manual refresh,
opening Hub/Claim with claimable data older than 10 minutes. Never on a timer.

## 20. Request deduplication strategy

```
BEFORE                                  AFTER
Home  → getUSDCBalance() → RPC          Home  ─┐
Hub   → getUSDCBalance() → RPC          Hub   ─┼→ BlockchainManager
Claim → getUSDCBalance() → RPC          Claim ─┘        │
3 requests                                      key hit? → cached (0 RPC)
                                                in-flight? → await same promise
                                                else → 1 RPC → shared response
                                                        ↓
                                                   BlockchainStore
                                                        ↓
                                                Home / Hub / Claim
```

Three layers:

1. **In-flight sharing** — `inFlight: Map<CacheKey, Promise<T>>`; entry cleared
   in `finally`.
2. **Microtask batching** — reads enqueued within one 16ms tick are grouped per
   chain and issued as a single Multicall3 `eth_call` (Arc: USDC+EURC+cirBTC →
   **1 request instead of 3**), or a JSON-RPC batch where Multicall3 isn't
   deployed. The 21-chain scan becomes 21 requests total with no per-chain
   duplication across pages.
3. **Event coalescing** — `chain_events` arriving within 300ms for the same
   wallet merge into one invalidation pass (replaces
   `HomePage.tsx:940-963`'s local debounce, generalized).

## 21. Workers: merge, keep, remove

### Merge into BlockchainIndexer

| Worker | Rationale |
|---|---|
| `deposit-scan-all` | *Is* the indexer already — cursor-windowed block scan + ERC-20 `eth_getLogs` for all wallets. Becomes the indexer's `sweep` mode; adds `chain_events` emission. Its `reconcile` mode becomes the indexer's reconcile mode unchanged. |
| `claim-recovery-scan` — **external-receive branch only** | Its non-mint branch does the same "incoming transfer with no activity row" detection as `deposit-scan-all`, but only for one wallet when a tab is open. Redundant once the indexer runs fleet-wide. |

### Keep independent — with justification

**`claim-worker` — keep, do not merge.** Different problem class. The indexer is
a *stateless observer* (read blocks → emit facts). `claim-worker` is a *stateful
orchestrator*: a 5-stage state machine with per-claim attempt budgets, `SKIP
LOCKED` row locking, Circle attestation-API dependency, a separate settling
budget, and a stuck-claim watchdog (`claim-worker/index.ts:472-500, 1006`).
Merging would couple claim liveness to indexer throughput — a slow block scan
would stall claim settlement, which is the single most user-visible flow.
Instead: the indexer *feeds* it. When the indexer sees a CCTP mint it emits
`kind:'claim_completed'`, letting `claim-worker` confirm arrival from an event
rather than by scanning logs itself — strictly less RPC on both sides.

**`claim-recovery-scan` — keep, narrowed.** Its unique value is the CCTP
`MessageReceived` → `sourceDomain` decode that recovers claims with **no
`claims` row at all** (app closed between approval and burn confirmation —
observed in real testing per its header). That is genuine reconciliation logic,
not observation. Keep it; delete only its duplicated external-receive branch;
keep it client-invoked (it only matters for a wallet actually in use).

**`claim-submit` — keep.** Thin authenticated write + worker kick. Correct as is.

**`wallet-key` — keep.** Security-critical, unrelated to chain sync. Do not touch.

### Remove entirely

| Target | Reason |
|---|---|
| `src/hooks/useArcWallet.ts` | **Verified dead** — zero importers; carries a 30s balance poll |
| `src/components/ui/ClaimFundsWidget.tsx` | **Verified unmounted** — zero importers; carries its own ethers provider cache and a 5s balance-delta poll |
| `src/lib/realtimeDeposits.ts` | Replaced by `chain_events`; removes B1 and the bundled Alchemy key |
| `src/lib/balanceCache.ts` | Superseded by manager cache (and address-key bug) |
| `claim-attention-scan` | Already removed (`20260720160000`); mentioned for completeness |

## 22. File-by-file migration plan

### Files to CREATE

| Path | Purpose |
|---|---|
| `src/blockchain/chains.ts` | Single chain registry (id, chainId, rpcs, tokens, multicall3, explorer) |
| `src/blockchain/ProviderManager.ts` | Singleton clients, health, failover |
| `src/blockchain/healthTransport.ts` | Reusable health-scored transport (port of `api/arc-rpc.js` logic) |
| `src/blockchain/BlockchainManager.ts` | Sole chain entry point |
| `src/blockchain/cache.ts` | TTL + SWR + in-flight map |
| `src/blockchain/batch.ts` | Microtask batching / Multicall3 |
| `src/blockchain/pendingTx.ts` | Persistent pending-tx registry + receipt watchers |
| `src/blockchain/SyncCoordinator.ts` | The only scheduler |
| `src/blockchain/events.ts` | `chain_events` Realtime subscription → manager |
| `src/blockchain/types.ts` | Shared types |
| `src/store/blockchainStore.ts` | Reactive store |
| `src/store/blockchainSelectors.ts` | Hooks UI imports |
| `supabase/functions/blockchain-indexer/index.ts` | Indexer (from `deposit-scan-all`) |
| `supabase/migrations/<ts>_chain_events.sql` | Table + RLS + indexes + retention |
| `supabase/migrations/<ts>_balances_cache.sql` | Server-side balance snapshot |
| `supabase/migrations/<ts>_blockchain_indexer_cron.sql` | Reschedule cron |
| `api/rpc/[chain].js` | Generalized proxy for all chains |
| `docs/BLOCKCHAIN_ARCHITECTURE.md` | Post-migration living doc |

### Files to MODIFY

| Path | Change | Risk |
|---|---|---|
| `src/features/home/HomePage.tsx` | Remove 3 polling effects + debounce block (`940-973`, `1606-1786`); read selectors | Med — largest surface |
| `src/features/multichain/MultichainPage.tsx` | Remove 60s scan (`105-131`); selectors | Low |
| `src/features/multichain/MultichainClaimPage.tsx` | Providers → ProviderManager (`303-320`, `412-417`); keep claim flow intact | **High** — Circle SDK |
| `src/features/multichain/MultichainSendPage.tsx` | Delete 3 local provider factories (`70-195`) → ProviderManager | **High** — Circle SDK |
| `src/features/swap/SwapPage.tsx` | Balance reads via manager; quote polling only while visible + focused | Med |
| `src/features/send/SendPage.tsx` | `sendUSDC` → `manager.sendNative`; drop manual refetch | Low |
| `src/features/chat/ChatPage.tsx` | 4 balance call sites → selectors | Low |
| `src/features/contacts/ContactsPage.tsx` | 1 call site | Low |
| `src/features/activity/ActivityPage.tsx` | Feed from store | Low |
| `src/features/insights/InsightsPage.tsx` | Read store | Low |
| `src/features/bulkpayout/BulkPayoutPage.tsx` | Clients → ProviderManager | Med |
| `src/hooks/useActivity.ts` | **Delete 12s poll** (`171-192`); event-driven | Med |
| `src/lib/arcService.ts` | Keep tx-building; reads move to manager; clients from ProviderManager | Med |
| `src/lib/externalChainBalances.ts` | Becomes a pure per-chain reader; cache/scheduling removed | Med |
| `src/lib/arc.ts` | `arcTransport` delegates to ProviderManager; keep wallet-derivation exports untouched | Low |
| `src/lib/chainRpcs.ts` | Re-export from `blockchain/chains.ts` | Low |
| `src/lib/claimService.ts` | Drop 6s fallback polls (`238`, `320`); keep Realtime | Low |
| `src/lib/backgroundBridge.ts` | Emit intents, no direct balance calls | Med |
| `src/lib/ubFundRecovery.ts` | Provider from ProviderManager | Low |
| `src/lib/p2pEscrowContract.ts`, `p2pChain.ts`, `rewards.ts` | Clients from ProviderManager | Low |
| `src/components/layout/AppLayout.tsx` | Replace `subscribeToWalletActivity` with `chain_events`; keep claim-notify catch-up | Med |
| `src/store/index.ts` | `useWalletStore.balance` → derived alias | Low |
| `supabase/functions/claim-recovery-scan/index.ts` | Delete external-receive branch | Med |
| `supabase/functions/claim-worker/index.ts` | Consume `chain_events` for arrival confirmation | Med |
| `api/arc-rpc.js` | Keep; becomes `api/rpc/arc` alias | Low |
| `.env.example` | Remove `VITE_ALCHEMY_ARC_KEY`; document server vars | Low |

### Files to DELETE

| Path | Verification |
|---|---|
| `src/hooks/useArcWallet.ts` | `grep -rn "useArcWallet" src/` → no importers |
| `src/components/ui/ClaimFundsWidget.tsx` | `grep -rn "ClaimFundsWidget" src/` → no importers |
| `src/lib/realtimeDeposits.ts` | after Phase 3 |
| `src/lib/balanceCache.ts` | after Phase 2 |
| `supabase/functions/deposit-scan-all/` | after indexer verified (Phase 3) |

## 23. Risks and mitigation

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Circle AppKit needs its own ethers provider shape; ProviderManager returns viem | **High** | ProviderManager exposes `getEthersProvider(chain)` alongside `get()`. Migrate Send/Claim **last** (Phase 5) with the existing factories retained behind a flag |
| R2 | Missing a deposit if indexer lags and client WS is gone | **High** | Do not delete `realtimeDeposits.ts` until the indexer has run ≥7 days with zero missed deposits vs. the reconcile backstop. Keep the 10min ArcScan reconcile permanently |
| R3 | Removing polling exposes a Realtime gap (mobile half-open sockets) | Med | Keep the resume-based refresh (≥5min) as backstop; `chain_events` catch-up query on reconnect using `last_seen_id` — replay, which today's pure pub/sub lacks |
| R4 | Optimistic update diverges from chain | Med | Reconcile on receipt; on revert roll back + toast. Never persist optimistic values to `balances_cache` |
| R5 | `chain_events` table growth | Low | 7-day retention cron; partial unique index bounds duplicates |
| R6 | HomePage is 2,686 lines — refactor risk | **High** | Selector-only edits; no restructuring in the same PR |
| R7 | Behavioral regression in claim flow | **High** | Claim state machine untouched. Only provider construction changes |
| R8 | Multicall3 not deployed on all 21 testnets | Med | Per-chain capability flag in registry; fall back to JSON-RPC batch, then sequential |
| R9 | New proxy becomes a bottleneck | Med | Reuse `api/arc-rpc.js` health/quarantine design; per-chain concurrency caps |
| R10 | Two systems writing `activity` during cutover | Med | Idempotent `tx_hash` dedupe already enforced; run both, compare, then cut |

## 24. Estimated RPC and compute-unit reduction

**Baseline** (1 tab, Home + Activity, 1 pending claim, per hour) — from §7:

| Path | Req/hr | Alchemy CU/hr |
|---|---|---|
| `newHeads` full-block fetch | 1,800 | ~28,800 (16 CU) |
| ArcScan REST | 600 | 0 (not Alchemy) |
| External 21-chain scan | 1,260 | ~3,800 (Alchemy subset ≈ 8 chains) |
| Home balance 30s | 120 | 1,320 |
| Portfolio 60s | 120 | 1,320 |
| **Total** | **≈ 3,900** | **≈ 35,240** |

**After**, same scenario:

| Path | Req/hr | CU/hr | Why |
|---|---|---|---|
| Block scanning | **0** | **0** | server-side, amortized across all users |
| ArcScan REST | ~10 | 0 | event-driven only |
| External scan | ~21 | ~64 | once on entry, not every 60s |
| Arc balances | ~15 | ~165 | Multicall3: 3 assets → 1 call, event-driven |
| Resume refresh | ~10 | ~110 | |
| **Total** | **≈ 56** | **≈ 339** |

| Metric | Before | After | Reduction |
|---|---|---|---|
| Client RPC req/hr/tab | ~3,900 | ~56 | **98.6%** |
| Alchemy CU/hr/tab | ~35,240 | ~339 | **99.0%** |
| Conservative (active user, tx + navigation) | — | — | **~92% req, ~95% CU** |
| Duplicate providers | 9 strategies, 3 caches | 1 per chain | **100%** |
| Duplicate polling loops | 13 | 0 chain-facing | **100%** |
| Duplicate 21-chain scans | 3 pages × 60s | 1 shared, on-demand | **~97%** |

Both exceed the 90% targets. The dominant win is deleting the client block-scan
(B1/D2) — that single path is ~82% of current CU on its own.

Server-side cost rises modestly: the indexer already runs (`deposit-scan-all`),
adding only `chain_events` inserts. Net platform cost falls because per-user
client scanning is replaced by one amortized fleet-wide scan.

## 25. Zero-regression migration strategy

**Principles**

1. **Strangler pattern.** New layer added alongside; call sites move one at a
   time. Old path stays until its replacement is proven.
2. **Behavior-preserving adapters.** `getUSDCBalance(addr)` keeps its exact
   signature and its `catch → return 0` contract, internally delegating to the
   manager. Most call sites change zero lines.
3. **Every phase independently revertible** — one flag, one commit.
4. **Dual-run before delete.** Indexer runs beside `deposit-scan-all`; compare
   emitted events vs. inserted activity rows for ≥7 days before removal.

**Feature flags** (`src/blockchain/flags.ts`, env-driven):

```
BLOCKCHAIN_MANAGER_READS    // route reads through manager
BLOCKCHAIN_MANAGER_WRITES   // route sends through manager
CHAIN_EVENTS_ENABLED        // subscribe to chain_events
DISABLE_LEGACY_POLLING      // kill timers (only after events proven)
UNIFIED_PROVIDERS           // ProviderManager for Circle SDK paths
```

**Regression gate per phase**

- Feature checklist: send/receive USDC · EURC · cirBTC · swap · bridge out ·
  claim in · P2P escrow · bulk payout · rewards · chat pay · contacts pay ·
  activity pagination · deposit detection · wallet import/restore · biometric
  unlock · admin chain toggles.
- Instrumentation: per-phase RPC counter + CU estimate logged to console in dev
  and to `app_settings`-gated telemetry in staging; compare before/after.
- Rollback: flip flag off; legacy path still present.

**Preserved behaviors explicitly verified as requirements**
`arcRpcJson` 429 in-place backoff · `ARC_NETWORK` static-network pinning ·
`staggeredMap` politeness to public RPCs · claim `SKIP LOCKED` + attempt budgets ·
`notifications_cleared_at` watermark · `seen-ids` ledger dedupe ·
idempotent `tx_hash` activity dedupe · admin chain enable/disable via
`isChainEnabledForClaim` · claim progress independent of any open tab.

## 26. Phased implementation roadmap

| Phase | Scope | Deliverables | Exit criteria | Risk |
|---|---|---|---|---|
| **0 — Cleanup** | Delete verified dead code | Remove `useArcWallet.ts`, `ClaimFundsWidget.tsx`; consolidate 5 RPC lists into `blockchain/chains.ts` (re-exported, no behavior change) | Build + typecheck green; no import breaks | **Very low** |
| **1 — Foundation** | Providers + store, nothing wired | `ProviderManager`, `healthTransport`, `blockchainStore`, selectors, `cache.ts`, `batch.ts`; store hydrated in parallel, UI still on old path | Store values match legacy values in dev | Low |
| **2 — Reads** | Route reads through manager | `BlockchainManager` reads; adapters keep old signatures; Home/Hub/Claim/Activity read selectors; delete `balanceCache.ts` | 21-chain scan fires once per entry, not 3×/min; balances identical | Med |
| **3 — Indexer** | Server push | `blockchain-indexer` + `chain_events` + RLS + cron; client subscription; **dual-run** with `deposit-scan-all` | 7 days, zero missed deposits vs reconcile; then delete `deposit-scan-all` + `realtimeDeposits.ts` + `VITE_ALCHEMY_ARC_KEY` | **High** |
| **4 — Event-driven refresh** | Kill polling | `SyncCoordinator`; remove Home 30s/60s, Hub 60s, `useActivity` 12s, claim 6s fallbacks; resume-≥5min rule | RPC counter shows ≥90% drop; no stale-UI reports in staging | Med |
| **5 — Writes & SDK** | Transactions | `manager.sendNative/sendToken`, pending registry, optimistic + rollback; Circle SDK paths (`MultichainSend`, `MultichainClaim`, `BulkPayout`) onto `getEthersProvider` | Every write flow passes checklist; pending tx survives refresh | **High** |
| **6 — Hardening** | Mainnet prep | `/api/rpc/:chain` for all chains; keys out of bundle; retention cron; `docs/BLOCKCHAIN_ARCHITECTURE.md`; load test | No `VITE_*` provider key in `dist/`; documented CU/user | Med |

Phases 0-2 deliver most maintainability gains with low risk. Phase 3 delivers
most of the cost reduction. Phase 5 is highest-risk and deliberately last.

---

## 27. Open questions for review

1. **Supabase access** — offered and useful for Phase 3. Specifically needed:
   confirm `pg_cron`/`pg_net` are enabled, current `deposit-scan-all` cursor
   table shape, actual row counts on `activity`/`claims`, and whether Realtime
   is enabled per-table or globally. Read-only is sufficient for design; Phase 3
   needs migration rights.
2. **Mainnet chain set** — is the 21-testnet list the intended mainnet set, or
   a reduced one? Affects scan cost materially.
3. **Multicall3 availability** — needs per-chain verification; Arc especially.
4. **Alchemy plan** — current tier and CU budget, to set concrete targets.
5. **Native USDC on mainnet Arc** — does the 18-decimal-native / 6-decimal-
   ERC20-wrapper split hold? Several detection paths depend on it.
6. **Retention** — is 7 days right for `chain_events`?

---

## 28. What is explicitly NOT changing

- Claim state machine semantics (`claim-worker` stages, locking, budgets)
- Circle AppKit / CCTP integration logic
- Wallet derivation, BIP39/BIP44, `wallet-key`, biometric, passcode
- RLS policies and the security model of `docs/SECURITY_ARCHITECTURE.md`
- Chat, P2P, rewards, bulk payout, admin business logic
- Any user-visible feature — this is an infrastructure change only






