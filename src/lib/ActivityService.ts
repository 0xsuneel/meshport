/**
 * ActivityService.ts — Centralized Supabase-backed activity tracking.
 *
 * Supabase `activity` table is the SINGLE SOURCE OF TRUTH.
 * No localStorage, no RPC history, no browser caches.
 *
 * All transaction types write here:
 *   send · receive · swap · bridge · claim · deposit · withdraw · bulk
 */

import { supabase } from './supabase'
import { searchUsersPartialDb } from './supabase'
import { ARC_EXPLORER, explorerTxUrl } from './chainExplorers'
import { subscribeWithRetry } from './chatService'




export type ActivityType = 'send' | 'receive' | 'swap' | 'bridge' | 'claim' | 'deposit' | 'withdraw' | 'bulk'
  // P2P marketplace events (see src/lib/p2pService.ts) — every one of these
  // corresponds to a real on-chain escrow movement, not just a status
  // change: 'p2p_sell_order' fires when YOUR crypto gets locked into P2P
  // escrow (creating a sell offer, or accepting someone else's buy offer —
  // both are "I've committed USDC to a P2P trade" from a ledger point of
  // view); 'p2p_refund' fires when escrowed crypto comes back to you
  // without a completed sale (cancelling a sell offer, or a buy-offer
  // trade being cancelled/expiring); 'p2p_purchase' fires for the BUYER
  // when a trade completes and USDC actually lands in their wallet.
  | 'p2p_sell_order' | 'p2p_refund' | 'p2p_purchase'
export type ActivityStatus = 'pending' | 'completed' | 'failed'

// ── The canonical record shape ────────────────────────────────────────────────
export interface ActivityRecord {
  id:                  string
  userId?:             string
  walletAddress:       string
  txHash?:             string
  destinationTxHash?:  string
  activityType:        ActivityType
  sourceChain?:        string
  destinationChain?:   string
  tokenSymbol:         string
  tokenAddress?:       string
  amount:              number
  usdValue:            number
  counterpartyAddress?: string
  status:              ActivityStatus
  explorerUrl?:        string
  metadata:            Record<string, any>
  createdAt:           string
  updatedAt:           string
}

// Internal tx_hash values for 'send'/'receive' rows carry a `send_`/`recv_`
// prefix purely so the DB's UNIQUE(tx_hash, wallet_address) constraint can
// tell apart a self-transfer's send-leg and receive-leg (same wallet, same
// on-chain hash). `ubrecover_` is the same idea for UB fund-recovery rows
// (see lib/ubFundRecovery.ts) — none of these prefixes should ever reach
// the UI. Every consumer (display, explorer links) should see the real
// on-chain hash, not the storage-layer key it's saved under.
function stripHashPrefix(hash: string): string {
  return hash.replace(/^(send_|recv_|bulk_|bulkrecv_|ubrecover_)/, '')
}

// ── DB row → ActivityRecord ───────────────────────────────────────────────────
function fromRow(r: any): ActivityRecord {
  return {
    id:                  r.id,
    userId:              r.user_id ?? undefined,
    walletAddress:       r.wallet_address,
    txHash:              r.tx_hash ? stripHashPrefix(r.tx_hash) : undefined,
    destinationTxHash:   r.destination_tx_hash ?? undefined,
    activityType:        r.activity_type as ActivityType,
    sourceChain:         r.source_chain ?? undefined,
    destinationChain:    r.destination_chain ?? undefined,
    tokenSymbol:         r.token_symbol ?? 'USDC',
    tokenAddress:        r.token_address ?? undefined,
    amount:              parseFloat(r.amount ?? '0'),
    usdValue:            parseFloat(r.usd_value ?? r.amount ?? '0'),
    counterpartyAddress: r.counterparty_address ?? undefined,
    status:              (r.status ?? 'completed') as ActivityStatus,
    explorerUrl:         r.explorer_url ?? undefined,
    metadata:            r.metadata ?? {},
    createdAt:           r.created_at,
    updatedAt:           r.updated_at,
  }
}

function explorerUrl(txHash: string, chain?: string): string {
  if (!txHash) return ''
  if (chain) {
    const url = explorerTxUrl(chain, txHash)
    if (url) return url
  }
  return `${ARC_EXPLORER}/tx/${txHash}`
}

// ── Save helpers ──────────────────────────────────────────────────────────────

