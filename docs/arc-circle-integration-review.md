# MeshPort — Arc/Circle Integration Review
## "What's correct, what's wrong, what Supabase can be removed"
_Generated: 2026-10-06_

---

## 1. Arc RPC Usage — Verdict: CORRECT with 3 bugs

### What is right
| Component | Status |
|-----------|--------|
| `api/arc-rpc.js` — single browser entry point, health-scored failover across 8 endpoints, authenticated DRPC/Alchemy tried first, deterministic revert detection, head-lag retry | ✅ Correct |
| `src/lib/arc.ts` — `ARC_RPCS = ['/api/arc-rpc']` (single same-origin proxy, no key in bundle) | ✅ Correct |
| `arcTransport()` — viem `fallback()` over ARC_RPCS | ✅ Correct |
| `arcRpcJson()` — direct fetch with 429 backoff + failover | ✅ Correct |
| `ARC_NETWORK` static pinning — avoids ethers' eth_chainId retry loop | ✅ Correct |
| `swapService.ts` — routes through `/api/arc-rpc`, never a raw RPC URL | ✅ Correct |
| `ubFundRecovery.ts` — `getArcProvider()` resolves `/api/arc-rpc` to absolute URL before ethers | ✅ Correct |
| `arcService.ts` — `confirmTransactionInBackground` uses 250ms pollingInterval | ✅ Correct |

### Bugs in RPC usage

**BUG-RPC-1 (Medium): `bridge-relay.ts` `callClients()` calls `probe.getChainId()` on every relayed call for Arc**

```ts
// bridge-relay.ts line 256
const probe: any = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) })
const id = await probe.getChainId()   // ← eth_chainId call, no staticNetwork
```
`callClients()` is called for every `action:'call'` relay (Gateway deposit, gatewayMint, receiveMessage). For Arc that's one extra eth_chainId RPC round trip on every gasless bridge relay even though Arc's chainId (5042002) is known and static. On a cold serverless instance this adds latency and can race with the RPC's rate limit.

**Fix:** For known chains (Arc_Testnet, and any chain in CHAINS whose chainId is set), use `defineChain` directly with the known id and skip the `probe.getChainId()` call.

---

**BUG-RPC-2 (Low): `arcService.ts` sends `sendEURC`/`sendCirBTC` with an inline chain object that duplicates `ARC_RPCS`**

```ts
// arcService.ts line 527-532
chain: {
  id: ARC_TESTNET.chainId,
  name: ARC_TESTNET.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ARC_RPCS } },   // ← ARC_RPCS = ['/api/arc-rpc']
},
```
This is only used as viem's `chain:` metadata for signing/chainId — the actual transport is `arcTransport()`, so the value in `rpcUrls` is never used for RPC calls. It is currently correct (ARC_RPCS = `['/api/arc-rpc']`) but is a maintenance trap: if someone imports `ARC_CHAIN_INLINE` from `blockchain/chains.ts` instead, they get the canonical version; if they copy this inline object they may forget to update it. `sendUSDC` already uses `ARC_CHAIN_INLINE` (via `chain: ARC_CHAIN_INLINE` in the sendTransaction call). `sendEURC` and `sendCirBTC` should do the same — replace the inline object with `chain: ARC_CHAIN_INLINE`.

---

**BUG-RPC-3 (Medium): `ubFundRecovery.ts` `getArcProvider()` may fail in non-browser environments**

```ts
const toAbsolute = (url: string) =>
  /^[a-z]+:\/\//i.test(url) ? url
    : (typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin + (url.startsWith('/') ? url : '/' + url)
        : url)  // ← returns '/api/arc-rpc' unchanged when window is undefined
```
In SSR/Worker environments (unlikely here but possible with future Supabase Edge Functions using this module), `toAbsolute('/api/arc-rpc')` returns the relative path unchanged, which ethers' `JsonRpcProvider` passes to `fetch()` and it fails because relative URLs are not valid there. The fallback for a missing window should be a known absolute Arc RPC endpoint, not the relative path.

---

## 2. Arc Chain Configuration — Verdict: CORRECT with 2 issues

