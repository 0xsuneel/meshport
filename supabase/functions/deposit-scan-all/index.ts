// supabase/functions/deposit-scan-all/index.ts
//
// ── Why this exists ─────────────────────────────────────────────────────────
// claim-recovery-scan already detects "external deposit landed straight on
// this wallet's address" (see its recordExternalReceive) — but it's only
// ever invoked FOR ONE WALLET, triggered from AppLayout.tsx when that
// wallet's own browser tab is open or becomes visible again. A deposit sent
// while the recipient never opens the app (e.g. an exchange withdrawal —
// OKX, etc. — sent straight to the MeshPort address, with nobody chatting it
// into the messages table) never gets a chance to be scanned for at all.
//
// This function does the same "plain incoming Transfer with no activity row
// yet" detection as claim-recovery-scan's non-mint branch, but for EVERY
// known wallet in one pass, so it can run on a schedule — genuinely
// independent of any browser tab.
//
// Deliberately scoped to just the external-receive case (not CCTP mint/claim
// reconciliation — that stays claim-recovery-scan's job).
//
// ── 2026-07-16 latency fix ───────────────────────────────────────────────────
// ROOT CAUSE of the observed 2-3min delay between "balance updates" and
// "activity row appears": this function used to run ONE PASS per invocation,
// triggered by pg_cron every 2 minutes, with no internal loop at all. Compare
// to claim-worker, which self-loops every ~8s for ~50s per invocation and
// only relies on its once-a-minute cron trigger as a safety net. This
// function had no such loop, so its real-world detection latency was bounded
// by the cron *schedule itself* (up to 2 minutes), not by chain confirmation
// time or RPC round-trip time. The Realtime layer (ActivityService.ts) was
// never the bottleneck — it pushes a row to the UI the instant it's inserted.
//
// Fix (this revision): adopt the exact same self-looping "sweep" architecture
// claim-worker already uses (mode: 'sweep' loops ~8s internally, cron
// re-triggers every minute as the safety net), PLUS a persisted cursor so
// each pass only scans the gap since the last successful scan instead of a
// fixed lookback window from scratch every time.
//
// ── USDC needs a DIFFERENT detection path than EURC/cirBTC ──────────────────
// EURC and cirBTC are genuine ERC-20 tokens — every transfer emits a Transfer
// event log, so eth_getLogs on their contract addresses reliably catches
// them (log-based scan, cursor-windowed instead of fixed-window as before).
//
// USDC is different: per Arc's own docs, it's the chain's NATIVE gas
// currency (18-decimal value transfers, no contract call), and the
// "optional ERC20 interface" at 0x3600...0000 is a SEPARATE, opt-in 6-decimal
// wrapper — plain native sends (which is how a normal wallet/exchange
// withdrawal, e.g. from OKX, actually sends funds) never touch that contract
// and never emit a log. eth_getLogs is structurally blind to these; no
// amount of tuning the window fixes it.
//
// PRIMARY detection for native USDC is now direct RPC: eth_getBlockByNumber
// (blockNumber, true) per new block since the cursor, checking every tx's
// `to` field against the known-wallet set in memory (there's no server-side
// filter available for plain value transfers the way eth_getLogs offers for
// event topics — this is the necessary tradeoff for catching them via RPC at
// all). Bounded concurrency + a per-pass block cap keep this cheap in the
// steady state and safe during catch-up after downtime.
//
// Blockscout's indexed REST API (GET /api/v2/addresses/{address}/transactions)
// is now ONLY used in 'reconcile' mode, as a backstop — it recovers anything
// the direct-RPC block scan might have missed (RPC hiccups, a missed block
// range during a cold start, etc). It is not a dependency of the fast path.
//
// ── FIX D (wrapper coverage) — the native scan alone is NOT sufficient ───────
// The paragraph above is correct that plain native sends never touch the
// 0x3600 wrapper. What it missed is the CONVERSE: a USDC transfer routed
// THROUGH that wrapper never appears as a native value transfer either. Such a
// transaction has
//     tx.to    = 0x3600000000000000000000000000000000000000   (the wrapper)
//     tx.value = 0                                            (no native move)
//     input    = transfer(address,uint256)                    (ERC-20 call)
// so `fetchNativeDepositsRange`'s `walletSet.has(tx.to)` test rejects it before
// any amount check, and the recipient is credited with nothing recorded.
//
// Confirmed on live data: 0x8c831fb5…87c0 (block 56088892) credited a
// registered wallet 20 USDC from an ordinary EOA. It was NOT internal-sender,
// NOT a swap, NOT self-transfer, NOT zero-value, NOT an external recipient —
// and it produced ZERO activity rows anywhere in the database while the native
// cursor sat 7,764 blocks past it. The reconcile backstop misses it too: it
// queries `?filter=to`, and `to` is the wrapper, not the wallet (verified live
// — the transaction is only visible under the explorer's `token-transfers`
// endpoint, which this function never calls).
//
// The fix scans 0xffff…fffe, NOT the 0x3600 wrapper. Both emit a Transfer log
// for this transaction, so scanning both would double-count:
//     0xffff…fffe  raw 20000000000000000000  /1e18 = 20   (18 decimals)
//     0x3600…0000  raw           20000000    /1e6  = 20   ( 6 decimals)
// 0xffff…fffe is the authoritative representation and a strict superset of real
// credits — it logs wrapper-routed AND plain native movements (measured over
// 3,000 live blocks; see blockchain-indexer/chains.ts for that measurement).
// Scanning only 0x3600 would miss every plain native transfer instead.
//
// This mirrors the indexer's Fix B so the two systems have the same semantic
// coverage. It is deliberately a THIRD source alongside the native block scan
// rather than a replacement: the native scan still catches plain sends whose
// log delivery an RPC might drop, and the two are deduped (see EMIT DEDUP).
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
const ARC_EXPLORER = 'https://testnet.arcscan.app'
const ARC_EXPLORER_API = 'https://testnet.arcscan.app/api/v2'

