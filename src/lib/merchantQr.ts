// Merchant QR — a payment QR any wallet understands (MetaMask, OKX, Rabby,
// Trust, Coinbase Wallet…): EIP-681 carries the NETWORK and the AMOUNT, so
// the scanner opens its send screen on the right chain with the amount filled
// in. The chains are the ones MeshPort watches for merchant payments (the
// merchant-pay deposit watcher), so a payment from the QR is linked to its
// order automatically; payments on other chains are collected to Arc.
import { parseUnits, getAddress } from 'viem'
import { ARC, EXTERNAL_CHAINS } from '@/blockchain/chains'

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
]

export const MERCHANT_QR_CHAINS: MerchantQrChain[] = [
  // Arc: USDC is the native coin (18 decimals as native value).
  { id: 'Arc_Testnet', label: 'Arc', chainId: ARC.chainId, usdc: null, logo: '/logos/chains/arc.svg', native: true },
  ...EXTERNAL.flatMap(([id, label, logo]) => {
    const c = EXTERNAL_CHAINS[id]
    return c?.chainId && c.usdc ? [{ id, label, chainId: c.chainId, usdc: c.usdc, logo: `/logos/chains/${logo}.svg` }] : []
  }),
]

/** Merchant QR networks: the other chains (Arc is in the MeshPort QR). */
export const MERCHANT_QR_EXTERNAL: MerchantQrChain[] = MERCHANT_QR_CHAINS.filter(c => !c.native)

export const merchantQrChain = (id: string): MerchantQrChain => MERCHANT_QR_CHAINS.find(c => c.id === id) ?? MERCHANT_QR_CHAINS[0]

/**
 * EIP-681 payment URI for `amount` USDC to `to` on `chainId` — the standard
 * wallets read (Trust, OKX, Coinbase Wallet, MetaMask, Rainbow…):
 *   Arc (native USDC):  ethereum:<to>@<chainId>?value=<amount × 10^18>
 *   ERC-20 USDC:        ethereum:<usdc>@<chainId>/transfer?address=<to>&uint256=<amount × 10^6>
 * Amounts are plain integers in the token's smallest unit (every parser
 * reads those); addresses are EIP-55 checksummed (strict scanners check it).
 */
export function merchantPaymentUri(chainId: string, to: string, amount: number): string {
  const c = merchantQrChain(chainId)
  const recipient = getAddress(to)
  const amt = amount.toFixed(6).replace(/\.?0+$/, '')
  if (c.native || !c.usdc) return `ethereum:${recipient}@${c.chainId}?value=${parseUnits(amt, 18).toString()}`
  return `ethereum:${getAddress(c.usdc)}@${c.chainId}/transfer?address=${recipient}&uint256=${parseUnits(amt, 6).toString()}`
}

/** Network names as wallets list them (for the "add this network" hint). */
export const MERCHANT_QR_NETWORK_NAME: Record<string, string> = {
  Arc_Testnet: 'Arc Testnet', Ethereum_Sepolia: 'Sepolia', Base_Sepolia: 'Base Sepolia', Arbitrum_Sepolia: 'Arbitrum Sepolia',
  Optimism_Sepolia: 'OP Sepolia', Polygon_Sepolia: 'Polygon Amoy', Avalanche_Fuji: 'Avalanche Fuji', HyperEVM_Testnet: 'HyperEVM Testnet',
  Sei_Testnet: 'Sei Testnet', Unichain_Sepolia: 'Unichain Sepolia',
}

/**
 * MeshPort QR for a payment request: ONLY address + amount + network (no
 * link — wallets like OKX would show it). Any wallet fills the payment in;
 * MeshPort's scanner finds the open order for that address and amount
 * (merchant-pay `find`) and opens it with amount and order fixed.
 */
export function meshportRequestQr(chainId: string, to: string, amount: number): string {
  return merchantPaymentUri(chainId, to, amount)
}

/** My QR with no amount: the address on Arc, so wallets pick the Arc network. */
export function arcAddressUri(to: string): string {
  try { return `ethereum:${getAddress(to)}@${ARC.chainId}` } catch { return to }
}