### What is right
- `ARC_TOKENS.USDC.nativeDecimals: 18`, `decimals: 6` — correctly distinguishes native (18) from ERC-20 view (6)
- `ARC_TOKENS.USDC.isNative: true` — correct flag
- `arcService.ts` `getUSDCBalance` uses `eth_getBalance` (native, 18-dec), divides by 1e18 — correct
- `sendUSDC` converts 6-dec input to 18-dec: `amount6dec * 10n**12n` — matches Arc docs exactly
- `EURC` uses `eth_call` with `balanceOf` (ERC-20), divides by 1e6 — correct
- `cirBTC` divides by 1e8 — correct

### Issues

**ISSUE-CHAIN-1 (High): `swapService.ts` hardcodes `'Arc_Testnet'` as the chain for both `estimateSwap` and `swap`**

```ts
// swapService.ts lines 300, 351
from: { adapter, chain: 'Arc_Testnet' as any },
```
This will fail on a mainnet deployment because `'Arc_Testnet'` is not a valid mainnet App Kit chain key. Should read `ARC_CHAIN_KEY` from env (same pattern `ubClaim.ts` uses after the previous fix).

**ISSUE-CHAIN-2 (Low): `ubFundRecovery.ts` `removeFund` hardcodes `'Arc_Testnet'`**

```ts
// line 278
await kit.unifiedBalance.removeFund({ from: { adapter, chain: 'Arc_Testnet' as any }, token: 'USDC' })
```
Same mainnet-readiness issue. Should be `ARC_CHAIN_KEY` from env.

---

## 3. Circle App Kit / Unified Balance / Gateway — Verdict: MOSTLY CORRECT with 3 bugs

### What is right
- `ubClaim.ts` `getUnifiedBalances` — uses `networkType` from env (already fixed in previous pass)
- `ubClaim.ts` `runUbClaim` — deposit → wait-for-confirm → spend chain is correct
- `assertDepositSucceeded` — checks on-chain receipt before recording claim ✅
- `signSpendToArc` — intercepts the fetch POST to `/v1/transfer` to capture signed body for server submission ✅ (clever, handles closed-tab recovery)
- `spendUnifiedTo` — forwarder-first with self-mint fallback when forwarder fails ✅
- `GATEWAY_SELF_MINT_CHAINS` — correctly pre-bypasses forwarder for Sei ✅
- `forwarderMintRetry` — correctly detects ON_CHAIN_FAILURE and retries as self-mint ✅
- `ubFundRecovery.ts` `initiateRemoveFund` / `removeFund` — correct 7-day timelock pattern ✅
- `getUbWithdrawalStatus` — reads withdrawal state directly from Gateway contract on Arc ✅

### Bugs

**BUG-UB-1 (High): `signSpendToArc` monkey-patches `globalThis.fetch` non-atomically**

```ts
globalThis.fetch = (async (input, init) => {
  // ... capture /v1/transfer POST
}) as typeof fetch
try {
  await kit.unifiedBalance.spend(...)
} catch { /* expected */ } finally {
  globalThis.fetch = realFetch
}
```
If two `signSpendToArc` calls run concurrently (merchant auto-convert + manual recovery on two tabs via BroadcastChannel), both patch `globalThis.fetch` and both restore `realFetch` to what they saw at their call time — the second caller's restore may re-install the first caller's patched version. The `finally` only restores the reference captured at call entry; if a third (unchained) fetch arrives between the two concurrent calls, it goes through both patches. This is a race condition in the fetch-capture path.

**Fix:** Use a mutex/lock (Web Locks API, same pattern `withChainLock` already uses) around the fetch-monkey-patch window.

---

**BUG-UB-2 (Medium): `runMerchantAutoConvert` uses `new AppKit()` with no Kit Key**

```ts
// ubClaim.ts line 522
const kit = new AppKit({ disableErrorReporting: true } as any)
```
`AppKit` for Unified Balance (deposit/spend) does NOT require a Kit Key — those operations are permissionless. But `swapService.ts`'s `getKit()` comment says "routeSwapServiceThroughServer()" to patch the Kit Key for swap calls. This is fine here because the merchant auto-convert never calls `kit.swap()`. No bug in practice, but the pattern should be documented to avoid accidentally adding a swap call here without the proxy.

---

**BUG-UB-3 (Medium): `autoFinishUbClaims` does not guard against overlapping runs with `withChainLock`**

