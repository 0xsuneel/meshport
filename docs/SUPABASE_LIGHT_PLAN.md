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
3. **Fewer Edge Function calls per person.** Correction: moving them to
   Vercel alone doesn't fit 10k users either (~1.2M calls/month vs Vercel
   Hobby's 1M, with a 30-day pause when exceeded), so first cut calls that
   do no work.
   - Done 26 Nov: no pay-intent warm-up on every app open (main.tsx,
     AppLayout) - only when a payment screen opens, at most every 5 min
     (was every 20 s); swap-intent warm-up likewise. The stuck-payment check
     (a pay-intent call on every session) asks Arc's node first - pending vs
     latest nonce in one batch - and calls the server only when something
     is queued. ensureNameOnchain remembers a confirmed on-chain name (was a
     name-register call every session).
   - Done 26 Nov: markSubmitted (pay / swap / bulk pay) is the
     mark_attempt_submitted database function - same checks (caller's
     wallet via auth_uid, own attempt, 0x hash), same write, the confirm
     trigger still fires; anon can't call it. The app re-links the session
     once if needed and falls back to the Edge Function if the database
     path can't be used. Verified live in a rolled-back transaction:
     another wallet's attempt refused, bad hash refused, no login refused,
     own attempt updated.
   - Left per real action: create (pay/swap/bulkpay - nonce reservation
     needs the server's RPC read), claim submit, name registration once.
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
5. **Retention** (done 26 Nov, migration 20261126170000): prune_logs() daily
   at 03:29 - rpc_usage 14 days (admin reads 7), client_errors 30,
   wallet_events 30, move_timings 90. First run removed 14,829 rpc_usage
   rows and 70 error rows; a one-time VACUUM FULL of cron.job_run_details
   (13 MB → 0.7 MB for 700 rows), rpc_usage and the empty wallet_audit_log
   took the database from 71 MB to 52 MB (Free plan: 500 MB). Already
   pruned before: chain_events + shadow reports, cron history (hourly),
   push subscriptions, pg_net responses. Kept: fx_rate_history (rate
   charts), and everything a user owns.
