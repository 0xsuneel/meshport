// src/lib/portfolio.ts
//
// Home's total: every Arc asset at its market price, the way MetaMask / OKX
// count a wallet - sum of (amount held × USD price). USDC is $1; EURC and
// cirBTC use their live prices (lib/eurcPrice, lib/btcPrice). A price that
// isn't known yet counts as 0 for that asset rather than a made-up rate
// (the old fixed EURC × 1.08 inflated the total on every swap).
//
// The 7-day bars: each asset's own end-of-day amounts (balanceTrend with
// { asset }, so a swap moves value between assets instead of creating it),
// valued at today's prices. Pure - unit tested.
import { balanceTrend, type BalanceTrend } from './balanceTrend'

export type Holdings = { USDC: number; EURC: number; cirBTC: number }
export type Prices = { EURC: number; cirBTC: number }

export function portfolioUsd(h: Holdings, p: Prices): number {
  return h.USDC + h.EURC * (p.EURC > 0 ? p.EURC : 0) + h.cirBTC * (p.cirBTC > 0 ? p.cirBTC : 0)
}

type Records = Parameters<typeof balanceTrend>[0]

export function portfolioTrend(records: Records, h: Holdings, p: Prices, now = new Date(), days = 7): BalanceTrend {
  const usdc = balanceTrend(records, h.USDC, now, days, { asset: 'USDC' })
  const eurc = balanceTrend(records, h.EURC, now, days, { asset: 'EURC' })
  const btc = balanceTrend(records, h.cirBTC, now, days, { asset: 'cirBTC' })
  const values = usdc.values.map((_, i) => portfolioUsd({ USDC: usdc.values[i], EURC: eurc.values[i], cirBTC: btc.values[i] }, p))
  return { values, labels: usdc.labels, change: values[values.length - 1] - values[0] }
}
