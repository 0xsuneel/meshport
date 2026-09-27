# P2P Notifications, Transaction History, Home Popups, Activity Feed — What Changed

## New files
- `supabase/migrations/20260730031528_p2p_notifications_system.sql` — deployed & live.
  - `notifications` table (id, user_id, type, title, message, trade_id, read, created_at), RLS, Realtime enabled.
  - Trigger on `p2p_trades` (INSERT + UPDATE) that automatically inserts notification rows for: new buy/sell order placed, payment marked completed, funds released, trade cancelled, trade expired, dispute opened, dispute resolved, refund completed.
  - Push-dispatch trigger calling this app's existing `/api/push?action=send-internal` (`https://meshport.xyz/...`) for offline/backgrounded users.
- `src/lib/p2pNotifications.ts` — seeds the existing notification store from the `notifications` table, subscribes to Realtime, shows a toast, syncs "mark read" to Supabase.
- `src/lib/p2pChain.ts` — `fetchTxChainInfo(txHash)`: confirmations, block number, timestamp, explorer URL.
- `src/features/p2p/HistoryPage.tsx` — Transaction History page (route: `/p2p/history`).

## Edited files
- `src/store/index.ts` — widened `NotificationType`, added optional `tradeId` to `AppNotification`.
- `src/components/layout/AppLayout.tsx` — wired `startP2PNotifications(userId)` in.
- `src/features/profile/ProfileSubPages.tsx` (`NotificationsPage`) — icons for new P2P types; tap marks read server-side + navigates to the trade.
- `src/features/p2p/P2PPage.tsx` — exported `COLORS`/`Header`/`statusMeta`; added a History icon button.
- `src/lib/p2pService.ts` — `fetchCounterpartyProfiles()`; Activity-feed logging (see below); old client-only `notifyP2P()` annotated as superseded.
- `src/lib/p2pProviders.ts` — widened `EscrowProvider.refund()`'s declared return type to include the `txHash` it already returns at runtime.
- `src/lib/ActivityService.ts` — three new `ActivityType`s: `p2p_sell_order`, `p2p_refund`, `p2p_purchase`.
- `src/features/activity/ActivityPage.tsx` — both row components (compact + detail sheet) render the new P2P types with correct label/color/sign.
- `src/App.tsx` — added the `/p2p/history` route.
- `src/features/home/HomePage.tsx` — new dismissible order-alert popups.

---

## Deployment status (Supabase)

✅ **Live** on the MeshPort project (`cvvpzfvzweszuuxvaayb`). Verified end-to-end with a real trade insert/update, cleaned up after:
- `notifications` table + RLS + Realtime publication confirmed.
- Both `p2p_trades` triggers + the push-dispatch trigger confirmed installed.
- `net.http_post` actually fired to `https://meshport.xyz/api/push?action=send-internal`, authenticated successfully (`p2p_push_secret` Vault secret matches `PUSH_INTERNAL_SECRET`), got back a real `200 {"sent":0,"failed":0}`.

Nothing further needed on the Supabase side. The `HistoryPage.tsx`/`HomePage.tsx`/`ActivityPage.tsx` changes are frontend-only — they take effect on your next deploy to `meshport.xyz`.

---

## Home-screen order-alert popups

Show only for the two events that need you to actually do something next:
- A new buy/sell order was placed on your offer.
- A buyer marked payment as sent (you need to review + release escrow).

Everything else stays in the bell/toast only. Cards appear below the Home header, newest-first, capped at 3. Tap → marks read + opens the trade. **X** (top-right) → dismisses in place, no navigation. Pulls from the same live `notifications` store the bell already uses — no new state or polling.

---

## P2P events in the main Activity feed (Navigation → Activity)

| Event | Label | Sign | Fires when |
|---|---|---|---|
| `p2p_sell_order` | P2P Sell Order Created | **−** | You create a sell offer (escrow locked), or accept someone else's buy offer (same event either way) |
| `p2p_refund` | P2P Refund | **+** | You cancel a sell offer and get unused escrow back, or a buy-offer trade you funded is cancelled/expires |
| `p2p_purchase` | P2P Purchase | **+** | A trade completes and USDC lands in your wallet as the buyer |

