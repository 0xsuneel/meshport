// src/lib/merchantPay.ts
//
// Merchant payment requests (client side).
//   Merchant: create a request (amount, optional customer, note, expiry) →
//             link /pay/r/<code> + QR; follow its status live; Ledger data.
//   Customer: open the link and pay —
//     • MeshPort user with Arc USDC  → the normal Pay/Send flow on Arc
//     • external wallet on Arc       → a USDC transfer on Arc, signed in the wallet
//     • external wallet on a UB chain→ a USDC transfer to the merchant's
//       address on that chain; the merchant's auto-collect brings it to Arc
//       through Unified Balance.
// Payments are only ever confirmed by the merchant-pay Edge Function, which
// reads the transaction from the chain. Nothing here marks anything paid.

import { encodeFunctionData, parseUnits, createPublicClient, http, erc20Abi, type Hex } from 'viem'
import { supabase } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'

/** confirmed = paid on the customer's chain · in_ledger = in the merchant's Unified Balance · collected = on Arc */
export type PaymentStage = 'confirmed' | 'in_ledger' | 'collected'

/** Where a merchant payment is right now, in merchant words. */
export function paymentStageLabel(p: { method: string; status: PaymentStage }): string {
  if (p.method !== 'external_ub') return 'Received'
  return p.status === 'confirmed' ? 'Received · waiting to convert' : p.status === 'in_ledger' ? 'In Ledger · moving to Arc' : 'In Arc balance'
}
/** Still on its way to the Arc balance. */
export const isArriving = (p: { method: string; status: PaymentStage }) => p.method === 'external_ub' && p.status !== 'collected'

export type PayChain = { id: string; label: string; chainId: number; usdc: string; route: 'direct' | 'ub' }

/** One line on a bill. The server recomputes totals from qty × price. */
export type InvoiceItem = { name: string; qty: number; price: number; total?: number }

export type PaymentView = {
  code: string
  /** Unique order number (ORD-100001…), assigned by the database. */
  orderNumber: string | null
  merchantName: string | null
  merchantWallet: string
  merchantUsername: string | null
  merchantAvatar: string | null
  amount: number
  received: number
  currency: string
  note: string | null
  customerUsername: string | null
  kind?: 'request' | 'invoice'
  items?: InvoiceItem[] | null
  status: 'pending' | 'payment_detected' | 'processing' | 'paid' | 'partially_paid' | 'expired' | 'failed' | 'cancelled'
  createdAt: string
  expiresAt: string | null
  paidAt: string | null
  /** The merchant marked the order completed themselves (settled another way). */
  completedByMerchant?: boolean
  completedNote?: string | null
  chains: PayChain[]
  payments: Array<{ chain: string; amount: number; status: PaymentStage; txHash: string; method: string; createdAt: string }>
  pending?: boolean
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('merchant-pay', { body })
  if (error) throw new Error(await describeFunctionsError(error, 'Payment service unavailable'))
  if (data?.error) throw new Error(data.error)
  return data as T
}

/** Open order for this wallet with exactly this amount due (wallet QR scanned in MeshPort). */
export const findOpenOrder = (wallet: string, amount: number) =>
  call<{ order: { code: string; orderNumber: string | null } | null }>({ action: 'find', wallet, amount }).then(r => r.order, () => null)

export const getPayment = (code: string) => call<PaymentView>({ action: 'get', code })
export const cancelPayment = (code: string) => call<PaymentView>({ action: 'cancel', code })

/**
 * Hands a payment transaction to the server for on-chain verification.
 * Retries while the transaction isn't mined yet.
 */
export async function submitPayment(code: string, chain: string, txHash: string, opts: { merchantVerify?: boolean; orderNumber?: string; amount?: number } = {}): Promise<PaymentView> {
  let last: PaymentView | null = null
  for (let attempt = 0; attempt < 20; attempt++) {
    // The customer's payment is confirmed against the order: the server
    // checks this order number and amount before counting the transaction.
    last = await call<PaymentView>({
      action: opts.merchantVerify ? 'verify' : 'submit', code, chain, txHash,
      ...(opts.orderNumber ? { orderNumber: opts.orderNumber } : {}),
      ...(opts.amount != null ? { amount: opts.amount } : {}),
    })
    if (!last.pending) return last
    await new Promise(r => setTimeout(r, 3000))
  }
  return last!
}

export function paymentLink(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://meshport.xyz'
  return `${origin}/pay/r/${code}`
}

