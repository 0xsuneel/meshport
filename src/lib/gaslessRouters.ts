// src/lib/gaslessRouters.ts
//
// Which chains have MeshPort's gasless CCTP router - with no viem import, so
// screens that only need to KNOW (the Pay page's network list, the merchant
// QR) don't pull the wallet library into the app's first load. The
// checksummed router addresses for actually bridging live in gaslessBridge.ts.
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

/** VITE_BRIDGE_ROUTERS as { chainId: address }, EVM chains only, unchecksummed. */
export function routerAddressesRaw(): Record<string, string> {
  try {
    // Plain import.meta.env.VITE_… so Vite substitutes it at build time.
    const raw = import.meta.env.VITE_BRIDGE_ROUTERS as string | undefined
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof EXTERNAL_CHAINS[k]?.chainId === 'number' && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = v
    }
    return out
  } catch { return {} }
}

export function hasGaslessRouter(chainId: string): boolean {
  return !!routerAddressesRaw()[chainId]
}
