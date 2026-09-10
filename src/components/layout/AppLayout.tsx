import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { BottomNav } from './BottomNav'
import { DesktopSidebar } from './DesktopSidebar'
import { DesktopHeader } from './DesktopHeader'
import { Toast } from '@/components/ui/Toast'
import { PageTransition } from '@/components/ui/PageTransition'
import { WalletRecoveryBanner } from './WalletRecoveryBanner'
import { ModeToggle } from '@/components/admin/ModeToggle'
import { useAuthStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useVisibleViewportHeight } from '@/hooks/useVisibleViewportHeight'
import { supabase, syncAuthUidToProfile } from '@/lib/supabase'
import { notifyClaimArrived } from '@/lib/bridgeTracker'
import { notifyPaymentReceived, notifyPaymentReceivedFromAddress } from '@/lib/notifications'
import { shadowEventBus, syncCoordinator } from '@/blockchain/shadowEventBus'
import { arcDepositWatcher } from '@/lib/arcDepositWatcher'
import { startP2PNotifications } from '@/lib/p2pNotifications'

const noNavRoutes = [
  '/pay-send', '/receive', '/bulk-payout', '/profile', '/notifications',
  '/security', '/backup', '/edit-profile', '/transaction', '/feature-guide', '/about', '/terms-privacy', '/help-support', '/appearance',
  '/multichain-transfer', '/multichain-claim', '/swap', '/insights', '/p2p',
]

function isNoNavRoute(pathname: string) {
  if (noNavRoutes.some(r => pathname.startsWith(r))) return true
  if (/^\/chat\/.+/.test(pathname)) return true
  return false
}

// NOTE: the old BridgeProgressBanner (a global floating "Claiming... Tap to
// view progress" pill driven by the client-side `backgroundBridge` job
// tracker) has been removed. It duplicated the server-backed "Processing
// Claims" section on the Multichain Hub, and — being tied to `backgroundBridge`'s
// in-memory job list — stopped reflecting reality the moment the tab that
// started the claim was closed, which is exactly the bug this feature fixes.
// The Hub's "Processing Claims" list (Supabase Realtime) is now the single
// source of truth for in-flight claims across the whole app.

