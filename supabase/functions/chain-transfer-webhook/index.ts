// supabase/functions/chain-transfer-webhook/index.ts
//
// Real-time Receive detection via Circle Contracts Event Monitoring.
// Circle POSTs here the instant a Transfer event is mined on a watched
// token contract (USDC/EURC/cirBTC on Arc). Full reasoning, setup steps,
// and known limitations: see docs/CHAIN_TRANSFER_WEBHOOK_SETUP.md.
//
// claim-recovery-scan, activity-consumer, and blockchain-indexer are all
// left untouched and still run as the backstop for anything this misses.
//
// Every request is signature-verified against Circle's own public key
// (ECDSA_SHA_256) against the RAW body bytes before being trusted.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
// deno-lint-ignore no-node-globals
import { createVerify, createPublicKey, type KeyObject } from 'node:crypto'
import { isKnownInternalContract } from '../_shared/knownInternalContracts.ts'
import { findCorrelatedTrackedFeature } from '../_shared/trackedFeatureCorrelation.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-circle-signature, x-circle-key-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

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
      console.error('[chain-transfer-webhook] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }
  throw new Error('No Supabase service role key found - checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()
// Separate Circle secret from any CCTP-related Circle usage elsewhere.
const CIRCLE_API_KEY = Deno.env.get('CIRCLE_API_KEY') ?? ''

const ARC_EXPLORER = 'https://testnet.arcscan.app'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)

// Same contracts/decimals as claim-recovery-scan's own token list. USDC's
// log-based amount is 6 decimals (ERC-20 view convention), not 18.
const WATCHED_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC',   decimals: 6 },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a':  { symbol: 'EURC',   decimals: 6 },
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf':  { symbol: 'cirBTC', decimals: 8 },
}

