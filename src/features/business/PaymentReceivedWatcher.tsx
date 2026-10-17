// "Payment received" for business accounts, on every screen: when a new
// merchant payment lands, a full-screen confirmation shows over whatever the
// merchant is doing and the voice alert speaks the amount. Mounted once in
// the app shell.
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { listMyPayments, subscribeMerchantPayments, type MerchantPayment } from '@/lib/merchantPay'
import { speakPayment } from '@/lib/voiceAlerts'
import { PaymentReceivedOverlay } from './ui'
import { chainLabel } from './settlement'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PaymentReceivedWatcher() {
  const business = useBusinessTab()
  const wallet = useAuthStore(s => s.walletAddress)
  const [shown, setShown] = useState<MerchantPayment | null>(null)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    seen.current = null
    if (!business || !wallet) return
    let live = true
    const check = async () => {
      const list = await listMyPayments(50).catch(() => null)
      if (!live || !list) return
      if (seen.current) {
        const fresh = list.filter(p => !seen.current!.has(p.id) && Date.now() - Date.parse(p.createdAt) < 10 * 60_000)
        if (fresh.length) { setShown(fresh[0]); fresh.forEach(p => speakPayment(p.amount)) }
      }
      seen.current = new Set(list.map(p => p.id))
    }
    void check()
    const stop = subscribeMerchantPayments(wallet, () => { void check() })
    return () => { live = false; stop() }
  }, [business, wallet])

  useEffect(() => {
    if (!shown) return
    const t = setTimeout(() => setShown(null), 8000)
    return () => clearTimeout(t)
  }, [shown])

  if (!business) return null
  return (
    <PaymentReceivedOverlay open={!!shown} amount={shown ? money(shown.amount) : ''}
      from={shown ? (shown.customerUsername ? `${shown.customerUsername}.arc` : `${shown.from.slice(0, 6)}…${shown.from.slice(-4)}`) : ''}
      chainLabel={shown ? chainLabel(shown.chain) : ''} order={shown?.orderNumber ?? undefined} onDone={() => setShown(null)} />
  )
}