interface SaveParams {
  walletAddress:       string
  userId?:             string
  txHash?:             string
  destinationTxHash?:  string
  activityType:        ActivityType
  amount:              number
  tokenSymbol?:        string
  tokenAddress?:       string
  sourceChain?:        string
  destinationChain?:   string
  counterpartyAddress?: string
  status?:             ActivityStatus
  explorerUrl?:        string
  metadata?:           Record<string, any>
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Writes one activity row. Returns true on confirmed success (insert OR a
 * harmless duplicate-of-existing-row), false only after every retry has
 * been exhausted — callers that care can surface that to the user or queue
 * a manual "refresh" nudge instead of losing the row silently.
 *
 * Two bugs this fixes vs. the original fire-and-forget version:
 *
 * 1. `on_conflict=tx_hash,wallet_address` was ALWAYS sent, but the DB's
 *    unique index is partial — `UNIQUE (tx_hash, wallet_address) WHERE
 *    tx_hash IS NOT NULL` (see supabase_migration.sql). For any row with no
 *    real tx hash (a swap that returned no hash, a fallback id, etc.),
 *    Postgres has no matching arbiter for that ON CONFLICT target and the
 *    whole insert throws — previously that throw was only console.error'd
 *    and the row was gone for good. Now `on_conflict` is only sent when
 *    txHash is actually present, so a hashless row does a plain insert
 *    instead of erroring out.
 * 2. A single attempt, no retry: a transient network blip, a 5xx from
 *    PostgREST, or a not-yet-refreshed auth token meant the write was lost
 *    outright. Now retries transient failures (network errors, 5xx, 429)
 *    up to 3 times with backoff. 4xx auth/validation errors are NOT
 *    retried since retrying the same bad request won't help.
 */
export async function saveActivity(p: SaveParams): Promise<boolean> {
  const SUPA_URL  = (import.meta.env.VITE_SUPABASE_URL  as string) || ''

  const row = {
    wallet_address:       p.walletAddress.toLowerCase(),
    user_id:              p.userId ?? null,
    tx_hash:              p.txHash?.toLowerCase() ?? null,
    destination_tx_hash:  p.destinationTxHash?.toLowerCase() ?? null,
    activity_type:        p.activityType,
    amount:               p.amount,
    usd_value:            p.amount,
    token_symbol:         p.tokenSymbol ?? 'USDC',
    token_address:        p.tokenAddress ?? null,
    source_chain:         p.sourceChain ?? null,
    destination_chain:    p.destinationChain ?? null,
    counterparty_address: p.counterpartyAddress?.toLowerCase() ?? null,
    status:               p.status ?? 'completed',
    explorer_url:         p.explorerUrl ?? (p.txHash ? explorerUrl(p.txHash, p.sourceChain) : null),
    metadata:             p.metadata ?? {},
  }

  // Only ask Postgres to dedupe on (tx_hash, wallet_address) when tx_hash is
  // actually set — that's the only case the partial unique index covers.
  const url = row.tx_hash
    ? `${SUPA_URL}/rest/v1/activity?on_conflict=tx_hash,wallet_address`
    : `${SUPA_URL}/rest/v1/activity`
  const preferHeader = row.tx_hash
    ? 'return=minimal,resolution=ignore-duplicates'
    : 'return=minimal'

  const { authHeaders } = await import('./chatService')
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...(await authHeaders()),
          'Content-Type': 'application/json',
          'Prefer': preferHeader,
        },
        body: JSON.stringify(row),
      })
      if (res.ok || res.status === 409) return true // success, or benign duplicate
      const txt = await res.text()
      lastErr = `${res.status}: ${txt}`
      // 4xx other than 409 is a bad request / auth problem — retrying the
      // exact same payload won't fix it, so stop immediately.
      if (res.status >= 400 && res.status < 500) break
    } catch (e: any) {
      lastErr = e?.message ?? String(e)
      // network/timeout errors are worth retrying
    }
    if (attempt < 2) await sleep(400 * Math.pow(2, attempt)) // 400ms, 800ms
  }

  console.error('[ActivityService] saveActivity FAILED after retries:', p.activityType, p.txHash, lastErr)
  return false
}

/**
 * Updates an already-saved activity row's status — used to correct the rare
 * case where a transaction that was optimistically recorded as successful
 * (see arcService.ts's confirmTransactionInBackground) turns out to have
 * actually reverted on-chain. txHash here should be the SAME prefixed form
 * (e.g. `send_0x...`/`recv_0x...`) the row was originally saved under.
 */
export async function updateActivityStatus(txHash: string, walletAddress: string, status: ActivityStatus): Promise<void> {
  const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
  try {
    const { authHeaders } = await import('./chatService')
    await fetch(
      `${SUPA_URL}/rest/v1/activity?tx_hash=eq.${encodeURIComponent(txHash.toLowerCase())}&wallet_address=eq.${encodeURIComponent(walletAddress.toLowerCase())}`,
      {
        method: 'PATCH',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status }),
      },
    )
  } catch (e) {
    console.error('[ActivityService] updateActivityStatus failed:', txHash, e instanceof Error ? e.message : e)
  }
}

/**
 * Whether ANY activity row already exists for this wallet under EITHER the
 * plain or `recv_`-prefixed form of a tx hash — i.e. "has this blockchain
 * transaction already been represented in this wallet's history, under any
 * activity_type at all".
 *
 * Required because `send`/`swap`/`bulk` store the plain hash while
 * `receive` stores `recv_<hash>` — a plain `tx_hash + wallet_address`
 * lookup only ever catches an exact-string duplicate of the SAME type, not
 * the cross-type case (e.g. a `bulk`/received row and a `receive` row for
 * the same real transfer, which is exactly the BulkPay race this function
 * exists to close — see docs/BULKPAY_ACTIVITY_SAFETY_FIX.md).
 *
 * One request, not a poll: this queries once, immediately before the
 * caller's write, rather than checking-then-waiting-then-rechecking the way
 * claim-recovery-scan's existsActivityForTxHash does server-side. That
 * function polls because IT is racing an ~synchronous client write it has
 * no way to wait on directly. This function is called FROM the client write
 * itself, at the moment it's about to happen — there's nothing to wait for
 * on this side of the race; a single immediate check is the correct
 * primitive here, not a weaker version of the server-side one. It narrows,
 * but does not eliminate, the race: a competing writer's row landing in the
 * brief gap between this check and the caller's own insert is still
 * possible in principle (true elimination needs an atomic check-and-insert,
 * which is future Ledger-migration work, not this mitigation's job — see
 * the doc above for the full reasoning).
 *
 * Fails OPEN (returns false, i.e. "proceed with the write") on any network/
 * query error, matching the reasoning already used elsewhere in this
 * codebase for the equivalent server-side check (deposit-scan-all's
 * recentSwapOutputsByWallet: "losing the row would be worse" than a
 * possible duplicate) — never crediting a recipient at all is a worse
 * outcome than an occasional cosmetic duplicate.
 */
