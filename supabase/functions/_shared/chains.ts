// Server-side chain config for the claim worker.
// Mirrors src/features/multichain/MultichainClaimPage.tsx CHAIN_CONFIG / CCTP_DOMAINS
// but only what's needed for READ-ONLY verification (no signing happens here).

// Every chain here previously had 2 RPC endpoints EXCEPT HyperEVM, Sei,
// Sonic, Unichain, and World Chain — each had exactly one, no fallback.
// Confirmed root cause of claims from those chains getting permanently
// stuck at 'Bridging' whenever that single endpoint had any transient
// issue. All five now have a second, verified public endpoint.
// CCTP_DOMAINS below previously only had 11 of the 21 supported chains —
// this file had drifted out of sync with claim-worker/index.ts's inlined
// copy of it, which already got the missing 10 chains added in an earlier
// pass. Not currently live-impacting (claim-submit, the only importer of
// this file, only uses getArcNativeBalance below, not these maps) — synced
// anyway so this file stays trustworthy as the documented canonical source
// if anything imports CHAIN_RPCS/CCTP_DOMAINS from here in the future.
// drpc.live API key — set DRPC_KEY in Supabase project secrets
const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
// Optional explicit authenticated RPC URL override — set ARC_RPC_URL in
// Supabase project secrets to point at a specific authenticated gateway.
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()

export const CHAIN_RPCS: Record<string, string[]> = {
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

// Circle CCTP domain IDs, keyed the same as CHAIN_RPCS
export const CCTP_DOMAINS: Record<string, number> = {
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
// drpc.org). Those were exactly how claim verification could end up
// querying arc-testnet.rpc.thirdweb.com even with an authenticated RPC
// configured elsewhere in the app.
export const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
]

export const CIRCLE_IRIS_API = 'https://iris-api-sandbox.circle.com'

// Arc testnet MessageTransmitter contract address. This is the CCTP contract
// that emits `MessageReceived` when a mint is actually delivered — this is
// the ONLY authoritative on-chain signal that a claim has settled.
// TODO(ops): fill in the real deployed address for Arc testnet and remove
// the placeholder guard in findCctpReceiveLog() below. Until this is set,
// event-based detection is skipped and the worker falls back to balance
// heuristics with a loud warning — do not ship to a real-money environment
// with this still unset.
export const ARC_MESSAGE_TRANSMITTER =
  Deno.env.get('ARC_MESSAGE_TRANSMITTER_ADDRESS') ?? ''

// CCTP v2 changed this event's shape from v1 (nonce: uint64 → bytes32,
// added finalityThresholdExecuted before messageBody) — a different event
// shape means a completely different topic0 hash, even though the event
// name and emitting contract are the same. The v1 hash below was verified
// against Circle's public MessageTransmitter.sol source and is correct —
// for v1. Confirmed via production logs that at least one real mint's
// MessageReceived log came from exactly the right contract address but
// didn't match this v1-only topic, meaning it was actually emitted via v2.
// Filtering for only v1 meant such a mint would never be found by this
// query, silently falling through to claim-recovery-scan's slower backfill
// instead of being detected on the fast path here.
// keccak256("MessageReceived(address,uint32,uint64,bytes32,bytes)")
// (Circle's evm-cctp-contracts MessageTransmitter.sol — verified against the
// public source, not guessed.)
const MESSAGE_RECEIVED_TOPIC0_V1 =
  '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d'
// keccak256("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")
const MESSAGE_RECEIVED_TOPIC0_V2 =
  '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c'

// ── Minimal read-only JSON-RPC helper (no ethers dependency needed) ─────────
export async function rpcCall(urls: string[], method: string, params: unknown[]): Promise<any> {
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
      const json = await res.json()
      if (json.error) { lastErr = json.error; continue }
      return json.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`RPC call ${method} failed on all endpoints`)
}

export async function getTransactionReceipt(chainId: string, txHash: string) {
  const urls = CHAIN_RPCS[chainId] ?? []
  if (!urls.length) return null
  try {
    return await rpcCall(urls, 'eth_getTransactionReceipt', [txHash])
  } catch {
    return null
  }
}

