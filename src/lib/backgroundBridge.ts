/**
 * backgroundBridge.ts — Simple bridge using Circle Forwarding Service
 *
 * Flow:
 *   1. kit.bridge() with useForwarder:true (or the adapter-submits-mint
 *      fallback below, for the few chains not on Circle's forwarder
 *      allow-list — see chainSupportsForwarder)
 *   2. User signs approve + burn (relay pays ETH gas)
 *   3. Circle's servers handle attestation + mint on Arc automatically
 *   4. User can close app after burn — Circle finishes it
 *
 * No server needed. No Supabase. No scan-burns. No recovery logic.
 */

import { logTestEvent, newRunId } from './multichainTestLog'
import { chainSupportsForwarder } from './chainRpcs'
import { trimTrailingZeros } from './utils'

export interface BridgeJob {
  id:         string
  chainId:    string
  chainLabel: string
  amount:     number
  status:     'running' | 'submitted' | 'done' | 'error'
  startedAt:  number
  burnTxHash?: string
  error?:     string
}

type JobListener = (jobs: BridgeJob[]) => void

const STORAGE_KEY = 'meshport_bridge_jobs'

// ── CCTP transfer-speed selection per source chain ──────────────────────────
// Per Arc's docs (app-kit/tutorials/bridge/pay-fees-on-source): some source
// chains support ONLY CCTP Standard Transfer — Avalanche, Polygon PoS, Sei,
// XDC and their testnets. On those, `transferSpeed` MUST be 'SLOW'. Passing
// 'FAST' (or omitting it — it defaults to 'FAST') fails the Circle Quote API
// with `PRE_FINALITY_UNAVAILABLE`, usually surfaced as HTTP 422, BEFORE the
// burn ever happens — which is exactly what makes a claim from one of these
// chains land on "Claim Failed" every time. Every other source keeps 'FAST'.
// Matched against BOTH the internal chain id and the Circle SDK chain id,
// since callers pass sdkChainId separately (e.g. Polygon_Sepolia internally
// but Polygon_Amoy_Testnet to the SDK).
export const STANDARD_ONLY_CCTP_SOURCES = new Set<string>([
  'Avalanche_Fuji',
  'Polygon_Sepolia',
  'Polygon_Amoy_Testnet',
  'Sei_Testnet',
  'XDC_Apothem',
])

export function cctpSpeedForSource(internalChainId: string, sdkChainId?: string): 'FAST' | 'SLOW' {
  if (STANDARD_ONLY_CCTP_SOURCES.has(internalChainId)) return 'SLOW'
  if (sdkChainId && STANDARD_ONLY_CCTP_SOURCES.has(sdkChainId)) return 'SLOW'
  return 'FAST'
}

// ── Claim-direction destination target (Arc-side) ───────────────────────────
// Circle's Forwarding Service (which submits the Arc-side mint automatically)
// only covers an explicit allow-list of chains — this file used to route
// every source chain through useForwarder:true unconditionally, which is
// exactly what silently broke Plume on the Send side before that page
// started checking chainSupportsForwarder(). Claims never got the same
// check: a burn from a chain NOT on the allow-list would go through fine
// (irreversible), but the forwarder would then never submit the mint — the
// claim stalls in 'bridging' forever (that stage is deliberately unbounded,
// so it never even surfaces as "failed"). Mirror Send's fallback: when the
// source chain isn't forwarder-eligible, `adapter` submits the mint on Arc
// directly instead of asking the forwarder to. Safe to reuse the claim's own
// `adapter` for this — buildAdapter()'s getProvider (MultichainClaimPage.tsx)
// is chain-aware (branches on whatever `chain` the SDK asks it for at call
// time), so it already resolves a plain Arc RPC provider when asked for Arc,
// separate from the gas-sponsored provider it builds for the source chain.
//
// KNOWN LIMITATION: unlike the forwarder path (Circle pays the mint gas),
// this path needs the claiming wallet to already hold enough Arc USDC to pay
// for its own receiveMessage gas. There's no Arc-side gas sponsorship in this
// app today, so a wallet's very first claim ever from one of these chains,
// with zero prior Arc balance, can still fail on gas. That's a real gap
// worth closing separately — but it's strictly better than today's
// guaranteed-stuck claim for every user of these 3 chains.
export function buildClaimDestTarget(internalChainId: string, sdkChainId: string | undefined, walletAddr: string, adapter: any) {
  const useForwarder = chainSupportsForwarder(sdkChainId ?? internalChainId)
  return useForwarder
    ? { useForwarder: true as const, chain: 'Arc_Testnet' as any, recipientAddress: walletAddr }
    : { useForwarder: false as const, chain: 'Arc_Testnet' as any, recipientAddress: walletAddr, adapter }
}