// Circle's own Kit/CCTP infrastructure contracts on Arc — mirrors
// CIRCLE_CONTRACTS in api/relay-rpc.js (kept in sync manually; these are
// static testnet deployment addresses, not expected to change often).
// A candidate whose fromAddr is one of these is DEFINITIONALLY not a real
// external deposit — a swap's output leg, for instance, is a Transfer FROM
// the Kit Adapter Contract, not from any wallet a real person or exchange
// controls. Unlike the amount/token/timing-based matching below (which is
// necessarily probabilistic — it's guessing "this looks related to that
// recent swap"), this is a hard fact: no genuine OKX/MetaMask/faucet/
// person-to-person transfer will ever originate from one of these
// addresses, so these are always skipped outright, not just marked quiet.
const KNOWN_INTERNAL_CONTRACTS = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // Kit Bridge Contract testnet
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', // Kit Adapter Contract testnet — swaps route through this
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter
  // Multicall3 — BulkPay routes through this. Was missing here (this file's
  // own local copy had drifted from _shared/knownInternalContracts.ts, the
  // same gap activity-consumer/decide.ts had — see that file's comment for
  // the live production evidence, tx 0xac28f48b…/0x22b268c5…). Added to keep
  // this native-USDC reconcile backstop from crediting a BulkPay self-send
  // as an external deposit the same way the primary consumer did.
  '0xca11bde05977b3631167028862be2a173976ca11',
])

function isFromKnownInternalContract(fromAddr: string | undefined | null): boolean {
  return KNOWN_INTERNAL_CONTRACTS.has((fromAddr || '').toLowerCase())
}
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)
const NATIVE_DECIMALS = 18

// Genuine ERC-20 tokens only — USDC is handled separately below via direct
// block scanning, since it's Arc's native currency and plain sends never
// touch its optional ERC-20 wrapper contract (see comment above).
//
// USDC is deliberately NOT added to this list. Doing so is the obvious-looking
// fix and it is wrong twice over: the 0x3600 wrapper carries 6 decimals while
// this scan's sibling native path uses 18, and a wrapper-routed transfer emits
// a log on BOTH 0x3600 and 0xffff…fffe — so adding either address here would
// double-count against the native-USDC source below. Native USDC gets its own
// path (FIX D) keyed on the authoritative 18-decimal contract instead.
const TOKENS: Array<{ symbol: string; contract: string; decimals: number }> = [
  { symbol: 'EURC',   contract: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
  { symbol: 'cirBTC', contract: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 },
]

// ── FIX D — authoritative native-USDC Transfer log contract ─────────────────
// Emits a Transfer for EVERY native-USDC movement, wrapper-routed or plain, in
// 18 decimals (NATIVE_DECIMALS). Same address the indexer scans, so the two
// systems observe the same population.
//
// Stored lowercase and always compared lowercase: the chain returns this
// address checksummed as 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE, so a
// case-sensitive comparison against log.address would silently never match and
// this whole path would appear to work while detecting nothing.
const NATIVE_USDC_LOG_CONTRACT = '0xfffffffffffffffffffffffffffffffffffffffe'

// The 6-decimal opt-in ERC-20 view of the same native USDC. Never scanned —
// named only so the exclusion is explicit and greppable rather than implied by
// absence. See the FIX D header for the double-count measurement.
const USDC_WRAPPER_CONTRACT = '0x3600000000000000000000000000000000000000'

// ── Sweep cadence — same pattern as claim-worker ─────────────────────────────
// pg_cron only needs to fire once a minute; this internal loop is the actual
// fast path, giving ~3s effective detection cadence regardless of the cron
// schedule. If an invocation dies early, the next cron tick just resumes
// from the persisted cursor — nothing is lost.
// 2026-07-19: reduced from 8s to 3s — the wallet's own balance figure
// already updates fast via a separate, faster-cadence path (direct RPC
// balance polling), but the notification specifically was bottlenecked by
// this interval: a deposit landing right after a sweep tick completed had
// to wait the full interval for the next one. 8s alone doesn't explain a
// 30s real-world gap on its own — that also includes whatever's left of
// the current 50s invocation window before the tick lands, plus any cold
// start after an idle period — but this is the one number directly in our
// control that scales the typical case down proportionally.
const SWEEP_DURATION_MS = 65_000
const SWEEP_INTERVAL_MS = 2_000

// First-ever run (no cursor row yet) bridges this many blocks of history —
// same conservative default the old fixed-window approach used. After that,
// every subsequent pass scans only the true gap since the last cursor.
const INIT_LOOKBACK_BLOCKS = 20_000

// Per-pass caps so a very stale cursor (e.g. after extended downtime) can't
// make a single invocation run unboundedly long — it just takes a few more
// ~8s loop iterations (or a few more cron ticks) to fully catch up.
const MAX_NATIVE_BLOCKS_PER_PASS = 3_000
const NATIVE_BLOCK_CONCURRENCY  = 8
const MAX_LOG_BLOCKS_PER_PASS   = 100_000
const LOG_CHUNK_SIZE = 5_000
const LOG_CHUNK_CONCURRENCY = 5

// ── FIX D.2 — dedicated per-pass range for the authoritative native-USDC log ─
// MAX_LOG_BLOCKS_PER_PASS (100k) is sized for EURC/cirBTC, which are SPARSE:
// a 5,000-block chunk of those returns a handful of logs. 0xffff…fffe is not
// sparse — it emits a Transfer for EVERY native-USDC movement on the chain,
// which on Arc is the native gas currency.
//
// The binding constraint is the RPC's eth_getLogs RESULT CAP, not the block
// span. Measured live against this contract:
//
//   3,000 blocks -> {"code":-32602,"message":"query exceeds max results 20000,
//                    retry with the range 56081656-56083665"}
//   1,000 blocks -> 9,685 logs, 6.1 MB
//     200 blocks -> 1,825 logs, 1.2 MB
//
// So ~9.7 logs/block: any window above ~2,060 blocks exceeds the 20,000-result
// cap and is REJECTED OUTRIGHT. An earlier revision used 3,000 on the reasoning
// that it matched the blockchain-indexer's maxBlocksPerPass. That was wrong: the
// indexer chunks its log query by nativeSafe after a per-block native scan, so
// its effective eth_getLogs window is far smaller than 3,000 and stays under the
// cap. Deployed result of the 3,000 value: the single chunk was rejected on every
// pass, safeUpTo came back as fromBlock - 1, the (correct) strict cursor guard
// declined to advance, and native_usdc_logs sat frozen at 56081655 for 12.9h
// while native_blocks, erc20_logs:EURC and erc20_logs:cirBTC all tracked head.
//
// 500 blocks is ~4,800 logs — roughly 4x headroom under the cap, so ordinary
// traffic growth cannot silently push a window back over it. Deliberately a
// SEPARATE constant: EURC/cirBTC work correctly at 100k and must not be slowed
// down to fix a problem they do not have.
const MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS = 500

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
      console.error('[deposit-scan-all] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }
  throw new Error('No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

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

// Races all known RPCs, returns the first-settled successful result — used
// for single-block fetches where we want the fastest healthy endpoint rather
// than waiting on all of them.
async function rpcCallAny(method: string, params: unknown[]): Promise<any> {
  const results = await Promise.allSettled(ARC_RPCS.map(url => rpcCallSingle(url, method, params)))
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value != null) return r.value
  }
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  throw firstError?.reason ?? new Error(`${method}: all Arc RPC endpoints failed`)
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

// ── Structured logging ───────────────────────────────────────────────────
// Plain console.error(string) is all this file had before — fine for
// failures, useless for seeing *why* a healthy-looking invocation still
// produced a delayed row. One JSON line per event, so a log query can
// answer "what was the cursor / latest block / candidates / inserts for
// this pass" without guessing from prose.
function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ fn: 'deposit-scan-all', event, ts: new Date().toISOString(), ...fields }))
}