const P2P_ESCROW_CONTRACT = (Deno.env.get('P2P_ESCROW_CONTRACT') ?? '').trim().toLowerCase()
const P2P_ESCROW_CONTRACTS_LEGACY = (Deno.env.get('P2P_ESCROW_CONTRACTS_LEGACY') ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const KNOWN_INTERNAL_EXTRA = [P2P_ESCROW_CONTRACT, ...P2P_ESCROW_CONTRACTS_LEGACY].filter(Boolean)

// ── Multichain Claim completion via this same live webhook ──────────────────
// USDC's event monitor has been live since 2026-08-30 (see
// docs/CHAIN_TRANSFER_WEBHOOK_SETUP.md) and already receives every Transfer
// on Arc's USDC contract, mints included - the `isMint` branch below was
// simply discarding that data instead of using it, deferring entirely to
// claim-worker/claim-recovery-scan's own RPC-based polling. Diagnosed this
// session: that polling's configured RPC provider was silently missing real,
// confirmed mints (eth_getLogs returning empty while a fresh public endpoint
// and Arc's own explorer both showed the transfer) - claim-worker kept
// retrying against the same blind provider for the full 40-minute settling
// window before giving up. This webhook is not subject to that bug at all:
// Circle's own indexer is the one watching the chain, not this app's RPC
// config, so it sees the mint the moment it confirms regardless of whatever
// state that provider is in.
//
// Match by wallet_address + fee-tolerant amount band - the exact same
// heuristic claim-worker's own findIncomingMintByAmount fallback already
// uses (claim-worker/index.ts), not a new/riskier one: CCTP/relay fees only
// ever reduce the minted amount versus what was claimed, so a real match is
// always in [70% of claimed, claimed + 0.1% rounding slack]. Deliberately
// also matches recently-`failed` claims (not just active ones) - this is
// exactly the scenario from this session's diagnosis: a claim that already
// timed out and shows "Failed" in Activity, even though the money arrived
// (just too late for claim-worker's own blind polling to see it in time).
const CHAIN_EXPLORER: Record<string, string> = {
  Ethereum_Sepolia:    'https://sepolia.etherscan.io',
  Base_Sepolia:        'https://sepolia.basescan.org',
  Arbitrum_Sepolia:    'https://sepolia.arbiscan.io',
  Optimism_Sepolia:    'https://sepolia-optimism.etherscan.io',
  Polygon_Sepolia:     'https://amoy.polygonscan.com',
  Avalanche_Fuji:      'https://testnet.snowtrace.io',
  Unichain_Sepolia:    'https://sepolia.uniscan.xyz',
  HyperEVM_Testnet:    'https://explore-testnet.hyperpc.app',
  Sei_Testnet:         'https://testnet.seiscan.io',
  Sonic_Testnet:       'https://testnet.sonicscan.org',
  World_Chain_Sepolia: 'https://sepolia.worldscan.org',
  Linea_Sepolia:       'https://sepolia.lineascan.build',
  Ink_Testnet:         'https://explorer-sepolia.inkonchain.com',
  XDC_Apothem:         'https://testnet.xdcscan.com',
  Injective_Testnet:   'https://testnet.explorer.injective.network',
  Plume_Testnet:       'https://testnet-explorer.plume.org',
  Monad_Testnet:       'https://monad-testnet.socialscan.io',
  Morph_Testnet:       'https://explorer-hoodi.morph.network',
}

// Tolerates a mis-set secret (e.g. the whole 'supabase secrets set …' line
// pasted as the value): use the first http(s) origin found, else the default.
const APP_BASE_URL = (() => {
  const raw = (Deno.env.get('APP_BASE_URL') || '').trim()
  const m = /https?:\/\/[^\s/'"]+/i.exec(raw)
  return m ? m[0] : 'https://meshport.xyz'
})()
const PUSH_INTERNAL_SECRET = (Deno.env.get('PUSH_INTERNAL_SECRET') || '').trim()

// Same server-side push claim-worker's own notifyClaimComplete sends -
// duplicated rather than shared across function boundaries (this repo's
// existing pattern: claim-recovery-scan already keeps its own independent
// copy of RPC/log helpers rather than importing claim-worker's). Best-effort
// only: a failed push never blocks or reverses the claim completion itself.
async function notifyClaimComplete(
  supabase: SupabaseClient, walletAddress: string, sourceChain: string, claimId: string, amount: number,
): Promise<void> {
  if (!PUSH_INTERNAL_SECRET) return
  try {
    const { data: user } = await supabase
      .from('users').select('id').eq('wallet_address', walletAddress.toLowerCase()).maybeSingle()
    if (!user?.id) return
    // A merchant's claim moves Ledger money to Arc - same wording as the Hub.
    const { data: m } = await supabase.from('merchant_applications').select('status')
      .eq('wallet_address', walletAddress.toLowerCase()).eq('status', 'approved').limit(1)
    const merchant = (m?.length ?? 0) > 0
    const chainLabel = (sourceChain || '').replace(/_Sepolia|_Testnet|_Fuji/g, '').replace(/_/g, ' ')
    await fetch(`${APP_BASE_URL}/api/push?action=send-internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_INTERNAL_SECRET}` },
      body: JSON.stringify({
        userId: user.id,
        ...(merchant
          ? { title: 'Moved to Arc', body: `$${amount.toFixed(2)} USDC from your ${chainLabel} Ledger` }
          : { title: 'Claim Complete', body: `$${amount.toFixed(2)} USDC arrived on Arc from ${chainLabel}` }),
        url:    '/multichain',
        tag:    `claim-complete-${claimId}`,
      }),
    })
  } catch (e) {
    console.warn('[chain-transfer-webhook] notifyClaimComplete failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

// Returns the completed claim's id, or null if no matching claim was found
// (a plain external USDC mint unrelated to any tracked claim - always
// possible, always safe to leave to the existing scan-based backstops).
async function tryCompleteClaimFromMint(
  supabase: SupabaseClient, toAddress: string, mintTxHash: string, mintedAmount: number,
): Promise<string | null> {
  try {
    const { data: candidates, error } = await supabase
      .from('claims')
      .select('id, tx_hash, amount, source_chain, status, wallet_address')
      .eq('wallet_address', toAddress.toLowerCase())
      .in('status', ['bridging', 'verifying', 'settling', 'failed'])
      .order('created_at', { ascending: true })
    if (error) { console.error('[chain-transfer-webhook] claims lookup failed:', error.message); return null }
    if (!candidates?.length) return null

    // ── 2026-09-20 ambiguous-match guard ────────────────────────────────
    // This matches by wallet+amount only, same as claim-worker's own
    // fallback - but unlike claim-worker (fixed this session to try each
    // claim's own CCTP nonce first, and to safely fall through on a
    // write collision), this webhook fires once per mint event with no
    // retry loop and no nonce correlation available here. If TWO claims
    // for the same wallet qualify for the same mint (same amount, both
    // in flight - exactly the scenario that caused claim-worker's stuck-
    // in-settling bug), picking one is a guess: it can silently assign
    // the wrong claim's completion to this mint. The DB's unique
    // constraint on destination_tx_hash prevents actual data corruption,
    // but a wrong guess still leaves the RIGHT claim stuck. Safer to
    // decline and let claim-worker's authoritative nonce-based match
    // (which runs every ~8s regardless) resolve it correctly instead.
    const qualifying: typeof candidates = []
    const mintedRaw = BigInt(Math.round(mintedAmount * 1e6))
    for (const c of candidates) {
      const claimedRaw    = BigInt(Math.round(Number(c.amount) * 1e6))
      const roundingSlack = claimedRaw / 1000n         // 0.1% - rounding only
      const feeFloor       = (claimedRaw * 70n) / 100n // up to 30% fee, generous margin
      if (mintedRaw < feeFloor || mintedRaw > claimedRaw + roundingSlack) continue
      qualifying.push(c)
    }
    if (qualifying.length === 0) return null
    if (qualifying.length > 1) {
      console.warn(
        `[chain-transfer-webhook] ambiguous mint match for ${toAddress}: ${qualifying.length} candidate claims ` +
        `qualify for mint ${mintTxHash} (amount ${mintedAmount}) - [${qualifying.map(c => c.id).join(', ')}]. ` +
        `Declining to guess; leaving for claim-worker's nonce-based match.`
      )
      return null
    }
    // Exactly one qualifying candidate - safe to complete (mirrors the
    // original single-candidate behavior, just without the multi-
    // candidate "pick one" guess).
    const best = qualifying[0]

    // Idempotency + race guard: only write if this claim isn't ALREADY
    // completed (by claim-worker's own polling, or a duplicate webhook
    // delivery). No rows affected here just means someone else already
    // finished it with equally-correct data - a harmless no-op.
    const { data: updated, error: updErr } = await supabase
      .from('claims')
      .update({
        status:              'completed',
        destination_tx_hash: mintTxHash.toLowerCase(),
        arrived_amount:      mintedAmount,
        completed_at:        new Date().toISOString(),
        error:               null,
      })
      .eq('id', best.id)
      .neq('status', 'completed')
      .select('id, tx_hash, amount, source_chain, wallet_address')
      .maybeSingle()
    if (updErr) {
      // A duplicate-key hit here (code 23505 on destination_tx_hash) means
      // claim-worker's own polling already assigned this exact mint tx to
      // a different claim between our SELECT and this UPDATE - not a
      // failure, just a lost race to a source that's equally authoritative.
      // Nothing to correct: whichever writer won has the same, correct data.
      if ((updErr as { code?: string }).code === '23505') {
        console.warn(`[chain-transfer-webhook] lost race to claim-worker for mint ${mintTxHash} on claim ${best.id} - already completed elsewhere`)
      } else {
        console.error('[chain-transfer-webhook] claim completion update failed:', updErr.message)
      }
      return null
    }
    if (!updated) return null

    const base = CHAIN_EXPLORER[updated.source_chain] ?? ARC_EXPLORER
    const burnTxHash = (updated.tx_hash || '').toLowerCase()
    if (burnTxHash) {
      // No ignoreDuplicates here (unlike recordExternalReceive below) -
      // deliberately OVERWRITES an existing row, since the common case this
      // exists for is a stale 'failed' Activity row that needs correcting,
      // not just a fresh insert.
      const { error: actErr } = await supabase
        .from('activity')
        .upsert({
          wallet_address:       updated.wallet_address.toLowerCase(),
          tx_hash:              burnTxHash,
          destination_tx_hash:  mintTxHash.toLowerCase(),
          activity_type:        'claim',
          amount:               mintedAmount,
          usd_value:            mintedAmount,
          arrived_amount:       mintedAmount,
          token_symbol:         'USDC',
          source_chain:         updated.source_chain,
          destination_chain:    'Arc_Testnet',
          status:               'completed',
          explorer_url:         `${base}/tx/${burnTxHash}`,
          metadata:             { claimed_amount: Number(updated.amount), reconciled_from: 'chain-transfer-webhook' },
        }, { onConflict: 'tx_hash,wallet_address' })
      if (actErr) console.error('[chain-transfer-webhook] activity upsert failed:', actErr.message)
    }

    await notifyClaimComplete(supabase, updated.wallet_address, updated.source_chain, updated.id, mintedAmount)
    return updated.id
  } catch (e) {
    console.error('[chain-transfer-webhook] tryCompleteClaimFromMint threw:', e instanceof Error ? e.message : e)
    return null
  }
}

// Signature verification - matches Circle's own Node.js sample from
// developers.circle.com/api-reference/verify-webhook-signatures.
const publicKeyCache = new Map<string, KeyObject>()

async function getCirclePublicKey(keyId: string): Promise<KeyObject> {
  const cached = publicKeyCache.get(keyId)
  if (cached) return cached
  if (!CIRCLE_API_KEY) throw new Error('CIRCLE_API_KEY is not configured')
  const res = await fetch(`https://api.circle.com/v2/notifications/publicKey/${keyId}`, {
    headers: { Authorization: `Bearer ${CIRCLE_API_KEY}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Circle publicKey fetch failed: ${res.status}`)
  const { data } = await res.json()
  const publicKey = createPublicKey({
    key: new Uint8Array(Uint8Array.from(atob(data.publicKey), c => c.charCodeAt(0))),
    format: 'der',
    type: 'spki',
  })
  publicKeyCache.set(keyId, publicKey)
  return publicKey
}

async function verifyCircleSignature(rawBody: string, signature: string, keyId: string): Promise<boolean> {
  try {
    const publicKey = await getCirclePublicKey(keyId)
    const verifier = createVerify('SHA256')
    verifier.update(rawBody)
    return verifier.verify(publicKey, signature, 'base64')
  } catch (e) {
    console.error('[chain-transfer-webhook] signature verification threw:', e instanceof Error ? e.message : e)
    return false
  }
}

interface CircleEventLogNotification {
  notificationType: string
  notification: {
    contractAddress: string
    blockchain: string
    txHash: string
    // Real field name confirmed against live Circle payloads - NOT
    // "eventName" (their own quickstart doc's field name, which never
    // actually appears on the wire; every real notification uses this
    // instead). Getting this wrong silently made every single real
    // Transfer notification fall through to "not a Transfer event" -
    // found and fixed this session by capturing real request bodies.
    eventSignature: string
    topics: string[]
    data: string
  }
}

async function findUserByWallet(supabase: SupabaseClient, address: string) {
  const { data } = await supabase
    .from('users')
    .select('id, username')
    .eq('wallet_address', address.toLowerCase())
    .maybeSingle()
  return data
}

async function recordedRow(supabase: SupabaseClient, walletAddress: string, recvTxHash: string): Promise<{ id: string; created_at: string } | null> {
  const { data } = await supabase
    .from('activity')
    .select('id, created_at')
    .eq('tx_hash', recvTxHash)
    .eq('wallet_address', walletAddress.toLowerCase())
    .maybeSingle()
  return (data as { id: string; created_at: string } | null) ?? null
}

// Returns true only when this call created the row, so a transfer seen by
// both the Circle webhook and the Arc watcher is recorded and pushed once.
async function recordExternalReceive(
  supabase: SupabaseClient,
  walletAddress: string, userId: string | undefined,
  txHash: string, amount: number, fromAddress: string, tokenSymbol: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('activity')
    .upsert({
      wallet_address:       walletAddress.toLowerCase(),
      user_id:              userId,
      tx_hash:              `recv_${txHash.toLowerCase()}`,
      activity_type:        'receive',
      amount,
      usd_value:            amount,
      token_symbol:         tokenSymbol,
      counterparty_address: fromAddress.toLowerCase(),
      explorer_url:         `${ARC_EXPLORER}/tx/${txHash}`,
      metadata:             { recovered: false, note: 'External deposit', source: 'chain-transfer-webhook', receiveKind: 'external_deposit', pushed: true },
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
    .select('id')
  if (error) { console.error('[chain-transfer-webhook] recordExternalReceive failed:', error.message); return false }
  return (data?.length ?? 0) > 0
}

async function notifyExternalReceive(
  supabase: SupabaseClient, userId: string, txHash: string, amount: number, fromAddress: string, tokenSymbol: string,
): Promise<boolean> {
  if (!PUSH_INTERNAL_SECRET) { console.warn('[chain-transfer-webhook] PUSH_INTERNAL_SECRET not set - no receive push'); return false }
  try {
    const sender = await findUserByWallet(supabase, fromAddress)
    const from = sender?.username
      ? `${String(sender.username).replace(/\.arc$/i, '')}.arc`
      : `${fromAddress.slice(0, 6)}…${fromAddress.slice(-4)}`
    const amountStr = String(Number(amount.toFixed(tokenSymbol === 'cirBTC' ? 8 : 6)))
    const res = await fetch(`${APP_BASE_URL}/api/push?action=send-internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_INTERNAL_SECRET}` },
      body: JSON.stringify({
        userId,
        title: 'Received',
        body:  `+${amountStr} ${tokenSymbol} from ${from}`,
        url:   '/activity',
        tag:   `payment-${txHash.toLowerCase()}`,
      }),
      signal: AbortSignal.timeout(8000),
    })
    console.log('[chain-transfer-webhook] receive push:', res.status, await res.text().catch(() => ''))
    return res.ok
  } catch (e) {
    console.warn('[chain-transfer-webhook] receive push failed (non-fatal):', e instanceof Error ? e.message : e)
    return false
  }
}

// ── Catch-up: notify deposits recorded by ANY writer ──────────────────────
// deposit-scan-all / activity-consumer / the app record external deposits
// without sending a push, and Circle's event for a deposit can arrive late
// (or after those writers). Circle calls this function several times a
// second, so at most every SWEEP_EVERY_MS each instance looks for fresh
// external-deposit rows not yet notified, claims them (metadata.pushed) and
// sends the push. The claim is a conditional update, so two instances never
// notify the same deposit.
const SWEEP_EVERY_MS = 10_000
let lastSweepAt = 0

async function sweepUnnotifiedReceives(supabase: SupabaseClient): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_EVERY_MS) return
  lastSweepAt = Date.now()
  try {
    const since = new Date(Date.now() - 15 * 60_000).toISOString()
    const { data: rows, error } = await supabase
      .from('activity')
      .select('id, wallet_address, user_id, tx_hash, amount, token_symbol, counterparty_address, metadata')
      .eq('activity_type', 'receive')
      .eq('status', 'completed')
      .eq('metadata->>receiveKind', 'external_deposit')
      .is('metadata->>pushed', null)
      .gte('created_at', since)
      .limit(20)
    if (error) { console.error('[chain-transfer-webhook] sweep query failed:', error.message); return }
    for (const r of rows ?? []) {
      const { data: claimed } = await supabase
        .from('activity')
        .update({ metadata: { ...(r.metadata as Record<string, unknown> ?? {}), pushed: true } })
        .eq('id', r.id)
        .is('metadata->>pushed', null)
        .select('id')
      if (!claimed?.length) continue
      let userId = r.user_id as string | null
      if (!userId) userId = (await findUserByWallet(supabase, r.wallet_address as string))?.id ?? null
      if (!userId) continue
      const hash = String(r.tx_hash).replace(/^recv_/, '')
      const ok = await notifyExternalReceive(supabase, userId, hash, Number(r.amount), String(r.counterparty_address || ''), String(r.token_symbol || 'USDC'))
      // Not delivered → release the claim so the next pass retries it.
      if (!ok) await supabase.from('activity').update({ metadata: r.metadata ?? {} }).eq('id', r.id)
    }
  } catch (e) {
    console.warn('[chain-transfer-webhook] sweep failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

// ── Shared processing for one verified Transfer to a MeshPort wallet ────────
// Used by the Circle webhook (after signature verification) and by the Arc
// log watcher (logs come straight from Arc's RPC, filtered to MeshPort
// wallets). Every write is idempotent on (tx_hash, wallet_address).
interface TransferIn {
  symbol: string; isMint: boolean; fromAddress: string; toAddress: string
  amount: number; txHash: string
  user?: { id: string; username: string | null } | null
}
async function processTransfer(supabase: SupabaseClient, t: TransferIn): Promise<Record<string, unknown>> {
  const { symbol, isMint, fromAddress, toAddress, amount, txHash } = t
  if (isMint) {
    // A mint (from address(0)) is a CCTP claim or similar system mint, not a
    // generic external deposit - see tryCompleteClaimFromMint's own comment
    // for why matching by wallet+amount here is safe and already-precedented
    // in this codebase. Only USDC claims are tracked.
    if (symbol === 'USDC') {
      const completedClaimId = await tryCompleteClaimFromMint(supabase, toAddress, txHash, amount)
      if (completedClaimId) return { completedClaim: completedClaimId, wallet: toAddress, amount, token: symbol }
    }
    return { ignored: 'mint (from address(0)) - no matching pending/recent-failed claim found' }
  }
  if (fromAddress.toLowerCase() === toAddress.toLowerCase()) return { ignored: 'self-transfer' }
  const user = t.user ?? await findUserByWallet(supabase, toAddress)
  if (!user) return { ignored: 'recipient is not a MeshPort wallet' }

  try {
    // Same three-layer classification claim-recovery-scan already
    // established, in the same order, for the same reasons - see
    // trackedFeatureCorrelation.ts and knownInternalContracts.ts.
    if (isKnownInternalContract(fromAddress, KNOWN_INTERNAL_EXTRA)) {
      return { ignored: 'sender is a known-internal contract (swap/BulkPay/CCTP/P2P escrow)' }
    }
    if (await findCorrelatedTrackedFeature(supabase, 'arc', txHash)) {
      return { ignored: 'tx_hash correlates to a tracked Pay/BulkPay/Swap attempt' }
    }
    if (await recordedRow(supabase, toAddress, `recv_${txHash.toLowerCase()}`)) {
      // Already recorded by a scanner - the catch-up sweep notifies it
      // (exactly once, via its claim).
      lastSweepAt = 0
      await sweepUnnotifiedReceives(supabase)
      return { ignored: 'already recorded (notification handled by the catch-up sweep)' }
    }

    const inserted = await recordExternalReceive(supabase, toAddress, user.id, txHash, amount, fromAddress, symbol)
    if (!inserted) return { ignored: 'already recorded by a concurrent writer' }
    // Phone notification the moment the deposit is seen - works with the
    // app closed. Tag matches the app's in-app mirror (payment-<hash>), so
    // the phone keeps one entry.
    const pushed = await notifyExternalReceive(supabase, user.id, txHash, amount, fromAddress, symbol)
    if (!pushed) {
      // Not delivered - clear the flag so the catch-up sweep retries it.
      await supabase.from('activity')
        .update({ metadata: { recovered: false, note: 'External deposit', source: 'chain-transfer-webhook', receiveKind: 'external_deposit' } })
        .eq('tx_hash', `recv_${txHash.toLowerCase()}`).eq('wallet_address', toAddress.toLowerCase())
    }
    return { recorded: true, wallet: toAddress, amount, token: symbol }
  } catch (e) {
    // Never throw back to Circle (no retry storm) or out of the watcher loop;
    // the scan-based backstops still catch this transfer on their schedule.
    console.error('[chain-transfer-webhook] failed:', e instanceof Error ? e.message : e)
    return { error: e instanceof Error ? e.message : 'unknown error' }
  }
}

// ── Arc log watcher ──────────────────────────────────────────────────────────
// Asks Arc's RPC for Transfer logs whose recipient (topic 2) is a MeshPort
// wallet - the node filters, so only MeshPort transfers come back. Native
// USDC is included: Arc emits a Transfer log for every native USDC movement
// from the system address below (18 decimals), whether it was a plain value
// send or went through the 0x3600… ERC-20 interface. This replaces Circle's
// Event Monitor, which delivers every USDC transfer on Arc (~490k/day).
const NATIVE_USDC_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'
const WATCH_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_USDC_EMITTER]:                         { symbol: 'USDC',   decimals: 18 },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a':  { symbol: 'EURC',   decimals: 6 },
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf':  { symbol: 'cirBTC', decimals: 8 },
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WATCH_CURSOR = 'transfer_watch'
const WATCH_MAX_RANGE = 5000        // Arc RPC caps eth_getLogs ranges (~10k)
const WATCH_FIRST_LOOKBACK = 200    // first run: ~2 minutes of history
const WATCH_WALLET_CHUNK = 200      // recipients per eth_getLogs call
const WATCH_LOOP_MS = 58_000      // covers the whole minute until the next cron run
const WATCH_INTERVAL_MS = 2_000  // Arc makes ~2 blocks a second
const ARC_RPC_URLS = [
  (Deno.env.get('ARC_RPC_URL') ?? '').trim(),
  'https://rpc.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
].filter(Boolean)

async function arcRpc(method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown
  for (const url of ARC_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      const body = await res.json()
      if (body?.error) throw new Error(body.error.message ?? 'rpc error')
      return body.result
    } catch (e) { lastErr = e }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all Arc RPCs failed')
}

const pad32Topic = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** One pass: claim the next block range, fetch MeshPort-bound transfers, process them. */
async function watchPass(supabase: SupabaseClient, wallets: string[]): Promise<number> {
  const latest = parseInt(await arcRpc('eth_blockNumber', []), 16)
  const { data: cur } = await supabase.from('deposit_scan_cursor')
    .select('last_scanned_block').eq('source', WATCH_CURSOR).maybeSingle()
  if (!cur) {
    await supabase.from('deposit_scan_cursor')
      .upsert({ source: WATCH_CURSOR, last_scanned_block: latest - WATCH_FIRST_LOOKBACK }, { onConflict: 'source', ignoreDuplicates: true })
    return 0
  }
  const from = Number(cur.last_scanned_block)
  if (from >= latest) return 0
  const to = Math.min(latest, from + WATCH_MAX_RANGE)
  // Compare-and-swap claim: overlapping runs never scan the same range twice.
  const { data: claimed } = await supabase.from('deposit_scan_cursor')
    .update({ last_scanned_block: to, updated_at: new Date().toISOString() })
    .eq('source', WATCH_CURSOR).eq('last_scanned_block', from).select('source')
  if (!claimed?.length) return 0

  const logs: any[] = []
  try {
    for (let i = 0; i < wallets.length; i += WATCH_WALLET_CHUNK) {
      const recipients = wallets.slice(i, i + WATCH_WALLET_CHUNK).map(pad32Topic)
      logs.push(...await arcRpc('eth_getLogs', [{
        address: Object.keys(WATCH_TOKENS),
        fromBlock: '0x' + (from + 1).toString(16), toBlock: '0x' + to.toString(16),
        topics: [TRANSFER_TOPIC, null, recipients],
      }]) ?? [])
    }
  } catch (e) {
    // Hand the range back so the next pass retries it.
    await supabase.from('deposit_scan_cursor').update({ last_scanned_block: from })
      .eq('source', WATCH_CURSOR).eq('last_scanned_block', to)
    console.error('[chain-transfer-webhook] watch getLogs failed:', e instanceof Error ? e.message : e)
    return 0
  }

  let recorded = 0
  for (const log of logs) {
    const token = WATCH_TOKENS[String(log.address).toLowerCase()]
    if (!token || log.removed) continue
    const fromTopic = String(log.topics?.[1] ?? '')
    const toAddress = '0x' + String(log.topics?.[2] ?? '').slice(-40)
    let amount: number
    try { amount = Number(BigInt(log.data)) / (10 ** token.decimals) } catch { continue }
    if (!Number.isFinite(amount) || amount <= 0) continue
    const out = await processTransfer(supabase, {
      symbol: token.symbol,
      isMint: fromTopic.toLowerCase() === MINT_FROM_TOPIC,
      fromAddress: '0x' + fromTopic.slice(-40),
      toAddress, amount, txHash: String(log.transactionHash),
    })
    if (out.recorded || out.completedClaim) recorded++
  }
  return recorded
}

async function runWatcher(supabase: SupabaseClient): Promise<{ passes: number; recorded: number }> {
  const { data: rows } = await supabase.from('users').select('wallet_address').not('wallet_address', 'is', null)
  const wallets: string[] = [...new Set<string>((rows ?? []).map((r: any) => String(r.wallet_address).toLowerCase())
    .filter((a: string) => /^0x[0-9a-f]{40}$/.test(a)))]
  let passes = 0, recorded = 0
  if (!wallets.length) return { passes, recorded }
  const until = Date.now() + WATCH_LOOP_MS
  while (Date.now() < until) {
    try { recorded += await watchPass(supabase, wallets) } catch (e) {
      console.error('[chain-transfer-webhook] watch pass failed:', e instanceof Error ? e.message : e)
    }
    passes++
    await new Promise(r => setTimeout(r, WATCH_INTERVAL_MS))
  }
  return { passes, recorded }
}

// The cron job sends the vault's claim_worker_service_key, which need not be
// byte-identical to this function's own service key (other jobs rely on the
// gateway's verify_jwt, which is off here so Circle can call in). Ask Auth:
// its admin API only answers a service-role key.
async function isServiceRoleBearer(authorization: string | null): Promise<boolean> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) return false
  if (token === SUPABASE_SERVICE_KEY) return true
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  // Read the RAW body ONCE, before any JSON.parse - the signature is over
  // these exact bytes.
  const rawBody = await req.text()

  const signature = req.headers.get('x-circle-signature') ?? ''
  const keyId     = req.headers.get('x-circle-key-id') ?? ''

  // Catch-up sweep, driven by the chain-transfer-webhook-sweep cron job
  // (every minute, service-role bearer - same pattern as the other cron
  // jobs). It used to piggyback on every Circle request, but this function
  // cold-starts on nearly every call, so the per-instance 10s throttle never
  // held and the sweep query ran on every one of ~490k calls/day.
  if (!signature) {
    let mode = ''
    try { mode = JSON.parse(rawBody || '{}')?.mode ?? '' } catch { /* not a sweep */ }
    if (mode === 'sweep') {
      if (!await isServiceRoleBearer(req.headers.get('authorization'))) return json({ ok: false, error: 'unauthorized' }, 401)
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      lastSweepAt = 0
      await sweepUnnotifiedReceives(supabase)
      // The same once-a-minute job drives the Arc log watcher (2s passes for ~58s).
      const watch = await runWatcher(supabase)
      return json({ ok: true, swept: true, watch })
    }
  }

  if (!signature || !keyId) {
    // Circle's actual endpoint-verification probe (sent when a notification
    // subscription is created/updated) is an unsigned POST, not the HEAD
    // request their own docs describe. Treated as a benign connectivity
    // check, not an error: nothing downstream ever writes to the database
    // without a signature also verifying successfully, so returning 200
    // here instead of 401 does not weaken that guarantee - it only lets
    // Circle's own verification step succeed.
    return json({ ok: true, ignored: 'no signature headers present - treated as a connectivity check' })
  }

  // Filter BEFORE verifying the signature. The USDC monitor delivers every
  // Transfer on Arc (~490k/day), and almost none involve a MeshPort wallet.
  // Verifying first meant fetching Circle's public key on nearly every call
  // (cold start = empty key cache), ~0.8s each and a rate-limit risk for the
  // deposits that matter. Every branch below that runs before verification
  // only returns "ignored" - nothing is written or sent until the signature
  // checks out, so an unsigned or forged body can at most get itself ignored.
  let payload: CircleEventLogNotification
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400)
  }

  if (payload.notificationType !== 'contracts.eventLog') {
    return json({ ok: true, ignored: 'not a contracts.eventLog notification' })
  }

  const n = payload.notification
  if (!n || n.blockchain !== 'ARC-TESTNET') {
    return json({ ok: true, ignored: 'not ARC-TESTNET' })
  }
  if (n.eventSignature?.split('(')[0] !== 'Transfer') {
    return json({ ok: true, ignored: 'not a Transfer event' })
  }

  const token = WATCHED_TOKENS[(n.contractAddress || '').toLowerCase()]
  if (!token) {
    return json({ ok: true, ignored: 'contract not in WATCHED_TOKENS' })
  }

  // Same topic layout as every other Transfer-log parser in this codebase
  // (claim-recovery-scan, blockchain-indexer/scanner.ts) - topics[0] = event
  // signature hash, topics[1] = from (padded), topics[2] = to (padded).
  const fromTopic = (n.topics?.[1] as string) || ''
  const toTopic    = (n.topics?.[2] as string) || ''
  const isMint = fromTopic.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()
  const fromAddress = '0x' + fromTopic.slice(-40)
  const toAddress   = '0x' + toTopic.slice(-40)

  let amount: number
  try {
    amount = Number(BigInt(n.data)) / (10 ** token.decimals)
  } catch {
    return json({ ok: false, error: 'could not decode transfer amount' }, 400)
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: true, ignored: 'non-positive or unparseable amount' })
  }
  if (isMint && token.symbol !== 'USDC') {
    // Only USDC claims are tracked; EURC/cirBTC mints have no `claims` rows.
    return json({ ok: true, ignored: 'mint (from address(0)) - no matching pending/recent-failed claim found' })
  }
  if (!isMint && fromAddress.toLowerCase() === toAddress.toLowerCase()) {
    return json({ ok: true, ignored: 'self-transfer at the topic level (should not occur for a real Transfer)' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // One indexed lookup decides relevance: a claim mint needs an in-flight
  // claim for the recipient; any other transfer needs a MeshPort recipient.
  let user: { id: string; username: string | null } | null = null
  if (isMint) {
    const { data: claim, error } = await supabase
      .from('claims').select('id')
      .eq('wallet_address', toAddress.toLowerCase())
      .in('status', ['bridging', 'verifying', 'settling', 'failed'])
      .limit(1).maybeSingle()
    if (error) console.error('[chain-transfer-webhook] claims pre-check failed:', error.message)
    else if (!claim) return json({ ok: true, ignored: 'mint (from address(0)) - no matching pending/recent-failed claim found' })
  } else {
    user = await findUserByWallet(supabase, toAddress)
    if (!user) return json({ ok: true, ignored: 'recipient is not a MeshPort wallet' })
  }

  const validSignature = await verifyCircleSignature(rawBody, signature, keyId)
  if (!validSignature) {
    console.error('[chain-transfer-webhook] rejected: signature verification failed')
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  const outcome = await processTransfer(supabase, { symbol: token.symbol, isMint, fromAddress, toAddress, amount, txHash: n.txHash, user })
  return json({ ok: true, ...outcome })
})
