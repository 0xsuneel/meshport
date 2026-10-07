# MeshPort Audit — Fix Status

All 40 findings from `docs/meshport-audit.md` have been triaged. Below is the
fix status for every item that required a code change, grouped by the file
where the change landed. Items marked **[FIXED]** have source edits committed
in this pass. Items marked **[ENV ONLY]** require a Vercel/Supabase environment
variable to be set — the code already reads from the correct env var; no
additional source change is needed. Items marked **[DESIGN]** are architectural
decisions documented for the next sprint.

---

## Critical / High Security

### 1. Anon key used as Authorization bearer on writes — `src/lib/supabase.ts` [FIXED]

**Finding:** `markMessagesRead` and `restInsertMessage` both sent `Authorization: Bearer <anon-key>`
on mutating HTTP requests. Any unauthenticated caller could trigger those endpoints as if signed in.

**Fix:** Both functions now call `supabase.auth.getSession()` and use the real session JWT as
the bearer. The anon key is only ever used in the `apikey` header (as Supabase requires), never
as the Authorization bearer for writes or lookups.

---

### 2. Anon key used for user-data lookup — `src/lib/ActivityService.ts` [FIXED]

**Finding:** `fetchActivity` Pass 4 (username resolution) fetched `/rest/v1/users` with
`Authorization: Bearer <anon-key>` — a user-data query that should be scoped to the session.

**Fix:** Replaced with `authHeaders()` (session JWT) from `chatService.ts`. The unused `SUPA_KEY`
variable in `fetchActivity` was also removed.

---

### 3. IRIS API hardcoded to sandbox — `src/lib/cctpTracker.ts`, `api/bridge-relay.ts` [FIXED]

**Finding:** `https://iris-api-sandbox.circle.com` was hardcoded in both files. Any production
deployment would query the sandbox attestation API, making every mainnet CCTP mint invisible.

**Fix:** Both files now read `VITE_IRIS_ENV` (client) / `IRIS_ENV` (server). Default is
`'production'` → `https://iris-api.circle.com`. Set the variable to `'sandbox'` for testnet
deployments.

**Env vars to set:**
- Vercel: `IRIS_ENV=sandbox` (testnet deployments), `IRIS_ENV=production` or omit (mainnet)
- Client: `VITE_IRIS_ENV=sandbox` (testnet builds), omit or `VITE_IRIS_ENV=production` (mainnet)

---

### 4. Hardcoded Supabase project URL fallback — `api/bridge-relay.ts`, `api/swap-proxy.js` [FIXED]

**Finding:** Both files fell back to `'https://cvvpzfvzweszuuxvaayb.supabase.co'` when
`SUPABASE_URL` was unset, leaking the project URL in source and silently binding to the wrong
project in staging/preview environments.

**Fix:** The literal fallback is removed. Both files now warn to console when `SUPABASE_URL` is
unset and let the request fail visibly rather than silently routing to the wrong project.

**Env vars required:**
- Vercel: `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` (one of these must be set)
- Vercel: `SUPABASE_SERVICE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`

---

### 5. Session private key in plain-text sessionStorage — `src/lib/security.ts` [FIXED]

**Finding:** `cacheSessionPrivateKey` stored the raw private key as a plain string in
`sessionStorage`. Any XSS or browser storage inspector could read it directly.

**Fix:**
- Added an in-memory `Map` as the primary cache (never serialised anywhere; cleared on page unload).
- sessionStorage is now a fallback for cross-reload persistence only, and the value is
  device-wrapped (AES-GCM under the non-extractable IndexedDB key) before writing, matching the
  same layer that already protects the persisted encrypted key.
- Both `cacheSessionPrivateKey` and `getSessionPrivateKey` are now `async`.
- Call sites in `store/index.ts` and `restoreWallet.ts` updated accordingly.

---

## Integration / Configuration Bugs

### 6. UB `networkType` hardcoded to `'testnet'` — `src/lib/ubClaim.ts` [FIXED]

**Finding:** `getUnifiedBalances` always passed `networkType: 'testnet'` to App Kit. On a
mainnet deployment this returned 0 for every UB balance, making claims and Recover permanently
invisible.

**Fix:** `UB_NETWORK_TYPE` is now derived from `VITE_NETWORK_ENV`. Set `VITE_NETWORK_ENV=mainnet`
for production builds; testnet is the default.

**Env var:** `VITE_NETWORK_ENV=mainnet` (production) / omit or `VITE_NETWORK_ENV=testnet` (testnet)

---

### 7. `'Arc_Testnet'` chain key hardcoded throughout — `src/lib/ubClaim.ts`, `src/lib/ActivityService.ts` [FIXED]

