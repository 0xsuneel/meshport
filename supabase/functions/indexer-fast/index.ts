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
import { indexChain, anyKnownWallet, sqlWalletMatcher } from '../blockchain-indexer/indexChain.ts'
import { createCursorCache } from '../blockchain-indexer/cursorCache.ts'
import { cursorDb } from '../blockchain-indexer/cursors.ts'

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
// A chain whose endpoints keep failing (a testnet RPC down for hours) is
// rested instead of retried every 4s: each failed pass also writes its error
// to chain_cursors at once. 8s after the first failure, doubling to at most
// 2 minutes; the first good pass clears it. Kept across calls while this
// worker stays warm. blockchain-indexer's minute pass still reads the chain.
const BACKOFF_BASE_MS = 8_000
const BACKOFF_MAX_MS = 120_000
const chainRest = new Map<string, { fails: number; until: number }>()
const failedPass = (r: Record<string, unknown>) => !!r.error || r.action === 'no_progress'

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
      if (!got) await new Promise(r => setTimeout(r, 3_000))
    }
    if (!got) { console.warn(`[indexer-fast] ${group}: previous loop still running - skipped`); return }
    // Cursors kept in memory for this run, saved every 30 s per chain and at
    // the end (cursorCache.ts) - they were read and written on every 4 s pass.
    const cursors = createCursorCache(cursorDb(supabase))
    try {
      // Each chain loops on its own: a pass waits on every RPC endpoint of
      // its chain (up to 8s for a slow one), so one slow chain must not hold
      // the others back.
      // Recipients are matched in SQL per pass (only addresses seen on
      // chain), so this no longer reloads every user's wallet every 15 s.
      if (!(await anyKnownWallet(supabase))) return
      const wallets = sqlWalletMatcher(supabase)
      // Every chain's cursor in one read.
      await cursors.preload(chains.map(c => c.id))
      const end = callStart + LOOP_MS
      await Promise.all(chains.map(async chain => {
        for (;;) {
          const t0 = Date.now()
          const rest = chainRest.get(chain.id)
          if (!(rest && rest.until > t0)) {
            const r = await indexChain(supabase, chain, wallets, cursors)
            const took = Date.now() - t0
            if (took > 2 * PASS_MS) console.info(`[indexer-fast] ${chain.id} pass ${took}ms`, r.error ?? r.action ?? r.window ?? '')
            if (failedPass(r)) {
              const fails = (rest?.fails ?? 0) + 1
              const ms = Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_MAX_MS)
              chainRest.set(chain.id, { fails, until: Date.now() + ms })
              if (fails === 1 || ms === BACKOFF_MAX_MS) console.warn(`[indexer-fast] ${chain.id} failing (${fails}x) - resting ${ms / 1000}s`)
            } else if (rest) chainRest.delete(chain.id)
          }
          const wait = Math.max(0, PASS_MS - (Date.now() - t0))
          if (Date.now() + wait >= end) break
          if (wait) await new Promise(r => setTimeout(r, wait))
        }
      }))
    } finally {
      // Save every cursor before the next run takes over (it reads them first).
      await cursors.flushAll().catch(e => console.error('[indexer-fast] cursor flush failed:', e instanceof Error ? e.message : e))
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
