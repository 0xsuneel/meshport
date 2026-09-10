// supabase/functions/claim-recovery-scan/index.ts
//
// SELF-CONTAINED, same reasoning as claim-worker/index.ts: the dashboard
// editor doesn't reliably support separate shared files, so everything
// needed is inlined here.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// A claim only ever gets durably tracked from the moment its burn
// transaction CONFIRMS (that's when the app saves a recovery record and
// calls claim-submit). If the app is closed in the narrow window after
// approval but before the burn confirms, the burn can still go through —
// irreversible once broadcast — and Circle's infrastructure will still
// complete the mint on Arc entirely independent of MeshPort's own tracking.
// But since nothing was ever recorded, there's no `claims` row: no Hub card,
// no notification, no history, even though the money is real and already in
// the wallet. This happened in practice (not just in theory) during testing.
//
// ── Why scan Arc instead of every source chain ──────────────────────────────
// The obvious-seeming fix is scanning each source chain for burns from the
// wallet. That's fragile in practice: different bridge routers (e.g. "Bridge
// With Preapproval And Hook") wrap the underlying CCTP burn call, and
// correctly detecting a DepositForBurn event requires knowing the right
// event signature per CCTP version per router — exactly the ambiguity that
// caused real confusion earlier (a stuck claim's attestation lookup
// returning 404 with no clear way to confirm whether a valid CCTP message
// was ever emitted). Scanning Arc for INCOMING mints instead reuses the
// exact same event-matching code already proven reliable in claim-worker
// (fetchLogsBounded / TRANSFER_TOPIC0 / MINT_FROM_TOPIC) — one chain, one
// battle-tested code path, no per-router guessing.
//
// Trade-off, stated plainly: since detection happens from the Arc side only,
// a recovered claim's source_chain isn't known from the mint's Transfer
// event alone. It's resolved separately, from that same mint transaction's
// CCTP MessageReceived event (emitted by Circle's MessageTransmitter
// contract, which encodes the real sourceDomain) — the same decoding
// claim-worker's normal path already relies on. Only falls back to
// 'Unknown' if ARC_MESSAGE_TRANSMITTER_ADDRESS isn't configured, the log
// can't be found, or the domain isn't one of ours — genuinely unresolvable
// cases, not the common case.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { isKnownInternalContract } from '../_shared/knownInternalContracts.ts'
import { findCorrelatedTrackedFeature } from '../_shared/trackedFeatureCorrelation.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  return null
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// drpc.live API key — set DRPC_KEY in Supabase project secrets
const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
// Optional explicit authenticated RPC URL override — set ARC_RPC_URL in
// Supabase project secrets to point at a specific authenticated gateway.
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()

// Authenticated-only Arc endpoints — no direct public gateways
// (rpc.testnet.arc.network, Blockdaemon, dRPC public, QuickNode, thirdweb,
// drpc.org). Those were exactly how this scan could end up querying
// arc-testnet.rpc.thirdweb.com even with an authenticated RPC configured.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
]
const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)
const ARC_EXPLORER = 'https://testnet.arcscan.app'

