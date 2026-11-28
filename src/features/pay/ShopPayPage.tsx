// Public Shop QR page (/paylink/<business>?store=<id>). The customer types
// the amount, shop_open_order creates an order for that exact store, and
// the normal order page (/paylink/r/<code>) takes the payment - so every
// Shop QR payment is recorded in the owner's Business tab with its store.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, MapPin, Phone, Store } from 'lucide-react'
import { businessCurrency } from '@/lib/localCurrency'
import { formatFiat } from '@/lib/currencyRegistry'
import { supabase } from '@/lib/supabase'
import { getShopLimits, shopSubline, shopTitle, type ShopInfo, type ShopLimits } from '@/lib/shop'
import { useAuthStore, useUIStore, useWalletStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { errorText } from '@/lib/errorText'
import { openPayLinkOrder, type PublicPayLink } from '@/lib/businessCounters'

// Shop payments: cents, up to $100,000 - the same caps typed and on the keys.
const SHOP_DECIMALS = 2
const SHOP_MAX = 100000

// The payer's own currency (their phone's region): how much the dollars are
// locally, as Square shows a foreign card holder. One small read, cached 15 min.
const FX_KEY = 'meshport_fx_rate_v1'
function useLocalRate(): { currency: string; rate: number } | null {
  const [fx, setFx] = useState<{ currency: string; rate: number } | null>(null)
  useEffect(() => {
    const currency = businessCurrency()
    if (currency === 'USD') return
    try {
      const c = JSON.parse(sessionStorage.getItem(FX_KEY) || 'null')
      if (c && c.currency === currency && Date.now() - c.at < 15 * 60_000 && c.rate > 0) { setFx({ currency, rate: c.rate }); return }
    } catch { /* storage unavailable */ }
    let live = true
    void supabase.from('p2p_fx_rates').select('usd_rate').eq('currency', currency).maybeSingle().then(({ data }) => {
      const rate = Number((data as { usd_rate?: number } | null)?.usd_rate)
      if (!live || !(rate > 0)) return
      setFx({ currency, rate })
      try { sessionStorage.setItem(FX_KEY, JSON.stringify({ currency, rate, at: Date.now() })) } catch { /* storage unavailable */ }
    })
    return () => { live = false }
  }, [])
  return fx
}

// The amount as a big centred figure with a small raised $, grey while
// nothing is typed, shrinking as it grows. Desktop types into it directly.
function ShopAmount({ value, onType, balance, compact = false, approx }: {
  value: string; onType?: (raw: string) => void
  /** The amount in the payer's own currency ("≈ £0.79"), when it isn't USD. */
  approx?: string | null
  /** Signed in: the payer's Arc USDC balance (shown under the amount); null hides it. */
  balance?: number | null
  /** A short screen: smaller figure and less room around it. */
  compact?: boolean
}) {
  const shown = value || '0'
  const full = shown.length <= 4 ? 64 : shown.length <= 6 ? 54 : shown.length <= 8 ? 44 : 36
  const size = compact ? Math.round(full * 0.8) : full
  const color = value ? 'var(--text-primary)' : 'var(--text-muted)'
  const digits = { fontSize: size, fontWeight: 700, lineHeight: 1.1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' as const, color, opacity: value ? 1 : 0.45 }
  return (
    <div className={`flex flex-col items-center ${compact ? 'py-1' : 'py-6'}`}>
      <div className="flex items-start justify-center max-w-full" aria-live="polite">
        <span style={{ fontSize: Math.round(size * 0.45), fontWeight: 600, lineHeight: 1, marginTop: Math.round(size * 0.12), marginRight: 4, color: 'var(--text-muted)' }}>$</span>
        {onType ? (
          <input autoFocus inputMode="decimal" value={value} placeholder="0" aria-label="Amount in USDC"
            onChange={e => onType(e.target.value)}
            className="bg-transparent outline-none text-center p-0 border-0 placeholder:text-text-muted"
            style={{ ...digits, width: `${Math.max(1, shown.length) + 0.4}ch`, minWidth: '1ch' }} />
        ) : (
          <span style={digits} aria-label={`Amount ${shown} USDC`}>{shown}</span>
        )}
      </div>
      <span className={`${compact ? 'mt-2' : 'mt-3'} inline-flex items-center gap-1.5 rounded-full bg-surface border border-border px-3 py-1 text-xs font-semibold text-text-secondary`}>
        <img decoding="async" src="/logos/tokens/usdc.png" alt="" width={16} height={16} className="rounded-full" /> USDC
      </span>
      {approx && <p className="mt-1.5 text-[13px] text-text-muted tabular-nums">{approx}</p>}
      {balance != null && (
        // Rounded down, so it never shows more than can be paid.
        <p className={`mt-2 text-[13px] ${Number(value) > balance ? 'text-danger font-semibold' : 'text-text-muted'}`}>
          Available balance {(Math.floor(balance * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
        </p>
      )}
    </div>
  )
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ShopPayPage({ shop, initialAmount, wallet, counterId = null, link = null }: {
  shop: ShopInfo; initialAmount?: string | null
  /** The business's wallet (PayPage already looked it up), so Pay can open the pay screen at once. */
  wallet?: string | null
  /** A counter's own QR (?counter=): the payment is tagged with that counter. */
  counterId?: string | null
  /** A payment link (/l/<shop>/<slug>): its title, price (or any amount), and whether it asks for a name and phone. */
  link?: { slug: string; info: PublicPayLink } | null
}) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  // A short screen (an in-app browser's bars take ~150px; OKX leaves ~790px): everything above
  // the keys tightens so the whole keypad stays above the Pay button.
  const short = useMediaQuery('(max-height: 820px)') && !isDesktop
  const toast = useUIStore(s => s.showToastMessage)
  const signedIn = useAuthStore(s => s.isAuthenticated)
  // Signed in to MeshPort, a shop is paid on the normal pay screen, shown as
  // the business (28 Nov, as UPI apps do) - this page is for paying from
  // outside MeshPort (another wallet or network). Its store and counter go
  // along. Not a payment link (a product page), not the owner's own page.
  const myWallet = useAuthStore(s => s.walletAddress)
  const toPayScreen = signedIn && !link && !!wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)
    && (!myWallet || myWallet.toLowerCase() !== wallet.toLowerCase())
  useEffect(() => {
    if (!toPayScreen || !wallet) return
    const q = new URLSearchParams({ to: `${shop.username}|${wallet}|${shopTitle(shop)}|${shop.avatarUrl ?? ''}` })
    if (shop.storeId) q.set('store', shop.storeId)
    if (counterId) q.set('counter', counterId)
    if (initialAmount && Number(initialAmount) > 0) q.set('amount', String(Number(initialAmount)))
    navigate(`/pay?${q}`, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the shop is known
  }, [toPayScreen])
  // The same Arc USDC balance the pay screen shows (kept per wallet by the store).
  const balance = useWalletStore(s => s.balance)
  const fixed = link?.info.amount ?? null
  const [amount, setAmount] = useState(() => fixed !== null ? String(fixed) : initialAmount && Number(initialAmount) > 0 ? String(Number(initialAmount)) : '')
  const [payer, setPayer] = useState({ name: '', contact: '' })
  const localRate = useLocalRate()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [limits, setLimits] = useState<ShopLimits>({ min: null, max: null })
  useEffect(() => { getShopLimits(shop.username).then(setLimits).catch(() => {}) }, [shop.username])
  // While the amount is typed, fetch the pay screen's code, so tapping Pay
  // opens it at once (it took ~2s on mobile data when fetched after the tap).
  useEffect(() => {
    if (!signedIn) return
    import('@/features/paysend/PaySendPage').catch(() => {})
    import('@/lib/merchantPay').catch(() => {})
  }, [signedIn])

  // Typed (desktop): same caps as the keys (AmountKeypad's decimals / maxValue).
  const type = (raw: string) => {
    const next = sanitizeAmountInput(raw, SHOP_DECIMALS)
    if (Number(next) <= SHOP_MAX) setAmount(next)
  }
  const value = Number(amount) || 0
  const limitError = link ? (!link.info.open ? "This link isn't taking payments right now" : link.info.askContact && value && !payer.name.trim() ? 'Add your name' : null)
    : !value ? null
    : limits.min != null && value < limits.min ? `The smallest payment here is ${money(limits.min)}`
    : limits.max != null && value > limits.max ? `The largest payment here is ${money(limits.max)}` : null
  const limitHint = link ? null : limits.min != null && limits.max != null ? `${money(limits.min)} – ${money(limits.max)}`
    : limits.min != null ? `From ${money(limits.min)}` : limits.max != null ? `Up to ${money(limits.max)}` : null

  const go = async () => {
    setBusy(true)
    try {
      let data: string
      if (link) data = await openPayLinkOrder(shop.username, link.slug, fixed === null ? value : null, link.info.askContact ? payer : undefined)
      else {
        const r = await supabase.rpc('shop_open_order', { p_username: shop.username, p_amount: value, p_store: shop.storeId, p_note: note || null, ...(counterId ? { p_counter: counterId } : {}) })
        if (r.error) throw new Error(r.error.message)
        data = String(r.data)
      }
      const noteOut = link ? link.info.title : note
      // Signed in: straight to the pay screen's Review - the amount was just
      // typed here, so there is nothing to confirm on an order page. The
      // order page stays for paying from another wallet (it picks a network).
      // With the business's wallet known, go at once: the pay screen loads
      // the order from the server itself and keeps Pay disabled until it has
      // checked it (payable, and paid to this wallet) - it fails closed to the
      // order page otherwise, exactly as when the order is handed over.
      // Keep the amount on this page's link, so Back from Review shows it again.
      const here = new URL(window.location.href)
      here.searchParams.set('amount', String(value))
      navigate(`${here.pathname}${here.search}`, { replace: true })
      if (useAuthStore.getState().isAuthenticated && wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        // Named as on this page (the store), so the confirm sheet matches it.
        const to = `${shop.username}|${wallet}|${shopTitle(shop)}|${shop.avatarUrl ?? ''}`
        // &store: kept on the payment in history, so "Pay again" reopens this store.
        const storeQ = (shop.storeId ? `&store=${encodeURIComponent(shop.storeId)}` : '')
          + (noteOut.trim() ? `&note=${encodeURIComponent(noteOut.trim().slice(0, 140))}` : '')
          // What the payment screens show under the name instead of the username.
          + (shopSubline(shop) ? `&shopline=${encodeURIComponent(shopSubline(shop))}` : '')
        navigate(`/pay?to=${encodeURIComponent(to)}&amount=${encodeURIComponent(String(value))}&merchantPay=${encodeURIComponent(String(data))}&review=1${storeQ}`)
        return
      }
      if (useAuthStore.getState().isAuthenticated) {
        const { getPayment, orderPaySendUrl, isOrderPayable } = await import('@/lib/merchantPay')
        const v = await getPayment(String(data)).catch(() => null)
        if (v && isOrderPayable(v)) { navigate(`${orderPaySendUrl(v)}&review=1${shop.storeId ? `&store=${encodeURIComponent(shop.storeId)}` : ''}${noteOut.trim() ? `&note=${encodeURIComponent(noteOut.trim().slice(0, 140))}` : ''}${shopSubline(shop) ? `&shopline=${encodeURIComponent(shopSubline(shop))}` : ''}`, { state: { merchantView: v } }); return }
      }
      navigate(`/paylink/r/${data}`)
    } catch (e) {
      toast(errorText(e, 'Could not start the payment'), 'error')
      setBusy(false)
    }
  }

  // Off to the pay screen (above) - nothing to show meanwhile.
  if (toPayScreen) return null

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="flex items-center justify-between px-5 pb-2" style={{ paddingTop: 'calc(var(--safe-top) + 20px)' }}>
        {!isDesktop ? <button onClick={() => navigate('/')} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button> : <span />}
        <div className="flex items-center gap-2">
          <img decoding="async" src="/favicon.svg" alt="MeshPort" className="w-6 h-6 rounded-lg" />
          <span className="text-text-primary font-bold text-sm">MeshPort</span>
        </div>
        <span className="w-10" />
      </div>

      {/* Phone: a column that fills the space above the Pay button - the
          amount takes whatever room is left (centred in it), so the note and
          keys sit right above the button with no empty band under them. */}
      <div className={`flex-1 overflow-y-auto ${isDesktop ? '' : 'flex flex-col'}`}>
        {/* Who is being paid: photo, then the name with its badge. */}
        <div className="shrink-0 mx-auto w-full max-w-md flex flex-col items-center text-center px-5 pt-2">
          <Avatar src={shop.avatarUrl ?? undefined} name={shopTitle(shop)} size={short ? 'md' : 'lg'} />
          <h1 className={`${short ? 'mt-2 text-[20px]' : 'mt-4 text-[22px]'} leading-tight font-bold text-text-primary flex items-center justify-center gap-2 max-w-full`}>
            <span className="truncate">{shopTitle(shop)}</span>
            {shop.verified && <BadgeCheck className="w-6 h-6 shrink-0 text-brand-text" aria-label="Verified business" />}
          </h1>
          {/* What kind of business and which branch - like a payment app's
              merchant screen; the username isn't what a customer looks for. */}
          {shopSubline(shop) && (
            <p className="mt-1 text-[13px] text-text-muted flex items-center justify-center gap-1.5 max-w-full">
              <Store className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{shopSubline(shop)}</span>
            </p>
          )}
          {shop.contact && !short && (
            <p className="mt-0.5 text-[12px] text-text-muted flex items-center justify-center gap-1 max-w-full">
              <Phone className="w-3 h-3 shrink-0" /> <span className="truncate">{shop.contact}</span>
            </p>
          )}
          {link && (
            <div className="mt-3 w-full rounded-2xl bg-surface border border-border px-4 py-3 text-left">
              <p className="text-[15px] font-bold text-text-primary">{link.info.title}</p>
              {link.info.description && <p className="text-[13px] text-text-secondary mt-0.5">{link.info.description}</p>}
            </div>
          )}
          {shop.address && !short && !link && (
            <p className="mt-0.5 text-[12px] text-text-muted flex items-center justify-center gap-1 max-w-full">
              <MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{shop.address}</span>
            </p>
          )}
        </div>
        <div className={`mx-auto w-full max-w-md flex flex-col px-5 ${isDesktop ? '' : 'flex-1'} ${short ? 'gap-3 pt-3' : 'gap-5 pt-6'}`}>
          {/* The amount, large and centred: typed straight in on desktop; on
              a phone the keys sit right in the page under it. */}
          <div className={isDesktop ? '' : 'flex-1 flex flex-col justify-center'}>
            <ShopAmount value={amount} onType={isDesktop && fixed === null ? type : undefined} balance={signedIn ? balance : null} compact={short}
              approx={localRate && Number(amount) > 0 ? `≈ ${formatFiat(Number(amount) * localRate.rate, localRate.currency)}` : null} />
          </div>
          {link?.info.askContact && (
            <div className="shrink-0 w-full flex flex-col gap-2">
              <input value={payer.name} onChange={e => setPayer(p => ({ ...p, name: e.target.value.slice(0, 80) }))} placeholder="Your name" aria-label="Your name"
                className="w-full h-12 px-4 rounded-2xl bg-card border border-border text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40" />
              <input value={payer.contact} onChange={e => setPayer(p => ({ ...p, contact: e.target.value.slice(0, 120) }))} placeholder="Phone (with country code) or email" aria-label="Your phone or email" inputMode="email"
                className="w-full h-12 px-4 rounded-2xl bg-card border border-border text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40" />
            </div>
          )}
          {!link && <div className="shrink-0 w-full max-w-[280px] mx-auto">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)"
              maxLength={60}
              className="w-full bg-transparent text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] text-center text-text-secondary placeholder:text-text-muted border-b border-border pb-1.5 outline-none focus:border-brand-text transition-colors"
              aria-label="Payment note"
            />
          </div>}
          {!isDesktop && fixed === null && (
            <div className="shrink-0 pb-2"><AmountKeypad variant="inline" open value={amount} onChange={setAmount} token="USDC"
              decimals={SHOP_DECIMALS} maxValue={SHOP_MAX} showMax={false} /></div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-5 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
        {(limitError || limitHint) && (
          <p className={`mb-2 text-xs text-center ${limitError ? 'text-danger font-semibold' : 'text-text-muted'}`}>{limitError ?? `Payments here: ${limitHint}`}</p>
        )}
        <button type="button" disabled={!(value >= 0.01) || !!limitError || busy} onClick={go}
          className="w-full min-h-[52px] rounded-2xl bg-brand text-white font-bold text-base disabled:opacity-40 transition-opacity">
          {/* In the app the next screen is Review; a payment link's visitor pays from their own wallet. */}
          {busy ? 'Starting…' : value >= 0.01 ? (signedIn ? 'Review' : `Pay ${money(value)}`) : 'Enter amount'}
        </button>
        <p className="mt-2 text-[11px] text-center text-text-muted">Pay in USDC from Arc or any supported chain</p>
      </div>
    </div>
  )
}
