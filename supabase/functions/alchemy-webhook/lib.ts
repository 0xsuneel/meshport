// supabase/functions/alchemy-webhook/lib.ts - pure parts of alchemy-webhook (tested)
//
// Incoming money, pushed - the way MetaMask is told about activity instead of
// scanning chains. Alchemy's Address Activity webhook POSTs here when a
// tracked address (a MeshPort user's wallet) sends or receives a token, and
// only then. Each transfer to a user is written to chain_events in exactly
// the shape blockchain-indexer writes, so everything downstream (activity
// rows, notifications, merchant receipts, the ledger) is unchanged; only the
// source moved from polling every chain every 4 s to one call per real
// transfer.
//
// One Alchemy webhook per network (ARC_TESTNET, ETH_SEPOLIA, ...). Every
// request is HMAC-SHA256 verified against the raw body with that webhook's
// signing key (x-alchemy-signature). Keys: secret ALCHEMY_WEBHOOK_SIGNING_KEYS,
// comma-separated, one per webhook.
//
// Deduplication is the chain_events unique index (event_type, chain_id,
// tx_hash, wallet_address, log_index) - the same rows the indexer would write,
// so both can run side by side during the switch-over.

import { INDEXED_CHAINS, type IndexedChain } from '../blockchain-indexer/chains.ts'

/** Alchemy network enum -> MeshPort chain id (blockchain-indexer/chains.ts). */
export const ALCHEMY_NETWORKS: Record<string, string> = {
  ARC_TESTNET: 'arc',
  ETH_SEPOLIA: 'ethereum-sepolia',
  BASE_SEPOLIA: 'base-sepolia',
  ARB_SEPOLIA: 'arbitrum-sepolia',
  OPT_SEPOLIA: 'optimism-sepolia',
  MATIC_AMOY: 'polygon-amoy',
  AVAX_FUJI: 'avalanche-fuji',
  UNICHAIN_SEPOLIA: 'unichain-sepolia',
  WORLDCHAIN_SEPOLIA: 'world-chain-sepolia',
  LINEA_SEPOLIA: 'linea-sepolia',
  INK_SEPOLIA: 'ink-testnet',
  MONAD_TESTNET: 'monad-testnet',
}

const ZERO = '0x0000000000000000000000000000000000000000'
const NATIVE_DECIMALS = 18

export interface AlchemyActivity {
  blockNum?: string
  hash?: string
  fromAddress?: string
  toAddress?: string
  value?: number | null
  asset?: string | null
  category?: string
  rawContract?: { rawValue?: string | null; address?: string | null; decimals?: number | null } | null
  log?: { address?: string; logIndex?: string; blockHash?: string; transactionIndex?: string; removed?: boolean } | null
}

const hexNum = (h?: string | null): number | null => {
  if (!h) return null
  try { return Number(BigInt(h)) } catch { return null }
}
const lc = (a?: string | null) => (a ?? '').toLowerCase()

function units(raw: string | null | undefined, decimals: number): number | null {
  if (!raw) return null
  try {
    const v = BigInt(raw)
    const n = Number(v) / 10 ** decimals
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/**
 * Turn one Alchemy activity into the chain_events row blockchain-indexer would
 * write for it, or null when it is not a tracked asset arriving at someone
 * other than its sender. Mirrors scanner.ts: Arc's native USDC (a plain value
 * transfer, or its Transfer log from the 0x..fffe system contract) is a
 * deposit_detected; a tracked token is a transfer_detected; self-transfers are
 * skipped, and so are mints on Arc (CCTP mints belong to claim-worker).
 */
export function toChainEvent(chain: IndexedChain, a: AlchemyActivity): Record<string, unknown> | null {
  const to = lc(a.toAddress), from = lc(a.fromAddress), hash = lc(a.hash)
  if (!to || !hash || to === from) return null
  const block = hexNum(a.blockNum)
  const logIndex = a.log ? hexNum(a.log.logIndex) : null
  const blockHash = a.log?.blockHash ? lc(a.log.blockHash) : null
  const txIndex = a.log ? hexNum(a.log.transactionIndex) : null
  const contract = lc(a.rawContract?.address ?? a.log?.address ?? null)
  const isNativeChain = chain.nativeAsset !== null
  const isMint = from === ZERO

  // Native value transfer (Arc's USDC is the gas coin).
  if (isNativeChain && !contract && (a.category === 'external' || a.category === 'internal')) {
    const amount = typeof a.value === 'number' && a.value > 0 ? a.value
      : units(a.rawContract?.rawValue, NATIVE_DECIMALS)
    if (!amount) return null
    return {
      chain_id: chain.id, block_number: block, tx_hash: hash, event_type: 'deposit_detected',
      wallet_address: to, assets: ['USDC'], status: 'confirmed', confirmed_at: new Date().toISOString(),
      metadata: { recipient: to, sender: from, amount, via: 'alchemy-webhook' },
      log_index: null, contract_address: null, event_signature: null, block_hash: blockHash, transaction_index: txIndex,
    }
  }

  // Arc's native USDC as a Transfer log from the system contract.
  if (isNativeChain && contract && contract === lc(chain.nativeTransferLogContract)) {
    if (isMint) return null
    const amount = units(a.rawContract?.rawValue, NATIVE_DECIMALS)
    if (!amount) return null
    return {
      chain_id: chain.id, block_number: block, tx_hash: hash, event_type: 'deposit_detected',
      wallet_address: to, assets: ['USDC'], status: 'confirmed', confirmed_at: new Date().toISOString(),
      metadata: { recipient: to, sender: from, amount, via: 'native-transfer-log' },
      log_index: logIndex, contract_address: contract, event_signature: 'Transfer(address,address,uint256)',
      block_hash: blockHash, transaction_index: txIndex,
    }
  }

  // A tracked token (USDC on the other chains; EURC / cirBTC on Arc).
  const token = chain.tokens.find(t => lc(t.contract) === contract)
  if (!token) return null
  if (isMint && isNativeChain) return null
  const amount = units(a.rawContract?.rawValue, token.decimals)
  if (!amount) return null
  return {
    chain_id: chain.id, block_number: block, tx_hash: hash, event_type: 'transfer_detected',
    wallet_address: to, assets: [token.symbol], status: 'confirmed', confirmed_at: new Date().toISOString(),
    metadata: { to, from, amount, via: 'alchemy-webhook', ...(isMint ? { mint: true } : {}) },
    log_index: logIndex, contract_address: lc(token.contract), event_signature: 'Transfer(address,address,uint256)',
    block_hash: blockHash, transaction_index: txIndex,
  }
}

async function hmacHex(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
export async function validSignature(body: string, signature: string, keys: string[]): Promise<boolean> {
  if (!signature) return false
  for (const k of keys) if (safeEqual(await hmacHex(k, body), signature.toLowerCase())) return true
  return false
}

