// ── News - Home "News" box, /news list, /news/:id short article ─────────────
// Stories live in public.news_items: Arc and Circle blog posts, Circle
// developer updates (CCTP / Gateway release notes, App Kit / Bridge Kit
// releases), Arc network notices (filled every 30 minutes by the news-sync edge function)
// and MeshPort's own posts (written by admins). The app only ever reads.
// "Read full article" opens `url` on the original site.

import { supabase } from './supabase'

export type NewsSource = 'arc' | 'circle' | 'circle_dev' | 'arc_status' | 'meshport'

export interface NewsItem {
  id: string
  source: NewsSource
  url: string | null
  title: string
  summary: string | null
  body: string[]
  image_url: string | null
  topic: string | null
  read_minutes: number | null
  status_label: string | null
  published_at: string
}

const COLUMNS = 'id,source,url,title,summary,body,image_url,topic,read_minutes,status_label,published_at'

export const NEWS_SOURCE_LABEL: Record<NewsSource, string> = {
  arc: 'Arc',
  circle: 'Circle',
  circle_dev: 'Developer',
  arc_status: 'Arc status',
  meshport: 'MeshPort',
}

/** Background shown behind (or instead of) a story's cover image. */
export const NEWS_SOURCE_TINT: Record<NewsSource, string> = {
  arc: 'linear-gradient(135deg, #0E3B37, #1F8A7E)',
  circle: 'linear-gradient(135deg, #1C2340, #4E5BD1)',
  circle_dev: 'linear-gradient(135deg, #10172A, #3B4A6B)',
  arc_status: 'linear-gradient(135deg, #3B1F0F, #C9702E)',
  meshport: 'linear-gradient(135deg, #0F5C57, #2F9E8F)',
}

/** Where "Read full article" goes, as shown on the button. */
export function newsHost(item: Pick<NewsItem, 'url'>): string | null {
  if (!item.url) return null
  try { return new URL(item.url).hostname.replace(/^www\./, '') } catch { return null }
}

// A status notice is "live" (shown pinned at the top of /news) until Arc marks
// it finished, and never for more than a week after its last update.
const FINISHED_STATUS = /^(resolved|completed|postmortem)$/i
export function isLiveStatusNotice(item: NewsItem, now = Date.now()): boolean {
  if (item.source !== 'arc_status') return false
  if (item.status_label && FINISHED_STATUS.test(item.status_label)) return false
  return now - new Date(item.published_at).getTime() < 7 * 86_400_000
}

export function newsDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
  if (days <= 0 && d.getDate() === now.getDate()) return 'Today'
  if (days <= 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

// The Home box opens with the last list this device saw, so it never flashes
// empty while the fresh one loads.
const HOME_CACHE_KEY = 'meshport_news_home_v1'
export function readCachedHomeNews(): NewsItem[] {
  try { const v = JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || 'null'); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** Latest stories for the Home box. Network notices only appear while live. */
export async function fetchHomeNews(limit = 4): Promise<NewsItem[]> {
  const { data, error } = await supabase.from('news_items').select(COLUMNS)
    .eq('hidden', false).order('published_at', { ascending: false }).limit(limit + 6)
  if (error) { console.warn('[news] home:', error.message); return readCachedHomeNews() }
  const items = ((data ?? []) as NewsItem[])
    .filter(i => i.source !== 'arc_status' || isLiveStatusNotice(i))
    .slice(0, limit)
  try { localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(items)) } catch { /* storage full */ }
  return items
}

export const NEWS_PAGE_SIZE = 20

/** One page of the /news list, newest first. `before` = published_at of the last item already shown. */
export async function fetchNewsPage(opts: { source?: NewsSource | null; before?: string | null } = {}): Promise<NewsItem[]> {
  let q = supabase.from('news_items').select(COLUMNS).eq('hidden', false)
    .order('published_at', { ascending: false }).limit(NEWS_PAGE_SIZE)
  if (opts.source) q = q.eq('source', opts.source)
  if (opts.before) q = q.lt('published_at', opts.before)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as NewsItem[]
}

/** Live network notices for the pinned alert on /news. */
export async function fetchLiveStatusNotices(): Promise<NewsItem[]> {
  const { data, error } = await supabase.from('news_items').select(COLUMNS)
    .eq('hidden', false).eq('source', 'arc_status').order('published_at', { ascending: false }).limit(5)
  if (error) return []
  return ((data ?? []) as NewsItem[]).filter(i => isLiveStatusNotice(i))
}

export async function fetchNewsItem(id: string): Promise<NewsItem | null> {
  const cached = readCachedHomeNews().find(i => i.id === id)
  const { data, error } = await supabase.from('news_items').select(COLUMNS).eq('id', id).maybeSingle()
  if (error) return cached ?? null
  return (data as NewsItem | null) ?? cached ?? null
}
