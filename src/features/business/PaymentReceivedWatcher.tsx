// "Payment received" for business accounts, on every screen: when a new
// merchant payment lands, a full-screen confirmation shows over whatever the
// merchant is doing and the voice alert speaks the amount. Mounted once in
// the app shell. Payments on other chains (merchant_chain_receipts, read by
// the merchant-pay watcher) show the same way.
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { listMyPayments, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, type MerchantPayment } from '@/lib/merchantPay'
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
    // One check at a time: a live update landing while the first load is
    // still out would otherwise count its payment as already seen (silent).
    let running: Promise<void> = Promise.resolve()
    const check = () => { running = running.then(load, load); return running }
    const load = async () => {
      const [paid, receipts] = await Promise.all([listMyPayments(50).catch(() => null), listChainReceipts(30).catch(() => [])])
      if (!live || !paid) return
      // Order payments are already in `paid`; own transfers aren't payments.
      const list: MerchantPayment[] = [...paid, ...receipts.filter(r => !r.orderNumber && !isOwnReceipt(r, wallet)).map(r => ({
        id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '', amount: r.amount,
        status: 'confirmed', customerUsername: null, orderNumber: null, createdAt: r.createdAt,
      }) as unknown as MerchantPayment)]
      if (seen.current) {
        const fresh = list.filter(p => !seen.current!.has(p.id) && Date.now() - Date.parse(p.createdAt) < 10 * 60_000)
        if (fresh.length) { setShown(fresh[0]); fresh.forEach(p => speakPayment(p.amount)) }
      }
      seen.current = new Set(list.map(p => p.id))
    }
    void check()
    const stop = subscribeMerchantPayments(wallet, () => { void check() })
    // Other-chain receipts have no live feed - look every 20 s.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void check() }, 20_000)
    return () => { live = false; stop(); clearInterval(t) }
  }, [business, wallet])

  useEffect(() => {
    if (!shown) return
    const t = setTimeout(() => setShown(null), 8000)
    return () => clearTimeout(t)
  }, [shown])

  if (!business) return null
  return (
    <PaymentReceivedOverlay open={!!shown} amount={shown ? money(shown.amount) : ''}
      from={shown ? (shown.customerUsername ? `${shown.customerUsername}.arc` : (/^0x0{40}$/i.test(shown.from) ? 'a bridge' : `${shown.from.slice(0, 6)}…${shown.from.slice(-4)}`)) : ''}
      chainLabel={shown ? chainLabel(shown.chain) : ''} order={shown?.orderNumber ?? undefined} onDone={() => setShown(null)} />
  )
}
