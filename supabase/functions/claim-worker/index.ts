// supabase/functions/claim-worker/index.ts
//
// SELF-CONTAINED VERSION — 2026-07-06. Previously this imported from
// '../_shared/cors.ts' and '../_shared/chains.ts'. That's the correct
// structure for CLI-based deploys, but the Supabase Dashboard's single-file
// editor very likely does not support those separate shared files — which is
// the most probable reason a fix to chains.ts (bounding the eth_getLogs
// block range) appeared not to take effect after a dashboard deploy: the
// editor only ever saw/redeployed index.ts, silently continuing to run
// whatever chains.ts content was already live. Inlining everything into this
// one file removes that ambiguity entirely: a single paste-and-deploy of
// this file is guaranteed to include every fix.
//
// The actual background worker. Runs entirely server-side — never invoked by
// or dependent on any browser tab. Two invocation modes:
//
//   { mode: 'single', claimId }  — process one claim now (called by claim-submit
//                                   right after insert, for a fast first update)
//   { mode: 'sweep' }            — process ALL due claims; loops internally for
//                                   ~50s (poll every ~8s) before returning, then
//                                   pg_cron re-triggers it every minute as a
//                                   self-healing safety net (see migration
//                                   20260702120100_claim_worker_cron.sql)
//
// State machine (status column on `claims`):
//   submitted -> bridging   (bridgeFunds:    confirm burn tx is mined)
//   bridging  -> verifying  (waitForBridge:  Circle attestation complete)
//   verifying -> settling   (settleClaim:    cheap UI transition)
//   settling  -> completed  (confirmArrival: funds visible on Arc — event-based)
//   any       -> failed     (too many attempts / explicit error)
//
// ── 2026-07-06 hardening pass ────────────────────────────────────────────────
// Root-caused and fixed a class of claims stalling forever in 'settling' with
// no error surfaced:
//   1. confirmArrival() only ever had a balance-delta heuristic to detect
//      arrival, compared against a wallet-wide snapshot taken once at submit
//      time. Any other activity on that wallet permanently invalidated it.
//      -> Replaced with event-based detection (CCTP MessageReceived log, or
//         a specific incoming Transfer matched by recipient+amount).
//   2. Every `.update()` call discarded `{ error }`, so a rejected write
//      failed completely silently. -> All writes now error-checked and
//      persisted to the row itself.
//   3. String(error) on a plain thrown object (e.g. a raw JSON-RPC error)
//      produces the literal text "[object Object]", destroying the actual
//      diagnostic info. -> serializeError() below handles this properly.
//   4. eth_getLogs was called with an UNBOUNDED block range
//      (fromBlock: '0x0', toBlock: 'latest'). Public RPC providers reject
//      this outright (confirmed: `{"code":-32614,"message":"eth_getLogs is
//      limited to a 10,000 range"}` on every single attempt) — this was the
//      actual root cause of claims never resolving, not a matching-logic
//      bug. -> fetchLogsBounded() now queries only a recent window and
//      adapts to the provider's stated limit if it's smaller.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// ── Inlined from _shared/cors.ts ─────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  return null
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Inlined from _shared/chains.ts ───────────────────────────────────────────
// CCTP_DOMAINS below already covers all 21 supported chains (added in an
// earlier pass specifically because it was found missing 10 of them) — but
// THIS map was never updated to match at the same time. That's a much more
// severe bug than a missing fallback: getTransactionReceipt() does
// `CHAIN_RPCS[chainId] ?? []`, so for any of these 10 chains it ALWAYS
// returns an empty list, which means it ALWAYS returns null, which means
// bridgeFunds() ALWAYS just silently returns without advancing the claim
// past 'submitted' — a 100% guaranteed, permanent failure for every claim
// from these chains, not an occasional one. Confirmed by tracing the actual
// call chain, not assumed. RPC URLs below are the same ones already proven
// working in the client-side balance scanners (Home/Hub/Claim), reused here
// as the primary endpoint for each; second endpoints added where a
// same-confidence public alternative was readily verifiable.
// drpc.live API key — set DRPC_KEY in Supabase project secrets
const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
// Optional explicit authenticated RPC URL override — set ARC_RPC_URL in
// Supabase project secrets to point at a specific authenticated gateway.
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()

