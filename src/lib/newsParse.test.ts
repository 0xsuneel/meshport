import { describe, it, expect } from 'vitest'
import {
  parseArcBlogList, parseCircleBlogList, parseArticle, parseStatusRss, clampParagraph, plainText,
} from '../../supabase/functions/_shared/newsParse'
import { isLiveStatusNotice, newsHost, type NewsItem } from './news'

// Fixtures are trimmed copies of the real markup (fetched 2026-10-08).

const ARC_LIST = `<div role="list" class="row w-dyn-items"><div role="listitem" class="col w-dyn-item"><div class="blog-card"><div class="blog-card_wrapper"><img src="https://cdn.prod.website-files.com/68af/6ac3_Blog_Pulsar_1200x630%20(1).jpg" loading="lazy" alt="" srcset="x 500w"/><div class="blog-card_content"><div class="blog-card_topic-row"><div>Partner spotlights</div><div class="blog-card_timeread"><div>4</div><div>min read</div></div></div><h2 class="blog-card_header">How Pulsar Is Building a Cross-Border Money Experience With Arc</h2></div><div fs-list-field="topic">Partner spotlights</div></div><a href="/blog/how-pulsar-is-building-a-cross-border-money-experience-with-arc" class="u-link-cover w-inline-block"></a></div></div>
<div role="listitem" class="col w-dyn-item"><div class="blog-card"><div class="blog-card_wrapper"><img src="https://cdn.prod.website-files.com/68af/6aab_Blog_cirBTC-Arc.jpg" alt=""/><div class="blog-card_content"><div class="blog-card_topic-row"><div>Arc updates</div><div class="blog-card_timeread"><div>5</div><div>min read</div></div></div><h2 class="blog-card_header">cirBTC Is Now Live on Arc</h2></div></div><a href="/blog/cirbtc-is-now-live-on-arc" class="u-link-cover"></a></div></div></div>`

const ARC_ARTICLE = `<html><head><title>cirBTC Is Now Live on Arc | Circle Wrapped Bitcoin</title><meta content="Circle Wrapped Bitcoin (cirBTC) brings bitcoin (BTC) liquidity to Arc." name="description"/><meta content="cirBTC Is Now Live on Arc | Circle Wrapped Bitcoin" property="og:title"/><meta content="https://cdn.prod.website-files.com/68af/6aab_Blog_cirBTC-Arc.jpg" property="og:image"/>
<style>.w-richtext>:first-child { margin-top: 0; } .blog_content-rt p { color: red }</style>
<script type="application/ld+json">{ "@type": "BlogPosting", "url": "https://arc.network/blog/cirbtc-is-now-live-on-arc", "datePublished": "2026-09-30T19:58:50.829Z", "articleSection": "Arc updates" }</script></head>
<body><h1 class="h2">cirBTC Is Now Live on Arc</h1><div class="blog_summary"><h2 class="eyebrow">Summary</h2><div class="blog_summary-rt w-richtext"><p>Circle Wrapped Bitcoin (cirBTC) is now available on Arc, bringing 1:1 bitcoin-backed (BTC) liquidity into the Economic OS for internet-native financial markets.</p></div></div>
<div fs-toc-element="contents" class="blog_content-rt w-richtext"><p>Bitcoin (BTC) is essential collateral for onchain finance. It is also, by design, difficult to use outside its native network.</p><p><a href="https://www.arc.io/blog/x">Onchain credit markets</a> need deep collateral. Market makers need inventory that can move across venues.</p><p>Short.</p><p>Circle Wrapped Bitcoin (cirBTC) is now live on Arc, bringing bitcoin liquidity to the network&#39;s builders.</p><p>A fourth long paragraph that should not be included because only three are kept.</p></div></body></html>`

const CIRCLE_LIST = `<article class="blog-featured_card"><img src="https://cdn/a.jpg"/><h1 class="h5">Introducing Circle Agent Stack</h1><a href="/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy" class="blog-featured_link"></a></article>
<a href="/blog-all" class="text-link">view all</a><article class="blog-latest_card"><a href="/blog/simplify-stablecoin-adoption-with-cpn-managed-payments"><h2>Simplify Stablecoin Adoption With CPN Managed Payments</h2></a><a href="/topic/usdc">USDC</a></article>
<a href="/blog/simplify-stablecoin-adoption-with-cpn-managed-payments">again</a>`

