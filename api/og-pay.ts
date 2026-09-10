import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * GET /api/og-pay?username=<username>
 *
 * Powers rich link previews for payment links (meshport.xyz/pay/:username).
 *
 * WHY THIS EXISTS: MeshPort is a client-side React app — the actual HTML the
 * server sends back is the same empty shell for every route, and the real
 * page content (including who a payment link is for) only appears after
 * JavaScript runs. Link-preview bots (WhatsApp, iMessage, Telegram, Slack,
 * etc.) do NOT run JavaScript — they only ever look at the raw HTML's <head>
 * meta tags. So without this function, every payment link would show the
 * exact same generic "MeshPort" card, never the actual recipient's name.
 *
 * HOW IT WORKS: vercel.json rewrites /pay/:username to this function for
 * EVERY request (both bots and real people). This function then branches:
 *   - Bot request  → looks up the user, returns a small HTML page with
 *                    that person's name baked into the og:title/description
 *                    meta tags. Bots read this and stop — they never load
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
 * with this function in place — everything else (WhatsApp, Telegram, Slack,
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const username = String(req.query.username || '').replace(/\.arc$/i, '').trim()
  const userAgent = String(req.headers['user-agent'] || '')
  const host = req.headers.host || 'meshport.xyz'
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const pageUrl = `${proto}://${host}/pay/${username}`

  // ── Real visitor: pass through to the actual app, unchanged ──────────────
  if (!isBot(userAgent)) {
    try {
      const appRes = await fetch(`${proto}://${host}/index.html`)
      const html = await appRes.text()
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.status(200).send(html)
    } catch {
      // If the self-fetch ever fails for some reason, redirecting still
      // gets a real visitor to a working page rather than an error.
      res.setHeader('Location', `/pay/${username}`)
      return res.status(302).end()
    }
  }

  // ── Bot: look up the user and build a personalized preview card ──────────
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://cvvpzfvzweszuuxvaayb.supabase.co').trim()
  const key = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

  let displayName = username
  let handle = username
  let avatarUrl = ''

  if (username && supabaseUrl && key) {
    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=display_name,username,avatar_url`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      )
      const rows = await r.json()
      if (Array.isArray(rows) && rows[0]) {
        displayName = rows[0].display_name || username
        handle = rows[0].username || username
        avatarUrl = rows[0].avatar_url || ''
      }
    } catch {
      // Fall through with the raw username as a reasonable default — a
      // slightly plainer card beats a broken one.
    }
  }

  const title = `Pay ${displayName} on MeshPort`
  const description = `${handle}.arc • Send USDC instantly with MeshPort`
  // Render the branded card (avatar circle + name + handle + logo) via the
  // og-image edge function instead of a static png, so it's personalized
  // per recipient. og-image.tsx falls back to an initials badge itself
  // when avatarUrl is empty, so no separate default-image branch needed.
  const imageParams = new URLSearchParams({ name: displayName, username: handle })
  if (avatarUrl) imageParams.set('avatar', avatarUrl)
  const image = `${proto}://${host}/api/og-image?${imageParams.toString()}`

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="MeshPort">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${image}">
</head>
<body></body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300') // 5 min — new users/name changes show up promptly, not instantly
  return res.status(200).send(html)
}
