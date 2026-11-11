// src/lib/qrPayload.ts
//
// What a scanned QR asks for, read the way wallet scanners read it: EIP-681
// payment URIs (MetaMask, OKX, Trust, Coinbase Wallet, Rabby…), Solana
// addresses and Solana Pay URIs (Phantom, Solflare…), and codes MeshPort
// can't pay (Bitcoin, Tron, UPI, WalletConnect, plain links) - those get a
// clear message instead of "No MeshPort user found for <gibberish>".
// Pure functions, no camera or network, so every format is unit-tested.
import { formatUnits } from 'viem'
import { ARC } from '@/blockchain/chains'
import { MERCHANT_QR_CHAINS } from './merchantQrChains'
import { isSolanaAddress } from './solana'

/** USDC contracts whose `uint256` amount is 6-decimal USDC: every network
 *  MeshPort's own QRs use, plus USDC on the main networks. Any other token's
 *  amount is NOT USDC (DAI has 18 decimals) and is left for the payer to type. */
const KNOWN_USDC = new Set<string>([
  ...MERCHANT_QR_CHAINS.flatMap(c => (c.usdc ? [c.usdc.toLowerCase()] : [])),
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Ethereum
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // Arbitrum
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // Optimism
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // Polygon
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // Avalanche
])

const MAINNET_NAMES: Record<number, string> = {
  1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon',
  56: 'BNB Chain', 43114: 'Avalanche', 324: 'zkSync', 59144: 'Linea', 11155111: 'Sepolia',
}

/** A network's name for a chain id, or null when it's unknown. */
export function chainNameOf(chainId: number): string | null {
  return MERCHANT_QR_CHAINS.find(c => c.chainId === chainId)?.label ?? MAINNET_NAMES[chainId] ?? null
}

/** An integer amount in a token's smallest unit (may be 1.25e7) → human. */
function toHuman(raw: string | null, decimals: number): string | null {
  const n = raw?.trim().match(/^(\d+)(?:\.(\d+))?(?:e(\d+))?$/i)
  if (!n) return null
  const [, int, frac = '', exp = '0'] = n
  const e = Number(exp) - frac.length
  if (e < 0) return null
  const atomic = BigInt(int + frac) * 10n ** BigInt(e)
  if (atomic <= 0n) return null
  const human = formatUnits(atomic, decimals)
  return human.includes('.') ? human.replace(/0+$/, '').replace(/\.$/, '') : human
}

export type Eip681 = {
  /** Who gets paid; null when a token transfer names no recipient. */
  to: string | null
  /** The network the QR asks for; null when it names none. */
  chainId: number | null
  /** USDC amount, only when the QR's amount really is USDC. */
  amount: string | null
}

/**
 * An EIP-681 payment URI (or a MetaMask send link), or null if it isn't one.
 *   Native coin:  ethereum:<to>[@chainId]?value=<wei>
 *   ERC-20:       ethereum:<token>[@chainId]/transfer?address=<to>&uint256=<atomic>
 */
export function parseEip681(raw: string): Eip681 | null {
  const value = raw.trim()
  if (!/^ethereum:/i.test(value) && !/^https:\/\/metamask\.app\.link\/send\//i.test(value)) return null
  const body = value.replace(/^ethereum:(pay-)?/i, '').replace(/^https:\/\/metamask\.app\.link\/send\/(pay-)?/i, '')
  const m = body.match(/^(0x[0-9a-fA-F]{40})(?:@(\d+))?(\/transfer)?\??(.*)$/i)
  if (!m) return null
  const [, target, chain, isTransfer, queryStr] = m
  const params = new URLSearchParams(queryStr)
  const chainId = chain ? Number(chain) : null
  if (isTransfer) {
    // The address before /transfer is the TOKEN contract - never the payee.
    const to = params.get('address')
    const amount = KNOWN_USDC.has(target.toLowerCase()) ? toHuman(params.get('uint256'), 6) : null
    return { to: to && /^0x[0-9a-fA-F]{40}$/.test(to) ? to : null, chainId, amount }
  }
  // A native `value` is USDC only on Arc (USDC is Arc's native coin, 18
  // decimals); on Ethereum it's ETH. No network named: MeshPort's own older QRs.
  const amount = chainId === null || chainId === ARC.chainId ? toHuman(params.get('value'), 18) : null
  return { to: target, chainId, amount }
}

export type ForeignQr =
  | { kind: 'solana'; address: string }
  | { kind: 'unsupported'; message: string }

const BTC = /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/
const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

/**
 * A QR that isn't an EVM address or a MeshPort code: a Solana wallet (which
 * Transfer can send to), or something MeshPort can't pay, with the reason.
 * null: not one of these - the scanner reads it as usual.
 */
export function classifyForeignQr(raw: string): ForeignQr | null {
  const value = raw.trim()
  const lower = value.toLowerCase()
  // Solana Pay (solana:<address>?amount=…) or a bare Solana address.
  if (lower.startsWith('solana:')) {
    const addr = value.slice('solana:'.length).split('?')[0]
    if (isSolanaAddress(addr)) return { kind: 'solana', address: addr }
    return { kind: 'unsupported', message: 'This Solana payment QR needs a Solana wallet app to complete.' }
  }
  if (isSolanaAddress(value)) return { kind: 'solana', address: value }
  if (lower.startsWith('bitcoin:') || BTC.test(value)) return { kind: 'unsupported', message: 'This is a Bitcoin address. MeshPort sends USDC, so it can\'t pay to Bitcoin.' }
  if (lower.startsWith('tron:') || TRON.test(value)) return { kind: 'unsupported', message: 'This is a Tron address. MeshPort can\'t send to Tron.' }
  if (/^(litecoin|dogecoin|bitcoincash|ton|ripple|xrp|cosmos):/i.test(value)) {
    const net = value.split(':')[0]
    return { kind: 'unsupported', message: `This is a ${net[0].toUpperCase()}${net.slice(1).toLowerCase()} address. MeshPort can't send to it.` }
  }
  if (lower.startsWith('upi://')) return { kind: 'unsupported', message: 'This is a UPI QR. Pay it with a UPI app - MeshPort sends USDC.' }
  if (lower.startsWith('wc:')) return { kind: 'unsupported', message: 'This is a WalletConnect code for connecting a wallet to a website, not a payment QR.' }
  // A web link that isn't MeshPort's own (those are read by the scanner).
  if (/^https?:\/\//i.test(value) && !/meshport/i.test(value)) {
    let host = value
    try { host = new URL(value).host } catch { /* keep the text */ }
    return { kind: 'unsupported', message: `This QR is a link to ${host}, not a payment QR.` }
  }
  return null
}
