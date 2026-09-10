/**
 * verify-sync-coordinator.ts — Phase 6 event-driven refresh.
 *
 * Asserts the whole decision table plus the safety properties that make it
 * deployable: coalescing, dedupe/subsumption, the kill switch, and the refusal
 * to ever emit a wallet-wide 'all' scope for a chain event.
 *
 * Inputs are the real event vocabulary from blockchain/events.ts and the real
 * chain_events column contract from shadowEventMap.ts. No browser, no network,
 * no database — the coordinator's impure half is injected.
 *
 * Run: npx tsx scripts/verify-sync-coordinator.ts
 */
import {
  scopesFor, dedupeScopes, scopeKey, triggerFor, createSyncCoordinator,
  COALESCE_WINDOW_MS, scopesForResume, RESUME_MIN_MS, RESUME_EXTERNAL_MS,
  scopesForActivityRow,
} from '../src/blockchain/SyncCoordinator'
import { mapChainEventRow } from '../src/blockchain/shadowEventMap'
import type { RefreshScope, RefreshTrigger } from '../src/blockchain/types'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const OTHER  = '0xfe2ac69fe72e91f1642e98ce0cdf55b8d1800e43'

/** Build a ShadowEvent through the REAL row mapper, so the column contract is exercised. */
function ev(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 1,
    chain_id: 'arc',
    event_type: 'deposit_detected',
    wallet_address: WALLET,
    tx_hash: '0xbdded45c789fe2dacb0dc258392f431acf24c62ac273be39efab47ff2e3f8f77',
    block_number: 57218424,
    status: 'confirmed',
    created_at: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  }
  const mapped = mapChainEventRow(base, 1_700_000_000_500)
  // `assets` is not part of ShadowEvent but IS on the row; the coordinator
  // reads it defensively for the ERC-20 case.
  if (base.assets) (mapped as unknown as { assets: unknown }).assets = base.assets
  return mapped
}

const keys = (s: RefreshScope[]) => s.map(scopeKey).sort()

console.log('\n══ A. Decision table — one event -> exact scopes ══')
{
  const dep = scopesFor(ev({ event_type: 'deposit_detected' }))
  check('deposit_detected -> arc + history',
    keys(dep).join('|') === [`arc:${WALLET}`, `history:${WALLET}`].sort().join('|'),
    keys(dep).join(', '))

  const erc = scopesFor(ev({ event_type: 'transfer_detected', assets: ['EURC'] }))
  check('transfer_detected(EURC) -> per-ASSET scope + history',
    keys(erc).join('|') === [`asset:${WALLET}:arc:EURC`, `history:${WALLET}`].sort().join('|'),
    keys(erc).join(', '))

  const ercNoAsset = scopesFor(ev({ event_type: 'transfer_detected' }))
  check('transfer_detected with no assets[] falls back to chain scope, not asset',
    keys(ercNoAsset).includes(`chain:${WALLET}:arc`), keys(ercNoAsset).join(', '))

  const conf = scopesFor(ev({ event_type: 'transaction_confirmed' }))
  check('transaction_confirmed -> chain + claims + history',
    keys(conf).join('|') === [`chain:${WALLET}:arc`, `claims:${WALLET}`, `history:${WALLET}`].sort().join('|'),
    keys(conf).join(', '))

  const failed = scopesFor(ev({ event_type: 'transaction_failed' }))
  check('transaction_failed -> history ONLY (no value moved, no balance drop)',
    keys(failed).join('|') === `history:${WALLET}`, keys(failed).join(', '))

  const balArc = scopesFor(ev({ event_type: 'balance_changed', chain_id: 'arc' }))
  check('balance_changed(arc) -> arc scope', keys(balArc).join('|') === `arc:${WALLET}`,
    keys(balArc).join(', '))

  const balExt = scopesFor(ev({ event_type: 'balance_changed', chain_id: 'base-sepolia' }))
  check('balance_changed(non-arc) -> chain + external aggregate',
    keys(balExt).join('|') === [`chain:${WALLET}:base-sepolia`, `external:${WALLET}:base-sepolia`].sort().join('|'),
    keys(balExt).join(', '))
}