export async function hasAnyActivityForTx(walletAddress: string, txHash: string): Promise<boolean> {
  const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
  const plain = (txHash || '').trim().toLowerCase()
  if (!plain || !walletAddress) return false
  const recv = `recv_${plain}`
  try {
    const { authHeaders } = await import('./chatService')
    const res = await fetch(
      `${SUPA_URL}/rest/v1/activity` +
        `?wallet_address=eq.${encodeURIComponent(walletAddress.toLowerCase())}` +
        `&tx_hash=in.(${encodeURIComponent(plain)},${encodeURIComponent(recv)})` +
        `&select=id&limit=1`,
      { headers: { ...(await authHeaders()) } },
    )
    if (!res.ok) return false // fail open — see doc comment above
    const rows = await res.json()
    return Array.isArray(rows) && rows.length > 0
  } catch (e) {
    console.error('[ActivityService] hasAnyActivityForTx check failed (proceeding with write):', e instanceof Error ? e.message : e)
    return false
  }
}

// ── Typed save functions ──────────────────────────────────────────────────────

export const Activity = {

  send: (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; toAddress: string; tokenSymbol?: string; note?: string; fee?: number; toUsername?: string
  }) => saveActivity({
    walletAddress:       p.walletAddress,
    userId:              p.userId,
    txHash:              `send_${(p.txHash || '').toLowerCase()}`,
    activityType:        'send',
    amount:              p.amount,
    tokenSymbol:         p.tokenSymbol ?? 'USDC',
    counterpartyAddress: p.toAddress?.toLowerCase(),
    explorerUrl:         explorerUrl(p.txHash),
    metadata:            { note: p.note, fee: p.fee, toUsername: p.toUsername },
  }),

  /**
   * `receiveKind` is the explicit, canonical classification this row belongs
   * to -- introduced to stop HomePage.tsx's notification logic from depending
   * on an exact free-form `note` string (the bug: claim-recovery-scan's own
   * writer used a slightly different note text than deposit-scan-all's,
   * silently breaking the deposit notification for anything it recovered).
   * Every current writer of a 'receive' row is updated to pass this
   * explicitly:
   *   'external_deposit' -- a genuine external Receive (deposit-scan-all,
   *      claim-recovery-scan's faucet/claim recovery, the canonical
   *      chain_events deposit-activity-consumer). Should trigger the
   *      generic Receive notification.
   *   'p2p_payment' -- an in-app payment between MeshPort users (the chat
   *      payment_sent listener, PaySendPage.tsx's direct write). Already has
   *      its own dedicated notification fired at write time -- must NOT
   *      also trigger the generic Receive notification, or the recipient
   *      is notified twice for one payment.
   *   'reward_claim' -- a rewards-points claim landing on-chain. Already has
   *      its own dedicated in-app notification -- same duplicate-avoidance
   *      reasoning as p2p_payment.
   * Left undefined only for legacy call sites not yet migrated; the
   * notification code falls back to the old note-text check for those,
   * documented at that call site.
   */
  receive: (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; fromAddress: string; tokenSymbol?: string; note?: string; fromUsername?: string
    receiveKind?: 'external_deposit' | 'p2p_payment' | 'reward_claim'
  }) => saveActivity({
    walletAddress:       p.walletAddress,
    userId:              p.userId,
    txHash:              `recv_${(p.txHash || '').toLowerCase()}`,
    activityType:        'receive',
    amount:              p.amount,
    tokenSymbol:         p.tokenSymbol ?? 'USDC',
    counterpartyAddress: p.fromAddress?.toLowerCase(),
    explorerUrl:         explorerUrl(p.txHash),
    metadata:            { note: p.note, fromUsername: p.fromUsername, receiveKind: p.receiveKind },
  }),

  swap: (p: {
    walletAddress: string; userId?: string; txHash: string
    amountIn: number; amountOut: number
    tokenIn: string; tokenOut: string; status: ActivityStatus
  }) => saveActivity({
    walletAddress: p.walletAddress,
    userId:        p.userId,
    txHash:        p.txHash,
    activityType:  'swap',
    amount:        p.amountIn,
    tokenSymbol:   p.tokenIn,
    status:        p.status,
    explorerUrl:   p.txHash ? explorerUrl(p.txHash) : undefined,
    metadata:      { tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, amountOut: p.amountOut },
  }),

  bridge: (p: {
    walletAddress: string; userId?: string; txHash: string; destinationTxHash?: string
    amount: number; sourceChain: string; destinationChain: string; destinationAddress?: string
    status?: ActivityStatus
  }) => saveActivity({
    walletAddress:        p.walletAddress,
    userId:                p.userId,
    txHash:                p.txHash,
    destinationTxHash:     p.destinationTxHash,
    activityType:          'bridge',
    amount:                p.amount,
    sourceChain:           p.sourceChain,
    destinationChain:      p.destinationChain,
    counterpartyAddress:   p.destinationAddress,
    status:                p.status,
    explorerUrl:           explorerUrl(p.txHash, p.sourceChain),
    metadata:              {},
  }),

  // Finalizes a bridge row that was already written early (as 'pending',
  // via Activity.bridge above, right when the burn confirms) by PATCHing
  // it to 'completed' with the destination (mint) hash — a targeted
  // update to the ONE existing row, never a second insert. This is what
  // lets the activity row appear the moment the burn confirms instead of
  // only once the entire bridge (through mint) finishes, without
  // reintroducing duplicate-row risk: saveActivity's insert path still
  // only ever runs once per tx_hash for this flow.
  //
  // Falls back to a normal saveActivity() upsert if the PATCH matches
  // zero rows (e.g. the early 'pending' write never happened — burn event
  // genuinely never fired, only the UI timer advanced) — so the
  // transaction still ends up recorded even in that fallback case,
  // exactly as it always was before this change, just not instantly.
  markBridgeCompleted: async (p: {
    walletAddress: string; txHash: string; destinationTxHash?: string
    amount: number; sourceChain: string; destinationChain: string; destinationAddress?: string
  }) => {
    const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
    try {
      const { authHeaders } = await import('./chatService')
      const res = await fetch(
        `${SUPA_URL}/rest/v1/activity?tx_hash=eq.${encodeURIComponent(p.txHash.toLowerCase())}&wallet_address=eq.${encodeURIComponent(p.walletAddress.toLowerCase())}`,
        {
          method: 'PATCH',
          headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({
            status: 'completed',
            destination_tx_hash: p.destinationTxHash?.toLowerCase() ?? null,
          }),
        }
      )
      const updated = res.ok ? await res.json() : []
      if (!res.ok || !Array.isArray(updated) || updated.length === 0) {
        // Fallback: no existing row to finalize — record it fresh, same as
        // the pre-existing behavior this replaces.
        await saveActivity({
          walletAddress: p.walletAddress, txHash: p.txHash, destinationTxHash: p.destinationTxHash,
          activityType: 'bridge', amount: p.amount, sourceChain: p.sourceChain,
          destinationChain: p.destinationChain, counterpartyAddress: p.destinationAddress,
          status: 'completed', explorerUrl: explorerUrl(p.txHash, p.sourceChain), metadata: {},
        })
      }
    } catch (e: any) {
      console.error('[ActivityService] markBridgeCompleted failed:', e?.message)
    }
  },

  claim: (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; sourceChain?: string; explorerUrl?: string
  }) => {
    // Normalize chain names — 'Optimism Sepolia' and 'Optimism_Sepolia' → same key
    const normalizeChain = (c?: string) => c?.replace(/ /g, '_') ?? c
    return saveActivity({
      walletAddress:    p.walletAddress,
      userId:           p.userId,
      txHash:           p.txHash,
      activityType:     'claim',
      amount:           p.amount,
      sourceChain:      normalizeChain(p.sourceChain),
      destinationChain: 'Arc_Testnet',
      explorerUrl:      p.explorerUrl || explorerUrl(p.txHash, normalizeChain(p.sourceChain)),
      metadata:         {},
    })
  },

  deposit: (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; sourceChain: string; explorerUrl?: string
  }) => saveActivity({
    walletAddress:    p.walletAddress,
    userId:           p.userId,
    txHash:           p.txHash,
    activityType:     'deposit',
    amount:           p.amount,
    sourceChain:      p.sourceChain,
    destinationChain: 'Unified Balance',
    explorerUrl:      p.explorerUrl || explorerUrl(p.txHash, p.sourceChain),
    metadata:         {},
  }),

  bulk: (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; recipientCount: number; purpose?: string
    recipients?: { label: string; amount: number; txHash?: string; isSelf?: boolean }[]
  }) => saveActivity({
    walletAddress: p.walletAddress,
    userId:        p.userId,
    // BUG FIX: previously stored with NO prefix at all (unlike send/receive,
    // which always use send_/recv_ specifically so a self-transfer's two
    // legs never collide on the DB's UNIQUE(tx_hash, wallet_address) index
    // — see stripHashPrefix's own comment). When a bulk payout includes the
    // payer's own wallet as a recipient, this row and bulkReceived()'s row
    // below shared the exact same (wallet_address, tx_hash) key — the two
    // legs collided, AND bulkReceived()'s own hasAnyActivityForTx guard
    // (built to catch a genuinely different race, see that function's own
    // comment) found this row first and silently skipped writing the
    // received leg entirely. Prefixing both legs distinctly closes both
    // problems at once, the same way send_/recv_ already does for Pay.
    txHash:        `bulk_${(p.txHash || '').toLowerCase()}`,
    activityType:  'bulk',
    amount:        p.amount,
    explorerUrl:   explorerUrl(p.txHash),
    metadata:      { direction: 'sent', recipientCount: p.recipientCount, purpose: p.purpose, recipients: p.recipients },
  }),

  // Receiver-side record — written to a RECIPIENT's own wallet_address when they're
  // paid as part of someone else's bulk payout. Shows the individual amount THEY
  // were allocated (never the payer's total), the purpose text the payer entered,
  // and who paid them. Distinguished from the payer's own 'bulk' summary row via
  // metadata.direction === 'received'.
  //
  // P0 safety mitigation (see docs/BULKPAY_ACTIVITY_SAFETY_FIX.md): this write
  // comes from the PAYER's browser, on behalf of a DIFFERENT wallet, with no
  // confirmation wait — the same shape of race already known for claim-recovery-
  // scan's swap-vs-receive collision (docs/ACTIVITY_WRITER_AUDIT.md §2), but here
  // completely unguarded before this fix. Guarded now with hasAnyActivityForTx:
  // if a recovery worker (deposit-scan-all reconcile, claim-recovery-scan) already
  // credited this recipient a plain 'receive' row for this same transaction before
  // this call ran, skip the write rather than create a second, differently-labeled
  // row for the same money movement. Returns `true` on skip (not a failure — the
  // recipient's history already correctly reflects this transaction, just under a
  // different activity_type) as well as on a normal successful write.
  //
  // Self-transfer note: the guard above checks hasAnyActivityForTx with the RAW
  // (unprefixed) txHash, exactly as written — that's intentional, not a bug to
  // "fix" alongside the prefix change below. It still needs to catch a real
  // recv_<hash> row from an unrelated recovery worker; it just no longer
  // false-positives against Activity.bulk()'s own sent-leg row for the same
  // wallet, now that that row lives under a different key (bulk_<hash>, not
  // plain/recv_<hash>) — see that writer's own comment for the full reasoning.
  bulkReceived: async (p: {
    walletAddress: string; userId?: string; txHash: string
    amount: number; fromAddress: string; fromUsername?: string; purpose?: string
  }): Promise<boolean> => {
    if (await hasAnyActivityForTx(p.walletAddress, p.txHash)) {
      console.log('[ActivityService] bulkReceived skipped — activity already exists for this tx/wallet under another type:', p.txHash, p.walletAddress)
      return true
    }
    return saveActivity({
      walletAddress:       p.walletAddress,
      userId:              p.userId,
      txHash:              `bulkrecv_${(p.txHash || '').toLowerCase()}`,
      activityType:        'bulk',
      amount:              p.amount,
      counterpartyAddress: p.fromAddress?.toLowerCase(),
      explorerUrl:         explorerUrl(p.txHash),
      metadata:            { direction: 'received', purpose: p.purpose, fromUsername: p.fromUsername },
    })
  },
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export interface FetchOptions {
  limit?:        number
  offset?:       number
  activityType?: ActivityType | 'p2p'
  status?:       ActivityStatus
  search?:       string
  // ISO timestamp — only rows created strictly after this are returned.
  // Used by catch-up scans to respect users.notifications_cleared_at, so a
  // cleared browser doesn't resurrect notifications for events that
  // happened before the user last tapped Clear (see the migration
  // 20260719090000_notifications_cleared_watermark.sql for why this exists
  // server-side rather than relying on local storage alone).
  since?:        string
  // Pending bridge/claim rows are excluded by default — see fetchActivity's
  // own comment for why. Opt in explicitly for callers that need them
  // (MultichainPage.tsx's own progress view, MultichainClaimPage.tsx's
  // internal claimed-hash tracking).
  includePendingBridge?: boolean
}

