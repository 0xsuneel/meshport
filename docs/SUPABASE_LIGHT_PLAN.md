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
   write storm fixed, claim-worker mint lookup fixed. Done 26 Nov
   (migration 20261126130000): idle heartbeat 30 min per job, 11 more jobs
   gated (nonce recovery, reconcile, broadcast recovery, ledger link, Arc
   push sweep, deposit backstop, name sync), Arc index pass every 10 min,
   shadow compare paused. Target < 30 Edge calls/hour.
2. **≤ 10 Supabase requests/user/day** (biggest egress win).
   - Done 26 Nov: activity history kept on the device (ActivityService
     device copy) - one full read, then only rows with a newer
     `updated_at`; live events go straight into it. Was ~3 MB/user/day
     (pages of up to 1,000 rows × ~520 B re-read by every screen).
   - Done 26 Nov: public profiles by wallet cached on the device (6 h; "no
     account" 5 min; sign-in/ownership/own profile always fresh; cleared on
     profile edit); notifications-cleared watermark cached 10 min; known
     contact pairs remembered (no lookup per payment) and the contact list
     shared across screens for 60 s; Home's missed-payment catch-up at most
     every 3 min (live listener covers payments while Home is open).
     App start already uses one bootstrap call (lib/homeBootstrap.ts).
   - Not cached on purpose: other people's chat public keys (a key rotated
     on a new device must be seen at once).
   - Dropped: same-origin rewrite for CORS preflights - preflights are tiny
     (no egress to speak of) and a Vercel rewrite would move the bytes onto
     Vercel's 10 GB Fast Origin Transfer instead.
3. **User actions off Supabase Edge Functions**: pay/swap/bulkpay intents,
   claim-submit, merchant API, name-register, rewards, login → one merged
   Vercel route (`/api/tx?action=`) - or Cloudflare Workers if Vercel
   Hobby's non-commercial rule applies (verify).
4. **Realtime only while someone is looking** (done 26 Nov): every channel
   goes through subscribeWithRetry's live gate - closed 30 s after the app
   is hidden and after 3 idle minutes (not on /chat or /splits, where
   reading without touching is normal); with no channels supabase-js closes
   the socket, so the 200-connection limit counts people actively using the
   app, not installs or tabs left open. The next touch / return reopens
   them and each runs its catch-up (Home's missed-payment check listens for
   `meshport:live-resumed`). Alerts while paused: Web Push, already sent for
   chat payments (api/chat), external deposits (chain-transfer-webhook)
   and claims (claim-worker / ub-claim-worker).
   Follow-up done 26 Nov: `users` dropped from the Realtime publication (it
   is readable by all and the chat list reloaded on every profile UPDATE by
   anyone - a message per viewer per change); Home's payment listener
   filtered to `type=eq.payment_sent`, its P2P listener to this person's
   trades (buyer_id / seller_id). messages and p2p_trades are RLS-limited to
   participants, so their other listeners only reach the people involved.
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