The seller's "−" happens once, when funds are first locked into escrow — not again at completion, since by then the money already left. Only the buyer gets a new entry at completion. Wired into `createOffer`, `cancelOfferAndWithdrawEscrow`, `createTrade` (buy-offer accept path), `releaseTrade`, `cancelTrade`, `autoCancelExpiredTrades`.

**Known gap:** admin-triggered cancellations (`adminCancelTrade`) don't log a refund entry yet — same logic would apply, just not wired in (admin-only path, out of scope so far).

---

## Transaction History page (`/p2p/history`) — bug fixes

Two real, distinct bugs were found and fixed (not just UI polish):

**Bug 1 — Buy/Sell tabs matched nothing (root cause).** The category logic treated "Buy/Sell" (a *role*) and "Completed/Cancelled/Disputed/Refunded" (a *status*) as one mutually-exclusive bucket per trade — checking status first, only falling through to buyer/seller if nothing else matched. Since a trade is always **both** a role and a status at once, every completed trade got stuck at `'completed'` and could never also match `'buy'` or `'sell'`. Since almost all real trade history ends up completed/cancelled, the Buy/Sell tabs matched nothing — confirmed by your screenshot showing "No transactions match these filters" on Buy despite completed Buy trades being visible under All.

Fixed by splitting into two independent functions:
- `matchesCategory(trade, myId, tab)` — an independent per-tab predicate used only for filtering. "Buy" checks only "was I the buyer," with no regard to status.
- `badgeMeta(trade)` — kept priority-ordered and mutually-exclusive, purely for the one-label-only status pill on each card. Never used for filtering.