/** Amount still due on an order (6 dp). */
export const orderDue = (v: { amount: number; received: number }) => Math.max(0, Math.round((v.amount - v.received) * 1e6) / 1e6)
/** The order can still be paid. */
export const isOrderPayable = (v: { status: string; amount: number; received: number }) =>
  ['pending', 'partially_paid'].includes(v.status) && orderDue(v) > 0

/**
 * MeshPort's pay screen for an order: recipient, amount (what's due) and the
 * order number are fixed — the payer can't change them.
 */
export function orderPaySendUrl(v: PaymentView): string {
  const name = v.merchantUsername ?? v.merchantWallet
  const to = `${name}|${v.merchantWallet}|${v.merchantName ?? name}|${v.merchantAvatar ?? ''}`
  return `/pay-send?to=${encodeURIComponent(to)}&amount=${encodeURIComponent(String(orderDue(v)))}&merchantPay=${encodeURIComponent(v.code)}`
    + (v.orderNumber ? `&order=${encodeURIComponent(v.orderNumber)}` : '')
}

/** Merchant QR: the order link plus the network the customer's wallet pays on. */
export function orderChainPayLink(code: string, orderNumber: string | null | undefined, chain: string): string {
  const link = orderPayLink(code, orderNumber)
  return `${link}${link.includes('?') ? '&' : '?'}chain=${encodeURIComponent(chain)}`
}

/** Pay link for an order that also carries its order number (QR / share / copy). */
export function orderPayLink(code: string, orderNumber?: string | null): string {
  return paymentLink(code) + (orderNumber ? `?order=${encodeURIComponent(orderNumber)}` : '')
}

// Set when this device creates a payment request, so the generic "Received
// from" notification defers to the order's own notification (see
// lib/notifications.ts) for non-merchants too.
const PAYREQ_KEY = 'meshport-payreq-at'
export function markPaymentRequestCreated() {
  try { localStorage.setItem(PAYREQ_KEY, String(Date.now())) } catch { /* ignore */ }
}
export function hasRecentPaymentRequest(days = 8): boolean {
  try { return Date.now() - Number(localStorage.getItem(PAYREQ_KEY) || 0) < days * 864e5 } catch { return false }
}

/** Short, human bill / request number (first 6 of the code) — only a
 *  fallback for requests created before order numbers existed. */
export function billNumber(code: string): string {
  return code.slice(0, 6).toUpperCase()
}

/** The order number to show for a request / bill. */
export function orderLabel(v: { code: string; orderNumber?: string | null }): string {
  return v.orderNumber || billNumber(v.code)
}

/** Chat message text for a payment request (not a bill) sent to a customer. */
export function paymentRequestMessage(i: { code: string; orderNumber?: string | null; amount: number; note?: string | null }, amountText: string): string {
  return `💸 Payment request · Order #${orderLabel(i)} · $${amountText} USDC${i.note ? `\n${i.note}` : ''}\n${paymentLink(i.code)}`
}

/** Chat → pay a bill in-chat (ChatPage listens and opens its pay sheet). */
export const BILL_PAY_EVENT = 'meshport:bill-pay'
/** Fired after a bill payment is submitted so chat cards refresh at once. */
export const BILL_UPDATED_EVENT = 'meshport:bill-updated'

/** Pulls the request code out of a MeshPort payment link (for chat cards). */
export function codeFromLink(text: string): string | null {
  const m = /\/pay\/r\/([a-z0-9]{6,32})/i.exec(text)
  return m ? m[1].toLowerCase() : null
}

