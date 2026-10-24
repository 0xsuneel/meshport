// server/circle/client.ts
//
// A small client for Circle's User-Controlled Wallets API
// (https://developers.circle.com/openapi/user-controlled-wallets.yaml).
// The API key (PREFIX:ID:SECRET) stays on the server; calls made for a user
// also carry that user's Circle session as X-User-Token.

export class CircleApiError extends Error {
  constructor(public status: number, public code: number | undefined, message: string) { super(message) }
}

/** Circle error codes this app acts on (from Circle's SDK docs). */
export const CIRCLE_ERR = {
  userTokenExpired: 155104,
  userWasInitialized: 155106,
} as const

export interface CircleRequest {
  userToken?: string
  body?: Record<string, unknown>
  query?: Record<string, string | undefined>
}

export interface CircleClient {
  request<T>(method: 'GET' | 'POST', path: string, req?: CircleRequest): Promise<T>
}

export function createCircleClient(opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): CircleClient {
  if (!/^[^:\s]+:[^:\s]+:[^:\s]+$/.test(opts.apiKey)) throw new Error('CIRCLE_API_KEY must look like PREFIX:ID:SECRET')
  const f = opts.fetch ?? fetch
  const base = (opts.baseUrl ?? 'https://api.circle.com').replace(/\/$/, '')
  return {
    async request<T>(method: 'GET' | 'POST', path: string, req: CircleRequest = {}): Promise<T> {
      const url = new URL(base + path)
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
      const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' }
      if (req.userToken) headers['X-User-Token'] = req.userToken
      if (req.body) headers['Content-Type'] = 'application/json'
      const r = await f(url.toString(), {
        method, headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
      const json = await r.json().catch(() => null) as { data?: T; code?: number; message?: string } | null
      if (!r.ok) throw new CircleApiError(r.status, json?.code, json?.message || `Circle API error (${r.status})`)
      return (json?.data ?? json) as T
    },
  }
}
