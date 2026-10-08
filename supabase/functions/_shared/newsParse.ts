// Pure HTML/RSS readers for the news-sync edge function (arc.io/blog,
// circle.com/blog, status.arc.io). No Deno or network APIs in here so the
// same file is unit-tested from vitest (src/lib/newsParse.test.ts).
//
// Both blogs are Webflow sites with no usable feed (circle.com's RSS link
// 404s, arc.io has none), so the list pages give us article links and each
// article page gives the summary, cover, date and opening paragraphs.
// Every reader returns [] / nulls rather than throwing when a layout
// changes; news-sync then simply keeps the stories it already has.

export interface BlogListEntry {
  url: string
  title: string | null
  image_url: string | null
  topic: string | null
  read_minutes: number | null
}

export interface ArticleDetails {
  title: string | null
  summary: string | null
  body: string[]
  image_url: string | null
  published_at: string | null
  topic: string | null
}

export interface StatusEntry {
  url: string
  title: string
  summary: string | null
  body: string[]
  status_label: string | null
  published_at: string | null
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', rarr: '→',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Tags out, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ').trim()
}

function absolute(base: string, href: string): string {
  try { return new URL(href, base).toString() } catch { return href }
}

/** Long paragraphs are cut at a sentence end near `max` so the short article never ends mid-word. */
export function clampParagraph(s: string, max = 480): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (end > max * 0.5) return cut.slice(0, end + 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…'
}

function metaContent(html: string, key: string): string | null {
  // Webflow writes content before property/name; other sites the other way round.
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const a = html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="${k}"`, 'i'))
  const b = html.match(new RegExp(`<meta[^>]*(?:property|name)="${k}"[^>]*content="([^"]*)"`, 'i'))
  const v = (a?.[1] ?? b?.[1])
  return v ? decodeEntities(v).trim() || null : null
}

