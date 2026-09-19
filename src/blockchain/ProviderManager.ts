/**
 * blockchain/ProviderManager.ts — one provider per chain, for the whole app
 *
 * Phase 1 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md (§6).
 *
 * ── What it replaces ────────────────────────────────────────────────────────
 * The audit found nine separate provider-construction strategies for Arc alone,
 * spread across arcService.ts, chain.ts, externalChainBalances.ts,
 * realtimeDeposits.ts (since removed — Phase 5/6 superseded it), the Multichain
 * pages and rewards.ts — with three module
 * caches that never share an instance. Each construction re-does discovery and
 * keeps its own connection. This module is the single place a provider is built.
 *
 * ── Why both viem AND ethers ────────────────────────────────────────────────
 * Both are already dependencies and both must stay: the Circle AppKit adapters
 * (@circle-fin/adapter-ethers-v6) require ethers-shaped providers, while the
 * app's own reads use viem. So this exposes both from one cached instance each,
 * rather than picking a winner and breaking Circle.
 *
 * ethers is loaded via dynamic import(), never statically. The codebase
 * deliberately code-splits it (see MultichainTransferPage's loadSdkModules and
 * ubFundRecovery's loadSdk) so it stays out of the initial bundle; a static
 * import here would drag it back in for every page that touches a balance.
 *
 * ── staticNetwork / no chain discovery ──────────────────────────────────────
 * Where a chain's numeric id is authoritatively known, the provider is pinned
 * to it. This is not a micro-optimization: arc.ts documents that when ethers
 * auto-detects a network and the eth_chainId call fails, ethers v6 retries every
 * ~1s FOREVER, and that silent loop alone was enough to exhaust a rate-limited
 * key and cause -32011 errors on real swap/bridge calls.
 *
 * ── Batching is deliberately NOT enabled yet ────────────────────────────────
 * viem's `batch: { multicall: true }` requires chain.contracts.multicall3, which
 * is not configured for Arc or for the 21 external chains — enabling it would
 * make reads throw ChainDoesNotSupportContract. JSON-RPC array batching is also
 * off, because Arc traffic flows through our own /api/arc-rpc proxy, which
 * forwards a single JSON-RPC body and has not been verified against array
 * payloads. Both are tracked as open question #3 in the proposal and belong in
 * Phase 2, after per-chain verification. Deduplication and caching (cache.ts)
 * deliver the bulk of the request reduction without this risk.
 *
 * TESTNET ONLY: every endpoint resolved here comes from blockchain/chains.ts,
 * which contains Arc Testnet / Circle Testnet endpoints exclusively.
 */
import { createPublicClient, http, fallback, defineChain } from 'viem'
import type { Chain } from 'viem'
import {
  ARC, ARC_RPCS, ARC_CHAIN_INLINE, EXTERNAL_CHAINS,
  resolveRpcList, isArc,
} from './chains'
import { orderEndpoints, recordSuccess, recordFailure, STAGGER_MS } from './endpointHealth'
import { countRequest, countError } from './rpcMetrics'
import type { ChainId } from './types'

/** Resolved, health-ordered endpoint list for a chain. Never empty. */
/**
 * Endpoints for a chain, health-ordered with quarantined ones EXCLUDED.
 *
 * For one-shot calls (rpcCall), which re-evaluate health on every invocation —
 * so an endpoint that recovers is picked up on the very next call.
 */
export function endpointsFor(chain: ChainId): string[] {
  return orderEndpoints(allEndpointsFor(chain))
}

/**
 * Every configured endpoint for a chain, unfiltered.
 *
 * Used when building the long-lived viem/ethers clients. This distinction
 * matters: those clients are cached for the lifetime of the tab, and their
 * transport list is fixed at construction. Handing them a quarantine-filtered
 * list would permanently exclude any endpoint that happened to be quarantined
 * at that moment — even hours later, after it recovered — silently shrinking
 * the failover pool for the whole session. Quarantine is meant to be a
 * seconds-to-minutes backoff, not a life sentence.
 *
 * The clients don't need the filter anyway: viem's fallback() and ethers'
 * FallbackProvider both do their own per-request sequential failover.
 */
