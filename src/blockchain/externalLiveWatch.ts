/**
 * externalLiveWatch.ts - session-wide catch-up for USDC landing on other chains.
 *
 * The indexer's chain_events → Realtime path (shadowEventBus) only reaches an
 * app that is connected when the event is published. The usual way money
 * arrives on another chain is the person switching to a different wallet app
 * (or the faucet) to send it - the phone suspends this app and its socket, the
 * event is published while it's away, and nothing replays it on return. The
 * pages also only re-scanned every few minutes, so the balance looked stuck.
 *
 * Same idea as arcDepositWatcher's catch-up on resume, for external chains:
 *   - coming back to the app (hidden ≥ 3s): re-read now, and again a little
 *     later - a deposit sent just before switching back may still be landing;
 *   - while visible: re-read every 30s.
 * One fresh /api/portfolio read each time (past the 90s scan cache), and only
 * chains whose balance actually changed are announced on
 * EXTERNAL_BALANCE_EVENT, which every external-balance screen already applies.
 */
import { readExternalBalances, refreshScope, EXTERNAL_BALANCE_EVENT, EXTERNAL_LIVE_POLL_MS } from './BlockchainManager'
import type { SettingsMap } from '@/lib/adminSupabase'

const RESUME_MIN_HIDDEN_MS = 3_000
const RESUME_FOLLOW_UPS_MS = [15_000, 40_000]

export function startExternalLiveWatch(
  wallet: string,
  getSettings: () => { settings: SettingsMap; loaded: boolean },
): () => void {
  let stopped = false
  let inFlight = false
  let last: Record<string, number> | null = null
  let hiddenAt = 0
  const timers: Array<ReturnType<typeof setTimeout>> = []

  const scan = async () => {
    if (stopped || inFlight || document.visibilityState !== 'visible') return
    inFlight = true
    try {
      const { settings, loaded } = getSettings()
      refreshScope({ kind: 'external', wallet })
      const { chains } = await readExternalBalances(wallet, settings, loaded)
      if (stopped) return
      const next: Record<string, number> = {}
      for (const c of chains) next[c.chainId] = c.balance
      if (last) {
        for (const [chainId, balance] of Object.entries(next)) {
          if (Math.abs(balance - (last[chainId] ?? 0)) > 1e-9) {
            window.dispatchEvent(new CustomEvent(EXTERNAL_BALANCE_EVENT, { detail: { chainId, balance } }))
          }
        }
      }
      last = next
    } catch { /* keep what's shown; the next tick retries */ } finally {
      inFlight = false
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
    if (!hiddenAt || Date.now() - hiddenAt < RESUME_MIN_HIDDEN_MS) return
    hiddenAt = 0
    void scan()
    for (const ms of RESUME_FOLLOW_UPS_MS) timers.push(setTimeout(() => { void scan() }, ms))
  }

  void scan() // seed the baseline
  const every = setInterval(() => { void scan() }, EXTERNAL_LIVE_POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onVisibility)

  return () => {
    stopped = true
    clearInterval(every)
    for (const t of timers) clearTimeout(t)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pageshow', onVisibility)
  }
}