function jsonLdField(html: string, field: string): string | null {
  const m = html.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`))
  return m ? decodeEntities(m[1]) : null
}

/** First <p>s inside the element whose class attribute starts with one of `classNames`. */
function paragraphsIn(html: string, classNames: string[], limit: number): string[] {
  for (const cls of classNames) {
    const at = html.search(new RegExp(`class="${cls}[\\s"]`))
    if (at < 0) continue
    const chunk = html.slice(at, at + 40000)
    const out: string[] = []
    for (const m of chunk.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = plainText(m[1])
      if (t.length >= 40) out.push(clampParagraph(t))
      if (out.length >= limit) break
    }
    if (out.length) return out
  }
  return []
}

// ── arc.io/blog ─────────────────────────────────────────────────────────────
export function parseArcBlogList(html: string, base = 'https://www.arc.io'): BlogListEntry[] {
  const out: BlogListEntry[] = []
  const seen = new Set<string>()
  for (const card of html.split('class="blog-card"').slice(1)) {
    const href = card.match(/href="(\/blog\/[a-z0-9-]+)"/i)?.[1]
    if (!href) continue
    const url = absolute(base, href)
    if (seen.has(url)) continue
    seen.add(url)
    const title = card.match(/class="blog-card_header"[^>]*>([\s\S]*?)<\/h\d>/)?.[1]
    const topic = card.match(/class="blog-card_topic-row"[^>]*><div>([\s\S]*?)<\/div>/)?.[1]
    const mins = card.match(/class="blog-card_timeread"[^>]*><div>(\d+)<\/div>/)?.[1]
    const img = card.match(/<img[^>]*src="([^"]+)"/)?.[1]
    out.push({
      url,
      title: title ? plainText(title) || null : null,
      image_url: img ? decodeEntities(img) : null,
      topic: topic ? plainText(topic) || null : null,
      read_minutes: mins ? Number(mins) : null,
    })
  }
  return out
}

// ── circle.com/blog ─────────────────────────────────────────────────────────
// The list page mixes featured cards and a text-only "recent posts" list, so
// only the link is trusted here; everything else comes from the article.
export function parseCircleBlogList(html: string, base = 'https://www.circle.com'): BlogListEntry[] {
  const out: BlogListEntry[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/href="(\/blog\/[a-z0-9-]+)"/gi)) {
    const url = absolute(base, m[1])
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, title: null, image_url: null, topic: null, read_minutes: null })
  }
  return out
}

// ── An article page on either blog ──────────────────────────────────────────
export function parseArticle(html: string): ArticleDetails {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]
  const ogTitle = metaContent(html, 'og:title')
  const title = jsonLdField(html, 'headline') || (h1 ? plainText(h1) : null) || (ogTitle ? ogTitle.split(' | ')[0] : null)
  const summary = paragraphsIn(html, ['blog_summary-rt', 'rt-blog_summary'], 1)[0]
    || metaContent(html, 'og:description') || metaContent(html, 'description')
  const body = paragraphsIn(html, ['blog_content-rt', 'blog-rich-text'], 3)
  const published = jsonLdField(html, 'datePublished') || metaContent(html, 'article:published_time')
  const iso = published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null
  return {
    title: title || null,
    summary: summary ? clampParagraph(summary, 360) : null,
    body: summary ? body.filter(p => p !== summary) : body,
    image_url: metaContent(html, 'og:image'),
    published_at: iso,
    topic: jsonLdField(html, 'articleSection'),
  }
}

// ── status.arc.io/history.rss ───────────────────────────────────────────────
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null

export function parseStatusRss(xml: string, limit = 10): StatusEntry[] {
  const out: StatusEntry[] = []
  for (const item of xml.split('<item>').slice(1, limit + 1)) {
    const title = tag(item, 'title'), link = tag(item, 'link') || tag(item, 'guid')
    if (!title || !link) continue
    // The description is escaped HTML: one <p> per update, newest first:
    // <p><small>Oct 8, 00:00 UTC</small><br><strong>In progress</strong> - text</p>
    const desc = decodeEntities(tag(item, 'description') ?? '')
    const updates: { label: string | null; when: string; text: string }[] = []
    for (const p of desc.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
      const when = plainText(p[1].match(/<small>([\s\S]*?)<\/small>/)?.[1] ?? '')
      const label = p[1].match(/<strong>([\s\S]*?)<\/strong>/)?.[1]
      const text = plainText(p[1].replace(/<small>[\s\S]*?<\/small>/, '').replace(/<strong>[\s\S]*?<\/strong>/, '')).replace(/^-\s*/, '')
      if (text) updates.push({ label: label ? plainText(label) : null, when, text })
    }
    const pub = tag(item, 'pubDate')
    out.push({
      url: decodeEntities(link),
      title: plainText(title),
      summary: updates[0] ? clampParagraph(updates[0].text, 360) : null,
      body: updates.slice(0, 4).map(u => clampParagraph(`${[u.label, u.when].filter(Boolean).join(' · ')}: ${u.text}`)),
      status_label: updates[0]?.label ?? null,
      published_at: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null,
    })
  }
  return out
}

// ── Developer updates: Circle release notes + Kit changelogs ────────────────
export interface DevUpdateEntry {
  url: string
  title: string
  summary: string | null
  body: string[]
  topic: string
  published_at: string
}

/** Markdown → plain text: links keep their text, code/emphasis marks and tags go. */
export function markdownText(md: string): string {
  return decodeEntities(md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_]{1,3}([^`*_]+)[`*_]{1,3}/g, '$1')
    .replace(/[`]/g, ''))
    .replace(/\s+/g, ' ').trim()
}

function firstSentence(s: string, max = 110): string {
  // Ends at the first sentence, or at a colon that introduces details.
  const m = s.match(/^(.{20,}?)[.!?:](\s|$)/)
  const one = (m ? m[1] : s).replace(/[.:]$/, '')
  if (one.length <= max) return one
  const cut = one.slice(0, max)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…'
}

