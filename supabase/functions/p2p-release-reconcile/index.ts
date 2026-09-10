// supabase/functions/p2p-release-reconcile/index.ts
//
// Scheduled repair for P2P trades stranded mid-release.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Releasing escrowed USDC is two steps: the app claims the trade
// ('payment_sent' -> 'released') so no second caller can release the same
// funds, then it moves the money on-chain. If the process dies in between —
// the tab is closed, the connection drops, the compensating write is
// rejected — the trade is left saying 'released' with released_at NULL and
// no transaction, and its offer stays pinned by locked_by_trade_id forever.
// releaseTrade() now compensates on every path it can reach, but it cannot
// compensate for code that never runs.
//
// The browser sweep in p2pService.reconcileStuckReleases() repairs this too,
// but only when someone opens the P2P page. That is not a guarantee: the
// seller may never return, may be offline, may have uninstalled. Money owed
// to a buyer cannot depend on the counterparty's browsing habits. This
// function is the reliable path; the browser sweep stays as a fast fallback.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// This function NEVER sends a transaction and never moves USDC. It only ever
// writes p2p_trades.status / released_at / completed_at / cancel_reason and
// clears p2p_offers.locked_by_trade_id. The escrow contract is read-only here
// (eth_call), and the decision is made by the shared policy in
// _shared/stuckReleasePolicy.ts, whose rule is that "unknown" is never
// treated as "zero" — every unreadable probe yields 'investigate', which
// changes nothing and leaves the trade for a human.
//
// ── Conventions ─────────────────────────────────────────────────────────────
// Follows claim-recovery-scan/index.ts: authenticated-only Arc RPC endpoints,
// the same getServiceRoleKey() fallback chain, the same CORS/json helpers.
// Invoked by pg_cron via net.http_post, exactly like activity-consumer and
// deposit-scan-all (see cron.job).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  classifyStuckRelease, STUCK_RELEASE_GRACE_MS,
  parseActivationCutoff, isEligibleForReconcile,
} from '../_shared/stuckReleasePolicy.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Same reasoning as claim-worker/claim-recovery-scan: legacy secret name first
// (verified working), the newer SUPABASE_SECRET_KEYS shape as a fallback, and a
// clear error rather than a silent crash if neither is present.
function getServiceRoleKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw)
      const candidate = parsed?.service_role ?? parsed?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(parsed ?? {})[0]
      if (typeof candidate === 'string' && candidate) return candidate
    } catch (e) {
      console.error('[p2p-release-reconcile] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }
  throw new Error('No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

// Authenticated-only Arc endpoints — same list and same reasoning as
// claim-recovery-scan: no public gateways, so a scan can never silently fall
// through to an unauthenticated node with different data or rate limits.
const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
]

// The escrow contract the app currently writes to. Must match
// VITE_P2P_ESCROW_CONTRACT. Set P2P_ESCROW_CONTRACT as a project secret.
const ESCROW_CONTRACT = (Deno.env.get('P2P_ESCROW_CONTRACT') ?? '').trim().toLowerCase()
// Optional: previously deployed escrow contracts, comma separated. Offers
// created before a redeploy still hold funds in the older contract, so a
// reconciler that only knows the current one would read 0 for them and
// wrongly conclude "never funded". Both known contracts are checked and the
// answers combined conservatively.
const ESCROW_CONTRACTS_LEGACY = (Deno.env.get('P2P_ESCROW_CONTRACTS_LEGACY') ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

const USDC_DECIMALS = 18   // native USDC on Arc

// ── V2 selectors (the CURRENT contract, P2PMeshportEscrowV2.sol) ───────────
// tradeReleased(bytes32) does NOT exist on V2 — that boolean mapping was
// replaced by the full Trade struct. getTrade(bytes32) is read instead, and
// this reconciler derives "was it released" from the trade's `state` field
// (index 4 of the 9-word tuple: offerKey, seller, buyer, amount, state,
// investigatedApproveRelease, frozenBy, investigatedBy, resolvedBy).
// State 4 = Released (buyer paid, either via normal release() or an
// admin-resolved dispute); anything else determinable is NOT a release —
// including state 5 (Refunded), which sent funds back to the seller instead,
// the opposite of what classifyStuckRelease's 'finalize' verdict means.
const SELECTOR_GET_TRADE_V2   = '0xa3b13799'  // getTrade(bytes32)
const TRADE_STATE_RELEASED_V2 = 4
const SELECTOR_GET_REMAINING  = '0x9cb589ac'  // getRemaining(bytes32) — signature unchanged from legacy, still valid on V2

// ── Legacy selectors (any address in P2P_ESCROW_CONTRACTS_LEGACY) ──────────
// Pre-hardening contracts (P2PMeshportEscrow.sol and earlier) DO have a
// plain `mapping(bytes32 => bool) public tradeReleased`, and their offerKey
// was NOT seller-bound (see escrowKeyLegacy below) — both genuinely
// different shapes from V2, which is exactly why this reconciler must not
// use one selector/key scheme for every configured contract address.
const SELECTOR_TRADE_RELEASED_LEGACY = '0x8deade26'  // tradeReleased(bytes32)

// ── Activation boundary ─────────────────────────────────────────────────────
// P2P_RECONCILE_AFTER is an ISO timestamp. Only trades created STRICTLY after it
// are eligible. Unset or unparseable => the function is DORMANT and repairs
// nothing, so scheduling the cron before deciding the cutoff is inert rather
// than destructive. No date is hardcoded here on purpose: the operator sets it
// to the moment they activate, and it is echoed in every response.
const RECONCILE_AFTER_RAW = Deno.env.get('P2P_RECONCILE_AFTER') ?? ''
// Independent second guard: individually quarantined trade ids, comma separated.
// Belt and braces — a trade named here is skipped even if the timestamp is set
// wrongly.
const SKIP_TRADE_IDS = (Deno.env.get('P2P_RECONCILE_SKIP_TRADE_IDS') ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
// Optional shared secret, checked in addition to Supabase's own JWT
// verification (which is on by default for edge functions). Defence in depth:
// if verify_jwt were ever disabled by mistake, this still refuses anonymous
// callers. Never hardcode it — read from project secrets only.
const RECONCILE_SECRET = Deno.env.get('P2P_RECONCILE_SECRET') ?? ''

async function rpcCallSingle(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`)
  const respJson = await res.json()
  if (respJson.error) throw respJson.error
  return respJson.result
}

/** eth_call across the authenticated endpoints; null if none could answer. */
async function ethCall(to: string, data: string): Promise<string | null> {
  if (ARC_RPCS.length === 0) return null
  const results = await Promise.allSettled(
    ARC_RPCS.map(url => rpcCallSingle(url, 'eth_call', [{ to, data }, 'latest'])),
  )
  for (const r of results) {
    if (r.status === 'fulfilled' && typeof r.value === 'string' && r.value !== '0x') return r.value
  }
  return null
}

/**
 * offerKey for the CURRENT (V2) contract — seller-bound, matching
 * offerKeyFor() in src/lib/p2pEscrowContract.ts exactly:
 * keccak256(abi.encode(string, address)). Required for sell-offer trades
 * (the offer's own bucket); buy-offer trades use tradeKeyPlain instead
 * (their bucket is keyed by the trade's own id, never seller-bound — see
 * depositForTrade's own reasoning in p2pProviders.ts, unchanged by the V2
 * hardening).
 */
async function offerKeyV2(offerId: string, sellerWallet: string): Promise<string> {
  const { keccak256, encodeAbiParameters } = await import('npm:viem@2')
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }],
    [offerId, sellerWallet.toLowerCase() as `0x${string}`],
  ))
}

/** tradeKey — unchanged by the V2 hardening on either contract generation: plain keccak256(toHex(id)), never seller-bound. Used for V2 getTrade() lookups and for buy-offer trade-keyed escrow buckets on either contract generation. */
async function tradeKeyPlain(id: string): Promise<string> {
  const { keccak256, toHex } = await import('npm:viem@2')
  return keccak256(toHex(id))
}

/** offerKey for a LEGACY (pre-hardening) contract — plain keccak256(toHex(id)), NOT seller-bound. This is deliberately the same computation as tradeKeyPlain; kept as a separate name so call sites read correctly regardless of which one two identical implementations happen to share. */
const offerKeyLegacy = tradeKeyPlain

/**
 * Did this trade's release happen on-chain? Checks the CURRENT (V2)
 * contract via getTrade()'s state field, and every LEGACY contract via its
 * old tradeReleased() mapping — each with ITS OWN correct selector/key
 * shape, never mixed. Returns null if NO contract could be read — never
 * false-on-error, because "unknown" must not become "not released".
 */
async function probeTradeReleased(tradeId: string): Promise<boolean | null> {
  let anyAnswered = false

  if (ESCROW_CONTRACT) {
    const key = (await tradeKeyPlain(tradeId)).slice(2)
    const raw = await ethCall(ESCROW_CONTRACT, SELECTOR_GET_TRADE_V2 + key).catch(() => null)
    if (raw !== null && raw.length >= 2 + 64 * 5) {
      anyAnswered = true
      // Word index 4 (0-based) of the ABI-encoded tuple — offerKey(0),
      // seller(1), buyer(2), amount(3), state(4).
      const hex = raw.slice(2)
      const stateWord = hex.slice(4 * 64, 4 * 64 + 64)
      const state = Number(BigInt('0x' + stateWord))
      if (state === TRADE_STATE_RELEASED_V2) return true
      // Any other determinable state (Active/Frozen/Investigated/Refunded/
      // None) is definitively NOT "buyer was paid via release" — but don't
      // return false yet, a legacy contract might still say true for an
      // older trade this reconciler also needs to check.
    }
  }

  for (const contract of ESCROW_CONTRACTS_LEGACY) {
    const key = (await offerKeyLegacy(tradeId)).slice(2)
    const raw = await ethCall(contract, SELECTOR_TRADE_RELEASED_LEGACY + key).catch(() => null)
    if (raw === null) continue
    anyAnswered = true
    if (BigInt(raw) === 1n) return true
  }

  return anyAnswered ? false : null
}

/**
 * Escrow still held under this trade's bucket, summed across the current
 * and every legacy contract. `sellerWallet` is required for sell-offer
 * trades on the CURRENT contract (seller-bound key) — pass '' for
 * buy-offer trades, where the bucket is the trade's own plain key on every
 * contract generation. Returns null if none could be read.
 */
async function probeEscrowRemaining(tradeId: string, offerId: string, isBuyOffer: boolean, sellerWallet: string): Promise<number | null> {
  let total = 0
  let anyAnswered = false

  if (ESCROW_CONTRACT) {
    const key = isBuyOffer
      ? (await tradeKeyPlain(tradeId)).slice(2)
      : (await offerKeyV2(offerId, sellerWallet)).slice(2)
    const raw = await ethCall(ESCROW_CONTRACT, SELECTOR_GET_REMAINING + key).catch(() => null)
    if (raw !== null) {
      anyAnswered = true
      total += Number(BigInt(raw)) / 10 ** USDC_DECIMALS
    }
  }

  for (const contract of ESCROW_CONTRACTS_LEGACY) {
    const escrowKeyId = isBuyOffer ? tradeId : offerId
    const key = (await offerKeyLegacy(escrowKeyId)).slice(2)
    const raw = await ethCall(contract, SELECTOR_GET_REMAINING + key).catch(() => null)
    if (raw === null) continue
    anyAnswered = true
    total += Number(BigInt(raw)) / 10 ** USDC_DECIMALS
  }

  return anyAnswered ? total : null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Auth. Supabase verifies the JWT ahead of this handler by default (the cron
  // job sends the service-role bearer), so reaching here already implies an
  // authorized caller. This optional secret is a second, independent gate for
  // the case where verify_jwt has been turned off.
  if (RECONCILE_SECRET) {
    const provided = req.headers.get('x-reconcile-secret') ?? ''
    if (provided !== RECONCILE_SECRET) {
      console.error('[p2p-release-reconcile] rejected: bad or missing x-reconcile-secret')
      return json({ ok: false, error: 'unauthorized' }, 401)
    }
  }

  const started = Date.now()
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Dry-run support: `{"dryRun": true}` classifies and reports without writing.
  let dryRun = false
  try {
    const body = await req.json().catch(() => ({}))
    dryRun = body?.dryRun === true
  } catch { /* no body — normal cron invocation */ }

  const cutoffMs = parseActivationCutoff(RECONCILE_AFTER_RAW)
  if (cutoffMs === null) {
    // Dormant by design. Scheduling the cron without setting the cutoff must do
    // nothing at all rather than sweep historical trades.
    console.warn('[p2p-release-reconcile] DORMANT — P2P_RECONCILE_AFTER is not set; no trades will be touched.')
    return json({
      ok: true, dormant: true, reason: 'P2P_RECONCILE_AFTER is not set',
      scanned: 0, eligible: 0, outcomes: [], ms: Date.now() - started,
    })
  }

  const graceCutoffIso = new Date(Date.now() - STUCK_RELEASE_GRACE_MS).toISOString()

  // The stuck signature. A completed release always writes released_at, so this
  // cannot match a healthy trade. Bounded by the activation cutoff in SQL too,
  // so historical rows are not even fetched.
  const { data: stuck, error } = await supabase
    .from('p2p_trades')
    .select('id, offer_id, offer_type, amount_usdc, buyer_wallet, seller_wallet, tx_hash, status, released_at, completed_at, created_at')
    .eq('status', 'released')
    .is('released_at', null)
    .lt('created_at', graceCutoffIso)
    .gt('created_at', new Date(cutoffMs).toISOString())
    .limit(50)

  if (error) {
    console.error('[p2p-release-reconcile] query failed:', error.message)
    return json({ ok: false, error: error.message }, 500)
  }
  if (!stuck || stuck.length === 0) {
    return json({
      ok: true, scanned: 0, eligible: 0, outcomes: [], dryRun,
      activationCutoff: new Date(cutoffMs).toISOString(), ms: Date.now() - started,
    })
  }

  const outcomes: Array<Record<string, unknown>> = []
  const nowMs = Date.now()

  for (const t of stuck) {
    // Re-apply the SAME pure gate the client uses, even though SQL already
    // bounded the query — the skip list lives here, and a single shared gate
    // means the two paths cannot diverge on what is in scope.
    const gate = isEligibleForReconcile({
      tradeId: t.id, createdAtIso: String(t.created_at),
      cutoffMs, graceMs: STUCK_RELEASE_GRACE_MS, nowMs, skipTradeIds: SKIP_TRADE_IDS,
    })
    if (!gate.eligible) {
      console.log('[p2p-release-reconcile]', t.id, 'SKIPPED —', gate.reason)
      outcomes.push({ tradeId: t.id, verdict: 'skipped', reason: gate.reason, applied: false })
      continue
    }

    const amountUsdc = Number(t.amount_usdc ?? 0)

    const [onChainReleased, escrowRemaining] = await Promise.all([
      probeTradeReleased(t.id),
      probeEscrowRemaining(t.id, t.offer_id, t.offer_type === 'buy', String(t.seller_wallet ?? '')),
    ])

    let everDeposited = Boolean(t.tx_hash)
    if (t.offer_type !== 'buy') {
      const { data: offer } = await supabase
        .from('p2p_offers').select('escrow_deposit_tx_hash').eq('id', t.offer_id).maybeSingle()
      everDeposited = Boolean(offer?.escrow_deposit_tx_hash)
    }

    const { verdict, reason } = classifyStuckRelease({
      onChainReleased, escrowRemaining, everDeposited, amountUsdc,
    })

    let applied = false
    if (!dryRun && verdict !== 'investigate') {
      const now = new Date().toISOString()
      if (verdict === 'finalize') {
        // tx_hash is deliberately left alone: the release provably happened but
        // we do not know which transaction did it, and inventing one would be
        // worse than leaving it blank.
        const { error: e1 } = await supabase.from('p2p_trades')
          .update({ status: 'completed', released_at: now, completed_at: now }).eq('id', t.id)
        applied = !e1
        if (applied) await supabase.from('p2p_offers').update({ locked_by_trade_id: null }).eq('id', t.offer_id)
      } else if (verdict === 'restore') {
        const { error: e2 } = await supabase.from('p2p_trades')
          .update({ status: 'payment_sent' }).eq('id', t.id)
        applied = !e2
        // Offer stays locked on purpose — the trade is live again.
      } else if (verdict === 'cancel') {
        const { error: e3 } = await supabase.from('p2p_trades')
          .update({ status: 'cancelled', cancel_reason: 'Escrow was never funded — release could not be completed' })
          .eq('id', t.id)
        applied = !e3
        if (applied) await supabase.from('p2p_offers').update({ locked_by_trade_id: null }).eq('id', t.offer_id)
      }
    }

    console.log('[p2p-release-reconcile]', t.id, verdict, dryRun ? '(dry run)' : applied ? 'applied' : 'not applied', '—', reason)
    outcomes.push({
      tradeId: t.id, offerId: t.offer_id, amountUsdc, verdict, reason, applied,
      probe: { onChainReleased, escrowRemaining, everDeposited },
    })
  }

  return json({
    ok: true, scanned: stuck.length,
    eligible: outcomes.filter(o => o.verdict !== 'skipped').length,
    activationCutoff: new Date(cutoffMs).toISOString(),
    skipped: SKIP_TRADE_IDS.length,
    dryRun, outcomes, ms: Date.now() - started,
  })
})
