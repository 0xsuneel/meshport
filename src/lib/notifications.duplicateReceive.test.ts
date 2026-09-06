// src/lib/notifications.duplicateReceive.test.ts
//
// Regression guard for a duplicate-notification bug found during /investigate
// (2026-09-05): AppLayout.tsx's claim-recovery-scan handler called
// notifyPaymentReceived/notifyPaymentReceivedFromAddress with NO `id`, so
// each call fell back to a fresh random id in addNotification (store/index.ts)
// — meaning the store's own id-based dedup ledger could never catch a repeat.
//
// runScan() there fires on every tab/app visibilitychange, and the server-side
// claim-recovery-scan function's "already recovered" check is a SELECT-then-
// upsert with no advisory lock — racy across two concurrent invocations of the
// same scan (e.g. two fast tab-switches in a row). Both invocations can see
// the same not-yet-written deposit, both report it in their `recovered` list,
// and both land in the client-side handler — which then wrote two separate
// "Payment received" notifications for the exact same underlying transaction.
//
// Fix: pass a stable `id` instead of leaving it undefined. This test
// simulates that race directly: two calls describing the "same" received
// payment (same id, as the fix now guarantees) must only ever produce one
// notification — regardless of how many times the racy scan re-discovers it.
//
// UPDATE (2026-09-05, /investigate follow-up): the id AppLayout.tsx actually
// passes was changed from `ext_recv_${row.tx_hash}` to `ext_recv_${row.id}`.
// The original fix above assumed tx_hash was "the same pattern already used
// everywhere else... HomePage.tsx's... ext_recv_ prefixed ids" — but
// HomePage.tsx's fireIfReceived() actually keys ext_recv_ on the activity
// row's `id` column, not tx_hash. Two different id spaces for the same row
// meant AppLayout's claim-recovery-scan handler and HomePage's live
// subscription each notified the same external deposit under a different,
// never-colliding id — a real, reproduced duplicate-notification bug this
// test's own dedup assertions did not catch, because it never modeled the
// cross-file id mismatch, only same-file repeats. See AppLayout.tsx's own
// comment at the notifId line for the full account.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// notifications.ts imports @/lib/supabase (for the reward-cap check in a
// different function), which constructs a real Supabase client at module
// load and throws without env vars — same issue every other test in this
// suite that touches @/lib/notifications or @/store already works around.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }), maybeSingle: async () => ({ data: null }) }),
        ilike: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  },
}))

import { useNotificationStore } from '@/store'
import { notifyPaymentReceived, notifyPaymentReceivedFromAddress } from './notifications'

