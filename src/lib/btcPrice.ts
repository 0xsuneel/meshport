// BTC price in USD (for cirBTC values). Tries several public sources in
// order - CoinGecko often rate-limits its free tier. Returns 0 when none
// answer. Cached for a minute so screens opening together share one fetch.
let cached: { at: number; price: number } | null = null
let inflight: Promise<number> | null = null

const sources: Array<() => Promise<number>> = [
  async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`)
    const p = (await r.json())?.bitcoin?.usd
    if (!p) throw new Error('No price')
    return p as number
  },
  async () => {
    // Binance public API - no auth needed
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`Binance ${r.status}`)
    const p = parseFloat((await r.json())?.price ?? '0')
    if (!p) throw new Error('No price')
    return p
  },
  async () => {
    // CoinCap - reliable fallback
    const r = await fetch('https://api.coincap.io/v2/assets/bitcoin', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`CoinCap ${r.status}`)
    const p = parseFloat((await r.json())?.data?.priceUsd ?? '0')
    if (!p) throw new Error('No price')
    return p
  },
]

export async function fetchBtcPriceUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < 60_000) return cached.price
  if (inflight) return inflight
  inflight = (async () => {
    for (const source of sources) {
      try {
        const price = await source()
        cached = { at: Date.now(), price }
        return price
      } catch { /* try next */ }
    }
    return 0
  })().finally(() => { inflight = null })
  return inflight
}
