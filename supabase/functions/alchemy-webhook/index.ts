// supabase/functions/alchemy-webhook/index.ts
//
// Incoming money, pushed by Alchemy's Address Activity webhooks instead of
// MeshPort scanning every chain. See lib.ts for the mapping and checks.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { INDEXED_CHAINS } from '../blockchain-indexer/chains.ts'
import { getServiceRoleKey } from '../_shared/serviceKey.ts'
import { ALCHEMY_NETWORKS, type AlchemyActivity, toChainEvent, validSignature } from './lib.ts'

const lc = (a?: string | null) => (a ?? '').toLowerCase()
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const body = await req.text()
  const keys = (Deno.env.get('ALCHEMY_WEBHOOK_SIGNING_KEYS') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!keys.length) { console.error('[alchemy-webhook] ALCHEMY_WEBHOOK_SIGNING_KEYS not set'); return json({ error: 'not configured' }, 503) }
  if (!(await validSignature(body, req.headers.get('x-alchemy-signature') ?? '', keys))) return json({ error: 'Forbidden' }, 403)

  let payload: { type?: string; event?: { network?: string; activity?: AlchemyActivity[] } }
  try { payload = JSON.parse(body) } catch { return json({ error: 'bad json' }, 400) }
  const chainId = ALCHEMY_NETWORKS[payload.event?.network ?? '']
  const chain = INDEXED_CHAINS.find(c => c.id === chainId)
  // Unknown network: acknowledge so Alchemy does not retry forever.
  if (!chain) return json({ ok: true, ignored: payload.event?.network ?? null })

  const activity = payload.event?.activity ?? []
  const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', getServiceRoleKey(), { auth: { persistSession: false } })

  // Reorged-out activity: mark what it produced, never delete.
  const removed = activity.filter(a => a.log?.removed && a.hash).map(a => lc(a.hash))
  if (removed.length) {
    const { error } = await db.from('chain_events').update({ status: 'reorged', reorged_at: new Date().toISOString() })
      .eq('chain_id', chain.id).in('tx_hash', removed)
    if (error) console.error('[alchemy-webhook] reorg mark failed:', error.message)
  }

  const rows = activity.filter(a => !a.log?.removed).map(a => toChainEvent(chain, a)).filter(Boolean) as Array<Record<string, unknown>>
  if (!rows.length) return json({ ok: true, chain: chain.id, recorded: 0 })

  // Only MeshPort users: the webhook also reports what tracked addresses send.
  const { data: ours, error: matchErr } = await db.rpc('indexer_match_wallets', { p_addrs: [...new Set(rows.map(r => String(r.wallet_address)))] })
  if (matchErr) { console.error('[alchemy-webhook] wallet match failed:', matchErr.message); return json({ error: 'retry' }, 500) }
  const mine = new Set(((ours as string[] | null) ?? []).map(lc))
  const toInsert = rows.filter(r => mine.has(String(r.wallet_address)))
  if (!toInsert.length) return json({ ok: true, chain: chain.id, recorded: 0 })

  // A duplicate is a redelivery, or the indexer got there first. Postgres
  // rejects the whole batch for one duplicate, so then insert one by one.
  const { error } = await db.from('chain_events').insert(toInsert)
  if (error && error.code !== '23505') { console.error('[alchemy-webhook] insert failed:', error.message); return json({ error: 'retry' }, 500) }
  if (error) {
    let recorded = 0
    for (const r of toInsert) {
      const { error: e } = await db.from('chain_events').insert(r)
      if (!e) recorded++
      else if (e.code !== '23505') { console.error('[alchemy-webhook] insert failed:', e.message); return json({ error: 'retry' }, 500) }
    }
    return json({ ok: true, chain: chain.id, recorded })
  }
  return json({ ok: true, chain: chain.id, recorded: toInsert.length })
})
