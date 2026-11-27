/**
 * useArcAssets - a business's tokens on Arc (USDC, EURC, cirBTC), with their
 * dollar value at live prices, for the Balance tab. USDC comes from the
 * wallet store; EURC and cirBTC are read here (last amounts saved per wallet
 * show at once, as on personal Home).
 */
import { useEffect, useState } from 'react'
import { useWalletStore } from '@/store'
import { readArcBalanceOrThrow } from '@/blockchain/BlockchainManager'
import { loadAssetSlot, saveAssetSlot } from '@/lib/assetSlot'
import { fetchBtcPriceUsd, lastKnownBtcPrice } from '@/lib/btcPrice'
import { fetchEurcPriceUsd, lastKnownEurcPrice } from '@/lib/eurcPrice'

export interface ArcAssetRow {
  symbol: 'USDC' | 'EURC' | 'cirBTC'
  name: string
  icon: string
  amount: number
  /** Dollar value; null while the price isn't known yet. */
  usd: number | null
}

export function useArcAssets(wallet: string | null, active: boolean) {
  const usdc = useWalletStore(s => s.balance)
  const [slot, setSlot] = useState(() => loadAssetSlot(wallet))
  const [eurcPrice, setEurcPrice] = useState(() => lastKnownEurcPrice())
  const [btcPrice, setBtcPrice] = useState(() => lastKnownBtcPrice())

  useEffect(() => {
    if (!active || !wallet) return
    let live = true
    setSlot(loadAssetSlot(wallet))
    readArcBalanceOrThrow(wallet, 'EURC').then(v => { if (live) { setSlot(s => ({ ...s, eurc: v })); saveAssetSlot(wallet, { eurc: v }) } }).catch(() => {})
    readArcBalanceOrThrow(wallet, 'CIRBTC').then(v => { if (live) { setSlot(s => ({ ...s, cirbtc: v })); saveAssetSlot(wallet, { cirbtc: v }) } }).catch(() => {})
    fetchEurcPriceUsd().then(p => { if (live && p > 0) setEurcPrice(p) }).catch(() => {})
    fetchBtcPriceUsd().then(p => { if (live && p > 0) setBtcPrice(p) }).catch(() => {})
    return () => { live = false }
  }, [wallet, active])

  const rows: ArcAssetRow[] = [
    { symbol: 'USDC', name: 'US Dollar', icon: '/logos/tokens/usdc.png', amount: usdc, usd: usdc },
    { symbol: 'EURC', name: 'Euro', icon: '/logos/tokens/eurc.png', amount: slot.eurc, usd: eurcPrice > 0 ? slot.eurc * eurcPrice : slot.eurc ? null : 0 },
    { symbol: 'cirBTC', name: 'Bitcoin', icon: '/logos/tokens/cirbtc.png', amount: slot.cirbtc, usd: btcPrice > 0 ? slot.cirbtc * btcPrice : slot.cirbtc ? null : 0 },
  ]
  const total = rows.reduce((t, r) => t + (r.usd ?? 0), 0)
  return { rows, total }
}