const CHAIN_RPCS: Record<string, string[]> = {
  Ethereum_Sepolia:    [`https://lb.drpc.live/sepolia/${DRPC_KEY}`, 'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
  Base_Sepolia:        [`https://lb.drpc.live/base-sepolia/${DRPC_KEY}`, 'https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'],
  Arbitrum_Sepolia:    [`https://lb.drpc.live/arbitrum-sepolia/${DRPC_KEY}`, 'https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'],
  Optimism_Sepolia:    [`https://lb.drpc.live/optimism-sepolia/${DRPC_KEY}`, 'https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'],
  Polygon_Sepolia:     [`https://lb.drpc.live/polygon-amoy/${DRPC_KEY}`, 'https://polygon-amoy-bor-rpc.publicnode.com'],
  Avalanche_Fuji:      [`https://lb.drpc.live/avalanche-fuji/${DRPC_KEY}`, 'https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
  HyperEVM_Testnet:    [`https://lb.drpc.live/hyperliquid-testnet/${DRPC_KEY}`, 'https://virtual.hyperliquid-testnet.rpc.tenderly.co', 'https://rpcs.chain.link/hyperevm/testnet'],
  Sei_Testnet:         [`https://lb.drpc.live/sei-testnet/${DRPC_KEY}`, 'https://evm-rpc-testnet.sei-apis.com', 'https://sei-testnet.drpc.org'],
  Sonic_Testnet:       [`https://lb.drpc.live/sonic-testnet-v2/${DRPC_KEY}`, 'https://rpc.testnet.soniclabs.com', 'https://sonic-blaze-rpc.publicnode.com'],
  Unichain_Sepolia:    [`https://lb.drpc.live/unichain-sepolia/${DRPC_KEY}`, 'https://sepolia.unichain.org', 'https://unichain-sepolia.drpc.org'],
  World_Chain_Sepolia: [`https://lb.drpc.live/worldchain-sepolia/${DRPC_KEY}`, 'https://worldchain-sepolia.g.alchemy.com/public', 'https://worldchain-sepolia.drpc.org'],
  Linea_Sepolia:       [`https://lb.drpc.live/linea-sepolia/${DRPC_KEY}`, 'https://rpc.sepolia.linea.build', 'https://linea-sepolia-rpc.publicnode.com'],
  Codex_Testnet:       ['https://rpc.codex-stg.xyz'],
  Monad_Testnet:       [`https://lb.drpc.live/monad-testnet/${DRPC_KEY}`, 'https://testnet-rpc.monad.xyz'],
  XDC_Apothem:         [`https://lb.drpc.live/xdc-testnet/${DRPC_KEY}`, 'https://rpc.apothem.network'],
  Ink_Testnet:         [`https://lb.drpc.live/ink-sepolia/${DRPC_KEY}`, 'https://rpc-gel-sepolia.inkonchain.com', 'https://ink-sepolia.drpc.org'],
  Plume_Testnet:       [`https://lb.drpc.live/plume-testnet/${DRPC_KEY}`, 'https://testnet-rpc.plume.org'],
  Edge_Testnet:        ['https://edge-testnet.g.alchemy.com/public'],
  Injective_Testnet:   ['https://k8s.testnet.json-rpc.injective.network'],
  Morph_Testnet:       [`https://lb.drpc.live/morph-hoodi/${DRPC_KEY}`, 'https://rpc-hoodi.morphl2.io'],
  Pharos_Testnet:      ['https://atlantic.dplabs-internal.com'],
}

const CCTP_DOMAINS: Record<string, number> = {
  Ethereum_Sepolia:    0,
  Base_Sepolia:        6,
  Arbitrum_Sepolia:    3,
  Optimism_Sepolia:    2,
  Polygon_Sepolia:     7,
  Avalanche_Fuji:      1,
  HyperEVM_Testnet:    19,
  Sei_Testnet:         16,
  Sonic_Testnet:       13,
  Unichain_Sepolia:    10,
  World_Chain_Sepolia: 14,
  // Added — verified directly from Circle's official CCTP domain table
  // (developers.circle.com/cctp/concepts/supported-chains-and-domains).
  // Without these, claims from these 10 chains silently skipped the real
  // Circle attestation check entirely (domain undefined -> straight to
  // 'verifying' with no message_hash) and always fell back to the less
  // precise amount-matching completion path instead of the primary one.
  Linea_Sepolia:       11,
  Codex_Testnet:       12,
  Monad_Testnet:       15,
  XDC_Apothem:         18,
  Ink_Testnet:         21,
  Plume_Testnet:       22,
  Edge_Testnet:        28,
  Injective_Testnet:   29,
  Morph_Testnet:       30,
  Pharos_Testnet:      31,
}

// Authenticated-only Arc endpoints — no direct public gateways
// (rpc.testnet.arc.network, Blockdaemon, dRPC public, QuickNode, thirdweb,
// drpc.org). Those were exactly how this scan could end up querying
// arc-testnet.rpc.thirdweb.com even with an authenticated RPC configured.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
]

const CIRCLE_IRIS_API = 'https://iris-api-sandbox.circle.com'

const ARC_MESSAGE_TRANSMITTER =
  Deno.env.get('ARC_MESSAGE_TRANSMITTER_ADDRESS') ?? ''

// CCTP v2 changed this event's shape from v1 (nonce: uint64 → bytes32,
// added finalityThresholdExecuted before messageBody) — a different event
// shape means a completely different topic0 hash, even though the event
// name and emitting contract are the same. Filtering for only the v1 hash
// meant any mint that actually went through v2 infrastructure would never
// be found by this query at all — silently falling through to
// claim-recovery-scan's slower backfill instead of being detected here,
// which is the primary, fast path. Confirmed via production logs: a real
// mint's MessageReceived log came from exactly the right contract address
// but matched neither the v1-only filter here nor the equivalent check in
// claim-recovery-scan.
// keccak256("MessageReceived(address,uint32,uint64,bytes32,bytes)")
const MESSAGE_RECEIVED_TOPIC0_V1 =
  '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d'
// keccak256("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")
const MESSAGE_RECEIVED_TOPIC0_V2 =
  '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c'

async function rpcCall(urls: string[], method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown = null
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      // Non-2xx (429 rate-limit, 5xx, etc.) doesn't always come back as
      // JSON-RPC-shaped JSON with an `.error` field — fail over on it too.
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

async function getTransactionReceipt(chainId: string, txHash: string) {
  const urls = CHAIN_RPCS[chainId] ?? []
  if (!urls.length) return null
  try {
    return await rpcCall(urls, 'eth_getTransactionReceipt', [txHash])
  } catch {
    return null
  }
}

async function rpcCallSingle(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`)
  const respJson = await res.json()
  if (respJson.error) throw respJson.error
  return respJson.result
}

function decodeCctpMessageNonce(messageHex: string): { nonce: bigint; sourceDomain: number } | null {
  try {
    const hex = messageHex.startsWith('0x') ? messageHex.slice(2) : messageHex
    if (hex.length < 116 * 2) return null
    const sourceDomain = parseInt(hex.slice(4 * 2, 8 * 2), 16)
    const nonce = BigInt('0x' + hex.slice(12 * 2, 20 * 2))
    return { nonce, sourceDomain }
  } catch {
    return null
  }
}

type CctpReceiveLog = { transactionHash: string; blockNumber: number; amount: number | null }
type MintTransferLog = { transactionHash: string; blockNumber: number; amount?: number }

// ── Bounded, range-limit-aware log fetching (the actual root-cause fix) ─────
// Arc's block time is ~500ms (per Arc docs: `avgBlockTimeMs: 500`, deterministic
// BFT finality, 1 confirmation). An earlier version of this file assumed ~1s
// and set the window to 5000 blocks calling it "~83 minutes" — at 500ms that's
// only ~42 minutes, which had drifted to roughly EQUAL to SETTLING_TIMEOUT_MS
// (40 min) below. A mint that landed near the edge of that window, or any time
// the Arc RPC's head was lagging, fell outside the scan and the claim got
// marked `failed` even though the USDC was already minted on Arc.
//
// 50,000 blocks is ~7 hours at 500ms — many multiples of the 40-minute
// settling budget, with room to spare for RPC lag and late Standard-transfer
// mints. It's fetched in fixed 5,000-block chunks (see fetchLogsBounded) so a
// wide window doesn't trip a provider's per-request `eth_getLogs` range cap.
const LOG_SCAN_WINDOW_BLOCKS = 50_000
const LOG_SCAN_CHUNK_BLOCKS  = 5_000
const LOG_SCAN_CONCURRENCY   = 5

async function getCurrentArcBlockNumber(): Promise<number> {
  const results = await Promise.allSettled(
    ARC_RPCS.map(url => rpcCallSingle(url, 'eth_blockNumber', []))
  )
  const values = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => Number(BigInt(r.value)))
    .filter(n => Number.isFinite(n) && n > 0)

  if (values.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw firstError?.reason ?? new Error('getCurrentArcBlockNumber: all Arc RPC endpoints failed')
  }
  return Math.max(...values)
}

function serializeErrorForRpc(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

async function fetchLogsBounded(filterBase: Record<string, unknown>): Promise<any[]> {
  const currentBlock = await getCurrentArcBlockNumber()
  const fromBlock = Math.max(0, currentBlock - LOG_SCAN_WINDOW_BLOCKS)

  // Query one fixed-size chunk — races all RPC endpoints, returns whichever
  // succeeds. `ok` means at least one endpoint answered (so [] is a real
  // "nothing here", not a total failure).
  const queryChunk = async (from: number, to: number): Promise<{ ok: boolean; logs: any[] }> => {
    const filter = { ...filterBase, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }
    const results = await Promise.allSettled(
      ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getLogs', [filter]))
    )
    const logs = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .flatMap(r => (Array.isArray(r.value) ? r.value : []))
    return { ok: results.some(r => r.status === 'fulfilled'), logs }
  }

  // Proactively split into fixed 5,000-block chunks instead of requesting the
  // whole window in one call and reactively retrying on an error-text pattern
  // ("limited to N range"). That reactive approach silently breaks if a
  // provider's wording differs — and on a range-cap error it could only ever
  // fall back to scanning the MOST RECENT N blocks, dropping everything older,
  // which is exactly the class of miss this widened window is meant to fix.
  // Same approach claim-recovery-scan already uses.
  const chunks: Array<[number, number]> = []
  for (let from = fromBlock; from <= currentBlock; from += LOG_SCAN_CHUNK_BLOCKS) {
    chunks.push([from, Math.min(from + LOG_SCAN_CHUNK_BLOCKS - 1, currentBlock)])
  }

  const allLogs: any[] = []
  let anyChunkSucceeded = false
  for (let i = 0; i < chunks.length; i += LOG_SCAN_CONCURRENCY) {
    const batch = chunks.slice(i, i + LOG_SCAN_CONCURRENCY)
    const results = await Promise.allSettled(batch.map(([from, to]) => queryChunk(from, to)))
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        if (r.value.ok) anyChunkSucceeded = true
        allLogs.push(...r.value.logs)
      } else {
        const [from, to] = batch[j]
        console.error(`[claim-worker] fetchLogsBounded chunk ${from}-${to} failed:`, serializeErrorForRpc(r.reason))
      }
    }
  }

  if (!anyChunkSucceeded && allLogs.length === 0) {
    throw new Error('fetchLogsBounded: every chunk failed on every Arc RPC endpoint')
  }
  return allLogs
}

async function fetchMintAmountForTx(transactionHash: string): Promise<number | null> {
  try {
    const receipt = await rpcCall(ARC_RPCS, 'eth_getTransactionReceipt', [transactionHash])
    const transferLog = (receipt?.logs ?? []).find((l: any) =>
      (l.address as string)?.toLowerCase() === ARC_USDC_CONTRACT.toLowerCase() &&
      (l.topics?.[0] as string)?.toLowerCase() === TRANSFER_TOPIC0.toLowerCase() &&
      (l.topics?.[1] as string)?.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()
    )
    return transferLog ? Number(BigInt(transferLog.data)) / 1e6 : null
  } catch (e) {
    console.error(`[claim-worker] fetchMintAmountForTx: failed for ${transactionHash}:`, e)
    return null
  }
}

async function findCctpReceiveLog(nonce: bigint): Promise<CctpReceiveLog | null> {
  if (!ARC_MESSAGE_TRANSMITTER) return null

  const nonceTopic = '0x' + nonce.toString(16).padStart(64, '0')
  const filter = {
    address: ARC_MESSAGE_TRANSMITTER,
    topics: [[MESSAGE_RECEIVED_TOPIC0_V1, MESSAGE_RECEIVED_TOPIC0_V2], null, nonceTopic],
  }

  const logs = await fetchLogsBounded(filter)
  if (logs.length === 0) return null

  const log = logs[0]
  const transactionHash = log.transactionHash as string
  const blockNumber = Number(BigInt(log.blockNumber))

  // The MessageReceived event only confirms the CCTP message was processed
  // — it doesn't carry the actual minted amount. That's a separate event
  // (the USDC contract's own Transfer, from the zero address to this
  // wallet) emitted in the SAME transaction. Fetching that transaction's
  // full receipt and finding its Transfer log gives an exact amount with
  // no ambiguity at all — no fee-tolerance matching needed like
  // findIncomingMintByAmount has to do, since we already know the exact
  // transaction, not just an amount range to search for.
  const amount = await fetchMintAmountForTx(transactionHash)

  return { transactionHash, blockNumber, amount }
}

const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)

type MintLookupResult = {
  matches: MintTransferLog[]   // all valid candidates within the fee-tolerance band, best (closest to claimed amount) first
  candidateCount: number       // how many Transfer logs to this recipient existed in range, before amount filtering
  candidateAmounts: string[]   // their raw values (human USDC), for diagnosing amount-mismatch vs range/topic issues
}

async function findIncomingMintByAmount(recipient: string, amountUsdc: number): Promise<MintLookupResult> {
  const recipientTopic = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const filter = {
    address: ARC_USDC_CONTRACT,
    topics: [TRANSFER_TOPIC0, MINT_FROM_TOPIC, recipientTopic],
  }

  const logs = await fetchLogsBounded(filter)
  if (logs.length === 0) return { matches: [], candidateCount: 0, candidateAmounts: [] }

  // Match by amount, fee-aware: the minted amount can only ever be AT OR
  // BELOW the claimed amount (Circle/relay fees are deducted before mint,
  // never added on top), so there's no single correct "tolerance
  // percentage" to hardcode — fee rates vary by chain and transfer speed
  // tier. Confirmed via live diagnostic: a genuine claim of 1.000000 USDC
  // minted as 0.974639 USDC (~2.5% fee) and was wrongly rejected by an
  // earlier 99%-minimum threshold. Instead: accept any candidate at or
  // below the claimed amount (with a small upward tolerance only for
  // floating-point rounding, not fees).
  //
  // Return ALL qualifying candidates, sorted closest-to-claimed-amount
  // first — not just the single best one. With many same-amount test
  // claims running close together, the single best candidate can already
  // be claimed by a different row; previously that meant giving up
  // entirely and returning null. Now the caller can walk down the list.
  const expectedRaw = BigInt(Math.round(amountUsdc * 1e6))
  const roundingSlack = expectedRaw / 1000n // 0.1% — rounding only, not a fee allowance
  const feeFloor = (expectedRaw * 70n) / 100n // allow up to 30% fee — generous margin beyond the ~2.5% observed in practice; guards against matching an unrelated, much-smaller transfer to the same recipient
  const candidateAmounts: string[] = []
  const qualifying: Array<{ log: any; value: bigint }> = []
  for (const log of logs) {
    try {
      const value = BigInt(log.data)
      candidateAmounts.push((Number(value) / 1e6).toString())
      if (value >= feeFloor && value <= expectedRaw + roundingSlack) {
        qualifying.push({ log, value })
      }
    } catch { /* skip unparseable log */ }
  }
  qualifying.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))

  return {
    matches: qualifying.map(q => ({
      transactionHash: q.log.transactionHash,
      blockNumber: Number(BigInt(q.log.blockNumber)),
      amount: Number(q.value) / 1e6, // the REAL minted amount — persisted as arrived_amount, distinct from claim.amount (what was claimed)
    })),
    candidateCount: logs.length,
    candidateAmounts,
  }
}

async function getBlockTimestamp(blockNumber: number): Promise<string | null> {
  try {
    const blockHex = '0x' + blockNumber.toString(16)
    for (const url of ARC_RPCS) {
      try {
        const block = await rpcCallSingle(url, 'eth_getBlockByNumber', [blockHex, false])
        if (block?.timestamp) {
          return new Date(Number(BigInt(block.timestamp)) * 1000).toISOString()
        }
      } catch { /* try next endpoint */ }
    }
    return null
  } catch {
    return null
  }
}

// ── Worker itself ────────────────────────────────────────────────────────────

// ── Service role key — legacy vs. new secret format ──────────────────────────
// This project's Supabase dashboard marks SUPABASE_SERVICE_ROLE_KEY as
// deprecated in favor of SUPABASE_SECRET_KEYS (a JSON object of named
// secrets), but claims are currently completing successfully in production,
// which means the legacy var is still what's actually injected today. Can't
// directly verify the platform's internal behavior from here, so rather than
// blindly switching to a guessed JSON shape (and risking breaking a working
// system), this tries the legacy name FIRST — preserving current behavior —
// and only falls back to parsing SUPABASE_SECRET_KEYS if the legacy name is
// ever actually removed. Throws a clear, diagnosable error either way instead
// of the previous silent `!` assertion, which would have surfaced as an
// opaque downstream auth failure with no indication of the real cause.
function getServiceRoleKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy

  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw)
      const candidate = parsed?.service_role ?? parsed?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(parsed ?? {})[0]
      if (typeof candidate === 'string' && candidate) return candidate
    } catch (e) {
      console.error('[claim-worker] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }

  throw new Error(
    'No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS. ' +
    'Set one of these as a project secret.'
  )
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

// Server-to-server push, same infra claim-attention-scan uses — needed
// because claim-worker runs entirely server-side with no user session to
// attach to a normal action=send call. See api/push.ts's action=send-internal.
const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') || 'https://meshport.xyz').trim()
const PUSH_INTERNAL_SECRET = (Deno.env.get('PUSH_INTERNAL_SECRET') || '').trim()

const MAX_ATTEMPTS        = 90
const SWEEP_DURATION_MS   = 50_000
const SWEEP_INTERVAL_MS   = 8_000
const STALE_LOCK_MS       = 6_000
const FETCH_PAGE_SIZE     = 200
const STUCK_THRESHOLD_MIN = 10

// ── Settling gets its own budget, separate from MAX_ATTEMPTS ────────────────
// MAX_ATTEMPTS (90, ~12-15 real minutes given the sweep cadence below) was
// previously a single global counter shared across every stage. Two
// problems with that, found during audit:
//   1. A claim that spent many attempts stuck earlier (bridging/verifying)
//      entered settling with fewer attempts left than one that sailed
//      through — an unpredictable, coupling-by-accident budget for the
//      stage that most needs a predictable one.
//   2. ~15 minutes is a reasonable ceiling for burn confirmation + Circle
//      attestation (which is what MAX_ATTEMPTS is actually gating for
//      submitted/bridging/verifying), but settling is waiting for the
//      actual CCTP mint — CCTP Standard transfers can legitimately take
//      longer than that on some source chains even under normal
//      conditions, well within what LOG_SCAN_WINDOW_BLOCKS (5000 blocks,
///     ~83 minutes) already assumes is a reasonable window to search.
//      MAX_ATTEMPTS was cutting settling off at ~15 min while the log scan
//      itself was built to look back 83 minutes — an internal
//      inconsistency that could fail a claim that was still genuinely in
//      flight and would have completed on its own.
//
// Fix: settling now times out based on real elapsed time since entering
// that stage (settling_at), independent of the attempts counter — 40
// minutes, comfortably inside the 83-minute log-scan window (so a mint
// found right at the edge of the timeout is still discoverable) while
// still bounded, not open-ended forever.
const SETTLING_TIMEOUT_MS = 40 * 60 * 1000

type Claim = {
  id: string
  wallet_address: string
  source_chain: string
  amount: number
  arrived_amount: number | null
  tx_hash: string
  bridge_tx_hash: string | null
  message_hash: string | null
  destination_tx_hash: string | null
  arc_balance_before: number | null
  attempts: number
  status: 'submitted' | 'bridging' | 'verifying' | 'settling' | 'completed' | 'failed'
  error?: string | null
  created_at?: string
  bridging_at?: string | null
  verifying_at?: string | null
  settling_at?: string | null
}

// ── Observability: settlement timing metrics ────────────────────────────────
// Logged as structured JSON on every completion so latency can actually be
// measured and broken down by stage, instead of only knowing total
// created_at -> completed_at. Any log-based metrics pipeline (Supabase log
// drains, Datadog, etc.) can parse this line directly; no metrics backend is
// wired up here since none is configured for this project, but the data is
// now captured at the source rather than needing to be added later.
function logSettlementMetrics(claim: Claim) {
  try {
    const now = Date.now()
    const created    = claim.created_at    ? new Date(claim.created_at).getTime()    : null
    const bridging   = claim.bridging_at   ? new Date(claim.bridging_at).getTime()   : null
    const verifying  = claim.verifying_at  ? new Date(claim.verifying_at).getTime()  : null
    const settling   = claim.settling_at   ? new Date(claim.settling_at).getTime()   : null

    const metrics = {
      metric: 'claim_settlement',
      claim_id: claim.id,
      attempts: claim.attempts,
      settlement_duration_ms:  created   ? now - created   : null, // total: submitted -> completed
      bridge_duration_ms:      created && bridging  ? bridging  - created   : null, // submitted -> burn confirmed
      attestation_duration_ms: bridging && verifying ? verifying - bridging  : null, // burn confirmed -> Circle attested
      relay_duration_ms:       verifying && settling ? settling  - verifying : null, // attested -> settling
      finality_duration_ms:    settling  ? now - settling : null, // settling -> mint found
    }
    console.log('[claim-worker] metrics', JSON.stringify(metrics))
  } catch (e) {
    console.error('[claim-worker] logSettlementMetrics failed:', e)
  }
}

function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    const j = JSON.stringify(e)
    if (j && j !== '{}') return j
  } catch { /* circular or non-serializable — fall through */ }
  return String(e)
}

async function persistErrorBestEffort(supabase: SupabaseClient, claimId: string, message: string) {
  try {
    const { error } = await supabase
      .from('claims')
      .update({ error: message.slice(0, 250), last_error_at: new Date().toISOString() })
      .eq('id', claimId)
    if (error) console.error(`[claim-worker] ALSO failed to persist error for ${claimId}:`, error.message)
  } catch (e) {
    console.error(`[claim-worker] persistErrorBestEffort threw for ${claimId}:`, e)
  }
}

async function updateClaim(supabase: SupabaseClient, claimId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('claims').update(patch).eq('id', claimId)
  if (error) {
    console.error(`[claim-worker] update failed for ${claimId}:`, error.message, patch)
    await persistErrorBestEffort(supabase, claimId, `update failed: ${error.message}`)
    throw error
  }
}

async function bridgeFunds(supabase: SupabaseClient, claim: Claim) {
  const receipt = await getTransactionReceipt(claim.source_chain, claim.tx_hash)
  if (!receipt) return

  if (receipt.status === '0x0') {
    await markFailed(supabase, claim, 'Burn transaction reverted on source chain')
    return
  }

  await updateClaim(supabase, claim.id, { status: 'bridging', bridge_tx_hash: claim.tx_hash, bridging_at: new Date().toISOString() })
}

async function waitForBridge(supabase: SupabaseClient, claim: Claim) {
  const domain = CCTP_DOMAINS[claim.source_chain]
  if (domain === undefined) {
    await updateClaim(supabase, claim.id, { status: 'verifying', verifying_at: new Date().toISOString() })
    return
  }

  try {
    const url = `${CIRCLE_IRIS_API}/v2/messages/${domain}?transactionHash=${claim.tx_hash}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json().catch(() => ({}))
    const msg = data?.messages?.[0]

    if (msg?.status === 'complete' && msg?.attestation && msg?.message) {
      await updateClaim(supabase, claim.id, { status: 'verifying', message_hash: msg.message, verifying_at: new Date().toISOString() })
    } else {
      // Previously this branch (attestation genuinely not ready yet, OR
      // Circle's API returned something unexpected) left NO trace at all —
      // same class of silent-freeze bug as confirmArrival before it was
      // fixed. Persist what Circle actually said so a stuck claim here is
      // diagnosable instead of indistinguishable from "still waiting".
      await persistErrorBestEffort(
        supabase, claim.id,
        `waiting-on-attestation: http=${res.status}, messages=${data?.messages?.length ?? 0}, msgStatus=${msg?.status ?? 'none'}`
      )
    }
  } catch (e) {
    // Previously only console.error'd — invisible in ephemeral logs with
    // short retention, exactly the pattern that made earlier claims
    // undiagnosable. Persist it to the row itself.
    console.error(`[claim-worker] waitForBridge transient error for ${claim.id}:`, e)
    await persistErrorBestEffort(supabase, claim.id, `waitForBridge: ${serializeError(e)}`)
  }
}

async function settleClaim(supabase: SupabaseClient, claim: Claim) {
  await updateClaim(supabase, claim.id, { status: 'settling', settling_at: new Date().toISOString() })
}

async function confirmArrival(supabase: SupabaseClient, claim: Claim) {
  try {
    if (claim.destination_tx_hash) {
      // arrived_amount can be missing here if destination_tx_hash was set
      // by an earlier run that itself predates this fix, or by a path that
      // doesn't capture amount — fetch it now rather than permanently
      // falling back to the gross claimed amount everywhere this claim is
      // ever displayed.
      const arrivedAmount = claim.arrived_amount ?? await fetchMintAmountForTx(claim.destination_tx_hash)
      await updateClaim(supabase, claim.id, {
        status: 'completed', completed_at: new Date().toISOString(), error: null,
        ...(claim.arrived_amount == null && arrivedAmount != null ? { arrived_amount: arrivedAmount } : {}),
      })
      logSettlementMetrics(claim)
      await recordClaimActivity(supabase, claim, 'completed', arrivedAmount ?? undefined, claim.destination_tx_hash)
      await notifyClaimComplete(supabase, claim, arrivedAmount ?? claim.amount)
      return
    }

    if (claim.message_hash) {
      const decoded = decodeCctpMessageNonce(claim.message_hash)
      if (decoded && ARC_MESSAGE_TRANSMITTER) {
        const log = await findCctpReceiveLog(decoded.nonce)
        if (log) {
          const relayTimestamp = await getBlockTimestamp(log.blockNumber)
          await updateClaim(supabase, claim.id, {
            status:              'completed',
            destination_tx_hash: log.transactionHash,
            receiver_block:      log.blockNumber,
            relay_timestamp:     relayTimestamp,
            completed_at:        new Date().toISOString(),
            error:               null,
            arrived_amount:      log.amount ?? null,
          })
          await recordClaimActivity(supabase, claim, 'completed', log.amount ?? undefined, log.transactionHash)
          await notifyClaimComplete(supabase, claim, log.amount ?? claim.amount)
          logSettlementMetrics(claim)
          return
        }
      }
    }

    const result = await findIncomingMintByAmount(claim.wallet_address, Number(claim.amount))
    let claimed = false
    const skippedAlreadyUsed: string[] = []
    for (const mint of result.matches) {
      const { data: alreadyUsed } = await supabase
        .from('claims')
        .select('id')
        .eq('destination_tx_hash', mint.transactionHash)
        .neq('id', claim.id)
        .maybeSingle()

      if (alreadyUsed) {
        // Previously the single-best-candidate version returned completely
        // silently here — no diagnostic, no trace, and no attempt to fall
        // back to a different candidate. With many same-amount test claims
        // run close together, the best match is often already claimed by a
        // different row; now we just move on to the next-best candidate
        // instead of giving up entirely.
        skippedAlreadyUsed.push(`${mint.transactionHash}->${alreadyUsed.id}`)
        continue
      }

      const relayTimestamp = await getBlockTimestamp(mint.blockNumber)
      await updateClaim(supabase, claim.id, {
        status:              'completed',
        destination_tx_hash: mint.transactionHash,
        receiver_block:      mint.blockNumber,
        relay_timestamp:     relayTimestamp,
        completed_at:        new Date().toISOString(),
        error:               null,
        arrived_amount:      mint.amount ?? null,
      })
      await recordClaimActivity(supabase, claim, 'completed', mint.amount, mint.transactionHash)
      await notifyClaimComplete(supabase, claim, mint.amount ?? claim.amount)
      logSettlementMetrics(claim)
      claimed = true
      break
    }

    if (!claimed) {
      // No usable match — persist WHY, not just "still pending". Previously
      // this failed completely silently (a null return with no trace),
      // which is exactly what made earlier stuck claims undiagnosable even
      // after the RPC-range bug was fixed. `error` here is a breadcrumb,
      // not a terminal failure — it gets overwritten harmlessly next pass
      // once a usable match is found.
      const diag = result.candidateCount === 0
        ? 'no-match: 0 Transfer logs found to this recipient in scanned range (topic/address/window issue)'
        : skippedAlreadyUsed.length > 0
          ? `no-match: all ${skippedAlreadyUsed.length} qualifying candidate(s) already claimed: [${skippedAlreadyUsed.join(', ')}]`
          : `no-match: ${result.candidateCount} candidate log(s) found, amounts=[${result.candidateAmounts.join(',')}], expected>=${(Number(claim.amount) * 0.99).toFixed(6)}`
      await persistErrorBestEffort(supabase, claim.id, diag)
    }
  } catch (error) {
    console.error(`[claim-worker] confirmArrival error for claim ${claim.id}:`, error)
    await persistErrorBestEffort(supabase, claim.id, `confirmArrival: ${serializeError(error)}`)
  }
}

const ARC_EXPLORER = 'https://testnet.arcscan.app'
// Same coverage gap as CHAIN_RPCS above, lower severity: this only affects
// which chain's block explorer the activity row's link points to (falls
// back safely to Arc's explorer via `?? ARC_EXPLORER` below when missing),
// not whether a claim can complete — but still wrong for 15 of 21 chains.
// URLs reused from the same verified set already established in
// ActivityPage.tsx, keyed by the actual canonical chain-id used everywhere
// else (Polygon_Sepolia — ActivityPage.tsx's own map has a documented
// mismatch here using 'Polygon_Amoy_Testnet' instead, a separate bug not
// fixed as part of this pass). Morph/Pharos/Codex/Edge intentionally
// omitted, same as ActivityPage.tsx — no confirmed public explorer found
// for them, and a wrong link is worse than the existing Arc fallback.
const CHAIN_EXPLORER: Record<string, string> = {
  Ethereum_Sepolia:    'https://sepolia.etherscan.io',
  Base_Sepolia:        'https://sepolia.basescan.org',
  Arbitrum_Sepolia:    'https://sepolia.arbiscan.io',
  Optimism_Sepolia:    'https://sepolia-optimism.etherscan.io',
  Polygon_Sepolia:     'https://amoy.polygonscan.com',
  Avalanche_Fuji:      'https://testnet.snowtrace.io',
  Unichain_Sepolia:    'https://sepolia.uniscan.xyz',
  HyperEVM_Testnet:    'https://explore-testnet.hyperpc.app',
  Sei_Testnet:         'https://testnet.seiscan.io',
  Sonic_Testnet:       'https://testnet.sonicscan.org',
  World_Chain_Sepolia: 'https://sepolia.worldscan.org',
  Linea_Sepolia:       'https://sepolia.lineascan.build',
  Ink_Testnet:         'https://explorer-sepolia.inkonchain.com',
  XDC_Apothem:         'https://testnet.xdcscan.com',
  Injective_Testnet:   'https://testnet.explorer.injective.network',
  Plume_Testnet:       'https://testnet-explorer.plume.org',
  Monad_Testnet:       'https://monad-testnet.socialscan.io',
  Morph_Testnet:       'https://explorer-hoodi.morph.network',
}

// Sends a real server-side push the instant a claim completes — works even
// if the user closed the app during the attestation wait, unlike the
// client-side fireWebPush() in src/lib/bridgeTracker.ts (plain
// `new Notification()`, which only works while the tab/page is still alive).
// Best-effort: a failure here never blocks or retries the claim's own
// completion — the claim itself is already done and correctly recorded by
// the time this runs; a missed notification is a much smaller problem than
// re-processing a completed claim over a notification hiccup.
async function notifyClaimComplete(supabase: SupabaseClient, claim: Claim, amount: number): Promise<void> {
  if (!PUSH_INTERNAL_SECRET) {
    console.warn('[claim-worker] PUSH_INTERNAL_SECRET not set — skipping completion push, claim itself is unaffected')
    return
  }
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', claim.wallet_address.toLowerCase())
      .maybeSingle()
    if (error || !user?.id) return

    const chainLabel = (claim.source_chain || '').replace(/_Sepolia|_Testnet|_Fuji/g, '').replace(/_/g, ' ')
    await fetch(`${APP_BASE_URL}/api/push?action=send-internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_INTERNAL_SECRET}` },
      body: JSON.stringify({
        userId: user.id,
        title:  'Claim Complete',
        body:   `$${amount.toFixed(2)} USDC arrived on Arc from ${chainLabel}`,
        url:    '/multichain',
        tag:    `claim-complete-${claim.id}`,
      }),
    })
  } catch (e) {
    console.warn('[claim-worker] notifyClaimComplete failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

async function recordClaimActivity(supabase: SupabaseClient, claim: Claim, status: 'completed' | 'failed', arrivedAmount?: number, destinationTxHash?: string | null) {
  try {
    const txHash = (claim.tx_hash || '').toLowerCase()
    if (!txHash) return

    // The actual amount shown in the Hub/Activity list ("+$X.XX") should be
    // what genuinely arrived, not what was originally claimed — a real
    // CCTP/relay fee (confirmed in practice: ~2.5%) means these can
    // legitimately differ, and showing the claimed figure was misleading.
    // Falls back to claim.amount only when the real arrived figure isn't
    // known yet (the CCTP MessageReceived completion path doesn't currently
    // decode a transfer amount) — original claimed amount is preserved in
    // metadata either way, not discarded.
    const displayAmount = arrivedAmount ?? claim.amount

    const base = CHAIN_EXPLORER[claim.source_chain] ?? ARC_EXPLORER
    // destinationTxHash is passed explicitly by the caller rather than read
    // off `claim.destination_tx_hash` here — every completion path above
    // discovers the mint hash and writes it to the `claims` table via
    // updateClaim() *milliseconds before* calling this function, but that's
    // a separate async DB write that doesn't mutate this in-memory `claim`
    // object. Reading claim.destination_tx_hash here would silently save
    // `null` into the activity row even though the real hash was just
    // found — which is exactly why the Activity page's claim cards never
    // showed a destination/mint link or hash, unlike transfer cards.
    const destHash = (destinationTxHash ?? claim.destination_tx_hash ?? null)
    const destHashLower = destHash ? destHash.toLowerCase() : null

    const { error } = await supabase
      .from('activity')
      .upsert({
        wallet_address:    claim.wallet_address.toLowerCase(),
        tx_hash:           txHash,
        destination_tx_hash: destHashLower,
        activity_type:     'claim',
        amount:            displayAmount,
        usd_value:         displayAmount,
        arrived_amount:    arrivedAmount ?? null,
        token_symbol:      'USDC',
        source_chain:      claim.source_chain,
        destination_chain: 'Arc_Testnet',
        status,
        explorer_url:      `${base}/tx/${txHash}`,
        metadata:          { claimed_amount: claim.amount },
      }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })

    if (error) console.error(`[claim-worker] recordClaimActivity failed for ${claim.id}:`, error.message)
  } catch (e) {
    console.error(`[claim-worker] recordClaimActivity threw for ${claim.id}:`, e)
  }
}

async function markFailed(supabase: SupabaseClient, claim: Claim, errorMsg: string) {
  const { data: latest, error: fetchErr } = await supabase
    .from('claims').select('status').eq('id', claim.id).single()

  if (fetchErr) {
    console.error(`[claim-worker] markFailed: couldn't re-check status for ${claim.id}:`, fetchErr.message)
    return
  }
  if (latest?.status === 'completed') return

  await updateClaim(supabase, claim.id, { status: 'failed', error: errorMsg.slice(0, 250) })
  await recordClaimActivity(supabase, claim, 'failed')
}

async function advanceClaim(supabase: SupabaseClient, claim: Claim) {
  // Previously this only ever processed ONE stage transition per call, no
  // matter what. That's fine when a stage is genuinely still waiting on
  // something real (an unmined receipt, a pending attestation) — but when
  // the underlying reality has already moved past multiple stages by the
  // time a check finally runs (e.g. the mint landed on Arc before this
  // invocation even started), it meant claims.status was artificially
  // throttled to advance one step per kick regardless, needing up to 4
  // separate invocations — each waiting for its own kick cycle — to catch
  // up to something that was already fully true. Looping here lets a
  // single invocation walk through every stage that's actually ready,
  // right now, so status can catch up to reality in one shot instead of
  // lagging behind it by (remaining stages × kick interval). Bounded to 4
  // iterations — one per real stage — so a genuinely-stuck claim can't
  // spin here; it just exits after its one real stage doesn't advance.
  for (let i = 0; i < 4; i++) {
    console.log('processing', claim.id)

    const { data: latest, error: fetchErr } = await supabase
      .from('claims').select('*').eq('id', claim.id).single()

    if (fetchErr) {
      console.error(`[claim-worker] couldn't re-fetch claim ${claim.id} before advancing:`, fetchErr.message)
      return
    }
    if (latest.status === 'completed' || latest.status === 'failed') return

    console.log('incrementing', claim.id)
    const { data: incrementedRaw, error: incErr } = await supabase.rpc('increment_claim_attempts', {
      p_claim_id: claim.id,
    })
    if (incErr) {
      console.error(`[claim-worker] attempts increment failed for ${claim.id}:`, incErr.message)
      await persistErrorBestEffort(supabase, claim.id, `attempts increment failed: ${incErr.message}`)
      return
    }
    const incremented = Array.isArray(incrementedRaw) ? incrementedRaw[0] : incrementedRaw
    console.log('increment success', claim.id, incremented?.attempts)

    // Settling has its own real-time budget, independent of the shared
    // attempts counter — see SETTLING_TIMEOUT_MS above for why. Every other
    // stage still uses the attempts-based MAX_ATTEMPTS check.
    if (latest.status === 'settling') {
      const settlingStartMs = latest.settling_at ? new Date(latest.settling_at).getTime() : Date.now()
      if (Date.now() - settlingStartMs >= SETTLING_TIMEOUT_MS) {
        // Last-chance reconciliation before giving up: the normal settling
        // handler (confirmArrival) doesn't run on the pass where the timeout
        // trips, so a mint that landed since the previous pass would
        // otherwise be missed and the claim marked `failed` with the USDC
        // already on Arc. Run one full confirmArrival now (it scans the
        // widened LOG_SCAN_WINDOW_BLOCKS) and only fail if it still can't
        // find the mint.
        await confirmArrival(supabase, latest)
        const { data: afterCheck } = await supabase
          .from('claims').select('status').eq('id', latest.id).single()
        if (afterCheck?.status === 'completed') return
        await markFailed(supabase, latest, 'Timed out waiting for funds to arrive on Arc')
        return
      }
    } else if (latest.status === 'bridging') {
      // Deliberately UNBOUNDED — no MAX_ATTEMPTS ceiling here, and this is
      // intentional, not an oversight. By the time a claim reaches
      // 'bridging', the burn on the source chain has already happened —
      // it's irreversible. There is no valid "give up" outcome for this
      // stage: marking the claim 'failed' here doesn't return anything to
      // the user, it just stops our own system from watching for an
      // attestation that Circle will eventually still produce. A real
      // incident (found in production): a claim sat at
      // msgStatus=pending_confirmations for 45+ minutes — far past the old
      // MAX_ATTEMPTS window (~12-15 min) — then kept polling successfully
      // once manually reset, with Circle's own API confirming the message
      // the whole time (http=200, messages=1) — it just hadn't attested
      // yet. Letting the claim die and requiring a manual DB reset to
      // resume checking was the actual bug, not anything about how long
      // Circle took. This is a single cheap HTTP call per pass (see
      // waitForBridge) — retrying indefinitely costs nothing meaningful,
      // and the stuck-claim watchdog below (checkStuckClaims) still
      // provides operator visibility if a claim's updated_at genuinely
      // stops advancing, which an actively-polling claim's won't.
    } else if ((incremented?.attempts ?? latest.attempts) >= MAX_ATTEMPTS) {
      await markFailed(supabase, latest, 'Timed out waiting for bridge to complete')
      return
    }

    switch (latest.status) {
      case 'submitted': await bridgeFunds(supabase, latest); break
      case 'bridging':  await waitForBridge(supabase, latest); break
      case 'verifying': await settleClaim(supabase, latest); break
      case 'settling':  await confirmArrival(supabase, latest); break
      default: return
    }

    // Did that stage function actually move the status forward? If not —
    // still genuinely waiting on something real — stop here and let the
    // next scheduled kick check again later, rather than spinning
    // pointlessly. If it DID advance, loop immediately and try the next
    // stage right now, in this same invocation.
    const { data: after } = await supabase.from('claims').select('status').eq('id', claim.id).single()
    if (!after || after.status === latest.status) return
  }
}

async function fetchDueClaims(supabase: SupabaseClient, claimId?: string): Promise<Claim[]> {
  if (claimId) {
    const { data, error } = await supabase.rpc('fetch_and_lock_due_claims', { p_claim_id: claimId })
    if (error) { console.error('[claim-worker] fetch error (single)', error.message); return [] }
    return (data ?? []) as Claim[]
  }

  // Atomic lock-and-claim RPC (see migration 20260706130000_settlement_hardening.sql)
  // is now the AUTHORITATIVE concurrency guard — it combines FOR UPDATE
  // SKIP LOCKED with an UPDATE...RETURNING in one statement, so two
  // concurrent invocations (a single-mode kick racing the cron sweep, or two
  // overlapping sweep passes) can never both select the same row. The old
  // approach only filtered by a timestamp cutoff with no actual row lock —
  // real, but optimistic. Pagination loop unchanged: since each call already
  // marks what it returns (bumps updated_at) as part of the same statement,
  // repeated calls naturally see only still-untouched rows.
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString()
  const all: Claim[] = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase.rpc('fetch_and_lock_due_claims', {
      p_stale_cutoff: cutoff,
      p_limit: FETCH_PAGE_SIZE,
    })

    if (error) { console.error('[claim-worker] fetch error (sweep)', error.message); break }
    if (!data || data.length === 0) break

    all.push(...(data as Claim[]))
    if (data.length < FETCH_PAGE_SIZE) break
    offset += FETCH_PAGE_SIZE
    if (offset > 10_000) break // sane upper bound — this many non-terminal claims would indicate something else is wrong
  }

  return all
}

