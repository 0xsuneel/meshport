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
// on Arc's USDC contract, mints included — the `isMint` branch below was
// simply discarding that data instead of using it, deferring entirely to
// claim-worker/claim-recovery-scan's own RPC-based polling. Diagnosed this
// session: that polling's configured RPC provider was silently missing real,
// confirmed mints (eth_getLogs returning empty while a fresh public endpoint
// and Arc's own explorer both showed the transfer) — claim-worker kept
// retrying against the same blind provider for the full 40-minute settling
// window before giving up. This webhook is not subject to that bug at all:
// Circle's own indexer is the one watching the chain, not this app's RPC
// config, so it sees the mint the moment it confirms regardless of whatever
// state that provider is in.
//
// Match by wallet_address + fee-tolerant amount band — the exact same
// heuristic claim-worker's own findIncomingMintByAmount fallback already
// uses (claim-worker/index.ts), not a new/riskier one: CCTP/relay fees only
// ever reduce the minted amount versus what was claimed, so a real match is
// always in [70% of claimed, claimed + 0.1% rounding slack]. Deliberately
// also matches recently-`failed` claims (not just active ones) — this is
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

const APP_BASE_URL        = (Deno.env.get('APP_BASE_URL') || 'https://meshport.xyz').trim()
const PUSH_INTERNAL_SECRET = (Deno.env.get('PUSH_INTERNAL_SECRET') || '').trim()