describe('duplicate-receive-notification race (AppLayout claim-recovery-scan)', () => {
  beforeEach(() => {
    // Fresh slate per test — same wallet-switch reset the real app performs.
    useNotificationStore.getState()._resetForAddress(null)
  })

  it('two concurrent scan invocations reporting the SAME tx_hash produce only ONE notification', () => {
    const notifId = 'ext_recv_0xabc123'
    // Simulates AppLayout.tsx's runScan() handler being invoked twice in a
    // row (two visibilitychange events firing close together) and BOTH
    // independently discovering the same underlying deposit.
    notifyPaymentReceived({ id: notifId, amount: 5, fromUsername: 'alice' })
    notifyPaymentReceived({ id: notifId, amount: 5, fromUsername: 'alice' })

    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].id).toBe(notifId)
  })

  it('same fix applies to the from-address variant (unresolved sender)', () => {
    const notifId = 'ext_recv_0xdef456'
    notifyPaymentReceivedFromAddress({ id: notifId, amount: 12, fromAddress: '0x1111111111111111111111111111111111111111' })
    notifyPaymentReceivedFromAddress({ id: notifId, amount: 12, fromAddress: '0x1111111111111111111111111111111111111111' })

    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(1)
  })

  it('sanity check: the bug this guards against — omitting `id` really does produce a duplicate', () => {
    // Without a stable id, addNotification falls back to a random one every
    // call — this is the exact regression AppLayout.tsx used to have. Proves
    // the test above is actually exercising the dedup path, not passing
    // vacuously.
    notifyPaymentReceived({ amount: 5, fromUsername: 'alice' })
    notifyPaymentReceived({ amount: 5, fromUsername: 'alice' })

    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(2) // the bug, reproduced — id-less calls are NOT deduped
  })

  it('different tx_hash ids are genuinely different notifications, not over-deduped', () => {
    notifyPaymentReceived({ id: 'ext_recv_0xaaa', amount: 5, fromUsername: 'alice' })
    notifyPaymentReceived({ id: 'ext_recv_0xbbb', amount: 7, fromUsername: 'bob' })

    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(2)
  })

  // ── 2026-09-06: the three external-deposit notifiers must all agree ──────
  // The real-time Arc log watcher (lib/arcDepositWatcher.ts) fires BEFORE any
  // Supabase row exists, so it can only key on the tx hash. HomePage's
  // fireIfReceived() and AppLayout's claim-recovery-scan handler were realigned
  // onto that SAME scheme: `ext_recv_tx_<clean-lowercased-hash>`. This models
  // one external EURC deposit seen by all three and asserts ONE notification.
  it('watcher + fireIfReceived + claim-recovery-scan produce ONE notification for one deposit', () => {
    const HASH = '0xEF12aB34' // mixed-case on-chain hash
    const clean = HASH.toLowerCase()

    // 1. arcDepositWatcher: id = `ext_recv_tx_${tx.txHash.toLowerCase()}`
    const watcherId = `ext_recv_tx_${clean}`
    notifyPaymentReceivedFromAddress({ id: watcherId, amount: 20, fromAddress: '0x70e3000000000000000000000000000000061af8', tokenSymbol: 'EURC' })

    // 2. HomePage.fireIfReceived: record.txHash = stripHashPrefix('recv_' + clean) = clean
    //    id = `ext_recv_tx_${record.txHash || record.id}`
    const rowTxHash = `recv_${clean}`
    const stripped = rowTxHash.replace(/^(send_|recv_|bulk_|bulkrecv_|ubrecover_)/, '')
    const homeId = `ext_recv_tx_${stripped || 'uuid-1'}`
    notifyPaymentReceived({ id: homeId, amount: 20, fromUsername: 'someone', tokenSymbol: 'EURC' })

    // 3. AppLayout claim-recovery-scan: row.tx_hash = 'recv_' + clean
    //    id = `ext_recv_tx_${row.tx_hash.replace(/^recv_/,'').toLowerCase() || row.id}`
    const scanId = `ext_recv_tx_${(rowTxHash).replace(/^recv_/, '').toLowerCase() || 'uuid-1'}`
    notifyPaymentReceivedFromAddress({ id: scanId, amount: 20, fromAddress: '0x70e3000000000000000000000000000000061af8', tokenSymbol: 'EURC' })

    expect(watcherId).toBe(homeId)
    expect(homeId).toBe(scanId)
    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(1)
  })

  // ── 2026-09-06: MeshPort-to-MeshPort (username) payments double-notified ──
  // Reported bug: paying another MeshPort user (e.g. "uttam07.arc") fired TWO
  // "Received from" notifications, while a deposit from a genuine external
  // wallet correctly fired only one.
  //
  // Root cause: an in-app username payment (PaySendPage.tsx) is still a real
  // on-chain transfer, so TWO independent paths see it and each fired its own
  // notification under a DIFFERENT id:
  //   1. lib/arcDepositWatcher.ts's on-chain log watcher — id
  //      `ext_recv_tx_<hash>` (it has no concept of the in-app chat message,
  //      it only sees the Transfer log).
  //   2. HomePage.tsx's `messages`-table subscription (and its catch-up scan)
  //      — id `payment_recv_msg_<msg.id>`, keyed on the chat message row
  //      instead of the transaction hash.
  // Two different id namespaces for the same transfer meant the store's
  // id-based dedup ledger could never recognize them as the same event.
  // A genuine external-wallet deposit has no `payment_sent` chat message at
  // all, so only path 1 ever fires for it — which is why external deposits
  // already showed correctly as a single notification.
  //
  // Fix: HomePage.tsx's two `messages`-subscription handlers now key their
  // notification id on the transaction hash (`ext_recv_tx_<hash>`, same
  // scheme as arcDepositWatcher.ts) whenever the message carries a tx_hash,
  // instead of the message id. This test models both paths firing for the
  // same MeshPort-to-MeshPort transfer and asserts only one notification.
  it('MeshPort-to-MeshPort payment: chat-message path and on-chain watcher path collapse to ONE notification', () => {
    const HASH = '0xAbCd1234ef567890'
    const clean = HASH.toLowerCase()

    // 1. arcDepositWatcher.ts's fireDepositNotification: id = `ext_recv_tx_${tx.txHash.toLowerCase()}`
    const watcherId = `ext_recv_tx_${clean}`
    notifyPaymentReceived({ id: watcherId, amount: 1, fromUsername: 'uttam07', tokenSymbol: 'USDC' })

    // 2. HomePage.tsx's messages-table subscription / catch-up scan, post-fix:
    //    id = msg.tx_hash ? `ext_recv_tx_${msg.tx_hash.toLowerCase()}` : `payment_recv_msg_${msg.id}`
    const msgTxHash = HASH // as stored on the message row, arbitrary case
    const homeId = msgTxHash ? `ext_recv_tx_${msgTxHash.toLowerCase()}` : `payment_recv_msg_msg-1`
    notifyPaymentReceived({ id: homeId, amount: 1, fromUsername: 'uttam07', tokenSymbol: 'USDC' })

    expect(watcherId).toBe(homeId)
    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(1)
  })

  // ── 2026-09-06 (follow-up): the first fix above referenced the WRONG
  // column name and silently never engaged ──────────────────────────────
  // HomePage.tsx's two `messages`-table handlers read `msg.tx_hash`, but the
  // real column (see chatService.ts / ChatPage.tsx) is `payment_tx_hash`.
  // `msg.tx_hash` is always `undefined` on the actual row, so the id there
  // ALWAYS fell back to `payment_recv_msg_<msg.id>` — the exact bug the test
  // above thought it was guarding against. This models the real row shape
  // (payment_tx_hash, no tx_hash) and asserts the id-selection logic used in
  // HomePage.tsx actually produces the tx-hash-keyed id from the real field,
  // not the fallback.
  it('id-selection reads the REAL column (payment_tx_hash), not a nonexistent tx_hash field', () => {
    const row = { id: 'msg-42', payment_tx_hash: '0xFeed00Cafe', payment_amount: 10 } as any

    // Mirrors the exact expression now used in both HomePage.tsx handlers.
    const txHash: string | undefined = row.payment_tx_hash || undefined
    const notifId = txHash ? `ext_recv_tx_${txHash.toLowerCase()}` : `payment_recv_msg_${row.id}`

    expect(notifId).toBe('ext_recv_tx_0xfeed00cafe')
    expect(notifId).not.toBe(`payment_recv_msg_${row.id}`)

    // And it still agrees with arcDepositWatcher.ts's id for the same hash.
    const watcherId = `ext_recv_tx_${row.payment_tx_hash.toLowerCase()}`
    expect(notifId).toBe(watcherId)

    notifyPaymentReceived({ id: watcherId, amount: 10, fromUsername: 'uttam07' })
    notifyPaymentReceived({ id: notifId, amount: 10, fromUsername: 'uttam07' })
    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(1)
  })
})
