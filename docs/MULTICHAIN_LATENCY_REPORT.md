# Multichain latency investigation (Transfer, Bring, Unified Balance, CCTP, EURC, cirBTC)

Date: 2026-10-31. Everything below was measured against the live services
(Circle Iris sandbox, Arc Testnet RPC, meshport.xyz `/api/*`) from outside the app.
No wallet was used and no funds were moved.

## Verdict

USDC Arc to another chain is already fast in the wild. The slow paths are:

| Path | Observed | Cause | Status |
|---|---|---|---|
| EURC / cirBTC quote (cold server) | 10.4 s and 19.8 s | Server walked Circle's whole token registry (964 tokens, 20 sequential pages) | Fixed |
| EURC / cirBTC quote (warm server) | 1.2 to 2.9 s | 3 to 5 chained RPC reads plus a gas-price read, every time | Fixed |
| EURC / cirBTC "Finding chains..." in the browser | seconds on a phone | Same full-registry walk, plus loading the whole Circle kit just to read domain ids | Fixed |
| Bring Confirm (all tokens) | one extra round trip | The fee quote Review showed was fetched again at Confirm | Fixed |
| Every Arc read (balances, allowance, gas, receipts) | 0.41 to 0.46 s each | All reads went through the Vercel proxy; Circle's own endpoint answers in 0.06 to 0.09 s | Fixed (reads only) |
| Bring tracking showing "Burning..." | up to 4 s late | Poll every 4 s; default Iris was production (wrong network for testnet) | Fixed |
| Bring via Unified Balance (Ethereum, Base, Arbitrum, OP, Unichain, World) | 3 to 20 min | Gateway waits for the SOURCE chain's finality before crediting a deposit | By design, see below |
| EURC / cirBTC Transfer out of Arc | slow steps | Uses the Circle SDK (about 30 sequential RPC calls per Arc step); USDC has a direct path, these do not | Not changed, see below |

## What I measured

### USDC, Arc to another chain (real burns on Arc, last 8 hours)

Burn on Arc to mint on the destination, from chain timestamps:

| Destination | Mint by | Burn to mint |
|---|---|---|
| Avalanche Fuji | Circle forwarder | 5 to 6 s |
| Arbitrum Sepolia | Circle forwarder | 5 s |
| Base Sepolia | Circle forwarder | 5 to 6 s |
| OP Sepolia | Circle forwarder | 8 s |
| Ethereum Sepolia | MeshPort relayer (2 gwei tip) | 10 to 12 s |

Every forwarder transfer in the sample (Sei, HyperEVM, World, Sonic, Unichain,
Amoy and others) was attested and forwarded. The earlier Ethereum 57 to 162 s
problem noted in `api/bridge-relay.ts` is gone with the tip floor.

Circle's Fast Transfer allowance is healthy on both Iris environments, so Fast
transfers are not being throttled.

### USDC, Bring (chain to Arc)

`/api/bridge-relay?action=quote` answers in 0.25 to 0.9 s warm for 19 of 21
chains (Codex and Edge have no router, by design). The deployed client bundle
ships routers for every chain and sets `VITE_IRIS_ENV=sandbox`, and the live
quote uses sandbox fee tables (slope of 1.3 bps, matching the sandbox), so the
live deployment is configured correctly.

The repository default was not: both the app and `api/bridge-relay.ts` defaulted
to **production** Iris. Testnet burns do not exist there. Production's
Base Sepolia to Arc fee row is 0.325 bps plus 17.5k; the sandbox's is 1.3 bps
plus 20.9k. A maxFee cap built from the production table can be below what the
sandbox requires, and Circle holds such a transfer (`insufficient_fee`) until
standard finality, 15+ minutes instead of about 10 s. Any fresh deploy, preview
or fork without `IRIS_ENV` / `VITE_IRIS_ENV` hit this. Fixed by defaulting to
sandbox in both places.

### EURC and cirBTC

Circle's registry (sandbox) lists:

| Token | Id | Chains (CCTP domain) |
|---|---|---|
| EURC | `0x2587...eecd` | Ethereum Sepolia (0), Avalanche Fuji (1), Base Sepolia (6), World Chain Sepolia (14), Ink Sepolia (21), Arc (26) |
| cirBTC | `0x7c27...cc7d` | Ethereum Sepolia (0), Arc (26) |

Checked against the code:

- Token ids, Arc addresses (EURC `0x89B5...D72a`, cirBTC `0xf0C4...32BF`) and
  decimals (6 and 8) match the registry and Arc's docs.
- Live `token_quote` works for EURC from Ethereum, Fuji, World and Ink, and for
  cirBTC from Ethereum. It correctly refuses EURC from Arbitrum / OP and cirBTC
  from Base ("can't be brought from this chain right now").
- Fees are sane: EURC 0.034 to 0.089, cirBTC 0.00000382.
- Ink Sepolia EURC works on the server but the client route list
  (`CCTPX_CHAIN_DEFS`) does not include Ink, so the app never offers it.

### Arc and Circle services

