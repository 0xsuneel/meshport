// supabase/functions/bulkpay-intent/index.ts
//
// Real entry point for createBulkPayIntent (logic.ts) -- the only place in
// this feature that instantiates a real Supabase client or makes a real
// RPC call. Everything in logic.ts is pure/dependency-injected and already
// tested without either (logic.test.ts).
//
// Self-contained rather than importing blockchain-indexer's rpcCallRace --
// matching the established pattern already used throughout this codebase
// (claim-recovery-scan, claim-worker, wallet-key are all self-contained for
// the same reason: Edge Functions are deployed as independent bundles).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createBulkPayIntent, markBulkPayAttemptSubmitted } from './logic.ts'
import type { IntentRepository, NonceFetcher, CreateBulkPayIntentRequest } from './logic.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
]

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  let lastErr: unknown = null
  for (const url of ARC_RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) { lastErr = new Error(`RPC ${res.status} from ${url}`); continue }
      const respJson = await res.json()
      if (respJson.error) { lastErr = respJson.error; continue }
      return respJson.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`RPC call ${method} failed on all endpoints`)
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
    } catch { /* fall through to the error below */ }
  }
  throw new Error('No Supabase service role key found -- checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

function makeLiveIntentRepository(supabase: ReturnType<typeof createClient>): IntentRepository {
  return {
    async findIntentByIdempotencyKey(walletAddress, idempotencyKey) {
      const { data } = await supabase
        .from('transaction_intents')
        .select('id, transaction_attempts(id)')
        .eq('wallet_address', walletAddress)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()
      if (!data) return null
      const attempts = (data as { transaction_attempts?: Array<{ id: string }> }).transaction_attempts
      return { id: data.id as string, attemptId: attempts?.[0]?.id ?? null }
    },
    async insertIntent(row) {
      const { data, error } = await supabase.from('transaction_intents').insert(row).select('id').single()
      if (error) {
        if (error.code === '23505') return { outcome: 'conflict' }
        throw error
      }
      return { outcome: 'inserted', id: data!.id as string }
    },
    async insertAttempt(row) {
      const { data, error } = await supabase.from('transaction_attempts').insert(row).select('id').single()
      if (error) {
        if (error.code === '23505') return { outcome: 'nonce_conflict' }
        throw error
      }
      return { outcome: 'inserted', id: data!.id as string }
    },
    async markAttemptSubmitted(attemptId, txHash) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ tx_hash: txHash, status: 'SUBMITTED', submitted_at: new Date().toISOString() })
        .eq('id', attemptId)
      if (error) throw error
    },
    async transitionIntentToSubmitted(intentId) {
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: 'SUBMITTED' })
        .eq('id', intentId)
        .eq('status', 'AUTHORIZING')
      if (error) console.error('[bulkpay-intent] transitionIntentToSubmitted failed:', error.message)
    },
    async reclaimStaleAttempt(chainId, walletAddress, nonce, staleBeforeIso) {
      // See reclaimStaleAttempt's own doc comment on IntentRepository
      // (logic.ts) / pay-intent/index.ts's identical implementation for
      // the full reasoning.
      const { data, error } = await supabase
        .from('transaction_attempts')
        .update({ nonce: null, status: 'DROPPED', failure_code: 'RECLAIMED_STALE_NONCE', failure_message: 'No broadcast observed within the grace period -- nonce released for reuse.' })
        .eq('chain_id', chainId)
        .eq('wallet_address', walletAddress)
        .eq('nonce', nonce)
        .eq('status', 'CREATED')
        .is('tx_hash', null)
        .lt('updated_at', staleBeforeIso)
        .select('id')
      if (error) { console.error('[bulkpay-intent] reclaimStaleAttempt failed:', error.message); return false }
      return (data?.length ?? 0) > 0
    },
  }
}

function makeLiveNonceFetcher(): NonceFetcher {
  return {
    async getPendingNonce(_chainId, walletAddress) {
      const result = await rpcCall('eth_getTransactionCount', [walletAddress, 'pending'])
      return Number(BigInt(result as string))
    },
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body: unknown = {}
  try { body = await req.json() } catch { /* ignore, validated below */ }
  const b = body as Record<string, unknown>

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const repo = makeLiveIntentRepository(supabase)

  // ── action=markSubmitted: persist a real, client-observed tx_hash the
  // instant it's known, BEFORE the client waits for a receipt — closes
  // docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md §1's traced bug at
  // the server-persistence layer, not just the in-memory one already fixed
  // directly in BulkPayoutPage.tsx. Kept on this SAME deployed function
  // rather than a new one — same "prefer reuse" precedent already used for
  // blockchain-indexer's multiple modes.
  if (b.action === 'markSubmitted') {
    const attemptId = typeof b.attemptId === 'string' ? b.attemptId : ''
    const txHash = typeof b.txHash === 'string' ? b.txHash : ''
    try {
      const result = await markBulkPayAttemptSubmitted(repo, attemptId, txHash)
      if (result.outcome === 'invalid_request') return json({ success: false, error: result.reason }, 400)
      return json({ success: true })
    } catch (e) {
      console.error('[bulkpay-intent] markSubmitted failed:', e instanceof Error ? e.message : e)
      return json({ success: false, error: 'internal error' }, 500)
    }
  }

  // ── default action: create the intent + attempt ─────────────────────────
  const req_: CreateBulkPayIntentRequest = {
    walletAddress: typeof b.walletAddress === 'string' ? b.walletAddress : '',
    idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : '',
    chainId: typeof b.chainId === 'string' ? b.chainId : 'arc',
    amountAtomic: typeof b.amountAtomic === 'string' ? b.amountAtomic : '0',
    decimals: typeof b.decimals === 'number' ? b.decimals : 18,
    isNative: typeof b.isNative === 'boolean' ? b.isNative : true,
    tokenAddress: typeof b.tokenAddress === 'string' ? b.tokenAddress : null,
    tokenSymbol: typeof b.tokenSymbol === 'string' ? b.tokenSymbol : null,
    recipientCount: typeof b.recipientCount === 'number' ? b.recipientCount : 0,
    purpose: typeof b.purpose === 'string' ? b.purpose : null,
  }
  const nonceFetcher = makeLiveNonceFetcher()

  try {
    const result = await createBulkPayIntent(repo, nonceFetcher, req_)
    if (result.outcome === 'invalid_request') return json({ success: false, error: result.reason }, 400)
    return json({ success: true, ...result })
  } catch (e) {
    console.error('[bulkpay-intent] failed:', e instanceof Error ? e.message : e)
    return json({ success: false, error: 'internal error' }, 500)
  }
})