export async function fetchActivity(
  walletAddress: string,
  opts: FetchOptions = {},
): Promise<ActivityRecord[]> {
  const SUPA_URL  = (import.meta.env.VITE_SUPABASE_URL  as string) || ''
  const SUPA_KEY  = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
  const { limit = 100, offset = 0, activityType, status, search, since, includePendingBridge = false } = opts

  const addr = walletAddress.toLowerCase()
  // Secondary sort key on `id` (not just `created_at.desc`) for the same
  // reason ActivityPage.tsx's own client-side sort now has one: Postgres
  // does not guarantee a stable row order for ties on a single column, and
  // `created_at` genuinely can tie at millisecond/microsecond resolution
  // for rows written back-to-back (e.g. a bulk payout's sent + received
  // legs). Without this, the exact same underlying rows could come back in
  // a different relative order across two otherwise-identical requests —
  // "history doesn't follow timestamp order" from the user's perspective,
  // even though every row's own timestamp was always correct. Matches the
  // tiebreak direction ActivityPage.tsx's client-side sort already uses.
  let url = `${SUPA_URL}/rest/v1/activity?wallet_address=eq.${encodeURIComponent(addr)}&order=created_at.desc,id.desc&limit=${limit}&offset=${offset}`
  if (activityType === 'bridge') {
    // 'withdraw' included here too — the ONLY thing that ever writes that
    // activity_type is the UB fund-recovery flow (lib/ubFundRecovery.ts),
    // which is itself a byproduct of a failed multichain transfer. It
    // belongs in the same "Multichain" bucket as bridge/claim, both for
    // the pending-exclusion below and so MultichainPage.tsx's own activity
    // view (and the failure screen's "View Recovery Status" link, which
    // navigates to this same filter) can actually find and show it.
    url += `&activity_type=in.(bridge,claim,withdraw)`
  } else if (activityType === 'p2p') {
    url += `&activity_type=in.(p2p_sell_order,p2p_refund,p2p_purchase)`
  } else if (activityType) {
    url += `&activity_type=eq.${activityType}`
  }
  if (status) url += `&status=eq.${status}`
  if (since) url += `&created_at=gt.${encodeURIComponent(since)}`

  // ── Search: username / wallet address / tx hash, across every activity type ──
  // The `search` option was previously accepted but never actually applied
  // to the query (dead param) — this wired it up for real.
  //
  // Username isn't a column on `activity` at all (it's resolved client-side
  // afterward, see Pass 4 below), so a username search first resolves it to
  // matching users' wallet addresses via the same partial-match lookup the
  // Send flow's "as you type" search already uses (searchUsersPartialDb),
  // then matches those wallets against counterparty_address. A wallet/hash
  // -shaped term matches directly against tx_hash / destination_tx_hash /
  // counterparty_address — no need to guess which one, since ilike across
  // all three catches whichever it actually is. Runs across every activity
  // type (send/receive/swap/bridge/bulk/p2p/etc.) — the activityType filter
  // above (if any) narrows further, it doesn't gate search away from any
  // one type.
  let searchOrClause = ''
  const rawSearch = (search ?? '').trim()
  if (rawSearch) {
    // Strip characters that would break out of the PostgREST OR-group
    // syntax (`,` `(` `)`) — everything else is passed through as-is.
    // Still fully scoped to this wallet's own rows (wallet_address=eq.
    // above), so at worst a stray character just narrows/broadens the
    // match, it can never reach another wallet's data.
    const term = rawSearch.replace(/[,()]/g, '')
    if (term) {
      const parts = [
        `tx_hash.ilike.*${term}*`,
        `destination_tx_hash.ilike.*${term}*`,
        `counterparty_address.ilike.*${term}*`,
      ]
      try {
        const matchedUsers = await searchUsersPartialDb(term, undefined, 10)
        for (const u of matchedUsers) {
          const w = (u.wallet_address || '').replace(/[,()]/g, '')
          if (w) parts.push(`counterparty_address.ilike.*${w}*`)
        }
      } catch (e) {
        console.error('[ActivityService] username search lookup failed:', (e as any)?.message)
      }
      searchOrClause = `or(${parts.join(',')})`
    }
  }

  // Pending multichain transfers/claims already have a dedicated, purpose
  // -built home: MultichainPage.tsx's own all/pending/success/failed view,
  // which shows live progress and lets the user tap through to the actual
  // in-flight claim/transfer screen. The main navigation Activity list is a
  // history of what's happened, not a progress tracker — a pending bridge
  // row sitting there (sometimes for many minutes on a slow chain) reads
  // as clutter, not information, and there's nothing useful to tap into
  // from a plain history row anyway. Excluded here by default; callers
  // that genuinely need pending bridge/claim rows (MultichainPage.tsx,
  // MultichainClaimPage.tsx's own internal claimed-hash tracking) opt back
  // in explicitly with includePendingBridge: true. Once a bridge/claim
  // row's status leaves 'pending', it's a completed part of the wallet's
  // history and shows up in the main list exactly like anything else —
  // no special-casing needed there, this only ever filters the pending state.
  const pendingClause = 'or(activity_type.not.in.(bridge,claim,withdraw),status.neq.pending)'
  if (searchOrClause) {
    // Both conditions must hold at once, and PostgREST only allows one
    // top-level `or=` per query — nest both OR-groups under a single `and=`
    // instead of sending two competing `or=` params (the second would just
    // silently overwrite the first).
    url += includePendingBridge
      ? `&${searchOrClause}`
      : `&and=(${pendingClause},${searchOrClause})`
  } else if (!includePendingBridge) {
    url += `&${pendingClause}`
  }

  try {
    const { authHeaders } = await import('./chatService')
    const res = await fetch(url, {
      headers: {
        ...(await authHeaders()),
        'Accept': 'application/json',
      },
    })
    if (!res.ok) {
      const txt = await res.text()
      console.error('[ActivityService] fetchActivity REST FAILED:', res.status, txt)
      return []
    }
    const data = await res.json()
    const rows: ActivityRecord[] = (data ?? []).map(fromRow)

    // Pass 1: deduplicate by (activityType + txHash) — using activityType too
    // means a self-transfer's send-leg and receive-leg (same wallet, same
    // clean on-chain hash) are still treated as distinct rows here for
    // send/receive, since those legs have different activityType values
    // ('send' vs 'receive').
    //
    // BUG FIX: that reasoning does NOT hold for a self-included BulkPay.
    // Both the sent summary and the payer's own received leg are stored
    // with the SAME activityType ('bulk') and the SAME clean hash —
    // they're only distinguished by metadata.direction ('sent' vs
    // 'received'), which this key never looked at. The query returns
    // newest-first, and the received leg is always written a few hundred
    // ms after the sent summary, so it always won this filter and the
    // sent row was silently dropped right here — before it ever reached
    // ActivityPage's own (already direction-aware) dedup, which never got
    // a chance to see both rows. Folding direction into the key fixes
    // this the same way it was already fixed in ActivityPage.tsx's
    // dedupeAndSortActivityRecords and useActivity.ts's
    // mergeOnchainIntoRecords — this was the one remaining place using
    // the old, non-direction-aware key.
    const seenHash = new Set<string>()
    const pass1 = rows.filter(r => {
      if (!r.txHash) return true
      const direction = (r as any).metadata?.direction
      const key = `${r.activityType}:${r.txHash}:${direction || ''}`
      if (seenHash.has(key)) return false
      seenHash.add(key)
      return true
    })

    // Pass 2: deduplicate bridge/claim — burn+mint can create two rows when
    // a hash is briefly missing on insert. Same fix as Pass 3 below: only
    // apply this fuzzy (type+amount+chain, 2-minute window) heuristic to
    // rows that don't already have a real txHash. Bridge/claim rows always
    // carry a real, unique burn hash (see Activity.bridge/Activity.claim
    // above) once fully recorded, and Pass 1 already dedupes exactly on
    // that — applying the fuzzy heuristic unconditionally would silently
    // hide two genuinely separate transfers/claims of the same amount from
    // the same chain sent within 2 minutes of each other.
    const seenKey2 = new Map<string, number>()
    const pass2 = pass1.filter(r => {
      if (r.activityType !== 'claim' && r.activityType !== 'bridge') return true
      if (r.txHash) return true // has a real, unique hash — Pass 1 already handled it correctly
      const chain = r.sourceChain || r.destinationChain || ''
      const key   = `${r.activityType}:${r.amount}:${chain}`
      const t     = new Date(r.createdAt).getTime()
      const last  = seenKey2.get(key)
      if (last !== undefined && Math.abs(t - last) < 2 * 60 * 1000) return false
      seenKey2.set(key, t)
      return true
    })

    // Pass 3: catch LEGACY duplicates only — rows from before txHash was
    // reliably recorded on every send/receive row. Every current row always
    // gets a real, unique hash (`send_${hash}` / `recv_${hash}` — see
    // Activity.send/Activity.receive above), and Pass 1 already dedupes
    // exactly on that. This heuristic used to run unconditionally on EVERY
    // send/receive row regardless of whether it had a real hash, which meant
    // two genuinely separate payments — same recipient, same amount, sent
    // back-to-back — got silently collapsed into one on both the sender's
    // and the recipient's Activity page. Now gated to only rows with no
    // txHash at all, which is what "legacy duplicates" actually meant.
    const seenLegacy = new Map<string, number>()
    const pass3 = pass2.filter(r => {
      if (r.activityType !== 'send' && r.activityType !== 'receive') return true
      if (r.txHash) return true // has a real, unique hash — Pass 1 already handled it correctly
      const cp = (r.counterpartyAddress || '').toLowerCase().slice(0, 10)
      const key = `${r.activityType}:${r.amount}:${cp}`
      const t = new Date(r.createdAt).getTime()
      const last = seenLegacy.get(key)
      if (last !== undefined && Math.abs(t - last) < 60_000) return false
      seenLegacy.set(key, t)
      return true
    })

    // Pass 4: resolve counterparty addresses → MeshPort usernames in one batch query
    // For rows where metadata.toUsername/fromUsername is missing but counterpartyAddress exists
    const needsLookup = pass3.filter(r =>
      (r.activityType === 'send' || r.activityType === 'receive') &&
      r.counterpartyAddress &&
      !(r as any).metadata?.toUsername &&
      !(r as any).metadata?.fromUsername
    )

    if (needsLookup.length > 0) {
      try {
        const addrs = [...new Set(needsLookup.map(r => r.counterpartyAddress!.toLowerCase()))]
        const orFilter = addrs.map(a => `wallet_address.ilike.${a}`).join(',')
        const res2 = await fetch(
          `${SUPA_URL}/rest/v1/users?or=(${orFilter})&select=wallet_address,username,display_name`,
          { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }
        )
        if (res2.ok) {
          const users = await res2.json() as any[]
          const userMap = new Map<string, { username: string; display_name: string }>()
          for (const u of users) userMap.set((u.wallet_address || '').toLowerCase(), u)
          // Enrich records with resolved username
          return pass3.map(r => {
            if ((r.activityType !== 'send' && r.activityType !== 'receive') || !r.counterpartyAddress) return r
            const meta = (r as any).metadata || {}
            if (meta.toUsername || meta.fromUsername) return r
            const u = userMap.get(r.counterpartyAddress.toLowerCase())
            if (!u) return r
            const username = u.username?.endsWith('.arc') ? u.username : (u.username ? u.username + '.arc' : '')
            const enrichedMeta = r.activityType === 'send'
              ? { ...meta, toUsername: username }
              : { ...meta, fromUsername: username }
            return { ...r, metadata: enrichedMeta } as ActivityRecord
          })
        }
      } catch {}
    }

    return pass3
  } catch (e: any) {
    console.error('[ActivityService] fetchActivity ERROR:', e?.message)
    return []
  }
}


