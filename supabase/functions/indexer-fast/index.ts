// supabase/functions/indexer-fast/index.ts
//
// The external chains, watched the way wallet backends (MetaMask, OKX)
// watch for incoming money: a server that keeps asking each chain for USDC
// transfers to its users' addresses. blockchain-indexer reads every chain
// once a minute (a full pass takes ~25s), so a deposit on Ethereum or Base
// reached chain_events - and the app's balance, over Realtime - up to a
// minute after its block. This runs the same per-chain pass (indexChain) on
// every external chain every 4s, for ~57s of each once-a-minute call, so it
// arrives seconds after its block.
//
// One loop per group at a time (job_locks 'indexer-fast:<group>'; each call
// takes over when the last one finishes). blockchain-indexer's minute pass still covers these chains; two writers on a chain cursor cannot lose
// an event - each writes only the end of a range it scanned, and chain_events
// is unique per (tx, wallet, log), so an overlap is at most a repeat read.
//
// Scheduled job only (pg_cron, same caller secret as blockchain-indexer).
// TESTNET ONLY.
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { enabledChains } from '../blockchain-indexer/chains.ts'
import { indexChain, loadKnownWallets } from '../blockchain-indexer/indexChain.ts'

// Every external chain (Arc has its own 2s transfer watch in
// chain-transfer-webhook, and the indexer's Arc pass reads whole blocks).
// Each chain loops on its own, so a testnet with slow endpoints only slows
// itself. Two workers, one cron job each: the busy chains ({} or
// {group:'busy'}) and the rest ({group:'rest'}) - all 21 in one worker used
// ~1.3s of the ~2s CPU an Edge Function run gets.
const BUSY = new Set(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia', 'optimism-sepolia', 'polygon-amoy', 'avalanche-fuji', 'unichain-sepolia'])
const inGroup = (group: 'busy' | 'rest', chainId: string) =>
  chainId !== 'arc' && (group === 'busy' ? BUSY.has(chainId) : !BUSY.has(chainId))
const LOOP_MS = 57_000
const HANDOVER_WAIT_MS = 20_000
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
  let group: 'busy' | 'rest' = 'busy'
  try { if ((await req.json())?.group === 'rest') group = 'rest' } catch { /* no body: busy */ }
  const chains = enabledChains().filter(c => inGroup(group, c.id))
  if (chains.length === 0) return json({ ok: true, note: `no ${group} chains enabled` })
  const lockName = `indexer-fast:${group}`

  // Runs until ~57s after this call; the next minute's call waits (up to
  // 20s) for this one to finish its last pass, so the loops hand over without
  // a gap or an overlap - and a slow last pass never makes a minute skip.
  const callStart = Date.now()
  const loop = (async () => {
    let got = false
    while (!got && Date.now() - callStart < HANDOVER_WAIT_MS) {
      const { data, error } = await supabase.rpc('job_lock_acquire', { p_name: lockName, p_seconds: 70 })
      if (error) { console.error('[indexer-fast] lock failed:', error.message); return }
      got = data === true
      if (!got) await new Promise(r => setTimeout(r, 1_000))
    }
    if (!got) { console.warn(`[indexer-fast] ${group}: previous loop still running - skipped`); return }
    try {
      // Each chain loops on its own: a pass waits on every RPC endpoint of
      // its chain (up to 8s for a slow one), so one slow chain must not hold
      // the others back.
      let wallets = await loadKnownWallets(supabase)
      let walletsAt = Date.now()
      let refreshing: Promise<void> | null = null
      const currentWallets = () => {
        if (Date.now() - walletsAt > WALLETS_REFRESH_MS && !refreshing) {
          refreshing = loadKnownWallets(supabase).then(fresh => { if (fresh.size) wallets = fresh; walletsAt = Date.now() })
            .finally(() => { refreshing = null })
        }
        return wallets
      }
      const end = callStart + LOOP_MS
      await Promise.all(chains.map(async chain => {
        for (;;) {
          const t0 = Date.now()
          const w = currentWallets()
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
    } finally {
      await supabase.rpc('job_lock_release', { p_name: lockName }).then(() => {}, () => {})
    }
  })().catch(e => console.error('[indexer-fast] loop failed:', e instanceof Error ? e.message : e))

  // In the background - the cron caller hangs up after a few seconds.
  // @ts-ignore - EdgeRuntime is available in the Supabase Edge Functions runtime
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    // @ts-ignore - see above
    EdgeRuntime.waitUntil(loop)
    return json({ ok: true, started: true, group, chains: chains.map(c => c.id) })
  }
  await loop
  return json({ ok: true, done: true })
})