export const STATUS_LABEL: Record<PaymentView['status'], string> = {
  pending: 'Waiting for payment',
  payment_detected: 'Payment detected',
  processing: 'Payment arriving',
  paid: 'Paid',
  partially_paid: 'Partially paid',
  expired: 'Expired',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// ── Merchant side ──────────────────────────────────────────────────────────
export type MerchantIntent = {
  id: string; code: string; orderNumber: string | null; amount: number; received: number; note: string | null
  customerUsername: string | null; customerWallet: string | null; status: PaymentView['status']
  sourceChain: string | null; paymentMethod: string | null; createdAt: string; expiresAt: string | null; paidAt: string | null
  kind: 'request' | 'invoice'; items: InvoiceItem[] | null
  completedByMerchant: boolean; completedNote: string | null
}
export type MerchantPayment = {
  id: string; intentId: string; chain: string; txHash: string; from: string; amount: number
  method: string; status: PaymentStage; customerUsername: string | null; createdAt: string; orderNumber: string | null
  /** How it was linked to its order: customer (pay link / chat), merchant (checked a tx), watcher (direct deposit auto-matched). */
  matchedBy: 'customer' | 'merchant' | 'watcher' | null
}

/** A direct deposit that matched more than one open order — the merchant picks. */
export type UnmatchedDeposit = {
  id: string; chain: string; txHash: string; from: string; amount: number; candidateCodes: string[]; createdAt: string
  /** multiple_orders: exact amount, several orders; amount_mismatch: close but not exact. */
  reason: 'multiple_orders' | 'amount_mismatch'
}

export async function listUnmatchedDeposits(): Promise<UnmatchedDeposit[]> {
  const { data } = await supabase.from('merchant_unmatched_deposits').select('*').eq('status', 'needs_review').order('created_at', { ascending: false }).limit(50)
  return (data ?? []).map((r: any) => ({
    id: r.id, chain: r.source_chain, txHash: r.tx_hash, from: r.from_address, amount: Number(r.amount),
    candidateCodes: Array.isArray(r.candidate_codes) ? r.candidate_codes : [], createdAt: r.created_at,
    reason: r.reason === 'amount_mismatch' ? 'amount_mismatch' : 'multiple_orders',
  }))
}
export const assignDeposit = (depositId: string, code: string) => call<PaymentView>({ action: 'assign', depositId, code })
/** Merchant marks an order completed (paid in cash, settled elsewhere…). */
export const completeOrder = (code: string, note?: string) => call<PaymentView>({ action: 'complete', code, ...(note ? { note } : {}) })
export const dismissDeposit = (depositId: string) => call<{ ok: boolean }>({ action: 'dismiss', depositId })

function mapIntent(r: any): MerchantIntent {
  const expired = r.status === 'pending' && r.expires_at && new Date(r.expires_at).getTime() < Date.now()
  return {
    id: r.id, code: r.code, orderNumber: r.order_number ?? null, amount: Number(r.requested_amount), received: Number(r.received_amount), note: r.note,
    customerUsername: r.customer_username, customerWallet: r.customer_wallet, status: expired ? 'expired' : r.status,
    sourceChain: r.source_chain, paymentMethod: r.payment_method, createdAt: r.created_at, expiresAt: r.expires_at, paidAt: r.paid_at,
    kind: r.kind === 'invoice' ? 'invoice' : 'request',
    completedByMerchant: !!r.completed_by_merchant, completedNote: r.completed_note ?? null,
    items: Array.isArray(r.items) ? r.items.map((i: any) => ({ name: i.name, qty: Number(i.qty), price: Number(i.price), total: Number(i.total) })) : null,
  }
}

/** Bill total = Σ qty × price (rounded like the server). */
export function invoiceTotal(items: InvoiceItem[]): number {
  return Number(items.reduce((s, i) => s + Math.round((i.qty || 0) * (i.price || 0) * 1e6) / 1e6, 0).toFixed(6))
}

export async function createPaymentRequest(p: { amount: number; customer?: string; note?: string; expiresInMinutes?: number | null; items?: InvoiceItem[] }): Promise<MerchantIntent> {
  const items = p.items?.filter(i => i.name.trim() && i.qty > 0 && i.price >= 0).map(i => ({ name: i.name.trim().slice(0, 80), qty: i.qty, price: i.price }))
  const amount = items?.length ? invoiceTotal(items) : p.amount
  if (!(amount > 0)) throw new Error(items ? 'Add at least one item with a price' : 'Enter an amount')
  const { data, error } = await supabase.from('merchant_payment_intents').insert({
    requested_amount: Number(amount.toFixed(6)),
    ...(items?.length ? { items } : {}),
    customer_username: p.customer?.trim().replace(/^@/, '') || null,
    note: p.note?.trim().slice(0, 140) || null,
    expires_at: p.expiresInMinutes ? new Date(Date.now() + p.expiresInMinutes * 60_000).toISOString() : null,
  }).select('*').single()
  if (error) throw new Error(/approved merchants/i.test(error.message) ? 'Only approved merchants can send bills.' : error.message)
  markPaymentRequestCreated()
  return mapIntent(data)
}

export async function listMyIntents(limit = 200): Promise<MerchantIntent[]> {
  const { data } = await supabase.from('merchant_payment_intents').select('*').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []).map(mapIntent)
}

