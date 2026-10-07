# MeshPort — Claude Implementation Guide

This file is detected automatically by Claude Code and Claude in Projects.
Read it before touching any code in this repository.

---

## What this project is

MeshPort is an Arc-native USDC payments app. Arc is Circle's blockchain where
**USDC is the native gas token** — there is no separate ETH/MATIC for gas.
The same USDC balance is reachable two ways (see Architecture rule 1): as the
native currency (18 decimals, `msg.value`) and through the ERC-20 interface at
`0x3600000000000000000000000000000000000000` (6 decimals). Both are valid;
existing contracts and app code use both.

---

## Security fixes already applied (DO NOT revert)

The following bugs were found and patched. Each fix is commented in source with
the tag shown. If you see the old code in a diff, reject it.

| Tag | File | What was fixed |
|-----|------|----------------|
| `H-2 FIX` | `api/chat.ts` | Hardcoded Supabase project URL removed; missing env var now errors loudly |
| `H-3 FIX` | `api/chat.ts` | `Access-Control-Allow-Origin: *` replaced with `ALLOWED_ORIGIN` env var |
| `M-2 FIX` | `api/chat.ts` | Arc RPC fallback list expanded to all four official providers |
| `B-1 FIX` | `api/chat.ts` | `toUnits()` float-precision bug fixed (was using `Number.toFixed`) |
| `B-2 FIX` | `api/bridge-relay.ts` | Rate-limit map used `clear()` on all entries; replaced with single-entry LRU eviction |
| `B-3 FIX` | `api/bridge-relay.ts` | Session cache used `clear()` on all entries; replaced with single-entry LRU eviction |
| `M-4 FIX` | `api/profile.ts` | `ilike` replaced with `eq` for wallet address queries (index-safe) |
| `B-4 FIX` | `src/lib/supabase.ts` | Silent empty catch in `ensureAnonSession` replaced with `console.warn` |
| contracts-audit H-1 | `contracts/MeshPortBridgeRouter.sol` | Post-burn `approve(0)` return value now checked |
| contracts-audit M-1 | `contracts/MeshPortRewards.sol` | 2-day timelock on signer rotation, rate change, treasury withdrawal, ownership transfer |
| contracts-audit L-1 | `contracts/MeshPortRewards.sol` | Owner no longer immutable; two-step (timelocked) ownership transfer |

