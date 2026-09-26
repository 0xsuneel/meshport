import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
// Same packages/versions wallet-key.ts already uses for address derivation —
// reused here (not a new dependency) to sign relayer transactions.
import { getPublicKey, signAsync as secpSignAsync } from 'npm:@noble/secp256k1@2.1.0'
import { keccak_256 } from 'npm:@noble/hashes@1.4.0/sha3'
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
const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
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
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
  'https://rpc.testnet.arc.network',
]
const CIRCLE_IRIS_API = 'https://iris-api-sandbox.circle.com'
const ARC_MESSAGE_TRANSMITTER =
  Deno.env.get('ARC_MESSAGE_TRANSMITTER_ADDRESS') ?? ''
const MESSAGE_RECEIVED_TOPIC0_V1 =
  '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d'
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
    const version = parseInt(hex.slice(0, 4 * 2), 16)
    const sourceDomain = parseInt(hex.slice(4 * 2, 8 * 2), 16)
    const nonceBytes = version === 1 ? 32 : 8
    if (hex.length < (12 + nonceBytes) * 2) return null
    const nonce = BigInt('0x' + hex.slice(12 * 2, (12 + nonceBytes) * 2))
    return { nonce, sourceDomain }
  } catch {
    return null
  }
}
type CctpReceiveLog = { transactionHash: string; blockNumber: number; amount: number | null }
type MintTransferLog = { transactionHash: string; blockNumber: number; amount?: number }
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
const NATIVE_USDC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
async function fetchMintAmountForTx(transactionHash: string): Promise<number | null> {
  try {
    const receipt = await rpcCall(ARC_RPCS, 'eth_getTransactionReceipt', [transactionHash])
    const logs = receipt?.logs ?? []
    const nativeLog = logs.find((l: any) =>
      (l.address as string)?.toLowerCase() === NATIVE_USDC_EMITTER.toLowerCase() &&
      (l.topics?.[0] as string)?.toLowerCase() === TRANSFER_TOPIC0.toLowerCase() &&
      (l.topics?.[1] as string)?.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()
    )
    if (nativeLog) return Number(BigInt(nativeLog.data)) / 1e18
    const wrapperLog = logs.find((l: any) =>
      (l.address as string)?.toLowerCase() === ARC_USDC_CONTRACT.toLowerCase() &&
      (l.topics?.[0] as string)?.toLowerCase() === TRANSFER_TOPIC0.toLowerCase() &&
      (l.topics?.[1] as string)?.toLowerCase() === MINT_FROM_TOPIC.toLowerCase()
    )
    return wrapperLog ? Number(BigInt(wrapperLog.data)) / 1e6 : null
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
  const amount = await fetchMintAmountForTx(transactionHash)
  return { transactionHash, blockNumber, amount }
}
const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)
const MINT_AND_WITHDRAW_TOPIC0 = '0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e6'
const ARC_TOKEN_MESSENGER_V2 = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'
async function findMintAndWithdrawLog(recipient: string, amountUsdc: number): Promise<MintTransferLog | null> {
  const recipientTopic = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const filter = { address: ARC_TOKEN_MESSENGER_V2, topics: [MINT_AND_WITHDRAW_TOPIC0, recipientTopic] }
  let logs: any[]
  try {
    logs = await fetchLogsBounded(filter)
  } catch (e) {
    console.error('[claim-worker] MintAndWithdraw scan failed (non-fatal — falling back to Transfer-based detection):', e instanceof Error ? e.message : e)
    return null
  }
  if (logs.length === 0) return null
  const feeFloor = amountUsdc * 0.70
  const roundingSlack = amountUsdc * 0.001
  let best: { log: any; amount: number } | null = null
  for (const log of logs) {
    const mintToken = ((log.topics?.[2] as string) || '').toLowerCase()
    const isNative = mintToken.endsWith(NATIVE_USDC_EMITTER.toLowerCase().slice(-40))
    const decimals = isNative ? 18 : 6
    let amount: number
    try { amount = Number(BigInt(log.data)) / (10 ** decimals) } catch { continue }
    if (amount < feeFloor || amount > amountUsdc + roundingSlack) continue
    if (!best || amount > best.amount) best = { log, amount }
  }
  if (!best) return null
  return {
    transactionHash: best.log.transactionHash,
    blockNumber: Number(BigInt(best.log.blockNumber)),
    amount: best.amount,
  }
}
// ── 2026-09-20 active relay submission ───────────────────────────────────
// Previously claim-worker only ever PASSIVELY scanned for a mint that
// Circle's own automatic relayer would eventually submit — meaning
// completion depended entirely on Circle's relayer timing and on this
// worker's own RPC scan finding the result afterward. This section adds
// the ability to submit receiveMessage() ourselves, via a dedicated
// relayer wallet (RELAYER_PRIVATE_KEY, gas-funded, holds no user funds),
// the instant a claim's attestation is ready — so completion no longer
// depends on any other party's relay timing.
//
// This is purely additive: the existing passive detection above (nonce
// match, MintAndWithdraw, amount fallback) is completely unchanged and
// remains the actual source of truth for completion. It will find the
// mint whether OUR relay submission succeeded or someone else's did.
// relay_tx_hash/relay_error on the claim row are diagnostics only.
const RELAYER_PRIVATE_KEY = (Deno.env.get('RELAYER_PRIVATE_KEY') ?? '').trim()
// Arc Testnet chainId, per Arc's own docs (EIP-712 domain reference) —
// not derived from an RPC call since it never changes for a given network.
const ARC_CHAIN_ID = 5042002n

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const padded = clean.length % 2 ? '0' + clean : clean
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHexStr(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrs) { out.set(a, offset); offset += a.length }
  return out
}
function bigIntToMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0)
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  return hexToBytes(hex)
}