export async function listMyPayments(limit = 500): Promise<MerchantPayment[]> {
  const { data } = await supabase.from('merchant_payments').select('*').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []).map((r: any) => ({
    id: r.id, intentId: r.intent_id, chain: r.source_chain, txHash: r.tx_hash, from: r.from_address, amount: Number(r.amount),
    method: r.method, status: r.status, customerUsername: r.customer_username, createdAt: r.created_at,
    orderNumber: r.order_number ?? null, matchedBy: r.matched_by ?? null,
  }))
}

/** An open bill / payment request between me and the other person in a chat. */
export type ChatPendingOrder = {
  code: string; orderNumber: string | null; kind: 'invoice' | 'request'; amount: number; received: number
  note: string | null; merchantName: string | null; iAmMerchant: boolean; createdAt: string; expiresAt: string | null
}

/** Open orders between me and `otherUserId` — whichever of us is the merchant. */
export async function listChatPendingOrders(otherUserId: string): Promise<ChatPendingOrder[]> {
  const { data, error } = await supabase.rpc('chat_pending_orders', { p_other: otherUserId })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    code: r.code, orderNumber: r.order_number ?? null, kind: r.kind === 'invoice' ? 'invoice' : 'request',
    amount: Number(r.amount), received: Number(r.received), note: r.note ?? null, merchantName: r.merchant_name ?? null,
    iAmMerchant: !!r.i_am_merchant, createdAt: r.created_at, expiresAt: r.expires_at ?? null,
  }))
}

// Which users are approved merchants (chat list "Merchant" tag). Cached for
// the session; a user's merchant status rarely changes.
const merchantFlagCache = new Map<string, boolean>()
export async function fetchMerchantFlags(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))]
  const missing = ids.filter(id => !merchantFlagCache.has(id))
  if (missing.length) {
    const { data, error } = await supabase.rpc('merchant_user_flags', { p_user_ids: missing })
    if (!error) {
      const yes = new Set((data ?? []).map((r: any) => String(r.user_id)))
      for (const id of missing) merchantFlagCache.set(id, yes.has(id))
    }
  }
  return new Set(ids.filter(id => merchantFlagCache.get(id)))
}

/** Live updates for this merchant's requests and payments. */
export function subscribeMerchantPayments(merchantWallet: string, onChange: () => void): () => void {
  const w = merchantWallet.toLowerCase()
  // Unique name per subscriber: the app shell and the Ledger both subscribe,
  // and a shared name returns the already-joined channel, where adding
  // listeners throws ("cannot add postgres_changes callbacks after subscribe")
  // and crashed the Ledger. Removing one must not remove the other either.
  const ch = supabase.channel(`merchant-pay-${w}-${Math.random().toString(36).slice(2, 10)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_payment_intents', filter: `merchant_wallet=eq.${w}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_payments', filter: `merchant_wallet=eq.${w}` }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(ch) }
}

/** Live updates for one request (pay page / chat card). Polls — customers may not be signed in. */
export function watchPayment(code: string, onUpdate: (v: PaymentView) => void, everyMs = 5000): () => void {
  let stop = false
  let iv: ReturnType<typeof setInterval> | null = null
  const tick = async () => {
    try {
      const v = await getPayment(code)
      if (stop) return
      onUpdate(v)
      // Final states don't change any more — stop asking.
      if (['paid', 'expired', 'cancelled', 'failed'].includes(v.status) && iv) { clearInterval(iv); iv = null }
    } catch { /* keep last */ }
  }
  void tick()
  iv = setInterval(tick, everyMs)
  return () => { stop = true; if (iv) clearInterval(iv) }
}

// ── Customer: external browser wallets (EIP-6963 + window.ethereum) ────────
export type BrowserWallet = { id: string; name: string; icon?: string; provider: any }

/** Wallet extensions that announced themselves (MetaMask, OKX, Rabby, Bitget, …). */
export function discoverWallets(timeoutMs = 400): Promise<BrowserWallet[]> {
  return new Promise(resolve => {
    if (typeof window === 'undefined') return resolve([])
    const found = new Map<string, BrowserWallet>()
    const onAnnounce = (e: any) => {
      const d = e?.detail
      if (!d?.provider || !d?.info) return
      found.set(d.info.uuid ?? d.info.rdns ?? d.info.name, { id: d.info.rdns ?? d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider })
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce as any)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as any)
      const list = [...found.values()]
      const legacy = (window as any).ethereum
      if (list.length === 0 && legacy) list.push({ id: 'injected', name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: legacy })
      resolve(list)
    }, timeoutMs)
  })
}