```ts
// ubClaim.ts line 607
for (const r of ready) {
  if (inFlight.has(r.chain)) continue
  inFlight.add(r.chain)   // ← Set.add is synchronous but the await below creates a gap
  try {
    const out = await spendUnifiedToArc(...)
```
`inFlight.add(r.chain)` happens synchronously before the `await`, so within one invocation of `autoFinishUbClaims` a second iteration of the loop correctly sees the chain as in-flight. But `autoFinishUbClaims` itself has a `sweeping` boolean guard against two OVERLAPPING RUNS — it's correct. The issue is that `withChainLock` (which uses Web Locks API for cross-tab coordination) is not called here, only the in-memory `inFlight` set is. A second tab can start a spend on the same chain simultaneously if one tab's `autoFinishUbClaims` holds it in `inFlight` but the other tab doesn't see that (in-memory only, not cross-tab). The manual `runUbClaim` uses `withChainLock` correctly; the auto-finish path should too.

---

## 4. CCTP / Bridge — Verdict: CORRECT with 2 gaps

### What is right
- `cctpTracker.ts` CCTP domain map — complete (all 22 chains) ✅
- IRIS URL env-driven — `VITE_IRIS_ENV` in client, `IRIS_ENV` in server — already fixed ✅
- `bridge-relay.ts` `CHAINS` — correct chain ids, USDC addresses, domains for all 20 source chains ✅
- `bridge-relay.ts` self-bridge-only guard (`destinationDomain === ARC_DOMAIN`) ✅
- `bridge-relay.ts` authorization validation (EIP-3009 window, mintRecipient === from, min amount) ✅
- `bridge-relay.ts` idempotent relay — `authorizationState` check before submitting ✅
- `checkRelayable` — allowlist of exactly the functions the relayer will call ✅

### Gaps

**GAP-CCTP-1 (High): `bridge-relay.ts` `CHAINS` uses single public RPCs with no fallback**

Every entry in `CHAINS` has exactly one `rpc` URL. For the relay action (bridgeWithAuthorization) this is the ONLY RPC used — there is no `EXTRA_RPCS` fallback for bridge relay (only for `action:'call'`). When a chain's public node is rate-limited or down (e.g. `sepolia.optimism.io`, `rpc-hoodi.morphl2.io`), the relay fails completely with no retry path.

**Fix:** Change `clients()` to accept a list of RPCs from `CHAINS[chainKey]` (add an optional `rpcs: string[]` alongside `rpc`) and use viem's `fallback()` transport, same pattern as the client-side `arcTransport()`.

---

**GAP-CCTP-2 (Medium): `bridge-relay.ts` `CHAINS.Sonic_Testnet` missing secondary RPC**

`chains.ts` (client) has `Sonic_Testnet` with TWO entries (`rpc.testnet.soniclabs.com` + `sonic-testnet.rpc.thirdweb.com`) because `rpc.testnet.soniclabs.com` returns sustained 503s during outages. `bridge-relay.ts` has only `rpc.testnet.soniclabs.com`. During a Sonic outage, bridge-relay silently fails all Sonic bridges while the client correctly falls over to thirdweb.

---

## 5. Swap — Verdict: CORRECT with 1 bug

### What is right
- Private key never sent to server (client-side signing via `createEthersAdapterFromPrivateKey`) ✅
- Kit Key stays server-side — browser routes `api.circle.com/v1/stablecoinKits/*` through `/api/swap-proxy` ✅
- `swap-proxy.js` `relayStablecoinService` — path allowlist, wallet ownership check, wallet mismatch guard ✅
- `swapService.ts` `buildArcForwardProvider` — routes through `/api/arc-rpc`, 200ms polling ✅
- `verifySwapLanded` — on-chain fallback when swap throws but may have succeeded ✅
- `recordCompletion` — write activity + mark attempt server-side (closes orphan-tx race) ✅

### Bug

**BUG-SWAP-1 (already noted as ISSUE-CHAIN-1 above):** `'Arc_Testnet'` hardcoded in `estimateSwapLocal` and `runSwap` — mainnet-readiness issue, replace with env-driven `ARC_CHAIN_KEY`.

---

## 6. Supabase — What to Keep vs. Replace

### KEEP IN SUPABASE (no Arc/Circle native equivalent)
These features require a relational database, real-time subscriptions, or server-side auth. There is no Circle service that replaces them.