/** A markdown chunk → readable paragraphs; a bullet list joins into one line (after its "Updated topics:" lead-in, if any). */
function mdParagraphs(md: string): { heading: string | null; paras: string[] } {
  let heading: string | null = null
  const paras: string[] = []
  for (const raw of md.split(/\n\s*\n/)) {
    const block = raw.trim()
    if (!block || block.startsWith('```')) continue
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.every(l => l.startsWith('#'))) { heading ??= markdownText(lines[0].replace(/^#+\s*/, '')); continue }
    if (/^[*-]\s/.test(lines[0])) {
      // A list; a wrapped item continues on the next (unbulleted) line.
      const raw: string[] = []
      for (const l of lines) {
        if (/^[*-]\s/.test(l)) raw.push(l.replace(/^[*-]\s+/, ''))
        else raw[raw.length - 1] += ' ' + l
      }
      const items = raw.map(markdownText).filter(Boolean)
      if (!items.length) continue
      const joined = items.join('; ')
      if (paras.length && /:$/.test(paras[paras.length - 1])) paras[paras.length - 1] += ' ' + joined
      else paras.push(joined)
      continue
    }
    const text = markdownText(lines.filter(l => !l.startsWith('#')).join(' '))
    if (text) paras.push(text)
  }
  return { heading, paras }
}

/**
 * developers.circle.com/release-notes/<product>-<year>.md: one
 * <Update label="YYYY.MM.DD"> block per change, newest first.
 */
export function parseReleaseNotesMd(md: string, product: string, pageUrl: string, limit = 10): DevUpdateEntry[] {
  const out: DevUpdateEntry[] = []
  const seen = new Map<string, number>()
  for (const m of md.matchAll(/<Update\s+label="(\d{4})\.(\d{2})\.(\d{2})"[^>]*>([\s\S]*?)<\/Update>/g)) {
    const [, y, mo, d, inner] = m
    const { heading, paras } = mdParagraphs(inner)
    const lead = paras.find(p => !/:$/.test(p)) ?? paras[0] ?? heading
    if (!lead) continue
    const label = `${y}.${mo}.${d}`
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    out.push({
      url: `${pageUrl}#${label}${n > 1 ? `-${n}` : ''}`,
      title: `${product}: ${firstSentence(lead)}`,
      summary: clampParagraph(lead, 360),
      body: paras.filter(p => p !== lead).slice(0, 3).map(p => clampParagraph(p)),
      topic: product,
      published_at: new Date(`${y}-${mo}-${d}T12:00:00Z`).toISOString(),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * A Changesets CHANGELOG.md shipped in an npm package ("## 1.16.0",
 * "### Minor Changes", "- change…"). Only major/minor releases count as
 * news; patch releases are fixes. Dates come from the npm registry (`times`).
 */
export function parseChangelogMd(md: string, product: string, pkg: string, times: Record<string, string>, limit = 8): DevUpdateEntry[] {
  const out: DevUpdateEntry[] = []
  const parts = md.split(/^## (\d+\.\d+\.\d+)\s*$/m)
  for (let i = 1; i < parts.length && out.length < limit; i += 2) {
    const version = parts[i], section = parts[i + 1] ?? ''
    if (!/^### (Major|Minor) Changes/m.test(section)) continue
    const when = times[version]
    if (!when || Number.isNaN(Date.parse(when))) continue
    // Changes under the major/minor headings only; each "- " at column 0 starts one.
    const notable = section.split(/^### /m).filter(s => /^(Major|Minor) Changes/.test(s)).join('\n')
    const items = notable.split(/^- /m).slice(1)
      .map(it => mdParagraphs(it.replace(/^(Major|Minor) Changes.*$/m, '')).paras[0])
      .filter((p): p is string => !!p)
    if (!items.length) continue
    out.push({
      url: `https://www.npmjs.com/package/${pkg}/v/${version}`,
      title: `${product} ${version}: ${firstSentence(items[0])}`,
      summary: clampParagraph(items[0], 360),
      body: items.slice(1, 4).map(p => clampParagraph(p)),
      topic: product,
      published_at: new Date(when).toISOString(),
    })
  }
  return out
}
