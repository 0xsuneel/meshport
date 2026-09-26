// supabase/functions/activity-consumer/decide.ts
//
// The PURE half of the chain_events -> activity consumer.
//
// Given one chain_event plus the database facts about it, decide whether it
// becomes an `activity` receive row — and if so, exactly which row. No database
// access, no Deno APIs, no imports, so scripts/verify-activity-consumer.ts can
// assert the entire rule set under plain tsx.
//
// ── Why these rules are re-applied HERE rather than trusted from the indexer ──
// The indexer's scanner.ts applies only: recipient is a known wallet, sender is
// not the recipient, amount > 0, and (on the log paths) sender is not the zero
// address. It deliberately does NOT apply Fix C's internal-contract exclusion —
// that lives in compare.ts and runs at COMPARISON time, not emit time. So
// `chain_events` legitimately contains rows that must never become deposits.
//
// Verified on live data: event sender=0xbbd70b01… (Kit Adapter, which swaps
// route through) for a registered wallet, with NO recv_ row and an existing
// activity row of type 'swap'. A consumer that trusted the indexer's filters
// alone would have credited that swap's output leg as an external deposit and
// fired a spurious "Payment Received" alongside the correct "Swap Complete".
// That is the precise bug Fix C and deposit-scan-all's swap suppression exist
// to prevent, so both are reproduced below.
//
// Every rule here mirrors deposit-scan-all's native/log candidate loops. If one
// of them changes there, it must change here, or the two will disagree about
// what a deposit is and the shadow comparison will report it as a discrepancy.

/**
 * Mirrors KNOWN_INTERNAL_CONTRACTS in deposit-scan-all/index.ts and
 * compare.ts — kept as its own local copy (not an import of
 * supabase/functions/_shared/knownInternalContracts.ts) specifically so
 * this file's own "no imports" guarantee holds, per the file header above.
 *
 * Multicall3 (0xca11bde05977b3631167028862be2a173976ca11, BulkPay's route)
 * was ADDED to _shared/knownInternalContracts.ts (see that file's own
 * provenance comment, tx 0x435d804c…) but this local copy was never
 * updated to match — a real, live gap: production `activity` rows confirm
 * it, e.g. tx 0xac28f48b… and 0x22b268c5… (BulkPay self-sends, both dated
 * 2026-08-30/31, both AFTER the shared list was fixed) each got a correct
 * pair of `bulk` rows from BulkPayoutPage.tsx PLUS a spurious THIRD
 * `receive` row from this consumer, sender = Multicall3, because this set
 * didn't contain it yet. Added now to close that gap. If this list changes
 * again, _shared/knownInternalContracts.ts, deposit-scan-all/index.ts,
 * compare.ts and this file all need the same update — see this repo's own
 * "kept in sync manually" note on that shared file for why it isn't a
 * single import here.
 */
export const KNOWN_INTERNAL_CONTRACTS: ReadonlySet<string> = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // Kit Bridge Contract testnet
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', // Kit Adapter Contract testnet — swaps route through this
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter
  '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3 — BulkPay routes through this
])

const ZERO_ADDRESS = '0x' + '0'.repeat(40)

/** Event types that can represent an incoming external credit. */
export const CREDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'deposit_detected',   // native USDC, plain or wrapper-routed (via 0xffff…fffe)
  'transfer_detected',  // ERC-20: EURC / cirBTC
])

/**
 * Only `confirmed` events may be credited.
 *
 * `pending` can still be reorged away, and crediting it would put a deposit in
 * a user's history that never happened. `reorged` is explicitly not real. Arc
 * runs confirmationDepth 0, so the confirmed transition is fast and this costs
 * effectively no latency.
 */
export const CREDITABLE_STATUS = 'confirmed'