**Finding:** All `toChain`, `destinationChain`, and auto-sweep filter references used the literal
`'Arc_Testnet'`, making the app non-functional on mainnet Arc.

**Fix:** Both files now derive `ARC_CHAIN_KEY` from `VITE_NETWORK_ENV` (`'Arc'` on mainnet,
`'Arc_Testnet'` on testnet). All six literal occurrences replaced.

---

### 8. `EXTRA_RPCS` single-endpoint Arc RPC + Injective missing — `api/bridge-relay.ts` [FIXED]

**Finding:** `EXTRA_RPCS.Arc_Testnet` was a single hardcoded public RPC endpoint; a rate-limit
on it took down every Arc-facing relayed call. `Injective_Testnet` was missing from `EXTRA_RPCS`
entirely, so `receiveMessage` relays on Injective always failed.

**Fix:**
- `Arc_Testnet` now prefers `process.env.ARC_RPC_URL || process.env.BRIDGE_RPC_ARC_TESTNET`
  before falling back to the public endpoint.
- `Injective_Testnet` added, reading from `process.env.BRIDGE_RPC_INJECTIVE_TESTNET` or the
  `CHAINS.Injective_Testnet.rpc` value already present in the CHAINS table.
- `Edge_Testnet` reads from `BRIDGE_RPC_EDGE_TESTNET` env var first.

**Env vars (optional, for higher rate limits):**
- `ARC_RPC_URL` — authenticated Arc RPC endpoint
- `BRIDGE_RPC_ARC_TESTNET` — alternative name for the same
- `BRIDGE_RPC_INJECTIVE_TESTNET` — authenticated Injective RPC

---

## Smart Contract Fixes

### 9. `MeshPortBridgeRouter`: no ETH recovery + stale approval — `contracts/MeshPortBridgeRouter.sol` [FIXED]

**Finding 1:** No `receive()` function. Native tokens accidentally sent to the router are
permanently locked — there is no `sweep` function.

**Fix:** Added `receive() external payable { revert(...) }` to reject all native-token transfers
at the contract level, preventing accidental lockup.

**Finding 2:** `approve(tokenMessenger, amount)` was called without first resetting to 0.
Some ERC-20 tokens revert on a non-zero-to-non-zero approval.

**Fix:** Added `usdc.approve(address(tokenMessenger), 0)` before the main approval, and a second
reset to 0 after the burn. CCTP's `depositForBurn` consumes the exact approved amount so the
post-burn reset is always a safe no-op; it makes the intent explicit and protects against edge
cases.

---

### 10. `P2PMeshportEscrowV2`: no seller response timeout after `buyerPaid` — `contracts/P2PMeshportEscrowV2.sol` [FIXED]

**Finding:** Once the buyer marked a trade paid (`buyerPaid = true`), an unresponsive or malicious
seller could leave funds locked indefinitely — `release()` is seller-only, and the dispute path
requires the Pauser to notice and act manually.

**Fix:** Added `SELLER_RELEASE_TIMEOUT = 24 hours` constant and `forceFreezeStalePaidTrade()`
function in the Pauser tier. After 24 hours past `registeredAt`, any Pauser may force-freeze a
paid-but-unreleased trade, enabling the full dispute pipeline. This does not change who can
release funds — only the seller or admin-after-dispute can do that; this gives Pausers a
time-gated escalation path instead of requiring manual monitoring.

---

## Remaining Open Items (not fixed in this pass)

These items from the original audit require larger architectural changes or
explicit product decisions:

| # | Finding | Action needed |
|---|---------|--------------|
| A | Supabase dependency reduction (contacts, activity cache, auth) | Architecture sprint — IndexedDB local cache for contacts + activity; passkey-derived local auth |
| B | CCTP domain map sync between `cctpTracker.ts` and `bridge-relay.ts` `CHAINS` | Review — `CHAINS` now covers the relayer side; `cctpTracker.CCTP_DOMAINS` includes additional chains (Injective, Morph, Pharos, Edge, Sonic) that the relayer does not bridge from. Add to `CHAINS` when those routes are enabled. |
| C | `backfillActivityFromMessages` N+1 query (O(n) Supabase round-trips) | Performance sprint — batch all conversation/user lookups |
| D | P2P order-book off-chain in Supabase (`offers` table) | On-chain indexing or subgraph for full trustlessness |
| E | `arc-rpc.js` no rate-limit on `/api/arc-rpc` endpoint | Add IP + wallet rate limiting in Vercel middleware |
| F | `bridge-relay.ts` in-memory `_relayHits` rate limiter resets on cold start | Replace with Vercel KV or upstash Redis for persistent per-wallet throttling |

---

*Generated by Arc Studio audit-fix pass. See `docs/meshport-audit.md` for the original findings.*
