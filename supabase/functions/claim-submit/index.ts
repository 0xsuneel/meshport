// supabase/functions/claim-submit/index.ts
//
// POST /claim  (deployed as the Supabase Edge Function "claim-submit")
//
// Body: { walletAddress, sourceChain, amount, txHash, userId? }
// Returns immediately: { success: true, claimId }
//
// This is the ONLY write path into `claims`. It inserts the row with the
// starting status ('submitted'), then hands off to claim-worker via a
// fire-and-forget invocation (EdgeRuntime.waitUntil keeps it alive after the
// response is sent). From this point on, processing is 100% server-side —
// the browser tab can be closed and the claim still completes.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders, handleOptions, json } from '../_shared/cors.ts'
import { getArcNativeBalance } from '../_shared/chains.ts'

// Same reasoning as claim-worker/index.ts's getServiceRoleKey — legacy name
// tried first (currently verified working), new SUPABASE_SECRET_KEYS format
// only as a fallback, clear error instead of a silent crash if neither is set.
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
      console.error('[claim-submit] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }

  throw new Error(
    'No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS. ' +
    'Set one of these as a project secret.'
  )
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const walletAddress = (body?.walletAddress ?? '').toString().trim()
  const sourceChain    = (body?.sourceChain ?? '').toString().trim()
  const amount         = Number(body?.amount)
  // Lowercase for consistency with wallet_address (already lowercased below)
  // and with activity.tx_hash (always lowercased in ActivityService.saveActivity).
  // Without this, a claim's tx_hash here could differ only in case from the
  // matching activity row, silently breaking the cross-reference the UI uses
  // to show live claim status (MultichainPage.tsx claimStatusByTxHash lookup).
  const txHash         = (body?.txHash ?? '').toString().trim().toLowerCase()

  if (!walletAddress || !sourceChain || !txHash || !Number.isFinite(amount) || amount <= 0) {
    return json({ success: false, error: 'walletAddress, sourceChain, amount and txHash are required' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Best-effort: try to identify the calling user from their JWT (anonymous
  // wallet sessions still carry a valid auth.users id). Not required.
  let userId: string | null = null
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (jwt) {
      const { data } = await supabase.auth.getUser(jwt)
      userId = data?.user?.id ?? null
    }
  } catch { /* non-fatal */ }

  // Snapshot the Arc balance now so the worker can later detect arrival by
  // comparing against this baseline (read-only RPC call, no signing).
  let arcBalanceBefore: number | null = null
  try {
    arcBalanceBefore = await getArcNativeBalance(walletAddress)
  } catch { /* worker will re-derive if this fails */ }

  const { data: existing, error: existingErr } = await supabase
    .from('claims')
    .select('id, status')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (existingErr) {
    // Don't silently proceed as if no duplicate exists — that's how a
    // rejected/erroring read gets misread as "safe to insert" and could
    // double-submit a claim for the same burn tx.
    console.error('[claim-submit] idempotency check failed:', existingErr.message)
    return json({ success: false, error: 'Failed to check for existing claim' }, 500)
  }

  let claimId: string

  if (existing) {
    // Idempotent: same burn tx submitted twice (e.g. client retry) — don't duplicate.
    claimId = existing.id
  } else {
    const { data: inserted, error } = await supabase
      .from('claims')
      .insert({
        user_id:             userId,
        wallet_address:      walletAddress.toLowerCase(),
        source_chain:        sourceChain,
        amount,
        tx_hash:             txHash,
        status:              'submitted',
        arc_balance_before:  arcBalanceBefore,
      })
      .select('id')
      .single()

    if (error?.code === '23505') {
      // Lost a race with a concurrent request for the same tx_hash — the
      // SELECT-then-INSERT above isn't atomic, so two near-simultaneous
      // submitClaim() calls (e.g. the original in-flight request racing
      // AppLayout's pending-submit retry after a reload) can both pass the
      // "not found" check before either INSERT commits. The DB's unique
      // index on tx_hash correctly blocks the second physical row from
      // being created — but until now this branch treated that as a hard
      // failure instead of what it actually is: a successful, idempotent
      // outcome that just needs to look up what the winning request
      // created. Only self-heals via the client's retry loop on next app
      // load otherwise.
      const { data: raced, error: racedErr } = await supabase
        .from('claims').select('id').eq('tx_hash', txHash).maybeSingle()
      if (raced) {
        claimId = raced.id
      } else {
        console.error('[claim-submit] 23505 race but no row found on lookup:', racedErr?.message)
        return json({ success: false, error: 'Failed to create claim' }, 500)
      }
    } else if (error || !inserted) {
      return json({ success: false, error: error?.message ?? 'Failed to create claim' }, 500)
    } else {
      claimId = inserted.id
    }
  }

  // Fire-and-forget: kick the worker for this specific claim so it gets a
  // fast first pass, instead of waiting for the next cron sweep. If this
  // fails or times out, the pg_cron sweep (running independently of any
  // client) will still pick the claim up within ~1 minute.
  //
  // IMPORTANT: previously this used `.catch(() => {})`, which swallowed ANY
  // failure of this kick completely silently — no log, no trace anywhere.
  // If this kick was ever failing (cold start timeout, auth issue, network
  // blip), every single claim would silently fall back to the much slower
  // ~60s cron cadence with zero visibility into why — which would look
  // exactly like "status updates lag behind" reports, especially next to a
  // client-side balance-poll notification that fires independently and much
  // faster. Log failures now so this is actually diagnosable going forward.
  const kickWorker = fetch(`${SUPABASE_URL}/functions/v1/claim-worker`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ mode: 'single', claimId }),
  }).then(res => {
    if (!res.ok) console.error(`[claim-submit] fast-path kick for ${claimId} returned ${res.status}`)
  }).catch(e => {
    console.error(`[claim-submit] fast-path kick for ${claimId} failed:`, e?.message ?? e)
  })

  // @ts-ignore — EdgeRuntime is available in the Supabase Edge Functions runtime
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(kickWorker)
  }

  return json({ success: true, claimId })
})