| Feature | Table(s) | Why keep |
|---------|----------|----------|
| **User identity** (username `.arc`, display name, avatar) | `users` | No Circle identity registry. Username resolution (`sunil.arc → 0x…`) is app-specific. |
| **Encrypted chat** (E2E message storage, delivery receipts) | `conversations`, `messages` | No Circle messaging service. Supabase Realtime is the only real-time delivery path here. |
| **Contacts** | `contacts` | App-level social graph, no Circle equivalent. |
| **P2P trade state** (offer listings, trade negotiations, dispute records) | `users` (counterparty lookup), `activity` (trade events) | Supplementary to on-chain escrow; on-chain is source of truth but off-chain metadata (offer description, fiat method, dispute notes) needs DB. |
| **Support tickets** | `support_tickets` | App-specific, no Circle equivalent. |
| **Push notification tokens** | via `api/push.ts` | WebPush/APNS delivery, no Circle equivalent. |
| **Auth** (Google/email OTP login, bind-session) | Supabase Auth | Required for social login flow. |

---

### REMOVE FROM SUPABASE — Replace with Arc/Circle native

These are the clearest candidates for replacement. Each is currently redundant with a Circle service that is already being used.

---

#### REMOVE-1 (High Impact): `transactions` + `transaction_notes` tables

**What they do:** Store a copy of every Arc send (sender, receiver, amount, txHash, note) so the Activity page can show it instantly after payment without waiting for ArcScan indexing.

**The problem:** Arc's own chain is the source of truth. These rows can drift from reality (double entries, wrong amounts if there's a rounding mismatch, missed entries if the Supabase write fails after a successful broadcast). `ActivityService.ts` has to run a complex deduplication pipeline to reconcile them with on-chain data.

**Replace with:** Arc RPC `eth_getLogs` + `eth_getTransactionReceipt`. `arcDepositWatcher.ts` and `onchainReceivedActivity.ts` already scan Arc directly via `arcRpcJson`. The Activity page can read these two sources exclusively. For "note" metadata (payment memo, source classification), use a small local IndexedDB store keyed by txHash — it survives page refresh but requires no server.

**What to keep:** The `activity` table's `multichain`, `bridge`, `claim`, `swap`, `ub_claim` rows (non-Arc-native events that don't appear in Arc's own logs). Only the pure `sent`/`received` Arc-native rows are redundant.

---

#### REMOVE-2 (High Impact): `multichain_transactions` table

**What it does:** Stores hashes of Arc-side mints from CCTP/Gateway claims, so `ActivityService` can classify an incoming Transfer log as `multichain` instead of `received`.

**The problem:** These mints arrive via Circle's MessageTransmitter or Gateway contracts. The contract emitter address is already known and constant. `onchainReceivedActivity.ts` can classify any incoming transfer whose `from` address matches `MESSAGE_TRANSMITTER_V2` or `GATEWAY_MINTER` as a multichain credit — no DB lookup needed.

**Replace with:** Classify by `from` address at scan time:
```ts
const MULTICHAIN_SENDERS = new Set([
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // MessageTransmitter V2
  '0x0022222abe238cc2c7bb1f21003f0a260052475b', // GatewayMinter
])
if (MULTICHAIN_SENDERS.has(log.from.toLowerCase())) type = 'multichain'
```

---

#### REMOVE-3 (Medium Impact): `ub_claim_intents` table

**What it does:** Holds signed-but-unsubmitted Gateway spend bodies so the server (`ub-claim-worker` Edge Function) can submit them even when the user's app is closed.

**The problem:** This requires Supabase + a background Edge Function just to persist one Circle API call. Circle's own `@circle-fin/app-kit` `spend()` is the canonical path; the "offline completion" value is real but the mechanism is bespoke.

**Keep for now, but reduce scope:** The core value (server finishing the spend after the user closes the app) is real. However the signed body stored in `transfer_body` is large (Base64 BLS signatures) and the table grows unboundedly. Add a retention policy: delete rows older than 30 days with `status IN ('completed','failed','expired')`.

---

#### REMOVE-4 (Medium Impact): Session verification via Supabase in `swap-proxy.js` and `bridge-relay.ts`

**What it does:** Both server routes call `SUPABASE_URL/auth/v1/user` with the user's JWT to verify the session, then look up the wallet address via `SUPABASE_URL/rest/v1/users`.

**The problem:** This is TWO extra network round-trips (auth verify + wallet lookup) on every single swap quote, bridge quote, and bridge submission. Under load this is a 200–500ms tax on every Arc financial operation.