const ARC_ADD_CHAIN = {
  chainId: `0x${(5042002).toString(16)}`,
  chainName: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: ['https://rpc.testnet.arc.network'],
  blockExplorerUrls: ['https://testnet.arcscan.app'],
}

export async function connectWallet(w: BrowserWallet): Promise<string> {
  const accounts: string[] = await w.provider.request({ method: 'eth_requestAccounts' })
  if (!accounts?.[0]) throw new Error('No account connected')
  return accounts[0].toLowerCase()
}

// Networks a wallet may not have yet — added (the wallet asks the user) when
// switching fails. Public RPCs; explorers only where certain.
const ADD_CHAIN: Record<string, { chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls?: string[] }> = {
  Arc_Testnet: ARC_ADD_CHAIN,
  Ethereum_Sepolia: { chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] },
  Base_Sepolia: { chainName: 'Base Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
  Arbitrum_Sepolia: { chainName: 'Arbitrum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'], blockExplorerUrls: ['https://sepolia.arbiscan.io'] },
  Optimism_Sepolia: { chainName: 'OP Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.optimism.io'], blockExplorerUrls: ['https://sepolia-optimism.etherscan.io'] },
  Polygon_Sepolia: { chainName: 'Polygon Amoy', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://rpc-amoy.polygon.technology'], blockExplorerUrls: ['https://amoy.polygonscan.com'] },
  Avalanche_Fuji: { chainName: 'Avalanche Fuji', nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'], blockExplorerUrls: ['https://testnet.snowtrace.io'] },
  HyperEVM_Testnet: { chainName: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: ['https://rpc.hyperliquid-testnet.xyz/evm'] },
  Sei_Testnet: { chainName: 'Sei Testnet', nativeCurrency: { name: 'SEI', symbol: 'SEI', decimals: 18 }, rpcUrls: ['https://evm-rpc-testnet.sei-apis.com'] },
  Unichain_Sepolia: { chainName: 'Unichain Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.unichain.org'], blockExplorerUrls: ['https://sepolia.uniscan.xyz'] },
}
/** Coin the wallet pays gas with on `chainId` (for the hint under the Pay button). */
export const gasCoin = (chainId: string) => ADD_CHAIN[chainId]?.nativeCurrency.symbol === 'USDC' ? 'USDC' : ADD_CHAIN[chainId]?.nativeCurrency.symbol ?? 'the network coin'
/** Explorer transaction link, where known. */
export const txExplorerUrl = (chainId: string, hash: string) => {
  const base = ADD_CHAIN[chainId]?.blockExplorerUrls?.[0]
  return base ? `${base.replace(/\/$/, '')}/tx/${hash}` : null
}

export async function ensureChain(w: BrowserWallet, chain: PayChain) {
  const want = `0x${chain.chainId.toString(16)}`
  const onChain = async () => parseInt(String(await w.provider.request({ method: 'eth_chainId' })), 16) === chain.chainId
  if (await onChain()) return
  try {
    await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] })
  } catch (e: any) {
    if (e?.code === 4001) throw new Error(`Switch your wallet to ${chain.label} to pay.`)
    // Unknown network: wallets report it differently (4902, -32603, a
    // message…) — add it (the wallet asks the user) and switch.
    const add = ADD_CHAIN[chain.id]
    if (!add) throw new Error(`Switch your wallet to ${chain.label} to pay.`)
    await w.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, ...add }] })
    if (!(await onChain())) await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }).catch(() => {})
  }
  if (!(await onChain())) throw new Error(`Switch your wallet to ${chain.label} to pay.`)
}