function serializeErrorForRpc(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

// ── Persisted scan cursor (supabase/migrations/*_deposit_scan_cursor.sql) ──
// One row per detection source ('native_blocks' | 'erc20_logs'). This is
// what lets each pass scan only the true gap since the last successful scan
// instead of re-scanning a fixed lookback window from scratch every time.
async function getCursor(supabase: SupabaseClient, source: string, fallback: number): Promise<number> {
  const { data, error } = await supabase
    .from('deposit_scan_cursor')
    .select('last_scanned_block')
    .eq('source', source)
    .maybeSingle()
  if (error) {
    console.error(`[deposit-scan-all] cursor read failed for ${source}, using fallback:`, error.message)
    return fallback
  }
  if (!data) return fallback
  return Number(data.last_scanned_block)
}

async function setCursor(supabase: SupabaseClient, source: string, block: number): Promise<void> {
  const { error } = await supabase
    .from('deposit_scan_cursor')
    .upsert({ source, last_scanned_block: block, updated_at: new Date().toISOString() }, { onConflict: 'source' })
  if (error) console.error(`[deposit-scan-all] cursor write failed for ${source}:`, error.message)
}

// ── ERC-20 log scan (EURC / cirBTC) — cursor-windowed ───────────────────────
// Unfiltered by recipient (unlike claim-recovery-scan, which filters by ONE
// wallet's topic) — we want every incoming Transfer on the token in the
// window, then match against the whole known-wallet set in memory. Far
// cheaper than one eth_getLogs call per user.
//
// Returns the logs found AND the highest block we can safely advance the
// cursor to — if any chunk failed on every RPC, we stop the safe cursor at
// the start of the earliest failed chunk so a transient RPC failure can
// never cause a silent permanent gap; the next pass retries from there.
async function fetchTransferLogsRange(
  contract: string, fromBlock: number, toBlock: number,
): Promise<{ logs: any[]; safeUpTo: number }> {
  const queryChunk = async (from: number, to: number): Promise<{ ok: boolean; logs: any[] }> => {
    const filter = {
      address: contract,
      topics:  [TRANSFER_TOPIC0],
      fromBlock: '0x' + from.toString(16),
      toBlock:   '0x' + to.toString(16),
    }
    const results = await Promise.allSettled(ARC_RPCS.map(url => rpcCallSingle(url, 'eth_getLogs', [filter])))
    const logs = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .flatMap(r => (Array.isArray(r.value) ? r.value : []))
    const anySucceeded = results.some(r => r.status === 'fulfilled')
    return { ok: anySucceeded, logs }
  }

  const chunks: Array<[number, number]> = []
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_SIZE) {
    chunks.push([from, Math.min(from + LOG_CHUNK_SIZE - 1, toBlock)])
  }

  const allLogs: any[] = []
  let firstFailedFrom: number | null = null
  for (let i = 0; i < chunks.length; i += LOG_CHUNK_CONCURRENCY) {
    // Stop launching new batches once we've hit a failure — later blocks may
    // depend on context we no longer trust being contiguous, and there's no
    // benefit to racing ahead past a known gap.
    if (firstFailedFrom !== null) break
    const batch = chunks.slice(i, i + LOG_CHUNK_CONCURRENCY)
    const results = await Promise.allSettled(batch.map(([from, to]) => queryChunk(from, to)))
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      const [from, to] = batch[j]
      if (r.status === 'fulfilled' && r.value.ok) {
        allLogs.push(...r.value.logs)
      } else {
        console.error(`[deposit-scan-all] log chunk ${from}-${to} failed for ${contract}:`, r.status === 'rejected' ? serializeErrorForRpc(r.reason) : 'no RPC succeeded')
        if (firstFailedFrom === null || from < firstFailedFrom) firstFailedFrom = from
      }
    }
  }

  const safeUpTo = firstFailedFrom !== null ? firstFailedFrom - 1 : toBlock
  return { logs: allLogs, safeUpTo }
}

// ── Native USDC scan — cursor-windowed direct RPC block scan (PRIMARY) ──────
// Native value transfers emit no log, so there is no server-side filter
// available the way eth_getLogs offers for events — every tx in every block
// since the cursor has to be pulled and checked against the known-wallet set
// in memory. Bounded concurrency keeps this cheap; the per-pass block cap
// keeps a single invocation from running long during catch-up (the next
// ~8s loop iteration, or the next cron tick, just continues from where this
// one left off).
async function fetchNativeDepositsRange(
  fromBlock: number, toBlock: number, walletSet: Map<string, string>,
): Promise<{ candidates: Array<{ txHash: string; fromAddr: string; toAddr: string; amount: number }>; safeUpTo: number }> {
  const blockNumbers: number[] = []
  for (let b = fromBlock; b <= toBlock; b++) blockNumbers.push(b)

  const candidates: Array<{ txHash: string; fromAddr: string; toAddr: string; amount: number }> = []
  let firstFailedBlock: number | null = null

  for (let i = 0; i < blockNumbers.length; i += NATIVE_BLOCK_CONCURRENCY) {
    if (firstFailedBlock !== null) break
    const batch = blockNumbers.slice(i, i + NATIVE_BLOCK_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(bn => rpcCallAny('eth_getBlockByNumber', ['0x' + bn.toString(16), true])),
    )
    for (let j = 0; j < results.length; j++) {
      const bn = batch[j]
      const r = results[j]
      if (r.status !== 'fulfilled' || !r.value) {
        console.error(`[deposit-scan-all] native block ${bn} fetch failed:`, r.status === 'rejected' ? serializeErrorForRpc(r.reason) : 'empty result')
        if (firstFailedBlock === null || bn < firstFailedBlock) firstFailedBlock = bn
        continue
      }
      const block = r.value
      const txs: any[] = Array.isArray(block.transactions) ? block.transactions : []
      for (const tx of txs) {
        const toAddr = (tx?.to ?? '') as string
        if (!toAddr) continue // contract creation, irrelevant here
        const toLower = toAddr.toLowerCase()
        if (!walletSet.has(toLower)) continue // not one of ours
        const fromAddr = ((tx?.from ?? '') as string).toLowerCase()
        if (fromAddr === toLower) continue // self-send
        let amount: number
        try { amount = Number(BigInt(tx.value ?? '0x0')) / (10 ** NATIVE_DECIMALS) } catch { continue }
        if (!Number.isFinite(amount) || amount <= 0) continue
        candidates.push({
          txHash: (tx.hash as string).toLowerCase(),
          fromAddr,
          toAddr: walletSet.get(toLower)!,
          amount,
        })
      }
    }
  }

  const safeUpTo = firstFailedBlock !== null ? firstFailedBlock - 1 : toBlock
  return { candidates, safeUpTo }
}