export function allEndpointsFor(chain: ChainId): string[] {
  if (isArc(chain)) return [...ARC_RPCS]

  const cfg = EXTERNAL_CHAINS[chain]
  if (!cfg) throw new Error(`[ProviderManager] unknown chain: ${chain}`)

  const resolved = resolveRpcList(cfg.rpcs)
  if (resolved.length === 0) {
    throw new Error(`[ProviderManager] no usable RPC endpoint for ${chain}`)
  }
  return resolved
}

/** Numeric chain id when authoritatively known, else undefined. */
function chainIdFor(chain: ChainId): number | undefined {
  if (isArc(chain)) return ARC.chainId
  return EXTERNAL_CHAINS[chain]?.chainId
}

/**
 * viem chain descriptor, or undefined when the numeric id isn't confirmed.
 * Six chains have no verified id (see the block comment in chains.ts);
 * undefined lets viem operate chain-agnostically, which is fine for reads and
 * matches what the Multichain pages already do. Never substitute a placeholder
 * id — a wrong id is far worse than an absent one.
 */
function viemChainFor(chain: ChainId, rpcs: string[]): Chain | undefined {
  if (isArc(chain)) {
    return defineChain({
      id:   ARC.chainId,
      name: ARC_CHAIN_INLINE.name,
      nativeCurrency: ARC_CHAIN_INLINE.nativeCurrency,
      rpcUrls: { default: { http: [...ARC_RPCS] } },
    })
  }

  const id = chainIdFor(chain)
  if (id === undefined) return undefined

  return defineChain({
    id,
    name: chain,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpcs } },
  })
}

/**
 * Wraps viem's http transport to feed the health scorer and the RPC counter.
 * This is the only place client-side request volume is observed, which is what
 * makes the phase-over-phase measurements trustworthy.
 */
function instrumentedHttp(url: string, chain: ChainId) {
  return http(url, {
    timeout: 10_000,
    // viem's own retry is disabled: fallback() below already handles failover,
    // and layering two retry policies multiplies requests during an outage —
    // exactly the amplification this migration is meant to remove.
    retryCount: 0,
    onFetchRequest() { countRequest(chain, 'rpc') },
  })
}

/**
 * The concrete client type. Derived from createPublicClient's own return type
 * rather than written as the bare `PublicClient` interface: viem's generics make
 * the returned object structurally narrower than that interface, so annotating
 * it as `PublicClient` forces a cast that TypeScript rejects outright
 * (TS2352 — the two types don't sufficiently overlap, because getBlock's return
 * shape differs). Inferring the type keeps full method typing with no cast.
 */
type ArcPublicClient = ReturnType<typeof createPublicClient>

const viemClients = new Map<ChainId, ArcPublicClient>()

/**
 * The app's read client for a chain. One instance per chain, cached — connection
 * reuse only pays off if the client is shared, which is precisely what the old
 * per-call construction prevented.
 */
export function getClient(chain: ChainId): ArcPublicClient {
  const cached = viemClients.get(chain)
  if (cached) return cached

  // Full pool, health-ORDERED but not health-FILTERED — see allEndpointsFor.
  const rpcs = orderEndpoints(allEndpointsFor(chain))
  const client = createPublicClient({
    chain: viemChainFor(chain, rpcs),
    transport: fallback(rpcs.map(u => instrumentedHttp(u, chain)), { rank: false }),
  })

  viemClients.set(chain, client)
  return client
}

type EthersProvider = any // ethers is dynamically imported; see module header

const ethersProviders = new Map<ChainId, Promise<EthersProvider>>()

/**
 * ethers provider for the Circle AppKit adapter paths, which cannot take a viem
 * client. Async because ethers is code-split.
 *
 * The PROMISE is cached, not the resolved value — so concurrent callers during
 * the first load share one import and one construction rather than racing to
 * build duplicates, which is the very problem this class is here to remove.
 */
