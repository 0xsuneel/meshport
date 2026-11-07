// Hedged reads over a chain's RPC list (api/bridge-relay rpcTransport).
//
// viem's fallback tries RPCs one after another, each with its own timeout: a
// hanging first RPC costs that whole timeout on every read, and a cold quote
// makes several reads (Bring quotes from Ethereum took 26-44 s on 7 Nov).
// Here a read goes to the first RPC; if no answer within `hedgeMs`, the next
// one is asked too (up to `maxParallel`), and the first good answer wins.
// Sends (eth_sendRawTransaction) and anything else keep the plain fallback
// order - one node at a time, and so does the nonce (eth_getTransactionCount):
// a lagging node's pending count would make the send fail.

export const HEDGED_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBlockByNumber', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs',
])

type Req = (args: { method: string; params?: unknown }, opts?: unknown) => Promise<unknown>

/** Races `requests` (in order, staggered by `hedgeMs`, at most `maxParallel`); the first success wins. */
export function hedgedRequest(requests: Req[], args: { method: string; params?: unknown }, hedgeMs = 1_200, maxParallel = 3): Promise<unknown> {
  const pool = requests.slice(0, Math.max(1, maxParallel))
  return new Promise((resolve, reject) => {
    let next = 0, inFlight = 0, done = false
    let lastErr: unknown = new Error('No RPC answered')
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => { done = true; if (timer) clearTimeout(timer) }
    const launch = () => {
      if (done || next >= pool.length) return
      const req = pool[next++]
      inFlight++
      if (next < pool.length) { if (timer) clearTimeout(timer); timer = setTimeout(launch, hedgeMs) }
      req(args).then(
        v => { if (!done) { finish(); resolve(v) } },
        e => {
          inFlight--
          lastErr = e
          if (done) return
          if (next < pool.length) launch() // failed fast: don't wait for the hedge timer
          else if (inFlight === 0) { finish(); reject(lastErr) }
        },
      )
    }
    launch()
  })
}

/**
 * A viem transport: hedged reads over `urls`, `fallbackTransport` for the rest.
 * `http` / `fallback` are viem's (passed in, so this file has no viem import).
 */
export function hedgedTransport(http: any, fallback: any, urls: string[], o: { timeoutMs?: number; hedgeMs?: number } = {}) {
  const each = urls.map(u => http(u, { timeout: o.timeoutMs ?? 8_000, retryCount: 0 }))
  const fb = fallback(each, { retryCount: 1 })
  return (config: any) => {
    const base = fb(config)
    const singles = each.map((t: any) => t(config))
    return {
      ...base,
      request: (args: any, opts?: any) => HEDGED_METHODS.has(args?.method)
        ? hedgedRequest(singles.map((s: any) => (a: any) => s.request(a)), args, o.hedgeMs)
        : base.request(args, opts),
    }
  }
}
