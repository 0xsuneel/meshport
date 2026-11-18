// supabase/functions/rewards-claim-sign/index.ts
//
// POST /rewards-claim-sign
//
// Body: { points: number, claimId: string }  (who is claiming comes from the session)
//   claimId: 0x + 64 hex chars (bytes32), generated client-side.
//   { action: 'pending' } → { pending: { points, claimId } | null }: an unfinished claim.
// An unfinished claim (points reserved, voucher not yet paid on-chain) is
// always finished first: the response then carries ITS points and claimId
// (resumed: true) - see openReservation.
//
// Validates the caller's real point balance from `user_points`, then signs a
// claim voucher with REWARDS_SIGNER_PRIVATE_KEY for consumption by the
// MeshPortRewards.claimRewards(points, claimId, signature) on-chain call.
//
// Returns: { signature, points, claimId, resumed } - signature 0x-prefixed hex, 65 bytes (EIP-191 v=27/28)
//
// Security: the private key NEVER leaves this function - not in logs, not in
// responses, not in errors. Same discipline as RELAY_PRIVATE_KEY in relay-deposit.js.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders, handleOptions, json } from '../_shared/cors.ts'
import { getServiceRoleKey } from '../_shared/serviceKey.ts'

// ── Supabase service-role client (same pattern as claim-submit) ───────────────

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

// ── Signing key - NEVER logged, NEVER returned ────────────────────────────────
// Must match the address set as pointsSigner on the deployed MeshPortRewards
// contract. Set as a Supabase project secret: REWARDS_SIGNER_PRIVATE_KEY.
const REWARDS_SIGNER_PRIVATE_KEY = Deno.env.get('REWARDS_SIGNER_PRIVATE_KEY') ?? ''

// ── Contract address - read from env, NEVER hardcoded ────────────────────────
// Must match VITE_REWARDS_CONTRACT in the app's env.
const REWARDS_CONTRACT = (Deno.env.get('VITE_REWARDS_CONTRACT') ?? '').trim().toLowerCase()

// Arc Testnet chain ID (5042002) - fixed for signing; this matches the value
// hardcoded in MeshPortRewards's digest construction (block.chainid on Arc Testnet).
const ARC_TESTNET_CHAIN_ID = 5042002n

