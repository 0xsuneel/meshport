// src/wallet/useSolanaWallet.ts
//
// This account's Solana wallet for screens (docs/SOLANA.md): its address
// once Privy has it, and its USDC balance on Solana devnet. Only Privy
// accounts (Google / email) have one; everyone else gets { address: null }.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuthStore } from '@/store'
import { getSolanaUsdcBalance } from '@/lib/solana'
import { onPrivyChange, privySolanaAddress } from './privy'

export function useSolanaWallet(): { address: string | null; usdc: string | null; refresh: () => void } {
  const isPrivy = useAuthStore(s => s.walletSource === 'privy')
  const address = useSyncExternalStore(onPrivyChange, privySolanaAddress, () => null)
  const [usdc, setUsdc] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (!isPrivy || !address) { setUsdc(null); return }
    let cancelled = false
    getSolanaUsdcBalance(address).then(b => { if (!cancelled) setUsdc(b) }).catch(() => { if (!cancelled) setUsdc(null) })
    return () => { cancelled = true }
  }, [isPrivy, address, tick])

  return { address: isPrivy ? address : null, usdc, refresh }
}
