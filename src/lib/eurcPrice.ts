// EURC price in USD (for EURC values and the portfolio total). EURC tracks the
// euro, so the sources are the euro-coin market price first, then the
// EUR/USD rate. Cached for a minute so screens opening together share one
// fetch; the last price is kept on the device (lastKnownEurcPrice) so a
// total can show at once on the next open instead of waiting for the network.
// Returns 0 when no source answers and none was ever known - never a guess.
const KEY = 'meshport_eurc_price'
let cached: { at: number; price: number } | null = null
let inflight: Promise<number> | null = null

const sources: Array<() => Promise<number>> = [
  async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`)
    const p = (await r.json())?.['euro-coin']?.usd
    if (!p) throw new Error('No price')
    return p as number
  },
  async () => {
    // Binance public API - EUR/USDT, no auth needed
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`Binance ${r.status}`)
    const p = parseFloat((await r.json())?.price ?? '0')
    if (!p) throw new Error('No price')
    return p
  },
  async () => {
    // Frankfurter (ECB reference rates) - EUR -> USD
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`Frankfurter ${r.status}`)
    const p = (await r.json())?.rates?.USD
    if (!p) throw new Error('No price')
    return p as number
  },
]

/** The last price fetched on this device (0 if never). */
export function lastKnownEurcPrice(): number {
  if (cached) return cached.price
  try { const p = parseFloat(localStorage.getItem(KEY) || '0'); return p > 0 ? p : 0 } catch { return 0 }
}

export async function fetchEurcPriceUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < 60_000) return cached.price
  if (inflight) return inflight
  inflight = (async () => {
    for (const source of sources) {
      try {
        const price = await source()
        // A euro stablecoin: anything far outside the euro's range is a bad answer.
        if (!(price > 0.5 && price < 2)) throw new Error('Out of range')
        cached = { at: Date.now(), price }
        try { localStorage.setItem(KEY, String(price)) } catch { /* storage blocked */ }
        return price
      } catch { /* try next */ }
    }
    return lastKnownEurcPrice()
  })().finally(() => { inflight = null })
  return inflight
}
