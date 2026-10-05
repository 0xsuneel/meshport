// src/lib/relayedProvider.ts
//
// Ethers provider for Circle App Kit on non-Arc chains, used wherever the kit
// would otherwise need the user's wallet to hold native gas there. Instead of
// broadcasting, a transaction MeshPort's relayer can submit for the user —
// a Gateway Wallet deposit the user signed, a Gateway Minter gatewayMint or a
// CCTP receiveMessage — is handed to /api/bridge-relay ({ action: 'call' }),
// which sends the same call from the relayer wallet. Those calls don't depend
// on who sends them (the recipient is fixed by the user's signature or
// Circle's attestation), so nothing changes except who pays the gas.
//
// The kit still signs its own transaction and waits on that hash, so the
// provider answers receipt/transaction lookups for it with the relayer's
// transaction. Anything the relayer can't submit fails with a clear error —
// it is never broadcast from a gas-less wallet.

import { RPC_BY_CHAIN_NAME } from './chainRpcs'

/** Circle App Kit chain name → the app's chain id (what the relayer expects). */
export const KIT_CHAIN_NAME_TO_ID: Record<string, string> = {
  'Ethereum Sepolia':    'Ethereum_Sepolia',
  'Base Sepolia':        'Base_Sepolia',
  'Arbitrum Sepolia':    'Arbitrum_Sepolia',
  'OP Sepolia':          'Optimism_Sepolia',
  'Optimism Sepolia':    'Optimism_Sepolia',
  'Polygon PoS Amoy':    'Polygon_Sepolia',
  'Polygon Amoy':        'Polygon_Sepolia',
  'Avalanche Fuji':      'Avalanche_Fuji',
  'HyperEVM Testnet':    'HyperEVM_Testnet',
  'Sei Testnet':         'Sei_Testnet',
  'Sonic Testnet':       'Sonic_Testnet',
  'Unichain Sepolia':    'Unichain_Sepolia',
  'World Chain Sepolia': 'World_Chain_Sepolia',
  'Arc Testnet':         'Arc_Testnet',
  'Linea Sepolia':       'Linea_Sepolia',
  'Ink Testnet':         'Ink_Testnet',
  'Ink Sepolia':         'Ink_Testnet',
  'Monad Testnet':       'Monad_Testnet',
  'Morph Testnet':       'Morph_Testnet',
  'Morph Hoodi':         'Morph_Testnet',
  'Pharos Testnet':      'Pharos_Testnet',
  'Pharos Atlantic':     'Pharos_Testnet',
  'Plume Testnet':       'Plume_Testnet',
  'XDC Apothem':         'XDC_Apothem',
  'Apothem Network':     'XDC_Apothem',
  'Codex Testnet':       'Codex_Testnet',
  'EDGE Testnet':        'Edge_Testnet',
  'Edge Testnet':        'Edge_Testnet',
  'Injective Testnet':   'Injective_Testnet',
}

// Selectors of the calls /api/bridge-relay will submit (the server checks
// again; this only decides what to hand over instead of broadcasting).
export const RELAYABLE_SELECTORS = new Set([
  '0x8a94d4fc', // depositWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
  '0x438d4835', // depositWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)
  '0x8ef59739', // depositWithPermit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  '0x26a3fb30', // depositWithPermit(address,address,uint256,uint256,bytes)
  '0x9fb01cc5', // gatewayMint(bytes,bytes)
  '0x57ecfd28', // receiveMessage(bytes,bytes)
])
const RELAYED_GAS_LIMIT = '0x' + (1_000_000).toString(16) // the relayer estimates its own; this only fills the kit's tx

const cache = new Map<string, any>()

// The kit's own (never broadcast) tx hash → the relayer's tx hash, plus the
// kit's signed tx. Shared by every relayed provider.
const aliases = new Map<string, { relayed: string; tx: any }>()

/**
 * The on-chain hash for a hash a kit result reports: a relayed transaction's
 * kit-side hash never exists on-chain, so use the relayer's instead (links,
 * receipts, Activity). Any other hash is returned unchanged.
 */
export function realTxHash<T extends string | undefined | null>(hash: T): T {
  if (!hash) return hash
  return (aliases.get(String(hash).toLowerCase())?.relayed ?? hash) as T
}

/** A provider for `sdkChain` (an App Kit chain object) whose relayable transactions go through MeshPort's relayer. */
export async function relayedProviderFor(sdkChain: any): Promise<any> {
  const name: string = sdkChain?.name ?? ''
  const chainKey = KIT_CHAIN_NAME_TO_ID[name] ?? name
  const urls: string[] = RPC_BY_CHAIN_NAME[name]
    ?? [sdkChain?.rpcEndpoints?.[0] ?? sdkChain?.rpcUrls?.default?.http?.[0]].filter(Boolean)
  if (urls.length === 0) throw new Error(`No RPC for ${name || 'this chain'}`)
  const cacheKey = `${chainKey}|${urls.join(',')}`
  if (!cache.has(cacheKey)) cache.set(cacheKey, await build(urls, chainKey, sdkChain?.chainId))
  return cache.get(cacheKey)
}

