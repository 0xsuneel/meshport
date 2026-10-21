// supabase/functions/indexer-fast/index.ts
//
// The busy external chains, watched the way wallet backends (MetaMask, OKX)
// watch for incoming money: a server that keeps asking each chain for USDC
// transfers to its users' addresses. blockchain-indexer reads every chain
// once a minute (a full pass takes ~25s), so a deposit on Ethereum or Base
// reached chain_events - and the app's balance, over Realtime - up to a
// minute after its block. This runs the same per-chain pass (indexChain) on
// those chains every 4s for ~55s of each once-a-minute call, so it arrives
// seconds after its block.
//
// One loop at a time (indexer_fast_lock). blockchain-indexer's minute pass
// still covers these chains too; two writers on a chain cursor cannot lose
// an event - each writes only the end of a range it scanned, and chain_events
// is unique per (tx, wallet, log), so an overlap is at most a repeat read.
//
// Scheduled job only (pg_cron, same caller secret as blockchain-indexer).
// TESTNET ONLY.
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { enabledChains } from '../blockchain-indexer/chains.ts'
import { indexChain, loadKnownWallets } from '../blockchain-indexer/indexChain.ts'

// The chains MeshPort's Bring / Transfer flows use most.
const FAST_CHAIN_IDS = new Set(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia', 'optimism-sepolia', 'polygon-amoy', 'avalanche-fuji', 'unichain-sepolia'])
const LOOP_MS = 55_000
const PASS_MS = 4_000
// New sign-ups are watched within this long.
const WALLETS_REFRESH_MS = 15_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (!isCronOrLegacyServiceCaller(req)) return json({ error: 'Forbidden' }, 403)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )
  const chains = enabledChains().filter(c => FAST_CHAIN_IDS.has(c.id))
  if (chains.length === 0) return json({ ok: true, note: 'no fast chains enabled' })

  const { data: got, error } = await supabase.rpc('indexer_fast_lock_acquire', { p_seconds: 70 })
  if (error) return json({ ok: false, error: error.message }, 500)
  if (got !== true) return json({ ok: true, skipped: 'busy' })

  // Each chain loops on its own: a pass waits on every RPC endpoint of its
  // chain (up to 8s for a slow one), so one slow chain must not hold the
  // others back.
  let wallets = await loadKnownWallets(supabase)
  let walletsAt = Date.now()
  let refreshing: Promise<void> | null = null
  const currentWallets = async () => {
    if (Date.now() - walletsAt > WALLETS_REFRESH_MS && !refreshing) {
      refreshing = loadKnownWallets(supabase).then(fresh => { if (fresh.size) wallets = fresh; walletsAt = Date.now() })
        .finally(() => { refreshing = null })
    }
    return wallets
  }
  const end = Date.now() + LOOP_MS
  const loop = Promise.all(chains.map(async chain => {
    for (;;) {
      const t0 = Date.now()
      const w = await currentWallets()
      if (w.size) {
        const r = await indexChain(supabase, chain, w)
        const took = Date.now() - t0
        if (took > 2 * PASS_MS) console.info(`[indexer-fast] ${chain.id} pass ${took}ms`, r.error ?? r.action ?? r.window ?? '')
      }
      const wait = Math.max(0, PASS_MS - (Date.now() - t0))
      if (Date.now() + wait >= end) break
      if (wait) await new Promise(r => setTimeout(r, wait))
    }
  }))
    .catch(e => console.error('[indexer-fast] loop failed:', e instanceof Error ? e.message : e))
    .finally(() => supabase.rpc('indexer_fast_lock_release').then(() => {}, () => {}))

  // In the background - the cron caller hangs up after a few seconds.
  // @ts-ignore - EdgeRuntime is available in the Supabase Edge Functions runtime
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    // @ts-ignore - see above
    EdgeRuntime.waitUntil(loop)
    return json({ ok: true, started: true, chains: chains.map(c => c.id) })
  }
  await loop
  return json({ ok: true, done: true })
})
