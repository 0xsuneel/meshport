// lib/hedgedApi.ts
//
// A POST to MeshPort's API that doesn't hang on a stalled connection.
//
// Field 1 Nov (wallet_events + Supabase/Vercel logs): twice a phone's
// connection to meshport.xyz went quiet for 9-13 s - every request to that
// host waited, then all arrived at once - while its connection to Supabase
// kept working. A Circle signature waits on /api/circle-wallet, so a 4 s
// payment took 17 s. Browsers give a page no way to drop a stalled
// connection, so after `hedgeAfterMs` without an answer the same request is
// also sent through Supabase (edge function api-relay, which forwards it
// server-to-server). Whichever answers first is used. Same idea as the Arc
// RPC hedge (blockchain/arc.ts directSendHedge).
//
// Only for requests where a duplicate is harmless (creating a signing
// challenge: the unused one simply expires).

export interface HedgedResult { res: Response; via: 'direct' | 'relay' }

export interface HedgeOptions {
  hedgeAfterMs: number
  timeoutMs: number
  /** Sends the same request the second way. */
  relay: (signal: AbortSignal) => Promise<Response>
  /** Sends it directly. */
  direct: (signal: AbortSignal) => Promise<Response>
}

/**
 * Only a successful relay answer wins outright. Any other (the relay or its
 * gateway refusing, or the API's own error) waits for the direct answer, and
 * is used only if that never comes.
 */
const relayFailed = (r: Response) => !r.ok

export function hedgedFetch(o: HedgeOptions): Promise<HedgedResult> {
  return new Promise<HedgedResult>((resolve, reject) => {
    const directCtl = new AbortController()
    const relayCtl = new AbortController()
    let settled = false
    let directDone = false
    let relayStarted = false
    let relayDone = false
    let lastError: unknown = null
    let lastRelayResponse: Response | null = null

    const finish = (r: HedgedResult | null, err?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(hedgeTimer)
      clearTimeout(overall)
      if (r) {
        const loser = r.via === 'direct' ? relayCtl : directCtl
        loser.abort()
        resolve(r)
      } else {
        directCtl.abort(); relayCtl.abort()
        reject(err)
      }
    }
    const bothDone = () => directDone && (!relayStarted || relayDone)
    const giveUp = () => {
      if (lastRelayResponse) finish({ res: lastRelayResponse, via: 'relay' })
      else finish(null, lastError ?? new Error('No answer'))
    }

    const startRelay = () => {
      if (relayStarted || settled) return
      relayStarted = true
      o.relay(relayCtl.signal).then(res => {
        relayDone = true
        if (!relayFailed(res)) { finish({ res, via: 'relay' }); return }
        lastRelayResponse = res
        if (bothDone()) giveUp()
      }, e => {
        relayDone = true
        lastError = lastError ?? e
        if (bothDone()) giveUp()
      })
    }

    o.direct(directCtl.signal).then(res => finish({ res, via: 'direct' }), e => {
      directDone = true
      lastError = e
      // Failed fast (offline, reset): try the other road now.
      if (!relayStarted) startRelay()
      else if (bothDone()) giveUp()
    })

    const hedgeTimer = setTimeout(startRelay, o.hedgeAfterMs)
    const overall = setTimeout(() => {
      if (lastRelayResponse) { finish({ res: lastRelayResponse, via: 'relay' }); return }
      const e = new Error('timed out'); e.name = 'TimeoutError'
      finish(null, e)
    }, o.timeoutMs)
  })
}
