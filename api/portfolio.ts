// api/portfolio.ts - one request for every balance a wallet shows.
//
// GET /api/portfolio?address=0x…
//   → { arc: { USDC, EURC, cirBTC }, chains: { <chainId>: number|null },
//       tokens: { EURC: { <chainId>: { balance, address } }, cirBTC: {…} } | null, at }
//
// tokens: EURC / cirBTC on the chains Circle's CCTPx registry lists them on
// (and on Arc - a route needs both ends), read in the same pass as USDC so
// Bring's coin chips show their chains at once instead of scanning again.
//
// What OKX-style wallets do on a weak connection: the phone asks the server
// once and the server reads the chains. Before this, the app made one request
// per chain (~21 for "Available To Bring", plus Arc) from the phone itself -
// on a slow link they all shared the same thin pipe and timed out.
//
// - Read-only, public data (balances of a public address). No keys involved.
// - Each chain's USDC is read with the chain registry the app already uses
//   (src/blockchain/chains.ts - no 4th copy), first good answer wins.
// - Arc reads go through arc-rpc.js's health-scored upstream race.
// - A null balance means "could not read this chain right now" (the app then
//   keeps its last known value) - never a fake 0.
// - Cached per address for a few seconds so a burst of screens shares one read.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { EXTERNAL_CHAINS, ARC_TOKENS, CCTP_DOMAINS } from '../src/blockchain/chains'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { forward: arcForward } = require('./arc-rpc.js') as { forward: (body: unknown) => Promise<any> }

const CHAIN_TIMEOUT_MS = 3500
const HEDGE_MS = 900
const CACHE_MS = 8000
const MAX_CACHE = 500
const BALANCE_OF = '0x70a08231'

type TokenChains = Record<string, { balance: number | null; address: string }>
type Portfolio = {
  arc: Record<string, number | null>
  chains: Record<string, number | null>
  tokens: { EURC: TokenChains; cirBTC: TokenChains } | null
  at: number
}

// ── EURC / cirBTC (Circle CCTPx) ─────────────────────────────────────────────
// Circle's token registry (IRIS sandbox - testnet chains), cached here for 5
// minutes: which chain (by CCTP domain) each token is deployed and switched on.
const CCTPX_IRIS = (process.env.CCTPX_IRIS || 'https://iris-api-sandbox.circle.com').replace(/\/+$/, '')
const REGISTRY_TTL_MS = 5 * 60_000
const CCTPX_TOKENS = {
  EURC:   { id: '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd', decimals: 6 },
  cirBTC: { id: '0x7c27b7b6485f3ea49b7d1a439e288d3c3116f533302afabb7e372dfc0770cc7d', decimals: 8 },
} as const
type RegistryToken = { tokenId: string; deployments: Array<{ domainId: number; tokenAddress: string; enabled?: boolean }> }
let registry: { at: number; tokens: RegistryToken[] } | null = null
let registryLoad: Promise<RegistryToken[]> | null = null