// ── Minimal RLP encoder — just enough for a legacy (type-0) EIP-155 tx ───
function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset])
  let hex = len.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const lenBytes = hexToBytes(hex)
  return concatBytes(new Uint8Array([offset + 55 + lenBytes.length]), lenBytes)
}
function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input
    return concatBytes(rlpEncodeLength(input.length, 0x80), input)
  }
  const items = input.map(rlpEncode)
  const body = concatBytes(...items)
  return concatBytes(rlpEncodeLength(body.length, 0xc0), body)
}

// ── ABI encoding for receiveMessage(bytes message, bytes attestation) ────
// Selector verified independently: keccak256("receiveMessage(bytes,bytes)")
// = 0x57ecfd28... — computed at load time below rather than hardcoded, so
// a typo here would be self-evident (wrong selector = every call reverts
// immediately, never a silent wrong-behavior bug).
const RECEIVE_MESSAGE_SELECTOR = keccak_256(new TextEncoder().encode('receiveMessage(bytes,bytes)')).slice(0, 4)
function uint256BE(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}
function pad32(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % 32
  if (rem === 0) return bytes
  return concatBytes(bytes, new Uint8Array(32 - rem))
}
function encodeReceiveMessageCalldata(message: Uint8Array, attestation: Uint8Array): Uint8Array {
  const offsetA = uint256BE(64n) // after two 32-byte head words
  const lenA    = uint256BE(BigInt(message.length))
  const dataA   = pad32(message)
  const offsetB = uint256BE(64n + 32n + BigInt(dataA.length))
  const lenB    = uint256BE(BigInt(attestation.length))
  const dataB   = pad32(attestation)
  return concatBytes(RECEIVE_MESSAGE_SELECTOR, offsetA, offsetB, lenA, dataA, lenB, dataB)
}

// ── Address derivation — identical approach to wallet-key.ts, so this is a
// proven, already-audited code path, not new crypto logic.
function deriveAddressFromPrivateKey(privBytes: Uint8Array): string {
  const pubKey = getPublicKey(privBytes, false)
  const pubKeyNoPrefix = pubKey.slice(1)
  const hash = keccak_256(pubKeyNoPrefix)
  return '0x' + bytesToHexStr(hash.slice(-20))
}

let relayerPrivateKeyBytes: Uint8Array | null = null
let relayerAddress: string | null = null
if (RELAYER_PRIVATE_KEY) {
  try {
    relayerPrivateKeyBytes = hexToBytes(RELAYER_PRIVATE_KEY)
    relayerAddress = deriveAddressFromPrivateKey(relayerPrivateKeyBytes)
    console.log(`[claim-worker] relayer configured: ${relayerAddress}`)
  } catch (e) {
    console.error('[claim-worker] RELAYER_PRIVATE_KEY is set but invalid — active relay submission disabled:', e instanceof Error ? e.message : e)
    relayerPrivateKeyBytes = null
    relayerAddress = null
  }
}

