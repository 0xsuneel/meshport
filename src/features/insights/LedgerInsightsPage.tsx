// Ledger Insights - Insights for approved merchants (normal users keep
// InsightsPage). Everything here comes from the merchant's own records:
//   • order payments (merchant_payments) and payments received straight to
//     the wallet on other chains (merchant_chain_receipts) - the same list the
//     Ledger shows (withChainReceipts)
//   • payment requests / bills (merchant_payment_intents)
//   • merchant claims moved to Arc (activity claims, isMerchantClaim)
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowUp, ArrowDown } from 'lucide-react'
import { format, getHours, getDay, startOfWeek, startOfMonth, startOfYear, subWeeks, subMonths, subYears, getDaysInMonth } from 'date-fns'
import { useAuthStore } from '@/store'
import { formatAmount, timeAgo } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { listMyIntents, listMyPayments, listChainReceipts, type MerchantIntent, type MerchantPayment } from '@/lib/merchantPay'
import { fetchActivity } from '@/lib/ActivityService'
import { isMerchantClaim, useMerchant } from '@/lib/merchant'
import { chainLogoSrc } from '@/lib/chainLogos'
import { withChainReceipts, customersOf, customerKey } from '@/features/merchant/MerchantLedger'
import { SkeletonRows } from '@/components/ui/Skeleton'

type Period = 'week' | 'month' | 'year'

const PERIOD_LABEL: Record<Period, string> = { week: 'This Week', month: 'This Month', year: 'This Year' }
const PREV_LABEL: Record<Period, string> = { week: 'last week', month: 'last month', year: 'last year' }

function periodRange(period: Period, back = 0): [number, number] {
  const now = new Date()
  const start = period === 'week' ? startOfWeek(subWeeks(now, back), { weekStartsOn: 1 })
              : period === 'month' ? startOfMonth(subMonths(now, back))
              : startOfYear(subYears(now, back))
  const end = period === 'week' ? startOfWeek(subWeeks(now, back - 1), { weekStartsOn: 1 })
            : period === 'month' ? startOfMonth(subMonths(now, back - 1))
            : startOfYear(subYears(now, back - 1))
  return [start.getTime(), end.getTime()]
}
const inRange = (iso: string | null | undefined, [a, b]: [number, number]) => {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return t >= a && t < b
}
const pct = (curr: number, prev: number) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : curr > 0 ? 100 : 0
const chainName = (id: string) => id === 'Arc_Testnet' ? 'Arc'
  : id.replace(/_(Sepolia|Testnet|Fuji|Apothem)$/, '').replace(/_/g, ' ')
const chainLogo = (id: string) => id === 'Arc_Testnet' ? '/logos/chains/arc.svg' : chainLogoSrc(id)

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: 16 }
const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }

function Change({ value, suffix }: { value: number; suffix: string }) {
  const up = value >= 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11.5, fontWeight: 600, color: up ? 'var(--success)' : 'var(--danger, #D64545)' }}>
      {up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(value)}% <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>&nbsp;vs {suffix}</span>
    </span>
  )
}

/** Revenue bars for the period: days (week / month) or months (year). */
function RevenueBars({ values, labels, highlight }: { values: number[]; labels: string[]; highlight: number }) {
  const max = Math.max(...values, 0)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: values.length > 14 ? 2 : 5, height: 96 }}>
        {values.map((v, i) => (
          <div key={i} title={`$${formatAmount(v)}`} style={{
            flex: 1, minWidth: 0, borderRadius: 4,
            height: max > 0 ? `${Math.max(4, (v / max) * 100)}%` : '4%',
            background: i === highlight && v > 0 ? 'var(--brand)' : v > 0 ? 'color-mix(in srgb, var(--brand) 45%, transparent)' : 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10.5, color: 'var(--text-secondary)' }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  )
}

function Stat({ title, value, sub }: { title: string; value: string; sub?: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: 14, minWidth: 0 }}>
      <div style={label}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  )
}