console.log('\n══ B. Safety: never a wallet-wide drop, never an unattributed refresh ══')
{
  const allTypes = ['deposit_detected', 'transfer_detected', 'transaction_confirmed',
                    'transaction_failed', 'balance_changed']
  const everyScope = allTypes.flatMap(t => scopesFor(ev({ event_type: t, assets: ['EURC'] })))
  check("NO event type ever emits {kind:'all'}",
    everyScope.every(s => s.kind !== 'all'),
    `${everyScope.length} scopes across ${allTypes.length} event types`)

  check('unknown event_type -> [] (degrades to polling, never a stampede)',
    scopesFor(ev({ event_type: 'something_new_from_the_server' })).length === 0)

  check('event with null wallet_address -> [] (unattributable)',
    scopesFor(ev({ wallet_address: null })).length === 0)

  check('event with empty wallet_address -> []',
    scopesFor(ev({ wallet_address: '' })).length === 0)

  const mixedCase = scopesFor(ev({ wallet_address: WALLET.toUpperCase() }))
  check('wallet address is lowercased before use as a cache key',
    mixedCase.every(s => s.wallet === WALLET), mixedCase[0]?.wallet)

  check('triggers are attributed for telemetry',
    triggerFor('deposit_detected') === 'deposit-detected' &&
    triggerFor('transaction_confirmed') === 'tx-confirmed' &&
    triggerFor('balance_changed') === 'chain-event')
}

console.log('\n══ C. Dedupe / subsumption ══')
{
  const burst: RefreshScope[] = [
    { kind: 'arc', wallet: WALLET }, { kind: 'history', wallet: WALLET },
    { kind: 'arc', wallet: WALLET }, { kind: 'history', wallet: WALLET },
    { kind: 'arc', wallet: WALLET }, { kind: 'history', wallet: WALLET },
  ]
  const merged = dedupeScopes(burst)
  check('a 3-deposit burst collapses to 2 scopes, not 6', merged.length === 2,
    keys(merged).join(', '))

  const subsumedArc = dedupeScopes([
    { kind: 'arc', wallet: WALLET },
    { kind: 'asset', wallet: WALLET, chain: 'arc', asset: 'USDC' },
  ])
  check('an arc-wide drop subsumes a per-asset arc drop', subsumedArc.length === 1 &&
    subsumedArc[0].kind === 'arc', keys(subsumedArc).join(', '))

  const subsumedChain = dedupeScopes([
    { kind: 'chain', wallet: WALLET, chain: 'base-sepolia' },
    { kind: 'asset', wallet: WALLET, chain: 'base-sepolia', asset: 'USDC' },
  ])
  check('a chain drop subsumes a per-asset drop on the same chain',
    subsumedChain.length === 1 && subsumedChain[0].kind === 'chain',
    keys(subsumedChain).join(', '))

  const twoWallets = dedupeScopes([
    { kind: 'arc', wallet: WALLET },
    { kind: 'asset', wallet: OTHER, chain: 'arc', asset: 'USDC' },
  ])
  check('subsumption is per-wallet — another wallet is NOT swallowed',
    twoWallets.length === 2, keys(twoWallets).join(', '))

  const differentAssets = dedupeScopes([
    { kind: 'asset', wallet: WALLET, chain: 'arc', asset: 'EURC' },
    { kind: 'asset', wallet: WALLET, chain: 'arc', asset: 'cirBTC' },
  ])
  check('distinct assets on one chain are both preserved', differentAssets.length === 2,
    keys(differentAssets).join(', '))
}

