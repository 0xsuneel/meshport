// src/lib/gaslessRouters.ts
//
// Which chains have MeshPort's gasless CCTP router - with no viem import, so
// screens that only need to KNOW (the Pay page's network list, the merchant
// QR) don't pull the wallet library into the app's first load. The
// checksummed router addresses for actually bridging live in gaslessBridge.ts.
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

/**
 * Chains whose test USDC cannot verify any EIP-712 signature, so no gasless route (permit /
 * receiveWithAuthorization) can work there: Linea Sepolia's USDC (0xFEce44…d9B7, Circle's
 * published address) never set a DOMAIN_SEPARATOR. Left out until Circle fixes the token -
 * the screen then says "not available" instead of dead-ending on a quote error. The server
 * (api/bridge-relay.ts) keeps the same list.
 */
export const NO_SIGNING_DOMAIN = new Set(['Linea_Sepolia'])

/** VITE_BRIDGE_ROUTERS as { chainId: address }, EVM chains only, unchecksummed. */
export function routerAddressesRaw(): Record<string, string> {
  try {
    // Plain import.meta.env.VITE_… so Vite substitutes it at build time.
    const raw = import.meta.env.VITE_BRIDGE_ROUTERS as string | undefined
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (NO_SIGNING_DOMAIN.has(k)) continue
      if (typeof EXTERNAL_CHAINS[k]?.chainId === 'number' && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = v
    }
    return out
  } catch { return {} }
}

export function hasGaslessRouter(chainId: string): boolean {
  return !!routerAddressesRaw()[chainId]
}
