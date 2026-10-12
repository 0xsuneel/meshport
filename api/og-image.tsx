import { ImageResponse } from '@vercel/og'

/**
 * GET /api/og-image?name=&username=&avatar=&amount=&currency=&label=&status=&memo=&path=&kind=
 * GET /api/og-image?variant=default
 *
 * Renders the 1200x630 PNG used as og:image for payment link previews (see
 * api/og-pay.ts, which builds this URL and points bots at it). Runs on the
 * Edge runtime because @vercel/og needs it.
 *
 * Layout: a white "ticket" on a soft mint backdrop. Header: MeshPort logo +
 * a pill (Pay link / Bill ORD-… / Request ORD-…). Body: the recipient's
 * avatar - their real photo if set, else a coloured initials badge - with
 * "Pay", their name and @handle.arc; with `amount` the amount sits on the
 * right ("Amount" / "Amount due" / "Paid", currency under it). A perforated
 * divider separates the footer: the link path on the left and the payment
 * status on the right (Awaiting payment / Partially paid / Paid / Expired).
 *
 * `variant=default` renders the generic site card (public/og-default.png is
 * a saved copy of it).
 */

export const config = { runtime: 'edge' }

// The MeshPort mark (public/favicon.svg rendered to a 192px PNG), inlined as a
// data URI so the edge runtime doesn't need a network round-trip to fetch it.
const LOGO_DATA_URI =
  'data:image/png;base64,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'

// Inter, served from public/fonts/og. Loaded once per instance; without it
// Satori falls back to a single regular weight and every heading looks flat.
const FONT_WEIGHTS = [500, 600, 700, 800] as const
let fontsPromise: Promise<{ name: string; data: ArrayBuffer; weight: 500 | 600 | 700 | 800; style: 'normal' }[]> | null = null
function loadFonts(origin: string) {
  if (!fontsPromise) {
    fontsPromise = Promise.all(FONT_WEIGHTS.map(async weight => {
      const r = await fetch(`${origin}/fonts/og/inter-${weight}.woff`)
      if (!r.ok) throw new Error(`font ${weight}: ${r.status}`)
      return { name: 'Inter', data: await r.arrayBuffer(), weight, style: 'normal' as const }
    })).catch(err => {
      fontsPromise = null // retry on the next request instead of caching the failure
      throw err
    })
  }
  return fontsPromise
}

const INK = '#0B2B27'
const TEAL = '#0F5C57'
const TEAL_TEXT = '#0F7A6C'
const MUTED = '#5F716D'
const BACKDROP = '#E7F1EE'
const LINE = '#D5E0DD'

// Avatar badge gradients, picked per user so the same person always gets the same colour.
const GRADIENTS: [string, string][] = [
  ['#3CC48F', '#0E8A64'],
  ['#F7AE3A', '#DF6F16'],
  ['#5AA8F5', '#2D6FD6'],
  ['#9B7BF7', '#6A47D9'],
  ['#F2798F', '#D24668'],
]
function pickGradient(seed: string): [string, string] {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length]
}

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)

const CURRENCIES: Record<string, { symbol: string; decimals: number }> = {
  USDC: { symbol: '$', decimals: 2 },
  EURC: { symbol: '€', decimals: 2 },
  cirBTC: { symbol: '', decimals: 8 },
}

/** "10" → "$10", "10.5" → "$10.50", EURC → "€20", cirBTC → "0.0021". Empty when not a positive number. */
function formatAmount(raw: string, currency: string): string {
  const n = Number(raw)
  if (!raw || !Number.isFinite(n) || n <= 0 || n > 1e12) return ''
  const c = CURRENCIES[currency] || CURRENCIES.USDC
  const whole = Number.isInteger(n)
  return c.symbol + n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : Math.min(2, c.decimals), maximumFractionDigits: c.decimals })
}

const STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: 'Awaiting payment', color: '#C2620A' },
  partially_paid: { text: 'Partially paid', color: '#C2620A' },
  paid: { text: 'Paid', color: '#15803D' },
  expired: { text: 'Expired', color: '#6B7280' },
  cancelled: { text: 'Cancelled', color: '#6B7280' },
}
const STATUS_DOT: Record<string, string> = { pending: '#F59E0B', partially_paid: '#F59E0B', paid: '#22C55E', expired: '#9CA3AF', cancelled: '#9CA3AF' }

const svgUri = (svg: string) => 'data:image/svg+xml;base64,' + btoa(svg)

