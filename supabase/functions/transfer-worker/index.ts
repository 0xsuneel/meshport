// supabase/functions/transfer-worker/index.ts
//
// Backend worker for outbound Multichain Transfer (Arc -> destination
// chain) — the reverse direction of Multichain Claim (destination chain ->
// Arc, handled by claim-worker). Mirrors claim-worker's architecture:
// continuous pg_cron sweep, FOR UPDATE SKIP LOCKED row locking, passive
// on-chain detection of the mint. Kept deliberately simpler than
// claim-worker in one respect — see the note above findMintByAmount below
// for why this doesn't attempt claim-worker's exact nonce-based match.
//
// Root cause this exists to fix: there was no backend for this direction
// at all before this. A burn on Arc got written to `activity` as a
// 'pending' bridge row and then NOTHING ever checked it again — confirmed
// live via rows over a month old with updated_at == created_at. The CCTP
// burn itself was never the problem; nothing was left watching for the
// mint once the browser tab that submitted it moved on.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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

// ── Per-destination-chain RPC + USDC contract registry ───────────────────
// Ported verbatim from src/blockchain/chains.ts's EXTERNAL_CHAINS — that
// file's own comments describe it as "verified against Circle's own SDK
// source / developers.circle.com," already battle-tested for balance
// scanning across every one of these chains. Reused here rather than
// re-deriving a second, possibly-drifted copy.
const DEST_CHAINS: Record<string, { rpcs: string[]; usdc: string }> = {
  Ethereum_Sepolia:    { rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'], usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  Base_Sepolia:        { rpcs: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'], usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  Arbitrum_Sepolia:    { rpcs: ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'], usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
  Optimism_Sepolia:    { rpcs: ['https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'], usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7' },
  Polygon_Sepolia:     { rpcs: ['https://polygon-amoy-bor-rpc.publicnode.com'], usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582' },
  Avalanche_Fuji:      { rpcs: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'], usdc: '0x5425890298aed601595a70AB815c96711a31Bc65' },
  HyperEVM_Testnet:    { rpcs: ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'], usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab' },
  Sei_Testnet:         { rpcs: ['https://evm-rpc-testnet.sei-apis.com'], usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED' },
  Sonic_Testnet:       { rpcs: ['https://rpc.testnet.soniclabs.com', 'https://sonic-testnet.rpc.thirdweb.com'], usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51' },
  Unichain_Sepolia:    { rpcs: ['https://sepolia.unichain.org'], usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F' },
  World_Chain_Sepolia: { rpcs: ['https://worldchain-sepolia.g.alchemy.com/public', 'https://worldchain-sepolia.rpc.thirdweb.com'], usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88' },
  Linea_Sepolia:       { rpcs: ['https://rpc.sepolia.linea.build'], usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7' },
  Ink_Testnet:         { rpcs: ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'], usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac' },
  Monad_Testnet:       { rpcs: ['https://testnet-rpc.monad.xyz'], usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3' },
  Morph_Testnet:       { rpcs: ['https://rpc-hoodi.morphl2.io'], usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B' },
  Pharos_Testnet:      { rpcs: ['https://atlantic.dplabs-internal.com'], usdc: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B' },
  Plume_Testnet:       { rpcs: ['https://testnet-rpc.plume.org'], usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18' },
  XDC_Apothem:         { rpcs: ['https://rpc.apothem.network', 'https://erpc.apothem.network'], usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4' },
  Codex_Testnet:       { rpcs: ['https://rpc.codex-stg.xyz'], usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f' },
  Edge_Testnet:        { rpcs: ['https://edge-testnet.g.alchemy.com/public'], usdc: '0x2d9F7CAD728051AA35Ecdc472a14cf8cDF5CFD6B' },
  Injective_Testnet:   { rpcs: ['https://k8s.testnet.json-rpc.injective.network'], usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d' },
}

const CIRCLE_IRIS_API = 'https://iris-api-sandbox.circle.com'
const ARC_DOMAIN = 26 // Arc's own CCTP domain — it's the SOURCE for this direction

async function rpcCall(urls: string[], method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown = null
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { lastErr = new Error(`RPC ${res.status} from ${url}`); continue }
      const respJson = await res.json()
      if (respJson.error) { lastErr = respJson.error; continue }
      return respJson.result
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error(`RPC call ${method} failed on all endpoints`)
}

function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)
// Same Kit forwarder addresses claim-worker already had to add (as
// KIT_FORWARD_SOURCES) after discovering live that Circle's Fast Transfer
// relay doesn't always mint directly from address(0) — some mints route
// through one of these forwarding contracts instead. That fix only ever
// landed on the Arc (claim) side; this direction had the same narrow
// address(0)-only filter the whole time, meaning any forwarded mint on a
// destination chain was invisible to this worker's scan from day one —
// not found-but-wrong-amount, just never in the result set at all.
const KIT_FORWARD_TOPICS = [
  MINT_FROM_TOPIC,
  '0x000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d',
  '0x000000000000000000000000bbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
]
const LOG_SCAN_WINDOW_BLOCKS = 50_000
const LOG_SCAN_CHUNK_BLOCKS  = 5_000

async function getBlockTimestamp(rpcs: string[], blockNumber: number): Promise<number | null> {
  try {
    const block = await rpcCall(rpcs, 'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false])
    return block?.timestamp ? Number(BigInt(block.timestamp)) : null
  } catch { return null }
}

// Binary search for the block whose timestamp is closest to (at or just
// before) targetUnixSeconds — used by backfill mode so a one-off historical
// scan can position itself accurately without assuming any chain's block
// time (several of these chains are L2s with very different block
// intervals than Ethereum Sepolia's ~12s).
async function findBlockByTimestamp(rpcs: string[], targetUnixSeconds: number): Promise<number> {
  let low = 0
  let high = await getCurrentBlockNumber(rpcs)
  for (let i = 0; i < 40 && low < high; i++) {
    const mid = Math.floor((low + high) / 2)
    const ts = await getBlockTimestamp(rpcs, mid)
    if (ts === null) break
    if (ts < targetUnixSeconds) low = mid + 1
    else high = mid
  }
  return low
}

async function getCurrentBlockNumber(rpcs: string[]): Promise<number> {
  const result = await rpcCall(rpcs, 'eth_blockNumber', [])
  return Number(BigInt(result))
}

async function fetchLogsBounded(rpcs: string[], filterBase: Record<string, unknown>, range?: { fromBlock: number; toBlock: number }): Promise<any[]> {
  let fromBlock: number, toBlock: number
  if (range) {
    ({ fromBlock, toBlock } = range)
  } else {
    toBlock = await getCurrentBlockNumber(rpcs)
    fromBlock = Math.max(0, toBlock - LOG_SCAN_WINDOW_BLOCKS)
  }
  const allLogs: any[] = []
  for (let from = fromBlock; from <= toBlock; from += LOG_SCAN_CHUNK_BLOCKS) {
    const to = Math.min(from + LOG_SCAN_CHUNK_BLOCKS - 1, toBlock)
    const filter = { ...filterBase, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }
    try {
      const logs = await rpcCall(rpcs, 'eth_getLogs', [filter])
      if (Array.isArray(logs)) allLogs.push(...logs)
    } catch (e) {
      console.error(`[transfer-worker] fetchLogsBounded chunk ${from}-${to} failed:`, serializeError(e))
    }
  }
  return allLogs
}

type MintCandidate = { transactionHash: string; blockNumber: number; amount: number }
type MintLookupResult = { matches: MintCandidate[]; candidateCount: number; candidateAmounts: string[] }

// Amount-fuzzy match only — NOT claim-worker's exact nonce-based match.
// claim-worker can do exact matching because it only ever watches ONE
// chain (Arc) and has a verified MessageTransmitter address for it. This
// worker watches up to 20 different destination chains, and getting even
// one of 20 different testnets' MessageTransmitterV2 addresses wrong from
// an unverified source would be worse than not attempting exact matching
// at all — a wrong contract address doesn't fail loudly, it just silently
// never matches anything. Amount-fuzzy matching (same tolerance band
// claim-worker's own fallback already uses safely in production) plus the
// same collision-safe write pattern (partial unique index on
// destination_tx_hash + skip-if-already-used) gets the actual bug fixed
// — stuck-forever transfers — without introducing a new class of risk. If
// per-chain MessageTransmitter addresses are ever verified against each
// chain's own docs, exact nonce matching can be added as a preferred first
// pass the same way claim-worker's confirmArrival tries nonce before amount.
async function findMintByAmount(destChain: string, recipient: string, amountUsdc: number, range?: { fromBlock: number; toBlock: number }): Promise<MintLookupResult> {
  const chain = DEST_CHAINS[destChain]
  if (!chain) return { matches: [], candidateCount: 0, candidateAmounts: [] }
  const recipientTopic = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const filter = { address: chain.usdc, topics: [TRANSFER_TOPIC0, KIT_FORWARD_TOPICS, recipientTopic] }
  let logs: any[]
  try {
    logs = await fetchLogsBounded(chain.rpcs, filter, range)
  } catch (e) {
    console.error(`[transfer-worker] mint scan failed for ${destChain}:`, serializeError(e))
    return { matches: [], candidateCount: 0, candidateAmounts: [] }
  }
  if (logs.length === 0) return { matches: [], candidateCount: 0, candidateAmounts: [] }
  const feeFloor = amountUsdc * 0.70
  const roundingSlack = amountUsdc * 0.001
  const candidateAmounts: string[] = []
  const qualifying: MintCandidate[] = []
  for (const log of logs) {
    try {
      const amount = Number(BigInt(log.data)) / 1e6 // every DEST_CHAINS USDC is 6 decimals
      candidateAmounts.push(amount.toString())
      if (amount >= feeFloor && amount <= amountUsdc + roundingSlack) {
        qualifying.push({ transactionHash: log.transactionHash, blockNumber: Number(BigInt(log.blockNumber)), amount })
      }
    } catch { /* skip unparseable log */ }
  }
  qualifying.sort((a, b) => b.amount - a.amount)
  return { matches: qualifying, candidateCount: logs.length, candidateAmounts }
}

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
      console.error('[transfer-worker] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }
  throw new Error('No Supabase service role key found - checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()
const SWEEP_DURATION_MS    = 50_000
const SWEEP_INTERVAL_MS    = 8_000
const STALE_LOCK_MS        = 6_000
const TRANSFER_TIMEOUT_MS  = 6 * 60 * 60 * 1000 // was 60min — confirmed live via Circle's own API that testnet attestation alone can take 4+ hours (checked directly: messages[].status stayed "pending_confirmations" that long for a real transfer). Safe to extend now that completion is authoritative (Circle's forwardState), not dependent on a scan finding the right block in time.

type Transfer = {
  id: string
  wallet_address: string
  tx_hash: string
  destination_tx_hash: string | null
  destination_chain: string
  amount: number
  arrived_amount: number | null
  message_hash: string | null
  status: string
  attempts: number
  error?: string | null
  created_at?: string
  updated_at?: string
}

function isDuplicateDestinationTxError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (!err) return false
  if (err.code === '23505') return true
  return typeof err.message === 'string' && err.message.includes('activity_bridge_destination_tx_hash_unique')
}

async function persistErrorBestEffort(supabase: SupabaseClient, id: string, message: string) {
  try {
    await supabase.from('activity').update({ error: message.slice(0, 250), last_error_at: new Date().toISOString() }).eq('id', id)
  } catch (e) {
    console.error(`[transfer-worker] persistErrorBestEffort threw for ${id}:`, e)
  }
}

async function markFailed(supabase: SupabaseClient, t: Transfer, message: string) {
  const { data: latest } = await supabase.from('activity').select('status').eq('id', t.id).single()
  if (latest?.status === 'completed') return
  await supabase.from('activity').update({ status: 'failed', error: message.slice(0, 250) }).eq('id', t.id)
}

async function advanceTransfer(supabase: SupabaseClient, t: Transfer) {
  const { data: latest } = await supabase.from('activity').select('*').eq('id', t.id).single()
  if (!latest || latest.status !== 'pending') return

  await supabase.rpc('increment_transfer_attempts', { p_transfer_id: t.id })

  try {
    const chain = DEST_CHAINS[latest.destination_chain]
    if (!chain) {
      await persistErrorBestEffort(supabase, t.id, `unsupported destination chain: ${latest.destination_chain}`)
      return
    }

    // ── 2026-09-20 authoritative detection via Circle's own forward-tracking ──
    // MAJOR FIX: this used to only read messages[0].status/message from this
    // response (to store message_hash) and otherwise rely entirely on
    // amount-fuzzy on-chain log scanning to find the mint — the same
    // heuristic used everywhere else in this codebase for exactly this
    // reason (no verified per-chain MessageTransmitter address to match
    // exactly). But Circle's OWN v2/messages response already contains the
    // exact answer in fields never read here before: forwardState and
    // destinationMintTxHash (also forwardTxHash, identical value). Per
    // Arc's own docs (unified-balance-error-recovery): "The top-level
    // message `status` describes the CCTP attestation. It doesn't confirm
    // that the forwarding transaction completed. Use `forwardState` and
    // `forwardTxHash` for the destination deposit." Confirmed live against
    // three transfers this worker had wrongly marked 'failed': all three
    // had forwardState:"COMPLETE" with a real destinationMintTxHash Circle
    // had recorded — the funds had genuinely arrived; amount-fuzzy scanning
    // just never found the right block/candidate among same-amount
    // collisions. destinationMintTxHash is authoritative and exact, same
    // guarantee claim-worker's nonce-based match has for the reverse
    // direction — no more guessing needed when Circle already knows.
    let circleMsg: any = null
    try {
      const url = `${CIRCLE_IRIS_API}/v2/messages/${ARC_DOMAIN}?transactionHash=${latest.tx_hash}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const data = await res.json().catch(() => ({}))
      circleMsg = data?.messages?.[0] ?? null
      if (circleMsg?.status === 'complete' && circleMsg?.message && !latest.message_hash) {
        await supabase.from('activity').update({ message_hash: circleMsg.message }).eq('id', t.id)
      }
    } catch (e) {
      console.error(`[transfer-worker] attestation fetch failed for ${t.id}:`, serializeError(e))
    }

    if (circleMsg?.forwardState === 'COMPLETE' && circleMsg?.destinationMintTxHash) {
      const mintHash = circleMsg.destinationMintTxHash as string
      const body = circleMsg?.decodedMessage?.decodedMessageBody
      // Real arrived amount straight from Circle's own decoded message —
      // amount minus the fee actually charged, both already in raw USDC
      // units (6 decimals) in this response. No RPC call needed to derive
      // it, unlike the amount-fuzzy path which has to read it off-chain.
      const arrivedAmount = body ? (Number(body.amount) - Number(body.feeExecuted)) / 1e6 : null

      const { data: alreadyUsed } = await supabase
        .from('activity').select('id').eq('destination_tx_hash', mintHash).eq('activity_type', 'bridge').neq('id', t.id).maybeSingle()
      if (!alreadyUsed) {
        const { error } = await supabase.from('activity').update({
          status: 'completed', destination_tx_hash: mintHash, arrived_amount: arrivedAmount, error: null,
        }).eq('id', t.id)
        if (!error) {
          console.log(`[transfer-worker] completed ${t.id} via Circle forwardState: ${mintHash} (${arrivedAmount})`)
          return
        }
        if (!isDuplicateDestinationTxError(error)) {
          console.error(`[transfer-worker] update failed for ${t.id}:`, error.message)
          await persistErrorBestEffort(supabase, t.id, `update failed: ${error.message}`)
          return
        }
        // Race with something else writing the same hash — fine, fall
        // through to the diagnostic path below rather than treat it as new.
      }
      // else: this exact mint is already claimed by a different row — an
      // actual data problem (two transfers can't share one mint), not
      // something to silently retry. Falls through to persistErrorBestEffort
      // below with a clear diagnostic instead of the generic amount-fuzzy one.
      if (alreadyUsed) {
        await persistErrorBestEffort(supabase, t.id, `Circle reports mint ${mintHash} but it's already recorded on a different transfer (${alreadyUsed.id}) — needs manual review`)
        return
      }
    } else if (circleMsg?.forwardState === 'FAILED') {
      // Per Arc's docs: "Relayer reported a permanent failure; manual mint
      // may be required." This is Circle telling us directly it gave up —
      // no reason to keep polling for 60 minutes when the source already
      // says it's terminal.
      await markFailed(supabase, latest, 'Circle\'s relayer reported a permanent forwarding failure for this transfer — the burn succeeded but the mint did not complete automatically. May need a manual mint.')
      return
    }
    // forwardState PENDING/null/absent: keep going — fall through to the
    // amount-fuzzy scan below as a backstop (in case forwardState is ever
    // unavailable for a given message) and normal timeout handling.

    const result = await findMintByAmount(latest.destination_chain, latest.wallet_address, Number(latest.amount))
    let claimed = false
    const skippedAlreadyUsed: string[] = []
    for (const mint of result.matches) {
      const { data: alreadyUsed } = await supabase
        .from('activity')
        .select('id')
        .eq('destination_tx_hash', mint.transactionHash)
        .eq('activity_type', 'bridge')
        .neq('id', t.id)
        .maybeSingle()
      if (alreadyUsed) { skippedAlreadyUsed.push(`${mint.transactionHash}->${alreadyUsed.id}`); continue }

      const { error } = await supabase
        .from('activity')
        .update({
          status: 'completed',
          destination_tx_hash: mint.transactionHash,
          arrived_amount: mint.amount,
          error: null,
        })
        .eq('id', t.id)
      if (error) {
        if (isDuplicateDestinationTxError(error)) { skippedAlreadyUsed.push(`${mint.transactionHash}->(race)`); continue }
        console.error(`[transfer-worker] update failed for ${t.id}:`, error.message)
        await persistErrorBestEffort(supabase, t.id, `update failed: ${error.message}`)
        return
      }
      console.log(`[transfer-worker] completed ${t.id}: ${mint.transactionHash} (${mint.amount})`)
      claimed = true
      break
    }

    if (claimed) return

    // Only apply the timeout AFTER a real attempt found nothing — never
    // before. A transfer whose first-ever check happens well after
    // TRANSFER_TIMEOUT_MS has already elapsed (exactly what happened to
    // every pre-existing stuck transfer the moment this worker was first
    // deployed, since they'd been sitting unwatched for weeks) deserves
    // that one real look before being failed, not an instant time-based
    // rejection with zero scan ever attempted.
    const createdMs = latest.created_at ? new Date(latest.created_at).getTime() : Date.now()
    const attemptsSoFar = (latest.attempts ?? 0) + 1 // +1 for the increment this pass just did
    if (Date.now() - createdMs >= TRANSFER_TIMEOUT_MS && attemptsSoFar >= 3) {
      await markFailed(supabase, latest, 'Timed out waiting for the mint on the destination chain')
      return
    }

    const diag = result.candidateCount === 0
      ? 'no-match: 0 Transfer logs found to this recipient on destination chain'
      : skippedAlreadyUsed.length > 0
        ? `no-match: all ${skippedAlreadyUsed.length} qualifying candidate(s) already claimed: [${skippedAlreadyUsed.join(', ')}]`
        : `no-match: ${result.candidateCount} candidate log(s) found, amounts=[${result.candidateAmounts.join(',')}], expected>=${(Number(latest.amount) * 0.7).toFixed(6)}`
    await persistErrorBestEffort(supabase, t.id, diag)
  } catch (e) {
    console.error(`[transfer-worker] advanceTransfer error for ${t.id}:`, e)
    await persistErrorBestEffort(supabase, t.id, `advanceTransfer: ${serializeError(e)}`)
  }
}

async function fetchDueTransfers(supabase: SupabaseClient, transferId?: string): Promise<Transfer[]> {
  if (transferId) {
    const { data, error } = await supabase.rpc('fetch_and_lock_due_transfers', { p_transfer_id: transferId })
    if (error) { console.error('[transfer-worker] fetch error (single)', error.message); return [] }
    return (data ?? []) as Transfer[]
  }
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString()
  const { data, error } = await supabase.rpc('fetch_and_lock_due_transfers', { p_stale_cutoff: cutoff, p_limit: 200 })
  if (error) { console.error('[transfer-worker] fetch error (sweep)', error.message); return [] }
  return (data ?? []) as Transfer[]
}

async function processPass(supabase: SupabaseClient, transferId?: string): Promise<number> {
  const transfers = await fetchDueTransfers(supabase, transferId)
  await Promise.all(transfers.map(t => advanceTransfer(supabase, t).catch(e => {
    console.error(`[transfer-worker] advance ${t.id} failed:`, serializeError(e))
    return persistErrorBestEffort(supabase, t.id, `advanceTransfer threw: ${serializeError(e)}`)
  })))
  return transfers.length
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  let body: any = {}
  try { body = await req.json() } catch { /* sweep may send no body */ }
  const mode = body?.mode === 'single' ? 'single' : body?.mode === 'diagnose' ? 'diagnose' : body?.mode === 'backfill' ? 'backfill' : 'sweep'

  // One-off diagnostic: fetch a transaction + receipt on a destination
  // chain and return its raw shape, so a specific match found by
  // amount-fuzzy detection can be manually sanity-checked (e.g. is `to`
  // really the USDC contract, does the tx look like a CCTP relay call
  // versus something else like a testnet faucet mint) before trusting it.
  if (mode === 'diagnose' && body?.chain && body?.txHash) {
    const chain = DEST_CHAINS[body.chain]
    if (!chain) return json({ success: false, error: `unknown chain ${body.chain}` }, 400)
    try {
      const [tx, receipt] = await Promise.all([
        rpcCall(chain.rpcs, 'eth_getTransactionByHash', [body.txHash]),
        rpcCall(chain.rpcs, 'eth_getTransactionReceipt', [body.txHash]),
      ])
      return json({
        success: true,
        tx: tx ? { to: tx.to, from: tx.from, input: (tx.input || '').slice(0, 10), blockNumber: tx.blockNumber } : null,
        logs: (receipt?.logs || []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data })),
      })
    } catch (e) {
      return json({ success: false, error: serializeError(e) }, 500)
    }
  }

  // One-off historical scan for a single transfer, positioned around its
  // OWN burn time via binary search rather than "now minus a fixed window"
  // — the normal sweep's recent-window scan can never find a mint that
  // happened shortly after an old burn, since by the time the worker looks
  // again, that block range has scrolled out of the recent window entirely.
  if (mode === 'backfill' && body?.transferId) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: t, error: fetchErr } = await supabase.from('activity').select('*').eq('id', body.transferId).single()
    if (fetchErr || !t) return json({ success: false, error: fetchErr?.message ?? 'transfer not found' }, 404)
    const chain = DEST_CHAINS[t.destination_chain]
    if (!chain) return json({ success: false, error: `unsupported destination chain: ${t.destination_chain}` }, 400)

    // Same authoritative check advanceTransfer now does first — Circle's
    // own forwardState/destinationMintTxHash beats guessing from on-chain
    // logs. Try it before falling back to the scan below.
    if (t.status !== 'completed') {
      try {
        const circleRes = await fetch(`${CIRCLE_IRIS_API}/v2/messages/${ARC_DOMAIN}?transactionHash=${t.tx_hash}`, { signal: AbortSignal.timeout(8000) })
        const circleMsg = (await circleRes.json().catch(() => ({})))?.messages?.[0]
        if (circleMsg?.forwardState === 'COMPLETE' && circleMsg?.destinationMintTxHash) {
          const mintHash = circleMsg.destinationMintTxHash as string
          const body2 = circleMsg?.decodedMessage?.decodedMessageBody
          const arrivedAmount = body2 ? (Number(body2.amount) - Number(body2.feeExecuted)) / 1e6 : null
          const { data: alreadyUsed } = await supabase.from('activity').select('id').eq('destination_tx_hash', mintHash).eq('activity_type', 'bridge').neq('id', t.id).maybeSingle()
          if (!alreadyUsed) {
            const { error } = await supabase.from('activity').update({ status: 'completed', destination_tx_hash: mintHash, arrived_amount: arrivedAmount, error: null }).eq('id', t.id)
            if (!error) {
              return json({ success: true, transferId: t.id, destChain: t.destination_chain, completedAs: mintHash, via: 'circle-forwardState' })
            }
          }
        }
      } catch (e) {
        console.error(`[transfer-worker] backfill: Circle forwardState check failed for ${t.id}:`, serializeError(e))
      }
    }

    const burnMs = t.created_at ? new Date(t.created_at).getTime() : Date.now()
    const targetStart = Math.floor(burnMs / 1000) - 300 // 5min buffer before the burn
    const fromBlock = await findBlockByTimestamp(chain.rpcs, targetStart)
    const currentBlock = await getCurrentBlockNumber(chain.rpcs)
    // Scan a generous window after the burn (or up to "now" for a burn
    // recent enough that the whole gap is smaller) — CCTP mints normally
    // land within minutes to a couple hours of the burn, not days.
    const toBlock = Math.min(currentBlock, fromBlock + 600_000)

    const result = await findMintByAmount(t.destination_chain, t.wallet_address, Number(t.amount), { fromBlock, toBlock })

    let completedAs: string | null = null
    const skippedAlreadyUsed: string[] = []
    if (t.status !== 'completed') {
      for (const candidate of result.matches) {
        const { data: alreadyUsed } = await supabase
          .from('activity').select('id').eq('destination_tx_hash', candidate.transactionHash).eq('activity_type', 'bridge').neq('id', t.id).maybeSingle()
        if (alreadyUsed) { skippedAlreadyUsed.push(candidate.transactionHash); continue }
        const { error } = await supabase.from('activity').update({
          status: 'completed', destination_tx_hash: candidate.transactionHash, arrived_amount: candidate.amount, error: null,
        }).eq('id', t.id)
        if (!error) { completedAs = candidate.transactionHash; break }
      }
    }

    return json({
      success: true, transferId: t.id, destChain: t.destination_chain,
      scannedFromBlock: fromBlock, scannedToBlock: toBlock,
      candidateCount: result.candidateCount, candidateAmounts: result.candidateAmounts,
      matches: result.matches, skippedAlreadyUsed, completedAs,
    })
  }

  if (mode === 'single' && body?.transferId) {
    const start = Date.now()
    let totalProcessed = 0
    while (Date.now() - start < SWEEP_DURATION_MS) {
      const { data } = await supabase.from('activity').select('status').eq('id', body.transferId).maybeSingle()
      if (!data || data.status === 'completed' || data.status === 'failed') break
      totalProcessed += await processPass(supabase, body.transferId)
      await new Promise(r => setTimeout(r, SWEEP_INTERVAL_MS))
    }
    return json({ success: true, mode, processed: totalProcessed })
  }

  const totalProcessed = await processPass(supabase)
  return json({ success: true, mode, totalProcessed, idleExit: totalProcessed === 0 })
})