export function getEthersProvider(chain: ChainId): Promise<EthersProvider> {
  const cached = ethersProviders.get(chain)
  if (cached) return cached

  const p = (async () => {
    const { JsonRpcProvider, FallbackProvider } = await import('ethers')
    // Full pool here too — same reasoning as getClient: this provider is cached
    // for the session, so it must not inherit a momentary quarantine.
    const rpcs = orderEndpoints(allEndpointsFor(chain))
    const id = chainIdFor(chain)

    // Pin only when the id is confirmed; otherwise auto-detect, which is
    // exactly what the Multichain pages do for these chains today.
    const network = id === undefined
      ? undefined
      : { chainId: id, name: isArc(chain) ? 'arc-testnet' : chain }
    const opts = network ? { staticNetwork: true } : undefined

    if (rpcs.length === 1) {
      return new JsonRpcProvider(rpcs[0], network as any, opts as any)
    }
    // quorum: 1 — this is failover, not multi-node consensus.
    return new FallbackProvider(
      rpcs.map((url, i) => ({
        provider: new JsonRpcProvider(url, network as any, opts as any),
        priority: i + 1,
        stallTimeout: 1_500,
        weight: 1,
      })),
      network as any,
      { quorum: 1 },
    )
  })()

  ethersProviders.set(chain, p)
  return p
}

/**
 * Resolves with the first fulfilled promise; rejects only if all reject.
 *
 * Hand-rolled instead of Promise.any because this project targets ES2020
 * (see tsconfig lib) and Promise.any is ES2021 — using it would fail typecheck
 * and, depending on the browser floor, fail at runtime on older mobile Safari.
 */
function firstSuccess<T>(makers: Array<() => Promise<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remaining = makers.length
    let settled = false
    let lastErr: unknown = null

    if (remaining === 0) { reject(new Error('no endpoints')); return }

    for (const make of makers) {
      make().then(
        v => { if (!settled) { settled = true; resolve(v) } },
        e => {
          lastErr = e
          if (--remaining === 0 && !settled) reject(lastErr)
        },
      )
    }
  })
}

/**
 * Raw JSON-RPC against a chain, racing health-ordered endpoints with a stagger.
 * Ported from api/arc-rpc.js's forward(): the top-ranked endpoint usually wins
 * in one round trip, and a degraded one loses the race rather than blocking, so
 * there's no sequential-timeout tax.
 *
 * Safe for reads and for eth_sendRawTransaction alike — broadcasting the same
 * signed transaction to several nodes is a standard pattern and the network
 * dedupes it (same reasoning as the proxy's own comment).
 */
export async function rpcCall<T = unknown>(
  chain: ChainId,
  method: string,
  params: unknown[] = [],
  timeoutMs = 10_000,
): Promise<T> {
  const ordered = endpointsFor(chain)

  const attempts = ordered.map((url, i) => async (): Promise<T> => {
    if (i > 0) await new Promise(r => setTimeout(r, i * STAGGER_MS))
    const startedAt = Date.now()
    countRequest(chain, method)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      const body = await res.json()
      if (body?.error) throw new Error(body.error?.message ?? 'rpc error')
      recordSuccess(url, Date.now() - startedAt)
      return body.result as T
    } catch (e) {
      recordFailure(url)
      countError()
      throw e
    }
  })

  return firstSuccess(attempts)
}

/** Cheap liveness probe. Returns null when every endpoint is unusable. */
export async function probeChain(chain: ChainId): Promise<number | null> {
  try {
    const hex = await rpcCall<string>(chain, 'eth_blockNumber')
    return Number.parseInt(hex, 16)
  } catch {
    return null
  }
}

/**
 * Drops cached instances so the next call rebuilds with current health order and
 * a fresh connection. For a confirmed network change or a manual reset — NOT for
 * routine failover, which fallback() already handles without discarding.
 */
export function resetProviders(chain?: ChainId): void {
  if (chain) {
    viemClients.delete(chain)
    ethersProviders.delete(chain)
    return
  }
  viemClients.clear()
  ethersProviders.clear()
}

/** Diagnostics: which chains currently hold a live instance. */
export function activeChains(): { viem: ChainId[]; ethers: ChainId[] } {
  return { viem: [...viemClients.keys()], ethers: [...ethersProviders.keys()] }
}