// Query a single Arc RPC endpoint directly (no fallback chain) so we can
// race all endpoints in parallel below instead of stopping at the first
// non-erroring response.
async function rpcCallSingle(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // no-store: some public RPC front-ends sit behind a CDN/edge cache and
    // will otherwise happily serve a cached (stale) eth_getBalance result.
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`)
  const json = await res.json()
  if (json.error) throw json.error
  return json.result
}

export async function getArcNativeBalance(address: string): Promise<number> {
  // IMPORTANT: do not use rpcCall()'s "first non-erroring response wins"
  // behavior here. Arc's public testnet RPCs are independently load-balanced
  // nodes that can fall behind head independently of each other; the first
  // endpoint in ARC_RPCS answering successfully (but from a lagging node)
  // will silently mask funds that have already arrived on the other nodes.
  //
  // Balance is monotonically non-decreasing while a mint is pending, so it's
  // always safe to take the MAX across whichever endpoints respond — a
  // stale node can only under-report, never over-report.
  const results = await Promise.allSettled(
    ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getBalance', [address, 'latest']))
  )

  // FIX (was: `raw !== '0x0'`): a genuinely zero balance is a VALID result,
  // not a sign of a lagging node. The old filter excluded '0x0' responses
  // entirely, which meant a wallet that legitimately has zero balance (fresh
  // address, or fully drained by a payment) could cause every endpoint's
  // result to be dropped, `values.length === 0`, and the function would
  // throw instead of correctly returning 0. Only null/undefined/'0x' (an
  // empty/invalid RPC response, not a value) are excluded now.
  const values = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(raw => raw !== null && raw !== undefined && raw !== '0x')
    .map(raw => Number(BigInt(raw)) / 1e18) // Arc native balance is 18-decimal wei-style, USDC value = /1e18

  if (values.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw firstError?.reason ?? new Error('getArcNativeBalance: all Arc RPC endpoints failed')
  }

  return Math.max(...values)
}

// ── CCTP message decoding + authoritative on-chain arrival detection ───────
//
// `message_hash` (poorly named — it's historical) actually stores the RAW
// CCTP message bytes returned by Circle's IRIS API (`msg.message`), not a
// hash. CCTP v1 message layout (all offsets in bytes):
//
//   [0:4]     version            uint32
//   [4:8]     sourceDomain       uint32
//   [8:12]    destinationDomain  uint32
//   [12:20]   nonce              uint64
//   [20:52]   sender             bytes32
//   [52:84]   recipient          bytes32
//   [84:116]  destinationCaller  bytes32
//   [116:]    messageBody        bytes
//
// This lets us recover the nonce and decode it against Arc's MessageTransmitter
// `MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)`
// event — the actual, authoritative "funds were delivered" signal — instead
// of inferring arrival from wallet balance deltas.
export function decodeCctpMessageNonce(messageHex: string): { nonce: bigint; sourceDomain: number } | null {
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

export type CctpReceiveLog = {
  transactionHash: string
  blockNumber: number
}

// ── Bounded, range-limit-aware log fetching ─────────────────────────────────
// Both findCctpReceiveLog and findIncomingMintByAmount previously queried
// `fromBlock: '0x0', toBlock: 'latest'` — an UNBOUNDED full-chain-history
// range. Public RPC providers commonly reject this outright (confirmed
// directly: Arc's RPC returned {"code":-32614,"message":"eth_getLogs is
// limited to ..."} on every single attempt, which is the actual reason
// claims were getting permanently stuck in 'settling' — not a logic bug in
// the matching itself, but every query for it failing before it could even
// run). A claim's relevant events only ever happen within a very recent
// window (minutes, not the chain's entire history), so there's no reason to
// ask for more than that.
const LOG_SCAN_WINDOW_BLOCKS = 5000 // generous window; Arc's block time is fast (~1s), so this covers well over an hour

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
  return Math.max(...values) // same "stale node under-reports" reasoning as getArcNativeBalance
}

// Local mirror of claim-worker's serializeError — chains.ts is shared and
// shouldn't depend on claim-worker's internals, but needs the same
// "don't collapse plain objects into '[object Object]'" safety here too,
// specifically to read the RPC provider's own error message text below.
function serializeErrorForRpc(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

// Runs an eth_getLogs filter with a bounded, recent block range instead of
// scanning full history. If the provider's error message reveals a smaller
// allowed range (many RPCs literally state their limit in the error text,
// e.g. "...limited to a 1000 range"), retries once with that exact size
// rather than failing outright.
async function fetchLogsBounded(filterBase: Record<string, unknown>): Promise<any[]> {
  const currentBlock = await getCurrentArcBlockNumber()
  const fromBlock = Math.max(0, currentBlock - LOG_SCAN_WINDOW_BLOCKS)

  const runWith = async (from: number) => {
    const filter = { ...filterBase, fromBlock: '0x' + from.toString(16), toBlock: 'latest' }
    const results = await Promise.allSettled(
      ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getLogs', [filter]))
    )
    const logs = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .flatMap(r => (Array.isArray(r.value) ? r.value : []))
    if (logs.length > 0) return logs

    const anySucceeded = results.some(r => r.status === 'fulfilled')
    if (anySucceeded) return [] // genuinely no matching logs in range yet — normal "not arrived" state

    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw firstError?.reason ?? new Error('fetchLogsBounded: all Arc RPC endpoints failed')
  }

  try {
    return await runWith(fromBlock)
  } catch (e) {
    const msg = serializeErrorForRpc(e)
    const rangeMatch = msg.match(/limited to[^\d]*(\d[\d,]*)/i)
    if (rangeMatch) {
      const allowed = parseInt(rangeMatch[1].replace(/,/g, ''), 10)
      if (Number.isFinite(allowed) && allowed > 0 && allowed < LOG_SCAN_WINDOW_BLOCKS) {
        return await runWith(Math.max(0, currentBlock - allowed))
      }
    }
    throw e
  }
}

// Look for the MessageReceived log matching this nonce on Arc. Returns null
// (not an error) if not found yet — that's the normal "still pending" state.
// Throws only on genuine RPC failure across all endpoints, same contract as
// getArcNativeBalance, so callers can distinguish "not arrived yet" from
// "couldn't check right now".
export async function findCctpReceiveLog(nonce: bigint): Promise<CctpReceiveLog | null> {
  if (!ARC_MESSAGE_TRANSMITTER) {
    // Not configured — caller must fall back to a secondary signal.
    return null
  }

  const nonceTopic = '0x' + nonce.toString(16).padStart(64, '0')
  const filter = {
    address: ARC_MESSAGE_TRANSMITTER,
    // topics: [event sig (v1 or v2), caller (indexed, any), nonce (indexed, ours)]
    topics: [[MESSAGE_RECEIVED_TOPIC0_V1, MESSAGE_RECEIVED_TOPIC0_V2], null, nonceTopic],
  }

  const logs = await fetchLogsBounded(filter)
  if (logs.length === 0) return null // genuinely not delivered yet

  const log = logs[0]
  return {
    transactionHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
  }
}

// Arc's native currency IS USDC, but it's also exposed as a fixed-address
// ERC-20-style contract for indexer/explorer/wallet compatibility — this is
// the same address src/lib/arcService.ts already uses client-side to read
// USDC balance via ERC-20 calls. Transfer logs (including mints) are emitted
// from this specific address, NOT from an arbitrary/unknown contract.
export const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'

// keccak256("Transfer(address,address,uint256)") — the standard ERC-20
// transfer event topic. Arc's native currency IS USDC (see
// getArcNativeBalance above), but Arc still emits this standard log on
// mint/transfer for indexer/explorer compatibility (confirmed directly
// against an Arc explorer capture: a claim mint shows as
// "Null: 0x000...000 -> wallet, Minting, ERC-20: USDC").
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC =
  '0x' + '0'.repeat(64) // address(0) as an indexed topic (32-byte, zero-padded)

export type MintTransferLog = {
  transactionHash: string
  blockNumber: number
}

// Look for a specific incoming mint Transfer matching this exact recipient +
// amount. This replaces the old balance-delta heuristic
// (`currentBalance >= before + expected`), which had a real correctness gap:
// any OTHER activity on the same wallet during the settling window —
// someone else sending the user funds, the user doing a swap or send, or a
// second concurrent claim — would shift the balance and could cause a false
// "arrived" (premature complete) or false negative (balance never crosses
// the threshold, e.g. after a swap/spend, leaving the claim stuck forever).
// Matching a specific Transfer event by recipient+amount is immune to any of
// that, the same way findCctpReceiveLog() is immune to it for the primary
// path — this only ever matches an event that this exact claim's mint,
// specifically, could have produced.
//
// amountUsdc: the claimed amount, in human units (e.g. 5 for $5 USDC).
// decimals: USDC is 6-decimal as an ERC-20 value in the Transfer log, even
// though the *native* balance representation used elsewhere in this file is
// 18-decimal wei-style — these are two different encodings of the same
// token and must not be confused.
export async function findIncomingMintByAmount(
  recipient: string,
  amountUsdc: number,
): Promise<MintTransferLog | null> {
  const recipientTopic = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const filter = {
    address: ARC_USDC_CONTRACT,
    topics: [TRANSFER_TOPIC0, MINT_FROM_TOPIC, recipientTopic],
  }

  const logs = await fetchLogsBounded(filter)
  if (logs.length === 0) return null // genuinely not delivered yet

  // Match by amount (USDC Transfer value is 6-decimal, unlike the 18-decimal
  // native balance representation elsewhere in this file). Allow a tiny
  // tolerance for floating point round-tripping, same 0.99 factor the old
  // heuristic used elsewhere in claim-worker.
  const expectedRaw = BigInt(Math.round(amountUsdc * 1e6))
  const match = logs.find((log: any) => {
    try {
      const value = BigInt(log.data)
      return value >= (expectedRaw * 99n) / 100n
    } catch { return false }
  })

  if (!match) return null

  return {
    transactionHash: match.transactionHash,
    blockNumber: Number(BigInt(match.blockNumber)),
  }
}

export async function getBlockTimestamp(blockNumber: number): Promise<string | null> {
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
