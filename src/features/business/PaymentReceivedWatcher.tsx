// "Payment received" for business accounts, on every screen: when a new
// merchant payment lands, a full-screen confirmation shows over whatever the
// merchant is doing and the voice alert speaks the amount. Mounted once in
// the app shell. Payments on other chains (merchant_chain_receipts, read by
// the merchant-pay watcher) show the same way - with or without an order.
// Plain USDC received on Arc (no order) is not a payment and stays silent.
import { useEffect, useRef, useState } from 'react'
import { useAuthStore, useUIStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { listMyPayments, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, subscribeChainReceipts, displayOrderNumber, orderTitle, type MerchantPayment } from '@/lib/merchantPay'
import { speakPayment, prefetchVoicePack, useVoiceAlerts, setVoiceAlerts, spokenLine, isSpoken } from '@/lib/voiceAlerts'
import { useNavigate } from 'react-router-dom'
import { PaymentReceivedOverlay } from './ui'
import { chainLabel } from './settlement'
import { notifyExternalBalanceChanged } from '@/blockchain/BlockchainManager'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A payment this recent is still announced when the app opens or comes back. */
const FRESH_MS = 10 * 60_000
const isFresh = (createdAt: string) => Date.now() - Date.parse(createdAt) < FRESH_MS

// Payments already announced on this phone (chain:tx), kept across app
// restarts: opening the app from a payment notification announces only the
// ones it hasn't said yet. Newest 200.
const announcedKey = (wallet: string) => `meshport_announced_${wallet.toLowerCase()}`
function readAnnounced(wallet: string): Set<string> {
  try { const a = JSON.parse(localStorage.getItem(announcedKey(wallet)) || '[]'); return new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string') : []) } catch { return new Set() }
}
function writeAnnounced(wallet: string, set: Set<string>) {
  try { localStorage.setItem(announcedKey(wallet), JSON.stringify([...set].slice(-200))) } catch { /* storage unavailable */ }
}

export function PaymentReceivedWatcher() {
  const business = useBusinessTab()
  const wallet = useAuthStore(s => s.walletAddress)
  // Cards waiting to be shown, oldest first: payments landing together each
  // get their own card, one after the other ("+N more waiting").
  const [cards, setCards] = useState<MerchantPayment[]>([])
  const shown = cards[0] ?? null
  const nextCard = () => setCards(c => c.slice(1))
  const navigate = useNavigate()
  const toast = useUIStore(s => s.showToastMessage)
  const seen = useRef<Set<string> | null>(null)
  // Payments already announced (chain:tx) - spoken from the live feed or a
  // reload, on this phone - so none is said twice (lives across restarts).
  const announced = useRef<Set<string>>(new Set())
  const voice = useVoiceAlerts()
  // The settings as of now, read inside the long-lived effect below.
  const bigCardRef = useRef(voice.bigCard); bigCardRef.current = voice.bigCard
  const keyOf = (p: MerchantPayment) => `${p.chain}:${p.txHash.toLowerCase()}`
  const showCards = (list: MerchantPayment[]) => {
    if (!bigCardRef.current || !list.length) return
    const inOrder = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    setCards(c => [...c, ...inOrder.filter(p => !c.some(x => keyOf(x) === keyOf(p)))])
  }

  // Like a soundbox's language pack: every voice clip downloaded ahead, while
  // the phone is idle, so an alert never waits on the network.
  useEffect(() => {
    if (!business || !voice.enabled) return
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (n: number) => void }
    const t = setTimeout(() => {
      if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => { void prefetchVoicePack() })
      else void prefetchVoicePack()
    }, 4000)
    return () => clearTimeout(t)
  }, [business, voice.enabled])
  const seenReceipts = useRef<Set<string> | null>(null)

  useEffect(() => {
    seen.current = null
    seenReceipts.current = null
    setCards([])
    if (!business || !wallet) return
    announced.current = readAnnounced(wallet)
    let live = true
    // Payments that arrived while the app was in the background: a hidden
    // page can't play sound, so they wait and are said when it is back.
    const waiting = new Map<string, { amount: number; createdAt: string; payment?: MerchantPayment }>()
    const visible = () => document.visibilityState === 'visible'
    const announce = (k: string, amount: number, createdAt: string, payment?: MerchantPayment) => {
      if (announced.current.has(k)) return
      if (!visible()) { waiting.set(k, { amount, createdAt, payment: payment ?? waiting.get(k)?.payment }); return }
      announced.current.add(k)
      writeAnnounced(wallet, announced.current)
      speakPayment(amount)
    }
    const sayWaiting = () => {
      if (!visible() || !waiting.size) return
      const list = [...waiting.entries()].sort((a, b) => Date.parse(a[1].createdAt) - Date.parse(b[1].createdAt))
      waiting.clear()
      for (const [k, w] of list) {
        // Back after a long time: too old to say now, still counted as told.
        if (isFresh(w.createdAt)) announce(k, w.amount, w.createdAt)
        else { announced.current.add(k); writeAnnounced(wallet, announced.current) }
      }
      showCards(list.filter(([, w]) => w.payment && isFresh(w.createdAt)).map(([, w]) => w.payment!))
    }
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
      if (!live) return
      // USDC that just landed on another chain (own transfers included):
      // re-read that chain's balance now, so Business / Hub / Home show it at
      // once instead of on their next full scan minutes later.
      if (seenReceipts.current) {
        for (const chain of new Set(receipts.filter(r => !seenReceipts.current!.has(r.id) && EXTERNAL_CHAINS[r.chain]).map(r => r.chain))) {
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
      // New since the last look - or, on the first look (app just opened, e.g.
      // from the payment's notification), recent ones this phone hasn't
      // announced yet.
      const fresh = list.filter(p => isFresh(p.createdAt) && (seen.current ? !seen.current.has(key(p)) : !announced.current.has(key(p))))
      if (fresh.length) {
        if (visible()) showCards(fresh)
        for (const p of [...fresh].reverse()) announce(key(p), p.amount, p.createdAt, p)
        // Already waiting from the live feed while hidden: its card shows on return.
        if (!visible()) for (const p of fresh) { const w = waiting.get(key(p)); if (w) w.payment = p }
      }
      seen.current = new Set(list.map(key))
    }
    void check()
    // A new payment row: speak at once from the live feed (the reload that
    // follows shows the card). Only once the first load has run - before that
    // every row counts as old - and only a payment of the last 10 minutes.
    const stopOrders = subscribeMerchantPayments(wallet, () => { void check() }, p => {
      const k = `${p.chain}:${p.txHash.toLowerCase()}`
      if (!seen.current || seen.current.has(k) || !isFresh(p.createdAt)) return
      announce(k, p.amount, p.createdAt)
    })
    const stopReceipts = subscribeChainReceipts(wallet, () => { void check() })
    const stop = () => { stopOrders(); stopReceipts() }
    // A fallback if the live feed drops - look every 20 s.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void check() }, 20_000)
    // Back in the app: look at once - the live feed was asleep with the phone,
    // and a payment that landed meanwhile would otherwise wait for the tick.
    const onVisible = () => { if (visible()) { sayWaiting(); void check() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; stop(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [business, wallet])

  // Each card closes by itself after 8 s; the next one waiting follows.
  useEffect(() => {
    if (!shown) return
    const t = setTimeout(nextCard, 8000)
    return () => clearTimeout(t)
  }, [shown])
  // Big alert card turned off: nothing more shows.
  useEffect(() => { if (!voice.bigCard) setCards([]) }, [voice.bigCard])

  // The last payment shown stays drawn while the popup animates away -
  // clearing it with the popup still on screen blanked it mid-close (flicker).
  const lastShown = useRef<MerchantPayment | null>(null)
  if (shown) lastShown.current = shown
  const p = shown ?? lastShown.current

  if (!business) return null
  // Which order it paid: "Bill #138" / "Request #138". A Shop QR payment had
  // no order the customer saw - no number.
  const order = !p?.orderNumber || p.orderKind === 'shop' ? undefined
    : p.orderKind ? orderTitle(p.orderKind, p.orderNumber, { short: true }) : displayOrderNumber(p.orderNumber)
  return (
    <PaymentReceivedOverlay open={!!shown} amount={p ? money(p.amount) : ''}
      from={p ? (p.customerUsername ? `${p.customerUsername}.arc` : (/^0x0{40}$/i.test(p.from) ? 'a bridge' : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`)) : ''}
      chainLabel={p ? chainLabel(p.chain) : ''} order={order}
      // What the voice said - shown when this payment was said out loud.
      spoken={p && isSpoken(p.amount) ? spokenLine(p.amount) : undefined}
      more={Math.max(0, cards.length - 1)} itemKey={p ? keyOf(p) : undefined}
      onRepeat={p ? () => speakPayment(p.amount, { test: true }) : undefined}
      onMute={voice.enabled ? () => { setVoiceAlerts({ enabled: false }); toast('Voice alerts off - turn them on in Business tools → Payment alerts', 'info') } : undefined}
      onView={p ? () => { setCards([]); navigate(`/business?pay=${encodeURIComponent(p.txHash)}`) } : undefined}
      onDone={nextCard} />
  )
}
