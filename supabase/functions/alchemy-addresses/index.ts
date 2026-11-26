// supabase/functions/alchemy-addresses/index.ts
//
// Keeps every Alchemy Address Activity webhook (one per network, listed in
// public.alchemy_webhooks) tracking exactly MeshPort's user wallets.
//
//   { add: [...], remove: [...] }  one wallet changed - called by the users
//                                  table trigger (users_alchemy_track)
//   { mode: 'full' }               add every user wallet (idempotent): after
//                                  creating the webhooks, and as a daily safety
//                                  net in case a trigger call was lost
//
// Server-only: requires the cron/service secret. Alchemy auth token: secret
// ALCHEMY_NOTIFY_TOKEN (Alchemy dashboard -> Webhooks -> Auth token).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'
import { getServiceRoleKey } from '../_shared/serviceKey.ts'

const API = 'https://dashboard.alchemy.com/api/update-webhook-addresses'
const CHUNK = 500   // Alchemy's limit per add/remove call
const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

async function patch(token: string, webhookId: string, add: string[], remove: string[]): Promise<string | null> {
  for (let i = 0; i < Math.max(add.length, remove.length, 1); i += CHUNK) {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Alchemy-Token': token },
      body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: add.slice(i, i + CHUNK), addresses_to_remove: remove.slice(i, i + CHUNK) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return `${res.status} ${(await res.text()).slice(0, 200)}`
  }
  return null
}

Deno.serve(async (req) => {
  if (!isCronOrLegacyServiceCaller(req)) return json({ error: 'Forbidden' }, 403)
  let body: { mode?: string; add?: unknown[]; remove?: unknown[] } = {}
  try { body = await req.json() } catch { /* empty body */ }

  const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', getServiceRoleKey(), { auth: { persistSession: false } })
  // The token: the ALCHEMY_NOTIFY_TOKEN secret, else the vault secret
  // 'alchemy_notify_token' (public.alchemy_notify_token(), service role only).
  let token = (Deno.env.get('ALCHEMY_NOTIFY_TOKEN') ?? '').trim()
  if (!token) {
    const { data } = await db.rpc('alchemy_notify_token')
    token = String(data ?? '').trim()
  }
  if (!token) return json({ error: 'Alchemy auth token not set (secret ALCHEMY_NOTIFY_TOKEN or vault alchemy_notify_token)' }, 503)
  const { data: hooks, error } = await db.from('alchemy_webhooks').select('network, webhook_id').eq('active', true)
  if (error) return json({ error: error.message }, 500)

  let add = (body.add ?? []).filter(isAddr).map(a => a.toLowerCase())
  const remove = (body.remove ?? []).filter(isAddr).map(a => a.toLowerCase())
  if (body.mode === 'full') {
    const { data, error: wErr } = await db.rpc('indexer_wallets')
    if (wErr) return json({ error: wErr.message }, 500)
    add = ((data as string[] | null) ?? []).filter(isAddr)
  }
  if (!add.length && !remove.length) return json({ ok: true, note: 'nothing to change' })

  const failures: Record<string, string> = {}
  await Promise.all((hooks ?? []).map(async h => {
    const err = await patch(token, h.webhook_id, add, remove)
    if (err) failures[h.network] = err
  }))
  if (Object.keys(failures).length) console.error('[alchemy-addresses] failed:', JSON.stringify(failures))
  return json({ ok: Object.keys(failures).length === 0, webhooks: hooks?.length ?? 0, added: add.length, removed: remove.length, failures }, Object.keys(failures).length ? 502 : 200)
})
