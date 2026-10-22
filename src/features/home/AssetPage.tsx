import { useEffect, useState } from 'react'
import { useNavigate, useParams, Navigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { useAuthStore, useWalletStore } from '@/store'
import { formatAmount, trimTrailingZeros } from '@/lib/utils'
import { type ActivityRecord } from '@/lib/ActivityService'
import { ActivityRow, DetailSheet, recordMovesToken } from '@/features/activity/ActivityPage'
import { ActionIcon, type ActionIconName } from '@/components/ui/ActionIcon'
import { loadAssetSlot } from '@/lib/assetSlot'
import { fetchBtcPriceUsd } from '@/lib/btcPrice'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// One asset's own page (Home → Assets → tap a token): balance, that token's
// actions, and its history underneath. Actions open with the token already
// chosen: USDC → Pay / Receive / Swap / Transfer; EURC and cirBTC → Pay /
// Receive / Swap.
type AssetToken = 'USDC' | 'EURC' | 'cirBTC'
const TOKENS: Record<AssetToken, { name: string; logo: string; fallbackChar: string; fallbackColor: string }> = {
  USDC:   { name: 'USD Coin',      logo: '/logos/tokens/usdc.png',       fallbackChar: '$', fallbackColor: 'var(--usdc-icon)' },
  EURC:   { name: 'Euro Coin',     logo: '/logos/tokens/eurc.png', fallbackChar: '€', fallbackColor: 'var(--usdc-icon)' },
  cirBTC: { name: 'Celo Bitcoin',  logo: '/logos/tokens/cirbtc.png',       fallbackChar: '₿', fallbackColor: '#F7931A' },
}
const ACTIONS: Record<AssetToken, { label: string; icon: ActionIconName; path: string }[]> = {
  USDC: [
    { label: 'Pay',      icon: 'pay',     path: '/pay?token=USDC' },
    { label: 'Receive',  icon: 'receive', path: '/receive?token=USDC' },
    { label: 'Swap',     icon: 'swap',    path: '/swap?from=USDC' },
    { label: 'Transfer', icon: 'hub',     path: '/multichain?tab=transfer' },
  ],
  EURC: [
    { label: 'Pay',     icon: 'pay',     path: '/pay?token=EURC' },
    { label: 'Receive', icon: 'receive', path: '/receive?token=EURC' },
    { label: 'Swap',    icon: 'swap',    path: '/swap?from=EURC' },
  ],
  cirBTC: [
    { label: 'Pay',     icon: 'pay',     path: '/pay?token=cirBTC' },
    { label: 'Receive', icon: 'receive', path: '/receive?token=cirBTC' },
    { label: 'Swap',    icon: 'swap',    path: '/swap?from=cirBTC' },
  ],
}

const SKEL = 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
const sortNewest = (a: ActivityRecord, b: ActivityRecord) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()

// How many of this token's latest transactions show here; "See all" opens
// the main Activity page filtered to the token (same rows, same details).
const RECENT = 8

/** Everything that moved this token (same rule as Activity's token filter), newest first. */
async function loadAssetHistory(walletAddress: string, token: AssetToken): Promise<ActivityRecord[]> {
  const { fetchActivity } = await import('@/lib/ActivityService')
  const records = await fetchActivity(walletAddress, { limit: 100 })
  // Swaps come separately (fetchActivity's default type filter doesn't
  // cover them); a USDC→EURC swap belongs in both tokens' histories.
  const swaps = await fetchActivity(walletAddress, { activityType: 'swap', limit: 100 })
  const seen = new Set<string>()
  return [...records, ...swaps]
    .filter(r => r.activityType !== 'deposit' && recordMovesToken(r, token))
    .filter(r => { const k = r.id || `${r.txHash}_${r.activityType}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort(sortNewest)
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
  // The transaction whose details are open (shown here, over this page).
  const [selected, setSelected] = useState<ActivityRecord | null>(null)
  // The row last opened flashes once when its details close (same as Activity).
  const [flashId, setFlashId] = useState<string | null>(null)
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
        <div style={{ display: 'flex', justifyContent: 'center', gap: actions.length === 4 ? 18 : 30, padding: '20px 20px 24px' }}>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>History</span>
            {history && history.length > 0 && (
              <button onClick={() => navigate(`/activity?token=${token}`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--brand-text)', padding: 0 }}>
                See all
              </button>
            )}
          </div>
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
          ) : history.slice(0, RECENT).map((item, i, list) => (
            <ActivityRow key={item.id || i} record={item} isFirst={i === 0} isLast={i === list.length - 1}
              onSelect={() => { setFlashId(null); setSelected(item) }} flash={!!item.id && item.id === flashId} />
          ))}
        </div>
      </div>
      <AnimatePresence>
        {selected && <DetailSheet key={selected.id} record={selected} onClose={() => { setFlashId(selected.id ?? null); setSelected(null) }} />}
      </AnimatePresence>
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