/** Arc Testnet as a pay chain (USDC is the native coin). */
export const ARC_PAY_CHAIN: PayChain = { id: 'Arc_Testnet', label: 'Arc', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', route: 'direct' }

/**
 * Pay on Arc from the wallet this page is open in (MetaMask / OKX / Trust /
 * Coinbase in-app browser, or a desktop extension): adds Arc Testnet to the
 * wallet if needed, then a plain native USDC send — the wallet shows
 * "Send <amount> USDC to <address>".
 */
export async function payArcFromBrowserWallet(w: BrowserWallet, to: string, amount: number): Promise<string> {
  const from = await connectWallet(w)
  await ensureChain(w, ARC_PAY_CHAIN)
  const value = parseUnits(amount.toFixed(6), 18)
  return await w.provider.request({ method: 'eth_sendTransaction', params: [{ from, to, value: `0x${value.toString(16)}` }] })
}

/** Deep links that open a page inside a wallet app's browser. */
export function walletAppLinks(url: string): Array<{ id: string; name: string; href: string }> {
  const bare = url.replace(/^https?:\/\//, '')
  const enc = encodeURIComponent(url)
  return [
    { id: 'metamask', name: 'MetaMask', href: `https://metamask.app.link/dapp/${bare}` },
    { id: 'okx', name: 'OKX Wallet', href: `okx://wallet/dapp/url?dappUrl=${enc}` },
    { id: 'trust', name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { id: 'coinbase', name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
  ]
}

/** Customer pays from their browser wallet: a USDC transfer to the merchant on `chain`. */
export async function payWithBrowserWallet(w: BrowserWallet, chain: PayChain, merchantWallet: string, amount: number): Promise<string> {
  const from = await connectWallet(w)
  await ensureChain(w, chain)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchantWallet as Hex, parseUnits(amount.toFixed(6), 6)] })
  const hash: string = await w.provider.request({ method: 'eth_sendTransaction', params: [{ from, to: chain.usdc, data }] })
  return hash
}

// Browser-readable RPCs per chain (Arc goes through MeshPort's proxy).
const READ_RPCS: Record<string, string> = {
  Ethereum_Sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  Base_Sepolia: 'https://base-sepolia-rpc.publicnode.com',
  Arbitrum_Sepolia: 'https://arbitrum-sepolia-rpc.publicnode.com',
  Optimism_Sepolia: 'https://optimism-sepolia-rpc.publicnode.com',
  Polygon_Sepolia: 'https://polygon-amoy-bor-rpc.publicnode.com',
  Avalanche_Fuji: 'https://api.avax-test.network/ext/bc/C/rpc',
  HyperEVM_Testnet: 'https://rpcs.chain.link/hyperevm/testnet',
  Sei_Testnet: 'https://evm-rpc-testnet.sei-apis.com',
  Unichain_Sepolia: 'https://sepolia.unichain.org',
}

/** The connected wallet's USDC on each payable chain (for "Pay with"). */
export async function walletBalances(address: string, chains: PayChain[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(chains.map(async c => {
    try {
      const url = c.id === 'Arc_Testnet' ? `${window.location.origin}/api/arc-rpc` : READ_RPCS[c.id]
      if (!url) return
      const client = createPublicClient({ transport: http(url, { timeout: 8000 }) })
      const bal = await (client as any).readContract({ address: c.usdc as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [address as Hex] }) as bigint
      out[c.id] = Number(bal) / 1e6
    } catch { /* unknown → not shown as payable */ }
  }))
  return out
}

// ── Payments on other chains + Auto-convert ─────────────────────────────────
/** A USDC payment to the merchant's address on another chain (Base, Ethereum…). */
export type ChainReceipt = {
  id: string; chain: string; txHash: string; from: string | null; amount: number; orderNumber: string | null
  status: 'received' | 'converting' | 'converted'; createdAt: string; convertedAt: string | null
}
export async function listChainReceipts(limit = 50): Promise<ChainReceipt[]> {
  const { data } = await supabase.from('merchant_chain_receipts').select('*').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []).map((r: any) => ({
    id: r.id, chain: r.source_chain, txHash: r.tx_hash, from: r.from_address ?? null, amount: Number(r.amount),
    orderNumber: r.order_number ?? null, status: r.status, createdAt: r.created_at, convertedAt: r.converted_at ?? null,
  }))
}

export type AutoConvert = { enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastResult: string | null }
const mapAuto = (r: any): AutoConvert => ({
  enabled: !!r?.enabled, nextRunAt: r?.next_run_at ?? null, lastRunAt: r?.last_run_at ?? null, lastResult: r?.last_result ?? null,
})
export async function getAutoConvert(): Promise<AutoConvert> {
  const { data } = await supabase.from('merchant_auto_convert').select('*').maybeSingle()
  return mapAuto(data)
}
export async function setAutoConvert(enabled: boolean): Promise<AutoConvert> {
  const { data, error } = await supabase.rpc('merchant_auto_convert_set', { p_enabled: enabled })
  if (error) throw new Error(error.message)
  return mapAuto(data)
}
