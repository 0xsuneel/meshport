import { useEffect, useState } from 'react'
import { useNavigate, useParams, Navigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'
import { formatAmount, trimTrailingZeros } from '@/lib/utils'
import { activitySign, activityLabel, type ActivityRecord } from '@/lib/ActivityService'
import { deriveActivityRow, activityRowIcon } from '@/features/activity/ActivityPage'
import { ActionIcon, type ActionIconName } from '@/components/ui/ActionIcon'
import { loadAssetSlot } from '@/lib/assetSlot'
import { fetchBtcPriceUsd } from '@/lib/btcPrice'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// One asset's own page (Home → Assets → tap a token): balance, that token's
// actions, and its history underneath. Actions open with the token already
// chosen: USDC → Pay / Swap / Transfer; EURC and cirBTC → Pay / Receive.
type AssetToken = 'USDC' | 'EURC' | 'cirBTC'
const TOKENS: Record<AssetToken, { name: string; logo: string; fallbackChar: string; fallbackColor: string }> = {
  USDC:   { name: 'USD Coin',      logo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',       fallbackChar: '$', fallbackColor: 'var(--usdc-icon)' },
  EURC:   { name: 'Euro Coin',     logo: 'https://assets.coingecko.com/coins/images/26045/small/euro-coin.png', fallbackChar: '€', fallbackColor: 'var(--usdc-icon)' },
  cirBTC: { name: 'Celo Bitcoin',  logo: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',       fallbackChar: '₿', fallbackColor: '#F7931A' },
}
const ACTIONS: Record<AssetToken, { label: string; icon: ActionIconName; path: string }[]> = {
  USDC: [
    { label: 'Pay',      icon: 'pay',  path: '/pay?token=USDC' },
    { label: 'Swap',     icon: 'swap', path: '/swap' },
    { label: 'Transfer', icon: 'hub',  path: '/multichain?tab=transfer' },
  ],
  EURC: [
    { label: 'Pay',     icon: 'pay',     path: '/pay?token=EURC' },
    { label: 'Receive', icon: 'receive', path: '/receive' },
  ],
  cirBTC: [
    { label: 'Pay',     icon: 'pay',     path: '/pay?token=cirBTC' },
    { label: 'Receive', icon: 'receive', path: '/receive' },
  ],
}

const SKEL = 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
const sortNewest = (a: ActivityRecord, b: ActivityRecord) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()

/** Everything that moved this token: direct activity in it, plus swaps in or out of it. */
async function loadAssetHistory(walletAddress: string, token: AssetToken): Promise<ActivityRecord[]> {
  const { fetchActivity } = await import('@/lib/ActivityService')
  const directTypes = new Set(['send', 'receive', 'claim', 'bridge', 'deposit', 'bulk'])
  const records = await fetchActivity(walletAddress, { limit: 100 })
  const direct = records.filter(r => directTypes.has(r.activityType) && (r.tokenSymbol || 'USDC') === token)
  // Swaps come separately (fetchActivity's default type filter doesn't
  // cover them); a USDC→EURC swap belongs in both tokens' histories.
  const swaps = (await fetchActivity(walletAddress, { activityType: 'swap', limit: 100 }))
    .filter(r => r.metadata?.tokenIn === token || r.metadata?.tokenOut === token)
  return [...direct, ...swaps].sort(sortNewest)
}

function fmtTokenAmount(n: number, token: AssetToken): string {
  if (token === 'cirBTC') return n > 0 ? trimTrailingZeros(n < 0.0001 ? n.toFixed(8) : n.toFixed(6)) : '0'
  return formatAmount(n)
}

export function AssetPage() {
  const { token: param } = useParams()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const walletAddress = useAuthStore(s => s.walletAddress)
  const usdcBalance = useWalletStore(s => s.balance)
  const token = (Object.keys(TOKENS) as AssetToken[]).find(t => t.toLowerCase() === (param || '').toLowerCase())

  const [history, setHistory] = useState<ActivityRecord[] | null>(null)
  const [btcPrice, setBtcPrice] = useState(0)
  const [hidden] = useState(() => { try { return localStorage.getItem('meshport_balance_hidden') === '1' } catch { return false } })

  useEffect(() => {
    if (!token || !walletAddress) { setHistory([]); return }
    let cancelled = false
    setHistory(null)
    loadAssetHistory(walletAddress, token)
      .then(h => { if (!cancelled) setHistory(h) })
      .catch(() => { if (!cancelled) setHistory([]) })
    return () => { cancelled = true }
  }, [token, walletAddress])
  useEffect(() => {
    if (token !== 'cirBTC') return
    let cancelled = false
    fetchBtcPriceUsd().then(p => { if (!cancelled && p) setBtcPrice(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [token])

  if (!token) return <Navigate to="/" replace />
  const slot = loadAssetSlot(walletAddress)
  const amount = token === 'USDC' ? Number(usdcBalance) || 0 : token === 'EURC' ? slot.eurc : slot.cirbtc
  const usd = token === 'USDC' ? amount : token === 'EURC' ? amount * 1.08 : amount * btcPrice
  const usdStr = token === 'cirBTC' && amount > 0 && btcPrice === 0 ? 'Fetching…'
    : `$${trimTrailingZeros(usd.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
  const actions = ACTIONS[token]

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 90 }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(20px)',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + var(--header-gap, 22px))',
        paddingBottom: 18, paddingLeft: 20, paddingRight: 20,
        minHeight: 44, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-primary" />
        </button>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{token}</div>
      </div>

      <div style={{ maxWidth: isDesktop ? 560 : undefined, margin: '0 auto' }}>
        {/* Balance */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 20px 4px' }}>
          <TokenLogo token={token} />
          <div style={{ marginTop: 14, fontSize: 34, fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>
            {hidden ? '••••' : usdStr}
          </div>
          <div style={{ marginTop: 4, fontSize: 15, fontWeight: 600, color: 'var(--brand-text)' }}>
            {hidden ? '••••' : `${fmtTokenAmount(amount, token)} ${token}`}
          </div>
        </div>

        {/* Actions - same round buttons as Home */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: actions.length === 3 ? 30 : 46, padding: '20px 20px 24px' }}>
          {actions.map(a => (
            <button key={a.label} onClick={() => navigate(a.path)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 'none',
                padding: 0, cursor: 'pointer', color: 'var(--text-primary)', font: 'inherit', minWidth: 64 }}>
              <span style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--brand)',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ActionIcon name={a.icon} size={27} />
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>{a.label}</span>
            </button>
          ))}
        </div>

        {/* History */}
        <div style={{ padding: '0 20px' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>History</div>
          {history === null ? (
            [0, 1, 2, 3].map(i => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px' }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: SKEL, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ width: '45%', height: 12, borderRadius: 6, background: SKEL }} />
                  <div style={{ width: '30%', height: 10, borderRadius: 6, marginTop: 7, background: SKEL }} />
                </div>
              </div>
            ))
          ) : history.length === 0 ? (
            <div style={{ padding: '36px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>No {token} transactions yet</div>
          ) : history.map((item, i) => (
            <HistoryRow key={item.id || i} item={item} token={token}
              // Tap a row → Activity, with that transaction opened.
              onOpen={() => navigate('/activity', { state: { openActivity: item } })} />
          ))}
        </div>
      </div>
    </div>
  )
}

function TokenLogo({ token }: { token: AssetToken }) {
  const info = TOKENS[token]
  const [imgOk, setImgOk] = useState(true)
  return (
    <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', background: info.fallbackColor,
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 24, fontWeight: 800 }}>
      {imgOk
        ? <img src={info.logo} alt={token} style={{ width: 56, height: 56, objectFit: 'cover' }} onError={() => setImgOk(false)} />
        : info.fallbackChar}
    </div>
  )
}

function HistoryRow({ item, token, onOpen }: { item: ActivityRecord; token: AssetToken; onOpen: () => void }) {
  const type = item.activityType
  const meta: any = item.metadata || {}
  const { title: derivedTitle, subtitle: derivedSubtitle, isPending, isClaim, isReceive, isBulkReceived, isP2PCredit } = deriveActivityRow(item)

  // Swaps are stored once, tagged with the input side - re-sign and
  // re-amount for the side this page's token was on.
  let sign: '+' | '-' | '↔' = activitySign(type, meta.direction)
  let displayAmount = item.amount
  if (type === 'swap') {
    if (token === meta.tokenOut) { sign = '+'; displayAmount = meta.amountOut ?? item.amount }
    else { sign = '-'; displayAmount = meta.amountIn ?? item.amount }
  }
  const color = sign === '+' ? 'var(--success)' : sign === '-' ? 'var(--danger)' : 'var(--text-secondary)'

  let title = derivedTitle
  let subtitle = derivedSubtitle
  if (type === 'deposit') {
    title = activityLabel(type)
    subtitle = `From ${(item.sourceChain || '').replace(/_/g, ' ')}`
  } else if (!['send', 'receive', 'swap', 'bulk', 'bridge', 'claim', 'p2p_sell_order', 'p2p_refund', 'p2p_purchase'].includes(type)) {
    title = activityLabel(type)
    const a = item.counterpartyAddress
    subtitle = a ? a.slice(0, 6) + '...' + a.slice(-6) : type
  }

  const rawDate = item.createdAt || (item as any).updatedAt
  const d = rawDate ? new Date(rawDate) : null
  const dateStr = d && !isNaN(d.getTime())
    ? `${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '-'

  // Small amounts (cirBTC, testnet dust) keep their real digits.
  const amtNum = Number(displayAmount) || 0
  const amtAbs = Math.abs(amtNum)
  const amountStr = amtAbs !== 0 && amtAbs < 0.01
    ? trimTrailingZeros(amtAbs < 0.0001 ? amtNum.toFixed(8) : amtNum.toFixed(6))
    : formatAmount(amtNum)

  const incoming = isClaim || isReceive || isBulkReceived || isP2PCredit || (type === 'swap' && sign === '+')
  const icon = activityRowIcon(item)
  return (
    <button onClick={onOpen}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', textAlign: 'left',
        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', font: 'inherit' }}>
      <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
        background: isPending ? 'color-mix(in srgb, var(--warning) 12%, transparent)' : incoming ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {isPending ? <ActionIcon name="clock" size={18} color="var(--warning)" />
          : icon ? <ActionIcon name={icon} size={18} color={incoming ? 'var(--success)' : 'var(--brand-text)'} />
          : <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M10 5l3 3-3 3" stroke="var(--brand-text)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color }}>{sign}{amountStr} {token}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{dateStr}</div>
      </div>
    </button>
  )
}