console.log('\n══ D. Coalescing + kill switch + fault isolation ══')
{
  // Manual scheduler so the burst window is deterministic.
  let queued: (() => void) | null = null
  const sched = (fn: () => void) => { queued = fn; return 1 }
  const seen: Array<{ key: string; trigger: RefreshTrigger }> = []

  const coord = createSyncCoordinator({
    applyScope: (s, t) => seen.push({ key: scopeKey(s), trigger: t }),
    schedule: sched,
    log: () => {},
  })

  coord.handle(ev({ id: 1 }))
  coord.handle(ev({ id: 2 }))
  coord.handle(ev({ id: 3 }))
  check('nothing applied before the coalesce window flushes', seen.length === 0,
    `${seen.length} applied`)
  check('window is short enough to stay imperceptible', COALESCE_WINDOW_MS <= 500,
    `${COALESCE_WINDOW_MS}ms`)

  queued!()
  check('after flush, 3 deposits produced exactly 2 invalidations', seen.length === 2,
    seen.map(s => s.key).join(', '))
  check('trigger is attributed as deposit-detected',
    seen.every(s => s.trigger === 'deposit-detected'))
  const st = coord.stats()
  check('stats report received/applied/coalesced',
    st.received === 3 && st.applied === 2 && st.coalesced === 4,
    `received=${st.received} applied=${st.applied} coalesced=${st.coalesced}`)

  // Kill switch — observer mode must apply NOTHING but still log.
  let q2: (() => void) | null = null
  const logs: string[] = []
  const applied: string[] = []
  const observer = createSyncCoordinator({
    applyScope: s => applied.push(scopeKey(s)),
    schedule: fn => { q2 = fn; return 1 },
    log: m => logs.push(m),
    enabled: false,
  })
  observer.handle(ev({ id: 9 }))
  q2!()
  check('enabled:false applies NOTHING (rollback path, no redeploy)', applied.length === 0)
  check('enabled:false still logs what it WOULD do (observable)',
    logs.some(l => l.includes('WOULD refresh')), logs[0] ?? '(none)')

  // A throwing applyScope must not break the stream.
  let q3: (() => void) | null = null
  const errs: string[] = []
  const boom = createSyncCoordinator({
    applyScope: () => { throw new Error('cache exploded') },
    schedule: fn => { q3 = fn; return 1 },
    log: m => errs.push(m),
  })
  boom.handle(ev({ id: 10 }))
  let threw = false
  try { q3!() } catch { threw = true }
  check('a throwing applyScope does NOT propagate (polling still covers it)', !threw)
  check('the failure is logged rather than swallowed silently',
    errs.some(l => l.includes('applyScope threw')), errs[0] ?? '(none)')

  // flush() with nothing pending must be a no-op.
  const idle = createSyncCoordinator({ applyScope: () => { throw new Error('should not run') }, log: () => {} })
  let idleThrew = false
  try { idle.flush() } catch { idleThrew = true }
  check('flush() with an empty queue is a safe no-op', !idleThrew)
}

console.log('\n══ E. Real-world sequences ══')
{
  // The verified 20 USDC wrapper deposit (0xbdded45c…, block 57218424).
  const real = scopesFor(ev({
    event_type: 'deposit_detected',
    tx_hash: '0xbdded45c789fe2dacb0dc258392f431acf24c62ac273be39efab47ff2e3f8f77',
    block_number: 57218424,
  }))
  check('the real wrapper-USDC deposit refreshes Arc balance and Activity',
    keys(real).join('|') === [`arc:${WALLET}`, `history:${WALLET}`].sort().join('|'),
    keys(real).join(', '))

  // A claim settling: confirmation must reach the Claim page's own bucket.
  const claim = scopesFor(ev({ event_type: 'transaction_confirmed' }))
  check('a settling claim invalidates the claims bucket (Multichain Claim page)',
    claim.some(s => s.kind === 'claims'), keys(claim).join(', '))

  // Two wallets in one burst must not cross-invalidate.
  let q: (() => void) | null = null
  const got: string[] = []
  const c = createSyncCoordinator({
    applyScope: s => got.push(scopeKey(s)),
    schedule: fn => { q = fn; return 1 },
    log: () => {},
  })
  c.handle(ev({ wallet_address: WALLET }))
  c.handle(ev({ wallet_address: OTHER }))
  q!()
  check('a two-wallet burst invalidates both wallets, neither merged away',
    got.some(k => k.includes(WALLET)) && got.some(k => k.includes(OTHER)),
    got.join(', '))
  check('and emits no cross-wallet scope', got.length === 4, got.join(', '))
}