/**
 * How old an event must be before it is eligible.
 *
 * Swap and P2P legs are written to `activity` by the CLIENT (api/swap-proxy.js's
 * recordSwapActivity, the P2P paths), and the indexer can publish its
 * chain_event before that write lands. Without a settle delay this consumer
 * could win that race and create an "External deposit" row for a swap output
 * before the 'swap' row exists to suppress it — and once created it cannot be
 * un-created. 30s is comfortably longer than the observed client write latency
 * and well inside deposit-scan-all's own SWAP_GRACE_SECONDS window of 45s.
 */
export const MIN_EVENT_AGE_MS = 30_000

/** Mirrors deposit-scan-all's SWAP_GRACE_SECONDS. */
export const SWAP_GRACE_SECONDS = 45

export interface ChainEventRow {
  id: number
  chain_id: string
  event_type: string
  tx_hash: string | null
  wallet_address: string | null
  assets: string[] | null
  metadata: Record<string, unknown> | null
  status: string
  created_at: string
}

/** Database facts the impure caller must supply for this event. */
export interface EventFacts {
  /** Recipient appears in `users` — the registered-wallet rule. */
  isRegisteredWallet: boolean
  /**
   * ANY activity row already exists for this wallet under this tx hash, in
   * either the plain or `recv_`-prefixed form, regardless of activity_type.
   * Mirrors claim-recovery-scan's existsActivityForTxHash: a swap / p2p / bulk /
   * claim row under the same hash means the movement is already accounted for.
   */
  hasAnyActivityForTxHash: boolean
  /** Recent swap outputs for this wallet, for the quiet-notification rule. */
  recentSwapOutputs?: Array<{ token: string; amount: number }>
}

export interface ActivityRowToInsert {
  wallet_address: string
  tx_hash: string
  activity_type: 'receive'
  amount: number
  usd_value: number
  token_symbol: string
  counterparty_address: string
  explorer_url: string
  metadata: { recovered: false; note: string; source: 'activity-consumer'; chain_event_id: number }
}

export type Decision =
  | { action: 'credit'; row: ActivityRowToInsert; quiet: boolean }
  | { action: 'skip'; reason: string }

/** 1 % relative tolerance with a small absolute floor — mirrors matchesRecentSwapOutput. */
export function matchesRecentSwapOutput(
  outputs: Array<{ token: string; amount: number }> | undefined,
  token: string,
  amount: number,
): boolean {
  if (!outputs) return false
  return outputs.some(o => o.token === token && Math.abs(o.amount - amount) <= Math.max(0.01, amount * 0.01))
}

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/**
 * Read the human-units amount the indexer already computed.
 *
 * scanner.ts divides by the correct decimals before emitting (1e18 for native
 * USDC on both the plain and wrapper paths, token.decimals for ERC-20s), so
 * metadata.amount is ALREADY human-readable. Re-dividing here would silently
 * under-credit by 10^18. This is the single most dangerous place to get wrong,
 * which is why it reads one field and does no arithmetic.
 */
