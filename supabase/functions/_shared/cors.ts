export const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  return null
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Origin-aware variants — additive, existing exports above are UNCHANGED ──
// so functions already using corsHeaders/handleOptions/json (claim-submit,
// faucet-drip) keep their exact current behavior. New/updated functions that
// return sensitive data (wallet-key) should use these instead: they echo
// back only a configured, known origin (ALLOWED_ORIGIN — the same server-
// only env var already used by api/*.ts for the same purpose) rather than
// '*', while still allowing localhost during local development. If
// ALLOWED_ORIGIN isn't set, falls back to '*' to avoid breaking a fresh
// deploy — set it before launch for anything security-sensitive.
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  const allowed = (Deno.env.get('ALLOWED_ORIGIN') || '').trim()
  const allowOrigin = allowed ? (origin.includes('localhost') ? origin : allowed) : '*'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

export function handleOptionsFor(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeadersFor(req) })
  }
  return null
}

export function jsonFor(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  })
}
