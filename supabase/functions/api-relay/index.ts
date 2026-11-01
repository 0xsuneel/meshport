// supabase/functions/api-relay/index.ts
//
// A second road to MeshPort's own API for latency-critical calls.
//
// Field 1 Nov: a phone's connection to meshport.xyz stalled for 9-13 s
// (every request to that host waited, then all went at once) while its
// connection to Supabase kept working. A Circle signature waits on
// /api/circle-wallet, so a payment took 17 s. The app now also sends the
// same request here after ~2 s without an answer (src/wallet/circle.ts);
// this function forwards it server-to-server and returns the answer, and
// the app uses whichever arrives first.
//
// Only allow-listed paths; the caller's Authorization header goes along
// unchanged, so the API checks the caller exactly as it would directly.

const ORIGIN = 'https://meshport.xyz'
const ALLOWED = new Set(['/api/circle-wallet'])

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } })
  let path = ''
  let body = ''
  try {
    const j = await req.json()
    path = typeof j?.path === 'string' ? j.path : ''
    body = typeof j?.body === 'string' ? j.body : ''
  } catch { /* bad request below */ }
  if (!ALLOWED.has(path) || !body || body.length > 200_000) {
    return new Response(JSON.stringify({ error: 'Bad relay request' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  try {
    const auth = req.headers.get('Authorization')
    const r = await fetch(ORIGIN + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body,
      signal: AbortSignal.timeout(25_000),
    })
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Relay could not reach the API', code: 'timeout', detail: e instanceof Error ? e.message : String(e) }), { status: 504, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