// Signs a legacy (type-0), EIP-155-replay-protected transaction and returns
// the raw hex ready for eth_sendRawTransaction.
async function signLegacyTx(params: {
  nonce: bigint; gasPrice: bigint; gasLimit: bigint; to: string; data: Uint8Array
}): Promise<string> {
  if (!relayerPrivateKeyBytes) throw new Error('relayer private key not configured')
  const toBytes = hexToBytes(params.to)
  const unsignedFields: Uint8Array[] = [
    bigIntToMinimalBytes(params.nonce),
    bigIntToMinimalBytes(params.gasPrice),
    bigIntToMinimalBytes(params.gasLimit),
    toBytes,
    new Uint8Array(0), // value: 0
    params.data,
    bigIntToMinimalBytes(ARC_CHAIN_ID),
    new Uint8Array(0),
    new Uint8Array(0),
  ]
  const unsignedRlp = rlpEncode(unsignedFields)
  const msgHash = keccak_256(unsignedRlp)
  const sig = await secpSignAsync(msgHash, relayerPrivateKeyBytes)
  const v = BigInt(sig.recovery) + ARC_CHAIN_ID * 2n + 35n
  const signedFields: Uint8Array[] = [
    bigIntToMinimalBytes(params.nonce),
    bigIntToMinimalBytes(params.gasPrice),
    bigIntToMinimalBytes(params.gasLimit),
    toBytes,
    new Uint8Array(0),
    params.data,
    bigIntToMinimalBytes(v),
    bigIntToMinimalBytes(sig.r),
    bigIntToMinimalBytes(sig.s),
  ]
  return '0x' + bytesToHexStr(rlpEncode(signedFields))
}

