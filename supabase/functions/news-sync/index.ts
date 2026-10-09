// supabase/functions/news-sync/index.ts
//
// Fills public.news_items (Home "News" box + News page) from:
//   arc.io/blog, circle.com/blog  - new articles only (cover, summary, the
//                                    opening paragraphs, publish date)
//   status.arc.io/history.rss     - network notices, refreshed every run
//                                    because their status changes
//   developer updates (circle_dev) - Circle's CCTP and Gateway release
//                                    notes, and the App Kit / Bridge Kit
//                                    changelogs shipped on npm
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
  parseReleaseNotesMd, parseChangelogMd,
  type BlogListEntry, type DevUpdateEntry,
} from '../_shared/newsParse.ts'

const UA = 'Mozilla/5.0 (compatible; MeshPortNews/1.0; +https://meshport.xyz)'
// New articles read per source per run. The first run backfills this many;
// later runs usually find 0–1 new ones.
const MAX_NEW_PER_SOURCE = 8
// Only the newest this-many articles on a list page are considered, so a
// list with hundreds of posts (circle.com/blog-all) backfills a sensible
// history instead of years of it.
const LIST_DEPTH = 60

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
  source: 'arc' | 'circle' | 'arc_status' | 'circle_dev'
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
  const fresh = entries.slice(0, LIST_DEPTH).filter(e => !known.has(e.url)).slice(0, MAX_NEW_PER_SOURCE)
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
  if (source === 'arc') keepListOrder(rows)
  return { rows, found: entries.length }
}

// arc.io shows no date on its articles; the only one in the page is the
// CMS publish time, which a site-wide republish resets (a whole batch of old
// posts came back stamped with the same second). The list page is
// newest-first, so a story is never dated later than the one listed above it.
function keepListOrder(rows: { published_at: string }[]) {
  for (let i = 1; i < rows.length; i++) {
    const cap = Date.parse(rows[i - 1].published_at) - 1000
    if (Date.parse(rows[i].published_at) > cap) rows[i].published_at = new Date(cap).toISOString()
  }
}

// Circle's release notes (one page per product per year, as Markdown) and
// the Kits' changelogs (CHANGELOG.md inside the npm package; release dates
// from the npm registry).
const RELEASE_NOTES = [
  { product: 'CCTP', slug: 'cctp' },
  { product: 'Gateway', slug: 'gateway' },
]
// Release notes and changelogs carry no picture, so each product's updates
// use the cover of its own launch article on circle.com / arc.io (read every
// run, so it follows whatever image Circle / Arc currently publish there).
const PRODUCT_COVER_ARTICLES: Record<string, string> = {
  'CCTP': 'https://www.circle.com/blog/migrate-to-cctp-v2-ahead-of-cctp-v1-legacy-deprecation',
  'Gateway': 'https://www.circle.com/blog/circle-gateway-redefining-crosschain-ux',
  'Bridge Kit': 'https://www.circle.com/blog/introducing-bridge-kit-build-crosschain-apps-faster',
  'App Kit': 'https://www.arc.io/blog/app-kits-a-suite-of-sdks-to-build-onchain',
}

async function productCovers(): Promise<Record<string, string>> {
  const pairs = await Promise.all(Object.entries(PRODUCT_COVER_ARTICLES).map(async ([product, url]) => {
    const html = await fetchText(url)
    return [product, html ? parseArticle(html).image_url : null] as const
  }))
  return Object.fromEntries(pairs.filter((p): p is readonly [string, string] => !!p[1]))
}
const KIT_PACKAGES = [
  { product: 'App Kit', pkg: '@circle-fin/app-kit' },
  { product: 'Bridge Kit', pkg: '@circle-fin/bridge-kit' },
]

async function readDevUpdates(): Promise<{ rows: Row[]; found: number; error?: string }> {
  const year = new Date().getUTCFullYear()
  const now = new Date().toISOString()
  const errors: string[] = []
  const notes = RELEASE_NOTES.map(async ({ product, slug }) => {
    const out: DevUpdateEntry[] = []
    // January: last year's page still holds the recent updates.
    for (const y of new Date().getUTCMonth() === 0 ? [year, year - 1] : [year]) {
      const pageUrl = `https://developers.circle.com/release-notes/${slug}-${y}`
      const md = await fetchText(`${pageUrl}.md`)
      if (md) out.push(...parseReleaseNotesMd(md, product, pageUrl))
    }
    if (!out.length) errors.push(`${product} release notes: nothing read`)
    return out
  })
  const kits = KIT_PACKAGES.map(async ({ product, pkg }) => {
    const [md, meta] = await Promise.all([
      fetchText(`https://unpkg.com/${pkg}/CHANGELOG.md`),
      fetchText(`https://registry.npmjs.org/${pkg}`),
    ])
    let times: Record<string, string> = {}
    try { times = meta ? JSON.parse(meta).time ?? {} : {} } catch { /* unreadable registry reply */ }
    const out = md ? parseChangelogMd(md, product, pkg, times) : []
    if (!out.length) errors.push(`${product} changelog: nothing read`)
    return out
  })
  const [entries, covers] = await Promise.all([Promise.all([...notes, ...kits]).then(r => r.flat()), productCovers()])
  const rows = entries.map((e): Row => ({
    source: 'circle_dev', url: e.url, title: e.title, summary: e.summary, body: e.body,
    image_url: covers[e.topic] ?? null, topic: e.topic, read_minutes: null, status_label: null,
    published_at: e.published_at, fetched_at: now,
  }))
  return { rows, found: rows.length, error: errors.length ? errors.join('; ') : undefined }
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

  const [arc, circle, status, dev] = await Promise.all([
    readBlog('arc', 'https://www.arc.io/blog', html => parseArcBlogList(html), known),
    // blog-all lists every post newest first; /blog only shows the latest 10.
    readBlog('circle', 'https://www.circle.com/blog-all', html => parseCircleBlogList(html), known),
    readStatus(),
    readDevUpdates(),
  ])
  const report = {
    arc:    { found: arc.found,    new: arc.rows.length,    error: arc.error },
    circle: { found: circle.found, new: circle.rows.length, error: circle.error },
    status: { found: status.found, upserted: status.rows.length, error: status.error },
    dev:    { found: dev.found, error: dev.error },
  }
  for (const [k, v] of Object.entries(report)) if (v.error) console.warn(`[news-sync] ${k}: ${v.error}`)

  if (dryRun) return json({ dryRun: true, report, rows: [...arc.rows, ...circle.rows, ...status.rows, ...dev.rows] })

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
  if (dev.rows.length) {
    // A cover article that didn't load this run never wipes a cover saved earlier.
    const missing = dev.rows.filter(r => !r.image_url).map(r => r.url)
    if (missing.length) {
      const { data: had } = await db.from('news_items').select('url,image_url').in('url', missing).not('image_url', 'is', null)
      const keep = new Map((had ?? []).map(h => [h.url as string, h.image_url as string]))
      for (const r of dev.rows) if (!r.image_url && keep.has(r.url)) r.image_url = keep.get(r.url)!
    }
    // Saved on their own so a problem here never holds back the blog stories.
    // Refreshed in place (a wording fix or a new cover shows up); `hidden`
    // isn't in the payload, so an admin's hide sticks.
    const { error } = await db.from('news_items').upsert(dev.rows, { onConflict: 'url' })
    if (error) { console.warn('[news-sync] dev updates:', error.message); return json({ ok: false, error: error.message, report }, 500) }
  }
  return json({ ok: true, report })
})
