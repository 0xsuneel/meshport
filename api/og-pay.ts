import type { VercelRequest, VercelResponse } from '@vercel/node'

// Same names as the app (src/lib/orderLabels.ts): ORD-100042 shows as
// ORD-00042; "Bill / Request / Requested Payment ORD-…", "Paid Bill …" etc.
function orderDisplay(n: string): string {
  const m = /^ORD-(\d+)$/i.exec(n || '')
  if (!m || Number(m[1]) <= 100000) return n || ''
  return `ORD-${String(Number(m[1]) - 100000).padStart(5, '0')}`
}
function orderName(kind: string | undefined, personal: boolean | null | undefined, n: string, paid: boolean): string {
  const no = orderDisplay(n)
  if (kind === 'invoice') return paid ? `Paid Bill ${no}` : `Bill ${no}`
  if (personal === false) return paid ? `Requested Payment Paid ${no}` : `Requested Payment ${no}`
  return paid ? `Request Amount Paid ${no}` : `Request ${no}`
}

/**
 * GET /api/og-pay?username=<username>[&amount=<n>][&token=EURC|cirBTC]   personal payment link
 * GET /api/og-pay?code=<code>[&order=<ORD-…>]        merchant bill / payment request
 *
 * Powers rich link previews for payment links (meshport.xyz/paylink/:username
 * and /paylink/r/:code, plus the older /pay/… forms). A link with an amount
 * (?amount=10, or a merchant bill) shows that amount on the card: "Pay $10",
 * in the link's token (?token=EURC → "€10 EURC"), plus the bill's status.
 *
 * WHY THIS EXISTS: MeshPort is a client-side React app - the actual HTML the
 * server sends back is the same empty shell for every route, and the real
 * page content (including who a payment link is for) only appears after
 * JavaScript runs. Link-preview bots (WhatsApp, iMessage, Telegram, Slack,
 * etc.) do NOT run JavaScript - they only ever look at the raw HTML's <head>
 * meta tags. So without this function, every payment link would show the
 * exact same generic "MeshPort" card, never the actual recipient's name.
 *
 * HOW IT WORKS: vercel.json rewrites /paylink/:username (and /pay/:username) to this function for
 * EVERY request (both bots and real people). This function then branches:
 *   - Bot request  → looks up the user, returns a small HTML page with
 *                    that person's name baked into the og:title/description
 *                    meta tags. Bots read this and stop - they never load
 *                    the JS app, so this is all they ever see.
 *   - Real browser → this function fetches the actual built index.html and
 *                    returns it unchanged, so the real React app boots
 *                    exactly like it would have without this function at
 *                    all. The URL in the address bar never changes, so
 *                    client-side routing (PayPage) picks it up normally.
 *
 * CAVEAT: Apple's iMessage link-preview fetcher doesn't always identify
 * itself with a distinct User-Agent the way other platforms do, so it's the
 * one platform this can't reliably guarantee a personalized card for even
 * with this function in place - everything else (WhatsApp, Telegram, Slack,
 * Discord, Facebook, Twitter/X, LinkedIn) is covered by the check below.
 */

const BOT_UA_PATTERNS = [
  /facebookexternalhit/i, /Twitterbot/i, /WhatsApp/i, /TelegramBot/i,
  /Slackbot/i, /LinkedInBot/i, /Discordbot/i, /SkypeUriPreview/i,
  /Google-InspectionTool/i, /Applebot/i, /Pinterest/i, /redditbot/i,
  /vkShare/i, /W3C_Validator/i, /Bot/i, /bot/,
]

function isBot(userAgent: string): boolean {
  return BOT_UA_PATTERNS.some(re => re.test(userAgent))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Same tokens and symbols as og-image.tsx and src/lib/payLinks.ts.
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  USDC: { symbol: '$', decimals: 2 },
  EURC: { symbol: '€', decimals: 2 },
  cirBTC: { symbol: '', decimals: 8 },
}

function formatAmount(n: number, token = 'USDC'): string {
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return ''
  const t = TOKENS[token] || TOKENS.USDC
  return t.symbol + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : Math.min(2, t.decimals), maximumFractionDigits: t.decimals })
}

