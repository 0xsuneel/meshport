// What the relayer needs to be able to pay for gas, chain by chain (admin → System → Relayer gas).
//
// Pure data and helpers - no Deno, no network - so the rules are unit-tested
// (src/lib/relayerGas.test.ts). The chain ids, names and rough gas-coin
// prices mirror CHAINS in api/bridge-relay.ts (which signs and sends); keep
// them in step. Every chain's own coin has 18 decimals (Arc's is USDC).

export interface RelayerGasChain {
  /** MeshPort's chain key (the same as CHAIN_RPCS / api/bridge-relay CHAINS). */
  key: string
  name: string
  chainId: number
  /** The coin gas is paid in; null = not confirmed for this chain, shown as "coin". */
  symbol: string | null
  /** Rough USD price of one coin (testnet coins are worth nothing - this only sizes a refill). */
  usd: number
}

export const RELAYER_GAS_CHAINS: RelayerGasChain[] = [
  { key: 'Arc_Testnet',         name: 'Arc',                 chainId: 5042002, symbol: 'USDC',  usd: 1 },
  { key: 'Ethereum_Sepolia',    name: 'Ethereum Sepolia',    chainId: 11155111, symbol: 'ETH',  usd: 3000 },
  { key: 'Base_Sepolia',        name: 'Base Sepolia',        chainId: 84532,    symbol: 'ETH',  usd: 3000 },
  { key: 'Arbitrum_Sepolia',    name: 'Arbitrum Sepolia',    chainId: 421614,   symbol: 'ETH',  usd: 3000 },
  { key: 'Optimism_Sepolia',    name: 'OP Sepolia',          chainId: 11155420, symbol: 'ETH',  usd: 3000 },
  { key: 'Polygon_Sepolia',     name: 'Polygon Amoy',        chainId: 80002,    symbol: 'POL',  usd: 0.5 },
  { key: 'Avalanche_Fuji',      name: 'Avalanche Fuji',      chainId: 43113,    symbol: 'AVAX', usd: 30 },
  { key: 'HyperEVM_Testnet',    name: 'HyperEVM Testnet',    chainId: 998,      symbol: 'HYPE', usd: 30 },
  { key: 'Sei_Testnet',         name: 'Sei Testnet',         chainId: 1328,     symbol: 'SEI',  usd: 0.5 },
  { key: 'Unichain_Sepolia',    name: 'Unichain Sepolia',    chainId: 1301,     symbol: 'ETH',  usd: 3000 },
  { key: 'Morph_Testnet',       name: 'Morph Hoodi',         chainId: 2910,     symbol: 'ETH',  usd: 3000 },
  { key: 'Pharos_Testnet',      name: 'Pharos Atlantic',     chainId: 688689,   symbol: 'PHRS', usd: 1 },
  { key: 'Plume_Testnet',       name: 'Plume Testnet',       chainId: 98867,    symbol: 'PLUME', usd: 0.2 },
  { key: 'XDC_Apothem',         name: 'XDC Apothem',         chainId: 51,       symbol: 'XDC',  usd: 0.1 },
  { key: 'Codex_Testnet',       name: 'Codex Testnet',       chainId: 812242,   symbol: null,   usd: 3000 },
  { key: 'Monad_Testnet',       name: 'Monad Testnet',       chainId: 10143,    symbol: 'MON',  usd: 1 },
  { key: 'Sonic_Testnet',       name: 'Sonic Testnet',       chainId: 14601,    symbol: 'S',    usd: 0.5 },
  { key: 'World_Chain_Sepolia', name: 'World Chain Sepolia', chainId: 4801,     symbol: 'ETH',  usd: 3000 },
  { key: 'Linea_Sepolia',       name: 'Linea Sepolia',       chainId: 59141,    symbol: 'ETH',  usd: 3000 },
  { key: 'Ink_Testnet',         name: 'Ink Sepolia',         chainId: 763373,   symbol: 'ETH',  usd: 3000 },
  { key: 'Edge_Testnet',        name: 'Edge Testnet',        chainId: 33431,    symbol: null,   usd: 1 },
  { key: 'Injective_Testnet',   name: 'Injective Testnet',   chainId: 1439,     symbol: 'INJ',  usd: 20 },
]

/** Worth less than this (USD, by the rough price) and the chain is "Low"; under LOW / 5 it is "Empty". */
export const LOW_USD = 5
export const EMPTY_USD = 1

export type GasStatus = 'ok' | 'low' | 'empty'

/** Wei → a short decimal text ("0.0123", "152.4"): 4 decimals, or 6 below 0.01, trailing zeros trimmed. */
export function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0')
  const small = whole === 0n && wei < 10n ** 16n
  const digits = small ? 6 : 4
  const f = frac.slice(0, digits).replace(/0+$/, '')
  if (wei > 0n && whole === 0n && f === '') return `<0.${'0'.repeat(digits - 1)}1`
  return f ? `${whole.toString()}.${f}` : whole.toString()
}

/** Roughly what this balance is worth in USD (for sizing a refill, not for accounting). */
export function approxUsd(wei: bigint, usd: number): number {
  return Number(wei / 10n ** 12n) / 1e6 * usd
}

export function gasStatus(wei: bigint, usd: number): GasStatus {
  const v = approxUsd(wei, usd)
  return v < EMPTY_USD ? 'empty' : v < LOW_USD ? 'low' : 'ok'
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DEFAULT_UNSUPPORTED = [998, 1328, 14601]

export interface RelayerEnv {
  mode?: string
  /** The relayer's address: the Circle wallet in circle mode, otherwise the key's. */
  address?: string
  /** The private-key account, used where Circle can't sign (circle mode). Optional. */
  keyAddress?: string
  /** Comma-separated chain ids Circle can't sign on. */
  unsupported?: string
}

export interface Signer { address: string; kind: 'circle' | 'key' }

/**
 * Who sends on `chainId`, as api/_lib/relayerSigner.ts decides: in circle mode
 * the Circle wallet, except on the chains it can't sign (then the key
 * account); otherwise the key's address. Null when nothing usable is set.
 */
export function signerFor(chainId: number, env: RelayerEnv): Signer | null {
  const address = ADDRESS.test((env.address ?? '').trim()) ? env.address!.trim() : null
  const keyAddress = ADDRESS.test((env.keyAddress ?? '').trim()) ? env.keyAddress!.trim() : null
  const circle = (env.mode ?? '').trim().toLowerCase() === 'circle'
  if (circle) {
    const raw = (env.unsupported ?? '').trim()
    const off = new Set(raw ? raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0) : DEFAULT_UNSUPPORTED)
    if (address && !off.has(chainId)) return { address, kind: 'circle' }
    const k = keyAddress ?? (off.has(chainId) ? null : address)
    return k ? { address: k, kind: 'key' } : null
  }
  const k = address ?? keyAddress
  return k ? { address: k, kind: 'key' } : null
}