function readAmount(metadata: Record<string, unknown> | null): number | null {
  const raw = metadata?.amount
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** Asset symbol: assets[0], falling back to USDC for native deposits. */
function readAsset(event: ChainEventRow): string {
  const a = event.assets
  if (Array.isArray(a) && a.length > 0 && typeof a[0] === 'string' && a[0]) return a[0]
  return event.event_type === 'deposit_detected' ? 'USDC' : ''
}

/**
 * Decide whether one chain_event becomes an activity receive row.
 *
 * Total and pure: every path returns either 'credit' with a fully-formed row or
 * 'skip' with a machine-readable reason. It never throws, so one malformed row
 * cannot stop a pass.
 */
export function decideActivityRow(
  event: ChainEventRow,
  facts: EventFacts,
  explorerBase: string,
  now = Date.now(),
): Decision {
  // ── Shape / eligibility ──────────────────────────────────────────────────
  if (!CREDIT_EVENT_TYPES.has(event.event_type)) {
    return { action: 'skip', reason: `event_type '${event.event_type}' is not a credit event` }
  }
  if (event.status !== CREDITABLE_STATUS) {
    return { action: 'skip', reason: `status '${event.status}' is not '${CREDITABLE_STATUS}'` }
  }
  const txHash = lower(event.tx_hash)
  if (!txHash) return { action: 'skip', reason: 'missing tx_hash' }

  const wallet = lower(event.wallet_address)
  if (!wallet) return { action: 'skip', reason: 'missing wallet_address' }

  // Settle delay — let a client-written swap/p2p row land first.
  const created = Date.parse(event.created_at ?? '')
  if (!Number.isFinite(created)) {
    return { action: 'skip', reason: 'unparseable created_at' }
  }
  if (now - created < MIN_EVENT_AGE_MS) {
    return { action: 'skip', reason: `event younger than ${MIN_EVENT_AGE_MS}ms settle delay` }
  }

  // ── Acceptance rules, mirroring deposit-scan-all ──────────────────────────
  if (!facts.isRegisteredWallet) {
    return { action: 'skip', reason: 'recipient is not a registered MeshPort wallet' }
  }

  const sender = lower(event.metadata?.sender ?? event.metadata?.from)
  // A missing sender is tolerated but NOT credited: without it neither the Fix C
  // exclusion nor the self-transfer check can be evaluated, and guessing would
  // bypass both.
  if (!sender) return { action: 'skip', reason: 'missing metadata.sender — cannot apply Fix C / self-transfer rules' }

  if (sender === ZERO_ADDRESS) {
    // A zero-address sender is a MINT — a CCTP claim arriving. claim-worker and
    // claim-recovery-scan own that lifecycle; crediting it here would create a
    // second row for a claim and could be mistaken for an ordinary deposit.
    return { action: 'skip', reason: 'zero-address sender (CCTP mint) — owned by claim-worker' }
  }
  if (KNOWN_INTERNAL_CONTRACTS.has(sender)) {
    // FIX C. This is the rule that live data proved necessary: swaps route
    // through the Kit Adapter, and its output leg is already a 'swap' row.
    return { action: 'skip', reason: `internal-contract sender ${sender} (Fix C exclusion)` }
  }
  if (sender === wallet) {
    return { action: 'skip', reason: 'self-transfer — no net credit' }
  }

  const amount = readAmount(event.metadata)
  if (amount === null) {
    return { action: 'skip', reason: 'missing or non-positive metadata.amount' }
  }

  const asset = readAsset(event)
  if (!asset) return { action: 'skip', reason: 'cannot determine asset symbol' }

  // Already accounted for under this hash, in ANY activity type — swap, p2p,
  // bulk, claim, or a receive row a prior pass (or deposit-scan-all) wrote.
  if (facts.hasAnyActivityForTxHash) {
    return { action: 'skip', reason: 'activity row already exists for this tx hash' }
  }

  // ── Quiet rule: record fully, suppress the notification ──────────────────
  // HomePage.tsx's fireIfReceived() only notifies when metadata.note is EXACTLY
  // 'External deposit', so the note string is what suppresses the alert. The row
  // is still written, so balance and history stay correct.
  const quiet = matchesRecentSwapOutput(facts.recentSwapOutputs, asset, amount)

  return {
    action: 'credit',
    quiet,
    row: {
      wallet_address: wallet,
      // Same identity key deposit-scan-all uses, so the unique index on
      // (tx_hash, wallet_address) makes both producers converge on ONE row.
      tx_hash: `recv_${txHash}`,
      activity_type: 'receive',
      amount,
      usd_value: amount,
      token_symbol: asset,
      counterparty_address: sender,
      explorer_url: `${explorerBase}/tx/${txHash}`,
      metadata: {
        recovered: false,
        note: quiet ? 'External deposit (near a swap)' : 'External deposit',
        source: 'activity-consumer',
        chain_event_id: event.id,
      },
    },
  }
}
