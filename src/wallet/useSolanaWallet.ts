// src/wallet/useSolanaWallet.ts
//
// This account's Solana wallet for screens (docs/SOLANA.md): its address and
// its USDC balance on Solana devnet. Every account has one - Privy's Solana
// wallet for Google / email, the frame-derived key for created / imported
// wallets (wallet/solana.ts); { address: null } until the wallet is open.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuthStore } from '@/store'
import { getSolanaUsdcBalance } from '@/lib/solana'
import { onPrivyChange, privySolanaAddress } from './privy'
import { getSolanaAddress, knownSolanaAddress } from './solana'

export function useSolanaWallet(): { address: string | null; usdc: string | null; refresh: () => void } {
  const source = useAuthStore(s => s.walletSource)
  const evm = useAuthStore(s => s.walletAddress)
  const unlocked = useAuthStore(s => !!s.signer)
  const privyAddress = useSyncExternalStore(onPrivyChange, privySolanaAddress, () => null)
  const [frameAddress, setFrameAddress] = useState<string | null>(() => knownSolanaAddress())
  const [usdc, setUsdc] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(t => t + 1), [])

  const isPrivy = source === 'privy'
  useEffect(() => {
    if (isPrivy || source === 'circle' || !evm || !unlocked) { setFrameAddress(null); return }
    let cancelled = false
    getSolanaAddress().then(a => { if (!cancelled) setFrameAddress(a) }).catch(() => { if (!cancelled) setFrameAddress(null) })
    return () => { cancelled = true }
  }, [isPrivy, source, evm, unlocked])

  const address = isPrivy ? privyAddress : frameAddress
  useEffect(() => {
    if (!address) { setUsdc(null); return }
    let cancelled = false
    getSolanaUsdcBalance(address).then(b => { if (!cancelled) setUsdc(b) }).catch(() => { if (!cancelled) setUsdc(null) })
    return () => { cancelled = true }
  }, [address, tick])

  return { address, usdc, refresh }
}
