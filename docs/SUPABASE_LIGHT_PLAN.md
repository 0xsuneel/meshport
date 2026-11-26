# MeshPort: Supabase-light plan

Goal: Supabase stays inside the Free plan at 10k daily active users, by
keeping only profiles, contacts and chat on it. Measured 26 Nov 2026.

## Free plan limits (Supabase docs)

| Per month | Free | Now (17 users) | 10k users, as built |
|---|---|---|---|
| Edge Function invocations | 500,000 | ~350k before 26 Nov cuts | ~1.2M (≈4 user actions/user/day) |
| Egress | 5 GB | not logged | ~70–200 GB (≈230 requests/user/day × 1–3 KB) |
| Realtime peak connections | 200 | few | ~500–1,000 |
| MAU | 50,000 | 17 | fine |
| Database size | 500 MB | 71 MB | fine with retention |

Over quota on Free: warning, grace period, then restriction - no bill.

Vercel Hobby (vercel.com/docs/plans/hobby, read 26 Nov 2026): Function
Invocations 1,000,000 · Active CPU 4 CPU-hrs · Provisioned Memory 360 GB-hrs ·
Fast Data Transfer 100 GB · Fast Origin Transfer 10 GB · CDN Requests
1,000,000 · Cron jobs 100 per project. Over a limit: that feature is paused
until 30 days have passed - worse than Supabase's grace period, so Vercel is
not an unlimited place to move load either. Functions per deployment are
"framework-dependent" (the code notes 12). Commercial-use terms not checked.

## Findings (24 h, 25-26 Nov)

- Edge Functions made 161k database requests a day; the app 6.3k. Top:
  chain_cursors 66k, merchant_payment_intents 27k, job locks 12k.
- The app: ~370 requests/user/day; ~40 % were repeated activity writes
  (fixed 26 Nov) and many are CORS preflights.
- User-triggered Edge Function calls: ~70/day - small now, but the part
  that grows with users.
- 19 Realtime channels across the app.

## Phases

1. **Background load ≈ 0** (mostly done 26 Nov): Alchemy webhooks for 5
   chains, idle watchers gated, leftover chains every 10 min, activity
   write storm fixed, claim-worker mint lookup fixed. Left: turn off
   blockchain-indexer shadow/compare, idle heartbeat 10 → 30 min.
   Target < 30 Edge calls/hour.
2. **≤ 10 Supabase requests/user/day** (biggest egress win): one bootstrap
   read on open + local cache; activity history from Alchemy via Vercel;
   same-origin Vercel rewrite for Supabase to drop CORS preflights.
3. **User actions off Supabase Edge Functions**: pay/swap/bulkpay intents,
   claim-submit, merchant API, name-register, rewards, login → one merged
   Vercel route (`/api/tx?action=`) - or Cloudflare Workers if Vercel
   Hobby's non-commercial rule applies (verify).
4. **Realtime only on the chat screen**: payment alerts via Web Push
   (`/api/push`) + refresh on resume.
5. **Retention**: rpc_usage, client_errors, cron history, net._http_response.

## Reference: how Acme (app.acme.money) does it

REA `analyze-javascript-application` over the 125 public JS chunks of
app.acme.money (26 Nov 2026; evidence
`ev_b7ffae005d9cc3bb678b93e9d8bb372828e588555143b92b5a1d7d7b96c0dbc1`,
graph coverage partial - 100k-node cap), plus a string inventory of the same
files for hosts and paths.

- Next.js front end on Vercel (`dpl_` deployment ids); no BaaS: zero
  references to Supabase, Firebase, Convex, Appwrite, Hasura, GraphQL.
- Own always-on API servers: `evm-api.acme.money` and
  `mobile-api.acme.money/api/v1` (axios clients) - users, KYC, Stripe
  checkout, challenges/leaderboards, social-pay, `/token/balances`,
  `/moralis/...` (balances and token data from Moralis, server-side).
- Login, sessions and embedded wallets: Privy (`auth.privy.io`, its
  `/api/v1/siwe|passkeys|oauth|passwordless...` routes) - not their DB.
- Wallet history: Reown/WalletConnect account API
  (`/v1/account/{address}/history`) - a third-party indexer, not their DB.
- Bridging: Relay API called straight from the browser (`api.relay.link`).
- Caching: React Query `staleTime` 30 s / 2 min / 5 min; no WebSocket to
  their own backend found in the bundle (only WalletConnect relay).
- Images on Bunny CDN (`acmemoney.b-cdn.net`); self-hosted analytics.

What MeshPort takes from it: the database holds only what is MeshPort's own
(profiles, contacts, chat, merchant orders); balances, history, bridging and
login state come from specialist providers or the chain, fetched on demand
and cached on the device; no always-open socket per user. Unknown from a
bundle: what runs behind their API servers.