console.log('\n══ F. Resume policy — proposal §19 ══')
{
  const MIN = 60_000
  // The whole point of the rule: a short absence must cost NOTHING.
  check('resume after 0s -> no refresh', scopesForResume(0, WALLET).length === 0)
  check('resume after 30s -> no refresh', scopesForResume(30_000, WALLET).length === 0)
  check('resume after 4m59s -> STILL no refresh (under the 5m threshold)',
    scopesForResume(RESUME_MIN_MS - 1_000, WALLET).length === 0,
    `${(RESUME_MIN_MS - 1_000) / 1000}s`)

  // At 5 minutes: arc + claims, but NOT the expensive external scan.
  const at5 = scopesForResume(RESUME_MIN_MS, WALLET)
  check('resume at exactly 5m -> arc + claims',
    keys(at5).join('|') === [`arc:${WALLET}`, `claims:${WALLET}`].sort().join('|'),
    keys(at5).join(', '))
  check('  and NOT external at 5m (the expensive scan stays gated)',
    !at5.some(s => s.kind === 'external'))

  const at7 = scopesForResume(7 * MIN, WALLET)
  check('resume at 7m -> still arc + claims only', at7.length === 2, keys(at7).join(', '))

  // At 10 minutes: external joins.
  const at10 = scopesForResume(RESUME_EXTERNAL_MS, WALLET)
  check('resume at exactly 10m -> arc + claims + external',
    keys(at10).join('|') === [`arc:${WALLET}`, `claims:${WALLET}`, `external:${WALLET}:`].sort().join('|'),
    keys(at10).join(', '))
  check('resume at 45m -> same three scopes, never more',
    scopesForResume(45 * MIN, WALLET).length === 3)

  // Never a wallet-wide drop: a resume is not a login.
  for (const ms of [0, 5 * MIN, 10 * MIN, 60 * MIN, 24 * 60 * MIN]) {
    check(`resume at ${ms / MIN}m never emits {kind:'all'}`,
      !scopesForResume(ms, WALLET).some(s => s.kind === 'all'))
  }

  // Untrustworthy clocks must not trigger the expensive path.
  check('negative elapsed (clock skew / frozen tab) -> no refresh',
    scopesForResume(-5_000, WALLET).length === 0)
  check('NaN elapsed -> no refresh', scopesForResume(NaN, WALLET).length === 0)
  check('missing wallet -> no refresh', scopesForResume(30 * MIN, '').length === 0)
  check('resume lowercases the wallet for cache-key use',
    scopesForResume(30 * MIN, WALLET.toUpperCase()).every(s => s.wallet === WALLET))

  // handleResume applies immediately — no coalescing, since a resume is one
  // discrete moment and the user is looking at the screen.
  const seen: Array<{ key: string; trigger: string }> = []
  let scheduled = 0
  const coord = createSyncCoordinator({
    applyScope: (s, t) => seen.push({ key: scopeKey(s), trigger: t }),
    schedule: fn => { scheduled++; return fn as unknown as number },
    log: () => {},
  })
  coord.handleResume(12 * MIN, WALLET)
  check('handleResume applies WITHOUT waiting for the coalesce window',
    seen.length === 3 && scheduled === 0, `${seen.length} applied, ${scheduled} timers`)
  check("  attributed with trigger 'resume'", seen.every(s => s.trigger === 'resume'),
    seen[0]?.trigger)

  // A short resume must apply nothing at all.
  const short: string[] = []
  const c2 = createSyncCoordinator({ applyScope: s => short.push(scopeKey(s)), log: () => {} })
  c2.handleResume(10_000, WALLET)
  check('handleResume under 5m applies nothing', short.length === 0)

  // Kill switch covers resume too.
  const obsApplied: string[] = []
  const obsLogs: string[] = []
  const obs = createSyncCoordinator({
    applyScope: s => obsApplied.push(scopeKey(s)),
    log: m => obsLogs.push(m), enabled: false,
  })
  obs.handleResume(30 * MIN, WALLET)
  check('observer mode applies nothing on resume', obsApplied.length === 0)
  check('observer mode still logs the resume it WOULD do',
    obsLogs.some(l => l.includes('WOULD refresh')), obsLogs[0] ?? '(none)')

  // A throwing applyScope must not break resume handling.
  let resumeThrew = false
  const boom = createSyncCoordinator({
    applyScope: () => { throw new Error('cache exploded') }, log: () => {},
  })
  try { boom.handleResume(30 * MIN, WALLET) } catch { resumeThrew = true }
  check('a throwing applyScope does not propagate out of handleResume', !resumeThrew)

  check('thresholds match the spec (5m / 10m)',
    RESUME_MIN_MS === 300_000 && RESUME_EXTERNAL_MS === 600_000,
    `${RESUME_MIN_MS}ms / ${RESUME_EXTERNAL_MS}ms`)
}