**Replace with:** Embed the wallet address in a signed session claim. On wallet unlock, sign a short-lived JWT (or use the Supabase JWT's `sub` claim plus a server-side lookup table cached in-memory) instead of doing a DB round-trip per request. At minimum, cache the `(token → wallet)` mapping in-memory in both server functions for 5 minutes — `swap-proxy.js` already does this (`_sessions` Map), but `bridge-relay.ts` does NOT. Add the same cache to `bridge-relay.ts`'s `sessionWallet()`.

---

#### REMOVE-5 (Low Impact): `rewards` + `reward_claims` tables

**What they do:** Store reward definitions and per-user claim records.

**Replace with:** Circle Smart Contract Platform — deploy a `MeshPortRewards.sol` contract that issues USDC rewards on-chain with duplicate-claim protection enforced by `mapping(bytes32 => bool) claimed`. The current `reward_claims` table is pure off-chain bookkeeping; an on-chain contract makes it trustless and verifiable. The existing `MeshPortRewards.sol` is already in the repo — it just needs to be wired to the UI instead of the Supabase tables.

---

## 7. All Other Bugs Found

### arcService.ts

**BUG-ARC-1 (Medium): `estimateTransferFee` creates a full `PublicClient` for every estimate**

```ts
const publicClient = createPublicClient({ transport: arcTransport({ timeout: 10000 }) })
const gasPrice = await publicClient.getGasPrice()
```
Called on every `preparePayment()` (which fires at PIN entry). `createPublicClient` is cheap but `getGasPrice()` is a full round-trip. The gas price changes slowly — cache it for 30s and reuse.

---

**BUG-ARC-2 (Low): `toPlainDecimalString` uses `toLocaleString` which is locale-dependent in non-`en-US` environments**

```ts
return amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals })
```
Locale is explicitly `'en-US'` so this is safe in V8/Node. Fine.

---

### swapService.ts

**BUG-SWAP-2 (Medium): `_adapterCache` keyed by last-8-chars of private key**

```ts
const keyTail = privateKey.slice(-8)
if (_adapterCache?.keyTail === keyTail) return _adapterCache.adapter
```
Two different private keys could share the same last 8 characters. While a collision is unlikely (2^32 chance per key pair), it is cryptographically unsound to use a truncated key suffix as a cache discriminator. Use a non-reversible hash: `const keyTail = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(privateKey)).then(b => Array.from(new Uint8Array(b)).slice(0,4).map(x=>x.toString(16).padStart(2,'0')).join(''))`.

---

### bridge-relay.ts

**BUG-BRIDGE-1 (Medium): `_relayHits` Map grows unboundedly on the warm Lambda instance**

```ts
if (_relayHits.size > 5000) _relayHits.clear()
```
`_relayHits.clear()` nukes ALL rate-limit windows, including legitimate current ones. A burst of 5001 unique wallet addresses clears everyone's window and immediately allows 20 more relayed calls per wallet. Use an LRU-eviction strategy instead of a full clear.

---

**BUG-BRIDGE-2 (Low): `bridge-relay.ts` `relayCall` returns `res.status(200)` with `pending: true` on timeout**

```ts
try {
  const receipt = await cl.pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
  if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
  return res.status(200).json({ txHash })
} catch {
  return res.status(200).json({ txHash, pending: true })
}
```
The client that receives `pending: true` must poll for the receipt itself. `gaslessBridge.ts` does check for `pending` but only for bridge relay — `relayCall` (Gateway deposit, gatewayMint, receiveMessage) doesn't have the same polling path in the client. If the receipt wait times out for a `gatewayMint`, the client never gets the confirmed hash and the claim stalls silently.

---

### supabase.ts

**BUG-SUPA-1 (Low): `getUsersByWalletAddresses` builds an unbounded `or()` filter**

```ts
const orFilter = addrs.map(a => `wallet_address.ilike.${a}`).join(',')
```
For 100+ addresses this creates a URL query string that can exceed Supabase/PostgREST's URL length limit (~8 KB). Batch into groups of 25 and union the results.

---

**BUG-SUPA-2 (Low): `fetchConversations` fetches up to 1000 messages in one query**

```ts
.limit(Math.min(Math.max(convIds.length * 10, 100), 1000)),
```
A user with 100 conversations fetches 1000 messages on every Chats page open, transferring ~200 KB. Cap at 5 per conversation (sufficient for previews) and fetch full history lazily.

---

### ubFundRecovery.ts

**BUG-RECOVERY-1 (Medium): `resolveUbStuckTransfer` hardcodes `'Arc_Testnet'` in two places**

```ts
// lines 442, 463, 464, 466, 469
toChain = mode === 'refund' ? 'Arc_Testnet' : item.destinationChain
...
destination_chain: 'Arc_Testnet',
explorer_url: `https://testnet.arcscan.app/tx/${out.txHash}` : null,
```
Same mainnet-readiness issue as the others. Replace with `ARC_CHAIN_KEY` and `ARC_EXPLORER_URL` from env.

---

## 8. Summary Table

| # | File | Severity | Category | One-line description |
|---|------|----------|----------|---------------------|
| BUG-RPC-1 | bridge-relay.ts | Medium | RPC | `callClients()` calls `getChainId()` on every relay even for chains with known ids |
| BUG-RPC-2 | arcService.ts | Low | RPC | `sendEURC`/`sendCirBTC` use inline chain object instead of `ARC_CHAIN_INLINE` |
| BUG-RPC-3 | ubFundRecovery.ts | Medium | RPC | `getArcProvider()` returns relative URL when `window` is undefined |
| ISSUE-CHAIN-1 | swapService.ts | High | Chain | `'Arc_Testnet'` hardcoded in `estimateSwapLocal` and `runSwap` — breaks mainnet |
| ISSUE-CHAIN-2 | ubFundRecovery.ts | Low | Chain | `'Arc_Testnet'` hardcoded in `removeFund` calls |
| BUG-UB-1 | ubClaim.ts | High | UB/Gateway | `signSpendToArc` monkey-patches `globalThis.fetch` without cross-call mutex |
| BUG-UB-2 | ubClaim.ts | Low | UB | `runMerchantAutoConvert` uses `new AppKit()` with no Kit Key (acceptable but undocumented) |
| BUG-UB-3 | ubClaim.ts | Medium | UB | `autoFinishUbClaims` uses in-memory `inFlight` only, not Web Locks (cross-tab race) |
| GAP-CCTP-1 | bridge-relay.ts | High | CCTP | `CHAINS` has single public RPC per chain, no fallback for bridge relay |
| GAP-CCTP-2 | bridge-relay.ts | Medium | CCTP | `Sonic_Testnet` missing secondary RPC (client has 2, server has 1) |
| BUG-SWAP-1 | swapService.ts | High | Swap | `'Arc_Testnet'` hardcoded — same as ISSUE-CHAIN-1 |
| BUG-SWAP-2 | swapService.ts | Medium | Swap | Adapter cache keyed by 8-char key tail (collision risk) |
| BUG-ARC-1 | arcService.ts | Medium | Arc | `estimateTransferFee` creates client + fetches gas price on every call, no cache |
| BUG-BRIDGE-1 | bridge-relay.ts | Medium | Bridge | `_relayHits.clear()` nukes all rate-limit windows (use LRU, not clear) |
| BUG-BRIDGE-2 | bridge-relay.ts | Low | Bridge | `relayCall` returns `pending:true` on timeout with no client-side polling path |
| BUG-SUPA-1 | supabase.ts | Low | DB | `getUsersByWalletAddresses` unbounded `or()` filter — batch to 25 |
| BUG-SUPA-2 | supabase.ts | Low | DB | `fetchConversations` fetches up to 1000 messages per open |
| BUG-RECOVERY-1 | ubFundRecovery.ts | Medium | Recovery | `resolveUbStuckTransfer` hardcodes `'Arc_Testnet'` and testnet explorer URL |
| REMOVE-1 | supabase.ts | Refactor | Supabase | `transactions`/`transaction_notes` tables — replace with Arc RPC scan + local IndexedDB |
| REMOVE-2 | supabase.ts | Refactor | Supabase | `multichain_transactions` table — replace with `from`-address classification at scan time |
| REMOVE-3 | supabase.ts | Refactor | Supabase | `ub_claim_intents` — keep but add 30-day retention policy |
| REMOVE-4 | bridge-relay.ts | Refactor | Supabase | Session verify via Supabase on every bridge call — add in-memory cache to `bridge-relay.ts` |
| REMOVE-5 | supabase.ts | Refactor | Supabase | `rewards`/`reward_claims` — replace with `MeshPortRewards.sol` on-chain contract |