async function build(urls: string[], chainKey: string, chainId?: number) {
  const { JsonRpcProvider, Transaction } = await import('ethers')
  const providers = urls.map(url => chainId
    ? new JsonRpcProvider(url, { chainId, name: 'chain-' + chainId }, { staticNetwork: true })
    : new JsonRpcProvider(url))
  const provider: any = providers[0]
  const sends = providers.map((p: any) => p._send.bind(p))
  const rpc = async (payload: any) => {
    let lastErr: unknown = null
    for (const send of sends) {
      try { return await send(payload) } catch (e) { lastErr = e }
    }
    throw lastErr
  }
  const rpcOne = async (method: string, params: unknown[]) => {
    const [r] = await rpc({ jsonrpc: '2.0', id: 1, method, params })
    if (r?.error) throw new Error(r.error.message || `${method} failed`)
    return r?.result
  }

  const isRelayable = (tx: any) => RELAYABLE_SELECTORS.has(String(tx?.data ?? tx?.input ?? '0x').slice(0, 10).toLowerCase())

  async function relay(raw: string): Promise<string> {
    const tx = Transaction.from(raw)
    if (!tx.to || !isRelayable(tx)) throw new Error('This step needs gas on this chain and cannot be relayed')
    const { authApiHeaders } = await import('./supabase')
    const r = await fetch('/api/bridge-relay', {
      method: 'POST', headers: await authApiHeaders(),
      body: JSON.stringify({ action: 'call', chain: chainKey, to: tx.to, data: tx.data }),
    })
    const out = await r.json().catch(() => null) as { txHash?: string; error?: string } | null
    if (!r.ok || !out?.txHash) throw new Error(out?.error || 'Relayer did not accept the transaction')
    aliases.set(tx.hash!.toLowerCase(), { relayed: out.txHash, tx })
    return tx.hash!
  }

  async function aliasedReceipt(hash: string) {
    const a = aliases.get(hash.toLowerCase())!
    const receipt = await rpcOne('eth_getTransactionReceipt', [a.relayed])
    if (!receipt) return null
    return { ...receipt, transactionHash: hash, logs: (receipt.logs ?? []).map((l: any) => ({ ...l, transactionHash: hash })) }
  }

  async function aliasedTransaction(hash: string) {
    const a = aliases.get(hash.toLowerCase())!
    const relayed = await rpcOne('eth_getTransactionByHash', [a.relayed]).catch(() => null)
    const t = a.tx
    const hex = (v: bigint | number | null | undefined) => v == null ? undefined : '0x' + BigInt(v).toString(16)
    return {
      hash, from: t.from, to: t.to, input: t.data, value: hex(t.value) ?? '0x0', nonce: hex(t.nonce),
      gas: hex(t.gasLimit), gasPrice: hex(t.gasPrice ?? t.maxFeePerGas), maxFeePerGas: hex(t.maxFeePerGas),
      maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas), type: hex(t.type ?? 0), chainId: hex(t.chainId),
      v: hex(t.signature?.v), r: t.signature?.r, s: t.signature?.s, accessList: t.accessList ?? undefined,
      blockHash: relayed?.blockHash ?? null, blockNumber: relayed?.blockNumber ?? null, transactionIndex: relayed?.transactionIndex ?? null,
    }
  }

  provider._send = async (payload: any) => {
    const batch = Array.isArray(payload) ? payload : [payload]
    const results: any[] = []
    for (const req of batch) {
      const { method, params = [] } = req
      try {
        // The wallet needs no gas here; report some so the kit doesn't refuse
        // before signing (same as the old gas-sponsored provider did).
        if (method === 'eth_getBalance') { results.push({ id: req.id, jsonrpc: '2.0', result: '0x1BC16D674EC80000' }); continue }
        if (method === 'eth_estimateGas' && isRelayable(params[0])) { results.push({ id: req.id, jsonrpc: '2.0', result: RELAYED_GAS_LIMIT }); continue }
        if (method === 'eth_sendRawTransaction') { results.push({ id: req.id, jsonrpc: '2.0', result: await relay(params[0]) }); continue }
        if (method === 'eth_getTransactionReceipt' && aliases.has(String(params[0]).toLowerCase())) {
          results.push({ id: req.id, jsonrpc: '2.0', result: await aliasedReceipt(params[0]) }); continue
        }
        if (method === 'eth_getTransactionByHash' && aliases.has(String(params[0]).toLowerCase())) {
          results.push({ id: req.id, jsonrpc: '2.0', result: await aliasedTransaction(params[0]) }); continue
        }
      } catch (e: any) {
        results.push({ id: req.id, jsonrpc: '2.0', error: { code: -32603, message: e?.message ?? String(e) } }); continue
      }
      results.push(null)
    }
    const pending = batch.filter((_: any, i: number) => results[i] === null)
    if (pending.length > 0) {
      const out = await rpc(pending.length === 1 ? pending[0] : pending)
      const arr = Array.isArray(out) ? out : [out]
      let k = 0
      for (let i = 0; i < results.length; i++) if (results[i] === null) results[i] = arr[k++]
    }
    return results
  }
  return provider
}