(An earlier, related but different bug was also fixed along the way: classifying by the *offer's* type instead of *your role* in the trade — accepting a sell offer is a buy order, so offerType alone was misleading. Both are now fixed together.)

**Bug 2 — Search matched nothing.** The filter called `.toLowerCase()` directly on wallet/username fields with no null guard. One trade with a missing field would throw inside the `useMemo`, silently blanking the *entire* list the instant you typed anything, while the unfiltered list rendered fine. Every field the search touches is now `?? ''`-guarded, and it also matches the counterparty's wallet address now, not just username/display name.

**Also done:**
- Removed the duplicate second filter row (Quick Filters) — Category tabs are now the only row.
- Added a copy button next to both Trade ID and Offer ID in the expanded row (same copy/checkmark pattern as the tx hash).

---

## Real remaining-balance tracking for offers

**The actual gap:** offers never tracked cumulative consumption at all. A $100 sell offer kept showing "$100 available" forever — even after $10 had already been sold against it — because `min_amount`/`max_amount` were only ever the original limits set at creation, and nothing decremented as trades completed. `escrow_balance` looked like it might track this, but it's only ever set at offer creation and reset to 0 at cancellation — never touched per-trade, and buy offers don't have one at all.

**Fix (`src/lib/p2pService.ts`):**
- `fetchOfferConsumedAmounts(offerIds)` — sums `amount_usdc` across all `completed`/`released` trades per offer (cancelled/expired trades don't count — nothing was actually transferred). Works identically for both offer types, no schema change needed.
- `offerRemainingAmount(offer, consumed)` — `maxAmount − consumed`, clamped at 0.
- `createTrade()` now validates against **actual remaining capacity**, not just the offer's original static max — previously a depleted offer could still be oversold well past what's actually left/escrowed.
- `releaseTrade()` now calls `retireOfferIfDepleted()` after each completion — once what's left can no longer satisfy the offer's own minimum trade size, it's automatically marked `'completed'` (an existing status) so it drops out of the active marketplace listing instead of sitting there showing a limit nobody could actually accept.

**UI (`src/features/p2p/P2PPage.tsx`):** every place an offer's amount is shown now displays real remaining capacity alongside the original limit —
- Marketplace browse list: "Available: X USDC" next to "Limit: min–max"
- Offer detail/accept screen: "Available" row + the amount input's max is capped to whatever's actually left, not the original ceiling
- My Offers: "Available: X USDC left" (replaces the old static, never-updated "Escrowed: X USDC" line)


The `PUSH_INTERNAL_SECRET` value shared earlier in this conversation is in the chat log. If that's a concern, rotate it: generate a new value, set it in Vercel, then run in the Supabase SQL editor:
```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'p2p_push_secret'),
  '<NEW_VALUE>'
);
```

---

## Admin panel: Emergency Pause, P2P kill switch, release/refund permissions

You asked me to check three things. Here's what I found for each — two were real bugs, not just verification:

### 1. "Emergency Pause Escrow" — was NOT reliably working, now fixed

The button and its wiring (`adminPauseEscrow`/`adminUnpauseEscrow`) were real — they correctly call `pause()`/`unpause()` on the actual deployed contract, and the contract's own `deposit`, `release`, and `withdrawRemaining` are all genuinely gated `whenNotPaused` on-chain (checked `contracts/P2PEscrow.sol` directly).

**The bug:** every deposit/release/refund call in the app picks between the real contract and an "honor system" fallback (used automatically whenever `VITE_P2P_ESCROW_CONTRACT` isn't configured) with **no pause check anywhere in that decision**. So:
- If a real contract *is* deployed: pausing worked, but only in the sense that a signed transaction would get sent and then revert on-chain — a raw contract-revert error, not a clean message, and only after going through the whole UI flow.
- If a real contract is *not* deployed (honor-system mode): pausing did **nothing at all**. The honor-system path never touches the chain, so it had no way to know it was supposed to stop.

**Fix:** added a single `assertNotPaused()` guard inside the shared `escrowProvider` wrapper in `p2pProviders.ts`, checked before *every* deposit/release/refund, regardless of which provider ends up handling it. Same clean, immediate message either way now: *"P2P escrow is currently paused by an admin."* Also added the same check to `cancelOfferAndWithdrawEscrow` (which calls the contract directly, bypassing that shared wrapper).

### 2. P2P enable/disable toggle — added (there was none)

Checked `app_settings` directly — every other feature area in this app (swap, chat, contacts, bulk payments, multichain, etc.) has its own toggle row. **P2P had none at all.** Added:
- A `p2p_enabled` row in `app_settings` (deployed, defaults to enabled — no disruption).
- A toggle button in `P2PAdminPage.tsx`, right below Emergency Pause, using the exact same `useSettingsStore`/`updateSetting` mechanism every other toggle already uses (Realtime-synced across clients automatically).
- Enforcement in `createOffer()` and `createTrade()` — blocks *new* offers/trades when off.

**Deliberately scoped narrower than Emergency Pause** — these are two different tools:

| | Emergency Pause Escrow | P2P Marketplace toggle |
|---|---|---|
| Scope | Contract-level, blocks everyone including active trades | App-level, blocks only *new* offers/trades |
| Existing trades | Frozen — can't release/refund until unpaused | Unaffected — still fully manageable |
| Use case | Active incident (e.g. suspected exploit) | Routine maintenance / gradual wind-down |

Blocking existing trades with the soft toggle would strand anyone with money already in a trade — especially now that notifications and the Home popups deep-link straight to `/p2p/trade/:tradeId`. The route-level `FeatureGate` in `App.tsx` follows the same split: browsing/creating/accepting are gated, but `trade/:tradeId`, `my-trades`, `my-offers`, and `history` stay reachable.

### 3. Admin release/refund permissions — working, and now fully consistent

`adminResolveDispute()` (favor buyer → real release; favor seller → real refund) and `adminCancelTrade()` (real refund) all genuinely move funds through the same `escrowProvider` the regular user-facing flows use — not just DB status flips. Both have proper double-fire guards (an atomic claim on `dispute_status`/`status` before touching escrow) and a real retry path if a release fails after being claimed.

The one gap: neither logged to the Activity feed (the `p2p_refund`/`p2p_purchase` entries added earlier only covered the user-initiated paths). Fixed — admin-triggered releases and refunds now show up in Activity too, tagged with `kind: 'dispute_resolved_buyer'` / `'dispute_resolved_seller'` / `'admin_cancelled'` in their metadata so they're distinguishable from user-initiated ones if you ever need to audit.

---

## P2P not showing in Activity — two separate causes, both fixed

You reported P2P history missing from the main Activity feed, and no "P2P" heading/label at all. Two distinct things were going on:

### 1. No dedicated "P2P" tab (this one was intentional, and wrong)

When I first wired P2P into Activity, I deliberately skipped adding a filter tab — the new entries showed under "All" by default, and I treated a dedicated tab as an optional nice-to-have. That was the wrong call once "P2P heading not showing" is literally the ask. Added, matching the exact pattern the existing "Multichain" tab already uses (a combined filter covering multiple underlying `activity_type` values):
- New "P2P" chip in the filter bar (`src/features/activity/ActivityPage.tsx`)
- Combined filter (`p2p_sell_order` + `p2p_refund` + `p2p_purchase`) at both the client-side tab-filtering layer and the server-side query (`fetchActivity` in `ActivityService.ts`)

### 2. Historical trades never got backfilled (the bigger one)

Even with the tab added, anything that happened **before** the P2P Activity-logging feature existed would still never show up — `saveActivity()` only ever fires at the moment of a real event (creating an offer, releasing a trade, etc.), so a trade completed last week has no row to find, regardless of any tab or query fix. This is very likely why it looked broken even for offers/trades you already know completed.

Added `backfillP2PActivity(userId, walletAddress)` in `p2pService.ts` — runs automatically once per Activity page visit (wired into `ActivityPage.tsx`'s mount effect, then refreshes the list), walks your existing offers/trades, and creates the missing entries for anything that already happened. Safe to run repeatedly: it fetches your existing `p2p_*` activity rows first and skips anything already covered by trade/offer id, rather than relying on tx-hash-based dedup — which matters specifically because honor-system-mode (no contract configured) trades/offers often have no tx hash at all, so the normal dedup path wouldn't have caught re-runs otherwise.

---

## "Couldn't access your wallet on this device" during dispute resolution — explained + made diagnosable

**Why this happens:** dispute resolution (and Emergency Pause) aren't purely administrative database actions — they're real on-chain transactions. `contracts/P2PEscrow.sol`'s `release()` function literally requires `msg.sender == seller || msg.sender == admin`, where `admin` is one specific wallet address set at contract deployment. So resolving a dispute means the browser has to sign a transaction with a real private key — same mechanism a regular seller uses to release their own trade — not just "an admin clicked a button."

The error means one (or both) of two things:
1. **Your wallet isn't unlocked in this browser session** — `useAuthStore`'s in-memory private key is empty, so there's nothing to sign with at all. This is the literal, direct cause of the exact message shown.
2. **Your wallet doesn't match the contract's actual admin address** — even if unlocked, the on-chain call only succeeds for the one specific wallet that deployed the contract (or whoever `transferAdmin` was called for). If a different wallet is logged in, it'll always fail.

**What I added** (`P2PAdminPage.tsx`, `p2pEscrowContract.ts`, `p2pService.ts`) — two clear diagnostic banners instead of a dead-end error:
- Reads the contract's actual `admin` address on-chain (new `getEscrowAdminAddress()`/`adminFetchEscrowAdminAddress()`) and compares it to your current wallet — shows both addresses directly if they don't match, so it's immediately obvious this needs either the correct wallet or an on-chain admin transfer, not more retrying.
- Separately checks whether your wallet is unlocked in this session at all, and tells you to reload/unlock if not.

This doesn't change how the underlying release/refund mechanism works (that's a real architectural fact of how the contract enforces admin rights) — it just makes the actual cause visible instead of a generic failure message.

---

## Limit display now updates as an offer depletes (not just "Available")

You caught a real inconsistency: "Available" correctly showed the reduced remaining amount, but "Limit" still showed the original static range (e.g. "1–10" even after $2 of a $10 offer had already sold, when it should read something like "1–8").

Fixed in all three places an offer's limit is shown (`P2PPage.tsx`):
- Browse-offers card
- Offer detail/accept screen
- My Offers (only while the offer is still `active` — a completed/cancelled offer now correctly keeps showing its original static range instead of a live remaining figure, since at that point it's history, not something still being sold)

The upper bound now shows `min(original max, remaining)` everywhere, matching the same "Available" figure right next to it — reusing the exact same computation already added for "Available," not a separate calculation, so the two numbers can never drift apart again.

---

## Admin panel: live Offers view + Cancel Offer permission

There was previously no offers view in the admin panel at all — only trades/disputes. Added:

**Deployed to Supabase:** enabled Realtime on `p2p_offers` (it already was on `p2p_trades`, but not offers) — required for the "live" part of the request.

**`p2pService.ts`:**
- `fetchAllOffersAdmin()` — every offer, any type/status (unlike the marketplace's `fetchOffers()`, which is deliberately narrowed to active+unlocked+one-type, or `fetchMyOffers()`, scoped to one user).
- `subscribeToAllOffers()` — Realtime subscription so new offers, cancellations, and depletion (auto-retirement to `'completed'`, from the earlier remaining-balance fix) all appear instantly.
- `adminCancelOffer(offer)` — thin wrapper around the existing `cancelOfferAndWithdrawEscrow`, tagged for Activity/audit purposes (`kind: 'admin_cancelled_offer'`) rather than a separate duplicated implementation. Confirmed against `contracts/P2PEscrow.sol` directly: `withdrawRemaining` allows `msg.sender == seller || msg.sender == admin`, and — importantly — **always refunds to the original seller regardless of who calls it**, so an admin cancelling someone else's offer can never redirect funds to themselves; it can only return them to the rightful owner. Same admin-wallet-must-match-the-contract requirement as Emergency Pause/dispute resolution applies here too (see the earlier diagnostic banners).

**`P2PAdminPage.tsx`:** new "Offers" section — All/Buy/Sell tabs, live green dot indicator, each card showing type, amount range, status, owner, escrow balance, and whether it's currently locked by an active trade. "Cancel Offer" button per offer (disabled once an offer is no longer active), plus a "Ban Owner" shortcut reusing the existing ban modal.

---

## Found the real root cause: P2P activity was never showing because the DB rejected every single insert

Traced this all the way down. Every `saveActivity()` call for `p2p_sell_order`/`p2p_refund`/`p2p_purchase` (in `p2pService.ts`, and the backfill added earlier) has been failing since the moment those types were introduced — the `activity` table has its own `CHECK` constraint restricting `activity_type` to a fixed list of 8 values, and the three new P2P types were never in it. Every insert attempt returned a `23514` constraint violation.

This is why nothing showed up even after the tab and backfill were added — the backfill function itself was working correctly (finding your real trades/offers), it just couldn't actually write any of them. `saveActivity()` does log failures to the browser console (`saveActivity FAILED after retries: ... 23514: violates check constraint...`), so it wasn't fully silent, but nothing surfaced it anywhere visible in the app itself.

**Fixed — deployed directly to Supabase, verified end-to-end:**
1. Widened the constraint to allow the three P2P types (`20260801005334_activity_allow_p2p_types.sql`).
2. Backfilled your actual existing data directly (not simulated) — **47 real rows created**: 20 purchases, 18 sell-order locks, 9 refunds, correctly attributed per wallet, matching your real trade/offer history exactly.

Also created the local migration file for `p2p_offers_realtime` (deployed a couple messages back but never saved to the repo folder) so the repo's migration history now matches what's actually live.

**This should show up immediately** — no redeploy needed for the backfilled data itself, since it's already in the database; opening the Activity → P2P tab should show it right away. Going forward, new events will save correctly too, now that the constraint allows them.

---

## Home popups: a trade's later status now replaces its earlier one, instead of stacking

You're right that "new order placed" and "payment marked sent" are two stages of the *same* order, not two separate things — previously, if both notifications for the same trade were unread at once, they'd show as two separate popup cards.

Fixed in `HomePage.tsx`'s `homePopups` computation: popups are now deduped per `tradeId`, keeping only the most recent one. The moment "payment marked" arrives for a trade, its earlier "order placed" popup disappears on its own — no polling, this is just the existing Realtime-driven `notifications` list re-filtering itself the instant the new row arrives, same mechanism that already powers the bell/toast.

Also cleaned up the loose end that created: since the older notification is now permanently hidden from Home the moment a newer one supersedes it, tapping or dismissing the current popup now clears *both* (every unread popup-type notification sharing that trade's id), so the superseded one doesn't sit unread forever with no popup left to reach it from. It still shows up in the full Notification Center as history — just not doubled up on Home.