// Claim bounds - must mirror MIN_CLAIM_POINTS / MAX_CLAIM_POINTS in rewards.ts
const MIN_CLAIM_POINTS = 100
// Fallback only: the live contract's MAX_DAILY_POINTS is read below (1,000 on
// the first MeshPortRewards, 10,000 = 5 USDC after the 18 Nov 2026 redeploy).
const MAX_CLAIM_POINTS = 1000
// A reservation of points, or of scratch-card USDC (18 Nov) - claimed as
// points at the contract's rate: 1000 points = 0.5 USDC, so 1 point = 500
// micro-USDC.
const RESERVED = ['claim_reserved', 'claim_reserved_usdc']
const MICRO_PER_POINT = 500
const MAX_DAILY_SELECTOR = 'c0d0f1ad' // MAX_DAILY_POINTS()

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  // ── Validate signing key is configured ────────────────────────────────────
  if (!REWARDS_SIGNER_PRIVATE_KEY) {
    console.error('[rewards-claim-sign] REWARDS_SIGNER_PRIVATE_KEY is not set')
    return json({ success: false, error: 'Signing service not configured' }, 503)
  }
  if (!REWARDS_CONTRACT) {
    console.error('[rewards-claim-sign] VITE_REWARDS_CONTRACT is not set')
    return json({ success: false, error: 'Rewards contract not configured' }, 503)
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const action       = String(body?.action ?? 'sign')
  // 'usdc' (18 Nov): claim USDC won on scratch cards (reward_usdc) through the same voucher.
  const source       = body?.source === 'usdc' ? 'usdc' : 'points'
  let points         = Number(body?.points)
  let claimId        = (body?.claimId      ?? '').toString().trim().toLowerCase()
  if (action === 'pending') { points = MIN_CLAIM_POINTS; claimId = '0x' + '0'.repeat(64) } // only who's asking matters

  if (!claimId) {
    return json({ success: false, error: 'claimId is required' }, 400)
  }
  const limit = await dailyLimit()
  if (!Number.isInteger(points) || points < MIN_CLAIM_POINTS || points > limit) {
    return json({
      success: false,
      error: `points must be between ${MIN_CLAIM_POINTS} and ${limit}`,
    }, 400)
  }
  // claimId must be 0x + 64 hex chars (bytes32)
  if (!/^0x[0-9a-f]{64}$/.test(claimId)) {
    return json({ success: false, error: 'claimId must be a 0x-prefixed bytes32 hex string' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // ── Who is claiming - from the session, never from the request body ───────
  // (The old version trusted body.userId + body.walletAddress: anyone could
  // sign vouchers against another user's points, paid to their own wallet.)
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: authData } = jwt ? await supabase.auth.getUser(jwt) : { data: { user: null } }
  const uid = authData?.user?.id
  if (!uid) return json({ success: false, error: 'Please sign in again' }, 401)
  const { data: me } = await supabase.from('users').select('id, wallet_address').eq('auth_uid', uid).maybeSingle()
  if (!me?.id || !me.wallet_address) return json({ success: false, error: 'Account not linked to this session' }, 403)
  const userId = me.id as string
  const walletAddress = String(me.wallet_address).toLowerCase()

  // ── An unfinished claim comes first ──────────────────────────────────────
  // Points are reserved (deducted) when a voucher is signed. If sending it
  // then failed, those points are held for that voucher - and it is still
  // valid on-chain, so they can't simply be handed back (the voucher could
  // then pay out too). So the next claim FINISHES that one: the same voucher,
  // the same points, whatever amount was asked for - never a second
  // reservation (a failed 100-point claim, then a claim from another device
  // or for another amount, used to hold the first 100 for good).
  // The contract says whether a voucher was used (isClaimUsed): a used one is
  // done (USDC was paid) and its claim record is marked so.
  const open = await openReservation(supabase, userId)
  if (open === 'unknown') return json({ success: false, error: "Couldn't check your earlier claim - try again in a moment" }, 503)
  if (action === 'pending') return json({ success: true, pending: open ? { points: open.points, claimId: open.claimId } : null })
  if (open && open.claimId !== claimId) {
    points = open.points
    claimId = open.claimId
  }

  // ── Same claimId again (a retry after a failed send): re-issue the same
  // voucher. Points were already reserved for it, so nothing is deducted twice.
  const { data: existing } = await supabase.from('point_transactions')
    .select('points, user_id').in('reason', RESERVED).eq('tx_hash', claimId).maybeSingle()
  if (existing) {
    if (existing.user_id !== userId || -Number(existing.points) !== points) {
      return json({ success: false, error: 'This claim id belongs to another claim' }, 409)
    }
  } else {
    // Daily cap (the contract allows 1000 points per wallet per UTC day) -
    // checked before reserving so a capped claim never burns points.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
    const { data: today } = await supabase.from('point_transactions')
      .select('points').eq('user_id', userId).in('reason', RESERVED).gte('created_at', dayStart.toISOString())
    const usedToday = (today ?? []).reduce((n: number, r: any) => n + Math.abs(Number(r.points) || 0), 0)
    if (usedToday + points > limit) {
      return json({ success: false, error: `Daily limit reached - ${Math.max(0, limit - usedToday)} points left today` }, 400)
    }

    if (source === 'usdc') {
      // USDC won on scratch cards: the voucher's points are its USDC value
      // (1 point = 500 micro-USDC on the contract), reserved from reward_usdc
      // the same way - compare-and-swap, then the reservation record.
      const need = points * MICRO_PER_POINT
      const { data: ub } = await supabase.from('reward_usdc').select('balance_micro').eq('user_id', userId).maybeSingle()
      const micro = Number(ub?.balance_micro ?? 0)
      if (micro < need) {
        return json({ success: false, error: `Not enough USDC rewards: have $${(micro / 1e6).toFixed(2)}, need $${(need / 1e6).toFixed(2)}` }, 400)
      }
      const { data: took } = await supabase.from('reward_usdc')
        .update({ balance_micro: micro - need, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('balance_micro', micro).select('user_id')
      if (!took || took.length !== 1) {
        return json({ success: false, error: 'Your USDC rewards changed - please try again' }, 409)
      }
      const { error: uErr } = await supabase.from('point_transactions').insert({
        user_id: userId, wallet_address: walletAddress, points: -points, reason: 'claim_reserved_usdc', tx_hash: claimId,
      })
      if (uErr) {
        await supabase.from('reward_usdc').update({ balance_micro: micro }).eq('user_id', userId).eq('balance_micro', micro - need)
        console.error('[rewards-claim-sign] usdc reservation insert failed:', uErr.message)
        return json({ success: false, error: 'Could not reserve your USDC - try again' }, 500)
      }
    } else {
    // Reserve the points atomically (compare-and-swap on the balance), then
    // record the reservation. Only then is a voucher signed.
    const { data: bal } = await supabase.from('user_points').select('total_points').eq('user_id', userId).maybeSingle()
    const available = Number(bal?.total_points ?? 0)
    if (available < points) {
      return json({ success: false, error: `Insufficient points: have ${available}, need ${points}` }, 400)
    }
    const { data: swapped } = await supabase.from('user_points')
      .update({ total_points: available - points, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('total_points', available).select('user_id')
    if (!swapped || swapped.length !== 1) {
      return json({ success: false, error: 'Your points changed - please try again' }, 409)
    }
    const { error: resErr } = await supabase.from('point_transactions').insert({
      user_id: userId, wallet_address: walletAddress, points: -points, reason: 'claim_reserved', tx_hash: claimId,
    })
    if (resErr) {
      // Put the points back - no voucher without a reservation record.
      await supabase.from('user_points').update({ total_points: available }).eq('user_id', userId).eq('total_points', available - points)
      console.error('[rewards-claim-sign] reservation insert failed:', resErr.message)
      return json({ success: false, error: 'Could not reserve points - try again' }, 500)
    }
    }
  }

  // ── Build digest - must match MeshPortRewards.claimRewards exactly ────────
  // Solidity: keccak256(abi.encode(address(this), block.chainid, msg.sender, points, claimId))
  // Then wrapped with toEthSignedMessageHash (standard Ethereum signed message prefix).
  const { keccak256, encodeAbiParameters, parseAbiParameters } = await import('npm:viem@2')
  const { privateKeyToAccount } = await import('npm:viem@2/accounts')

  const contractAddr = REWARDS_CONTRACT as `0x${string}`
  const callerAddr   = walletAddress as `0x${string}`
  const claimIdBytes = claimId as `0x${string}`

  const digest = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, uint256, address, uint256, bytes32'),
      [contractAddr, ARC_TESTNET_CHAIN_ID, callerAddr, BigInt(points), claimIdBytes],
    ),
  )

  // Sign with the Ethereum signed message prefix - this is what
  // MessageHashUtils.toEthSignedMessageHash() + ECDSA.recover() on the
  // Solidity side expects. viem's signMessage({ message: { raw: digest } })
  // applies the \x19Ethereum Signed Message:\n32 prefix before signing,
  // matching the Solidity side exactly.
  let signerKey = REWARDS_SIGNER_PRIVATE_KEY
  if (!signerKey.startsWith('0x')) signerKey = '0x' + signerKey
  const account = privateKeyToAccount(signerKey as `0x${string}`)
  const signature = await account.signMessage({ message: { raw: digest as `0x${string}` } })

  return json({ success: true, signature, points, claimId, resumed: !!open })
})

// ── Unfinished reservations ─────────────────────────────────────────────────
const ARC_RPC = (Deno.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io').trim()

/** The contract's own daily limit in points (MAX_DAILY_POINTS), cached 10 minutes. */
let limitCache: { v: number; at: number } | null = null
async function dailyLimit(): Promise<number> {
  if (limitCache && Date.now() - limitCache.at < 10 * 60_000) return limitCache.v
  try {
    const r = await fetch(ARC_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000),
      // MAX_DAILY_POINTS() selector
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REWARDS_CONTRACT, data: '0x' + MAX_DAILY_SELECTOR }, 'latest'] }),
    })
    const j = await r.json()
    const v = typeof j?.result === 'string' && j.result !== '0x' ? Number(BigInt(j.result)) : 0
    if (v >= MIN_CLAIM_POINTS && v <= 1_000_000) { limitCache = { v, at: Date.now() }; return v }
  } catch { /* fall back */ }
  return MAX_CLAIM_POINTS
}

