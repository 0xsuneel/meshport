// supabase/functions/pay-intent/hedgedRpc.ts
//
// Arc JSON-RPC with a hedge, for pay-intent's nonce read - the one chain
// call every Pay waits on before it can sign.
//
// It used to try the nodes strictly one after another, 10 s each: a node
// that rate-limited (HTTP 429) or stalled held the payment until it gave up.
// Field 3 Nov 10:20-10:31: create calls took 0.5-6.7 s, while the same
// function answered markSubmitted (no chain read) in ~0.1 s.
//
// Now: ask the first node; every HEDGE_MS without an answer, also ask the
// next one; a node that fails asks the next one at once. The first good
// answer wins and the rest are cancelled. Each node gets NODE_TIMEOUT_MS.
// Plain TypeScript (no Deno APIs), so it is tested with the app's vitest.

export const HEDGE_MS = 300
export const NODE_TIMEOUT_MS = 3000

export interface RpcAnswer { result: unknown; url: string; ms: number }

export function hedgedRpc(
  urls: string[],
  method: string,
  params: unknown[],
  opts: { fetch?: typeof fetch; hedgeMs?: number; nodeTimeoutMs?: number } = {},
): Promise<RpcAnswer> {
  const doFetch = opts.fetch ?? fetch
  const hedgeMs = opts.hedgeMs ?? HEDGE_MS
  const nodeTimeoutMs = opts.nodeTimeoutMs ?? NODE_TIMEOUT_MS
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false
    let next = 0
    let running = 0
    let lastErr: unknown = null
    const controllers: AbortController[] = []
    let timer: ReturnType<typeof setInterval> | null = null
    const finish = () => {
      settled = true
      if (timer) clearInterval(timer)
      for (const c of controllers) c.abort()
    }
    const launch = () => {
      if (settled || next >= urls.length) return
      const url = urls[next++]
      running++
      const ac = new AbortController()
      controllers.push(ac)
      const timeout = setTimeout(() => ac.abort(), nodeTimeoutMs)
      doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ac.signal,
      })
        .then(async res => {
          if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`)
          const j = await res.json() as { result?: unknown; error?: unknown }
          if (j.error) throw j.error
          if (j.result === undefined) throw new Error(`no result from ${url}`)
          return j.result
        })
        .then(result => {
          if (settled) return
          finish()
          resolve({ result, url, ms: Date.now() - t0 })
        })
        .catch(e => {
          if (settled) return
          lastErr = e
          launch() // failed fast: the next node now, not after the hedge delay
        })
        .finally(() => {
          clearTimeout(timeout)
          running--
          if (!settled && running === 0 && next >= urls.length) {
            finish()
            reject(lastErr ?? new Error(`RPC call ${method} failed on all endpoints`))
          }
        })
    }
    if (!urls.length) { reject(new Error('no RPC endpoints')); return }
    launch()
    timer = setInterval(() => { if (settled || next >= urls.length) { if (timer) clearInterval(timer) } else launch() }, hedgeMs)
  })
}
