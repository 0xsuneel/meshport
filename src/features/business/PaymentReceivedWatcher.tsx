// "Payment received" for business accounts, on every screen: when a new
// merchant payment lands, a full-screen confirmation shows over whatever the
// merchant is doing and the voice alert speaks the amount. Mounted once in
// the app shell. Payments on other chains (merchant_chain_receipts, read by
// the merchant-pay watcher) show the same way - with or without an order.
// Plain USDC received on Arc (no order) is not a payment and stays silent.
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { listMyPayments, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, subscribeChainReceipts, displayOrderNumber, type MerchantPayment } from '@/lib/merchantPay'
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
      // Order payments (requests, bills, Shop QR, on any chain) plus every
      // receipt on ANOTHER chain, order or not. USDC sent straight to the
      // wallet on Arc without an order isn't a sale. Your own transfers
      // between chains don't count either.
      const [orders, receipts] = await Promise.all([listMyPayments(50).catch(() => null), listChainReceipts(50).catch(() => [])])
      if (!live || !orders) return
      const known = new Set(orders.map(p => `${p.chain}:${p.txHash.toLowerCase()}`))
      const extra: MerchantPayment[] = receipts
        .filter(r => !known.has(`${r.chain}:${r.txHash.toLowerCase()}`) && !isOwnReceipt(r, wallet))
        .map(r => ({ id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '0x0000000000000000000000000000000000000000',
          amount: r.amount, method: r.orderNumber ? 'chain_receipt' : 'direct', status: r.status === 'converted' ? 'collected' : 'in_ledger',
          customerUsername: null, createdAt: r.createdAt, orderNumber: r.orderNumber, matchedBy: null, screenFlag: r.screenFlag ?? null }))
      const list = [...orders, ...extra]
      // Keyed by chain + tx (not id): a direct deposit later matched to an
      // order changes id but is still the same payment - no second pop-up.
      const key = (p: MerchantPayment) => `${p.chain}:${p.txHash.toLowerCase()}`
      if (seen.current) {
        const fresh = list.filter(p => !seen.current!.has(key(p)) && Date.now() - Date.parse(p.createdAt) < 10 * 60_000)
        if (fresh.length) { setShown(fresh[0]); fresh.forEach(p => speakPayment(p.amount)) }
      }
      seen.current = new Set(list.map(key))
    }
    void check()
    const stopOrders = subscribeMerchantPayments(wallet, () => { void check() })
    const stopReceipts = subscribeChainReceipts(wallet, () => { void check() })
    const stop = () => { stopOrders(); stopReceipts() }
    // A fallback if the live feed drops - look every 20 s.
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
      chainLabel={shown ? chainLabel(shown.chain) : ''} order={shown?.orderNumber ? displayOrderNumber(shown.orderNumber) : undefined} onDone={() => setShown(null)} />
  )
}