function Bar({ share }: { share: number }) {
  return (
    <div style={{ height: 6, borderRadius: 99, background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(2, Math.min(100, share))}%`, height: '100%', borderRadius: 99, background: 'var(--brand)' }} />
    </div>
  )
}

export function LedgerInsightsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress) ?? ''
  const { application } = useMerchant()
  const [period, setPeriod] = useState<Period>('month')
  const [payments, setPayments] = useState<MerchantPayment[]>([])
  const [intents, setIntents] = useState<MerchantIntent[]>([])
  const [claims, setClaims] = useState<Array<{ amount: number; createdAt: string; chain: string }>>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    Promise.all([
      listMyPayments(1000).catch(() => []),
      listMyIntents(500).catch(() => []),
      listChainReceipts(1000).catch(() => []),
      fetchActivity(walletAddress, { limit: 300 }).catch(() => []),
    ]).then(([p, i, r, acts]) => {
      if (cancelled) return
      setPayments(withChainReceipts(p, r, walletAddress))
      setIntents(i)
      setClaims((acts as any[])
        .filter(a => a.activityType === 'claim' && a.status === 'completed' && isMerchantClaim(a))
        .map(a => ({ amount: Number(a.amount) || 0, createdAt: a.createdAt, chain: a.sourceChain ?? '' })))
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [walletAddress])

  const s = useMemo(() => {
    const cur = periodRange(period, 0)
    const prev = periodRange(period, 1)
    const curPay = payments.filter(p => inRange(p.createdAt, cur))
    const prevPay = payments.filter(p => inRange(p.createdAt, prev))
    const revenue = curPay.reduce((a, p) => a + p.amount, 0)
    const prevRevenue = prevPay.reduce((a, p) => a + p.amount, 0)

    // Customers: anyone who paid this period; "new" = first payment ever in it.
    const firstPaid = new Map<string, number>()
    for (const p of payments) {
      const k = customerKey(p), t = new Date(p.createdAt).getTime()
      if (!firstPaid.has(k) || t < firstPaid.get(k)!) firstPaid.set(k, t)
    }
    const curCustomers = customersOf(curPay)
    const prevCustomers = customersOf(prevPay)
    const newCustomers = curCustomers.filter(c => (firstPaid.get(c.key) ?? 0) >= cur[0]).length

    // Revenue bars.
    const now = new Date()
    let bars: number[], labels: string[]
    if (period === 'year') {
      bars = Array(12).fill(0)
      curPay.forEach(p => { bars[new Date(p.createdAt).getMonth()] += p.amount })
      labels = ['Jan', 'Apr', 'Jul', 'Oct', 'Dec']
    } else if (period === 'month') {
      bars = Array(getDaysInMonth(now)).fill(0)
      curPay.forEach(p => { bars[new Date(p.createdAt).getDate() - 1] += p.amount })
      const m = format(now, 'MMM')
      labels = [1, 8, 15, 22, bars.length].map(d => `${m} ${d}`)
    } else {
      bars = Array(7).fill(0)
      curPay.forEach(p => { bars[(getDay(new Date(p.createdAt)) + 6) % 7] += p.amount })
      labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    }
    const best = bars.indexOf(Math.max(...bars))

    // Revenue by chain.
    const byChain = new Map<string, { amount: number; count: number }>()
    curPay.forEach(p => {
      const c = byChain.get(p.chain) ?? { amount: 0, count: 0 }
      c.amount += p.amount; c.count += 1; byChain.set(p.chain, c)
    })
    const chains = [...byChain.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.amount - a.amount)
    const external = curPay.filter(p => p.chain !== 'Arc_Testnet').reduce((a, p) => a + p.amount, 0)

    // Moved to Arc (merchant claims) in the period.
    const curClaims = claims.filter(c => inRange(c.createdAt, cur))
    const movedToArc = curClaims.reduce((a, c) => a + c.amount, 0)

    // Requests & bills created this period.
    const curReq = intents.filter(i => inRange(i.createdAt, cur))
    const paidReq = curReq.filter(i => i.status === 'paid')
    const openReq = curReq.filter(i => ['pending', 'partially_paid', 'processing'].includes(i.status))
    const lostReq = curReq.filter(i => ['expired', 'cancelled', 'failed'].includes(i.status))
    const payTimes = paidReq.filter(i => i.paidAt).map(i => new Date(i.paidAt!).getTime() - new Date(i.createdAt).getTime()).filter(ms => ms >= 0)
    const avgPayMins = payTimes.length ? payTimes.reduce((a, b) => a + b, 0) / payTimes.length / 60_000 : null

    // When customers pay.
    const hours = Array(24).fill(0), days = Array(7).fill(0)
    curPay.forEach(p => { const d = new Date(p.createdAt); hours[getHours(d)] += 1; days[(getDay(d) + 6) % 7] += 1 })
    const peakHour = curPay.length ? hours.indexOf(Math.max(...hours)) : null
    const peakDay = curPay.length ? days.indexOf(Math.max(...days)) : null

    return {
      revenue, revenueChange: pct(revenue, prevRevenue),
      count: curPay.length, countChange: pct(curPay.length, prevPay.length),
      avg: curPay.length ? revenue / curPay.length : 0,
      largest: curPay.length ? Math.max(...curPay.map(p => p.amount)) : 0,
      customers: curCustomers, customersChange: pct(curCustomers.length, prevCustomers.length), newCustomers,
      bars, labels, best, chains, external, movedToArc, claimsCount: curClaims.length,
      curReq, paidReq, openReq, lostReq, avgPayMins,
      peakHour, peakDay,
      recent: curPay.slice(0, 5),
    }
  }, [payments, intents, claims, period])

  const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  const fmtMins = (m: number) => m < 1 ? 'under a minute' : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`
  const conversion = s.curReq.length ? Math.round((s.paidReq.length / s.curReq.length) * 100) : null
  const businessName = application?.businessName as string | undefined

  return (
    <div className="flex-1 overflow-y-auto lg:max-w-[900px]" style={{ background: 'var(--bg)' }}>
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + var(--header-gap, 22px))', paddingLeft: 20, paddingRight: 20, position: 'sticky', top: 0, zIndex: 20, background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 16 }}>
          {!isDesktop && (
            <button onClick={() => navigate('/')} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px', lineHeight: 1.2 }}>Ledger Insights</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {businessName ? `${businessName} · sales and customers` : 'Your sales and customers'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 14px 28px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Period */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['week', 'month', 'year'] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '6px 12px', borderRadius: 22, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              background: period === p ? 'var(--brand)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
              border: `1px solid ${period === p ? 'var(--brand)' : 'color-mix(in srgb, var(--brand) 20%, transparent)'}`,
              color: period === p ? '#fff' : 'var(--brand-text)',
            }}>{PERIOD_LABEL[p]}</button>
          ))}
        </div>

        {!loaded ? <SkeletonRows count={5} className="px-0" /> : (
          <>
            {/* Revenue */}
            <div style={{ ...card, borderColor: 'color-mix(in srgb, var(--brand) 28%, transparent)' }}>
              <div style={label}>Revenue · {PERIOD_LABEL[period].toLowerCase()}</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-1px', margin: '4px 0 2px' }}>${formatAmount(s.revenue)}</div>
              <Change value={s.revenueChange} suffix={PREV_LABEL[period]} />
              <div style={{ marginTop: 14 }}>
                <RevenueBars values={s.bars} labels={s.labels} highlight={s.best} />
              </div>
            </div>

            {/* Key numbers */}
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? 'repeat(4, 1fr)' : '1fr 1fr', gap: 10 }}>
              <Stat title="Payments" value={String(s.count)} sub={<Change value={s.countChange} suffix={PREV_LABEL[period]} />} />
              <Stat title="Customers" value={String(s.customers.length)} sub={`${s.newCustomers} new`} />
              <Stat title="Avg payment" value={`$${formatAmount(s.avg)}`} sub="per payment" />
              <Stat title="Largest" value={`$${formatAmount(s.largest)}`} sub="single payment" />
            </div>

            {/* Where customers pay */}
            <div style={card}>
              <div style={{ ...label, marginBottom: 12 }}>Where customers pay</div>
              {s.chains.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No payments {PERIOD_LABEL[period].toLowerCase()} yet.</div>
              ) : s.chains.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <img src={chainLogo(c.id)} alt="" width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0 }}
                    onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5, marginBottom: 5 }}>
                      <b style={{ color: 'var(--text-primary)' }}>{chainName(c.id)}</b>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>${formatAmount(c.amount)} <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>· {c.count}</span></span>
                    </div>
                    <Bar share={s.revenue > 0 ? (c.amount / s.revenue) * 100 : 0} />
                  </div>
                </div>
              ))}
            </div>

            {/* Other chains → Arc */}
            <div style={card}>
              <div style={{ ...label, marginBottom: 10 }}>Other chains → Arc</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Received on other chains</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginTop: 2 }}>${formatAmount(s.external)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Moved to Arc</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--success)', marginTop: 2 }}>${formatAmount(s.movedToArc)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{s.claimsCount} claim{s.claimsCount === 1 ? '' : 's'}</div>
                </div>
              </div>
              <button onClick={() => navigate('/multichain', { state: { tab: 'bring' } })}
                style={{ marginTop: 12, width: '100%', padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--brand-text)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                Open Ledger
              </button>
            </div>

            {/* Top customers */}
            <div style={card}>
              <div style={{ ...label, marginBottom: 10 }}>Top customers</div>
              {s.customers.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Customers who pay you will show here.</div>
              ) : [...s.customers].sort((a, b) => b.total - a.total).slice(0, 5).map((c, i) => (
                <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800,
                    background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: 'var(--brand-text)' }}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.count} payment{c.count === 1 ? '' : 's'} · last {timeAgo(c.last)}</div>
                  </div>
                  <b style={{ fontSize: 14, color: 'var(--text-primary)', flexShrink: 0 }}>${formatAmount(c.total)}</b>
                </div>
              ))}
            </div>

            {/* Requests & bills */}
            <div style={card}>
              <div style={{ ...label, marginBottom: 10 }}>Payment requests & bills</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, textAlign: 'center' }}>
                {[['Created', s.curReq.length, 'var(--text-primary)'], ['Paid', s.paidReq.length, 'var(--success)'], ['Open', s.openReq.length, 'var(--warning)'], ['Expired', s.lostReq.length, 'var(--text-secondary)']].map(([t, n, col]) => (
                  <div key={t as string}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: col as string }}>{n as number}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t as string}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {conversion == null ? 'No requests or bills created in this period.'
                  : <>Paid rate <b style={{ color: 'var(--text-primary)' }}>{conversion}%</b>{s.avgPayMins != null && <> · paid in <b style={{ color: 'var(--text-primary)' }}>{fmtMins(s.avgPayMins)}</b> on average</>}</>}
              </div>
            </div>

            {/* When customers pay */}
            <div style={card}>
              <div style={{ ...label, marginBottom: 10 }}>When customers pay</div>
              {s.peakHour == null ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Not enough payments yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Busiest hour</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 2 }}>{format(new Date().setHours(s.peakHour, 0, 0, 0), 'h a')}–{format(new Date().setHours((s.peakHour + 1) % 24, 0, 0, 0), 'h a')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Busiest day</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 2 }}>{DAY[s.peakDay!]}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Latest payments */}
            {s.recent.length > 0 && (
              <div style={card}>
                <div style={{ ...label, marginBottom: 6 }}>Latest payments</div>
                {s.recent.map((p, i) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                    <img src={chainLogo(p.chain)} alt="" width={22} height={22} style={{ borderRadius: '50%', flexShrink: 0 }}
                      onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
                    <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{customersOf([p])[0]?.name}</span> · {chainName(p.chain)}{p.orderNumber ? ` · #${p.orderNumber}` : ''} · {timeAgo(p.createdAt)}
                    </div>
                    <b style={{ fontSize: 13.5, color: 'var(--success)', flexShrink: 0 }}>+${formatAmount(p.amount)}</b>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
