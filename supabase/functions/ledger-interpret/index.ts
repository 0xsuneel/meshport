// supabase/functions/ledger-interpret/index.ts
//
// Live entry point for server/ledger's interpreter (ported here as
// interpreter.ts -- see types.ts's provenance header). Two callable modes,
// matching the interpreter's two entry points exactly:
//
//   POST { mode: 'attempt',    attemptId: <transaction_attempts.id> }
//     -> interpretConfirmedAttempt (SWAP_DEBIT)
//   POST { mode: 'chain_event', chainEventId: <chain_events.id> }
//     -> interpretConfirmedChainEvent (CREDIT / SWAP_CREDIT / BulkPay pair)
//   POST { mode: 'sweep' }
//     -> convenience: finds every CONFIRMED swap attempt not yet ledger-
//        interpreted and every confirmed, swap-correlated chain_event not
//        yet ledger-interpreted, and interprets each. This is what
//        blockchain-indexer's swap-confirm/swap-reconcile call right after
//        their own work, so a real swap's ledger rows are produced in the
//        same pass its confirmation/reconciliation completes, without a
//        separate cron entry.
//
// This function's own DB reads for the 'sweep' worklist are intentionally
// minimal and separate from LedgerRepository (which is caller-supplied and
// has no "list uninterpreted" method by design, per repository.ts's own
// narrow, read-single-row interface) -- the worklist queries live here,
// in the live wiring layer, exactly where swap-confirm/swap-reconcile's own
// worklist queries live in blockchain-indexer/index.ts.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { interpretConfirmedAttempt, interpretConfirmedChainEvent } from './interpreter.ts'
import { makeLiveLedgerRepository } from './liveRepository.ts'
import type { AttemptContext } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    } catch { /* fall through */ }
  }
  throw new Error('No Supabase service role key found -- checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

async function findUninterpretedConfirmedSwapAttempts(supabase: ReturnType<typeof createClient>): Promise<AttemptContext[]> {
  // "Not yet ledger-interpreted" is derived, not stored as its own column:
  // an attempt whose CONFIRMED tx_hash has no ledger_events row at all yet
  // (SWAP_DEBIT's own event_key has log_index NULL, so a left-join-style
  // existence check by tx_hash+wallet_address is sufficient and cheap).
  const { data: attempts, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, tx_hash, status, block_number, wallet_address, transaction_intents!inner(feature)')
    .eq('status', 'CONFIRMED')
    .eq('transaction_intents.feature', 'swap')
    .not('tx_hash', 'is', null)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) { console.error('[ledger-interpret] findUninterpretedConfirmedSwapAttempts query failed:', error.message); return [] }

  const out: AttemptContext[] = []
  for (const r of (attempts ?? []) as Array<Record<string, unknown>>) {
    const { data: existing } = await supabase
      .from('ledger_events')
      .select('id')
      .eq('chain_id', r.chain_id as string)
      .eq('tx_hash', (r.tx_hash as string).toLowerCase())
      .eq('wallet_address', (r.wallet_address as string).toLowerCase())
      .eq('event_type', 'SWAP_DEBIT')
      .maybeSingle()
    if (existing) continue
    out.push({
      id: r.id as string,
      intent_id: r.intent_id as string,
      chain_id: r.chain_id as string,
      tx_hash: (r.tx_hash as string | null) ?? null,
      status: r.status as string,
      block_number: (r.block_number as number | null) ?? null,
    })
  }
  return out
}

async function findUninterpretedConfirmedSwapChainEvents(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  // Every confirmed chain_event sitting on a tx_hash that a swap attempt
  // also owns is a SWAP_CREDIT candidate (the interpreter itself decides
  // applicability/correlation -- this is only the worklist, not the
  // classification).
  const { data: attempts, error: attemptsErr } = await supabase
    .from('transaction_attempts')
    .select('tx_hash, chain_id, transaction_intents!inner(feature)')
    .eq('status', 'CONFIRMED')
    .eq('transaction_intents.feature', 'swap')
    .not('tx_hash', 'is', null)
    .limit(200)
  if (attemptsErr) { console.error('[ledger-interpret] findUninterpretedConfirmedSwapChainEvents attempts query failed:', attemptsErr.message); return [] }
  const txHashes = [...new Set((attempts ?? []).map(a => (a as Record<string, unknown>).tx_hash as string))]
  if (txHashes.length === 0) return []

  const { data: events, error: eventsErr } = await supabase
    .from('chain_events')
    .select('id, tx_hash, wallet_address, chain_id')
    .in('tx_hash', txHashes)
    .eq('status', 'confirmed')
    .limit(500)
  if (eventsErr) { console.error('[ledger-interpret] findUninterpretedConfirmedSwapChainEvents events query failed:', eventsErr.message); return [] }

  const out: string[] = []
  for (const e of (events ?? []) as Array<Record<string, unknown>>) {
    const { data: existing } = await supabase
      .from('ledger_events')
      .select('id')
      .eq('chain_id', e.chain_id as string)
      .eq('tx_hash', (e.tx_hash as string).toLowerCase())
      .eq('wallet_address', ((e.wallet_address as string) ?? '').toLowerCase())
      .eq('event_type', 'SWAP_CREDIT')
      .maybeSingle()
    if (existing) continue
    out.push(String(e.id))
  }
  return out
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body: unknown = {}
  try { body = await req.json() } catch { /* default mode below */ }
  const b = body as Record<string, unknown>
  const mode = typeof b.mode === 'string' ? b.mode : 'sweep'

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const repo = makeLiveLedgerRepository(supabase)

  try {
    if (mode === 'attempt') {
      const attemptId = typeof b.attemptId === 'string' ? b.attemptId : ''
      if (!attemptId) return json({ success: false, error: 'attemptId required' }, 400)
      const { data, error } = await supabase.from('transaction_attempts').select('id, intent_id, chain_id, tx_hash, status, block_number').eq('id', attemptId).maybeSingle()
      if (error || !data) return json({ success: false, error: 'attempt not found' }, 404)
      const result = await interpretConfirmedAttempt(repo, data as unknown as AttemptContext)
      return json({ success: true, result })
    }

    if (mode === 'chain_event') {
      const chainEventId = typeof b.chainEventId === 'string' || typeof b.chainEventId === 'number' ? String(b.chainEventId) : ''
      if (!chainEventId) return json({ success: false, error: 'chainEventId required' }, 400)
      const result = await interpretConfirmedChainEvent(repo, chainEventId)
      return json({ success: true, result })
    }

    // mode === 'sweep' (default)
    const [attempts, chainEventIds] = await Promise.all([
      findUninterpretedConfirmedSwapAttempts(supabase),
      findUninterpretedConfirmedSwapChainEvents(supabase),
    ])
    const attemptResults = []
    for (const attempt of attempts) {
      attemptResults.push(await interpretConfirmedAttempt(repo, attempt))
    }
    const chainEventResults = []
    for (const id of chainEventIds) {
      chainEventResults.push(await interpretConfirmedChainEvent(repo, id))
    }
    return json({ success: true, mode, attemptsProcessed: attemptResults.length, chainEventsProcessed: chainEventResults.length, attemptResults, chainEventResults })
  } catch (e) {
    console.error('[ledger-interpret] failed:', e instanceof Error ? e.message : e)
    return json({ success: false, error: 'internal error' }, 500)
  }
})