// The logo's node graph, drawn large and faint on cards with no amount.
const MOTIF = svgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 44 124 120"><g stroke="#DCE6E3" stroke-width="9" stroke-linecap="round" fill="none">' +
  '<line x1="100" y1="100" x2="62" y2="64"/><line x1="100" y1="100" x2="146" y2="58"/><line x1="100" y1="100" x2="150" y2="118"/><line x1="100" y1="100" x2="108" y2="152"/><line x1="100" y1="100" x2="54" y2="142"/>' +
  '<circle cx="62" cy="64" r="12" fill="#fff"/><circle cx="146" cy="58" r="13" fill="#fff"/><circle cx="150" cy="118" r="9" fill="#fff"/><circle cx="108" cy="152" r="8" fill="#fff"/><circle cx="54" cy="142" r="16" fill="#fff"/><circle cx="100" cy="100" r="22" fill="#fff"/></g></svg>',
)
const WALLET = svgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v4h-4a2 2 0 0 0 0 4h4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/></svg>',
)

function Pill({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', padding: '9px 22px', borderRadius: 999, background: '#E1F2EE', color: TEAL, fontSize: 24, fontWeight: 700 }}>
      {text}
    </div>
  )
}

function Dot({ color }: { color: string }) {
  return <div style={{ display: 'flex', width: 12, height: 12, borderRadius: 6, background: color }} />
}

/** The white ticket every card is drawn on: header, body, perforation, footer. */
function Ticket({ pill, body, footLeft, footRight }: { pill: string; body: any; footLeft: string; footRight: { text: string; color: string; dot: string } }) {
  const perforationY = 404
  return (
    <div style={{ width: 1200, height: 630, display: 'flex', background: `linear-gradient(180deg, #EEF6F4 0%, ${BACKDROP} 100%)`, padding: 44, fontFamily: 'Inter' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', background: '#FFFFFF', borderRadius: 36, boxShadow: '0 18px 44px rgba(16,64,56,0.10)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '44px 56px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img src={LOGO_DATA_URI} width={60} height={60} />
            <div style={{ display: 'flex', fontSize: 36, fontWeight: 800, color: INK, letterSpacing: '-0.02em' }}>MeshPort</div>
          </div>
          <Pill text={pill} />
        </div>

        <div style={{ display: 'flex', height: perforationY - 104, alignItems: 'center', padding: '0 56px' }}>{body}</div>

        <div style={{ position: 'absolute', left: 56, right: 56, top: perforationY, display: 'flex', borderTop: `2px dashed ${LINE}` }} />
        <div style={{ position: 'absolute', left: -24, top: perforationY - 24, width: 48, height: 48, borderRadius: 24, display: 'flex', background: BACKDROP }} />
        <div style={{ position: 'absolute', right: -24, top: perforationY - 24, width: 48, height: 48, borderRadius: 24, display: 'flex', background: BACKDROP }} />

        <div style={{ position: 'absolute', left: 56, right: 56, bottom: 0, height: 542 - perforationY, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 600, color: MUTED }}>{footLeft}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 26, fontWeight: 600, color: footRight.color }}>
            <Dot color={footRight.dot} />
            {footRight.text}
          </div>
        </div>
      </div>
    </div>
  )
}