const CIRCLE_ARTICLE = `<head><meta content="Settle globally via USDC without directly touching digital assets." name="description"/><meta content="Managed Payments: Streamlined Stablecoin Settlement | Circle" property="og:title"/><meta content="https://cdn.prod.website-files.com/6711/69c5_Blog_CPN-managed-payments.jpg" property="og:image"/>
<style>.blog-rich-text li ul { margin-top: .75rem; }</style>
<script type="application/ld+json">{ "headline": "Simplify Stablecoin Adoption With CPN Managed Payments", "datePublished": "2026-04-08" }</script></head>
<body><p class="u-sr-only">Home</p><div class="rt-blog_summary w-richtext"><p>CPN Managed Payments enables easier stablecoin adoption by removing technical and regulatory barriers via a turnkey solution. </p></div>
<div class="blog-rich-text w-richtext"><p>Businesses want the speed of stablecoin settlement without having to hold or manage digital assets themselves.</p></div></body>`

const STATUS_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Arc Status - Incident History</title>
<item>
<title>Arc Testnet arc.network URL deprecation — October 8 brownout</title>
<description>
&lt;p&gt; &lt;small&gt;Oct &lt;var data-var=&apos;date&apos;&gt; 8&lt;/var&gt;, &lt;var data-var=&apos;time&apos;&gt;00:00&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt; &lt;strong&gt;In progress&lt;/strong&gt; - Scheduled maintenance is currently in progress. We will provide updates as necessary. &lt;/p&gt; &lt;p&gt; &lt;small&gt;Oct &lt;var data-var=&apos;date&apos;&gt; 1&lt;/var&gt;, &lt;var data-var=&apos;time&apos;&gt;16:46&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt; &lt;strong&gt;Scheduled&lt;/strong&gt; - The arc.network endpoint URLs are scheduled for a brownout on October 8, 2026.&lt;br /&gt;&lt;br /&gt;rpc.testnet.arc.network → rpc.testnet.arc.io &lt;/p&gt;      </description>
<pubDate>Thu, 08 Oct 2026 00:00:08 +0000</pubDate>
<link>https://status.arc.io/incidents/5l16zk7f1p9g</link>
<guid>https://status.arc.io/incidents/5l16zk7f1p9g</guid>
</item>
<item><title>ARC Testnet Degraded Performance</title><description>&lt;p&gt; &lt;small&gt;Jun 16, 09:45 UTC&lt;/small&gt;&lt;br&gt; &lt;strong&gt;Resolved&lt;/strong&gt; - Arc Testnet performance has returned to normal. &lt;/p&gt;</description><pubDate>Tue, 16 Jun 2026 09:45:00 +0000</pubDate><link>https://status.arc.io/incidents/abc</link></item>
</channel></rss>`

describe('parseArcBlogList', () => {
  it('reads every card: link, title, cover, topic, read time', () => {
    const list = parseArcBlogList(ARC_LIST)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      url: 'https://www.arc.io/blog/how-pulsar-is-building-a-cross-border-money-experience-with-arc',
      title: 'How Pulsar Is Building a Cross-Border Money Experience With Arc',
      image_url: 'https://cdn.prod.website-files.com/68af/6ac3_Blog_Pulsar_1200x630%20(1).jpg',
      topic: 'Partner spotlights',
      read_minutes: 4,
    })
    expect(list[1].url).toBe('https://www.arc.io/blog/cirbtc-is-now-live-on-arc')
  })
  it('returns [] when the layout changes', () => {
    expect(parseArcBlogList('<div class="post">nothing</div>')).toEqual([])
  })
})

describe('parseCircleBlogList', () => {
  it('collects each article link once and skips /blog-all', () => {
    expect(parseCircleBlogList(CIRCLE_LIST).map(e => e.url)).toEqual([
      'https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy',
      'https://www.circle.com/blog/simplify-stablecoin-adoption-with-cpn-managed-payments',
    ])
  })
})

describe('parseArticle', () => {
  it('arc.io: summary block, first three real paragraphs, date, cover, section', () => {
    const a = parseArticle(ARC_ARTICLE)
    expect(a.title).toBe('cirBTC Is Now Live on Arc')
    expect(a.summary).toMatch(/^Circle Wrapped Bitcoin \(cirBTC\) is now available on Arc/)
    expect(a.body).toEqual([
      'Bitcoin (BTC) is essential collateral for onchain finance. It is also, by design, difficult to use outside its native network.',
      'Onchain credit markets need deep collateral. Market makers need inventory that can move across venues.',
      "Circle Wrapped Bitcoin (cirBTC) is now live on Arc, bringing bitcoin liquidity to the network's builders.",
    ])
    expect(a.image_url).toBe('https://cdn.prod.website-files.com/68af/6aab_Blog_cirBTC-Arc.jpg')
    expect(a.published_at).toBe('2026-09-30T19:58:50.829Z')
    expect(a.topic).toBe('Arc updates')
  })
  it('circle.com: headline from JSON-LD, ignores CSS mentioning the body class', () => {
    const a = parseArticle(CIRCLE_ARTICLE)
    expect(a.title).toBe('Simplify Stablecoin Adoption With CPN Managed Payments')
    expect(a.summary).toMatch(/^CPN Managed Payments enables easier stablecoin adoption/)
    expect(a.body).toEqual(['Businesses want the speed of stablecoin settlement without having to hold or manage digital assets themselves.'])
    expect(a.published_at).toBe('2026-04-08T00:00:00.000Z')
  })
  it('falls back to the meta description and og:title when the blocks are missing', () => {
    const a = parseArticle('<meta content="Plain description here." name="description"/><meta content="A title | Site" property="og:title"/>')
    expect(a.title).toBe('A title')
    expect(a.summary).toBe('Plain description here.')
    expect(a.body).toEqual([])
    expect(a.published_at).toBeNull()
  })
})

describe('parseStatusRss', () => {
  it('reads each notice with its latest status first', () => {
    const [first, second] = parseStatusRss(STATUS_RSS)
    expect(first.title).toBe('Arc Testnet arc.network URL deprecation — October 8 brownout')
    expect(first.url).toBe('https://status.arc.io/incidents/5l16zk7f1p9g')
    expect(first.status_label).toBe('In progress')
    expect(first.summary).toBe('Scheduled maintenance is currently in progress. We will provide updates as necessary.')
    expect(first.body[0]).toBe('In progress · Oct 8, 00:00 UTC: Scheduled maintenance is currently in progress. We will provide updates as necessary.')
    expect(first.body[1]).toMatch(/^Scheduled · Oct 1, 16:46 UTC: The arc\.network endpoint URLs/)
    expect(first.published_at).toBe('2026-10-08T00:00:08.000Z')
    expect(second.status_label).toBe('Resolved')
  })
})

describe('helpers', () => {
  it('plainText strips tags and decodes entities', () => {
    expect(plainText('<b>A&amp;B</b>&nbsp; &#39;c&#x27;')).toBe("A&B 'c'")
  })
  it('clampParagraph cuts at a sentence end, never mid-word', () => {
    const first = 'This opening sentence runs well past the halfway point of the limit.'
    expect(clampParagraph(first + ' ' + 'word '.repeat(120), 100)).toBe(first)
    // A sentence end too early to be useful falls back to a word cut.
    expect(clampParagraph('Short one. ' + 'word '.repeat(120), 100)).toMatch(/^Short one\. word.*word…$/)
    expect(clampParagraph('word '.repeat(60), 50).endsWith('…')).toBe(true)
  })
})

describe('news.ts', () => {
  const base: NewsItem = { id: '1', source: 'arc_status', url: 'https://status.arc.io/incidents/x', title: 't', summary: null, body: [],
    image_url: null, topic: null, read_minutes: null, status_label: 'In progress', published_at: '2026-10-08T00:00:00Z' }
  const now = Date.parse('2026-10-08T12:00:00Z')
  it('a status notice is live until resolved, and for at most a week', () => {
    expect(isLiveStatusNotice(base, now)).toBe(true)
    expect(isLiveStatusNotice({ ...base, status_label: 'Completed' }, now)).toBe(false)
    expect(isLiveStatusNotice({ ...base, published_at: '2026-09-20T00:00:00Z' }, now)).toBe(false)
    expect(isLiveStatusNotice({ ...base, source: 'arc' }, now)).toBe(false)
  })
  it('newsHost shows the bare site name', () => {
    expect(newsHost({ url: 'https://www.arc.io/blog/x' })).toBe('arc.io')
    expect(newsHost({ url: null })).toBeNull()
  })
})