// Same server-side push claim-worker's own notifyClaimComplete sends —
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
    const chainLabel = (sourceChain || '').replace(/_Sepolia|_Testnet|_Fuji/g, '').replace(/_/g, ' ')
    await fetch(`${APP_BASE_URL}/api/push?action=send-internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_INTERNAL_SECRET}` },
      body: JSON.stringify({
        userId: user.id,
        title:  'Claim Complete',
        body:   `$${amount.toFixed(2)} USDC arrived on Arc from ${chainLabel}`,
        url:    '/multichain',
        tag:    `claim-complete-${claimId}`,
      }),
    })
  } catch (e) {
    console.warn('[chain-transfer-webhook] notifyClaimComplete failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

// Returns the completed claim's id, or null if no matching claim was found
// (a plain external USDC mint unrelated to any tracked claim — always
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
    // fallback — but unlike claim-worker (fixed this session to try each
    // claim's own CCTP nonce first, and to safely fall through on a
    // write collision), this webhook fires once per mint event with no
    // retry loop and no nonce correlation available here. If TWO claims
    // for the same wallet qualify for the same mint (same amount, both
    // in flight — exactly the scenario that caused claim-worker's stuck-
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
      const roundingSlack = claimedRaw / 1000n         // 0.1% — rounding only
      const feeFloor       = (claimedRaw * 70n) / 100n // up to 30% fee, generous margin
      if (mintedRaw < feeFloor || mintedRaw > claimedRaw + roundingSlack) continue
      qualifying.push(c)
    }
    if (qualifying.length === 0) return null
    if (qualifying.length > 1) {
      console.warn(
        `[chain-transfer-webhook] ambiguous mint match for ${toAddress}: ${qualifying.length} candidate claims ` +
        `qualify for mint ${mintTxHash} (amount ${mintedAmount}) — [${qualifying.map(c => c.id).join(', ')}]. ` +
        `Declining to guess; leaving for claim-worker's nonce-based match.`
      )
      return null
    }
    // Exactly one qualifying candidate — safe to complete (mirrors the
    // original single-candidate behavior, just without the multi-
    // candidate "pick one" guess).
    const best = qualifying[0]

    // Idempotency + race guard: only write if this claim isn't ALREADY
    // completed (by claim-worker's own polling, or a duplicate webhook
    // delivery). No rows affected here just means someone else already
    // finished it with equally-correct data — a harmless no-op.
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
      // a different claim between our SELECT and this UPDATE — not a
      // failure, just a lost race to a source that's equally authoritative.
      // Nothing to correct: whichever writer won has the same, correct data.
      if ((updErr as { code?: string }).code === '23505') {
        console.warn(`[chain-transfer-webhook] lost race to claim-worker for mint ${mintTxHash} on claim ${best.id} — already completed elsewhere`)
      } else {
        console.error('[chain-transfer-webhook] claim completion update failed:', updErr.message)
      }
      return null
    }
    if (!updated) return null

    const base = CHAIN_EXPLORER[updated.source_chain] ?? ARC_EXPLORER
    const burnTxHash = (updated.tx_hash || '').toLowerCase()
    if (burnTxHash) {
      // No ignoreDuplicates here (unlike recordExternalReceive below) —
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

async function alreadyRecorded(supabase: SupabaseClient, walletAddress: string, recvTxHash: string): Promise<boolean> {
  const { data } = await supabase
    .from('activity')
    .select('id')
    .eq('tx_hash', recvTxHash)
    .eq('wallet_address', walletAddress.toLowerCase())
    .maybeSingle()
  return !!data
}

async function recordExternalReceive(
  supabase: SupabaseClient,
  walletAddress: string, userId: string | undefined,
  txHash: string, amount: number, fromAddress: string, tokenSymbol: string,
) {
  const { error } = await supabase
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
      metadata:             { recovered: false, note: 'External deposit', source: 'chain-transfer-webhook', receiveKind: 'external_deposit' },
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
  if (error) console.error('[chain-transfer-webhook] recordExternalReceive failed:', error.message)
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
  const validSignature = await verifyCircleSignature(rawBody, signature, keyId)
  if (!validSignature) {
    console.error('[chain-transfer-webhook] rejected: signature verification failed')
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

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
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  if (isMint) {
    // A mint (from address(0)) is a CCTP claim or similar system mint, not a
    // generic external deposit — see tryCompleteClaimFromMint's own comment
    // for why matching by wallet+amount here is safe and already-precedented
    // in this codebase. Only USDC claims are tracked; EURC/cirBTC mints have
    // no `claims` rows to match against, so they fall through to `ignored`
    // exactly as before.
    if (token.symbol === 'USDC') {
      const completedClaimId = await tryCompleteClaimFromMint(supabase, toAddress, n.txHash, amount)
      if (completedClaimId) {
        return json({ ok: true, completedClaim: completedClaimId, wallet: toAddress, amount, token: token.symbol })
      }
    }
    return json({ ok: true, ignored: 'mint (from address(0)) - no matching pending/recent-failed claim found' })
  }
  if (fromAddress.toLowerCase() === toAddress.toLowerCase()) {
    return json({ ok: true, ignored: 'self-transfer at the topic level (should not occur for a real Transfer)' })
  }

  try {
    const user = await findUserByWallet(supabase, toAddress)
    if (!user) {
      return json({ ok: true, ignored: 'recipient is not a MeshPort wallet' })
    }

    // Same three-layer classification claim-recovery-scan already
    // established this session, in the same order, for the same reasons -
    // see trackedFeatureCorrelation.ts and knownInternalContracts.ts for
    // the full reasoning on each. No TOCTOU poll here: this writer is
    // usually the FASTEST of all of them to run, so a poll-for-the-other-
    // writer's-row check would almost always find nothing yet regardless
    // of outcome - the two deterministic checks below are what actually
    // closes the collision cases, not timing.
    if (isKnownInternalContract(fromAddress, KNOWN_INTERNAL_EXTRA)) {
      return json({ ok: true, ignored: 'sender is a known-internal contract (swap/BulkPay/CCTP/P2P escrow)' })
    }
    if (await findCorrelatedTrackedFeature(supabase, 'arc', n.txHash)) {
      return json({ ok: true, ignored: 'tx_hash correlates to a tracked Pay/BulkPay/Swap attempt' })
    }
    if (await alreadyRecorded(supabase, toAddress, `recv_${n.txHash.toLowerCase()}`)) {
      return json({ ok: true, ignored: 'already recorded (duplicate webhook delivery or a scan-based backstop got there first)' })
    }

    await recordExternalReceive(supabase, toAddress, user.id, n.txHash, amount, fromAddress, token.symbol)
    return json({ ok: true, recorded: true, wallet: toAddress, amount, token: token.symbol })
  } catch (e) {
    console.error('[chain-transfer-webhook] failed:', e instanceof Error ? e.message : e)
    // 200, not 500 - a transient DB hiccup here should not make Circle
    // retry-storm this endpoint; the scan-based backstops still catch this
    // transfer on their own schedule either way.
    return json({ ok: false, error: e instanceof Error ? e.message : 'unknown error' })
  }
})