/** Has the contract already paid this voucher? null when the chain can't be asked. */
async function claimUsed(claimId: string): Promise<boolean | null> {
  try {
    const { encodeFunctionData, parseAbi } = await import('npm:viem@2')
    const data = encodeFunctionData({ abi: parseAbi(['function isClaimUsed(bytes32) view returns (bool)']), functionName: 'isClaimUsed', args: [claimId as `0x${string}`] })
    const r = await fetch(ARC_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REWARDS_CONTRACT, data }, 'latest'] }),
    })
    const j = await r.json()
    if (typeof j?.result !== 'string') return null
    return BigInt(j.result) !== 0n
  } catch { return null }
}

/**
 * The user's reservation whose voucher hasn't been paid yet (null: none;
 * 'unknown': the chain couldn't be asked). Reservations the contract already
 * paid are marked completed on their claim records along the way.
 */
async function openReservation(supabase: any, userId: string): Promise<{ points: number; claimId: string } | null | 'unknown'> {
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data: reserved } = await supabase.from('point_transactions')
    .select('points, tx_hash, created_at').eq('user_id', userId).in('reason', RESERVED)
    .gte('created_at', since).order('created_at', { ascending: true }).limit(50)
  const ids = (reserved ?? []).map((r: any) => String(r.tx_hash)).filter((x: string) => /^0x[0-9a-f]{64}$/.test(x))
  if (!ids.length) return null
  const { data: done } = await supabase.from('reward_claims').select('claim_id_bytes32').in('claim_id_bytes32', ids).eq('status', 'completed')
  const finished = new Set((done ?? []).map((r: any) => String(r.claim_id_bytes32)))
  for (const r of reserved ?? []) {
    const id = String(r.tx_hash)
    if (finished.has(id) || !/^0x[0-9a-f]{64}$/.test(id)) continue
    const used = await claimUsed(id)
    if (used === null) return 'unknown'
    if (used) {
      // Paid on-chain but never marked (the app closed before it could).
      await supabase.from('reward_claims').update({ status: 'completed', claimed_at: new Date().toISOString() })
        .eq('claim_id_bytes32', id).neq('status', 'completed')
      continue
    }
    return { points: Math.abs(Number(r.points) || 0), claimId: id }
  }
  return null
}