// ── Fetch single activity record by ID ───────────────────────────────────────
export async function fetchActivityById(
  id: string,
): Promise<ActivityRecord | null> {
  const { data, error } = await supabase
    .from('activity')
    .select('*')
    .eq('id', id)
    .single()
  if (error) { console.error('[ActivityService] fetchActivityById error:', error.message); return null }
  return data ? fromRow(data) : null
}

// ── Realtime subscription ─────────────────────────────────────────────────────
//
// Uses subscribeWithRetry (see chatService.ts) instead of a bare
// `.subscribe()`. A plain subscription has no built-in recovery: if the
// socket drops (tab backgrounded, brief network blip, an auth token
// refresh invalidating the channel) it goes silent and nothing ever tells
// the page to reconnect — new activity keeps landing in Supabase fine, but
// the open tab stops hearing about it until the page happens to remount.
// That's what "history doesn't appear instantly, only after reopening the
// page" was — the row was never actually late, the listener was dead.
//
// On every reconnect (including the very first connect) this also runs a
// catch-up fetch for anything created since the last row we actually saw,
// so a gap the socket missed while disconnected gets backfilled instead of
// silently dropped.
export function subscribeToActivity(
  walletAddress: string,
  onNew: (record: ActivityRecord) => void,
): () => void {
  const addr = walletAddress.toLowerCase()
  // Seeded to "now", not null. subscribeToActivity's own catchUp() below
  // deliberately only runs on a genuine RECONNECT (see its onReconnect
  // comment) — callers are expected to do their own initial fetch first
  // (HomePage.tsx's own separate catch-up IIFE does exactly this, and
  // additionally respects the user's notifications_cleared_at watermark,
  // which this function has no way to know about). But leaving this null
  // at setup meant a reconnect happening shortly after page load — a brief
  // mobile network blip is enough — ran catchUp() with no lower time bound
  // at all, re-fetching and re-delivering the last 50 rows regardless of
  // whether the caller's own initial fetch had just handled them seconds
  // earlier. That produced a real, reproducible duplicate notification for
  // any receive landing right around a reconnect. Seeding to "now" here
  // means catchUp() can only ever pick up rows created AFTER the
  // subscription itself was established — exactly the reconnect-gap it's
  // meant to cover — never anything from before it, which is the caller's
  // own initial fetch's job.
  let lastSeenAt: string | null = new Date().toISOString()

  const touchLastSeen = (createdAt: string) => {
    if (!lastSeenAt || new Date(createdAt).getTime() > new Date(lastSeenAt).getTime()) {
      lastSeenAt = createdAt
    }
  }

  const catchUp = async () => {
    try {
      const missed = await fetchActivity(addr, { limit: 50, since: lastSeenAt ?? undefined })
      // fetchActivity returns newest-first — replay oldest-first so onNew's
      // prepend-to-list callers end up with correct ordering.
      for (const rec of [...missed].reverse()) {
        touchLastSeen(rec.createdAt)
        onNew(rec)
      }
    } catch (e: any) {
      console.error('[ActivityService] catch-up fetch failed:', e?.message)
    }
  }

  const unsub = subscribeWithRetry(
    supabase,
    `activity:${addr}`,
    (channel) => channel.on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'activity',
        filter: `wallet_address=eq.${addr}`,
      },
      (payload) => {
        const rec = fromRow(payload.new)
        touchLastSeen(rec.createdAt)
        onNew(rec)
      },
    ),
    {
      // Fires on the very first successful subscribe too is NOT desired
      // (that would double-deliver rows the initial fetchActivity() already
      // loaded) — subscribeWithRetry only calls this for attempt > 1, i.e.
      // genuine reconnects after a drop.
      onReconnect: () => { catchUp() },
    },
  )

  return unsub
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function activityLabel(type: ActivityType): string {
  const MAP: Record<ActivityType, string> = {
    send:    'Sent',
    receive: 'Received',
    swap:    'Swap',
    bridge:  'Multichain Transfer',
    claim:   'Multichain Credit',
    deposit: 'Bridge Deposit',
    withdraw:'Withdraw',
    bulk:    'Bulk Payment',
    p2p_sell_order: 'P2P Sell Order Created',
    p2p_refund:     'P2P Refund',
    p2p_purchase:   'P2P Purchase',
  }
  return MAP[type] ?? type
}