**Rejected finding — do not apply:** contracts-audit C-1 ("MeshPortRewards must
switch to native `msg.value` because Arc USDC is not an ERC-20"). It is wrong:
Arc USDC has an ERC-20 interface at `0x3600…0000`, the rewards contract was
deployed against it, and production has completed on-chain reward claims.

---

## Open security items — implement these next

### CRITICAL — implement before any production deployment

#### C-1: Move bridge relayer off raw private key
**File:** `api/bridge-relay.ts` line ~194  
**Problem:** `process.env.BRIDGE_RELAYER_PRIVATE_KEY` is a raw hex private key
in a Vercel env var. A Vercel env var breach exposes it completely.  
**Fix:** Replace with a Circle developer-controlled wallet:

```typescript
// Install: npm add @circle-fin/developer-controlled-wallets
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

const walletsClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
})

// Replace: wallet.writeContract(request) / wallet.sendTransaction(...)
// With:    walletsClient.createTransaction({ walletId: RELAYER_WALLET_ID, ... })
// Store RELAYER_WALLET_ID in env — never a private key.
```

Set `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and `VITE_RELAYER_WALLET_ID` in
Vercel environment variables. Remove `BRIDGE_RELAYER_PRIVATE_KEY` once migrated.

#### C-2: Protect the Circle Stablecoin Service key
**File:** `api/swap-proxy.js` line ~150  
**Problem:** `process.env.KIT_KEY` — if this leaks, anyone can use your Circle
swap quota.  
**Fix:** Short-term: rotate the key immediately after any suspected exposure and
confirm Vercel env vars have access-controlled visibility. Long-term: move swap
signing to a Circle developer-controlled wallet so the key never lives in env.

#### C-3: Move rewards signer off raw private key — code done, setup pending
**File:** `supabase/functions/rewards-claim-sign/`  
**Status:** The function signs through a Circle developer-controlled wallet
(`POST /v1/w3s/developer/sign/message`) whenever `REWARDS_SIGNER_WALLET_ID` is
set, and falls back to `REWARDS_SIGNER_PRIVATE_KEY` until then.  
**Remaining setup:** `scripts/create-rewards-signer-wallet.mjs` → set the
Supabase secrets it prints → register the address with
`contracts/set-points-signer.cjs` → delete `REWARDS_SIGNER_PRIVATE_KEY`.

---

### HIGH — implement before launch

#### H-1: Three divergent chain registries — add a sync test
**Files:**
- `src/blockchain/chains.ts` (browser bundle)
- `api/bridge-relay.ts` `CHAINS` map (Vercel Node)
- `supabase/functions/_shared/chains.ts` (Deno edge)

These cannot share imports across runtime boundaries but must stay in sync.
A USDC address mismatch causes silent bridge failures.

**Fix:** Add a test file `test/chain-registry-sync.test.ts`:

```typescript
import { EXTERNAL_CHAINS } from '../src/blockchain/chains'
import { CHAINS as RELAY_CHAINS } from '../api/bridge-relay'
// For each chain key present in both registries, assert usdc address matches.
// Run this in CI: vitest run test/chain-registry-sync.test.ts
```

#### H-3 (arc-rpc.js): Restrict CORS origin
**File:** `api/arc-rpc.js` line ~445  
**Problem:** The CORS header is set before method/body validation and defaults
to `*` when `ALLOWED_ORIGIN` is unset.  
**Fix:**

```javascript
// Move CORS set AFTER the OPTIONS early-return, scope to ALLOWED_ORIGIN:
const allowedOrigin = process.env.ALLOWED_ORIGIN || ''
const origin = req.headers.origin || ''
const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
res.setHeader('Access-Control-Allow-Origin',
  (allowedOrigin && !isLocalDev) ? allowedOrigin : (origin || '*'))
```

---

### MEDIUM — fix before high traffic

#### M-1: Rate limiter is per-Lambda-instance only
**File:** `api/bridge-relay.ts` `allowRelay()`  
**Problem:** In-memory `_relayHits` resets on every cold start and is not
shared across Vercel instances. Under load the 20-calls/10-min limit can be
bypassed.  
**Fix:** Move to Vercel KV or Upstash Redis:

```typescript
// import { kv } from '@vercel/kv'
// const hits = await kv.lrange(`relay:${wallet}`, 0, -1)
// const recent = hits.filter(t => now - Number(t) < 10 * 60_000)
// if (recent.length >= 20) return false
// await kv.lpush(`relay:${wallet}`, now)
// await kv.expire(`relay:${wallet}`, 600)
```

#### M-3: Supabase placeholder client gives no visible error in dev
**File:** `src/lib/supabase.ts`  
**Problem:** When `VITE_SUPABASE_URL` is missing, the client is created with a
placeholder URL. `ensureAnonSession()` silently times out (now warns in console
after B-4 fix) but no UI feedback is shown.  
**Fix:** Add a dev-mode banner in `src/App.tsx` or `src/main.tsx`:

```typescript
if (import.meta.env.DEV && !import.meta.env.VITE_SUPABASE_URL) {
  console.error('[MeshPort] VITE_SUPABASE_URL is not set — copy .env.example to .env')
}
```

---

## Architecture rules — always follow these

1. **Arc USDC has two interfaces over one balance — never mix their units:**
   - Native: `eth_getBalance`, `msg.value`, plain value sends — **18 decimals**.
     The app reads Arc balances this way.
   - ERC-20 at `0x3600000000000000000000000000000000000000` — `transfer`,
     `transferFrom`, `approve`, `balanceOf` — **6 decimals**. `sendUSDC`
     (`src/lib/arcService.ts`) and `MeshPortRewards.sol` use this.
   See `docs/ARCHITECTURE.md` (token table) and `src/blockchain/chains.ts`.

2. **Contracts may use either interface — pick one per contract and keep its
   units consistent.** `P2PMeshportEscrowV2.sol` uses native value
   (`payable`/`.call{value: amount}("")`); `MeshPortRewards.sol` uses the
   ERC-20 interface. Don't "convert" a working contract from one to the other.

3. **Three chain registries must stay in sync:** when adding a chain, update
   all three files listed in H-1 above.

4. **Ledger events are append-only:** never mutate `activity` rows directly to
   fix a display bug. Fix the upstream classifier or indexer and re-project.

5. **`SUBMITTED_UNKNOWN` ≠ `FAILED`:** a transaction whose receipt-wait timed
   out is `SUBMITTED_UNKNOWN`. Never auto-mark it `FAILED` — it may confirm later.

6. **Intents before broadcast:** every financial action that can be retried must
   record a server-side intent BEFORE building or sending the transaction.

7. **No private keys in env vars:** use Circle developer-controlled wallets for
   any server-side signing (bridge relayer, rewards signer).

8. **`ALLOWED_ORIGIN` must be set in production Vercel env vars** for all API
   routes (`api/chat.ts`, `api/bridge-relay.ts`, `api/arc-rpc.js`).

---

## Environment variables required

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=          # or SUPABASE_SERVICE_ROLE_KEY
VITE_SUPABASE_URL=             # same value, exposed to browser
VITE_SUPABASE_ANON_KEY=

# Arc RPC (optional authenticated override — falls back to public Circle RPCs)
ARC_RPC_URL=
DRPC_KEY=
ALCHEMY_ARC_KEY=

# Bridge relay
BRIDGE_RELAYER_PRIVATE_KEY=    # TEMPORARY — migrate to CIRCLE_ENTITY_SECRET + RELAYER_WALLET_ID
BRIDGE_ROUTERS=                # JSON: {"Base_Sepolia":"0x…"}
VITE_P2P_ESCROW_CONTRACT=

# Circle developer-controlled wallets (for C-1/C-3 migration)
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=          # 64 hex chars, registered in Circle Console

# Rewards signer (Supabase secrets for rewards-claim-sign)
REWARDS_SIGNER_WALLET_ID=      # Circle wallet id — preferred
REWARDS_SIGNER_ADDRESS=        # its address; optional sanity check
REWARDS_SIGNER_PRIVATE_KEY=    # LEGACY — delete once the Circle signer is live

# Circle App Kit swap
KIT_KEY=                       # keep server-side only — never VITE_-prefixed

# Web push
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# CORS — set to your production domain
ALLOWED_ORIGIN=https://yourdomain.com
```

---

## Deployed contracts (Arc Testnet)

| Contract | Address |
|----------|---------|
| P2PMeshportEscrowV2 | `0xB3D37ff64A3c9E740e9d49efE346657944729F09` |

Arc Testnet chain ID: `5042002`  
Arc Testnet explorer: `https://testnet.arcscan.app`