function Avatar({ size, name, seed, avatar, wallet }: { size: number; name: string; seed: string; avatar: string; wallet: boolean }) {
  const ring = { border: `${Math.round(size / 26)}px solid #FFFFFF`, boxShadow: '0 12px 28px rgba(16,64,56,0.22)' }
  if (avatar) return <img src={avatar} width={size} height={size} style={{ borderRadius: '50%', objectFit: 'cover', ...ring }} />
  const [c1, c2] = pickGradient(seed)
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(145deg, ${c1}, ${c2})`, color: '#FFFFFF', fontSize: Math.round(size * 0.34), fontWeight: 800, ...ring }}>
      {wallet ? <img src={WALLET} width={Math.round(size * 0.46)} height={Math.round(size * 0.46)} /> : initialsFrom(name)}
    </div>
  )
}

function defaultCard() {
  return (
    <Ticket
      pill="USDC on Arc"
      footLeft="meshport.xyz"
      footRight={{ text: 'Instant · Just a username', color: MUTED, dot: '#2BB59A' }}
      body={
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 84, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.04 }}>
            <div style={{ display: 'flex', color: INK }}>USDC payments,</div>
            <div style={{ display: 'flex', color: '#13897A' }}>made simple.</div>
          </div>
          <img src={MOTIF} width={200} height={194} />
        </div>
      }
    />
  )
}

export default async function handler(req: Request) {
  const url = new URL(req.url)
  const { searchParams } = url
  let fonts: Awaited<ReturnType<typeof loadFonts>> | undefined
  try { fonts = await loadFonts(url.origin) } catch { /* plainer type beats no card */ }
  const opts = { width: 1200, height: 630, ...(fonts ? { fonts } : {}) }

  if (searchParams.get('variant') === 'default') return new ImageResponse(defaultCard(), opts)

  const name = (searchParams.get('name') || 'MeshPort User').slice(0, 40)
  const username = (searchParams.get('username') || '').slice(0, 40)
  // Avatars only from our own storage / Google profile photos - the image
  // renderer fetches this URL server-side, so arbitrary hosts aren't allowed.
  const avatar = (() => {
    const raw = searchParams.get('avatar') || ''
    try {
      const u = new URL(raw)
      return u.protocol === 'https:' && /(^|\.)(supabase\.co|googleusercontent\.com|meshport\.xyz)$/i.test(u.hostname) ? u.href : ''
    } catch { return '' }
  })()
  const rawCurrency = searchParams.get('currency') || 'USDC'
  const currency = CURRENCIES[rawCurrency] ? rawCurrency : 'USDC'
  const amount = formatAmount(searchParams.get('amount') || '', currency)
  const label = (searchParams.get('label') || '').slice(0, 40)
  const memo = clip(searchParams.get('memo') || '', 44)
  const path = clip((searchParams.get('path') || '').replace(/^https?:\/\//, ''), 44)
  const kind = searchParams.get('kind') === 'merchant' ? 'merchant' : 'personal'
  const rawStatus = searchParams.get('status') || ''
  const status = STATUS[rawStatus] ? rawStatus : amount ? 'pending' : ''
  const wallet = /^0x[0-9a-f]{4}/i.test(name) && !username

  const footRight = status
    ? { text: STATUS[status].text, color: STATUS[status].color, dot: STATUS_DOT[status] }
    : { text: `${currency} on Arc · instant`, color: MUTED, dot: '#2BB59A' }

  const amountLabel = status === 'paid' ? 'Paid' : kind === 'merchant' ? 'Amount due' : 'Amount'
  // Name and amount share one row: long amounts get a shorter name, and the
  // amount is sized to whatever width the name leaves (Inter 800 digits ≈ 0.62em).
  const nameMax = !amount ? 24 : amount.length > 7 ? 13 : 17
  const shownName = clip(name, nameMax)
  const personWidth = 128 + 30 + Math.max(shownName.length * 0.6 * 54, 200)
  const amountSize = Math.min(140, Math.floor((1000 - personWidth - 40) / (amount.length * 0.62)))

  const person = (
    <div style={{ display: 'flex', alignItems: 'center', gap: amount ? 30 : 40 }}>
      <Avatar size={amount ? 128 : 168} name={name} seed={username || name} avatar={avatar} wallet={wallet} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 500, color: MUTED }}>{status === 'paid' ? 'Paid to' : 'Pay'}</div>
        <div style={{ display: 'flex', fontSize: amount ? 54 : 66, fontWeight: 800, color: INK, letterSpacing: '-0.03em', lineHeight: 1.12 }}>{shownName}</div>
        {username ? <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, color: TEAL_TEXT }}>{clip(`${username}.arc`, 28)}</div> : null}
        {memo ? <div style={{ display: 'flex', fontSize: 22, fontWeight: 500, color: MUTED, marginTop: 10 }}>{memo}</div> : null}
      </div>
    </div>
  )

  const body = (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      {person}
      {amount ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 500, color: MUTED }}>{amountLabel}</div>
          <div style={{ display: 'flex', fontSize: amountSize, fontWeight: 800, color: status === 'paid' ? '#15803D' : TEAL, letterSpacing: '-0.045em', lineHeight: 1.02 }}>{amount}</div>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: MUTED }}>{currency}</div>
        </div>
      ) : (
        <img src={MOTIF} width={170} height={165} />
      )}
    </div>
  )

  return new ImageResponse(
    <Ticket pill={label || 'Pay link'} body={body} footLeft={path || 'meshport.xyz'} footRight={footRight} />,
    opts,
  )
}