async function checkStuckClaims(supabase: SupabaseClient) {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MIN * 60_000).toISOString()
  const { data, error } = await supabase
    .from('claims')
    .select('id, status, updated_at, attempts')
    .in('status', ['submitted', 'bridging', 'verifying', 'settling'])
    .lt('updated_at', cutoff)
    .eq('needs_review', false)

  if (error) { console.error('[claim-worker] watchdog query failed:', error.message); return }
  if (!data || data.length === 0) return

  console.warn(`[claim-worker] WATCHDOG: ${data.length} claim(s) stuck > ${STUCK_THRESHOLD_MIN}min`, data)

  const ids = data.map(c => c.id)
  const { error: flagErr } = await supabase.from('claims').update({ needs_review: true }).in('id', ids)
  if (flagErr) console.error('[claim-worker] watchdog: failed to flag needs_review:', flagErr.message)

  // Actually notify someone, not just flag a column nobody's watching.
  // Pluggable via env var — no alerting destination (Slack/PagerDuty/email)
  // is configured for this project yet, so this is a no-op until
  // ALERT_WEBHOOK_URL is set, but the dispatch path now exists rather than
  // needing to be added later. Any webhook accepting a JSON POST works
  // (Slack incoming webhooks, Discord, a custom endpoint, etc).
  const webhookUrl = Deno.env.get('ALERT_WEBHOOK_URL')
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `[MeshPort] ${data.length} claim(s) stuck > ${STUCK_THRESHOLD_MIN}min: ${ids.join(', ')}`,
          claims: data,
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (e) {
      console.error('[claim-worker] watchdog: alert webhook failed:', e)
    }
  }
}

