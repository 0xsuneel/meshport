// src/wallet/useSolanaWallet.ts
//
// This account's Solana wallet for screens (docs/SOLANA.md): its address and
// its USDC balance on Solana devnet. Created / imported wallets have one (the
// frame-derived key, wallet/solana.ts); Google / email accounts (Circle
// wallets) don't. { address: null } until the wallet is open, or without one.

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/store'
import { getSolanaUsdcBalance } from '@/lib/solana'
import { getSolanaAddress, knownSolanaAddress } from './solana'

export function useSolanaWallet(): { address: string | null; usdc: string | null; refresh: () => void } {
  const source = useAuthStore(s => s.walletSource)
  const evm = useAuthStore(s => s.walletAddress)
  const unlocked = useAuthStore(s => !!s.signer)
  const [frameAddress, setFrameAddress] = useState<string | null>(() => knownSolanaAddress())
  const [usdc, setUsdc] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (source === 'circle' || !evm || !unlocked) { setFrameAddress(null); return }
    let cancelled = false
    getSolanaAddress().then(a => { if (!cancelled) setFrameAddress(a) }).catch(() => { if (!cancelled) setFrameAddress(null) })
    return () => { cancelled = true }
  }, [source, evm, unlocked])

  const address = frameAddress
  useEffect(() => {
    if (!address) { setUsdc(null); return }
    let cancelled = false
    getSolanaUsdcBalance(address).then(b => { if (!cancelled) setUsdc(b) }).catch(() => { if (!cancelled) setUsdc(null) })
    return () => { cancelled = true }
  }, [address, tick])

  return { address, usdc, refresh }
}