export function AppLayout() {
  const location = useLocation()
  const showNav = !isNoNavRoute(location.pathname)
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const walletAddress = useAuthStore(s => s.walletAddress)
  const userId = useAuthStore(s => s.user?.id)
  // Real, currently-visible viewport height — see the hook's own comment.
  // Drives the mobile shell's actual pixel height below, replacing the old
  // fixed+inset:0-only approach (see that block's own updated comment).
  const visibleHeight = useVisibleViewportHeight()

  // Backfills users.auth_uid — a prerequisite for the reviewed RLS tightening
  // in supabase-SECURITY-REVIEW-scope-rls.sql. No-op until that migration's
  // column exists; harmless either way.
  useEffect(() => {
    if (userId) syncAuthUidToProfile(userId)
  }, [userId])

  // ── Phase 4 shadow observation — DELIBERATELY INERT ────────────────────────
  // Subscribes to the BlockchainIndexer's `chain_events` AND to `activity`
  // INSERTs, feeding both into SyncCoordinator (Phase 6). No longer inert: this
  // is now the primary event-driven refresh path. The Alchemy WebSocket that
  // previously shared this role was removed once Phase 5/6 superseded it — see
  // the note where its effect used to live, further down this file.
  //
  // Mounted here rather than inside a page because the measurement needs to
  // span the whole session — a page-scoped subscription would only observe
  // events while that one route happened to be open, which is precisely the
  // sampling bias that would make the shadow report look clean.
  useEffect(() => {
    if (!walletAddress) return
    shadowEventBus.start(walletAddress)
    return () => shadowEventBus.stop()
  }, [walletAddress])

  // ── Real-time external deposit watcher (Arc eth_subscribe(logs)) ──────────
  // Session-wide, one WebSocket for every route — NOT scoped to the Activity
  // page. On a confirmed external deposit it refreshes the Activity list
  // (via getRecentArcDeposits + the 'meshport:arc-deposit' event), the Home
  // balance (HomePage listens to the same event), and fires the "Received
  // from" notification immediately (deduped against the delayed server row by
  // a shared tx-hash-keyed id). Self-recovers on tab/app switch: force
  // reconnect + bounded eth_getLogs catch-up on visibilitychange/online/
  // pageshow/focus, plus a 30s heartbeat. See lib/arcDepositWatcher.ts.
  useEffect(() => {
    if (!walletAddress) return
    arcDepositWatcher.start(walletAddress)
    return () => arcDepositWatcher.stop()
  }, [walletAddress])

  // ── PHASE 6 — resume policy (proposal §19) ────────────────────────────────
  // On return to the foreground, refresh only what the elapsed absence
  // justifies: nothing under 5 min, {arc}+{claims} at 5 min, plus {external}
  // at 10 min. SyncCoordinator owns the policy; this effect only measures how
  // long the tab was hidden and reports it.
  //
  // Additive on purpose: the visibilitychange listeners below are untouched, so
  // the existing deposit/claim-recovery triggers behave exactly as before. This
  // one performs no network work of its own — it invalidates cache scopes and
  // lets the normal read paths refill them.
  useEffect(() => {
    if (!walletAddress) return
    let hiddenAt: number | null = null

    const onVisibilityForResume = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt === null) return          // became visible without a recorded hide
      const hiddenMs = Date.now() - hiddenAt
      hiddenAt = null
      syncCoordinator.handleResume(hiddenMs, walletAddress)
    }

    document.addEventListener('visibilitychange', onVisibilityForResume)
    return () => document.removeEventListener('visibilitychange', onVisibilityForResume)
  }, [walletAddress])

  // ── Recover claims whose burn confirmed but the app never got a chance to
  // record it — the SDK's own bridge.burn event (which is what triggers the
  // durable claims-row write) requires the tab to still be open when the
  // burn is detected as confirmed; if the tab closes before that, nothing
  // client-side ever runs. Scans Arc directly for incoming mints to this
  // wallet with no matching `claims` row — see claim-recovery-scan/index.ts
  // for why this scans Arc rather than every source chain.
  //
  // Runs on mount AND whenever the tab becomes visible again — not mount
  // alone. Resuming an already-open tab/PWA (switching apps and back) never
  // remounts this component, so a mount-only trigger would silently never
  // re-run for that very common case, even though that's exactly when
  // someone is likely to be "returning" after leaving mid-claim. Cheap
  // no-op when there's nothing to recover either way.
  useEffect(() => {
    if (!walletAddress) return

    const runScan = () => {
      supabase.functions.invoke('claim-recovery-scan', { body: { walletAddress } })
        .then(async ({ data, error }) => {
          // BUG FIX: see lib/describeFunctionsError.ts — error.message alone
          // is always the SDK's generic "Edge Function returned a non-2xx
          // status code", which was making every real server-side failure
          // here indistinguishable from every other one in the console.
          if (error) { const { describeFunctionsError } = await import('@/lib/describeFunctionsError'); console.error('[claim-recovery-scan] invoke failed:', await describeFunctionsError(error, 'unknown')); return }
          const recoveredHashes: string[] = data?.recovered ?? []
          if (recoveredHashes.length === 0) return
          console.log(`[claim-recovery-scan] recovered ${recoveredHashes.length} item(s)`)

          // Claims are intentionally NOT notified here — see the long
          // comment further below on notifyUnnotifiedCompletions, which is
          // the single source of truth for claim notifications specifically.
          // Direct-transfer receives (EURC/cirBTC/USDC sent straight to this
          // wallet's address, bypassing the chat-message system entirely)
          // are a different activity_type and have no equivalent tracking
          // column — so they DO get notified here, keyed by the SAME row id
          // HomePage.tsx's fireIfReceived() uses. Safe from repeat
          // notifications the same way claims are: the scan's own "already
          // tracked" check means a given transfer only ever appears in
          // `recovered` once, on the run that first discovers it.
          const { data: rows, error: fetchErr } = await supabase
            .from('activity')
            .select('id, tx_hash, amount, token_symbol, counterparty_address, metadata, created_at')
            .eq('wallet_address', walletAddress.toLowerCase())
            .eq('activity_type', 'receive')
            .in('tx_hash', recoveredHashes.map(h => `recv_${h.toLowerCase()}`))
          if (fetchErr) { console.error('[claim-recovery-scan] receive lookup failed:', fetchErr.message); return }
          // BUG FIX (duplicate notifications): this used to call
          // notifyPaymentReceived/FromAddress with no `id`, so each call fell
          // back to a fresh random id (see addNotification in store/index.ts)
          // -- meaning the store's own id-based dedup could never catch a
          // repeat. runScan() fires on EVERY tab/app visibilitychange, and
          // the server-side claim-recovery-scan function's "already
          // recovered" check (a SELECT-then-upsert with no advisory lock) is
          // racy across two concurrent invocations of the same scan -- two
          // fast tab-switches in a row can both see the same not-yet-written
          // deposit, both report it in their `recovered` list, and both land
          // here.
          //
          // NOTIF ID (2026-09-06, /investigate): every external-deposit
          // notifier now keys on the transaction hash, not the activity row
          // id — `ext_recv_tx_<clean-lowercased-hash>`. The three notifiers
          // that can each observe one external deposit are:
          //   - this claim-recovery-scan handler,
          //   - HomePage.tsx's fireIfReceived() (live subscription + catch-up),
          //   - lib/arcDepositWatcher.ts (real-time Arc log watcher).
          // The watcher fires BEFORE any Supabase row exists, so it has no
          // `row.id` to key on — a tx-hash id is the only value all three can
          // agree on. It is also strictly safer than the old `row.id` key: if
          // more than one activity row ever exists for a single deposit
          // (activity-consumer + deposit-scan-all + this scan racing), those
          // rows have different ids but the same hash, so hash-keying dedupes
          // them where id-keying would not. `row.tx_hash` here is the
          // `recv_<hash>` form the query above filtered on.
          for (const row of rows ?? []) {
            const notifId = `ext_recv_tx_${(row.tx_hash || '').replace(/^recv_/, '').toLowerCase() || row.id}`
            const fromUsername = (row.metadata as any)?.fromUsername
            if (fromUsername) {
              notifyPaymentReceived({ id: notifId, amount: row.amount, fromUsername, tokenSymbol: row.token_symbol, createdAt: row.created_at })
            } else {
              notifyPaymentReceivedFromAddress({ id: notifId, amount: row.amount, fromAddress: row.counterparty_address || '0x???', tokenSymbol: row.token_symbol, createdAt: row.created_at })
            }
          }
        })
        .catch(() => { /* best-effort — will retry on next trigger */ })
    }

    runScan()
    const onVisible = () => { if (document.visibilityState === 'visible') runScan() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [walletAddress])

  // ── Set up E2E chat encryption keys ─────────────────────────────────────
  // Generates this device's key pair (if it doesn't have one yet) and makes
  // sure the matching public key is uploaded to `users.chat_public_key` —
  // see chatCrypto.ts's own header for the full design. Runs once per
  // session as soon as both walletAddress and the real user id are known;
  // safe to call every mount, it's a no-op after the first successful
  // upload. Nothing else in the chat send/receive path blocks on this
  // finishing — every encrypt/decrypt call already falls back to plaintext
  // on its own if a key isn't ready yet (see getConversationKey), so a slow
  // or failed key setup here degrades to "chat works exactly like before
  // this feature existed" rather than breaking anything.
  const chatUserId = useAuthStore(s => s.user?.id)
  useEffect(() => {
    if (!walletAddress || !chatUserId) return
    import('@/lib/chatCrypto').then(({ ensureChatKeysReady }) =>
      ensureChatKeysReady(walletAddress, chatUserId)
    ).catch(() => { /* best-effort — chat falls back to plaintext until this succeeds */ })
  }, [walletAddress, chatUserId])

  // ── Complete any Unified Balance fund recoveries whose 7-day window has
  // passed — see lib/ubFundRecovery.ts for the full design. Same trigger
  // pattern as the claim-recovery-scan above (mount + tab refocus) and for
  // the same reason: this is what makes the recovery "automatic" from the
  // user's side without needing a server that holds their key. Needs
  // privateKey, not just walletAddress — removeFund() is a signed
  // transaction from the original depositing wallet, so this can only run
  // while the wallet is actually unlocked in this session.
  const privateKey = useAuthStore(s => s.privateKey)
  useEffect(() => {
    if (!walletAddress || !privateKey) return
    const runCheck = () => {
      import('@/lib/ubFundRecovery').then(({ checkAndCompleteUBRecoveries }) =>
        checkAndCompleteUBRecoveries({ walletAddress, privateKey })
      ).catch(() => { /* best-effort — will retry on next trigger */ })
    }
    runCheck()
    const onVisible = () => { if (document.visibilityState === 'visible') runCheck() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [walletAddress, privateKey])

  // ── Keep retrying wallet key restoration in the background ─────────────────
  // restorePrivateKey() (see lib/restoreWallet.ts) already retries a failed
  // attempt 3 times internally, spanning ~4.5s — but once THAT is exhausted,
  // nothing tried again until the user noticed the recovery banner and
  // manually tapped "Try Again". For social-auto (Google/Email) accounts
  // specifically, restoring the key is a genuine server round-trip (there's
  // no local mnemonic to fall back to), so a single bad moment on a weak
  // connection could leave the wallet permanently "not recovered" for the
  // rest of the session with no further attempt ever made. This keeps
  // trying every 20s for as long as walletAddress exists but privateKey
  // doesn't — stops immediately once it succeeds (the interval callback's
  // own live check does this, nothing else needed beyond unmount cleanup).
  //
  // BUG FIX (2026-09-03) — this loop used to run for EVERY walletSource, not
  // just social-auto. For a create/import-seed wallet, restorePrivateKey()'s
  // mnemonic-derive step is local and instant and either succeeds on the
  // very first internal attempt or won't ever succeed by retrying the exact
  // same inputs again — so this loop firing every 20s did nothing useful
  // there. For import-privkey specifically it was actively harmful: that
  // wallet source has NO mnemonic, so restorePrivateKey() can only succeed
  // via the LOCAL encrypted key + the user's passcode (see restoreWallet.ts
  // step 3) — but this loop calls restorePrivateKey() with no passcode
  // argument, which can never supply one. Every 20s it would therefore fail
  // exactly the same way, set walletRecoveryNeeded back to true, and
  // re-trigger WalletRecoveryBanner's "Still restoring your wallet…" state
  // — forever, on every session where the passcode hasn't been re-entered
  // yet — even though nothing was actually "still restoring": it needed the
  // user's passcode, not another silent retry. That is the direct cause of
  // reports of the recovery banner staying up indefinitely for imported
  // wallets. Scoped to social-auto only, matching what this effect's own
  // comment above already says it exists for.
  const walletSource = useAuthStore(s => s.walletSource)
  useEffect(() => {
    if (!walletAddress || privateKey || walletSource !== 'social-auto') return
    const interval = setInterval(() => {
      const { walletAddress: addr, privateKey: key, walletSource: src } = useAuthStore.getState()
      if (!addr || key || src !== 'social-auto') return // already restored (or logged out, or not social-auto) — nothing to do
      import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey()).catch(() => {})
    }, 20000)
    return () => clearInterval(interval)
  }, [walletAddress, privateKey, walletSource])

  // ── Real-time deposit detection — REMOVED, superseded by Phase 5/6 ─────────
  // This used to open a persistent Alchemy WebSocket to Arc
  // (lib/realtimeDeposits.ts, now deleted) and, on every new block, fetch that
  // block over HTTP to look for transactions addressed to this wallet.
  //
  // Every function it served is now covered, and covered better:
  //   ERC-20 (EURC/cirBTC) via its `logs` subscription
  //     -> blockchain-indexer emits transfer_detected -> chain_events
  //   native/wrapper USDC via `newHeads` + tx.to matching
  //     -> deposit_detected. STRICTLY better: tx.to matching is structurally
  //        blind to wrapper-routed deposits through 0x3600…, which is exactly
  //        the gap Fix B/Fix D closed server-side.
  //   Activity/history refresh
  //     -> the activity INSERT Realtime subscription (shadowEventBus)
  //   balance refresh
  //     -> SyncCoordinator's arc / asset scopes
  //   triggering deposit-scan-all on demand
  //     -> activity-consumer is now the authoritative writer; the reconcile
  //        job (*/10) remains the permanent backstop
  //
  // It was also the app's single largest Alchemy consumer: one
  // eth_getBlockByNumber(full=true) per ~2s block, per open tab, whether or not
  // a deposit occurred — plus unbounded reconnect handshakes that did not
  // special-case 429. That load was a primary contributor to the 2026-08-18
  // account-wide Alchemy 429s.
  //
  // NOT replaced with another WebSocket: Supabase Realtime already carries
  // chain_events and activity on a separate connection and credential.
  //
  // useActivity.ts's 'meshport:onchain-activity' listener is deliberately KEPT —
  // HomePage still dispatches that event when the polled Arc balance increases.

  // ── P2P marketplace notifications — server-driven, cross-device ───────────
  // See lib/p2pNotifications.ts: seeds the bell/notification-center with any
  // trade events that happened while this device was offline, then keeps it
  // live via Realtime. Keyed on the app's own user id (not walletAddress) —
  // notifications.user_id matches p2p_trades.buyer_id/seller_id, which are
  // app user ids, so this needs to re-subscribe on user change too, not just
  // wallet change (a social-auth account could switch users without its
  // wallet address ever changing).
  useEffect(() => {
    if (!userId) return
    return startP2PNotifications(userId)
  }, [userId])

  // ── Notify for claims that completed but were never told to the user ────
  // Distinct gap from the recovery scan above: that scan only fires a
  // notification at the MOMENT it first discovers a claim. Once recorded,
  // future scans correctly skip it (that's what prevents duplicates) — but
  // that also means a claim recovered before this notification code was
  // even deployed, or one that completed through the normal claim-worker
  // path while this tab happened to be closed, would otherwise sit there
  // completed forever with no notification ever sent. This check is
  // independent of HOW a claim reached 'completed' — it just looks for
  // anything completed with no notification sent yet, notifies once, and
  // marks it durably server-side (claims.user_notified_at) so it can never
  // fire twice, even across different devices or after clearing browser
  // data — deliberately not using localStorage for this.
  useEffect(() => {
    if (!walletAddress) return

    const notifyUnnotifiedCompletions = async () => {
      // Previously did a direct client-side SELECT then UPDATE against
      // `claims` — but RLS (correctly, by design) only allows the owning
      // wallet to READ its own rows, with writes reserved for the
      // server-side edge functions. The client's UPDATE was silently
      // affecting zero rows every time, which the old race-safety check
      // misread as "another concurrent call already handled this," so it
      // skipped the notification too — meaning nothing ever got marked AND
      // most notifications never fired. This single atomic RPC call does
      // the fetch-and-mark as one server-side statement, genuinely
      // bypassing that restriction the correct way instead of fighting it
      // from the client.
      const { data: rows, error } = await supabase.rpc('get_and_mark_unnotified_claims', {
        p_wallet_address: walletAddress.toLowerCase(),
      })
      if (error) { console.error('[claim-notify-catchup] rpc failed:', error.message); return }
      for (const row of rows ?? []) {
        notifyClaimArrived(row.amount, row.source_chain, undefined, row.completed_at)
      }
    }

    notifyUnnotifiedCompletions()
    const onVisible2 = () => { if (document.visibilityState === 'visible') notifyUnnotifiedCompletions() }
    document.addEventListener('visibilitychange', onVisible2)
    return () => document.removeEventListener('visibilitychange', onVisible2)
  }, [walletAddress])

  // ── DESKTOP (≥1024px): SaaS-dashboard shell — persistent sidebar+header
  // regardless of route (unlike mobile's noNavRoutes, which hides chrome for
  // full-screen sub-flows). Outlet/PageTransition/WalletRecoveryBanner/Toast/
  // ModeToggle are the exact same elements as the mobile branch below, just
  // re-parented into different chrome — no logic duplicated.
  if (isDesktop) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex' }}>
        <DesktopSidebar />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <DesktopHeader />
          {/* display:flex + minHeight:0 here is what actually makes
              PageTransition's own `flex:1` below take effect — without a
              flex container as its direct parent, that flex:1 is inert and
              PageTransition (and everything inside it) sizes to its
              content instead of the available viewport height. That let
              this div's overflowY:auto catch content that a page's OWN
              internal scroll container (every page already has one — see
              e.g. HomePage/ChatListPage's own overflow-y-auto root) was
              supposed to own instead, which is what made a nested split
              view like Chat's (list + conversation side by side) scroll
              the whole outer shell rather than just the panel under the
              cursor, and broke position:sticky headers inside it (sticky
              only works relative to ITS OWN nearest scrolling ancestor —
              if the wrong ancestor was the one actually scrolling, the
              header just scrolled away with everything else). */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <WalletRecoveryBanner />
            <PageTransition locationKey={location.pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </div>
        <Toast />
        <ModeToggle />
      </div>
    )
  }

  // ── MOBILE-FIRST: same layout on every screen size ────────────────────────
  // Outer shell's HEIGHT is now driven by useVisibleViewportHeight (real
  // measured pixels from window.visualViewport), not `inset:0` alone and
  // not a `dvh` unit. Two earlier approaches both fell short:
  //  - `height:100dvh` was inconsistent once launched from an Android
  //    home-screen shortcut (standalone display mode) — some
  //    devices/WebViews under- or over-counted the system gesture-nav bar.
  //  - `position:fixed;inset:0` (the previous fix here) sidesteps that,
  //    but on iPhone (Safari/Chrome) it resolves against the LAYOUT
  //    viewport, which does not shrink when the browser's own address bar
  //    / tab bar chrome is on-screen — that chrome is a native overlay
  //    drawn on top of the page, not carved out of it. Every "slides up
  //    from below" sheet/page nested in here (Sheet.tsx, AmountKeypad, the
  //    Home Actions sheet, passcode sheets, etc.) inherits its bottom
  //    edge from this shell's height, so they'd all render with their
  //    lowest content landing under that chrome instead of above it —
  //    "navigation shows over my sheet", but only ever on iPhone, because
  //    Android already resizes its layout viewport instead of overlaying.
  // Measuring the real visible height in JS (the same VisualViewport API
  // ChatPage.tsx already uses for the keyboard) and applying it directly
  // as this shell's height fixes both problems at once, for every page
  // and sheet in the app, without touching each one individually.
  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0,
      height: visibleHeight ?? '100dvh',
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg)',
        color: 'var(--text-primary)',
        width: '100%',
        maxWidth: '430px',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', paddingBottom: showNav ? 'calc(65px + env(safe-area-inset-bottom, 0px))' : 0, minHeight: 0 }}>
          <WalletRecoveryBanner />
          <PageTransition locationKey={location.pathname}>
            <Outlet />
          </PageTransition>
        </div>
        {showNav && <BottomNav />}
        <Toast />
        <ModeToggle />
      </div>
    </div>
  )
}