// ── FIX D — contract-mediated native-USDC scan ──────────────────────────────
// Reuses fetchTransferLogsRange (same chunking, same safe-cursor semantics) and
// applies acceptance rules identical to the native block scan above, so the two
// sources can never disagree about what counts as a deposit.
//
// Amounts use NATIVE_DECIMALS (18), matching the native path — this contract is
// the 18-decimal representation, NOT the 6-decimal 0x3600 wrapper view.
async function fetchNativeUsdcLogDeposits(
  fromBlock: number, toBlock: number, walletSet: Map<string, string>,
): Promise<{ candidates: Array<{ txHash: string; fromAddr: string; toAddr: string; amount: number }>; safeUpTo: number }> {
  const { logs, safeUpTo } = await fetchTransferLogsRange(NATIVE_USDC_LOG_CONTRACT, fromBlock, toBlock)

  const candidates: Array<{ txHash: string; fromAddr: string; toAddr: string; amount: number }> = []
  for (const log of logs) {
    const fromTopic = (log.topics?.[1] as string) || ''
    const toTopic   = (log.topics?.[2] as string) || ''
    if (!fromTopic || !toTopic) continue
    // Fixed-width slice(-40), never a leading-zero strip: an address of its own
    // beginning 0x0… would be mangled into a 41-char string that can never
    // match the wallet set, silently dropping ~1 wallet in 16.
    const toAddr   = ('0x' + toTopic.slice(-40)).toLowerCase()
    const fromAddr = ('0x' + fromTopic.slice(-40)).toLowerCase()
    if (fromTopic.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()) continue // mint — claim-recovery-scan's job
    if (!walletSet.has(toAddr)) continue                                    // not one of ours / external recipient
    if (toAddr === fromAddr) continue                                       // self-transfer
    let amount: number
    try { amount = Number(BigInt(log.data)) / (10 ** NATIVE_DECIMALS) } catch { continue }
    if (!Number.isFinite(amount) || amount <= 0) continue                   // zero-value
    candidates.push({
      txHash: (log.transactionHash as string).toLowerCase(),
      fromAddr,
      toAddr: walletSet.get(toAddr)!,
      amount,
    })
  }
  return { candidates, safeUpTo }
}