async function cctpxRegistry(): Promise<RegistryToken[]> {
  if (registry && Date.now() - registry.at < REGISTRY_TTL_MS) return registry.tokens
  registryLoad ??= (async () => {
    const tokens: RegistryToken[] = []
    let after = ''
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${CCTPX_IRIS}/v2/cctpx/tokens${after ? `?pageAfter=${encodeURIComponent(after)}` : ''}`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error('registry http ' + r.status)
      const j = await r.json() as { data?: RegistryToken[]; nextPageAfter?: string | null }
      tokens.push(...(j.data ?? []))
      if (!j.nextPageAfter) break
      after = j.nextPageAfter
    }
    registry = { at: Date.now(), tokens }
    return tokens
  })().finally(() => { registryLoad = null })
  return registryLoad
}

/** chainId → token address where `tokenId` is on and Arc has it too (pure). */
export function tokenChains(tokens: RegistryToken[], tokenId: string): Record<string, string> {
  const byDomain = new Map(Object.entries(CCTP_DOMAINS).map(([id, d]) => [d, id]))
  const t = tokens.find(x => String(x.tokenId).toLowerCase() === tokenId)
  const on = (t?.deployments ?? []).filter(d => d.enabled !== false && /^0x[0-9a-fA-F]{40}$/.test(d.tokenAddress))
  if (!on.some(d => d.domainId === CCTP_DOMAINS.Arc_Testnet)) return {}
  const out: Record<string, string> = {}
  for (const d of on) {
    const id = byDomain.get(d.domainId)
    if (id && id !== 'Arc_Testnet' && EXTERNAL_CHAINS[id]) out[id] = d.tokenAddress
  }
  return out
}

async function readTokens(address: string): Promise<Portfolio['tokens']> {
  let tokens: RegistryToken[]
  try { tokens = await cctpxRegistry() } catch { return null }
  const read = async (symbol: keyof typeof CCTPX_TOKENS): Promise<TokenChains> => {
    const out: TokenChains = {}
    await Promise.all(Object.entries(tokenChains(tokens, CCTPX_TOKENS[symbol].id)).map(async ([id, token]) => {
      const rpcs = (EXTERNAL_CHAINS[id]?.rpcs || []).filter(Boolean)
      let balance: number | null = null
      if (rpcs.length) {
        try {
          const hex = await hedged(rpcs, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: balanceOfData(address) }, 'latest'] })
          balance = hexToUnits(hex, CCTPX_TOKENS[symbol].decimals)
        } catch { /* null: couldn't read it right now */ }
      }
      out[id] = { balance, address: token }
    }))
    return out
  }
  const [EURC, cirBTC] = await Promise.all([read('EURC'), read('cirBTC')])
  return { EURC, cirBTC }
}
const cache = new Map<string, { at: number; data: Portfolio }>()
const inflight = new Map<string, Promise<Portfolio>>()

function balanceOfData(address: string): string {
  return BALANCE_OF + address.toLowerCase().replace('0x', '').padStart(64, '0')
}
function hexToUnits(hex: unknown, decimals: number): number {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) throw new Error('bad result')
  if (hex === '0x' || hex === '0x0') return 0
  return Number(BigInt(hex)) / Math.pow(10, decimals)
}

async function ask(rpc: string, body: unknown): Promise<any> {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('http ' + res.status)
  const json: any = await res.json()
  if (json?.error) throw new Error('rpc error')
  return json.result
}

/** First good answer from a chain's endpoints; the next one is asked if the first is slow. */
function hedged(rpcs: string[], body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const launch = () => {
      if (done || next >= rpcs.length) return
      running++
      ask(rpcs[next++], body).then(
        v => { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
        () => {
          running--
          if (done) return
          if (next < rpcs.length) { clearTimeout(timer); launch(); arm() }
          else if (running === 0) { done = true; reject(new Error('all endpoints failed')) }
        },
      )
    }
    const arm = () => { if (next < rpcs.length) timer = setTimeout(() => { launch(); arm() }, HEDGE_MS) }
    launch(); arm()
  })
}

async function readArc(address: string): Promise<Portfolio['arc']> {
  const call = (to: string) => ({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: balanceOfData(address) }, 'latest'] })
  const [usdc, eurc, btc] = await Promise.allSettled([
    arcForward({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    arcForward(call(ARC_TOKENS.EURC.contract)),
    arcForward(call(ARC_TOKENS.cirBTC.contract)),
  ])
  const pick = (r: PromiseSettledResult<any>, decimals: number) => {
    if (r.status !== 'fulfilled' || r.value?.error) return null
    try { return hexToUnits(r.value?.result, decimals) } catch { return null }
  }
  return {
    // Native USDC balance: 18 decimals (Architecture rule 1).
    USDC: pick(usdc, ARC_TOKENS.USDC.nativeDecimals ?? 18),
    EURC: pick(eurc, ARC_TOKENS.EURC.decimals),
    cirBTC: pick(btc, ARC_TOKENS.cirBTC.decimals),
  }
}

async function readChains(address: string): Promise<Portfolio['chains']> {
  const ids = Object.keys(EXTERNAL_CHAINS)
  const out: Portfolio['chains'] = {}
  await Promise.all(ids.map(async id => {
    const cfg = EXTERNAL_CHAINS[id]
    const rpcs = (cfg.rpcs || []).filter(Boolean)
    if (!rpcs.length) { out[id] = null; return }
    try {
      const hex = await hedged(rpcs, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: cfg.usdc, data: balanceOfData(address) }, 'latest'] })
      out[id] = hexToUnits(hex, cfg.decimals)
    } catch { out[id] = null }
  }))
  return out
}

async function load(address: string): Promise<Portfolio> {
  const [arc, chains, tokens] = await Promise.all([readArc(address), readChains(address), readTokens(address)])
  return { arc, chains, tokens, at: Date.now() }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin || '')
  const localDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  res.setHeader('Access-Control-Allow-Origin', localDev ? origin : (process.env.ALLOWED_ORIGIN || '*'))
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const address = String(req.query.address || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid address' })
  const key = address.toLowerCase()
  // Personal data: never stored by shared caches.
  res.setHeader('Cache-Control', 'private, no-store')

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return res.status(200).json(hit.data)
  try {
    let p = inflight.get(key)
    if (!p) {
      p = load(address).finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    const data = await p
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string) // drop the oldest only
    cache.set(key, { at: Date.now(), data })
    return res.status(200).json(data)
  } catch (e: any) {
    console.error('[portfolio] failed:', e?.message)
    return res.status(502).json({ error: 'Balances unavailable' })
  }
}
