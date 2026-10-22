// Public Shop QR page (/paylink/<business>?store=<id>). The customer types
// the amount, shop_open_order creates an order for that exact store, and
// the normal order page (/paylink/r/<code>) takes the payment - so every
// Shop QR payment is recorded in the owner's Business tab with its store.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, Store } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { getShopLimits, type ShopInfo, type ShopLimits } from '@/lib/shop'
import { useAuthStore, useUIStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { AmountField } from '@/components/ui/AmountField'

// Shop payments: cents, up to $100,000 - the same caps typed and on the keys.
const SHOP_DECIMALS = 2
const SHOP_MAX = 100000

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ShopPayPage({ shop, initialAmount }: { shop: ShopInfo; initialAmount?: string | null }) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const toast = useUIStore(s => s.showToastMessage)
  const [amount, setAmount] = useState(() => initialAmount && Number(initialAmount) > 0 ? String(Number(initialAmount)) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [limits, setLimits] = useState<ShopLimits>({ min: null, max: null })
  useEffect(() => { getShopLimits(shop.username).then(setLimits).catch(() => {}) }, [shop.username])

  // Typed (desktop): same caps as the keys (AmountKeypad's decimals / maxValue).
  const type = (raw: string) => {
    const next = sanitizeAmountInput(raw, SHOP_DECIMALS)
    if (Number(next) <= SHOP_MAX) setAmount(next)
  }
  const value = Number(amount) || 0
  const limitError = !value ? null
    : limits.min != null && value < limits.min ? `The smallest payment here is ${money(limits.min)}`
    : limits.max != null && value > limits.max ? `The largest payment here is ${money(limits.max)}` : null
  const limitHint = limits.min != null && limits.max != null ? `${money(limits.min)} – ${money(limits.max)}`
    : limits.min != null ? `From ${money(limits.min)}` : limits.max != null ? `Up to ${money(limits.max)}` : null

  const go = async () => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('shop_open_order', { p_username: shop.username, p_amount: value, p_store: shop.storeId, p_note: note || null })
      if (error) throw new Error(error.message)
      // Signed in: straight to the pay screen's Review - the amount was just
      // typed here, so there is nothing to confirm on an order page. The
      // order page stays for paying from another wallet (it picks a network).
      if (useAuthStore.getState().isAuthenticated) {
        const { getPayment, orderPaySendUrl, isOrderPayable } = await import('@/lib/merchantPay')
        const v = await getPayment(String(data)).catch(() => null)
        if (v && isOrderPayable(v)) { navigate(`${orderPaySendUrl(v)}&review=1`, { state: { merchantView: v } }); return }
      }
      navigate(`/paylink/r/${data}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the payment', 'error')
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="flex items-center justify-between px-5 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 20px)' }}>
        {!isDesktop ? <button onClick={() => navigate('/')} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button> : <span />}
        <div className="flex items-center gap-2">
          <img decoding="async" src="/favicon.svg" alt="MeshPort" className="w-6 h-6 rounded-lg" />
          <span className="text-text-primary font-bold text-sm">MeshPort</span>
        </div>
        <span className="w-10" />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md flex flex-col items-center text-center px-5 pt-4">
          <Avatar src={shop.avatarUrl ?? undefined} name={shop.businessName} size="lg" />
          <h1 className="mt-3 text-lg font-bold text-text-primary flex items-center gap-1.5">
            {shop.businessName}
            {shop.verified && <BadgeCheck className="w-4 h-4 text-brand-text" aria-label="Verified business" />}
          </h1>
          <p className="text-xs text-text-muted">{shop.username}.arc</p>
          {shop.storeName && (
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-surface border border-border px-3 py-1 text-xs font-semibold text-text-secondary">
              <Store className="w-3.5 h-3.5" /> {shop.storeName}
            </span>
          )}
        </div>
        {/* The app's amount field: typed straight in on desktop; on a phone
            the keys sit right in the page under it. */}
        <div className="mx-auto w-full max-w-md flex flex-col gap-5 px-5 pt-6">
          <AmountField value={amount} onChange={type} ariaLabel="Amount in USDC"
            token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }}
            onTap={isDesktop ? undefined : () => {}} editing={!isDesktop} />
          <div className="w-full max-w-[280px] mx-auto">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)"
              maxLength={60}
              className="w-full bg-transparent text-sm text-center text-text-secondary placeholder:text-text-muted border-b border-border pb-1.5 outline-none focus:border-brand-text transition-colors"
              aria-label="Payment note"
            />
          </div>
          {!isDesktop && (
            <AmountKeypad variant="inline" open value={amount} onChange={setAmount} token="USDC"
              decimals={SHOP_DECIMALS} maxValue={SHOP_MAX} showMax={false} />
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-5 pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
        {(limitError || limitHint) && (
          <p className={`mb-2 text-xs text-center ${limitError ? 'text-danger font-semibold' : 'text-text-muted'}`}>{limitError ?? `Payments here: ${limitHint}`}</p>
        )}
        <button type="button" disabled={!(value >= 0.01) || !!limitError || busy} onClick={go}
          className="w-full min-h-[52px] rounded-2xl bg-brand text-white font-bold text-base disabled:opacity-40 transition-opacity">
          {busy ? 'Starting…' : value >= 0.01 ? `Pay ${money(value)}` : 'Enter amount'}
        </button>
        <p className="mt-2 text-[11px] text-center text-text-muted">Pay in USDC from Arc or any supported chain</p>
      </div>
    </div>
  )
}
