// src/lib/merchantQrChains.ts
//
// The networks a merchant / personal payment QR can use, and their wallet
// names - plain data with no viem import, so the Pay page (loaded with the
// app's first bundle for cold visitors) doesn't pull the wallet library in.
// The EIP-681 URI builders that need viem stay in merchantQr.ts, which
// re-exports everything here.
import { ARC, EXTERNAL_CHAINS } from '@/blockchain/chains'
import { hasGaslessRouter } from './gaslessRouters'

export type MerchantQrChain = { id: string; label: string; chainId: number; usdc: string | null; logo: string; native?: boolean }

const EXTERNAL: Array<[id: string, label: string, logo: string]> = [
  ['Ethereum_Sepolia', 'Ethereum', 'ethereum'],
  ['Base_Sepolia', 'Base', 'base'],
  ['Arbitrum_Sepolia', 'Arbitrum', 'arbitrum'],
  ['Optimism_Sepolia', 'Optimism', 'optimism'],
  ['Polygon_Sepolia', 'Polygon', 'polygon'],
  ['Avalanche_Fuji', 'Avalanche', 'avalanche'],
  ['HyperEVM_Testnet', 'HyperEVM', 'hyperevm'],
  ['Sei_Testnet', 'Sei', 'sei'],
  ['Unichain_Sepolia', 'Unichain', 'unichain'],
  ['Sonic_Testnet', 'Sonic', 'sonic'],
  ['World_Chain_Sepolia', 'World Chain', 'world'],
  ['Linea_Sepolia', 'Linea', 'linea'],
  ['Ink_Testnet', 'Ink', 'ink'],
  ['Monad_Testnet', 'Monad', 'monad'],
  ['Morph_Testnet', 'Morph', 'morph'],
  ['Pharos_Testnet', 'Pharos', 'pharos'],
  ['Plume_Testnet', 'Plume', 'plume'],
  ['Codex_Testnet', 'Codex', 'codex'],
  ['Injective_Testnet', 'Injective', 'injective'],
  ['XDC_Apothem', 'XDC', 'xdc'],
]

export const MERCHANT_QR_CHAINS: MerchantQrChain[] = [
  // Arc: USDC is the native coin (18 decimals as native value).
  { id: 'Arc_Testnet', label: 'Arc', chainId: ARC.chainId, usdc: null, logo: '/logos/chains/arc.svg', native: true },
  ...EXTERNAL.flatMap(([id, label, logo]) => {
    const c = EXTERNAL_CHAINS[id]
    return c?.chainId && c.usdc ? [{ id, label, chainId: c.chainId, usdc: c.usdc, logo: `/logos/chains/${logo}.svg` }] : []
  }),
]

/**
 * Merchant QR networks: the other chains (Arc is in the MeshPort QR) that
 * have MeshPort's gasless CCTP router - merchants collect over CCTP only.
 * (If no router is configured, e.g. a local build, the full list is kept.)
 */
const QR_EXTERNAL_ALL = MERCHANT_QR_CHAINS.filter(c => !c.native)
const QR_EXTERNAL_CCTP = QR_EXTERNAL_ALL.filter(c => hasGaslessRouter(c.id))
export const MERCHANT_QR_EXTERNAL: MerchantQrChain[] = QR_EXTERNAL_CCTP.length ? QR_EXTERNAL_CCTP : QR_EXTERNAL_ALL

export const merchantQrChain = (id: string): MerchantQrChain => MERCHANT_QR_CHAINS.find(c => c.id === id) ?? MERCHANT_QR_CHAINS[0]

/** Network names as wallets list them (for the "add this network" hint). */
export const MERCHANT_QR_NETWORK_NAME: Record<string, string> = {
  Arc_Testnet: 'Arc Testnet', Ethereum_Sepolia: 'Sepolia', Base_Sepolia: 'Base Sepolia', Arbitrum_Sepolia: 'Arbitrum Sepolia',
  Optimism_Sepolia: 'OP Sepolia', Polygon_Sepolia: 'Polygon Amoy', Avalanche_Fuji: 'Avalanche Fuji', HyperEVM_Testnet: 'HyperEVM Testnet',
  Sei_Testnet: 'Sei Testnet', Unichain_Sepolia: 'Unichain Sepolia',
  Sonic_Testnet: 'Sonic Testnet', World_Chain_Sepolia: 'World Chain Sepolia', Linea_Sepolia: 'Linea Sepolia',
  Ink_Testnet: 'Ink Sepolia', Monad_Testnet: 'Monad Testnet', Morph_Testnet: 'Morph Hoodi', Pharos_Testnet: 'Pharos Testnet',
  Plume_Testnet: 'Plume Testnet', Codex_Testnet: 'Codex Testnet', Injective_Testnet: 'Injective EVM Testnet', XDC_Apothem: 'XDC Apothem',
}