- Arc Testnet RPC (`rpc.testnet.arc.io`): 52 to 90 ms. Through `/api/arc-rpc`:
  410 to 1,020 ms. Circle, Blockdaemon, dRPC and QuickNode all answer; the three
  Circle-provisioned ones send CORS for `https://meshport.xyz`.
- The app only uses `*.arc.io` endpoints (the old `*.arc.network` hosts were
  retired), good.
- Iris sandbox and production both healthy (fees in 150 to 250 ms).
- Observation, not MeshPort: about 235 Arc to Ethereum Sepolia burns in the
  last 4 hours have `maxFee = 0`, no forwarding hook and were never minted.
  That is not MeshPort's relay pattern (fee above 0, minted in 10 to 12 s), so
  it looks like other testnet traffic. If any belong to your users they appear
  in Multichain Hub, Recover.

## Changes made

| File | Change |
|---|---|
| `api/bridge-relay.ts` | Default Iris is sandbox (`IRIS_ENV=production` opts in) |
| `api/bridge-relay.ts` | CCTPx token lookup is one filtered request (`?tokenId=`), cached 5 min, keeps serving the last good answer if Circle is down; the full walk is only a fallback and now uses 200 per page (5 pages, not 20) |
| `api/bridge-relay.ts` | Token signing domain (EIP-3009 probe and EIP-712 domain) read once per token and chain instead of on every quote |
| `api/bridge-relay.ts` | Quote reads the quote, signing domain and gas price together; token relay reads replay check, Circle quote, balance and gas price together; USDC relay starts the quote and balance read while the nonce is read |
| `src/lib/cctpTracker.ts` | Default Iris is sandbox; progress lookup tries the other Iris when the first has no record; poll every 2 s (was 4 s) |
| `src/lib/fastCctp.ts` | Fee table comes only from the configured Iris |
| `src/lib/gaslessBridge.ts`, `src/lib/gaslessToken.ts` | The quote shown on Review is reused at Confirm for 20 to 25 s (same chain, token, amount and recipient); dropped after a failed relay. The relayer still re-prices and refuses a fee that fell too far behind |
| `src/lib/tokenBridge.ts` | Route discovery asks Circle for the two tokens by id in parallel, uses the app's own domain table (no kit import), and remembers the last routes on the device so a new session shows them instantly and refreshes behind |
| `src/lib/arc.ts` | Reads (`eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getBalance`, `eth_blockNumber`, `eth_getTransactionReceipt`) try Circle's Arc endpoint directly, falling back to the proxy on any error. Sends, relays and nonce reads still use the proxy only. A refused direct request parks the lane for 10 minutes |
| `.env.example` | Documents `VITE_IRIS_ENV` / `IRIS_ENV` |

Tests added or extended: `arc.test.ts`, `cctpxRegistry.test.ts`,
`tokenBridge.test.ts`, `cctpTracker.test.ts`. The 89 related tests passed; the
full suite had 7 failures and 32 unloadable files that need packages this
sandbox does not have (`@supabase/supabase-js`, `ethers`, `react-router-dom`),
none touching these changes.

## Not changed, and why

1. **Bring via Unified Balance is slow by design.** Gateway credits a deposit
   only after the source chain finalizes: seconds on Avalanche, Polygon, Sonic,
   Sei, HyperEVM; 13 to 20 minutes on Ethereum, Base, Arbitrum, OP, Unichain,
   World. The screen already defaults to CCTP (20 to 90 s) and labels both
   times. It falls back to Unified Balance silently only when a chain has no
   router. Recommendation: keep CCTP as the default and, on the slow-finality
   chains, show the Unified Balance option as secondary.
2. **EURC / cirBTC Transfer out of Arc still uses the Circle SDK.** USDC has a
   direct path (`fastCctp.ts`) because the SDK made about 30 sequential RPC
   calls per Arc step. The CCTPx equivalent would call the CrossChainTokenService
   contracts directly the way the Bring router does. That moves funds, so it
   needs a funded test wallet to verify before shipping. It is the next best win.
3. **Unified Balance Transfer asks for the fee estimate twice** (before and
   after the deposit). Reusing the first one when the deposit amount is
   unchanged saves one Gateway round trip; I left it because it sits on the
   money path of a 4,000-line screen and needs an on-chain run to verify.
4. **Add Ink Sepolia to the EURC routes** (`CCTPX_CHAIN_DEFS`, plus the Bring
   chain list). The relayer already supports it.
5. **Arc to Ethereum Sepolia uses the relayer, not Circle's forwarder.**
   Circle's forwarding fee row for Arc to Ethereum has `high` at 1.62 USDC
   (`med` 0.05), which would make a 2 USDC transfer fail the fee cap. The
   relayer path takes 10 to 12 s, so this is the right trade today.

## Deploy checklist

- Vercel: `IRIS_ENV` unset or `sandbox` (testnet). `production` only for mainnet.
- Build: `VITE_IRIS_ENV` unset or `sandbox`.
- No new environment variables are required.
- After deploy, re-run the EURC quote against a cold function: expect well under
  2 s (was 10 to 20 s).
