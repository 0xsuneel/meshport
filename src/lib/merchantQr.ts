// Merchant QR - a payment QR any wallet understands (MetaMask, OKX, Rabby,
// Trust, Coinbase Wallet…): EIP-681 carries the NETWORK and the AMOUNT, so
// the scanner opens its send screen on the right chain with the amount filled
// in. The chains are the ones MeshPort watches for merchant payments (the
// merchant-pay deposit watcher), so a payment from the QR is linked to its
// order automatically; the merchant moves them to Arc with Claim All (CCTP).
import { parseUnits, getAddress } from 'viem'
import { ARC } from '@/blockchain/chains'
import { merchantQrChain } from './merchantQrChains'

// The networks and their names are plain data in merchantQrChains.ts (no
// viem, so the Pay page can load without the wallet library).
export { MERCHANT_QR_CHAINS, MERCHANT_QR_EXTERNAL, merchantQrChain, MERCHANT_QR_NETWORK_NAME, type MerchantQrChain } from './merchantQrChains'

/**
 * EIP-681 payment URI for `amount` USDC to `to` on `chainId` - the standard
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


/**
 * MeshPort QR for a payment request: ONLY address + amount + network (no
 * link - wallets like OKX would show it). Any wallet fills the payment in;
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
