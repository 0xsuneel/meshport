// supabase/functions/news-sync/index.ts
//
// Fills public.news_items (Home "News" box + News page) from:
//   arc.io/blog, circle.com/blog  — new articles only (cover, summary, the
//                                    opening paragraphs, publish date)
//   status.arc.io/history.rss     — network notices, refreshed every run
//                                    because their status changes
// MeshPort's own posts are written by admins, never here.
//
// Called by pg_cron every 30 minutes (migration 20261008120000_news_items).
// A source that fails or whose layout changed adds nothing, and the stories
// already saved keep showing. {"dryRun": true} returns what would be saved
// without writing.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'
import {
  parseArcBlogList, parseCircleBlogList, parseArticle, parseStatusRss,
  type BlogListEntry,
} from '../_shared/newsParse.ts'

const UA = 'Mozilla/5.0 (compatible; MeshPortNews/1.0; +https://meshport.xyz)'
// New articles read per source per run. The first run backfills this many;
// later runs usually find 0–1 new ones.
const MAX_NEW_PER_SOURCE = 8

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) { console.warn(`[news-sync] ${url} → HTTP ${r.status}`); return null }
    return await r.text()
  } catch (e) {
    console.warn(`[news-sync] ${url} failed:`, e instanceof Error ? e.message : e)
    return null
  }
}

type Row = {
  source: 'arc' | 'circle' | 'arc_status'
  url: string; title: string; summary: string | null; body: string[]
  image_url: string | null; topic: string | null; read_minutes: number | null
  status_label: string | null; published_at: string; fetched_at: string
}

async function readBlog(
  source: 'arc' | 'circle', listUrl: string, list: (html: string) => BlogListEntry[], known: Set<string>,
): Promise<{ rows: Row[]; found: number; error?: string }> {
  const html = await fetchText(listUrl)
  if (!html) return { rows: [], found: 0, error: 'list page unreachable' }
  const entries = list(html)
  if (!entries.length) return { rows: [], found: 0, error: 'no articles found on list page (layout changed?)' }
  const fresh = entries.filter(e => !known.has(e.url)).slice(0, MAX_NEW_PER_SOURCE)
  const now = new Date().toISOString()
  const rows = (await Promise.all(fresh.map(async (e): Promise<Row | null> => {
    const page = await fetchText(e.url)
    if (!page) return null
    const a = parseArticle(page)
    const title = e.title || a.title
    if (!title) return null
    return {
      source, url: e.url, title,
      summary: a.summary, body: a.body,
      image_url: e.image_url || a.image_url,
      topic: e.topic || a.topic,
      read_minutes: e.read_minutes,
      status_label: null,
      // An article whose date can't be read sorts as "now" rather than being dropped.
      published_at: a.published_at || now,
      fetched_at: now,
    }
  }))).filter((r): r is Row => !!r)
  return { rows, found: entries.length }
}

async function readStatus(): Promise<{ rows: Row[]; found: number; error?: string }> {
  const xml = await fetchText('https://status.arc.io/history.rss')
  if (!xml) return { rows: [], found: 0, error: 'status feed unreachable' }
  const now = new Date().toISOString()
  const rows = parseStatusRss(xml, 10).map((s): Row => ({
    source: 'arc_status', url: s.url, title: s.title, summary: s.summary, body: s.body,
    image_url: null, topic: 'Network status', read_minutes: null, status_label: s.status_label,
    published_at: s.published_at || now, fetched_at: now,
  }))
  return { rows, found: rows.length, error: rows.length ? undefined : 'no items in status feed' }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isCronOrLegacyServiceCaller(req)) return json({ error: 'Forbidden' }, 403)
  const { dryRun = false } = await req.json().catch(() => ({}))

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const { data: existing, error: readErr } = await db.from('news_items').select('url').in('source', ['arc', 'circle']).not('url', 'is', null)
  if (readErr) return json({ error: readErr.message }, 500)
  const known = new Set((existing ?? []).map(r => r.url as string))

  const [arc, circle, status] = await Promise.all([
    readBlog('arc', 'https://www.arc.io/blog', html => parseArcBlogList(html), known),
    readBlog('circle', 'https://www.circle.com/blog', html => parseCircleBlogList(html), known),
    readStatus(),
  ])
  const report = {
    arc:    { found: arc.found,    new: arc.rows.length,    error: arc.error },
    circle: { found: circle.found, new: circle.rows.length, error: circle.error },
    status: { found: status.found, upserted: status.rows.length, error: status.error },
  }
  for (const [k, v] of Object.entries(report)) if (v.error) console.warn(`[news-sync] ${k}: ${v.error}`)

  if (dryRun) return json({ dryRun: true, report, rows: [...arc.rows, ...circle.rows, ...status.rows] })

  const blogRows = [...arc.rows, ...circle.rows]
  if (blogRows.length) {
    // ignoreDuplicates: an article saved by an overlapping run is left as is.
    const { error } = await db.from('news_items').upsert(blogRows, { onConflict: 'url', ignoreDuplicates: true })
    if (error) return json({ error: error.message, report }, 500)
  }
  if (status.rows.length) {
    // Status notices change (Scheduled → In progress → Completed), so they're
    // refreshed in place. `hidden` isn't in the payload, so an admin's hide sticks.
    const { error } = await db.from('news_items').upsert(status.rows, { onConflict: 'url' })
    if (error) return json({ error: error.message, report }, 500)
  }
  return json({ ok: true, report })
})
