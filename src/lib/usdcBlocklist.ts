/**
 * USDC blocklist check before sending to an address.
 *
 * A USDC transfer to a blocklisted address reverts on-chain and still burns
 * gas, so refunds, payouts and cash-outs ask first:
 * https://docs.arc.io/integrate/exchanges/withdrawals#step-2-check-the-blocklist
 */
import { encodeFunctionData, decodeFunctionResult, type Hex } from 'viem'

const ABI = [{ type: 'function', name: 'isBlacklisted', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] }] as const
const ARC_USDC = '0x3600000000000000000000000000000000000000'

const cache = new Map<string, { blocked: boolean; at: number }>()
const TTL_MS = 10 * 60_000

async function ethCall(chain: string, to: string, data: Hex): Promise<string | null> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }
  if (chain === 'Arc_Testnet') {
    const { arcRpcJson } = await import('@/lib/arc')
    const j = await arcRpcJson(body).catch(() => null)
    return typeof j?.result === 'string' ? j.result : null
  }
  const { EXTERNAL_CHAINS } = await import('@/blockchain/chains')
  for (const url of EXTERNAL_CHAINS[chain]?.rpcs ?? []) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) })
      const j = await r.json()
      if (typeof j?.result === 'string') return j.result
    } catch { /* next RPC */ }
  }
  return null
}

/**
 * True when USDC on `chain` refuses `address`. Unreadable → false: the
 * chain still enforces the list, this only saves a failed transaction.
 */
export async function isUsdcBlocked(address: string, chain = 'Arc_Testnet'): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false
  const key = `${chain}:${address.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.blocked
  let usdc = ARC_USDC
  if (chain !== 'Arc_Testnet') {
    const { EXTERNAL_CHAINS } = await import('@/blockchain/chains')
    const u = EXTERNAL_CHAINS[chain]?.usdc
    if (!u) return false
    usdc = u
  }
  const raw = await ethCall(chain, usdc, encodeFunctionData({ abi: ABI, functionName: 'isBlacklisted', args: [address as Hex] }))
  if (!raw || raw === '0x') return false
  let blocked = false
  try { blocked = decodeFunctionResult({ abi: ABI, functionName: 'isBlacklisted', data: raw as Hex }) } catch { return false }
  cache.set(key, { blocked, at: Date.now() })
  return blocked
}

/** The addresses of `list` that USDC refuses (checked together). */
export async function blockedAmong(list: string[], chain = 'Arc_Testnet'): Promise<Set<string>> {
  const unique = [...new Set(list.map(a => a.toLowerCase()))]
  const flags = await Promise.all(unique.map(a => isUsdcBlocked(a, chain)))
  return new Set(unique.filter((_, i) => flags[i]))
}

export const BLOCKED_TEXT = "This address is on the USDC blocklist, so USDC can't be sent to it."
