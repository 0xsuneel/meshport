// supabase/functions/swap-intent/index.ts
//
// Real entry point for createSwapIntent (logic.ts). Mirrors
// supabase/functions/pay-intent/index.ts byte-for-byte in structure -- the
// same production-validated wiring, applied to Swap.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createSwapIntent, markSwapAttemptSubmitted } from './logic.ts'
import type { IntentRepository, NonceFetcher, CreateSwapIntentRequest } from './logic.ts'

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
      if (error) console.error('[swap-intent] transitionIntentToSubmitted failed:', error.message)
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
      if (error) { console.error('[swap-intent] reclaimStaleAttempt failed:', error.message); return false }
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

  if (b.action === 'markSubmitted') {
    const attemptId = typeof b.attemptId === 'string' ? b.attemptId : ''
    const txHash = typeof b.txHash === 'string' ? b.txHash : ''
    try {
      const result = await markSwapAttemptSubmitted(repo, attemptId, txHash)
      if (result.outcome === 'invalid_request') return json({ success: false, error: result.reason }, 400)
      return json({ success: true })
    } catch (e) {
      console.error('[swap-intent] markSubmitted failed:', e instanceof Error ? e.message : e)
      return json({ success: false, error: 'internal error' }, 500)
    }
  }

  const req_: CreateSwapIntentRequest = {
    walletAddress: typeof b.walletAddress === 'string' ? b.walletAddress : '',
    idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : '',
    chainId: typeof b.chainId === 'string' ? b.chainId : 'arc',
    amountInAtomic: typeof b.amountInAtomic === 'string' ? b.amountInAtomic : '0',
    decimalsIn: typeof b.decimalsIn === 'number' ? b.decimalsIn : 6,
    tokenInAddress: typeof b.tokenInAddress === 'string' ? b.tokenInAddress : null,
    tokenInSymbol: typeof b.tokenInSymbol === 'string' ? b.tokenInSymbol : null,
    isNativeIn: typeof b.isNativeIn === 'boolean' ? b.isNativeIn : false,
    tokenOutAddress: typeof b.tokenOutAddress === 'string' ? b.tokenOutAddress : null,
    tokenOutSymbol: typeof b.tokenOutSymbol === 'string' ? b.tokenOutSymbol : null,
    decimalsOut: typeof b.decimalsOut === 'number' ? b.decimalsOut : 6,
    minAmountOutAtomic: typeof b.minAmountOutAtomic === 'string' ? b.minAmountOutAtomic : null,
    expectedAmountOutAtomic: typeof b.expectedAmountOutAtomic === 'string' ? b.expectedAmountOutAtomic : null,
    slippageBps: typeof b.slippageBps === 'number' ? b.slippageBps : null,
    routerAddress: typeof b.routerAddress === 'string' ? b.routerAddress : null,
  }
  const nonceFetcher = makeLiveNonceFetcher()

  try {
    const result = await createSwapIntent(repo, nonceFetcher, req_)
    if (result.outcome === 'invalid_request') return json({ success: false, error: result.reason }, 400)
    return json({ success: true, ...result })
  } catch (e) {
    console.error('[swap-intent] failed:', e instanceof Error ? e.message : e)
    return json({ success: false, error: 'internal error' }, 500)
  }
})