/** "For sunil.arc · 2x Flat white +1 more" - who a bill is for and what's on it. */
function billMemo(v: any): string {
  const parts: string[] = []
  if (v.customerUsername) parts.push(`For ${String(v.customerUsername).replace(/\.arc$/i, '')}.arc`)
  const items = Array.isArray(v.items) ? v.items.filter((i: any) => i && i.name) : []
  if (items.length) {
    const first = `${Number(items[0].qty) > 1 ? `${Number(items[0].qty)}x ` : ''}${items[0].name}`
    parts.push(items.length > 1 ? `${first} +${items.length - 1} more` : first)
  } else if (v.note) {
    parts.push(String(v.note))
  }
  return parts.join(' · ')
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = String(req.query.code || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  const username = String(req.query.username || '').replace(/\.arc$/i, '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
  const userAgent = String(req.headers['user-agent'] || '')
  // Only our own hosts - a forged Host header must not decide where this
  // function fetches from or which origin the preview card points at.
  const rawHost = String(req.headers.host || '')
  const host = /^(meshport\.xyz|www\.meshport\.xyz|[a-z0-9-]+\.vercel\.app|localhost(:\d+)?)$/i.test(rawHost) ? rawHost : 'meshport.xyz'
  const proto = /^localhost/i.test(host) ? 'http' : 'https'
  const appPath = code ? `/paylink/r/${code}` : `/paylink/${username}`
  const pageUrl = `${proto}://${host}${appPath}`
  const rawToken = String(req.query.token || '')
  const linkToken = !code && (rawToken === 'EURC' || rawToken === 'cirBTC') ? rawToken : 'USDC'

  // ── Real visitor: pass through to the actual app, unchanged ──────────────
  if (!isBot(userAgent)) {
    try {
      const appRes = await fetch(`${proto}://${host}/index.html`)
      const html = await appRes.text()
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).send(html)
    } catch {
      // If the self-fetch ever fails for some reason, redirecting still
      // gets a real visitor to a working page rather than an error.
      const amt = code ? '' : String(req.query.amount || '').replace(/[^0-9.]/g, '')
      const q = new URLSearchParams()
      if (amt) q.set('amount', amt)
      if (linkToken !== 'USDC') q.set('token', linkToken)
      res.setHeader('Location', appPath + (q.toString() ? `?${q}` : ''))
      return res.status(302).end()
    }
  }

  // ── Bot: look up who is being paid and build a personalized preview card ──
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://cvvpzfvzweszuuxvaayb.supabase.co').trim()
  const key = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()
  const headers = { apikey: key, Authorization: `Bearer ${key}` }

  let displayName = username
  let handle = username
  let avatarUrl = ''
  let amount = 0
  let label = ''
  let token = linkToken
  let status = ''
  let memo = ''

  if (code) {
    // Merchant bill / payment request: the public view the pay page shows.
    displayName = 'MeshPort merchant'
    handle = ''
    const order = String(req.query.order || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    if (supabaseUrl && key) {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/merchant-pay`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get', code }),
        })
        const v = await r.json()
        if (v && !v.error) {
          displayName = v.merchantName || v.merchantUsername || displayName
          handle = v.merchantUsername || ''
          avatarUrl = v.merchantAvatar || ''
          const due = Math.max(0, Number(v.amount) - Number(v.received || 0))
          amount = v.status === 'paid' ? Number(v.amount) : (due > 0 ? due : Number(v.amount))
          label = v.orderNumber ? orderName(v.kind, v.personal, v.orderNumber, v.status === 'paid') : v.status === 'paid' ? 'Paid' : v.kind === 'invoice' ? 'Bill' : ''
          if (TOKENS[v.currency]) token = v.currency
          status = String(v.status || '')
          memo = billMemo(v)
        }
      } catch { /* plainer card below */ }
    }
    if (!label && order) label = orderDisplay(order)
  } else {
    amount = Number(String(req.query.amount || '').replace(/[^0-9.]/g, '')) || 0
    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(username)
    if (isAddress) { displayName = shortAddr(username); handle = '' }
    if (username && supabaseUrl && key) {
      try {
        const filter = isAddress ? `wallet_address=ilike.${username}` : `username=eq.${encodeURIComponent(username)}`
        const r = await fetch(`${supabaseUrl}/rest/v1/users?${filter}&select=display_name,username,avatar_url&limit=1`, { headers })
        const rows = await r.json()
        if (Array.isArray(rows) && rows[0]) {
          displayName = rows[0].display_name || rows[0].username || displayName
          handle = rows[0].username || handle
          avatarUrl = rows[0].avatar_url || ''
        }
      } catch {
        // Fall through with the raw username as a reasonable default - a
        // slightly plainer card beats a broken one.
      }
    }
  }

  const amountText = formatAmount(amount, token)
  const title = amountText ? `Pay ${amountText} to ${displayName} on MeshPort` : `Pay ${displayName} on MeshPort`
  const description = [
    handle ? `${handle}.arc` : '',
    label,
    amountText ? `${amountText} ${token} • Pay instantly with MeshPort` : `Send ${token} instantly with MeshPort`,
  ].filter(Boolean).join(' • ')
  // Render the branded ticket card (avatar + name + handle, the amount and
  // status when there is one, the link path) via the og-image edge function,
  // so it's personalized per link. og-image.tsx falls back to an initials
  // badge itself when avatarUrl is empty, so no separate default-image branch.
  const displayHost = host.replace(/^www\./i, '')
  const displayPath = code ? appPath : `/paylink/${/^0x[0-9a-fA-F]{40}$/.test(username) ? shortAddr(username) : username}`
  const imageParams = new URLSearchParams({ name: displayName })
  if (handle) imageParams.set('username', handle)
  if (avatarUrl) imageParams.set('avatar', avatarUrl)
  if (amountText) imageParams.set('amount', String(Number(amount.toFixed(TOKENS[token].decimals))))
  if (token !== 'USDC') imageParams.set('currency', token)
  if (label) imageParams.set('label', label)
  if (status) imageParams.set('status', status)
  if (memo) imageParams.set('memo', memo)
  if (code) imageParams.set('kind', 'merchant')
  imageParams.set('path', displayHost + displayPath)
  imageParams.set('v', '4') // ticket redesign - a fresh URL for every preview cache
  const image = `${proto}://${host}/api/og-image?${imageParams.toString()}`
  const shareQuery = new URLSearchParams()
  if (amountText && !code) shareQuery.set('amount', String(amount))
  if (token !== 'USDC' && !code) shareQuery.set('token', token)
  const shareUrl = pageUrl + (shareQuery.toString() ? `?${shareQuery}` : '')

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="MeshPort">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
</head>
<body></body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  // private: this bot-only page and the real app share one URL, so it must
  // never sit in the shared CDN cache (a bot hit would blank the link for people).
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader('Vary', 'User-Agent')
  return res.status(200).send(html)
}
