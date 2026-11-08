// supabase/functions/chat-expiry/index.ts
//
// Daily (pg_cron 'chat-expiry', migration 20261108150000_chat_expiry.sql):
// drops chat content that was never delivered within 30 days - waiting
// mailbox messages and chat files (attachments/chat/…) - so Supabase never
// keeps chat data for good. Delivered messages and downloaded files are
// already gone (deleted on delivery). Payment cards are not touched.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isCronOrLegacyServiceCaller(req)) return json({ error: 'Forbidden' }, 403)
  const { days = 30, dryRun = false } = await req.json().catch(() => ({}))
  const d = Math.max(1, Math.min(365, Number(days) || 30))

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

  // 1. Files, in batches, through the Storage API (removes the bytes too).
  let files = 0
  for (let round = 0; round < 40; round++) {
    const { data: names, error } = await db.rpc('chat_expired_files', { p_days: d, p_limit: 500 })
    if (error) return json({ error: error.message, files }, 500)
    const list = (names ?? []) as string[]
    if (!list.length) break
    if (dryRun) { files += list.length; break }
    const { error: rmErr } = await db.storage.from('attachments').remove(list)
    if (rmErr) return json({ error: rmErr.message, files }, 500)
    files += list.length
    if (list.length < 500) break
  }

  // 2. Undelivered mailbox rows.
  let messages = 0
  if (!dryRun) {
    const { data, error } = await db.rpc('chat_expire_mail', { p_days: d })
    if (error) return json({ error: error.message, files }, 500)
    messages = Number(data) || 0
  }

  console.log('[chat-expiry]', JSON.stringify({ days: d, dryRun, files, messages }))
  return json({ ok: true, days: d, dryRun, files, messages })
})