export function activitySign(type: ActivityType, direction?: string): '+' | '-' | '↔' {
  if (type === 'receive' || type === 'claim' || type === 'p2p_refund' || type === 'p2p_purchase') return '+'  // Received / Multichain Received / P2P refund / P2P purchase = +
  if (type === 'bulk' && direction === 'received') return '+'  // Paid to me via someone else's bulk payout = +
  if (type === 'send' || type === 'bulk' || type === 'bridge' || type === 'p2p_sell_order') return '-'  // Sent / Multichain Sent / P2P escrow lock = -
  if (type === 'deposit') return '↔'  // Multichain Sent UB = no sign
  return '↔'
}

export function activityColor(type: ActivityType, status: ActivityStatus, direction?: string): string {
  if (status === 'failed') return 'text-danger'
  if (type === 'receive' || type === 'claim' || type === 'p2p_refund' || type === 'p2p_purchase') return 'text-success'  // + success
  if (type === 'bulk' && direction === 'received') return 'text-success'  // + success
  if (type === 'send' || type === 'bulk' || type === 'bridge' || type === 'p2p_sell_order') return 'text-danger'  // - danger
  if (type === 'deposit') return 'text-text-primary'  // Multichain Sent UB = no sign neutral
  return 'text-accent-text'
}


// ── Backfill activity from messages table ─────────────────────────────────────
// Called on login/import — syncs historical sends & receives from chat messages
export async function backfillActivityFromMessages(
  walletAddress: string,
  userId: string,
): Promise<void> {
  const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
  const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
  if (!SUPA_URL || !SUPA_KEY || !walletAddress || !userId) return

  const addr = walletAddress.toLowerCase()
  const { authHeaders } = await import('./chatService')
  const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' }

  try {
    // Fetch existing activity txHashes to avoid duplicates
    const existRes = await fetch(
      `${SUPA_URL}/rest/v1/activity?wallet_address=eq.${encodeURIComponent(addr)}&select=tx_hash&limit=500`,
      { headers }
    )
    const existRows = existRes.ok ? await existRes.json() : []
    const existingHashes = new Set<string>((existRows as any[]).map((r: any) => r.tx_hash).filter(Boolean))

    // Fetch payment_sent messages sent BY this user (sends)
    const sentRes = await fetch(
      `${SUPA_URL}/rest/v1/messages?type=eq.payment_sent&sender_id=eq.${userId}&select=*&limit=200&order=created_at.desc`,
      { headers }
    )
    const sentRows: any[] = sentRes.ok ? await sentRes.json() : []
    for (const msg of sentRows) {
      // Only backfill messages that carry a real on-chain tx hash. A message
      // with no tx_hash never actually settled on-chain, so it must not be
      // shown as a completed transaction (was previously faked as `msg_<id>`).
      if (!msg.tx_hash) continue
      const txHash = `send_${msg.tx_hash}`
      if (!msg.payment_amount || existingHashes.has(txHash)) continue
      existingHashes.add(txHash)
      // Get recipient wallet from conversation partner
      let toAddress: string | undefined
      let toUsername: string | undefined
      try {
        const convRes2 = await fetch(`${SUPA_URL}/rest/v1/conversations?id=eq.${msg.conversation_id}&select=participant_a,participant_b`, { headers })
        const convData: any[] = convRes2.ok ? await convRes2.json() : []
        if (convData[0]) {
          const otherId = convData[0].participant_a === userId ? convData[0].participant_b : convData[0].participant_a
          const uRes = await fetch(`${SUPA_URL}/rest/v1/users?id=eq.${otherId}&select=wallet_address,username`, { headers })
          const uData: any[] = uRes.ok ? await uRes.json() : []
          toAddress = uData[0]?.wallet_address
          toUsername = uData[0]?.username
        }
      } catch {}
      await saveActivity({
        walletAddress: addr, userId, txHash,
        activityType: 'send', amount: msg.payment_amount,
        tokenSymbol: msg.token_symbol || 'USDC', status: 'completed',
        counterpartyAddress: toAddress,
        metadata: { backfilled: true, toUsername },
      }).catch(() => {})
    }

    // Fetch payment_sent messages received BY this user (receives)
    // These are messages where type=payment_sent but sender_id != userId (other person sent to us)
    // We find them via conversations where we are a participant
    const convRes = await fetch(
      `${SUPA_URL}/rest/v1/conversations?or=(participant_a.eq.${userId},participant_b.eq.${userId})&select=id&limit=100`,
      { headers }
    )
    const convRows: any[] = convRes.ok ? await convRes.json() : []
    const convIds = convRows.map((c: any) => c.id)

    for (const convId of convIds) {
      const recvRes = await fetch(
        `${SUPA_URL}/rest/v1/messages?conversation_id=eq.${convId}&type=eq.payment_sent&sender_id=neq.${userId}&select=*&limit=100&order=created_at.desc`,
        { headers }
      )
      const recvRows: any[] = recvRes.ok ? await recvRes.json() : []
      for (const msg of recvRows) {
        // Same rule as sends: no real tx_hash means no real on-chain transfer,
        // so don't fabricate a "completed" receive activity for it.
        if (!msg.tx_hash) continue
        const txHash = `recv_${msg.tx_hash}`
        if (!msg.payment_amount || existingHashes.has(txHash)) continue
        existingHashes.add(txHash)
        // Get sender wallet address
        let fromAddress: string | undefined
        let fromUsername: string | undefined
        try {
          const sRes = await fetch(`${SUPA_URL}/rest/v1/users?id=eq.${msg.sender_id}&select=wallet_address,username`, { headers })
          const sData: any[] = sRes.ok ? await sRes.json() : []
          fromAddress = sData[0]?.wallet_address
          fromUsername = sData[0]?.username
        } catch {}
        await saveActivity({
          walletAddress: addr, userId, txHash,
          activityType: 'receive', amount: msg.payment_amount,
          tokenSymbol: msg.token_symbol || 'USDC', status: 'completed',
          counterpartyAddress: fromAddress,
          metadata: { backfilled: true, fromUsername },
        }).catch(() => {})
      }
    }
  } catch {}
}