function loadJobs(): Map<string, BridgeJob> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const arr: BridgeJob[] = JSON.parse(raw)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return new Map(arr.filter(j => j.startedAt > cutoff).map(j => [j.id, j]))
  } catch { return new Map() }
}

function saveJobs(jobs: Map<string, BridgeJob>) {
  try {
    // Only persist submitted/done — running jobs can't survive refresh
    const keep = Array.from(jobs.values()).filter(j => j.status !== 'running')
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keep))
  } catch {}
}

class BackgroundBridgeService {
  private jobs: Map<string, BridgeJob> = loadJobs()
  private listeners: Set<JobListener> = new Set()

  subscribe(fn: JobListener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    saveJobs(this.jobs)
    const jobs = Array.from(this.jobs.values())
    this.listeners.forEach(fn => fn(jobs))
  }

  getJobs(): BridgeJob[] {
    return Array.from(this.jobs.values())
  }

  async runBridge(params: {
    chainId:      string   // internal key (e.g. Polygon_Sepolia)
    sdkChainId?:  string   // Circle SDK chain ID (e.g. Polygon_Amoy_Testnet) — defaults to chainId
    chainLabel:   string
    amount:       number
    kit:          any
    adapter:      any
    walletAddr:   string
    setBalance:   (b: number) => void
    onStepUpdate: (chainId: string, stage: string, msg: string, pct: number, extra?: { txHash?: string; mintTxHash?: string }) => void
    onSubmitted?: (chainId: string) => void
    // Fired once the actual maxFee this chain's burn will sign is known
    // (after the live estimate + safety clamp below) — lets callers surface
    // a real per-chain/total fee figure in the UI instead of guessing from
    // the static fallback alone.
    onFeeKnown?: (chainId: string, fee: number) => void
    // Fired for each real wei transfer MeshPort's relay wallet makes to
    // cover this chain's gas (see api/relay-rpc.js's fundedWei field on
    // both mp_ensureGasFunded and eth_sendRawTransaction responses — 0 on
    // a call where the wallet already had enough). Can fire more than once
    // per chain (pre-fund + top-up); callers should accumulate, not
    // overwrite. Used for the claim success screen's real "gas MeshPort
    // covered" figure — never a guessed/example number, only what was
    // actually sent on-chain.
    onGasFunded?: (chainId: string, wei: bigint) => void
  }): Promise<void> {
    const id = `${params.chainId}-${Date.now()}`
    const testRunId = newRunId(`claim-${params.chainId}`)
    logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'runBridge started', data: { amount: params.amount, sdkChainId: params.sdkChainId } })
    const job: BridgeJob = {
      id,
      chainId:    params.chainId,
      chainLabel: params.chainLabel,
      amount:     params.amount,
      status:     'running',
      startedAt:  Date.now(),
    }
    this.jobs.set(id, job)
    this.notify()

    // ── SDK events ─────────────────────────────────────────────────────────────
    const onApprove = () => {
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'sdk-event', label: 'bridge.approve' })
      params.onStepUpdate(params.chainId, 'burning', 'USDC Approved ✓', 40)
    }
    try { params.kit.on('bridge.approve', onApprove) } catch {}

    const onBurn = (payload: any) => {
      const burnTxHash = payload?.values?.txHash ?? ''
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'sdk-event', label: 'bridge.burn', data: { burnTxHash } })

      job.status     = 'submitted'
      job.burnTxHash = burnTxHash
      this.jobs.set(id, job)
      this.notify()

      params.onStepUpdate(params.chainId, 'attesting', 'Burn confirmed — Circle processing…', 65, { txHash: burnTxHash })

      // NOTE: this used to also write an `activity` row here via
      // Activity.claim(). Removed — MultichainClaimPage.tsx's onStepUpdate
      // calls submitClaim() for this same burn event, which writes the
      // authoritative row to the `claims` table (server-tracked by
      // claim-worker). Writing to BOTH `claims` and `activity` for the same
      // physical claim meant MultichainPage rendered it twice: once from
      // `serverClaims` (the "Processing Claims" card) and once from
      // `dbActivity` (the "Activity" card, cross-referenced back to
      // `serverClaims` for live status). Same claim, same amount, same
      // chain, same timestamp — hence the "double double" processing cards.
      // `claims` rows persist indefinitely, so they're sufficient for full
      // claim history too — no separate `activity` row is needed.

      // Fire onSubmitted — user can navigate away, Circle handles the rest
      params.onSubmitted?.(params.chainId)
    }
    try { params.kit.on('bridge.burn', onBurn) } catch {}

    const onAttest = () => {
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'sdk-event', label: 'bridge.attestation' })
      params.onStepUpdate(params.chainId, 'minting', 'Circle attesting…', 82)
    }
    try { params.kit.on('bridge.attestation', onAttest) } catch {}

    const onMint = (payload: any) => {
      const txHash = payload?.values?.txHash ?? ''
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'sdk-event', label: 'bridge.mint', data: { txHash } })
      params.onStepUpdate(params.chainId, 'done', `${trimTrailingZeros(params.amount.toFixed(2))} USDC → Arc ✓`, 100, { mintTxHash: txHash })
    }
    try { params.kit.on('bridge.mint', onMint) } catch {}

    // ── kit.bridge() with useForwarder:true ─────────────────────────────────────
    // Circle's Forwarding Service handles attestation + mint automatically
    // User can close app after burn — no client-side waiting needed
    //
    // IMPORTANT: these four listeners are scoped to THIS job only, but `kit`
    // is a shared/long-lived emitter across all bridge calls. Without removing
    // them here, every subsequent claim/bridge stacks another full set of
    // listeners on top (confirmed by "MaxListenersExceededWarning" in prod) —
    // meaning a single burn event ends up firing every past job's onBurn too,
    // each writing its own (stale) Activity.claim() row for the same tx hash.
    // That's what produced the duplicate "Processing..." cards in the UI.
    const cleanupListeners = () => {
      try { params.kit.off('bridge.approve', onApprove) } catch {}
      try { params.kit.off('bridge.burn', onBurn) } catch {}
      try { params.kit.off('bridge.attestation', onAttest) } catch {}
      try { params.kit.off('bridge.mint', onMint) } catch {}
    }

    // maxFee is a CAP the source-chain burn signs into the message — it's not
    // just "the fee we pay", it's the ceiling the relayer must stay under to
    // submit the mint. With useForwarder:true, that cap has to cover BOTH the
    // CCTP protocol fee AND the Forwarding Service's own cut (deducted at
    // mint time), and per Circle's docs both are dynamic and must be fetched
    // immediately before the transfer.
    //
    // CORRECTION (supersedes an earlier version of this comment/fix that
    // blamed a missing 'kit' fee type): tracing into the exact installed
    // @circle-fin/provider-cctp-v2@1.8.3 (what bridge-kit@1.10.2 actually
    // resolves to) shows result.fees[] only ever contains a 'kit' entry when
    // `config.customFee` is set — this app never sets it, so that fix was
    // harmless but not the real cause.
    //
    // The actual gap: when Circle's live fee-rate lookup
    // (fetchUsdcFastBurnFee / fetchForwardingFee, keyed by source+dest CCTP
    // domain) rejects for a route — which newer/lower-volume forwarder
    // destinations are more exposed to than long-established ones — the SDK
    // does NOT throw. `estimate()` still resolves, but pushes
    // `{ type: 'provider', amount: null, error }` with NO forwarder entry at
    // all. `parseFloat(null) || 0` silently turns that into a $0
    // contribution, `feeTotal > 0` is false, and we fall back to the static
    // value anyway — so a failed lookup and a successful-but-zero lookup
    // were indistinguishable, and neither told us whether the static
    // fallback is actually enough for this route.
    //
    // Fix: (1) detect a null/error fee entry explicitly and retry the
    // estimate once — these lookups are more prone to transient failures
    // than outright unsupported-route errors; (2) if it still can't be
    // verified, use a fallback that scales with amount (mirroring the SDK's
    // own bps-based provider fee formula: ~14bps + 10% buffer) with a higher
    // floor, since maxFee is only a ceiling — signing a higher cap costs
    // nothing extra if the relayer's real fee is lower, it only avoids
    // under-provisioning.
    let maxFee = String(Math.max(0.15, params.amount * 0.002).toFixed(6)) // fallback: 20bps of amount, 0.15 USDC floor
    // Standard-only source chains (Avalanche/Polygon PoS/Sei/XDC + testnets)
    // must use 'SLOW' — 'FAST' 422s at the Quote API before burn. See
    // STANDARD_ONLY_CCTP_SOURCES above.
    const transferSpeed = cctpSpeedForSource(params.chainId, params.sdkChainId)
    logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'transferSpeed selected', data: { transferSpeed, chainId: params.chainId, sdkChainId: params.sdkChainId } })

    // See buildClaimDestTarget's own doc comment for why this branches at
    // all — TL;DR: not every source chain is on Circle's Forwarding Service
    // allow-list, and claims previously ignored that entirely.
    const destTarget = buildClaimDestTarget(params.chainId, params.sdkChainId, params.walletAddr, params.adapter)
    logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'forwarder eligibility', data: { useForwarder: destTarget.useForwarder, chainId: params.chainId, sdkChainId: params.sdkChainId } })

    const runEstimate = () => params.kit.estimateBridge({
      from: { adapter: params.adapter, chain: (params.sdkChainId ?? params.chainId) as any },
      to: destTarget,
      amount: params.amount.toFixed(6),
      token:  'USDC',
      config: { transferSpeed: transferSpeed as any },
    })
    let estimate: any = null
    try {
      estimate = await runEstimate()
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'estimate', label: 'estimateBridge succeeded', data: estimate })
    } catch (estErr: any) {
      console.error('[BgBridge] estimateBridge failed once, retrying:', estErr)
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'estimate', label: 'estimateBridge failed (attempt 1)', data: { message: estErr?.message } })
      try {
        estimate = await runEstimate()
        logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'estimate', label: 'estimateBridge succeeded (attempt 2)', data: estimate })
      } catch (estErr2: any) {
        console.error('[BgBridge] estimateBridge failed twice, falling back to scaled maxFee:', estErr2)
        logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'estimate', label: 'estimateBridge failed (attempt 2) — using fallback maxFee', data: { message: estErr2?.message, fallbackMaxFee: maxFee } })
      }
    }
    if (estimate) {
      const feeEntries: any[] = estimate?.fees ?? []
      const hadFailedLookup = feeEntries.some((f: any) => f.amount === null || f.error)
      const feeTotal = feeEntries
        .filter((f: any) => (f.type === 'provider' || f.type === 'forwarder' || f.type === 'kit') && f.amount !== null)
        .reduce((sum: number, f: any) => sum + (parseFloat(f.amount) || 0), 0)
      if (hadFailedLookup) {
        console.warn('[BgBridge] fee estimate returned a null/error entry for this route — using the scaled fallback maxFee instead of the partial result:', feeEntries)
      } else if (feeTotal > 0) {
        maxFee = feeTotal.toFixed(6)
      }
    }

    // ── Safety clamp: CCTP V2's depositForBurn REQUIRES maxFee < amount at
    // the contract level — signing a maxFee that equals or exceeds the
    // amount being burned is nonsensical (the whole transfer would go to
    // fees) and the contract rejects it outright. On routes whose actual
    // fee runs close to the claim amount — Monad/Polygon Amoy FAST
    // transfers have been seen quoting fees in the ~1.0-1.5 USDC range —
    // a small claim (e.g. $2, seen directly in production logs) leaves
    // almost no margin, and either the real estimate or the scaled
    // fallback above can end up at or past the amount itself. This is
    // exactly what "Simulation failed: Transaction reverted" with no burn
    // transaction ever reaching the chain looks like: the SDK validates
    // this client-side before ever asking the adapter to sign anything,
    // so no amount of gas/balance funding could ever have fixed it — this
    // was never a funding problem.
    //
    // Clamped to at most 90% of the claim amount (leaving genuine margin,
    // not just barely under) rather than trusting the estimate/fallback
    // blindly. If even that clamp can't leave a sane minimum margin — the
    // amount is just too small for this route's real fee — fail with a
    // clear, actionable message instead of letting the SDK's opaque
    // simulation error reach the user. Placed INSIDE the try block below
    // (not before it) so a too-small amount flows through the exact same
    // catch handler as every other failure here — job.status, the error
    // shown in the UI, and cleanup all stay consistent.
    const MAX_FEE_SAFETY_RATIO = 0.9
    const MIN_VIABLE_MARGIN = 0.05 // USDC — smallest gap between amount and fee this will attempt

    try {
      const clampedMaxFee = Math.min(parseFloat(maxFee), params.amount * MAX_FEE_SAFETY_RATIO)
      if (params.amount - clampedMaxFee < MIN_VIABLE_MARGIN) {
        logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'error', label: 'amount too small for route fee — aborting before bridge()', data: { amount: params.amount, estimatedFee: maxFee } })
        throw new Error(
          `This amount ($${trimTrailingZeros(params.amount.toFixed(2))}) is too small for ${params.chainLabel}'s current transfer fee ` +
          `(~$${trimTrailingZeros(parseFloat(maxFee).toFixed(2))}). Try claiming a larger amount from this chain.`
        )
      }
      if (clampedMaxFee < parseFloat(maxFee)) {
        console.warn(`[BgBridge] clamped maxFee from ${maxFee} to ${clampedMaxFee.toFixed(6)} (must stay below amount ${params.amount})`)
      }
      maxFee = clampedMaxFee.toFixed(6)
      try { params.onFeeKnown?.(params.chainId, parseFloat(maxFee)) } catch {}

      // Explicit, unconditional pre-fund — called and awaited BEFORE
      // kit.bridge() does anything at all. Added after a real production
      // case where the burn call failed with "Simulation failed:
      // Transaction reverted" despite the wallet's on-chain history
      // showing the burn transaction never actually reached the chain
      // (only Increase Allowance transactions ever appear) — meaning
      // whatever internal check the SDK runs before signing wasn't going
      // through the eth_call interception this proxy already had, so that
      // fix never got a chance to run. This removes the guesswork: fund
      // first, unconditionally, then let the SDK do whatever internal
      // checks it wants — the wallet is already provably funded by then,
      // no matter which of its internal RPC calls actually runs the check.
      // Best-effort by design: if this call itself fails (network blip,
      // proxy hiccup), don't block the whole claim on it — kit.bridge()'s
      // own existing funding paths (eth_sendRawTransaction, eth_call) are
      // still there as a fallback, this is defense in depth, not the only
      // line of defense.
      try {
        // IMPORTANT: relay-rpc.js's CHAIN_DEFS is keyed by the INTERNAL
        // chain id (e.g. 'Polygon_Sepolia'), same as everywhere else this
        // proxy is addressed from (see buildGasSponsoredProvider's
        // proxyUrl in MultichainClaimPage.tsx, which uses
        // CHAIN_NAME_TO_ID[chain.name] — never the raw SDK chain id).
        // params.sdkChainId is the real Circle SDK id (e.g.
        // 'Polygon_Amoy_Testnet' for Polygon) — passing THAT here would
        // 400 with "Unknown chain" on any chain where the two differ,
        // Polygon being exactly that case. Always params.chainId here.
        const ensureUrl = `/api/relay-rpc?chain=${encodeURIComponent(params.chainId)}&user=${encodeURIComponent(params.walletAddr)}`
        const ensureRes = await fetch(ensureUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mp_ensureGasFunded', params: [] }),
        })
        const ensureJson = await ensureRes.json().catch(() => null)
        logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'mp_ensureGasFunded', data: ensureJson })
        if (ensureJson?.error) {
          console.warn('[BgBridge] mp_ensureGasFunded returned an error (continuing anyway):', ensureJson.error)
        } else if (ensureJson?.fundedWei) {
          try { params.onGasFunded?.(params.chainId, BigInt(ensureJson.fundedWei)) } catch {}
        }
      } catch (ensureErr: any) {
        console.warn('[BgBridge] mp_ensureGasFunded call failed (continuing anyway):', ensureErr?.message)
      }

      let result: any = await params.kit.bridge({
        from: { adapter: params.adapter, chain: (params.sdkChainId ?? params.chainId) as any },
        to: destTarget,
        amount: params.amount.toFixed(6),
        token:  'USDC',
        config: { transferSpeed: transferSpeed as any, maxFee },
      })
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'result', label: `kit.bridge() → state: ${result?.state}`, data: { state: result?.state, steps: result?.steps } })

      if (result?.state === 'error') {
        // Don't give up immediately — if the burn already succeeded and only
        // a later step (e.g. the forwarder's mint submission) failed, this is
        // an "actionable" failure per Circle's Bridge Kit recovery docs:
        // resuming continues from the failed step using the attestation
        // already signed, instead of re-doing the whole burn.
        //
        // Gated on isRetryableError() — a definitively non-retryable error
        // (e.g. the maxFee-vs-amount contract validation) would just fail
        // the exact same way a second time; skipping it here avoids that
        // redundant round-trip and the log noise it produces, though
        // calling retryBridge() unconditionally (the old behavior) was
        // never actually broken, just slightly less precise.
        const failedStep = result?.steps?.find((s: any) => s?.error)
        const errorForCheck = failedStep?.error ?? result?.error
        let shouldRetry = true
        try {
          const { isRetryableError } = await import('@circle-fin/app-kit')
          shouldRetry = errorForCheck ? isRetryableError(errorForCheck) : true
        } catch { /* isRetryableError unavailable — fall back to always attempting, same as before */ }

        if (!shouldRetry) {
          logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'skipping retryBridge — error confirmed non-retryable', data: { error: errorForCheck } })
        } else {
        try {
          // Brief backoff before retrying — per Arc's own documented
          // guidance for RPC endpoint failures (exponential backoff in
          // retry logic). Retrying immediately after "all RPCs failed"
          // (e.g. a simultaneous 503 across every configured endpoint,
          // seen repeatedly on Arbitrum Sepolia) very likely just hits the
          // exact same still-ongoing outage again — a short pause gives a
          // genuinely transient provider issue a real chance to have
          // cleared before the second attempt.
          await new Promise(r => setTimeout(r, 3000))
          const retried: any = await params.kit.retryBridge(result, {
            from: params.adapter,
            to:   params.adapter,
          })
          logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'result', label: `kit.retryBridge() → state: ${retried?.state}`, data: { state: retried?.state, steps: retried?.steps } })
          if (retried) result = retried
        } catch (retryErr: any) {
          console.error('[BgBridge] retryBridge failed:', retryErr)
          logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'error', label: 'retryBridge threw', data: { message: retryErr?.message } })
        }
        }
      }

      const mintStep = result?.steps?.find((s: any) => s.name === 'mint')
      const burnStep = result?.steps?.find((s: any) => s.name === 'burn')
      // The REAL Arc-side mint hash, ONLY when one exists. Claims always go
      // through Circle's Forwarding Service (useForwarder:true), so per Arc's
      // docs the mint has no locally-signed hash and mintStep.data is
      // undefined — this is normally empty. Do NOT fall back to burnStep here:
      // the burn hash is a SOURCE-chain tx, and callers pair mintTxHash with
      // Arc's explorer, so a burn hash there is a broken "tx not found" link.
      // claim-worker backfills claims.destination_tx_hash with the true mint
      // hash once it observes the MessageReceived/Transfer log on Arc.
      const mintTxHash = mintStep?.txHash ?? mintStep?.data?.txHash ?? ''

      if (result?.state === 'error') {
        const failed = result?.steps?.find((s: any) => s.state === 'error')
        throw new Error(failed?.errorMessage ?? failed?.error?.message ?? 'Bridge failed')
      }

      job.status = 'done'
      job.burnTxHash = job.burnTxHash ?? (burnStep?.txHash ?? '')
      this.jobs.set(id, job)
      this.notify()

      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'result', label: 'SUCCESS', data: { amount: params.amount, mintTxHash, burnTxHash: job.burnTxHash } })
      params.onStepUpdate(params.chainId, 'done', `${trimTrailingZeros(params.amount.toFixed(2))} USDC → Arc ✓`, 100, { mintTxHash: mintTxHash || undefined, txHash: job.burnTxHash })
      try {
        const { getUSDCBalance } = await import('./arcService')
        params.setBalance(await getUSDCBalance(params.walletAddr))
      } catch {}

      // NOTE: notifyClaimArrived() used to fire here — the instant this
      // client SDK call resolved, independent of claims.status (the actual
      // settlement source of truth). That caused the notification to
      // consistently arrive before the Hub/Track Progress UI updated,
      // since claim-worker's server-side confirmation runs on its own
      // cadence. The notification now fires from the Realtime claims
      // subscription in MultichainClaimPage.tsx instead, so it's driven by
      // the same event as everything else — no more independent "is it
      // done" signal racing the real one.
      // Note: Activity already saved on burn — no duplicate save here

      setTimeout(() => { this.jobs.delete(id); this.notify() }, 60_000)

    } catch (e: any) {
      console.error(`[BgBridge] failed: ${e?.message}`)

      // If burn already confirmed — Circle forwarder will still complete it
      // Don't show error, keep as submitted
      if (job.burnTxHash) {
        logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'note', label: 'threw after burn confirmed — forwarder will still complete', data: { message: e?.message, burnTxHash: job.burnTxHash } })
        return
      }

      // Burn never happened — show error
      job.status = 'error'
      job.error  = e?.message?.slice(0, 100) ?? 'Bridge failed'
      this.jobs.set(id, job)
      this.notify()
      logTestEvent({ runId: testRunId, flow: 'claim', chainId: params.chainId, service: 'cctp', kind: 'error', label: 'FAILED', data: { message: e?.message } })
      params.onStepUpdate(params.chainId, 'error', job.error!, 0)
      setTimeout(() => { this.jobs.delete(id); this.notify() }, 30_000)
    } finally {
      cleanupListeners()
    }
  }
}

export const backgroundBridge = new BackgroundBridgeService()

// On load: convert running/submitted jobs to pending
;(() => {
  const jobs = backgroundBridge.getJobs()
  let changed = false
  jobs.forEach(j => {
    if (j.status === 'running') {
      ;(backgroundBridge as any).jobs.set(j.id, { ...j, status: 'submitted' })
      changed = true
    }
  })
  if (changed) { (backgroundBridge as any).notify() }
})()