// ── Backstop only — Blockscout's indexed REST API ───────────────────────────
// Used exclusively in 'reconcile' mode to recover anything the direct-RPC
// block scan might have missed (an RPC hiccup during a pass, a cold-start
// gap, etc). Not on the fast path, not a dependency of it.
async function fetchNativeDepositsViaExplorer(walletAddress: string): Promise<Array<{ txHash: string; fromAddr: string; amount: number }>> {
  const url = `${ARC_EXPLORER_API}/addresses/${walletAddress}/transactions?filter=to`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`explorer API ${res.status} for ${walletAddress}`)
  const body = await res.json()
  const items: any[] = Array.isArray(body?.items) ? body.items : []

  const out: Array<{ txHash: string; fromAddr: string; amount: number }> = []
  for (const item of items) {
    // Blockscout v2 nests from/to as objects with a `hash` field; be
    // defensive in case of shape drift across versions.
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

async function recordExternalReceive(
  supabase: SupabaseClient,
  walletAddress: string,
  txHash: string,
  amount: number,
  fromAddress: string,
  tokenSymbol: string,
  recovered: boolean,
  quiet: boolean = false,
) {
  const { error } = await supabase
    .from('activity')
    .upsert({
      wallet_address:       walletAddress.toLowerCase(),
      tx_hash:              `recv_${txHash.toLowerCase()}`,
      activity_type:        'receive',
      amount,
      usd_value:            amount,
      token_symbol:         tokenSymbol,
      counterparty_address: fromAddress.toLowerCase(),
      explorer_url:         `${ARC_EXPLORER}/tx/${txHash}`,
      // 'quiet' rows use an explicit, separate receiveKind on purpose —
      // HomePage.tsx's fireIfReceived() only notifies for 'external_deposit'
      // (not 'external_deposit_quiet'). See recentSwapOutputsByWallet/
      // matchesRecentSwapOutput below for why a row would be quiet: still
      // fully recorded (balance/history stay correct), just not alerted on,
      // because it matches a swap's own output leg that the exact-hash
      // dedupe below didn't catch in time. `note` is kept for human display
      // only now — classification no longer depends on its exact wording
      // (see ActivityService.ts's comment on receiveKind for the full
      // reasoning; this was the root cause of claim-recovery-scan's
      // equivalent writer silently never notifying, since it used a
      // differently-worded note for the same real-world event).
      metadata:             { recovered, note: quiet ? 'External deposit (near a swap)' : 'External deposit', receiveKind: quiet ? 'external_deposit_quiet' : 'external_deposit' },
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
  if (error) console.error('[deposit-scan-all] recordExternalReceive failed:', error.message)
}

// Grace window used by recentSwapOutputsByWallet below. Was 20s — widened
// after that still proved too tight in practice (a duplicate notification
// was still observed for a swap whose completion and the sweep pass that
// caught its output leg were more than 20s apart). Safe to be generous
// here now that matching also requires token + amount to be close (see
// matchesRecentSwapOutput) — unlike the original wallet-only check, a
// wider window doesn't reintroduce suppressing genuinely unrelated
// deposits, since those still won't match on amount/token.
const SWAP_GRACE_SECONDS = 45

interface RecentSwapOutput { token: string; amount: number }

// Backstop against the exact-hash race in filterAlreadyRecorded/
// recordSwapActivity (api/swap-proxy.js): that fix writes the swap's own
// 'swap' activity row synchronously and should almost always win the race
// against this sweep, but "almost always" isn't good enough for something
// users see as a wrong notification label every time it's lost.
//
// Checks, per pass, which candidate wallets have a 'swap' row from the
// last SWAP_GRACE_SECONDS, and what that swap actually delivered
// (metadata.tokenOut/amountOut, recorded by recordSwapActivity — the
// destination token and amount, not the input side). A candidate is only
// marked 'quiet' (see recordExternalReceive) if ITS OWN token and amount
// closely match one of those recent outputs — not just "any deposit near
// any swap on this wallet," which used to silently suppress unrelated
// genuine external deposits (from Coinbase, another wallet, a faucet,
// etc.) that happened to land within the same wallet's 20s window as an
// unrelated swap. Recording them normally but without a notification
// means a genuinely-matching concurrent leg is never lost from
// balance/history, just silently un-alerted — a much smaller cost than
// the wrong-label bug this exists to close, and now scoped to cases that
// actually look like the same event.
async function recentSwapOutputsByWallet(supabase: SupabaseClient, walletAddrs: string[]): Promise<Map<string, RecentSwapOutput[]>> {
  const result = new Map<string, RecentSwapOutput[]>()
  if (walletAddrs.length === 0) return result
  const uniqueAddrs = [...new Set(walletAddrs.map(a => a.toLowerCase()))]
  const since = new Date(Date.now() - SWAP_GRACE_SECONDS * 1000).toISOString()
  const { data, error } = await supabase
    .from('activity')
    .select('wallet_address, metadata')
    .eq('activity_type', 'swap')
    .gte('created_at', since)
    .in('wallet_address', uniqueAddrs)
  if (error) { console.error('[deposit-scan-all] recentSwapOutputsByWallet failed:', error.message); return result }
  for (const r of data ?? []) {
    const wallet = (r.wallet_address as string).toLowerCase()
    const meta = r.metadata as any
    const outToken = meta?.tokenOut
    const outAmount = parseFloat(meta?.amountOut)
    if (!outToken || !Number.isFinite(outAmount)) continue
    if (!result.has(wallet)) result.set(wallet, [])
    result.get(wallet)!.push({ token: outToken, amount: outAmount })
  }
  return result
}

// 1% relative tolerance (with a small absolute floor for tiny amounts) —
// the swap's recorded amountOut and the chain-scanned transfer amount
// should match almost exactly since they're the same on-chain event; this
// is slack for floating-point/decimal rounding, not a loose fuzzy match
// meant to catch unrelated transfers.
function matchesRecentSwapOutput(outputs: RecentSwapOutput[] | undefined, token: string, amount: number): boolean {
  if (!outputs) return false
  return outputs.some(o => o.token === token && Math.abs(o.amount - amount) <= Math.max(0.01, amount * 0.01))
}

async function loadWalletSet(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data: users, error } = await supabase
    .from('users')
    .select('wallet_address')
    .not('wallet_address', 'is', null)
  if (error) throw new Error(`users fetch failed: ${error.message}`)
  const walletSet = new Map<string, string>()
  for (const u of users ?? []) {
    const addr = (u as any).wallet_address as string | null
    if (addr) walletSet.set(addr.toLowerCase(), addr)
  }
  return walletSet
}

// Batched "already recorded?" lookup — one query instead of one per hit.
//
// Checks BOTH the `recv_`-prefixed key (this function's own dedupe key) AND
// the plain, unprefixed tx_hash — because a swap's output-token leg (e.g.
// the EURC a swap sends back to this wallet) shares its exact on-chain tx
// hash with that swap's own 'swap' activity row, which is saved under the
// plain hash with no prefix. Checking only the `recv_` form missed that
// case entirely: this sweep would record the router's Transfer as a brand
// new "external deposit," firing a spurious extra "Payment Received"
// notification alongside the correct "Swap Complete" one for the same swap.
async function filterAlreadyRecorded(
  supabase: SupabaseClient,
  candidates: Array<{ txHash: string; toAddr: string }>,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()
  const recvHashes = candidates.map(c => `recv_${c.txHash}`)
  const plainHashes = candidates.map(c => c.txHash)
  const { data: existingRows, error } = await supabase
    .from('activity')
    .select('tx_hash, wallet_address')
    .in('tx_hash', [...recvHashes, ...plainHashes])
  if (error) { console.error('[deposit-scan-all] existing-lookup failed:', error.message); return new Set() }
  const result = new Set<string>()
  for (const r of existingRows ?? []) {
    const wallet = (r.wallet_address as string).toLowerCase()
    // Normalize both forms to the `recv_`-keyed lookup key callers use below,
    // so a plain-hash match (from a swap) blocks the recv_ candidate too.
    const hash = (r.tx_hash as string).startsWith('recv_') ? r.tx_hash : `recv_${r.tx_hash}`
    result.add(`${hash}:${wallet}`)
  }
  return result
}

// ── SWEEP — the fast path, run every ~8s inside the loop below ─────────────
async function runSweepPass(supabase: SupabaseClient): Promise<{ native: number; tokens: number }> {
  // ── FIX (2026-07-16 latency bug #2) ─────────────────────────────────────
  // These two calls used to sit outside any try/catch, and the `while` loop
  // in Deno.serve that calls runSweepPass() has no per-iteration guard
  // either. A single transient failure here (all 3 Arc RPCs missing the
  // 10s timeout on the same tick, or one PostgREST blip loading the wallet
  // list) threw all the way out to the outer handler, which aborted the
  // ENTIRE 50s sweep invocation immediately — every remaining ~8s pass for
  // that minute silently never ran, with nothing logged to show it
  // happened. Detection then depended on the next cron tick (up to 60s
  // later), and if THAT invocation's first pass hit the same condition
  // again, the misses compounded into multi-minute gaps — exactly the
  // "eventually shows up, just late" pattern reported, with the 10-minute
  // reconcile job sometimes appearing to be what actually caught it.
  // Fix: contain failures at the pass level, same as every other RPC call
  // in this file already does, so one bad tick costs ~8s, not ~60s+.
  let walletSet: Map<string, string>
  let currentBlock: number
  try {
    walletSet = await loadWalletSet(supabase)
  } catch (e) {
    console.error('[deposit-scan-all] loadWalletSet failed, skipping this pass:', e instanceof Error ? e.message : e)
    logEvent('pass_aborted', { reason: 'loadWalletSet_failed', error: e instanceof Error ? e.message : String(e) })
    return { native: 0, tokens: 0 }
  }
  if (walletSet.size === 0) return { native: 0, tokens: 0 }

  try {
    currentBlock = await getCurrentArcBlockNumber()
  } catch (e) {
    console.error('[deposit-scan-all] getCurrentArcBlockNumber failed, skipping this pass:', e instanceof Error ? e.message : e)
    logEvent('pass_aborted', { reason: 'getCurrentArcBlockNumber_failed', error: e instanceof Error ? e.message : String(e) })
    return { native: 0, tokens: 0 }
  }
  logEvent('pass_start', { latestBlock: currentBlock, wallets: walletSet.size })

  let nativeRecorded = 0
  let tokenRecorded = 0

  // ── Native USDC — direct RPC block scan, cursor-windowed ──────────────────
  try {
    const cursorFallback = Math.max(0, currentBlock - INIT_LOOKBACK_BLOCKS)
    const cursorBefore = await getCursor(supabase, 'native_blocks', cursorFallback)
    const fromBlock = cursorBefore + 1
    logEvent('native_cursor_read', { source: 'native_blocks', cursorBefore, latestBlock: currentBlock, fromBlock })
    if (fromBlock <= currentBlock) {
      const toBlock = Math.min(currentBlock, fromBlock + MAX_NATIVE_BLOCKS_PER_PASS - 1)
      const { candidates, safeUpTo } = await fetchNativeDepositsRange(fromBlock, toBlock, walletSet)
      logEvent('native_scanned', { fromBlock, toBlock, blocksScanned: toBlock - fromBlock + 1, candidates: candidates.length, safeUpTo })

      if (candidates.length > 0) {
        const existingSet = await filterAlreadyRecorded(supabase, candidates.map(c => ({ txHash: c.txHash, toAddr: c.toAddr })))
        const recentSwaps = await recentSwapOutputsByWallet(supabase, candidates.map(c => c.toAddr))
        for (const c of candidates) {
          const key = `recv_${c.txHash}:${c.toAddr.toLowerCase()}`
          if (existingSet.has(key)) continue
          if (isFromKnownInternalContract(c.fromAddr)) {
            logEvent('native_candidate_skipped_internal_contract', { txHash: c.txHash, wallet: c.toAddr, fromAddr: c.fromAddr })
            continue
          }
          const quiet = matchesRecentSwapOutput(recentSwaps.get(c.toAddr.toLowerCase()), 'USDC', c.amount)
          await recordExternalReceive(supabase, c.toAddr, c.txHash, c.amount, c.fromAddr, 'USDC', false, quiet)
          nativeRecorded++
          logEvent('native_activity_inserted', { txHash: c.txHash, wallet: c.toAddr, amount: c.amount, quiet })
        }
      }
      if (safeUpTo >= fromBlock - 1) {
        await setCursor(supabase, 'native_blocks', safeUpTo)
        logEvent('native_cursor_advanced', { source: 'native_blocks', cursorBefore, cursorAfter: safeUpTo })
      } else {
        logEvent('native_cursor_stalled', { source: 'native_blocks', cursorBefore, attemptedFromBlock: fromBlock, reason: 'safeUpTo behind fromBlock (a block/chunk failed on every RPC)' })
      }
    }
  } catch (e) {
    console.error('[deposit-scan-all] native block scan failed:', e instanceof Error ? e.message : e)
    logEvent('native_scan_failed', { error: e instanceof Error ? e.message : String(e) })
  }

  // ── FIX D — native USDC via 0xffff…fffe Transfer logs ─────────────────────
  // EMIT DEDUP — a wrapper transaction must produce exactly ONE receive row,
  // and there are four sources that could each produce one. All four converge
  // on the same key, so all four are covered by one mechanism:
  //
  //   1. this log scan            -> upsert key recv_<hash>
  //   2. the native block scan    -> upsert key recv_<hash>   (same hash)
  //   3. the reconcile backstop   -> upsert key recv_<hash>   (same hash)
  //   4. a swap's own 'swap' row  -> plain <hash>, normalized to recv_<hash>
  //                                  by filterAlreadyRecorded
  //
  // The durable guarantee is the activity table itself: recordExternalReceive
  // upserts on (tx_hash, wallet_address) with ignoreDuplicates, and every
  // source derives tx_hash from the SAME on-chain hash. So even two sources
  // racing inside one pass converge on one row — the DB constraint is the
  // arbiter, not scan ordering. filterAlreadyRecorded is the cheap pre-check
  // that avoids the redundant write and the duplicate notification; it already
  // normalizes plain hashes to the recv_ form, which is what keeps a swap's
  // output leg from also being recorded as a deposit.
  //
  // A separate cursor ('native_usdc_logs') is required, not a shared one: this
  // source scans MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS (3k) per pass against the
  // chain's busiest contract, on its own failure profile. Sharing a cursor with
  // another source would let one drag it past blocks the other never examined,
  // reintroducing exactly the silent-gap class of bug the per-source cursors
  // exist to prevent.
  try {
    const cursorFallback = Math.max(0, currentBlock - INIT_LOOKBACK_BLOCKS)
    const cursorBefore = await getCursor(supabase, 'native_usdc_logs', cursorFallback)
    const fromBlock = cursorBefore + 1
    logEvent('native_usdc_log_cursor_read', { source: 'native_usdc_logs', cursorBefore, latestBlock: currentBlock, fromBlock })
    if (fromBlock <= currentBlock) {
      const toBlock = Math.min(currentBlock, fromBlock + MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS - 1)
      const { candidates, safeUpTo } = await fetchNativeUsdcLogDeposits(fromBlock, toBlock, walletSet)
      logEvent('native_usdc_log_scanned', { fromBlock, toBlock, blocksScanned: toBlock - fromBlock + 1, candidates: candidates.length, safeUpTo })

      if (candidates.length > 0) {
        const existingSet = await filterAlreadyRecorded(supabase, candidates.map(c => ({ txHash: c.txHash, toAddr: c.toAddr })))
        const recentSwaps = await recentSwapOutputsByWallet(supabase, candidates.map(c => c.toAddr))
        for (const c of candidates) {
          const key = `recv_${c.txHash}:${c.toAddr.toLowerCase()}`
          if (existingSet.has(key)) continue
          if (isFromKnownInternalContract(c.fromAddr)) {
            logEvent('native_usdc_log_candidate_skipped_internal_contract', { txHash: c.txHash, wallet: c.toAddr, fromAddr: c.fromAddr })
            continue
          }
          const quiet = matchesRecentSwapOutput(recentSwaps.get(c.toAddr.toLowerCase()), 'USDC', c.amount)
          await recordExternalReceive(supabase, c.toAddr, c.txHash, c.amount, c.fromAddr, 'USDC', false, quiet)
          nativeRecorded++
          logEvent('native_usdc_log_activity_inserted', { txHash: c.txHash, wallet: c.toAddr, amount: c.amount, quiet })
        }
      }
      // STRICT `> cursorBefore`, not `>= fromBlock - 1`. When the FIRST chunk
      // fails, fetchTransferLogsRange returns safeUpTo = firstFailedFrom - 1 =
      // fromBlock - 1 = cursorBefore — i.e. "nothing was scanned". The old
      // `>= fromBlock - 1` test accepted that as progress and rewrote the
      // cursor to the value it already held, so the source re-attempted the
      // same failing chunk forever and never surfaced as stalled (its
      // updated_at kept refreshing, which is exactly what made the live
      // deployment look healthy while detecting nothing).
      //
      // The strict form has both required properties: a failed first chunk
      // leaves the cursor untouched and logs a stall, and the cursor can only
      // ever move to a block that was actually scanned successfully — safeUpTo
      // is firstFailedFrom - 1, so a mid-range failure still advances over the
      // verified prefix and re-attempts the rest next pass, never skipping it.
      if (safeUpTo > cursorBefore) {
        await setCursor(supabase, 'native_usdc_logs', safeUpTo)
        logEvent('native_usdc_log_cursor_advanced', { source: 'native_usdc_logs', cursorBefore, cursorAfter: safeUpTo, blocksAdvanced: safeUpTo - cursorBefore })
      } else {
        logEvent('native_usdc_log_cursor_stalled', {
          source: 'native_usdc_logs', cursorBefore, attemptedFromBlock: fromBlock, attemptedToBlock: toBlock, safeUpTo,
          reason: 'first chunk failed on every RPC — cursor left unchanged, no blocks were scanned successfully',
        })
      }
    }
  } catch (e) {
    console.error('[deposit-scan-all] native USDC log scan failed:', e instanceof Error ? e.message : e)
    logEvent('native_usdc_log_scan_failed', { error: e instanceof Error ? e.message : String(e) })
  }

  // ── EURC / cirBTC — real ERC-20s, cursor-windowed log scan ────────────────
  for (const token of TOKENS) {
    try {
      const cursorFallback = Math.max(0, currentBlock - INIT_LOOKBACK_BLOCKS)
      const cursorBefore = await getCursor(supabase, `erc20_logs:${token.symbol}`, cursorFallback)
      const fromBlock = cursorBefore + 1
      logEvent('erc20_cursor_read', { source: `erc20_logs:${token.symbol}`, cursorBefore, latestBlock: currentBlock, fromBlock })
      if (fromBlock > currentBlock) continue
      const toBlock = Math.min(currentBlock, fromBlock + MAX_LOG_BLOCKS_PER_PASS - 1)

      const { logs, safeUpTo } = await fetchTransferLogsRange(token.contract, fromBlock, toBlock)
      logEvent('erc20_scanned', { symbol: token.symbol, fromBlock, toBlock, rawLogs: logs.length, safeUpTo })

      const candidates = logs
        .map(log => {
          const txHash    = (log.transactionHash as string).toLowerCase()
          const fromTopic = (log.topics?.[1] as string) || ''
          const toTopic   = (log.topics?.[2] as string) || ''
          const toAddr    = '0x' + toTopic.slice(-40)
          const fromAddr  = '0x' + fromTopic.slice(-40)
          let amount: number
          try { amount = Number(BigInt(log.data)) / (10 ** token.decimals) } catch { return null }
          if (!Number.isFinite(amount) || amount <= 0) return null
          if (fromTopic.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()) return null // mint — claim-recovery-scan's job
          if (!walletSet.has(toAddr.toLowerCase())) return null // not one of ours
          if (toAddr.toLowerCase() === fromAddr.toLowerCase()) return null // self-transfer
          return { txHash, toAddr: walletSet.get(toAddr.toLowerCase())!, fromAddr, amount }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)

      logEvent('erc20_candidates_matched', { symbol: token.symbol, candidates: candidates.length })
      if (candidates.length > 0) {
        const existingSet = await filterAlreadyRecorded(supabase, candidates.map(c => ({ txHash: c.txHash, toAddr: c.toAddr })))
        const recentSwaps = await recentSwapOutputsByWallet(supabase, candidates.map(c => c.toAddr))
        for (const c of candidates) {
          const key = `recv_${c.txHash}:${c.toAddr.toLowerCase()}`
          if (existingSet.has(key)) continue
          if (isFromKnownInternalContract(c.fromAddr)) {
            logEvent('erc20_candidate_skipped_internal_contract', { symbol: token.symbol, txHash: c.txHash, wallet: c.toAddr, fromAddr: c.fromAddr })
            continue
          }
          const quiet = matchesRecentSwapOutput(recentSwaps.get(c.toAddr.toLowerCase()), token.symbol, c.amount)
          await recordExternalReceive(supabase, c.toAddr, c.txHash, c.amount, c.fromAddr, token.symbol, false, quiet)
          tokenRecorded++
          logEvent('erc20_activity_inserted', { symbol: token.symbol, txHash: c.txHash, wallet: c.toAddr, amount: c.amount, quiet })
        }
      }
      if (safeUpTo >= fromBlock - 1) {
        await setCursor(supabase, `erc20_logs:${token.symbol}`, safeUpTo)
        logEvent('erc20_cursor_advanced', { source: `erc20_logs:${token.symbol}`, cursorBefore, cursorAfter: safeUpTo })
      } else {
        logEvent('erc20_cursor_stalled', { source: `erc20_logs:${token.symbol}`, cursorBefore, attemptedFromBlock: fromBlock, reason: 'a chunk failed on every RPC' })
      }
    } catch (e) {
      console.error(`[deposit-scan-all] log scan failed for ${token.symbol}:`, e instanceof Error ? e.message : e)
      logEvent('erc20_scan_failed', { symbol: token.symbol, error: e instanceof Error ? e.message : String(e) })
    }
  }

  logEvent('pass_end', { nativeRecorded, tokenRecorded })
  return { native: nativeRecorded, tokens: tokenRecorded }
}

// ── RECONCILE — infrequent backstop pass, Blockscout for native only ───────
async function runReconcilePass(supabase: SupabaseClient): Promise<{ recorded: string[] }> {
  const walletSet = await loadWalletSet(supabase)
  const recorded: string[] = []
  if (walletSet.size === 0) return { recorded }

  // FIX D — reconcile also recovers wrapper-routed USDC, which the native
  // explorer query is blind to. Same key, same upsert, same dedup.
  try {
    const currentBlock = await getCurrentArcBlockNumber()
    const cursorFallback = Math.max(0, currentBlock - INIT_LOOKBACK_BLOCKS)
    const cursorBefore = await getCursor(supabase, 'native_usdc_logs', cursorFallback)
    const fromBlock = cursorBefore + 1
    if (fromBlock <= currentBlock) {
      const toBlock = Math.min(currentBlock, fromBlock + MAX_NATIVE_USDC_LOG_BLOCKS_PER_PASS - 1)
      const { candidates, safeUpTo } = await fetchNativeUsdcLogDeposits(fromBlock, toBlock, walletSet)
      logEvent('reconcile_native_usdc_log_scanned', { fromBlock, toBlock, candidates: candidates.length, safeUpTo })
      if (candidates.length > 0) {
        const existingSet = await filterAlreadyRecorded(supabase, candidates.map(c => ({ txHash: c.txHash, toAddr: c.toAddr })))
        const recentSwaps = await recentSwapOutputsByWallet(supabase, candidates.map(c => c.toAddr))
        for (const c of candidates) {
          const key = `recv_${c.txHash}:${c.toAddr.toLowerCase()}`
          if (existingSet.has(key)) continue
          if (isFromKnownInternalContract(c.fromAddr)) continue
          await recordExternalReceive(supabase, c.toAddr, c.txHash, c.amount, c.fromAddr, 'USDC', true, matchesRecentSwapOutput(recentSwaps.get(c.toAddr.toLowerCase()), 'USDC', c.amount))
          recorded.push(c.txHash)
        }
      }
      // Same strict boundary as the sweep pass — see the note there. Without
      // it, reconcile would keep re-writing the cursor to its current value
      // and mask the stall from this side too.
      if (safeUpTo > cursorBefore) {
        await setCursor(supabase, 'native_usdc_logs', safeUpTo)
        logEvent('reconcile_native_usdc_log_cursor_advanced', { source: 'native_usdc_logs', cursorBefore, cursorAfter: safeUpTo })
      }
    }
  } catch (e) {
    console.error('[deposit-scan-all] reconcile: native USDC log scan failed:', e instanceof Error ? e.message : e)
    logEvent('reconcile_native_usdc_log_scan_failed', { error: e instanceof Error ? e.message : String(e) })
  }

  const NATIVE_CONCURRENCY = 8
  const walletList = [...walletSet.values()]
  for (let i = 0; i < walletList.length; i += NATIVE_CONCURRENCY) {
    const batch = walletList.slice(i, i + NATIVE_CONCURRENCY)
    const results = await Promise.allSettled(batch.map(async (wallet) => {
      const deposits = await fetchNativeDepositsViaExplorer(wallet)
      if (deposits.length === 0) return
      const existingSet = await filterAlreadyRecorded(supabase, deposits.map(d => ({ txHash: d.txHash, toAddr: wallet })))
      const recentSwaps = await recentSwapOutputsByWallet(supabase, [wallet])
      const swapOutputs = recentSwaps.get(wallet.toLowerCase())
      for (const d of deposits) {
        const key = `recv_${d.txHash}:${wallet.toLowerCase()}`
        if (existingSet.has(key)) continue
        if (isFromKnownInternalContract(d.fromAddr)) {
          logEvent('reconcile_candidate_skipped_internal_contract', { txHash: d.txHash, wallet, fromAddr: d.fromAddr })
          continue
        }
        await recordExternalReceive(supabase, wallet, d.txHash, d.amount, d.fromAddr, 'USDC', true, matchesRecentSwapOutput(swapOutputs, 'USDC', d.amount))
        recorded.push(d.txHash)
      }
    }))
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[deposit-scan-all] reconcile: native scan failed for a wallet:', r.reason instanceof Error ? r.reason.message : r.reason)
      }
    }
  }

  return { recorded }
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  let body: any = {}
  try { body = await req.json() } catch { /* sweep/reconcile may send no body */ }
  const mode = body?.mode === 'reconcile' ? 'reconcile' : 'sweep'

  try {
    if (mode === 'reconcile') {
      const { recorded } = await runReconcilePass(supabase)
      return json({ success: true, mode, recorded })
    }

    // 'sweep' — self-loop internally, same pattern claim-worker already
    // uses. pg_cron only needs to fire once a minute; this loop is what
    // actually gives ~8s effective detection cadence.
    const start = Date.now()
    let totalNative = 0
    let totalTokens = 0
    let passCount = 0
    let passFailures = 0
    while (Date.now() - start < SWEEP_DURATION_MS) {
      passCount++
      try {
        const { native, tokens } = await runSweepPass(supabase)
        totalNative += native
        totalTokens += tokens
      } catch (e) {
        // FIX: this call used to be unguarded, so any throw here (e.g. an
        // exception from loadWalletSet/getCurrentArcBlockNumber not caught
        // internally) killed the entire 50s invocation immediately, silently
        // dropping every remaining pass. Now it costs one ~8s pass, not the
        // whole minute.
        passFailures++
        console.error('[deposit-scan-all] sweep pass threw, continuing loop:', e instanceof Error ? e.message : e)
        logEvent('pass_threw', { passNumber: passCount, error: e instanceof Error ? e.message : String(e) })
      }
      await new Promise(r => setTimeout(r, SWEEP_INTERVAL_MS))
    }
    logEvent('sweep_invocation_done', { passCount, passFailures, totalNative, totalTokens })
    return json({ success: true, mode, recordedNative: totalNative, recordedTokens: totalTokens, passCount, passFailures })
  } catch (e: any) {
    console.error('[deposit-scan-all] failed:', e?.message ?? e)
    return json({ success: false, error: e?.message ?? 'Deposit scan failed' }, 500)
  }
})
