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
  if (isMint) {
    // A mint (from address(0)) is a CCTP claim or similar system mint, not
    // a generic external deposit - claim-worker/claim-recovery-scan own
    // that case already, correlated by the mint's own MessageReceived log,
    // which this function does not have the context to resolve safely.
    return json({ ok: true, ignored: 'mint (from address(0)) - not a generic external deposit' })
  }
  if (fromAddress.toLowerCase() === toAddress.toLowerCase()) {
    return json({ ok: true, ignored: 'self-transfer at the topic level (should not occur for a real Transfer)' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

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