console.log('\n══ G. Phase 6 ordering fix — activity INSERT (real production sequence) ══')
{
  /**
   * Reproduces the measured 2026-08-18 sequence exactly:
   *   03:02:07.582  chain_events 75 (EURC) + 76 (cirBTC) INSERT
   *   03:03:00.737  activity rows written by activity-consumer, +53s later
   * Before this fix the history refresh happened only at 03:02:07, when no
   * activity row existed, so EURC/cirBTC stayed invisible until the 60s poll.
   */
  const actRow = (o: Record<string, unknown> = {}) => ({
    id: 'a-1', wallet_address: WALLET, activity_type: 'receive',
    token_symbol: 'USDC', amount: 20, status: 'completed',
    tx_hash: 'recv_0xabc', metadata: { source: 'activity-consumer' }, ...o,
  })

  // ── the decision table for activity rows ────────────────────────────────
  const usdc = scopesForActivityRow(actRow({ token_symbol: 'USDC' }))
  check('USDC receive -> arc + history (native bucket)',
    keys(usdc).join('|') === [`arc:${WALLET}`, `history:${WALLET}`].sort().join('|'),
    keys(usdc).join(', '))

  const eurc = scopesForActivityRow(actRow({ token_symbol: 'EURC', amount: 20 }))
  check('EURC receive -> per-asset scope + history',
    keys(eurc).join('|') === [`asset:${WALLET}:arc:EURC`, `history:${WALLET}`].sort().join('|'),
    keys(eurc).join(', '))

  const cir = scopesForActivityRow(actRow({ token_symbol: 'cirBTC', amount: 0.0001 }))
  check('cirBTC receive -> per-asset scope + history',
    keys(cir).join('|') === [`asset:${WALLET}:arc:cirBTC`, `history:${WALLET}`].sort().join('|'),
    keys(cir).join(', '))

  check('history is ALWAYS invalidated for a receive (the actual bug fixed)',
    [usdc, eurc, cir].every(s => s.some(x => x.kind === 'history')))
  check('activity mapping never emits {kind:\'all\'}',
    [usdc, eurc, cir].every(s => s.every(x => x.kind !== 'all')))

  // ── narrow by design ────────────────────────────────────────────────────
  for (const t of ['swap', 'send', 'p2p_purchase', 'bulk', 'claim', 'p2p_refund']) {
    check(`client-authored/other type '${t}' -> [] (not our gap)`,
      scopesForActivityRow(actRow({ activity_type: t })).length === 0)
  }
  check('non-completed receive -> [] (speculative, wait for settle)',
    scopesForActivityRow(actRow({ status: 'pending' })).length === 0)
  check('missing wallet_address -> []',
    scopesForActivityRow(actRow({ wallet_address: null })).length === 0)
  check('wallet is lowercased for cache-key use',
    scopesForActivityRow(actRow({ wallet_address: WALLET.toUpperCase() })).every(s => s.wallet === WALLET))
  check('malformed row (empty object) -> [], never throws',
    scopesForActivityRow({}).length === 0)
  check('receive with no status still credits (status optional)',
    scopesForActivityRow({ wallet_address: WALLET, activity_type: 'receive', token_symbol: 'USDC' }).length === 2)

  // ── THE PRODUCTION SEQUENCE, end to end ─────────────────────────────────
  let q: (() => void) | null = null
  const seen: Array<{ key: string; trigger: string }> = []
  const coord = createSyncCoordinator({
    applyScope: (s, t) => seen.push({ key: scopeKey(s), trigger: t }),
    schedule: fn => { q = fn; return 1 },
    log: () => {},
  })

  // T+0: chain_events for EURC and cirBTC arrive (activity does NOT exist yet).
  coord.handle(ev({ id: 75, event_type: 'transfer_detected', assets: ['EURC'],
                    tx_hash: '0xfcf60cc4' }))
  coord.handle(ev({ id: 76, event_type: 'transfer_detected', assets: ['cirBTC'],
                    tx_hash: '0xd9fceeb2' }))
  q!()
  const afterChainEvents = seen.length
  check('step 1: chain_events refresh fires (history invalidated, row absent)',
    seen.some(s => s.key === `history:${WALLET}`), `${afterChainEvents} scopes`)

  // T+53s: the consumer's activity rows land — a DIFFERENT flush batch.
  seen.length = 0
  q = null
  coord.handleActivityRow(actRow({ id: 'eurc-1', token_symbol: 'EURC', amount: 20 }))
  coord.handleActivityRow(actRow({ id: 'cir-1', token_symbol: 'cirBTC', amount: 0.0001 }))
  q!()

  check('step 2: activity INSERT refreshes history AGAIN, 53s later',
    seen.some(s => s.key === `history:${WALLET}`),
    seen.map(s => s.key).join(', '))
  check('  NOT suppressed by the earlier chain_events refresh',
    seen.length > 0, 'different flush batch, no cross-batch dedup')
  check('  EURC becomes visible (its asset scope refreshed)',
    seen.some(s => s.key === `asset:${WALLET}:arc:EURC`))
  check('  cirBTC becomes visible (its asset scope refreshed)',
    seen.some(s => s.key === `asset:${WALLET}:arc:cirBTC`))
  check('  attributed as deposit-detected', seen.every(s => s.trigger === 'deposit-detected'))
  check('  two rows in one consumer pass coalesce (history invalidated ONCE)',
    seen.filter(s => s.key === `history:${WALLET}`).length === 1,
    `${seen.filter(s => s.key === `history:${WALLET}`).length} history invalidations for 2 rows`)

  // A USDC receive authored by the consumer must also surface.
  seen.length = 0; q = null
  coord.handleActivityRow(actRow({ id: 'usdc-1', token_symbol: 'USDC', amount: 20 }))
  q!()
  check('  new USDC receive becomes visible', seen.some(s => s.key === `arc:${WALLET}`) &&
    seen.some(s => s.key === `history:${WALLET}`), seen.map(s => s.key).join(', '))

  // ── replay / storm safety ───────────────────────────────────────────────
  seen.length = 0; q = null
  coord.handleActivityRow(actRow({ id: 'replay-1', token_symbol: 'EURC' }))
  q!()
  const firstCount = seen.length
  seen.length = 0; q = null
  for (let i = 0; i < 20; i++) coord.handleActivityRow(actRow({ id: 'replay-1', token_symbol: 'EURC' }))
  if (q) (q as () => void)()
  check('20 replays of the SAME activity row cause NO further refresh',
    seen.length === 0, `${firstCount} first time, ${seen.length} on replay`)
  const st = coord.stats()
  check('replays are counted, not silently dropped',
    st.activityReplaysIgnored === 20, `${st.activityReplaysIgnored} ignored`)
  check('activityRows counter tracks every row seen',
    st.activityRows >= 24, `${st.activityRows}`)

  // Distinct rows must each still refresh.
  seen.length = 0; q = null
  coord.handleActivityRow(actRow({ id: 'distinct-a', token_symbol: 'EURC' }))
  coord.handleActivityRow(actRow({ id: 'distinct-b', token_symbol: 'cirBTC' }))
  q!()
  check('distinct activity rows are NOT swallowed by the replay guard',
    seen.some(s => s.key.includes('EURC')) && seen.some(s => s.key.includes('cirBTC')),
    seen.map(s => s.key).join(', '))

  // ── coalescing + fallback preserved ─────────────────────────────────────
  let timers = 0
  let q2: (() => void) | null = null
  const c2 = createSyncCoordinator({
    applyScope: () => {}, schedule: fn => { timers++; q2 = fn; return 1 }, log: () => {},
  })
  c2.handleActivityRow(actRow({ id: 'x1', token_symbol: 'EURC' }))
  c2.handleActivityRow(actRow({ id: 'x2', token_symbol: 'cirBTC' }))
  c2.handle(ev({ id: 99 }))
  check('chain_events + activity share ONE coalescing timer (no double architecture)',
    timers === 1, `${timers} timer(s) for 3 events`)
  check('  still the same 250ms window', COALESCE_WINDOW_MS === 250)
  q2!()

  // Kill switch and fault isolation must cover the new path too.
  const obsApplied: string[] = []
  const obsLogs: string[] = []
  let q3: (() => void) | null = null
  const obs = createSyncCoordinator({
    applyScope: s => obsApplied.push(scopeKey(s)),
    schedule: fn => { q3 = fn; return 1 }, log: m => obsLogs.push(m), enabled: false,
  })
  obs.handleActivityRow(actRow({ id: 'obs-1' }))
  q3!()
  check('observer mode applies nothing for activity rows', obsApplied.length === 0)
  check('  but logs what it WOULD refresh', obsLogs.some(l => l.includes('WOULD refresh')))

  let threw = false
  let q4: (() => void) | null = null
  const boom = createSyncCoordinator({
    applyScope: () => { throw new Error('cache exploded') },
    schedule: fn => { q4 = fn; return 1 }, log: () => {},
  })
  boom.handleActivityRow(actRow({ id: 'boom-1' }))
  try { q4!() } catch { threw = true }
  check('a throwing applyScope does not propagate from the activity path', !threw)
}

console.log('\n' + '='.repeat(68))
console.log(`SyncCoordinator verification: ${pass}/${pass + fail} passed`)
console.log('='.repeat(68))
console.log('\nA asserts the decision table. B asserts the safety invariants')
console.log("(never 'all', never unattributed). C asserts subsumption. D asserts")
console.log('coalescing, the kill switch and fault isolation. E replays real events.\n')
if (fail > 0) process.exit(1)
