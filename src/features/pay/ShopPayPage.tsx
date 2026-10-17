// Public Shop QR page (/paylink/<business>?store=<id>). The customer types
// the amount, shop_open_order creates an order for that exact store, and
// the normal order page (/paylink/r/<code>) takes the payment - so every
// Shop QR payment is recorded in the owner's Business tab with its store.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, Store } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { ShopInfo } from '@/lib/shop'
import { useUIStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { AmountKeypad, type KeypadKey } from '@/features/business/ui'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ShopPayPage({ shop, initialAmount }: { shop: ShopInfo; initialAmount?: string | null }) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const toast = useUIStore(s => s.showToastMessage)
  const [amount, setAmount] = useState(() => initialAmount && Number(initialAmount) > 0 ? String(Number(initialAmount)) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const press = (k: KeypadKey) => setAmount(a => {
    if (k === 'del') return a.slice(0, -1)
    if (k === '.') return a.includes('.') ? a : (a || '0') + '.'
    const next = a === '0' ? k : a + k
    return /\.\d{3,}$/.test(next) || Number(next) > 100000 ? a : next
  })
  const value = Number(amount) || 0

  const go = async () => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('shop_open_order', { p_username: shop.username, p_amount: value, p_store: shop.storeId, p_note: note || null })
      if (error) throw new Error(error.message)
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
          <img src="/favicon.svg" alt="MeshPort" className="w-6 h-6 rounded-lg" />
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
        <div className="mx-auto w-full max-w-md">
          <AmountKeypad value={amount} onKey={press} note={note} onNote={setNote} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-5 pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
        <button type="button" disabled={!(value >= 0.01) || busy} onClick={go}
          className="w-full min-h-[52px] rounded-2xl bg-brand text-white font-bold text-base disabled:opacity-40 transition-opacity">
          {busy ? 'Starting…' : value >= 0.01 ? `Pay ${money(value)}` : 'Enter amount'}
        </button>
        <p className="mt-2 text-[11px] text-center text-text-muted">Pay in USDC from Arc or any supported chain</p>
      </div>
    </div>
  )
}