// Re-fetches the attestation for an already-verified claim. waitForBridge
// only persisted the message bytes (message_hash), not the attestation
// itself — Circle's IRIS API keeps serving a completed message's
// attestation indefinitely, so re-fetching here avoids a second column
// just to cache something that's already durably available on demand.
async function fetchAttestationForClaim(claim: Claim): Promise<string | null> {
  const domain = CCTP_DOMAINS[claim.source_chain]
  if (domain === undefined) return null
  try {
    const url = `${CIRCLE_IRIS_API}/v2/messages/${domain}?transactionHash=${claim.tx_hash}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json().catch(() => ({}))
    const msg = data?.messages?.[0]
    if (msg?.status === 'complete' && msg?.attestation) return msg.attestation as string
    return null
  } catch (e) {
    console.error(`[claim-worker] fetchAttestationForClaim failed for ${claim.id}:`, e instanceof Error ? e.message : e)
    return null
  }
}

// Attempts to submit receiveMessage() on Arc ourselves, at most once per
// claim (gated by relay_tx_hash/relay_error already being set). Never
// throws out to the caller — any failure here (including "someone already
// relayed this") is recorded as a diagnostic and confirmArrival's existing
// passive detection continues unaffected this same pass and every pass
// after, exactly as it did before this feature existed.
async function attemptRelaySubmission(supabase: SupabaseClient, claim: Claim): Promise<void> {
  if (!relayerPrivateKeyBytes || !relayerAddress) return
  if (!ARC_MESSAGE_TRANSMITTER) return
  if (!claim.message_hash) return
  if (claim.relay_tx_hash || claim.relay_error) return // one attempt per claim — see module comment above

  try {
    const attestation = await fetchAttestationForClaim(claim)
    if (!attestation) {
      // Attestation not (or no longer) fetchable — not an error worth
      // recording permanently; leave both columns null so a later pass
      // can try again once/if it becomes available.
      return
    }
    const messageBytes = hexToBytes(claim.message_hash)
    const attestationBytes = hexToBytes(attestation)
    const data = encodeReceiveMessageCalldata(messageBytes, attestationBytes)

    // Cheap pre-flight: if the call would revert (most commonly because
    // someone else — Circle's own relayer, or an earlier attempt — already
    // delivered this exact message), eth_call fails fast without spending
    // any gas or consuming a nonce. This is the common, expected outcome
    // once Circle's relayer wins the race; it just means our relay wasn't
    // needed, not that anything is wrong.
    try {
      await rpcCall(ARC_RPCS, 'eth_call', [{ from: relayerAddress, to: ARC_MESSAGE_TRANSMITTER, data: '0x' + bytesToHexStr(data) }, 'latest'])
    } catch (e) {
      await persistErrorBestEffort0(supabase, claim.id, 'relay_error', `already-delivered-or-reverts: ${serializeErrorForRpc(e)}`)
      return
    }

    const bootstrapNonceHex = await rpcCall(ARC_RPCS, 'eth_getTransactionCount', [relayerAddress, 'pending'])
    const bootstrapNonce = BigInt(bootstrapNonceHex)
    const { data: nonceRows, error: nonceErr } = await supabase.rpc('get_and_increment_relayer_nonce', {
      p_address: relayerAddress, p_bootstrap_nonce: bootstrapNonce,
    })
    if (nonceErr) {
      console.error(`[claim-worker] relayer nonce allocation failed for claim ${claim.id}:`, nonceErr.message)
      return
    }
    const nonce = BigInt(Array.isArray(nonceRows) ? nonceRows[0] : nonceRows)

    const gasPriceHex = await rpcCall(ARC_RPCS, 'eth_gasPrice', [])
    const gasPrice = BigInt(gasPriceHex)
    let gasLimit = 500_000n // generous fallback if estimateGas is unsupported/fails
    try {
      const estHex = await rpcCall(ARC_RPCS, 'eth_estimateGas', [{ from: relayerAddress, to: ARC_MESSAGE_TRANSMITTER, data: '0x' + bytesToHexStr(data) }])
      gasLimit = (BigInt(estHex) * 130n) / 100n // 30% buffer
    } catch { /* keep fallback */ }

    const rawTx = await signLegacyTx({ nonce, gasPrice, gasLimit, to: ARC_MESSAGE_TRANSMITTER, data })
    const txHash = await rpcCall(ARC_RPCS, 'eth_sendRawTransaction', [rawTx])

    await updateClaim(supabase, claim.id, {
      relay_tx_hash: txHash, relay_submitted_at: new Date().toISOString(),
    })
    console.log(`[claim-worker] relay submitted for claim ${claim.id}: ${txHash} (nonce ${nonce})`)
  } catch (e) {
    console.error(`[claim-worker] attemptRelaySubmission failed for claim ${claim.id}:`, e instanceof Error ? e.message : e)
    await persistErrorBestEffort0(supabase, claim.id, 'relay_error', `relay-submission-failed: ${serializeErrorForRpc(e)}`)
  }
}
// Small helper so attemptRelaySubmission's error path doesn't fight with
// the existing persistErrorBestEffort's `error` column (that one is
// reserved for the passive-detection diagnostic message) — writes to the
// dedicated relay_error column instead, best-effort, never throws.
async function persistErrorBestEffort0(supabase: SupabaseClient, claimId: string, column: 'relay_error', message: string) {
  try {
    await supabase.from('claims').update({ [column]: message.slice(0, 250) }).eq('id', claimId)
  } catch (e) {
    console.error(`[claim-worker] persistErrorBestEffort0 threw for ${claimId}:`, e)
  }
}

type MintLookupResult = {
  matches: MintTransferLog[]   // all valid candidates within the fee-tolerance band, best (closest to claimed amount) first
  candidateCount: number       // how many Transfer logs to this recipient existed in range, before amount filtering
  candidateAmounts: string[]   // their raw values (human USDC), for diagnosing amount-mismatch vs range/topic issues
}
async function findIncomingMintByAmount(recipient: string, amountUsdc: number): Promise<MintLookupResult> {
  const recipientTopic = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const KIT_FORWARD_SOURCES = new Set([
    MINT_FROM_TOPIC,
    '0x000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d',
    '0x000000000000000000000000bbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
  ])
  const nativeFilter  = { address: NATIVE_USDC_EMITTER, topics: [TRANSFER_TOPIC0, null, recipientTopic] }
  const wrapperFilter = { address: ARC_USDC_CONTRACT,   topics: [TRANSFER_TOPIC0, null, recipientTopic] }
  const [nativeLogsRaw, wrapperLogsRaw] = await Promise.all([
    fetchLogsBounded(nativeFilter).catch(e => {
      console.error('[claim-worker] native-emitter mint scan failed (non-fatal — wrapper-contract scan below still applies):', e instanceof Error ? e.message : e)
      return [] as any[]
    }),
    fetchLogsBounded(wrapperFilter).catch(e => {
      console.error('[claim-worker] wrapper-contract mint scan failed (non-fatal — native-emitter scan above still applies):', e instanceof Error ? e.message : e)
      return [] as any[]
    }),
  ])
  const isAcceptedSource = (log: any) => KIT_FORWARD_SOURCES.has(((log.topics?.[1] as string) || '').toLowerCase())
  const nativeLogs = nativeLogsRaw.filter(isAcceptedSource)
  const wrapperLogs = wrapperLogsRaw.filter(isAcceptedSource)
  const taggedLogs = [
    ...nativeLogs.map(log => ({ log, decimals: 18, source: 'native' as const })),
    ...wrapperLogs.map(log => ({ log, decimals: 6, source: 'wrapper' as const })),
  ]
  if (taggedLogs.length === 0) return { matches: [], candidateCount: 0, candidateAmounts: [] }
  const feeFloor = amountUsdc * 0.70
  const roundingSlack = amountUsdc * 0.001
  const candidateAmounts: string[] = []
  const qualifying: Array<{ log: any; amount: number }> = []
  for (const { log, decimals } of taggedLogs) {
    try {
      const amount = Number(BigInt(log.data)) / (10 ** decimals)
      candidateAmounts.push(amount.toString())
      if (amount >= feeFloor && amount <= amountUsdc + roundingSlack) {
        qualifying.push({ log, amount })
      }
    } catch { /* skip unparseable log */ }
  }
  qualifying.sort((a, b) => b.amount - a.amount)
  return {
    matches: qualifying.map(q => ({
      transactionHash: q.log.transactionHash,
      blockNumber: Number(BigInt(q.log.blockNumber)),
      amount: q.amount,
    })),
    candidateCount: taggedLogs.length,
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
const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') || 'https://meshport.xyz').trim()
const PUSH_INTERNAL_SECRET = (Deno.env.get('PUSH_INTERNAL_SECRET') || '').trim()
const MAX_ATTEMPTS        = 90
const SWEEP_DURATION_MS   = 50_000
const SWEEP_INTERVAL_MS   = 8_000
const STALE_LOCK_MS       = 6_000
const FETCH_PAGE_SIZE     = 200
const STUCK_THRESHOLD_MIN = 10
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
  relay_tx_hash?: string | null
  relay_error?: string | null
}
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
      settlement_duration_ms:  created   ? now - created   : null,
      bridge_duration_ms:      created && bridging  ? bridging  - created   : null,
      attestation_duration_ms: bridging && verifying ? verifying - bridging  : null,
      relay_duration_ms:       verifying && settling ? settling  - verifying : null,
      finality_duration_ms:    settling  ? now - settling : null,
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
// ── 2026-09-20 duplicate-mint-collision fix ─────────────────────────────────
// Root cause (confirmed live via prod logs + DB): two claims for the SAME
// wallet_address + SAME amount, submitted close together from different
// source chains, can both match the SAME destination mint via the
// amount-fuzzy fallbacks (findMintAndWithdrawLog / findIncomingMintByAmount)
// — those matchers have no per-claim identity stronger than wallet+amount.
// The pre-write "already used?" SELECT is a soft check with a real race
// window: two concurrent claim-worker invocations (single-mode webhook +
// sweep, or two overlapping sweeps) can both pass the SELECT before either
// commits, then both attempt the UPDATE — one wins, the other hits Postgres
// unique constraint `claims_destination_tx_hash_unique` (code 23505).
// Previously that error just fell into the outer catch, which persists a
// generic diagnostic and returns — next sweep pass re-finds the SAME
// already-claimed tx via the SAME amount-fuzzy match and repeats the same
// failing write forever. The claim then sits in 'settling' until
// SETTLING_TIMEOUT_MS falsely marks it 'failed', even though its OWN mint
// may have already landed on-chain separately.
// Fix: detect this specific constraint by name/code and treat it as
// "this candidate belongs to a different claim" rather than a fatal error —
// callers now fall through to the next detection method / next candidate
// instead of retrying the identical doomed write.
function isDuplicateDestinationTxError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (!err) return false
  if (err.code === '23505') return true
  return typeof err.message === 'string' && err.message.includes('claims_destination_tx_hash_unique')
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
    if (isDuplicateDestinationTxError(error)) {
      // Not a fatal worker error — a different claim already owns this
      // destination_tx_hash. Let the caller decide how to move on (next
      // candidate / next detection method) instead of persisting a scary
      // diagnostic and throwing.
      throw error
    }
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
      await persistErrorBestEffort(
        supabase, claim.id,
        `waiting-on-attestation: http=${res.status}, messages=${data?.messages?.length ?? 0}, msgStatus=${msg?.status ?? 'none'}`
      )
    }
  } catch (e) {
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

    // Actively submit receiveMessage() ourselves, at most once per claim,
    // before falling into passive detection below. If the relayer isn't
    // configured, or this claim already has a relay_tx_hash/relay_error
    // from a prior pass, this is a no-op and behavior is identical to
    // before this feature existed — passive detection is unaffected either
    // way and remains the actual source of truth for completion.
    await attemptRelaySubmission(supabase, claim)

    // Nonce-based match FIRST — decoded straight from this claim's own CCTP
    // message, so it's collision-proof by construction (unlike the
    // amount-fuzzy matchers below, which only know wallet+amount and can
    // pick up a DIFFERENT claim's already-consumed mint when two claims for
    // the same wallet+amount are in flight together — see the 2026-09-20
    // fix note above updateClaim for the full root-cause writeup).
    if (claim.message_hash) {
      const decoded = decodeCctpMessageNonce(claim.message_hash)
      if (decoded && ARC_MESSAGE_TRANSMITTER) {
        const log = await findCctpReceiveLog(decoded.nonce)
        if (log) {
          try {
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
          } catch (e) {
            if (!isDuplicateDestinationTxError(e)) throw e
            // Own nonce matched a tx some other claim already owns — should
            // be effectively impossible (nonce is unique per message), but
            // fall through defensively rather than loop forever on it.
            await persistErrorBestEffort(supabase, claim.id, `nonce-matched tx ${log.transactionHash} already claimed by another row — investigate`)
          }
        }
      }
    }

    const mawLog = await findMintAndWithdrawLog(claim.wallet_address, Number(claim.amount))
    if (mawLog) {
      const { data: alreadyUsed } = await supabase
        .from('claims')
        .select('id')
        .eq('destination_tx_hash', mawLog.transactionHash)
        .neq('id', claim.id)
        .maybeSingle()
      if (!alreadyUsed) {
        try {
          const relayTimestamp = await getBlockTimestamp(mawLog.blockNumber)
          await updateClaim(supabase, claim.id, {
            status:              'completed',
            destination_tx_hash: mawLog.transactionHash,
            receiver_block:      mawLog.blockNumber,
            relay_timestamp:     relayTimestamp,
            completed_at:        new Date().toISOString(),
            error:               null,
            arrived_amount:      mawLog.amount ?? null,
          })
          await recordClaimActivity(supabase, claim, 'completed', mawLog.amount ?? undefined, mawLog.transactionHash)
          await notifyClaimComplete(supabase, claim, mawLog.amount ?? claim.amount)
          logSettlementMetrics(claim)
          return
        } catch (e) {
          if (!isDuplicateDestinationTxError(e)) throw e
          // Lost the race to another claim for this same wallet+amount —
          // don't keep retrying the same collision. Wait for THIS claim's
          // own mint (nonce-based match above will pick it up once it's
          // found) instead of hammering an already-claimed tx every sweep.
          await persistErrorBestEffort(
            supabase, claim.id,
            `amount-match collision: ${mawLog.transactionHash} already claimed by another row (same wallet+amount) — waiting for own mint`
          )
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
        skippedAlreadyUsed.push(`${mint.transactionHash}->${alreadyUsed.id}`)
        continue
      }

      try {
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
      } catch (e) {
        if (!isDuplicateDestinationTxError(e)) throw e
        // Race: another claim's write landed between our SELECT and our
        // UPDATE. Same fix as findMintAndWithdrawLog above — move on to the
        // next ranked candidate instead of throwing out of the loop.
        skippedAlreadyUsed.push(`${mint.transactionHash}->(race)`)
        continue
      }
    }

    if (!claimed) {
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
    const displayAmount = arrivedAmount ?? claim.amount
    const base = CHAIN_EXPLORER[claim.source_chain] ?? ARC_EXPLORER
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
    if (latest.status === 'settling') {
      const settlingStartMs = latest.settling_at ? new Date(latest.settling_at).getTime() : Date.now()
      if (Date.now() - settlingStartMs >= SETTLING_TIMEOUT_MS) {
        await confirmArrival(supabase, latest)
        const { data: afterCheck } = await supabase
          .from('claims').select('status').eq('id', latest.id).single()
        if (afterCheck?.status === 'completed') return
        await markFailed(supabase, latest, 'Timed out waiting for funds to arrive on Arc')
        return
      }
    } else if (latest.status === 'bridging') {
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
  const totalProcessed = await processPass(supabase)
  return json({ success: true, mode, totalProcessed, idleExit: totalProcessed === 0 })
})
