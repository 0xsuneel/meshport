// supabase/functions/rewards-claim-sign/index.ts
//
// POST /rewards-claim-sign
//
// Body: { userId: string, walletAddress: string, points: number, claimId: string }
//   claimId: 0x + 64 hex chars (bytes32), generated client-side.
//
// Validates the caller's real point balance from `user_points`, then signs a
// claim voucher with REWARDS_SIGNER_PRIVATE_KEY for consumption by the
// MeshPortRewards.claimRewards(points, claimId, signature) on-chain call.
//
// Returns: { signature: string }  — 0x-prefixed hex, 65 bytes (EIP-191 v=27/28)
//
// Security: the private key NEVER leaves this function — not in logs, not in
// responses, not in errors. Same discipline as RELAY_PRIVATE_KEY in relay-deposit.js.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders, handleOptions, json } from '../_shared/cors.ts'

// ── Supabase service-role client (same pattern as claim-submit) ───────────────
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
      console.error('[rewards-claim-sign] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }

  throw new Error(
    'No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS. ' +
    'Set one of these as a project secret.',
  )
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

// ── Signing key — NEVER logged, NEVER returned ────────────────────────────────
// Must match the address set as pointsSigner on the deployed MeshPortRewards
// contract. Set as a Supabase project secret: REWARDS_SIGNER_PRIVATE_KEY.
const REWARDS_SIGNER_PRIVATE_KEY = Deno.env.get('REWARDS_SIGNER_PRIVATE_KEY') ?? ''

// ── Contract address — read from env, NEVER hardcoded ────────────────────────
// Must match VITE_REWARDS_CONTRACT in the app's env.
const REWARDS_CONTRACT = (Deno.env.get('VITE_REWARDS_CONTRACT') ?? '').trim().toLowerCase()

// Arc Testnet chain ID (5042002) — fixed for signing; this matches the value
// hardcoded in MeshPortRewards's digest construction (block.chainid on Arc Testnet).
const ARC_TESTNET_CHAIN_ID = 5042002n

// Claim bounds — must mirror MIN_CLAIM_POINTS / MAX_CLAIM_POINTS in rewards.ts
const MIN_CLAIM_POINTS = 100
const MAX_CLAIM_POINTS = 1000

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

  const points       = Number(body?.points)
  const claimId      = (body?.claimId      ?? '').toString().trim().toLowerCase()

  if (!claimId) {
    return json({ success: false, error: 'claimId is required' }, 400)
  }
  if (!Number.isInteger(points) || points < MIN_CLAIM_POINTS || points > MAX_CLAIM_POINTS) {
    return json({
      success: false,
      error: `points must be between ${MIN_CLAIM_POINTS} and ${MAX_CLAIM_POINTS}`,
    }, 400)
  }
  // claimId must be 0x + 64 hex chars (bytes32)
  if (!/^0x[0-9a-f]{64}$/.test(claimId)) {
    return json({ success: false, error: 'claimId must be a 0x-prefixed bytes32 hex string' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // ── Who is claiming — from the session, never from the request body ───────
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

  // ── Same claimId again (a retry after a failed send): re-issue the same
  // voucher. Points were already reserved for it, so nothing is deducted twice.
  const { data: existing } = await supabase.from('point_transactions')
    .select('points, user_id').eq('reason', 'claim_reserved').eq('tx_hash', claimId).maybeSingle()
  if (existing) {
    if (existing.user_id !== userId || -Number(existing.points) !== points) {
      return json({ success: false, error: 'This claim id belongs to another claim' }, 409)
    }
  } else {
    // Daily cap (the contract allows 1000 points per wallet per UTC day) —
    // checked before reserving so a capped claim never burns points.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
    const { data: today } = await supabase.from('point_transactions')
      .select('points').eq('user_id', userId).eq('reason', 'claim_reserved').gte('created_at', dayStart.toISOString())
    const usedToday = (today ?? []).reduce((n: number, r: any) => n + Math.abs(Number(r.points) || 0), 0)
    if (usedToday + points > MAX_CLAIM_POINTS) {
      return json({ success: false, error: `Daily limit reached — ${Math.max(0, MAX_CLAIM_POINTS - usedToday)} points left today` }, 400)
    }

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
      return json({ success: false, error: 'Your points changed — please try again' }, 409)
    }
    const { error: resErr } = await supabase.from('point_transactions').insert({
      user_id: userId, wallet_address: walletAddress, points: -points, reason: 'claim_reserved', tx_hash: claimId,
    })
    if (resErr) {
      // Put the points back — no voucher without a reservation record.
      await supabase.from('user_points').update({ total_points: available }).eq('user_id', userId).eq('total_points', available - points)
      console.error('[rewards-claim-sign] reservation insert failed:', resErr.message)
      return json({ success: false, error: 'Could not reserve points — try again' }, 500)
    }
  }

  // ── Build digest — must match MeshPortRewards.claimRewards exactly ────────
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

  // Sign with the Ethereum signed message prefix — this is what
  // MessageHashUtils.toEthSignedMessageHash() + ECDSA.recover() on the
  // Solidity side expects. viem's signMessage({ message: { raw: digest } })
  // applies the \x19Ethereum Signed Message:\n32 prefix before signing,
  // matching the Solidity side exactly.
  let signerKey = REWARDS_SIGNER_PRIVATE_KEY
  if (!signerKey.startsWith('0x')) signerKey = '0x' + signerKey
  const account = privateKeyToAccount(signerKey as `0x${string}`)
  const signature = await account.signMessage({ message: { raw: digest as `0x${string}` } })

  return json({ success: true, signature })
})