async function processPass(supabase: SupabaseClient, claimId?: string) {
  const claims = await fetchDueClaims(supabase, claimId)
  console.log('fetchDueClaims', claims.length)
  console.log(claims.map(c => ({ id: c.id, status: c.status, attempts: c.attempts, updated_at: (c as any).updated_at })))

  await Promise.all(claims.map(c => advanceClaim(supabase, c).catch(e => {
    console.error(`[claim-worker] advance ${c.id} failed:`, serializeError(e))
    return persistErrorBestEffort(supabase, c.id, `advanceClaim threw: ${serializeError(e)}`)
  })))
  return claims.length
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  let body: any = {}
  try { body = await req.json() } catch { /* sweep may send no body */ }

  const mode = body?.mode === 'single' ? 'single' : 'sweep'

  if (mode === 'single' && body?.claimId) {
    const start = Date.now()
    let totalProcessed = 0
    while (Date.now() - start < SWEEP_DURATION_MS) {
      const { data, error } = await supabase.from('claims').select('status').eq('id', body.claimId).maybeSingle()
      if (error) { console.error('[claim-worker] single mode status check failed:', error.message); break }
      if (!data || data.status === 'completed' || data.status === 'failed') break
      totalProcessed += await processPass(supabase, body.claimId)
      await new Promise(r => setTimeout(r, SWEEP_INTERVAL_MS))
    }
    return json({ success: true, mode, processed: totalProcessed })
  }

  await checkStuckClaims(supabase)

  const start = Date.now()
  let totalProcessed = 0
  while (Date.now() - start < SWEEP_DURATION_MS) {
    totalProcessed += await processPass(supabase)
    await new Promise(r => setTimeout(r, SWEEP_INTERVAL_MS))
  }

  return json({ success: true, mode, totalProcessed })
})
