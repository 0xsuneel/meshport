# MeshPort

**USDC/EURC/cirBTC payments on Arc — send money as easily as sending a message, across 20+ chains, without the recipient ever seeing an address.**

> **Status: Arc Testnet only.** Every chain, contract address, and RPC endpoint in this repository points at a testnet. Nothing here is configured for mainnet. See [Current Status](#current-status) before assuming any feature is production-ready.

---

## Table of Contents

- [Overview](#overview)
- [Problem](#problem)
- [Solution](#solution)
- [Key Features](#key-features)
- [Feature Guide (How It Works)](#feature-guide-how-it-works)
- [Architecture](#architecture)
- [Multichain Architecture](#multichain-architecture)
- [Bulk Pay Architecture](#bulk-pay-architecture)
- [Swap Architecture](#swap-architecture)
- [Chat & Pay](#chat--pay)
- [Project Structure](#project-structure)
- [Feature → Code Mapping](#feature--code-mapping)
- [Tech Stack](#tech-stack)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Security](#security)
- [Transaction Lifecycle](#transaction-lifecycle)
- [Supported Networks and Assets](#supported-networks-and-assets)
- [Deployed Contracts](#deployed-contracts)
- [API / Backend Overview](#api--backend-overview)
- [Database Overview](#database-overview)
- [Developer Guide — Where to Start](#developer-guide--where-to-start)
- [Troubleshooting](#troubleshooting)
- [Current Status](#current-status)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

MeshPort is a mobile-first web app (installable as a PWA) for sending and receiving USDC, EURC, and cirBTC. Its core idea is that a payment should feel like sending a chat message — pick a person, type an amount, confirm with a 6‑digit passcode — while everything a normal crypto wallet forces on a user (seed phrases, gas, chain selection, raw addresses) is either automated or hidden behind a simpler flow when it needs to be exposed at all.

MeshPort's home chain is **Arc Testnet**, a Circle-operated EVM chain where USDC is the *native* gas currency (an 18‑decimal value transfer, not an ERC‑20 call). On top of Arc, MeshPort layers:

- a username system (`name.arc`) so people never have to share or paste a wallet address,
- QR codes and shareable payment links,
- encrypted chat with payments attached to individual messages,
- two independent ways to move USDC in and out of 20+ other EVM testnets (Circle's CCTP V2 and Circle Gateway "Unified Balance"),
- a batch-payout tool that pays many recipients in one on-chain transaction via Multicall3,
- and a peer-to-peer trading marketplace backed by an on-chain escrow contract.

## Problem

Sending crypto today typically requires the sender to:

- copy/paste a long hexadecimal wallet address (and get it exactly right, with no forgiveness for typos),
- know which of several unrelated blockchains the recipient's funds actually live on,
- separately acquire gas tokens on that chain before they can do anything,
- use one app to chat with someone and a completely different app to pay them,
- track balances scattered across multiple wallets, chains, and asset types with no unified view,
- and manually bridge funds between chains through multi-step, jargon-heavy interfaces.

## Solution

MeshPort collapses each of those steps:

| Problem | MeshPort's approach |
|---|---|
| Wallet addresses are hard to share/verify | `.arc` usernames resolve to a wallet address server-side; QR codes and payment links encode the same identity |
| Funds are fragmented across chains | Multichain Claim (bring funds *in* to Arc) and Multichain Transfer (send *out* to other chains) via CCTP V2 and Unified Balance |
| Chat and payments are separate apps | Chat & Pay: payments are sent as first-class chat message types, with status shown inline |
| Paying many people is many transactions | Bulk Pay batches every recipient into one Multicall3 transaction |
| Managing multiple assets is confusing | A single Home balance view across USDC, EURC, and cirBTC, with an in-app Swap between them |
| Onboarding requires understanding wallets first | Email OTP or Google sign-in auto-provisions a wallet server-side; a 6-digit passcode is the only secret the user manages day-to-day |

## Key Features

Grouped by how solid the implementation is, based on reading the actual code — not on filenames or UI copy alone.

### Fully implemented
- **Wallet creation** — BIP39 mnemonic generation, viem HD derivation (`src/lib/arc.ts`)
- **Wallet import/recovery** — import via seed phrase or raw private key (`src/lib/restoreWallet.ts`)
- **Social auth wallets** — Google / Email OTP sign-in auto-provisions a wallet, envelope-encrypted server-side (`supabase/functions/wallet-key`)
- **Email OTP authentication** — Supabase Auth OTP flow (`src/features/auth/AuthPages.tsx`)
- **6-digit passcode / app lock** — required for send, seed reveal, and private key export (`src/lib/security.ts`)
- **MeshPort username system (`.arc`)** — unique handles resolved through Supabase, no on-chain registry (`src/lib/usernameRegistry.ts`)
- **QR payments** — scan-to-pay and generate-to-receive (`src/features/scanner/ScannerPage.tsx`, `src/features/receive/ReceivePage.tsx`)
- **Payment links** (`meshport.xyz/pay/:username`) with rich link-preview cards (`api/og-pay.ts`, `api/og-image.tsx`)
- **Send / Receive** — USDC, EURC, cirBTC on Arc (`src/features/paysend/PaySendPage.tsx`, `src/features/receive/ReceivePage.tsx`)
- **Chat & Pay** — end-to-end encrypted chat with in-line payments (`src/features/chat/ChatPage.tsx`, `src/lib/chatCrypto.ts`)
- **Multichain Claim** — bring USDC from 20+ external testnets to Arc via CCTP V2, driven by a server-side worker (`src/features/multichain/MultichainClaimPage.tsx`, `supabase/functions/claim-worker`)
- **Multichain Transfer** — send Arc USDC out to external chains via CCTP V2 or Circle Gateway Unified Balance (`src/features/multichain/MultichainTransferPage.tsx`)
- **Swap** — USDC ↔ EURC ↔ cirBTC (`src/features/swap/SwapPage.tsx`, `api/swap-proxy.js`)
- **Bulk Pay** — one Multicall3 transaction to many recipients (`src/features/bulkpayout/BulkPayoutPage.tsx`)
- **Activity / transaction history** — unified feed across all transaction types, cursor-paginated, realtime-updated (`src/lib/ActivityService.ts`, `src/features/activity/ActivityPage.tsx`)
- **Notifications** — in-app + Web Push, Supabase Realtime-driven (`src/lib/notifications.ts`, `api/push.ts`)
- **P2P trading** — buy/sell offers with an on-chain escrow contract, disputes, ratings (`src/features/p2p/*`, `contracts/P2PMeshportEscrowV2.sol`)
- **Contacts** — recent/saved contacts synced with Supabase (`src/features/contacts/ContactsPage.tsx`)
- **Admin panel** — feature flags, chain/coin toggles, support tickets, treasury, notification broadcast (`src/features/admin/*`)

### Implemented but simplified / testnet-scoped
- **Rewards** — real on-chain claim flow against `MeshPortRewards.sol`, but the point-earning schedule (+20 pts/tx, daily caps) is a fixed constant, not a tunable rules engine (`src/lib/rewards.ts`)
- **Multichain claim/transfer gas** — external-chain gas for claims is funded by a single relay wallet (`api/relay-gas.ts`); if that wallet runs dry on a given chain, claims from that chain fail until refunded

### Informational / not a live backend feature
- **Treasury (staking) page** — displays static, hardcoded validator data. Arc Testnet runs Proof-of-Authority; public staking isn't available on testnet, so this page is illustrative UI only, not a working staking product (`src/features/treasury/TreasuryPage.tsx`)

No other product surface in the codebase (no NFTs, no lending, no card issuance, etc.) — anything not listed above and not in the routes table further down does not exist in this repository.

## Feature Guide (How It Works)

### Authentication & Onboarding
1. User chooses Google, Email OTP, or "create/import a wallet directly."
2. Social logins hit Supabase Auth; the app then calls the `wallet-key` Edge Function, which either returns an existing envelope-encrypted wallet for that verified user or atomically generates one (race-safe: the first concurrent request wins, others simply re-read).
3. Every account — social or self-custodial — must set a 6-digit passcode (`PasscodeSetup.tsx`) before reaching the app. The passcode is used only to gate the local UI/actions; for self-custodial wallets it also derives the AES-GCM key that encrypts the private key at rest (`security.ts`).
4. The user claims a `.arc` username (`ClaimUsernamePage`, inside `AuthPages.tsx`), which is written to `users.username` in Supabase — usernames are not an on-chain registry.

### Send (Pay/Send)
1. Pick a recipient by username, wallet address, QR scan, or recent contact.
2. Enter an amount for USDC, EURC, or cirBTC.
3. Review the transaction.
4. Confirm with the 6-digit passcode (`FlashAuthIcon` / passcode modal).
5. The signed transaction is submitted directly to Arc via `arcService.ts` (USDC is a native value transfer; EURC/cirBTC are ERC-20 `transfer()` calls).
6. The app optimistically shows the send, then reconciles against on-chain confirmation and the Activity feed.
7. Reward points are awarded on confirmation (`awardTransactionPoints`).

### Receive
1. `ReceivePage.tsx` renders the user's Arc wallet address as a QR code and shareable text/link.
2. Funds sent to that address by anyone (in-app or external, e.g. an exchange withdrawal) are picked up by server-side scanning, not by the sender's client — see [Multichain Architecture](#multichain-architecture) and `deposit-scan-all` for the receive-side detection model, which also applies to plain same-chain Arc receives.
3. `arcDepositWatcher.ts` and `onchainReceivedActivity.ts` classify an incoming transfer, filter out known internal contracts (Multicall3, the Circle Kit adapter, CCTP message transmitters) so those aren't misattributed as a "payment from" that contract, and create the recipient's own Activity row.

### QR Payment
1. `ScannerPage.tsx` uses the device camera (`jsqr`) to decode a MeshPort QR payload (a wallet address or a payment-link URL).
2. On successful decode, the app routes straight into the Send flow with the recipient pre-filled.

### Payment Links
1. Every user has a permanent link at `meshport.xyz/pay/:username`.
2. Because MeshPort is a client-rendered SPA, link-preview bots (iMessage, WhatsApp, Slack, Telegram) would otherwise see an empty shell. `vercel.json` rewrites `/pay/:username` to the `api/og-pay` serverless function for **bot** user agents, which returns real HTML with Open Graph tags pointing at a dynamically generated PNG (`api/og-image.tsx`, built with `@vercel/og`) showing that user's name, handle, and avatar.
3. A human visiting the same URL in a real browser gets the normal SPA, landing on the Send flow pre-filled with that username.

### Chat & Pay
See the dedicated [Chat & Pay](#chat--pay) section below.

### Multichain Claim (bring funds to Arc)
1. User selects a source chain (one of 20+ external testnets) on `MultichainClaimPage.tsx` and confirms the amount already sitting in their wallet on that chain.
2. The client calls the `claim-submit` Edge Function, which inserts a `claims` row and returns immediately.
3. `claim-worker` (invoked immediately, then kept alive by `pg_cron` as a self-healing sweep every minute) does the actual CCTP work server-side: confirm the burn transaction on the source chain → wait for Circle's attestation → submit the mint on Arc → confirm arrival via an on-chain event match.
4. The client never drives this state machine — it only subscribes to Supabase Realtime on the `claims` table to reflect status (`submitted → bridging → verifying → settling → completed`/`failed`). A claim keeps progressing even if the browser tab is closed.

### Multichain Transfer (send funds out from Arc)
See [Multichain Architecture](#multichain-architecture) below for the full CCTP V2 vs. Unified Balance breakdown.

### Swap
See [Swap Architecture](#swap-architecture) below.

### Bulk Pay
See [Bulk Pay Architecture](#bulk-pay-architecture) below.

### Treasury (informational)
Displays static Arc "validator" cards with fixed APY/uptime numbers for illustration; there is no live staking contract or backend behind this page. See [Current Status](#current-status).

### Rewards
1. Confirmed transactions on Arc award fixed points (`+20`/tx, capped at `200`/day or `10` tx/day) via `awardTransactionPoints`, persisted to `user_points`/`point_transactions` in Supabase.
2. `RewardsPage.tsx` shows the running balance and lets the user claim once they clear the `MIN_CLAIM_POINTS` threshold.
3. Claiming calls `claimRewards()` on the deployed `MeshPortRewards.sol` contract, which pays out USDC from a treasury the contract holds (funded manually by an admin wallet).

### P2P Trading
1. A seller creates a sell offer (or a buyer creates a buy offer) specifying min/max amount and price via `P2PPage.tsx` / `RoleManagersPanel.tsx`.
2. Creating a sell offer locks the seller's USDC into `P2PMeshportEscrowV2.sol` on Arc.
3. A counterparty opens a trade against that offer; off-chain fiat/payment confirmation happens between the two users (marked "payment sent" / "payment received" in the UI).
4. The seller (or an admin, in a dispute) releases escrow on-chain to the buyer; `p2p-release-reconcile` reconciles the on-chain release against the `p2p_trades` row.
5. Notifications, activity rows, and remaining-offer-capacity tracking are all driven off real trade completion, not just UI state (`p2pNotifications.ts`, `p2pService.ts`).

### Username Registration
1. During onboarding, the user picks a handle; `isUsernameTakenDb` checks uniqueness against `users.username` in Supabase in real time.
2. On confirmation, the username (displayed everywhere as `name.arc`) and the user's wallet address are written to the `users` row. There is no on-chain name registry — resolution is a database lookup (`resolveUsernameDb`).

---

## Architecture

```
                                 ┌─────────────────────────┐
                                 │   MeshPort Frontend      │
                                 │ React + Vite PWA (src/)  │
                                 └────────────┬─────────────┘
                                              │
                 ┌────────────────────────────┼─────────────────────────────┐
                 │                            │                             │
                 ▼                            ▼                             ▼
      ┌─────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────┐
      │ Vercel Serverless   │   │   Supabase                │   │  Blockchain RPC       │
      │ Functions (api/)    │   │ Postgres + Auth + Realtime│   │  (Arc + 20 external   │
      │ RPC proxy, relay,   │   │ + Edge Functions (Deno)   │   │  EVM testnets)         │
      │ swap proxy, push,   │◄──┤ ledger, claim-worker,     │──►│  via viem / ethers /   │
      │ OG previews         │   │ blockchain-indexer, etc.  │   │  Circle App Kit SDK    │
      └─────────┬───────────┘   └──────────────┬───────────┘   └──────────────────────┘
                │                              │
                ▼                              ▼
      ┌─────────────────────┐   ┌──────────────────────────┐
      │ Circle infrastructure│   │  On-chain contracts       │
      │ CCTP V2 attestation, │   │  P2PMeshportEscrowV2,     │
      │ Gateway / Unified    │   │  MeshPortRewards          │
      │ Balance, App Kit     │   │  (Arc Testnet)            │
      └─────────────────────┘   └──────────────────────────┘
```

- **Frontend** — a single-page React app (React Router, Zustand for local state, TanStack Query for async caching). Talks to Arc exclusively through `/api/arc-rpc` (never a raw RPC URL) so upstream API keys never ship to the browser.
- **API / serverless layer** (`api/`) — Vercel functions for: the Arc RPC proxy, gas-sponsoring relay, deposit relay, swap quoting/execution proxy, push notifications, Open Graph link previews, and a couple of thin Supabase-backed read/write helpers (`activity`, `transactions`, `profile`, `chat`) used where the service-role key must never reach the client.
- **Backend / data layer** (`supabase/`) — Postgres tables (users, messages, activity, claims, ledger, P2P, notifications, etc.), Row Level Security policies, Realtime subscriptions the frontend listens to directly, and Deno Edge Functions that own every piece of server-driven state (claims, ledger interpretation, bulk pay intents, wallet custody, P2P reconciliation, chain indexing).
- **Ledger / transaction-state layer** (`server/`) — a pure, dependency-injected TypeScript state machine and ledger classifier/interpreter, unit-tested independently of any database or RPC call, then wired into the Edge Functions that need it (`ledger-interpret`, `activity-consumer`).
- **Blockchain services** — Arc Testnet as the home chain; Circle's App Kit SDK for wallet/session and Gateway (Unified Balance) operations; CCTP V2 contracts for cross-chain burn/mint; a canonical Multicall3 deployment for batched sends; two purpose-built escrow/rewards contracts deployed directly by this repo.

## Multichain Architecture

MeshPort provides **two independent, genuinely different mechanisms** for moving USDC between Arc and other chains. Both are real and implemented — they are not the same code path with different labels.

### A. Circle Gateway — "Unified Balance"

- **Direction supported today:** Arc → external chain (used inside Multichain Transfer for the allow-listed subset of chains flagged `ub: true` in the chain registry, unless overridden by an admin per-chain setting).
- **Flow:** `deposit` (approve/move Arc USDC into the user's Circle Unified Balance) → `spend` (the Unified Balance is spent straight out to the destination chain/address).
- **Speed:** sub-second for the deposit step (Arc's own confirmation time), then a fast spend — end-to-end materially faster than CCTP's attestation wait.
- **Fees:** the Unified Balance deducts Circle's protocol fee and gas for the operations Circle performs on the user's behalf; this is a different fee model from a plain on-chain transfer and is surfaced to the user before confirmation (see the fee-model comments in `MultichainTransferPage.tsx`).
- **Resumability:** if a deposit already succeeded but the spend step didn't, the UI detects the existing Unified Balance and resumes from the spend step rather than depositing twice.

### B. CCTP V2 (Cross-Chain Transfer Protocol)

- **Direction supported today:** both directions — Multichain Claim (external chain → Arc) and Multichain Transfer (Arc → external chain, for chains not on the Unified Balance allow-list, or with UB disabled).
- **Flow:** **burn** USDC on the source chain → source chain **confirms** the burn transaction → **wait for attestation** from Circle's attestation service (Circle's stated SLA and observed real-world latency put this around 20–90 seconds on testnet) → **mint** the equivalent USDC on the destination chain → destination chain confirms the mint → **settled**.
- **Claim direction (external → Arc) is entirely server-driven:** the client only submits the claim request; `claim-worker` performs the burn confirmation, attestation polling, mint submission, and arrival confirmation, and is re-triggered by `pg_cron` so a claim keeps progressing even if the user closes the app.
- **Transfer direction (Arc → external) runs from the client** for the burn/mint steps (since it's the user's own Arc wallet initiating), with a step-by-step progress UI timed against CCTP V2's realistic attestation window rather than assuming instant confirmation.
- **Arrival detection is event-based, not balance-delta-based:** an earlier implementation compared a wallet's total balance before/after, which broke the moment *any other* activity touched that wallet mid-claim. The current implementation matches the actual CCTP `MessageReceived` log (or a specific incoming Transfer by recipient + amount), which is robust to concurrent activity.

### How the frontend tracks state for both

- The claim/transfer UI subscribes to Supabase Realtime on the relevant table (`claims` for claim-in, resumable local operation state + on-chain event polling for transfer-out) rather than owning cross-chain completion in browser memory alone — a refresh or reconnect re-syncs from the source of truth instead of losing progress.
- `resumableOperation.ts` persists in-flight multichain operations so a page reload can resume rather than restart or silently drop them.
- Gas for the destination-chain leg (where MeshPort submits the mint on the user's behalf, or where a chain isn't on Circle's own forwarder allow-list) is sponsored by a single relay wallet via `/api/relay-gas`; if that wallet is underfunded on a given chain, that chain's claims stall until it's topped up (see [Troubleshooting](#troubleshooting)).

## Bulk Pay Architecture

`src/features/bulkpayout/BulkPayoutPage.tsx` pays an arbitrary list of recipients in **one on-chain transaction**, using the canonical [Multicall3](https://github.com/mds1/multicall) contract (the same CREATE2 address on every EVM chain, including Arc).

1. **Add recipients** — by username, address, or CSV/paste; amounts are entered per recipient.
2. **Validate** — resolves every username to a wallet address, checks for duplicates/invalid addresses, and sums the total against the sender's balance.
3. **Review** — shows the full recipient list, total amount, and (since it's one transaction) a flat, single-transaction gas cost regardless of recipient count.
4. **Prepare & batch** — builds calldata for Multicall3's `aggregate3Value`, with each recipient encoded as `{ target: recipientAddress, value: amount, allowFailure: false }`; USDC being Arc's native currency means each "call" is simply a value transfer forwarded by Multicall3, not an ERC-20 `transfer()`.
5. **Execute** — a single signed transaction to the Multicall3 address; the contract fans the value out to every target atomically.
6. **Confirmation & history** — if the Multicall3 transaction reverts, the app reports total failure (no partial-success is invented); on success, one `bulkTxHash` is recorded and every recipient's Activity feed shows a "received via bulk payout" entry, explicitly excluding Multicall3 itself from being misattributed as the sender (`onchainReceivedActivity.ts`'s known-internal-contract list).
7. **Server-side intent tracking** — `bulkpay-intent` (Edge Function) records an idempotent intent *before* the Multicall3 call is built, so a resumed/retried Bulk Pay can be reconciled against what was actually attempted rather than re-derived from scratch.

## Swap Architecture

`src/features/swap/SwapPage.tsx` + `api/swap-proxy.js`.

- **Supported assets:** USDC, EURC, cirBTC — the only three assets Arc Testnet's liquidity actually supports, per the token list hardcoded in `SwapPage.tsx` (no speculative "coming soon" assets are wired in).
- **Quote/estimate flow:** the client asks `/api/swap-proxy` for a quote given an input/output token pair and amount; the proxy (a CommonJS Vercel function, kept CommonJS specifically to dodge an ESM incompatibility in a Circle SDK transitive dependency) talks to Arc RPC directly to price the swap.
- **Execution:** the user reviews the quoted output and price impact, confirms with the passcode, and the signed swap transaction is submitted through the same proxy/RPC path.
- **Activity tracking:** `recordSwapActivity` in `swap-proxy.js` best-effort writes a completed swap into Supabase immediately, so a swap shows up in Activity without waiting on the same client-side polling used for balance refresh; a failure here never blocks the swap response itself.
- **Balance refresh:** all three balances (USDC, EURC, cirBTC) are refreshed on the client immediately after a confirmed swap.

## Chat & Pay

- **Supported assets:** USDC, EURC, cirBTC (`ChatPage.cirbtc.test.ts` covers cirBTC specifically).
- **Encryption:** chat messages, images, and files are end-to-end encrypted using X25519 key pairs. Each user's chat key pair is **deterministically derived from their wallet's private key** (`chatCrypto.ts`), not randomly generated — re-importing the same wallet on a new device reproduces the same chat identity, with nothing extra to back up. Public keys are published to `users.chat_public_key` so a counterparty can look them up.
- **Payments in chat:** a payment sent from within a conversation is a distinct message type carrying `amount`, `currency`, and `transaction_id`, rendered inline with its live status and an explorer link — the chat message *references* the transaction, it is never the source of truth for whether the payment happened (that's still Arc + the ledger/Activity pipeline).
- **Where it lives:** `src/features/chat/ChatPage.tsx` (conversation UI + payment composer), `src/lib/chatService.ts` (message CRUD + realtime), `src/lib/chatCrypto.ts` (E2E crypto), `api/chat.ts` (server-side conversation create/send/touch, merged into one endpoint to stay under Vercel's function-count limit).

---

## Project Structure

```
meshport-main/
├── src/
│   ├── App.tsx                  # Route table (React Router) — the map of every screen in the app
│   ├── main.tsx                 # Entry point; Buffer polyfill for Circle SDK/viem/ethers
│   ├── blockchain/              # Chain/token registry, provider management, event/sync coordination
│   │   ├── chains.ts             #   Single source of truth for Arc + 21 external chains, tokens, RPCs
│   │   ├── BlockchainManager.ts  #   High-level orchestration over ProviderManager
│   │   ├── ProviderManager.ts    #   Cached, health-scored RPC provider pool per chain
│   │   ├── SyncCoordinator.ts    #   Coordinates polling/sync across features
│   │   └── shadowEventBus.ts     #   Shadow-validation event bus (old vs. new pipeline comparison)
│   ├── features/                # One folder per screen/product area (see mapping table below)
│   ├── lib/                     # Business logic, services, and integrations shared across features
│   │   ├── arc.ts / arcService.ts        # Arc RPC transport, wallet derivation, balance/send
│   │   ├── ActivityService.ts            # Unified transaction history feed
│   │   ├── claimService.ts               # Client for the server-owned claim state machine
│   │   ├── backgroundBridge.ts           # Multichain transfer execution helpers
│   │   ├── chatCrypto.ts / chatService.ts# E2E chat crypto + message service
│   │   ├── p2pService.ts / p2pEscrowContract.ts / p2pProviders.ts  # P2P trading + on-chain escrow client
│   │   ├── security.ts / biometric.ts    # Passcode hashing, key encryption, biometric unlock
│   │   ├── rewards.ts                    # Points accrual + on-chain claim
│   │   ├── supabase.ts                   # Supabase client + typed table helpers
│   │   └── usernameRegistry.ts           # `.arc` username lookup/claim
│   ├── store/                   # Zustand stores (auth, wallet, UI, settings, admin, theme)
│   ├── components/              # Shared UI (layout shell, admin widgets, multichain widgets, base `ui/`)
│   ├── hooks/                   # Shared React hooks (activity polling, media queries, viewport)
│   └── types/                   # Shared TypeScript types
├── server/                      # Pure, framework-free TypeScript — unit-tested independent of Deno/DB
│   ├── ledger/                  #   Ledger event classification + interpretation
│   └── transactionStateMachine/ #   Canonical transaction state transitions
├── api/                         # Vercel serverless functions (Node/Edge runtime)
│   ├── arc-rpc.js               #   Arc RPC proxy (the browser's only path to Arc)
│   ├── relay-rpc.js / relay-gas.ts / relay-deposit.js  # Gas sponsorship + gasless deposit relay
│   ├── swap-proxy.js            #   Swap quote/execution proxy
│   ├── chat.ts / profile.ts / activity.ts / transactions.ts  # Thin Supabase read/write helpers
│   ├── push.ts                  #   Web Push subscribe/send/broadcast
│   └── og-pay.ts / og-image.tsx #   Payment-link bot previews
├── supabase/
│   ├── functions/               # Deno Edge Functions — all server-driven state lives here
│   │   ├── claim-worker/ claim-submit/ claim-recovery-scan/  # CCTP claim state machine
│   │   ├── deposit-scan-all/    #   Server-side "did anyone send this wallet money" scanner
│   │   ├── blockchain-indexer/  #   Canonical chain-event indexer feeding the ledger
│   │   ├── ledger-interpret/ activity-consumer/  # Ledger → Activity projection pipeline
│   │   ├── bulkpay-intent/      #   Idempotent Bulk Pay intent tracking
│   │   ├── pay-intent/ swap-intent/  # Idempotent intent tracking for Send/Swap
│   │   ├── wallet-key/          #   Server-custodial wallet envelope encryption for social logins
│   │   ├── p2p-release-reconcile/  # Reconciles on-chain escrow release with trade state
│   │   └── chain-transfer-webhook/ # Inbound webhook for chain-transfer events
│   ├── migrations/               # SQL migrations — the real, applied database schema history
│   └── scripts/                  # One-off operational SQL
├── contracts/                    # Solidity contracts + Hardhat deploy/fund/check scripts
│   ├── P2PMeshportEscrowV2.sol   #   Current P2P escrow (security-hardened; see its own header for what it fixed)
│   └── MeshPortRewards.sol       #   On-chain rewards treasury/claim contract
├── scripts/                       # Verification/diagnostic scripts (shadow validation, indexer checks, etc.)
├── test/                          # Hardhat/contract tests (P2P escrow V2)
├── docs/                          # Deep-dive design docs, audits, and runbooks (see below)
├── vite.config.ts / vercel.json / tailwind.config.js / hardhat.config.cjs
└── package.json
```

The `docs/` folder already contains a large set of detailed engineering documents (ledger design, transaction state machine, security audits, phased migration reports, disaster recovery). This README summarizes and indexes them rather than duplicating their full contents — see [Developer Guide](#developer-guide--where-to-start) for pointers into that folder.

## Feature → Code Mapping

| Feature | Main files | Purpose |
|---|---|---|
| Auth (Google/Email OTP, passcode) | `src/features/auth/AuthPages.tsx`, `PasscodeSetup.tsx`, `src/lib/security.ts`, `supabase/functions/wallet-key` | Sign-in, wallet provisioning, passcode lock |
| Send / Receive | `src/features/paysend/PaySendPage.tsx`, `src/features/receive/ReceivePage.tsx`, `src/lib/arcService.ts` | Core USDC/EURC/cirBTC transfer on Arc |
| QR / Payment Links | `src/features/scanner/ScannerPage.tsx`, `api/og-pay.ts`, `api/og-image.tsx` | Scan-to-pay, shareable/previewable pay links |
| Chat & Pay | `src/features/chat/ChatPage.tsx`, `src/lib/chatService.ts`, `src/lib/chatCrypto.ts`, `api/chat.ts` | E2E-encrypted chat with inline payments |
| Multichain Claim | `src/features/multichain/MultichainClaimPage.tsx`, `src/lib/claimService.ts`, `supabase/functions/claim-worker`, `claim-submit`, `claim-recovery-scan` | External chain → Arc via CCTP V2, server-driven |
| Multichain Transfer | `src/features/multichain/MultichainTransferPage.tsx`, `src/lib/backgroundBridge.ts` | Arc → external chain via CCTP V2 or Unified Balance |
| Unified Balance (Gateway) | `MultichainTransferPage.tsx` (`ub` code paths), `api/relay-deposit.js` | Circle Gateway deposit/spend fast path |
| Bulk Pay | `src/features/bulkpayout/BulkPayoutPage.tsx`, `src/lib/bulkPayIntentService.ts`, `supabase/functions/bulkpay-intent` | Multicall3-batched payouts |
| Swap | `src/features/swap/SwapPage.tsx`, `api/swap-proxy.js`, `src/lib/swapIntentService.ts` | USDC/EURC/cirBTC swap |
| Activity / History | `src/lib/ActivityService.ts`, `src/features/activity/ActivityPage.tsx`, `TransactionDetail.tsx` | Unified transaction feed |
| Ledger / Transaction state | `server/ledger/`, `server/transactionStateMachine/`, `supabase/functions/ledger-interpret`, `activity-consumer` | Canonical financial truth + state machine |
| P2P Trading | `src/features/p2p/*`, `src/lib/p2pService.ts`, `src/lib/p2pEscrowContract.ts`, `contracts/P2PMeshportEscrowV2.sol` | Buy/sell offers with on-chain escrow |
| Rewards | `src/lib/rewards.ts`, `src/features/rewards/RewardsPage.tsx`, `contracts/MeshPortRewards.sol` | Points accrual + on-chain claim |
| Treasury (informational) | `src/features/treasury/TreasuryPage.tsx` | Static staking display, no live backend |
| Notifications | `src/lib/notifications.ts`, `src/lib/pushNotifications.ts`, `api/push.ts` | In-app + Web Push notifications |
| Admin panel | `src/features/admin/*` | Feature flags, chain/coin config, support, treasury admin, analytics |
| Blockchain indexing | `supabase/functions/blockchain-indexer`, `src/blockchain/chains.ts`, `SyncCoordinator.ts` | Canonical on-chain event ingestion |

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | React 18 + Vite | Fast dev server, straightforward code-splitting for heavy SDK chunks (viem/ethers/Circle SDK are manually chunked in `vite.config.ts`) |
| Language | TypeScript | End-to-end type safety across `src/`, `server/`, and most of `api/` |
| State | Zustand | Minimal, hook-based global state (auth, wallet, UI, settings) without Redux boilerplate |
| Data fetching/caching | TanStack Query | Async cache for less latency-sensitive reads |
| Styling | Tailwind CSS | Utility-first styling matched to the app's design tokens |
| PWA | `vite-plugin-pwa` | Installable app shell, service worker (`src/sw.ts`) |
| Blockchain (EVM) | viem, ethers v6 | viem for most reads/wallet derivation; ethers for Circle SDK adapter compatibility |
| Wallet/Custody SDK | `@circle-fin/app-kit` + ethers/viem adapters | Circle Gateway (Unified Balance) operations and session management |
| Home chain | Arc Testnet (Circle) | Native USDC gas chain MeshPort is built around |
| Cross-chain | Circle CCTP V2 | Burn/attest/mint USDC transfers between Arc and 20+ EVM testnets |
| Database / Auth / Realtime | Supabase (Postgres) | Users, messages, activity, claims, ledger, P2P — plus Realtime subscriptions the frontend consumes directly |
| Server compute | Supabase Edge Functions (Deno) | All server-driven state machines (claims, ledger, bulk pay, wallet custody, indexing) |
| Serverless API | Vercel Functions (Node + Edge) | RPC proxying, gas relay, swap proxy, push, OG previews |
| Smart contracts | Solidity 0.8.20, OpenZeppelin, Hardhat | P2P escrow (V1 + hardened V2) and rewards treasury/claim contract |
| Batching | Multicall3 | Canonical CREATE2 deployment, used for Bulk Pay |
| Push | `web-push` (VAPID) | Web Push notifications from `api/push.ts` |
| Testing | Vitest, Hardhat/Mocha | Unit tests for `src/lib`, `server/`; contract tests for `P2PMeshportEscrowV2` |

## Environment Variables

There is no `.env.example` checked in; the tables below are compiled directly from every `import.meta.env.*`, `process.env.*`, and `Deno.env.get(...)` call site in the repository. **Never commit real values for any secret-tier variable.**

### Frontend (Vite — `VITE_`-prefixed, bundled into client JS, public)

| Variable | Used for | Required locally? |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL for the browser client | Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon (public) key for the browser client | Yes |
| `VITE_KIT_KEY` | Circle App Kit public key (session/adapter init) | Yes, for multichain/Gateway features |
| `VITE_P2P_ESCROW_CONTRACT` | Deployed `P2PMeshportEscrowV2` address the client points at | Yes, for P2P |
| `VITE_REWARDS_CONTRACT` | Deployed `MeshPortRewards` address | Yes, for Rewards claim |
| `VITE_P2P_RECONCILE_AFTER` | Client-side threshold used by P2P reconciliation UI logic | No (has a default) |
| `VITE_ADMIN_PANEL_PATH` | Overrides the admin panel's base route for obscurity | No (has a default) |

> Deliberately **not** a `VITE_`-prefixed Arc RPC URL — see the comment at the top of `src/blockchain/chains.ts`: any URL with an embedded API key that ends up in a `VITE_` variable is bundled straight into public client JS, which defeats the point of it being a secret. The client only ever calls the same-origin `/api/arc-rpc` proxy.

### Backend — Vercel serverless functions (`api/`, server-side only)

| Variable | Used for | Required? |
|---|---|---|
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL for service-role calls | Yes |
| `SUPABASE_SERVICE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Full-privilege Supabase key (bypasses RLS) — used by `api/activity.ts`, `api/transactions.ts`, `api/chat.ts`, `api/profile.ts` | Yes |
| `SUPABASE_ANON_KEY` | Fallback for endpoints that don't strictly need service-role | No |
| `DRPC_KEY` | dRPC.live authenticated Arc RPC key (higher rate limits) | Recommended |
| `ARC_RPC_URL` | Explicit authenticated Arc RPC override (never `VITE_`-prefixed) | No |
| `ALCHEMY_ARC_KEY` | Alchemy's Arc-specific partner endpoint | No |
| `ALCHEMY_KEY` | Alchemy key used by the gas-relay RPC proxy for external chains | Recommended |
| `RELAY_PRIVATE_KEY` | Private key of the gas/deposit relay wallet — funds gasless claims/deposits | Yes, for multichain claim/Unified Balance |
| `RELAY_MAX_AMOUNT_USDC` | Safety cap on relay-sponsored operations | Recommended |
| `ALLOWED_ORIGIN` | CORS allow-list for the Arc RPC proxy and others | Recommended in production |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push signing keys (`api/push.ts`) | Yes, for push notifications |
| `PUSH_INTERNAL_SECRET` | Shared secret so Supabase triggers can call `api/push?action=send-internal` | Yes, for server-triggered push (e.g. P2P) |
| `ADMIN_PRIVATE_KEY` | Deployer/admin key used by Hardhat scripts (contract deploy, treasury fund/check) | Only for contract deployment tooling |
| `NEW_ADMIN_PRIVATE_KEY` / `OLD_ADMIN_PRIVATE_KEY` | Used by `scripts/handover-escrow-admin.ts` during an escrow admin-role handover | Only during a handover |
| `ROLE_MANAGER_1` / `ROLE_MANAGER_1_KEY` / `ROLE_MANAGER_2` / `ROLE_MANAGER_2_KEY` / `ROLE_MANAGER_3` | P2P escrow role-manager addresses/keys (multi-role admin model in `P2PMeshportEscrowV2.sol`) | Only for escrow role administration |
| `INITIAL_INVESTIGATOR_ADDRESS` / `INITIAL_PAUSER_ADDRESS` | Constructor args when deploying the escrow contract | Only at deploy time |
| `CONTRACT_BYTECODE` | Used by a deploy script that submits raw bytecode | Only for that specific deploy path |

### Backend — Supabase Edge Functions (`supabase/functions/`, Deno secrets)

| Variable | Used for | Required? |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase client inside Edge Functions | Yes |
| `DRPC_KEY` / `ALCHEMY_KEY` / `ARC_RPC_URL` | Same RPC configuration as the Vercel side, set independently as Supabase project secrets (Edge Functions run in a separate Deno runtime and cannot import from `api/`) | Recommended |
| `ARC_MESSAGE_TRANSMITTER_ADDRESS` | CCTP MessageTransmitter contract address on Arc, used to verify mint events | Yes, for claim-worker |
| `CIRCLE_API_KEY` | Circle attestation-service API key used while polling for CCTP attestations | Yes, for claim-worker |
| `WALLET_KEK` / `WALLET_KEY_ENCRYPTION_SECRET` | Master key-encryption-key material for server-custodial wallet envelope encryption | Yes, for `wallet-key` |
| `P2P_ESCROW_CONTRACT` / `P2P_ESCROW_CONTRACTS_LEGACY` | Server-side view of the current (and any legacy) escrow contract address(es), for reconciliation | Yes, for P2P reconciliation |
| `P2P_RECONCILE_AFTER` / `P2P_RECONCILE_SECRET` / `P2P_RECONCILE_SKIP_TRADE_IDS` | Tuning/auth for the P2P release-reconciliation job | Recommended |
| `PUSH_INTERNAL_SECRET` | Must match the Vercel-side value so DB triggers can call `api/push` | Yes, for P2P/notification triggers |
| `APP_BASE_URL` | Base URL used when building links inside notifications/webhooks | Recommended |
| `ALERT_WEBHOOK_URL` | Optional operational alerting webhook (shadow validation, indexer health) | No |
| `SUPABASE_SECRET_KEYS` | Rotation-aware secret key set for the wallet vault (see `wallet-key` changelog) | Yes, for wallet custody |

None of the above are checked into this repository, and none should ever be. Set frontend variables in Vercel's *Environment Variables* UI (or a local untracked `.env` for `npm run dev`) and Edge Function secrets via `supabase secrets set` or the Supabase dashboard.

## Local Development

### Prerequisites
- Node.js **24.x** (pinned in `package.json`'s `engines` field)
- npm
- A Supabase project (for auth/database features) — or point `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` at an existing one for read-only exploration
- (Optional) A deployed Vercel project if you want live `/api/*` routes locally — see the note on `vite.config.ts`'s dev proxy below

### Installation
```bash
git clone <this-repo>
cd meshport-main
npm install
# On Windows, if native module builds cause issues:
npm run install:win
```

### Environment configuration
Create a `.env` file at the repo root (not committed) with at least the `VITE_`-prefixed variables from [Environment Variables](#environment-variables) that your local work touches. There is no bundled default backend — you need your own Supabase project (or credentials for a shared one) to sign in and see data.

### Database / Supabase setup
1. Create a Supabase project and run the SQL files under `supabase/migrations/` in filename (chronological) order to reach the current schema.
2. Deploy the Edge Functions under `supabase/functions/` you intend to exercise (`supabase functions deploy <name>`), and set their secrets per the Edge Function table above.
3. Note: several Edge Functions are deliberately **self-contained** (no shared imports) — see the comment at the top of `claim-worker/index.ts` — because the Supabase dashboard's single-file editor silently ignores separate shared files on a dashboard-based deploy. If you edit shared logic, verify it actually reaches every function that inlines a copy of it.

### Development server
```bash
npm run dev
```
Opens on `http://localhost:5173` by default (Vite). **Note:** `vite.config.ts` proxies every `/api/*` call to `https://meshport.xyz` in dev — meaning `npm run dev` alone talks to whatever the production deployment currently runs. For fully local API behavior, deploy your own Vercel project first and change that proxy target, or run `vercel dev` instead of `vite`.

### Type checking, linting, tests
```bash
npm run typecheck            # tsc --noEmit on the frontend
npm run typecheck:server     # tsc --noEmit on server/
npm run lint                 # ESLint, zero warnings allowed
npm run test                 # Vitest, single run
npm run test:watch           # Vitest, watch mode
```

### Build & preview
```bash
npm run build      # vite build → dist/
npm run preview    # serve the production build locally
```

### Smart contracts
```bash
npm run contract:compile                    # hardhat compile
npm run contract:deploy                     # deploy contracts/deploy-hardhat.cjs to arcTestnet
npm run contract:deploy:p2p-escrow          # deploy the legacy P2P escrow
npm run contract:deploy:p2p-escrow-v2       # deploy the current, hardened P2P escrow
npm run treasury:fund                       # fund the rewards treasury
npm run treasury:balance                    # check the rewards treasury balance
```
See `contracts/README.md` for a from-scratch Remix + MetaMask deployment walkthrough for `MeshPortRewards.sol`.

## Deployment

MeshPort is configured for **Vercel** (`vercel.json`):

- **Build command:** `npm run build` (Vite production build to `dist/`)
- **Install command:** `npm install --legacy-peer-deps` (Circle SDK / viem / ethers peer-dependency ranges need this)
- **Output directory:** `dist`
- **Rewrites:**
  - `/api/(.*)` → the corresponding serverless function in `api/`
  - `/pay/:username` → `api/og-pay` (serves bot-friendly HTML for link previews; humans still land in the SPA)
  - everything else → `index.html` (SPA fallback for client-side routing)
- **Function overrides:** `api/swap-proxy.js` and `api/relay-rpc.js` are given a 60s `maxDuration` — both can involve multi-step RPC/attestation work that exceeds Vercel's default function timeout.
- **Headers:** `sw.js` and `index.html` are set to `no-cache`/`must-revalidate` so PWA users always get the latest service worker and shell instead of a stale cached one.

**To deploy:**
```bash
npm install -g vercel
vercel            # first deploy, follow prompts
vercel --prod     # promote to production
```
or connect the GitHub repo in the Vercel dashboard for automatic deploys on push. Either way, set every relevant environment variable from the [Environment Variables](#environment-variables) tables in the Vercel project settings before deploying — the app will build without them but many features will fail at runtime.

Supabase Edge Functions deploy independently of Vercel:
```bash
supabase functions deploy claim-worker
supabase functions deploy <other-function-name>
```
Cron-triggered functions (`claim-worker` in `sweep` mode, `deposit-scan-all`) rely on `pg_cron` schedules created by their corresponding migrations — confirm those migrations have been applied, not just the function code deployed.

## Security

- **Passcode:** a 6-digit passcode is mandatory for every account. It is hashed with PBKDF2 (100,000 iterations, SHA-256) with an embedded salt (`security.ts`) for local verification, and gates sending funds, revealing the seed phrase, and exporting the private key.
- **Two distinct custody models, not one:**
  - *Self-custodial* (created/imported wallet): the private key is encrypted **client-side** with an AES-GCM key derived from the user's passcode via PBKDF2, and stored locally. MeshPort's servers never see this key.
  - *Social login* (Google/Email OTP): the wallet is generated and **envelope-encrypted server-side** (`wallet-key` Edge Function, KEK-based, with a `KeyProvider` abstraction currently backed by environment-variable secrets and designed to be swapped for a real KMS later without touching business logic). The user's passcode is never used to derive this wallet's encryption key.
- **Wallet key retrieval is authorization-checked server-side**, re-verifying the caller's Supabase session JWT on every call rather than trusting a client-asserted user id, and is rate-limited per-user and per-IP.
- **Client/server separation for secrets:** RPC provider API keys (`DRPC_KEY`, `ALCHEMY_KEY`, etc.) are never placed in `VITE_`-prefixed variables; the browser only ever talks to same-origin proxy endpoints (`/api/arc-rpc`, `/api/swap-proxy`, `/api/relay-*`) that hold the real credentials server-side.
- **Transaction authorization:** every fund-moving action (send, swap, multichain transfer, bulk pay, escrow release) requires an explicit passcode confirmation step in the UI before a transaction is signed.
- **P2P escrow contract hardening:** `P2PMeshportEscrowV2.sol` is a from-scratch security pass over the original escrow, fixing (with rationale documented in the contract's own comments): a first-depositor offer-hijack vulnerability, a `release()` call that trusted caller-supplied buyer/amount instead of on-chain state, and adds a proper INVESTIGATOR role alongside PAUSER/ADMIN. It uses OpenZeppelin's `ReentrancyGuard` and follows checks-effects-interactions throughout.
- **What this repository does *not* claim:** there is no multi-party computation (MPC) key management, no hardware security module integration, and no independent third-party security audit report included in this repo (`docs/SECURITY_AUDIT_FINAL.md` is an internal audit document, not an external attestation). Treat this as testnet-grade security posture unless you've independently verified otherwise for your deployment.

See `docs/SECURITY_ARCHITECTURE.md` and `docs/SECURITY_AUDIT_FINAL.md` for the full internal design and audit notes this summary is drawn from.

## Transaction Lifecycle

MeshPort's canonical transaction states (`server/transactionStateMachine/types.ts` and the design docs under `docs/`) are more granular than a simple pending/confirmed/failed model, specifically to distinguish "we don't know yet" from "it failed":

```
DRAFT → REVIEWED → AUTHORIZING → SIGNED → SUBMITTED → CONFIRMING → CONFIRMED → SETTLED
                                             │
                                             ├─→ SUBMITTED_UNKNOWN   (broadcast succeeded, but
                                             │                        waiting for a receipt timed out —
                                             │                        never auto-marked FAILED from here)
                                             ├─→ FAILED
                                             ├─→ REPLACED
                                             └─→ DROPPED
```

- A transaction that was successfully **broadcast** but whose receipt-wait **timed out** is `SUBMITTED_UNKNOWN`, never `FAILED` — the system reconciles unknown transactions (via the indexer / claim-worker's own confirmation logic) before ever concluding they didn't happen.
- Claims specifically move through their own narrower CCTP-flavored states: `submitted → bridging → verifying → settling → completed` (or `failed`), tracked directly on the `claims` table.
- Financial truth flows one direction only: **Blockchain → Indexer/Reconciler → Ledger Event → Activity Projection.** The frontend never writes a confirmed Activity row for money it merely *initiated* — for example, a sender's client never creates the *receiver's* Activity entry; that's always produced from an indexed on-chain event, so it works even if the receiver's app is closed at the time.
- See `docs/TRANSACTION_STATE_MACHINE.md`, `docs/LEDGER_CANONICAL_EVENT_DESIGN.md`, and `docs/LEDGER_CORE_IMPLEMENTATION.md` for the full design and rationale.

## Data Flow (summary)

| Flow | Path |
|---|---|
| Authentication | Client → Supabase Auth (Google/Email OTP) → `wallet-key` Edge Function (social) or local key generation (self-custodial) → passcode setup |
| Send | Client signs → Arc RPC (`/api/arc-rpc`) → on-chain confirmation → `ActivityService` + ledger pipeline → Realtime push to sender's UI |
| Receive | External/internal transfer lands on-chain → `deposit-scan-all` / `blockchain-indexer` detects it → ledger event → recipient's Activity row → Realtime push + notification |
| Multichain Claim | Client → `claim-submit` → `claims` row → `claim-worker` (burn confirm → attestation → mint → arrival confirm) → Realtime updates client |
| Multichain Transfer (CCTP) | Client burns on Arc → client polls attestation → client submits mint on destination (or relay-assisted where needed) → Activity update |
| Multichain Transfer (Unified Balance) | Client deposits into Gateway → Gateway spend to destination → Activity update |
| Swap | Client → `/api/swap-proxy` (quote, then execute) → Arc RPC → `recordSwapActivity` → Activity update |
| Bulk Pay | Client → `bulkpay-intent` (idempotent intent) → Multicall3 tx on Arc → per-recipient Activity rows via indexer |
| Chat & Pay | Client encrypts (X25519) → `api/chat.ts` / Supabase → Realtime delivery; payment sub-messages reference a real transaction id |
| P2P | Offer/trade rows in Supabase ↔ on-chain escrow deposit/release ↔ `p2p-release-reconcile` keeps both in sync |
| Activity | `blockchain-indexer` + `ledger-interpret` + `activity-consumer` → canonical `ledger_events`/`activity` rows → Realtime → `ActivityPage.tsx` |

## Supported Networks and Assets

**Home chain:** Arc Testnet — chain ID `5042002`, RPC `https://rpc.testnet.arc.network` (accessed by the app only via `/api/arc-rpc`), explorer `https://testnet.arcscan.app`.

**Arc-native assets** (`src/blockchain/chains.ts` → `ARC_TOKENS`):

| Asset | Contract | Decimals | Notes |
|---|---|---|---|
| USDC | `0x3600000000000000000000000000000000000000` | 6 (ERC-20 interface) / 18 (native value transfers) | Arc's native gas currency — plain sends are value transfers, not contract calls |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 | Standard ERC-20 |
| cirBTC | `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` | 8 | Standard ERC-20 |

**External chains registered for Multichain Claim/Transfer** (`EXTERNAL_CHAINS` in `chains.ts` — 21 total, each with its own testnet USDC contract and RPC list): Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Polygon Amoy (Sepolia), Avalanche Fuji, HyperEVM Testnet, Sei Testnet, Sonic Testnet, Unichain Sepolia, World Chain Sepolia, Linea Sepolia, Ink Testnet, Monad Testnet, Morph Testnet, Pharos Testnet, Plume Testnet, XDC Apothem, Codex Testnet, Edge Testnet, Injective Testnet.

Not every chain in that list necessarily supports both CCTP and Unified Balance — the Unified Balance path is limited to an explicit allow-list inside `MultichainTransferPage.tsx`, overridable per-chain from the admin panel. Treat the list above as "known to the app's registries," and the CCTP/UB split in [Multichain Architecture](#multichain-architecture) as the actual capability boundary.

## Deployed Contracts

Contract addresses currently deployed on **Arc Testnet**, as configured via the corresponding environment variable (see [Environment Variables](#environment-variables)):

| Contract | Address | Env var | Explorer |
|---|---|---|---|
| `P2PMeshportEscrowV2` | `0xB3D37ff64A3c9E740e9d49efE346657944729F09` | `VITE_P2P_ESCROW_CONTRACT` | [testnet.arcscan.app](https://testnet.arcscan.app/address/0xB3D37ff64A3c9E740e9d49efE346657944729F09) |
| `MeshPortRewards` | `0x436947EEE829B3C0a08BD683c8ff839bc871D167` | `VITE_REWARDS_CONTRACT` | [testnet.arcscan.app](https://testnet.arcscan.app/address/0x436947EEE829B3C0a08BD683c8ff839bc871D167) |

The `P2PMeshportEscrowV2` address above is the current, live contract the client points at by default. Any address(es) listed in the server-side `P2P_ESCROW_CONTRACTS_LEGACY` variable are earlier, superseded deployments kept only so `p2p-release-reconcile` can still read the status of trades created before the cutover — new trades are always created against the address above.

## API / Backend Overview

### Vercel serverless endpoints (`api/`)

| Route | Method(s) | Purpose | Auth / secrets used |
|---|---|---|---|
| `/api/arc-rpc` | POST | JSON-RPC proxy to Arc, with multi-endpoint health-scored failover | `DRPC_KEY`, `ARC_RPC_URL` (server-only) |
| `/api/relay-rpc` | POST | Gas-sponsoring proxy: funds a user's ETH deficit on an external chain then submits their signed tx | `RELAY_PRIVATE_KEY`, `ALCHEMY_KEY`, `DRPC_KEY` |
| `/api/relay-gas` | POST | Funds gas directly on chains not covered by Circle's own forwarder allow-list | `RELAY_PRIVATE_KEY` |
| `/api/relay-deposit` | POST | Gasless deposit into Circle Unified Balance via `depositFor()`, relay pays gas | `RELAY_PRIVATE_KEY`, `DRPC_KEY`/`ARC_RPC_URL` |
| `/api/swap-proxy` | POST | Swap quote + execution proxy (USDC/EURC/cirBTC) | `DRPC_KEY`, `ARC_RPC_URL`/`ALCHEMY_ARC_KEY`, Supabase service key (activity write) |
| `/api/activity` | GET | Reads `bulk_payments` metadata using the service key (bypasses RLS for wallet-only users) | `SUPABASE_SERVICE_KEY` |
| `/api/transactions` | GET, POST | Fetch/save transaction records by wallet address | `SUPABASE_SERVICE_KEY` |
| `/api/profile` | GET, POST | Fetch/update a user's public profile | `SUPABASE_SERVICE_ROLE_KEY` |
| `/api/chat` | POST (`?action=create\|send\|touch`) | Conversation create/send/touch, merged into one function to stay under Vercel's function-count limit | `SUPABASE_SERVICE_KEY` |
| `/api/push` | POST (`?action=subscribe\|unsubscribe\|send\|send-internal\|broadcast\|feed`) | Web Push subscription management and dispatch | `VAPID_*`, `PUSH_INTERNAL_SECRET` |
| `/api/og-pay` | GET | Bot-facing HTML with Open Graph tags for `/pay/:username` links | none (public data only) |
| `/api/og-image` | GET (Edge runtime) | Renders the PNG used as `og:image` for payment link previews | none |

### Supabase Edge Functions (`supabase/functions/`)

| Function | Purpose | Triggered by |
|---|---|---|
| `claim-submit` | Inserts a `claims` row and kicks off processing | Client (Multichain Claim) |
| `claim-worker` | Full CCTP claim state machine: burn confirm → attestation → mint → arrival confirm | `claim-submit` (immediate) + `pg_cron` sweep |
| `claim-recovery-scan` | Per-wallet scan for external deposits/mints missed by the normal flow | App foreground/visibility change |
| `deposit-scan-all` | Scheduled, all-wallet scan for plain incoming transfers with no activity row yet | `pg_cron` |
| `blockchain-indexer` | Canonical chain-event ingestion feeding the ledger | Scheduled/triggered indexing pass |
| `ledger-interpret` | Classifies raw chain events into ledger events | `blockchain-indexer` output |
| `activity-consumer` | Projects ledger events into user-facing Activity rows | `ledger-interpret` output |
| `pay-intent` | Idempotent intent tracking for Send | Client, before broadcasting a send |
| `swap-intent` | Idempotent intent tracking for Swap | Client, before executing a swap |
| `bulkpay-intent` | Idempotent intent tracking for Bulk Pay, plus nonce reservation | Client, before building the Multicall3 call |
| `wallet-key` | Server-custodial wallet generation/retrieval for social logins | Client, on social login |
| `p2p-release-reconcile` | Reconciles on-chain escrow release events with `p2p_trades` rows | Scheduled |
| `chain-transfer-webhook` | Inbound webhook endpoint for chain-transfer related events | External webhook call |

Full request/response shapes are documented inline at the top of each function's `index.ts` — the table above is a map, not a substitute for reading the function you're about to change.

## Database Overview

Schema history lives in `supabase/migrations/` (apply in filename order). Tables actually referenced from application code (`src/`, `api/`, `server/`, `supabase/functions/`) include:

| Table | Used for |
|---|---|
| `users` | Account profile: username (`.arc` handle), wallet address, avatar, `chat_public_key`, `login_type` |
| `messages`, `conversations`, `attachments` | Chat: conversations, individual messages (including payment sub-type), file/image attachments |
| `contacts` | Saved/recent contacts per user |
| `activity`, `transactions`, `multichain_transactions`, `bulk_payments` | User-facing transaction history across send/receive, multichain, and bulk pay |
| `transaction_intents`, `transaction_attempts` | Idempotent intent + attempt tracking feeding the transaction state machine |
| `ledger_events` | Canonical, append-only financial ledger — the single source of truth Activity is projected from |
| `chain_events`, `chain_cursors`, `indexer_config`, `indexer_shadow_reports` | Blockchain indexer state: raw events, per-chain scan cursors, config, and shadow-validation reports (old vs. new pipeline comparison) |
| `deposit_scan_cursor` | Cursor for the all-wallet deposit scanner |
| `claims` | Multichain Claim (CCTP) state machine rows |
| `external_balance_snapshots` | Point-in-time external-chain balance snapshots |
| `p2p_offers`, `p2p_trades` | P2P marketplace offers and trades |
| `notifications`, `notification_events` | In-app notification rows and the events that generate them (including DB triggers that call `api/push`) |
| `wallet_vault`, `wallet_audit_log`, `wallet_backups` | Server-custodial wallet envelope-encrypted storage and its audit trail (columns have been migrated/hardened multiple times — see migration history for the encryption model's evolution) |
| `user_points`, `point_transactions`, `reward_claims`, `daily_tx_rewards` | Rewards accrual and claim history |
| `admin_users`, `app_settings`, `settings_logs` | Admin accounts and feature-flag/config state with an audit log |
| `support_tickets` | In-app support ticket submissions |
| `transaction_notes` | Free-text notes attached to a transaction, if used |

RLS (Row Level Security) policies are defined per-table in the migrations that create or alter them — several Vercel API routes exist specifically because a wallet-only (non-Supabase-auth) user needs the service-role key to bypass RLS for their own data (`api/activity.ts`, `api/transactions.ts`). See `docs/PHASE_1_SCHEMA_DESIGN.md`, `docs/LEDGER_SCHEMA_GAP_AUDIT.md`, and `docs/ACTIVITY_WRITER_AUDIT.md` for the schema's design rationale and known gaps as of those audits.

## Developer Guide — Where to Start

| If you want to... | Start here |
|---|---|
| Change the Send flow | `src/features/paysend/PaySendPage.tsx` → `src/lib/arcService.ts` |
| Change Receive / deposit detection | `src/features/receive/ReceivePage.tsx`, `src/lib/arcDepositWatcher.ts`, `src/lib/onchainReceivedActivity.ts`, `supabase/functions/deposit-scan-all` |
| Change Multichain Claim (CCTP in) | `src/features/multichain/MultichainClaimPage.tsx`, `src/lib/claimService.ts`, `supabase/functions/claim-worker` |
| Change Multichain Transfer (CCTP/UB out) | `src/features/multichain/MultichainTransferPage.tsx`, `src/lib/backgroundBridge.ts` |
| Change Swap | `src/features/swap/SwapPage.tsx`, `api/swap-proxy.js` |
| Change Bulk Pay | `src/features/bulkpayout/BulkPayoutPage.tsx`, `supabase/functions/bulkpay-intent` |
| Change Chat | `src/features/chat/ChatPage.tsx`, `src/lib/chatService.ts`, `api/chat.ts` |
| Change authentication / onboarding | `src/features/auth/AuthPages.tsx`, `src/lib/security.ts`, `supabase/functions/wallet-key` |
| Change P2P trading or escrow | `src/features/p2p/*`, `src/lib/p2pService.ts`, `contracts/P2PMeshportEscrowV2.sol` |
| Change the transaction ledger/state machine | `server/ledger/`, `server/transactionStateMachine/` (pure, unit-testable — change here first, then verify the Edge Functions that consume it) |
| Change chain/token configuration | `src/blockchain/chains.ts` — and remember `api/*.js` and `supabase/functions/_shared` intentionally keep their own copies for runtime-isolation reasons documented at the top of that file |
| Change UI/navigation | `src/App.tsx` (route table), `src/components/layout/AppLayout.tsx` |
| Change admin tooling | `src/features/admin/*` |

Before making a structural change to transaction/ledger/state-machine logic, read `docs/TRANSACTION_STATE_MACHINE.md` and `docs/TRANSACTION_SERVICE_BOUNDARY.md` first — a lot of hard-won correctness reasoning (idempotency, `SUBMITTED_UNKNOWN` vs `FAILED`, sender-can't-write-receiver's-Activity) lives there and is easy to accidentally regress.

## Troubleshooting

These are drawn from the repository's own `LAUNCH_CHECKLIST.md` and inline code comments, not invented:

- **Multichain claims from a specific external chain fail or hang** — the relay wallet (`RELAY_PRIVATE_KEY`) may be underfunded with that chain's native gas token. Check `/api/relay-gas` logs and fund the relay wallet on that chain.
- **A claim sits in "settling" with no progress** — confirm `claim-worker`'s `pg_cron` schedule (migration `20260702120100_claim_worker_cron.sql`) is actually installed; the worker is designed to self-heal via that cron sweep, and a missing/disabled cron job removes that safety net.
- **CCTP claim/transfer feels stuck for 1–2 minutes** — this is expected: Circle's attestation step genuinely takes ~20–90 seconds on testnet. The UI's step timer is calibrated to this; a claim/transfer isn't actually stuck unless it exceeds the "needs review" watchdog window.
- **`npm run dev` shows stale or unexpected `/api/*` behavior** — remember the Vite dev server proxies `/api/*` to `https://meshport.xyz` by default (see `vite.config.ts`); you're seeing production's behavior, not necessarily your local code, unless you've pointed the proxy at your own deployment or used `vercel dev`.
- **A dashboard-deployed Edge Function doesn't reflect a shared-code fix** — several functions (`claim-worker`, `claim-recovery-scan`, `wallet-key`, `bulkpay-intent`) are deliberately self-contained with inlined "shared" code, specifically because the Supabase dashboard's single-file editor does not deploy separate shared files. Re-paste the full function body, don't just edit a shared file and expect it to propagate.
- **Windows install failures** — use `npm run install:win` (`npm install --ignore-scripts`) if native module postinstall scripts fail.
- **cirBTC swap returns a near-zero or zero output** — testnet liquidity for cirBTC is limited; this is a liquidity constraint on Arc Testnet itself, not a frontend bug.

## Current Status

- **Network:** Arc Testnet only. No mainnet configuration exists anywhere in this repository.
- **Implemented and working:** authentication (Google/Email OTP + passcode), username system, Send/Receive, QR + payment links, Chat & Pay, Multichain Claim (CCTP), Multichain Transfer (CCTP + Unified Balance), Swap, Bulk Pay (Multicall3), Activity/history, notifications (in-app + push), P2P trading with on-chain escrow, rewards accrual + on-chain claim, admin panel.
- **Dependent on external infrastructure that can bottleneck it:** Multichain Claim/Transfer depend on Circle's CCTP attestation service and a manually-funded relay wallet per external chain; Swap depends on Arc Testnet's own liquidity for EURC/cirBTC.
- **Informational only, not a real backend feature:** the Treasury (staking) page.
- **No independent external security audit** is included in this repo — `docs/SECURITY_AUDIT_FINAL.md` is an internal document, treat it accordingly.
- **Licensed under MIT** (see [License](#license)).

## Roadmap

No roadmap file or forward-looking planning document exists in this repository at the time of writing, so none is included here rather than inventing one. `docs/` contains historical phase-by-phase implementation reports (e.g. `PHASE_3_*`, `PHASE_4_*`) describing work that has already been completed, not future plans.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE). This matches the `SPDX-License-Identifier: MIT` header already declared in every contract under `contracts/` (`MeshPortRewards.sol`, `P2PMeshportEscrowV2.sol`); the root `LICENSE` file extends that same license to the rest of the repository.