// ── Sender-based internal-contract classification (docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md) ──
// A Transfer whose SENDER is one of these addresses is a MeshPort-internal
// transaction leg (a swap's output, a BulkPay/Multicall3 payout, CCTP
// infrastructure, or — if configured — a P2P escrow release/refund), not a
// genuine external deposit. Checked BEFORE existsActivityForTxHash/
// recordExternalReceive in every generic-receive branch below, so the
// classification no longer depends entirely on winning a timing race against
// the transaction's own, purpose-built Activity writer (SwapPage.tsx,
// BulkPayoutPage.tsx, p2pService.ts) — see the doc for the full EURC trace
// this fixes. P2P's escrow address(es), same env vars
// p2p-release-reconcile/index.ts already reads — not hardcoded here since no
// address was ever confirmed configured in every environment (see
// knownInternalContracts.ts's own comment on `extra`).
const P2P_ESCROW_CONTRACT = (Deno.env.get('P2P_ESCROW_CONTRACT') ?? '').trim().toLowerCase()
const P2P_ESCROW_CONTRACTS_LEGACY = (Deno.env.get('P2P_ESCROW_CONTRACTS_LEGACY') ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const KNOWN_INTERNAL_EXTRA = [P2P_ESCROW_CONTRACT, ...P2P_ESCROW_CONTRACTS_LEGACY].filter(Boolean)
// Added for native-USDC deposit detection (see the block below the ERC20-log
// scan, further down) — same values deposit-scan-all uses, kept in sync
// deliberately so both scanners agree on what a "native USDC transfer"
// looks like.
const ARC_EXPLORER_API = 'https://testnet.arcscan.app/api/v2'
const NATIVE_DECIMALS = 18

// ── CCTP source-chain resolution ─────────────────────────────────────────────
// A recovered claim is detected purely from the INCOMING mint on Arc — but
// that mint's own transaction also carries a MessageReceived event, emitted
// by Circle's CCTP MessageTransmitter contract, whose log data encodes the
// sourceDomain the message originated from. This is the exact same event
// claim-worker's normal (non-recovery) path already decodes — reusing it
// here means recovered claims no longer need to fall back to 'Unknown':
// the real source chain is sitting right there in the same transaction.
const ARC_MESSAGE_TRANSMITTER = Deno.env.get('ARC_MESSAGE_TRANSMITTER_ADDRESS') ?? ''
// CCTP v2 changed this event's shape from v1 (nonce: uint64 → bytes32, and
// added finalityThresholdExecuted before messageBody) — a different event
// shape means a completely different topic0 hash, even though the event
// name and the emitting contract are the same. Checking both makes this
// robust regardless of which CCTP version a given mint actually went
// through, rather than assuming only one is ever in play. Confirmed via
// production logs: a real recovered mint's MessageReceived log came from
// exactly the right contract address but neither topic0 matched only-v1,
// which is what caused it to fall back to 'Unknown' instead of resolving
// the real source chain.
// keccak256("MessageReceived(address,uint32,uint64,bytes32,bytes)")
const MESSAGE_RECEIVED_TOPIC0_V1 = '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d'
// keccak256("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")
const MESSAGE_RECEIVED_TOPIC0_V2 = '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c'

// Same table claim-worker uses (developers.circle.com/cctp/concepts/supported-chains-and-domains),
// inverted so a domain number found on-chain maps back to our chain-id strings.
const CCTP_DOMAIN_TO_CHAIN: Record<number, string> = {
  0:  'Ethereum_Sepolia',
  1:  'Avalanche_Fuji',
  2:  'Optimism_Sepolia',
  3:  'Arbitrum_Sepolia',
  6:  'Base_Sepolia',
  7:  'Polygon_Sepolia',
  10: 'Unichain_Sepolia',
  11: 'Linea_Sepolia',
  12: 'Codex_Testnet',
  13: 'Sonic_Testnet',
  14: 'World_Chain_Sepolia',
  15: 'Monad_Testnet',
  16: 'Sei_Testnet',
  18: 'XDC_Apothem',
  19: 'HyperEVM_Testnet',
  21: 'Ink_Testnet',
  22: 'Plume_Testnet',
  28: 'Edge_Testnet',
  29: 'Injective_Testnet',
  30: 'Morph_Testnet',
  31: 'Pharos_Testnet',
}

// Inlined rather than imported from _shared/chains.ts — matching this
// file's existing preference elsewhere (see claim-worker's own inlined
// copy of these same constants) for staying self-contained.
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

// keccak256("DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)")
// CCTP v1 only — nonce is the first indexed parameter, which is what makes
// an exact, reliable match possible at all (search by the exact nonce we
// already decoded from the Arc-side mint, not a fuzzy amount/time guess).
// CCTP v2 restructured DepositForBurn to no longer include nonce as part of
// this event at all — correlating a v2 burn requires matching by message
// hash instead, a genuinely different lookup this does not attempt. A v2
// source chain's claim will still fall back to the placeholder/no-source-
// link behavior rather than risk showing an unreliable, possibly wrong match.
const DEPOSIT_FOR_BURN_TOPIC0_V1 = '0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0'
const SOURCE_BURN_SCAN_WINDOW_BLOCKS = 500_000

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

async function findSourceBurnTx(sourceChain: string, nonce: bigint): Promise<string | null> {
  const urls = CHAIN_RPCS[sourceChain]
  if (!urls || urls.length === 0) return null
  try {
    const currentBlockHex = await rpcCall(urls, 'eth_blockNumber', [])
    const currentBlock = parseInt(currentBlockHex, 16)
    const fromBlock = Math.max(0, currentBlock - SOURCE_BURN_SCAN_WINDOW_BLOCKS)
    const nonceTopic = '0x' + nonce.toString(16).padStart(64, '0')
    const filter = {
      topics: [DEPOSIT_FOR_BURN_TOPIC0_V1, nonceTopic],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + currentBlock.toString(16),
    }
    const logs = await rpcCall(urls, 'eth_getLogs', [filter])
    return logs?.[0]?.transactionHash ?? null
  } catch (e) {
    console.error(`[claim-recovery-scan] findSourceBurnTx failed for ${sourceChain}:`, e)
    return null
  }
}

async function getTransactionReceiptRaced(txHash: string): Promise<any | null> {
  const results = await Promise.allSettled(ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getTransactionReceipt', [txHash])))
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value
  }
  return null
}

async function resolveSourceChain(mintTxHash: string): Promise<{ chain: string; nonce: bigint | null; isCctpMint: boolean }> {
  if (!ARC_MESSAGE_TRANSMITTER) {
    console.error('[claim-recovery-scan] resolveSourceChain: ARC_MESSAGE_TRANSMITTER_ADDRESS is not set — falling back to Unknown for', mintTxHash)
    // Can't tell either way without this configured — treat as "might be
    // CCTP" (true) rather than risk misclassifying real claims as external
    // receives. This only affects environments missing the env var, not
    // normal operation.
    return { chain: 'Unknown', nonce: null, isCctpMint: true }
  }
  try {
    const receipt = await getTransactionReceiptRaced(mintTxHash)
    if (!receipt) {
      console.error('[claim-recovery-scan] resolveSourceChain: no receipt found for', mintTxHash)
      return { chain: 'Unknown', nonce: null, isCctpMint: true }
    }
    const logs: any[] = receipt?.logs ?? []
    const receiveLog = logs.find(l =>
      (l.address as string)?.toLowerCase() === ARC_MESSAGE_TRANSMITTER.toLowerCase() &&
      ((l.topics?.[0] as string)?.toLowerCase() === MESSAGE_RECEIVED_TOPIC0_V1.toLowerCase() ||
       (l.topics?.[0] as string)?.toLowerCase() === MESSAGE_RECEIVED_TOPIC0_V2.toLowerCase())
    )
    if (!receiveLog?.data) {
      // No MessageReceived log from Circle's own MessageTransmitter at all —
      // this transfer's `from = address(0)` did NOT come through CCTP. It's
      // some other mechanism entirely (a different bridge, an exchange's own
      // mint-on-deposit flow, a faucet, etc.) that happens to look like a
      // mint at the log level. isCctpMint: false is what tells the caller
      // NOT to try matching this against one of our own claims by amount —
      // see the isMint branch in Deno.serve below for why that matters.
      console.error(
        '[claim-recovery-scan] resolveSourceChain: no MessageReceived log from', ARC_MESSAGE_TRANSMITTER,
        'in tx', mintTxHash, '— not a CCTP mint, addresses seen in receipt:', logs.map(l => l.address).join(', ')
      )
      return { chain: 'Unknown', nonce: null, isCctpMint: false }
    }
    // event MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)
    // sourceDomain is the first non-indexed field — the first 32-byte word of `data`, uint32 right-aligned.
    const data = (receiveLog.data as string).startsWith('0x') ? receiveLog.data.slice(2) : receiveLog.data
    const sourceDomain = parseInt(data.slice(0, 64).slice(-8), 16)
    const chain = CCTP_DOMAIN_TO_CHAIN[sourceDomain]
    // nonce is the second indexed topic (topics[0]=event sig, topics[1]=caller, topics[2]=nonce)
    // — only reliably present for the v1 event shape; v2 moved nonce out of
    // MessageReceived's indexed params entirely, so this is null for v2
    // mints, which is exactly why findSourceBurnTx below can't attempt a
    // lookup for those (there's nothing to search by).
    let nonce: bigint | null = null
    try { if (receiveLog.topics?.[2]) nonce = BigInt(receiveLog.topics[2]) } catch { /* leave null */ }
    // A real MessageReceived log WAS found here — this genuinely is a CCTP
    // mint, even if the specific sourceDomain isn't one we recognize.
    if (!chain) {
      console.error('[claim-recovery-scan] resolveSourceChain: unrecognized sourceDomain', sourceDomain, 'for', mintTxHash)
      return { chain: 'Unknown', nonce, isCctpMint: true }
    }
    return { chain, nonce, isCctpMint: true }
  } catch (e) {
    console.error('[claim-recovery-scan] resolveSourceChain threw for', mintTxHash, ':', e instanceof Error ? e.message : e)
    // Threw (RPC error, etc.) — genuinely couldn't determine either way.
    // Same reasoning as the missing-env-var case: don't risk misrouting a
    // real claim, so default to "might be CCTP".
    return { chain: 'Unknown', nonce: null, isCctpMint: true }
  }
}

// Recovery scans further back than claim-worker's normal 5000-block
// live-settlement window — this is meant to catch claims that have been
// missing for potentially hours, not seconds. 500k rather than 200k — a
// deliberately conservative widening: chunks are fetched in sequential
// batches of 5 (see fetchLogsBounded below), so this scales the number of
// batches roughly linearly. A much larger window risks the edge function
// itself timing out before finishing the scan, which would be worse than
// the gap this is trying to close. If claims are still going unrecovered
// past this window in practice, the right fix is switching this to a
// time-based lookback instead of a flat block count (block times aren't
// perfectly constant), not just raising this number further.
const RECOVERY_SCAN_WINDOW_BLOCKS = 500_000

async function rpcCallSingle(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`)
  const respJson = await res.json()
  if (respJson.error) throw respJson.error
  return respJson.result
}

async function getCurrentArcBlockNumber(): Promise<number> {
  const results = await Promise.allSettled(ARC_RPCS.map(url => rpcCallSingle(url, 'eth_blockNumber', [])))
  const values = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => Number(BigInt(r.value)))
    .filter(n => Number.isFinite(n) && n > 0)
  if (values.length === 0) throw new Error('getCurrentArcBlockNumber: all Arc RPC endpoints failed')
  return Math.max(...values)
}

function serializeErrorForRpc(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

async function fetchLogsBounded(filterBase: Record<string, unknown>, windowBlocks: number): Promise<any[]> {
  const currentBlock = await getCurrentArcBlockNumber()
  const fromBlock = Math.max(0, currentBlock - windowBlocks)

  // Query one chunk — races all RPC endpoints, returns whichever succeeds
  // first with actual results (or [] if all agree there's nothing there).
  const queryChunk = async (from: number, to: number): Promise<{ ok: boolean; logs: any[] }> => {
    const filter = { ...filterBase, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }
    const results = await Promise.allSettled(ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getLogs', [filter])))
    const logs = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .flatMap(r => (Array.isArray(r.value) ? r.value : []))
    const anySucceeded = results.some(r => r.status === 'fulfilled')
    return { ok: anySucceeded, logs }
  }

  // Proactively split into fixed-size chunks rather than requesting the
  // full window in one call and reactively retrying on a specific error
  // message pattern — that approach silently breaks if an RPC provider's
  // "range too large" wording doesn't match what we expect (very possible
  // for Arc's testnet RPCs, which are new and largely undocumented). Fixed
  // 5,000-block chunks are within limits for effectively every EVM JSON-RPC
  // provider in practice, so this never depends on parsing error text at
  // all — and one bad chunk doesn't sink the whole scan.
  const CHUNK_SIZE = 5_000
  const CONCURRENCY = 5
  const chunks: Array<[number, number]> = []
  for (let from = fromBlock; from <= currentBlock; from += CHUNK_SIZE) {
    chunks.push([from, Math.min(from + CHUNK_SIZE - 1, currentBlock)])
  }

  const allLogs: any[] = []
  let anyChunkSucceeded = false

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(([from, to]) => queryChunk(from, to)))
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        if (r.value.ok) anyChunkSucceeded = true
        allLogs.push(...r.value.logs)
      } else {
        const [from, to] = batch[j]
        console.error(`[claim-recovery-scan] chunk ${from}-${to} failed:`, serializeErrorForRpc(r.reason))
        // Keep going — one bad chunk shouldn't sink the whole recovery scan.
      }
    }
  }

  if (!anyChunkSucceeded && allLogs.length === 0) {
    throw new Error('fetchLogsBounded: every chunk failed on every Arc RPC endpoint')
  }
  return allLogs
}

async function getBlockTimestamp(blockNumber: number): Promise<string | null> {
  try {
    const blockHex = '0x' + blockNumber.toString(16)
    for (const url of ARC_RPCS) {
      try {
        const block = await rpcCallSingle(url, 'eth_getBlockByNumber', [blockHex, false])
        if (block?.timestamp) return new Date(Number(BigInt(block.timestamp)) * 1000).toISOString()
      } catch { /* try next endpoint */ }
    }
    return null
  } catch {
    return null
  }
}

// Same reasoning as claim-worker/index.ts's getServiceRoleKey — legacy name
// tried first (currently verified working), new SUPABASE_SECRET_KEYS format
// only as a fallback, clear error instead of a silent crash if neither is set.
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
      console.error('[claim-recovery-scan] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }

  throw new Error(
    'No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS. ' +
    'Set one of these as a project secret.'
  )
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

async function recordClaimActivity(supabase: SupabaseClient, walletAddress: string, txHash: string, amount: number, sourceChain: string, realBurnTxHash?: string | null) {
  try {
    const hasRealBurnHash = !!realBurnTxHash
    const { error } = await supabase
      .from('activity')
      .upsert({
        wallet_address:      walletAddress.toLowerCase(),
        // Real source-chain burn hash when findSourceBurnTx found one —
        // otherwise the same placeholder reasoning as before: the mint
        // hash standing in for both fields, distinguishable via
        // metadata.recovered so the frontend knows not to build a broken
        // "View Burn" link from it.
        tx_hash:             (hasRealBurnHash ? realBurnTxHash! : txHash).toLowerCase(),
        destination_tx_hash: txHash.toLowerCase(),
        activity_type:     'claim',
        amount,
        usd_value:         amount,
        token_symbol:      'USDC',
        source_chain:      sourceChain,
        destination_chain: 'Arc_Testnet',
        status:            'completed',
        explorer_url:      `${ARC_EXPLORER}/tx/${txHash}`,
        // recovered stays true either way (this claim was still found via
        // the recovery scan, not the normal tracked flow) — but
        // hasRealSourceHash lets the frontend distinguish "we have a real,
        // verified burn hash, show the link" from "placeholder only, hide it".
        metadata:          { recovered: true, hasRealSourceHash: hasRealBurnHash },
      }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
    if (error) console.error('[claim-recovery-scan] recordClaimActivity failed:', error.message)
  } catch (e) {
    console.error('[claim-recovery-scan] recordClaimActivity threw:', e)
  }
}

// A recently-failed claim being reconciled back to 'completed' already has
// an activity row from when claim-worker's markFailed() ran — keyed by the
// claim's BURN tx_hash, not the mint tx_hash this scan just found. Upserting
// with ignoreDuplicates (recordClaimActivity above) wouldn't touch that
// existing row at all, since it's a different tx_hash — it would silently
// leave the old 'failed' entry sitting in history forever while the claims
// row itself now says 'completed'. This explicitly corrects the SAME row in
// place instead.
async function reconcileFailedClaimActivity(
  supabase: SupabaseClient,
  walletAddress: string,
  burnTxHash: string,
  amount: number,
  mintTxHash: string,
) {
  try {
    const { error } = await supabase
      .from('activity')
      .update({
        status:            'completed',
        amount,
        usd_value:         amount,
        arrived_amount:    amount,
        destination_chain: 'Arc_Testnet',
        metadata:          { recovered: true, reconciled_from: 'failed', mint_tx_hash: mintTxHash },
      })
      .eq('tx_hash', burnTxHash.toLowerCase())
      .eq('wallet_address', walletAddress.toLowerCase())
    if (error) console.error('[claim-recovery-scan] reconcileFailedClaimActivity failed:', error.message)
  } catch (e) {
    console.error('[claim-recovery-scan] reconcileFailedClaimActivity threw:', e)
  }
}

// TOCTOU guard for the swap-collision checks below. A swap's output-token
// leg lands on-chain as a plain Transfer to this wallet — indistinguishable
// from a genuine external deposit at the log level — and is already being
// recorded, separately, by the client (SwapPage.tsx → Activity.swap(),
// under this exact unprefixed tx hash) the moment the swap confirms in the
// user's own browser. This scan runs independently (on app mount / tab
// refocus) and can win that race if it happens to check for an existing row
// before the client's write has landed — a single point-in-time SELECT
// can't tell "genuinely no row" apart from "row is still being written a
// few hundred ms from now". That was silently producing a real duplicate:
// a correct 'swap' row plus a spurious 'receive' row for the same
// transaction (and a spurious extra "Payment received" notification on top
// of the correct "Swap Complete" one).
//
// Re-checks a few times with a short delay instead of a single read. The
// client-side write normally lands within ~1-2s of on-chain confirmation
// (see saveActivity's own retry/backoff ceiling), so this closes the race
// for all practical purposes without meaningfully delaying the genuine
// external-deposit case (which has no competing writer and simply pays this
// same short cost once).
//
// Widened from ~3s to ~8s (2026-09-02) — docs/ACTIVITY_WRITER_AUDIT.md
// flagged this window as "P1, worth tightening... narrow but not zero
// probability", the exact mechanism behind the traced EURC duplicate. NOT
// widened all the way to activity-consumer's 30s despite that doc's
// suggestion: every caller of this function sits inside a `for` loop over
// every candidate transfer in the scan window (see below), so this delay
// is paid ONCE PER CANDIDATE, not once per invocation — at 30s, a wallet
// with several genuinely-ambiguous candidates in one pass could push a
// single scan invocation toward Edge Function execution limits. 8s is a
// real improvement (this poll is now also the THIRD, last-resort layer —
// see the sender-exclusion and transaction_attempts correlation checks
// above it in each caller, added by
// docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md, which structurally
// close the common cases before this ever runs) without meaningfully
// changing the fan-out risk profile.
async function existsActivityForTxHash(supabase: SupabaseClient, walletAddress: string, txHash: string): Promise<boolean> {
  const DELAYS_MS = [0, 1500, 2000, 2000, 2500] // ~8s total across 5 checks
  for (const delay of DELAYS_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay))
    const { data } = await supabase
      .from('activity')
      .select('id')
      .eq('tx_hash', txHash)
      .eq('wallet_address', walletAddress.toLowerCase())
      .maybeSingle()
    if (data) return true
  }
  return false
}

// A real transfer (not a mint from address(0)) landing in the wallet with no
// matching claims/activity row at all — this is what a Circle testnet
// faucet drop actually looks like on-chain: a plain Transfer from a funded
// faucet/treasury address, not a CCTP mint. Recorded as a genuine 'receive'
// row (not 'claim') so it correctly appears under Received/All, with the
// real sender address as the counterparty rather than 'Unknown'.
async function recordExternalReceive(supabase: SupabaseClient, walletAddress: string, txHash: string, amount: number, fromAddress: string, tokenSymbol: string = 'USDC') {
  try {
    const { error } = await supabase
      .from('activity')
      .upsert({
        wallet_address:      walletAddress.toLowerCase(),
        tx_hash:             `recv_${txHash.toLowerCase()}`,
        activity_type:       'receive',
        amount,
        usd_value:           amount,
        token_symbol:        tokenSymbol,
        counterparty_address: fromAddress.toLowerCase(),
        explorer_url:        `${ARC_EXPLORER}/tx/${txHash}`,
        // BUG FIX: this previously used a differently-worded note
        // ('External deposit (e.g. faucet)') than deposit-scan-all's own
        // writer ('External deposit'), and HomePage.tsx's notification
        // logic matched on the note text EXACTLY -- so anything recovered
        // through this path (a genuinely-landed external/faucet deposit)
        // silently never notified the user, even though the money arrived
        // and the Activity row was completely correct. Notification
        // classification now uses the explicit metadata.receiveKind field
        // instead (see ActivityService.ts's comment on it) -- `note` stays
        // as human-readable display text only, no longer load-bearing for
        // notification logic.
        metadata:            { recovered: true, note: 'External deposit (e.g. faucet)', receiveKind: 'external_deposit' },
      }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
    if (error) console.error('[claim-recovery-scan] recordExternalReceive failed:', error.message)
  } catch (e) {
    console.error('[claim-recovery-scan] recordExternalReceive threw:', e)
  }
}

// ── Native USDC deposit detection — added because the ERC20-log scan above
// is structurally blind to plain native transfers ────────────────────────
// USDC on Arc is the chain's NATIVE currency (18-decimal value transfers),
// not the token contract this file's ERC20-log scan (above) watches. A
// plain wallet-to-wallet send or an exchange withdrawal (OKX, etc. sent
// straight to a MeshPort address) never touches ARC_USDC_CONTRACT and never
// emits the Transfer log the scan above filters for — so it was invisible
// to this fast, app-open-triggered path entirely, only ever caught later by
// deposit-scan-all's slower scheduled sweep (up to ~1-2 min, by design —
// see that function's own header comment).
//
// This is the SAME detection logic already proven in deposit-scan-all
// (fetchNativeDepositsViaExplorer there), ported here for a single wallet.
// Using Blockscout's indexed REST API (one HTTP call) rather than the
// direct block-scan deposit-scan-all uses for its all-wallets sweep is
// deliberate: a single-address query is cheap enough to run synchronously
// on every app-open/tab-focus, whereas scanning raw blocks for every known
// wallet on every trigger would not be.
async function fetchNativeDepositsViaExplorer(walletAddress: string): Promise<Array<{ txHash: string; fromAddr: string; amount: number }>> {
  const url = `${ARC_EXPLORER_API}/addresses/${walletAddress}/transactions?filter=to`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`explorer API ${res.status} for ${walletAddress}`)
  const body = await res.json()
  const items: any[] = Array.isArray(body?.items) ? body.items : []

  const out: Array<{ txHash: string; fromAddr: string; amount: number }> = []
  for (const item of items) {
    const toAddr   = (item?.to?.hash ?? item?.to ?? '') as string
    const fromAddr = (item?.from?.hash ?? item?.from ?? '') as string
    const txHash   = (item?.hash ?? '') as string
    const rawValue = item?.value
    if (!toAddr || !fromAddr || !txHash || rawValue == null) continue
    if (toAddr.toLowerCase() !== walletAddress.toLowerCase()) continue
    if (fromAddr.toLowerCase() === walletAddress.toLowerCase()) continue // self-send
    const status = item?.status ?? item?.result
    if (status && status !== 'ok' && status !== 'success') continue

    let amount: number
    try { amount = Number(BigInt(rawValue)) / (10 ** NATIVE_DECIMALS) } catch { continue }
    if (!Number.isFinite(amount) || amount <= 0) continue

    out.push({ txHash: txHash.toLowerCase(), fromAddr: fromAddr.toLowerCase(), amount })
  }
  return out
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body: any = {}
  try { body = await req.json() } catch { /* ignore */ }
  const walletAddress: string | undefined = body?.walletAddress
  if (!walletAddress) return json({ success: false, error: 'walletAddress required' }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    const recipientTopic = '0x' + walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const recovered: string[] = []
    // Set inside runUsdcClaimAndReceiveScan below; read after
    // Promise.allSettled for the response's `scanned` field. A plain
    // outer-scoped counter (not a return value) because the three scans
    // below are awaited via allSettled, not individually destructured.
    let usdcScannedCount = 0

    // ── LATENCY FIX (~10s Receive delay, traced to real production timing) ──
    // These three scans (USDC claim-recovery + generic receive, EURC/cirBTC
    // token transfers, native-USDC-via-explorer) were previously run strictly
    // SEQUENTIALLY, one after another, in one invocation -- even though
    // they're fully independent (different RPC calls, different tokens,
    // no data dependency between them). The USDC scan alone chunks
    // RECOVERY_SCAN_WINDOW_BLOCKS (500,000 blocks) into 5,000-block pieces at
    // concurrency 5 -- 100 chunks, 20 sequential batches -- which measured
    // against real production Activity/chain_events timestamps is the
    // dominant cost of the whole invocation, paid IN FULL before the EURC/
    // cirBTC/native branches even start, regardless of which token the
    // user's specific deposit was actually in. That is the root cause of the
    // reported "receive shows up ~10s after balance" gap: balance updates
    // from a single, fast, direct RPC read (arcBalanceReader.ts), while this
    // function -- triggered by the SAME app-open/focus moment -- pays the
    // full sequential cost of all three scans before the specific deposit's
    // Activity row is ever written.
    //
    // FIX: run all three concurrently instead. Same RPC calls, same total
    // RPC volume (nothing here is polled more often or more aggressively),
    // same per-branch logic (copied unchanged into named functions below) --
    // only the WALL-CLOCK ordering changes, from serial to parallel.
    //
    // SAFETY: `recovered` is a plain array pushed to from multiple async
    // functions running concurrently. JS's single-threaded event loop makes
    // each individual .push() atomic, so this is not a data race. The native-
    // explorer branch's own `recovered.includes(dep.txHash)` check (a best-
    // effort skip of redundant work, not a correctness guard) may now see a
    // partially-populated array if it runs before the USDC branch reaches
    // that same hash -- harmless either way, because recordExternalReceive's
    // own `upsert(..., { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })`
    // is the actual, DB-level dedup guarantee (same as it already was before
    // this change) -- no new duplicate-write risk is introduced.
    //
    // Each branch now catches its own errors internally (mirroring the
    // native-explorer branch's existing try/catch) rather than throwing out
    // to the top-level catch -- so one scan failing no longer silently
    // prevents the other two from running, which is a genuine correctness
    // improvement (previously: a single Arc RPC outage during the USDC scan
    // meant EURC/cirBTC/native deposits went undetected too, even though
    // nothing was wrong with THEIR data source).

    const runUsdcClaimAndReceiveScan = async () => {
      // No MINT_FROM_TOPIC filter here anymore — catches every incoming
      // Transfer, not just CCTP mints. A Circle faucet drop is a plain
      // Transfer from a funded address, not a mint from address(0), so the
      // old mint-only filter silently excluded it entirely.
      const logs = await fetchLogsBounded(
        { address: ARC_USDC_CONTRACT, topics: [TRANSFER_TOPIC0, null, recipientTopic] },
        RECOVERY_SCAN_WINDOW_BLOCKS
      )
      usdcScannedCount = logs.length

      for (const log of logs) {
      const txHash = (log.transactionHash as string).toLowerCase()
      const fromTopic = (log.topics?.[1] as string) || ''
      const isMint = fromTopic.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()

      let amount: number
      try {
        amount = Number(BigInt(log.data)) / 1e6
      } catch { continue }
      if (!Number.isFinite(amount) || amount <= 0) continue

      // Real transfer (not a mint) — this is the faucet-drop / generic
      // external-deposit case. Check it isn't already tracked as a receive,
      // then record it as one.
      if (!isMint) {
        const { data: existingRecv } = await supabase
          .from('activity')
          .select('id')
          .eq('tx_hash', `recv_${txHash}`)
          .eq('wallet_address', walletAddress.toLowerCase())
          .maybeSingle()
        if (existingRecv) continue

        const fromAddress = '0x' + fromTopic.slice(-40)
        if (fromAddress.toLowerCase() === walletAddress.toLowerCase()) continue // self-transfer, not a real incoming payment

        // Sender-based classification — checked BEFORE existsActivityForTxHash,
        // per docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md. A known
        // internal contract's output (swap router, Multicall3/BulkPay, CCTP
        // infra, or a configured P2P escrow) is never a generic external
        // deposit — skip it structurally instead of relying on winning a
        // race against that flow's own Activity writer.
        if (isKnownInternalContract(fromAddress, KNOWN_INTERNAL_EXTRA)) continue

        // Deterministic, race-free: is this tx_hash already a tracked
        // Pay/BulkPay/Swap attempt? See trackedFeatureCorrelation.ts's own
        // header for why this closes the race structurally (the attempt row
        // exists before broadcast, long before this scan ever runs) instead
        // of depending on winning a timing window against that feature's own
        // Activity write. Checked BEFORE existsActivityForTxHash, same
        // ordering principle as the sender check above.
        if (await findCorrelatedTrackedFeature(supabase, 'arc', txHash)) continue

        // Same reasoning as the EURC/cirBTC branch below: a swap that
        // outputs USDC emits this exact plain Transfer to the wallet, and
        // is already recorded under this exact (unprefixed) tx hash as its
        // own 'swap' activity row. Skip so it isn't double-counted as an
        // "external" payment on top of the correct "Swap Complete" one.
        // Poll-with-delay (not a single check) — see existsActivityForTxHash.
        // Now a THIRD layer of defense, not the only one — the sender check
        // and the tracked-feature correlation above already catch the
        // common cases structurally, before any race can even occur.
        if (await existsActivityForTxHash(supabase, walletAddress, txHash)) continue

        await recordExternalReceive(supabase, walletAddress, txHash, amount, fromAddress)
        recovered.push(txHash)
        continue
      }

      // Already tracked as completed/failed? Skip entirely.
      const { data: existing } = await supabase
        .from('claims')
        .select('id')
        .eq('destination_tx_hash', txHash)
        .maybeSingle()
      if (existing) continue

      // Resolved once, up front, and reused below for both the
      // claim-matching decision AND (if it turns out to be a genuine,
      // fully-untracked CCTP mint) recordClaimActivity's realBurnTxHash
      // lookup — no need to re-derive it a second time later.
      const { chain: resolvedSourceChain, nonce, isCctpMint } = await resolveSourceChain(txHash)

      // A `from = address(0)` transfer that ISN'T actually a CCTP mint (no
      // MessageReceived log from Circle's MessageTransmitter at all) can't
      // belong to any of our claims — CCTP is the only thing our claim
      // system tracks. Routing it through the amount-only matching below
      // anyway was the real bug: a genuine external deposit (e.g. funded via
      // OKX/MetaMask through whatever mint-on-deposit mechanism THEY use)
      // that happened to be a similar amount to an unrelated pending or
      // recently-failed MeshPort claim got silently absorbed into
      // *completing that claim* instead of creating its own Activity entry
      // — the deposit was real and the balance was right, but no new
      // history row ever appeared for it. Treat it exactly like any other
      // non-mint external transfer instead.
      if (!isCctpMint) {
        const fromAddress = '0x' + fromTopic.slice(-40)
        if (fromAddress.toLowerCase() !== walletAddress.toLowerCase()) {
          // fromAddress is always address(0) on this branch by construction
          // (isMint was true, resolveSourceChain just determined it wasn't a
          // real CCTP mint) — isKnownInternalContract will never match it,
          // so this is a no-op here today. Kept for consistency with the
          // other three generic-receive branches rather than special-cased,
          // per docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md, and as a
          // safety net if this branch's sender resolution ever changes.
          if (isKnownInternalContract(fromAddress, KNOWN_INTERNAL_EXTRA)) { continue }
          // See the tracked-feature correlation comment on the first
          // generic-receive branch above — same check, kept consistent
          // across all four branches per
          // docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md's own reasoning
          // for why the other three do this uniformly rather than special-
          // casing any one of them.
          if (await findCorrelatedTrackedFeature(supabase, 'arc', txHash)) continue
          if (await existsActivityForTxHash(supabase, walletAddress, txHash)) continue
          await recordExternalReceive(supabase, walletAddress, txHash, amount, fromAddress)
          recovered.push(txHash)
        }
        continue
      }

      // Is there a STILL-PROCESSING claim (destination_tx_hash not yet set,
      // so the check above wouldn't have caught it) that this mint actually
      // belongs to? Fee-tolerant match, same 70%-100.1% band claim-worker
      // itself uses. If so, complete THAT claim instead of creating a new
      // 'Unknown' row — this is the fix for a real bug found in production:
      // a legitimately still-processing claim got permanently blocked
      // because the scanner created a redundant duplicate for the same
      // mint before claim-worker's own retry logic could claim it.
      //
      // Also consider RECENTLY-failed claims as a fallback pool: a claim
      // can be marked 'failed' by claim-worker's settling timeout while the
      // mint is still genuinely in flight (e.g. a slow CCTP Standard
      // transfer that outlasted the timeout but was never actually lost).
      // Without this, that money would show as both a 'failed' entry AND a
      // separate, unrelated-looking new 'completed' entry once this scan
      // finds the mint — same underlying claim, two disagreeing records.
      // Bounded to a recency window so an old failed claim can't be
      // resurrected by an unrelated, coincidentally-similar-amount mint.
      const RECONCILE_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000
      const { data: candidates } = await supabase
        .from('claims')
        .select('id, amount, source_chain, status, tx_hash, updated_at')
        .eq('wallet_address', walletAddress.toLowerCase())
        .neq('status', 'completed')

      const blockNumber = Number(BigInt(log.blockNumber))
      const timestamp = await getBlockTimestamp(blockNumber) ?? new Date().toISOString()

      const isAmountMatch = (c: { amount: number | string }) => {
        const claimedRaw = Number(c.amount)
        return amount >= claimedRaw * 0.70 && amount <= claimedRaw * 1.001
      }
      const now = Date.now()
      const activePool = (candidates ?? []).filter(c => c.status !== 'failed')
      const failedPool = (candidates ?? []).filter(c =>
        c.status === 'failed' && (now - new Date(c.updated_at).getTime()) < RECONCILE_FAILED_WINDOW_MS
      )
      const matchingClaim = activePool.find(isAmountMatch) ?? failedPool.find(isAmountMatch)
      const isReconcilingFailed = !!matchingClaim && matchingClaim.status === 'failed'

      if (matchingClaim) {
        const { error: updateErr } = await supabase
          .from('claims')
          .update({
            status: 'completed',
            destination_tx_hash: txHash,
            receiver_block: blockNumber,
            completed_at: timestamp,
            error: null,
          })
          .eq('id', matchingClaim.id)
        if (updateErr) {
          console.error('[claim-recovery-scan] failed to complete matching existing claim', matchingClaim.id, updateErr.message)
        } else {
          // This claim was already tracked (the user picked a source chain
          // when they submitted it) — reuse that instead of re-deriving it,
          // it's already the real value, not 'Unknown'.
          if (isReconcilingFailed && matchingClaim.tx_hash) {
            // Correct the existing 'failed' activity row in place (keyed by
            // the burn hash) rather than upserting a new row keyed by the
            // mint hash — see reconcileFailedClaimActivity for why the
            // normal recordClaimActivity path can't do this.
            await reconcileFailedClaimActivity(supabase, walletAddress, matchingClaim.tx_hash, amount, txHash)
          } else {
            // FIX: matchingClaim.tx_hash IS the real source-chain burn hash
            // (claim-submit writes the client-submitted burn tx hash there
            // at claim-submission time — see claim-submit/index.ts) — not a
            // placeholder. Previously this was never passed through as
            // recordClaimActivity's realBurnTxHash argument, so every claim
            // completed via this "already tracked" path got recorded with
            // hasRealSourceHash: false, even though the real burn hash was
            // sitting right here the whole time. The frontend (see
            // ActivityPage.tsx's isRecoveredClaim) treats hasRealSourceHash:
            // false as "genuinely unresolvable" and deliberately hides the
            // source hash row AND the "View Burn" explorer link — so this
            // was silently hiding real, known, correct links for every claim
            // that happened to complete through the recovery scan instead of
            // claim-worker's normal path (exactly the "recovery scan helped
            // show it, but the source hash/link are missing" symptom).
            await recordClaimActivity(supabase, walletAddress, txHash, amount, matchingClaim.source_chain || 'Unknown', matchingClaim.tx_hash)
          }
          recovered.push(txHash)
        }
        continue
      }

      // Fully untracked mint — no claims row ever existed for it, but we
      // already confirmed above (isCctpMint) that it genuinely IS a CCTP
      // mint, and resolvedSourceChain/nonce were already derived from that
      // same MessageReceived log — no need to re-resolve it here.
      // Attempt to find the REAL source-chain burn transaction — only
      // possible when we have both a recognized chain and a nonce (v1 CCTP
      // shape; v2 doesn't carry nonce in this event at all, see
      // resolveSourceChain's comment). Falls back to the existing
      // placeholder behavior (mint hash standing in for both fields) when
      // this can't be determined, rather than risk showing a wrong match.
      const realBurnTxHash = (nonce !== null && resolvedSourceChain !== 'Unknown')
        ? await findSourceBurnTx(resolvedSourceChain, nonce)
        : null

      const { error: insertErr } = await supabase.from('claims').insert({
        wallet_address:       walletAddress.toLowerCase(),
        source_chain:         resolvedSourceChain,
        amount,
        // Real burn hash when found; otherwise the same placeholder
        // reasoning as before — using the mint hash as the required NOT
        // NULL tx_hash value, distinguishable via tx_hash === destination_tx_hash
        // (see ActivityPage.tsx / MultichainPage.tsx's isRecoveredClaim checks).
        tx_hash:              realBurnTxHash ?? txHash,
        destination_tx_hash:  txHash,
        receiver_block:       blockNumber,
        status:               'completed',
        completed_at:         timestamp,
        created_at:           timestamp,
      })

      if (insertErr) {
        // Unique constraint races are expected/harmless here (e.g. two
        // concurrent recovery scans, or claim-worker completing it normally
        // a moment before this ran) — anything else gets logged.
        if (!insertErr.message?.includes('duplicate') && !insertErr.message?.includes('unique')) {
          console.error('[claim-recovery-scan] insert failed for', txHash, insertErr.message)
        }
        continue
      }

      await recordClaimActivity(supabase, walletAddress, txHash, amount, resolvedSourceChain, realBurnTxHash)
      recovered.push(txHash)
      }
    }

    // EURC and cirBTC — no CCTP claims exist for these tokens in this app,
    // so none of the claim-matching logic above applies. Just the same
    // "untracked incoming transfer" detection as the USDC !isMint branch,
    // for a payment sent directly to this wallet's raw address rather than
    // through a username (which would have gone through a chat message
    // instead, and already be tracked that way).
    //
    // Fetched concurrently with each other (unchanged from before), AND now
    // concurrently with the USDC scan above and the native-explorer scan
    // below too — see the LATENCY FIX comment earlier in this function for
    // why. A smaller window here too (these only need to catch recent direct
    // transfers, not the months-old edge cases claim recovery has to
    // consider).
    const runTokenScan = async () => {
      const PAYMENT_SCAN_WINDOW_BLOCKS = 100_000
      const OTHER_TOKENS: Array<{ symbol: string; contract: string; decimals: number }> = [
        { symbol: 'EURC',   contract: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
        { symbol: 'cirBTC', contract: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 },
      ]
      const otherTokenResults = await Promise.allSettled(
        OTHER_TOKENS.map(token =>
          fetchLogsBounded(
            { address: token.contract, topics: [TRANSFER_TOPIC0, null, recipientTopic] },
            PAYMENT_SCAN_WINDOW_BLOCKS
          ).then(logs => ({ token, logs }))
        )
      )

      for (const result of otherTokenResults) {
        if (result.status === 'rejected') {
          console.error('[claim-recovery-scan] other-token scan failed:', result.reason instanceof Error ? result.reason.message : result.reason)
          continue
        }
        const { token, logs: otherLogs } = result.value

        for (const log of otherLogs) {
        const txHash = (log.transactionHash as string).toLowerCase()
        const fromTopic = (log.topics?.[1] as string) || ''
        if (fromTopic.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()) continue // no mint case for these tokens; skip defensively

        let amount: number
        try { amount = Number(BigInt(log.data)) / (10 ** token.decimals) } catch { continue }
        if (!Number.isFinite(amount) || amount <= 0) continue

        const { data: existingRecv } = await supabase
          .from('activity')
          .select('id')
          .eq('tx_hash', `recv_${txHash}`)
          .eq('wallet_address', walletAddress.toLowerCase())
          .maybeSingle()
        if (existingRecv) continue

        const fromAddress = '0x' + fromTopic.slice(-40)
        if (fromAddress.toLowerCase() === walletAddress.toLowerCase()) continue // self-transfer, not a real incoming payment

        // THE EURC FIX — docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md.
        // This is the exact branch that produced the traced duplicate
        // (docs/ACTIVITY_WRITER_AUDIT.md §2, docs/CLAIM_RECOVERY_AUDIT.md
        // §5): a swap's EURC/cirBTC output leg is a plain Transfer from the
        // Kit Adapter router, structurally identical to a genuine external
        // deposit at the log level. Checking the sender BEFORE the race-
        // prone existsActivityForTxHash closes this structurally instead of
        // depending on winning a timing race against SwapPage.tsx's own
        // 'swap' Activity write.
        if (isKnownInternalContract(fromAddress, KNOWN_INTERNAL_EXTRA)) continue

        // Deterministic, race-free correlation check — see
        // trackedFeatureCorrelation.ts's header. This is the direct fix for
        // the traced EURC duplicate (docs/ACTIVITY_WRITER_AUDIT.md §2): the
        // swap's transaction_attempts row (feature='swap') exists from
        // broadcast time onward, well before this scan runs, so this check
        // cannot lose the timing race existsActivityForTxHash alone did.
        if (await findCorrelatedTrackedFeature(supabase, 'arc', txHash)) continue

        // A swap's output-token leg (e.g. the EURC this wallet receives back
        // from the router) emits the exact same on-chain Transfer event this
        // scan is watching for — same tx hash, `to` = this wallet. That swap
        // is already recorded client-side as its own 'swap' activity row,
        // keyed by the plain (unprefixed) tx hash. Any activity row already
        // existing under this exact tx hash for this wallet — regardless of
        // type — means it's already been accounted for. Poll-with-delay
        // (not a single check) — see existsActivityForTxHash. Now a THIRD
        // layer of defense (e.g. for a router/contract not yet in the known-
        // internal list, or a feature not tracked via transaction_attempts),
        // not the only one.
        if (await existsActivityForTxHash(supabase, walletAddress, txHash)) continue

        await recordExternalReceive(supabase, walletAddress, txHash, amount, fromAddress, token.symbol)
        recovered.push(txHash)
        }
      }
    }

    // ── Native USDC — catches what the ERC20-log scan above structurally
    // can't (see the comment on fetchNativeDepositsViaExplorer). Best-effort:
    // wrapped so an explorer hiccup never breaks the CCTP claim-recovery
    // logic above, which is this function's primary job. Already ran
    // independently of the other two scans before this change (its own
    // try/catch) — now also runs CONCURRENTLY with them, not just
    // independently-if-reached, per the LATENCY FIX comment above.
    const runNativeExplorerScan = async () => {
      try {
        const nativeDeposits = await fetchNativeDepositsViaExplorer(walletAddress)
        for (const dep of nativeDeposits) {
          if (recovered.includes(dep.txHash)) continue // already handled above (shouldn't overlap, but stay safe)

          const { data: existingRecv } = await supabase
            .from('activity')
            .select('id')
            .eq('tx_hash', `recv_${dep.txHash}`)
            .eq('wallet_address', walletAddress.toLowerCase())
            .maybeSingle()
          if (existingRecv) continue

          // Same reasoning as the ERC20 branch above: a swap that outputs
          // native USDC would otherwise get double-counted alongside its own
          // 'swap' activity row, keyed by the same unprefixed tx hash.
          if (isKnownInternalContract(dep.fromAddr, KNOWN_INTERNAL_EXTRA)) continue

          // Deterministic, race-free correlation check — same reasoning as the
          // other three branches, see trackedFeatureCorrelation.ts's header.
          if (await findCorrelatedTrackedFeature(supabase, 'arc', dep.txHash)) continue

          // Poll-with-delay (not a single check) — see existsActivityForTxHash.
          // Now a third layer of defense, same as the other branches.
          if (await existsActivityForTxHash(supabase, walletAddress, dep.txHash)) continue

          await recordExternalReceive(supabase, walletAddress, dep.txHash, dep.amount, dep.fromAddr)
          recovered.push(dep.txHash)
        }
      } catch (e) {
        console.error('[claim-recovery-scan] native USDC check failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    // ── Run all three independent scans concurrently ────────────────────────
    // See the LATENCY FIX comment near the top of this function for the full
    // reasoning. USDC's own scan/claim-matching errors are now caught inside
    // runUsdcClaimAndReceiveScan itself (logged, non-fatal) rather than
    // propagating to the outer catch, so a failure in any one of the three
    // scans can never prevent the other two from completing and writing
    // whatever they found.
    await Promise.allSettled([
      runUsdcClaimAndReceiveScan().catch(e =>
        console.error('[claim-recovery-scan] USDC claim/receive scan failed (non-fatal):', e instanceof Error ? e.message : e)
      ),
      runTokenScan().catch(e =>
        console.error('[claim-recovery-scan] token scan failed (non-fatal):', e instanceof Error ? e.message : e)
      ),
      runNativeExplorerScan(),
    ])

    return json({ success: true, scanned: usdcScannedCount, recovered })
  } catch (e: any) {
    console.error('[claim-recovery-scan] failed:', e?.message ?? e)
    return json({ success: false, error: e?.message ?? 'Recovery scan failed' }, 500)
  }
})
