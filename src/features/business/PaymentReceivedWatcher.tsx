// "Payment received" for business accounts, on every screen: when a new
// merchant payment lands, a full-screen confirmation shows over whatever the
// merchant is doing and the voice alert speaks the amount. Mounted once in
// the app shell. Payments on other chains (merchant_chain_receipts, read by
// the merchant-pay watcher) show the same way - with or without an order.
// Plain USDC received on Arc (no order) is not a payment and stays silent.
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { listMyPayments, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, subscribeChainReceipts, displayOrderNumber, nudgeChainWatch, type MerchantPayment } from '@/lib/merchantPay'
import { speakPayment } from '@/lib/voiceAlerts'
import { PaymentReceivedOverlay } from './ui'
import { chainLabel } from './settlement'
import { notifyExternalBalanceChanged, EXTERNAL_BALANCE_EVENT } from '@/blockchain/BlockchainManager'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PaymentReceivedWatcher() {
  const business = useBusinessTab()
  const wallet = useAuthStore(s => s.walletAddress)
  const [shown, setShown] = useState<MerchantPayment | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const seenReceipts = useRef<Set<string> | null>(null)

  useEffect(() => {
    seen.current = null
    seenReceipts.current = null
    if (!business || !wallet) return
    let live = true
    // One check at a time: a live update landing while the first load is
    // still out would otherwise count its payment as already seen (silent).
    let running: Promise<void> = Promise.resolve()
    const check = () => { running = running.then(load, load); return running }
    // Sound-box speed: the balance on another chain goes up (live chain
    // events, or the business balance poll) → merchant-pay reads that chain
    // right away instead of on its next 15s tick, and the verified receipt -
    // pop-up, voice, push - follows within seconds. Looked at again shortly
    // after (Ethereum credits one block on top; a run already going is
    // waited for) until the receipt shows.
    const lastBal = new Map<string, number>()
    const lastNudge = new Map<string, number>()
    const receiptedAt = new Map<string, number>()
    const followUps = new Map<string, Array<ReturnType<typeof setTimeout>>>()
    const nudge = (chain: string) => {
      if (Date.now() - (lastNudge.get(chain) ?? 0) < 4_000) return
      lastNudge.set(chain, Date.now())
      void nudgeChainWatch(chain).then(() => { if (live) void check() })
    }
    const onBalance = (e: Event) => {
      const { chainId, balance } = (e as CustomEvent<{ chainId?: string; balance?: number }>).detail ?? {}
      if (!chainId || !EXTERNAL_CHAINS[chainId] || typeof balance !== 'number') return
      const prev = lastBal.get(chainId)
      lastBal.set(chainId, balance)
      if (prev !== undefined && balance <= prev + 1e-9) return
      // The receipt that just landed announced this balance itself.
      if (Date.now() - (receiptedAt.get(chainId) ?? 0) < 20_000) return
      nudge(chainId)
      for (const t of followUps.get(chainId) ?? []) clearTimeout(t)
      followUps.set(chainId, [6_000, 16_000].map(ms => setTimeout(() => { lastNudge.delete(chainId); nudge(chainId) }, ms)))
    }
    window.addEventListener(EXTERNAL_BALANCE_EVENT, onBalance)
    const load = async () => {
      // Order payments (requests, bills, Shop QR, on any chain) plus every
      // receipt on ANOTHER chain, order or not. USDC sent straight to the
      // wallet on Arc without an order isn't a sale. Your own transfers
      // between chains don't count either.
      const [orders, receipts] = await Promise.all([listMyPayments(50).catch(() => null), listChainReceipts(50).catch(() => [])])
      if (!live) return
      // USDC that just landed on another chain (own transfers included):
      // re-read that chain's balance now, so Business / Hub / Home show it at
      // once instead of on their next full scan minutes later.
      if (seenReceipts.current) {
        for (const chain of new Set(receipts.filter(r => !seenReceipts.current!.has(r.id) && EXTERNAL_CHAINS[r.chain]).map(r => r.chain))) {
          receiptedAt.set(chain, Date.now())
          for (const t of followUps.get(chain) ?? []) clearTimeout(t)
          followUps.delete(chain)
          notifyExternalBalanceChanged(chain, wallet)
        }
      }
      seenReceipts.current = new Set(receipts.map(r => r.id))
      if (!orders) return
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
    // Back in the app: look at once - the live feed was asleep with the phone,
    // and a payment that landed meanwhile would otherwise wait for the tick.
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false; stop(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(EXTERNAL_BALANCE_EVENT, onBalance)
      for (const list of followUps.values()) list.forEach(clearTimeout)
    }
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
