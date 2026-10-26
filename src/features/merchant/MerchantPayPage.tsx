// /paylink/r/:code (old links: /pay/r/:code) - a customer pays a merchant's payment request.
//
// Pay with MeshPort → normal Pay/Send on Arc (direct transfer), amount and
// order number fixed. Opened in a wallet app (its scanner opens the QR's link
// in the wallet browser) → "Pay from your wallet": Arc added if needed, then
// the wallet's send with address, amount and network filled in.
// The server (merchant-pay) confirms every payment from the chain itself.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { MERCHANT_QR_CHAINS, MERCHANT_QR_EXTERNAL, merchantQrChain } from '@/lib/merchantQr'
import { chainLogoSrc } from '@/lib/chainLogos'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Clock, XCircle, ChevronRight, Home } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'
import { WalletPayPanel } from '@/features/pay/WalletPayPanel'
import { SolanaPayPanel } from '@/features/pay/SolanaPayPanel'
import { SOLANA_PAY_OPTION } from '@/lib/solanaPay'
import { formatAmount } from '@/lib/utils'
import {
  watchPayment, STATUS_LABEL, orderPaySendUrl, isOrderPayable, ARC_PAY_CHAIN, expiryText, type PaymentView,
  orderKindOf, orderTitle, } from '@/lib/merchantPay'

// Every chain merchant-pay accepts has a logo in the shared map (Arc is separate).
const logo = (id: string) => id === 'Arc_Testnet' ? '/logos/chains/arc.svg' : chainLogoSrc(id)

export function MerchantPayPage() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const myWallet = useAuthStore(s => s.walletAddress)
  const arcBalance = useWalletStore(s => s.balance)
  const [view, setView] = useState<PaymentView | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [walletPaid, setWalletPaid] = useState(false)


  useEffect(() => {
    if (!code) return
    return watchPayment(code, setView, 4000)
  }, [code])

  useEffect(() => {
    if (!code) return
    const t = setTimeout(() => { if (!view) setNotFound(true) }, 12000)
    return () => clearTimeout(t)
  }, [code, view])

  const remaining = view ? Math.max(0, Number((view.amount - view.received).toFixed(6))) : 0
  const closed = !view || ['paid', 'expired', 'cancelled', 'failed', 'processing'].includes(view.status)
  const isMerchantSelf = !!(view && myWallet && myWallet.toLowerCase() === view.merchantWallet)

  const payWithMeshPort = () => {
    if (!view) return
    const url = orderPaySendUrl(view)
    if (isAuthenticated) navigate(url)
    else { try { sessionStorage.setItem('meshport_return_to', `/paylink/r/${view.code}`) } catch { /* ignore */ } navigate('/auth') }
  }

  // Scanned in MeshPort / opened from a shared link: go straight to the pay
  // screen (order number attached, amount fixed). Paid / closed orders, your
  // own request, or ?stay=1 (coming back from paying) show this page instead.
  const [params] = useSearchParams()
  // Merchant QR: ?chain=<network> - a wallet pays there (default Arc).
  const wantChain = params.get('chain')
  // Opened in a wallet app (not signed in to MeshPort): the payer picks the
  // network - Arc, or any network MeshPort watches for payments (a business
  // settles those to Arc; a person brings them to Arc from the Multichain Hub).
  const [netId, setNetId] = useState('Arc_Testnet')
  const [netMenu, setNetMenu] = useState(false)
  // Solana: offered when the payee has a Solana address (merchant-pay lists it).
  const solanaTo = view?.merchantSolana && view.chains?.some(v => v.id === SOLANA_PAY_OPTION.id) ? view.merchantSolana : null
  const onSolana = (wantChain || netId) === SOLANA_PAY_OPTION.id && !!solanaTo
  const net = onSolana ? { ...SOLANA_PAY_OPTION } : merchantQrChain(netId)
  const netOptions = [...[MERCHANT_QR_CHAINS[0], ...MERCHANT_QR_EXTERNAL]
    .filter(c => c.native || view?.chains?.some(v => v.id === c.id)), ...(solanaTo ? [SOLANA_PAY_OPTION] : [])]
    .map(c => ({ id: c.id, label: c.label,
      icon: <img decoding="async" src={c.logo} alt="" width={22} height={22} style={{ borderRadius: '50%' }} onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} /> }))
  const pickedChain = wantChain || netId
  const payChain = (pickedChain && view?.chains?.find(c => c.id === pickedChain)) || ARC_PAY_CHAIN
  const onArc = payChain.id === ARC_PAY_CHAIN.id
  // A QR made for one network (Sepolia, Base…) is paid on that network only:
  // no "Pay with MeshPort" (Arc) and no jump to the Arc pay screen. The plain
  // order QR / link is the one that pays with MeshPort.
  const chainOnly = !!wantChain && wantChain !== 'Arc_Testnet'
  const redirected = useRef(false)
  useEffect(() => {
    if (!view || redirected.current || !isAuthenticated || isMerchantSelf || params.get('stay') || chainOnly) return
    if (!isOrderPayable(view)) return
    redirected.current = true
    navigate(orderPaySendUrl(view), { replace: true })
  }, [view, isAuthenticated, isMerchantSelf, params, navigate, chainOnly])

  // About to go straight to the pay screen: keep showing the loader rather
  // than flashing this page for a moment first.
  const willRedirect = !!view && isAuthenticated && !isMerchantSelf && !params.get('stay') && !chainOnly && isOrderPayable(view)
  if (!view || willRedirect) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: 'var(--bg)' }}>
        {notFound ? (
          <>
            <XCircle className="w-10 h-10 text-danger" />
            <p className="text-base font-bold text-text-primary">Payment request not found</p>
            <button onClick={() => navigate('/')} className="mt-2 px-5 py-3 rounded-2xl text-sm font-semibold text-white flex items-center gap-2" style={{ background: 'var(--brand)' }}><Home className="w-4 h-4" /> MeshPort</button>
          </>
        ) : <MeshLoader size={48} />}
      </div>
    )
  }

  const statusColor = view.status === 'paid' ? 'var(--success)' : ['expired', 'cancelled', 'failed'].includes(view.status) ? 'var(--danger)' : 'var(--warning)'

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg)' }}>
      <div className="px-5 pt-8 pb-10 max-w-[480px] mx-auto space-y-5">
        {/* Header */}
        <div className="text-center space-y-2">
          <p className="text-sm text-text-secondary">Pay</p>
          <p className="text-xl font-bold text-text-primary">{view.merchantName ?? 'Business'}</p>
          {/* The store (branch) it's for, when it isn't just the business name. */}
          {view.storeName && view.storeName.toLowerCase() !== (view.merchantName ?? '').toLowerCase() && (
            <p className="text-sm font-semibold text-text-secondary -mt-1">{view.storeName}</p>
          )}
          <p className="text-4xl font-extrabold text-text-primary">${formatAmount(view.amount)} <span className="text-lg font-semibold text-text-secondary">USDC</span></p>
          {view.orderNumber && <p className="text-sm font-semibold text-text-primary">{orderTitle(orderKindOf(view), view.orderNumber, { paid: view.status === 'paid' })}</p>}
          {view.note && <p className="text-sm text-text-secondary">{view.note}</p>}
          {view.kind === 'invoice' && !!view.items?.length && (
            <div className="bg-surface border border-border rounded-2xl p-4 text-left mt-2">
              <p className="text-xs font-bold text-text-secondary mb-2">Bill</p>
              {view.items.map((i, k) => (
                <div key={k} className="flex justify-between gap-3 text-sm py-1">
                  <span className="text-text-primary truncate">{i.name} <span className="text-text-secondary">× {Number(i.qty)} @ ${formatAmount(Number(i.price))}</span></span>
                  <span className="text-text-primary font-semibold">${formatAmount(Number(i.total ?? i.qty * i.price))}</span>
                </div>
              ))}
              {(() => {
                const sub = view.items!.reduce((s, i) => s + Number(i.total ?? Number(i.qty) * Number(i.price)), 0)
                return (
                  <div className="border-t border-border mt-2 pt-2">
                    {!!view.taxPercent && (
                      <>
                        <div className="flex justify-between text-sm text-text-secondary py-0.5"><span>Subtotal</span><span>${formatAmount(sub)}</span></div>
                        <div className="flex justify-between text-sm text-text-secondary py-0.5"><span>Tax ({view.taxPercent}%)</span><span>+ ${formatAmount(Math.max(0, view.amount - sub))}</span></div>
                      </>
                    )}
                    <div className="flex justify-between text-sm font-bold text-text-primary py-0.5"><span>Total</span><span>${formatAmount(view.amount)} USDC</span></div>
                  </div>
                )
              })()}
            </div>
          )}
          {/* Paid / arriving / expired / cancelled get their own card below. */}
          {!['paid', 'processing', 'expired', 'cancelled'].includes(view.status) && (
            <p className="text-xs font-semibold" style={{ color: statusColor }}>{STATUS_LABEL[view.status]}</p>
          )}
          {['pending', 'partially_paid', 'payment_detected'].includes(view.status) && expiryText(view.expiresAt) && (
            <p className="text-xs font-semibold" style={{ color: 'var(--warning-text)' }}>{expiryText(view.expiresAt)}</p>
          )}
          {view.received > 0 && view.status !== 'paid' && (
            <p className="text-xs text-text-secondary">Received ${formatAmount(view.received)} of ${formatAmount(view.amount)}</p>
          )}
        </div>

        {/* Done / closed states */}
        {view.status === 'paid' && (
          <div className="bg-surface border border-border rounded-3xl p-6 flex flex-col items-center gap-2 text-center">
            <CheckCircle2 className="w-12 h-12 text-success" />
            <p className="text-base font-bold text-text-primary">{view.completedByMerchant ? 'Order completed' : 'Payment received'}</p>
            <p className="text-sm text-text-secondary">{view.completedByMerchant
              ? `${view.merchantName ?? 'The business'} marked this order as completed.`
              : 'Confirmed on-chain.'}</p>
          </div>
        )}
        {view.status === 'processing' && (
          <div className="bg-surface border border-border rounded-3xl p-6 flex flex-col items-center gap-2 text-center">
            <Clock className="w-12 h-12 text-warning" />
            <p className="text-base font-bold text-text-primary">Payment sent</p>
            <p className="text-sm text-text-secondary">It reached {view.merchantName} and is being moved to their main balance - nothing more to do.</p>
          </div>
        )}
        {(view.status === 'expired' || view.status === 'cancelled') && (
          <div className="bg-surface border border-border rounded-3xl p-6 text-center text-sm text-text-secondary">
            This payment request {view.status === 'expired' ? 'has expired' : 'was cancelled'}. Ask {view.merchantName} for a new one.
          </div>
        )}

        {/* Pay */}
        {!closed && !isMerchantSelf && (
          <>
            {!isAuthenticated && !chainOnly && remaining > 0 && !walletPaid && netOptions.length > 1 && (
              // Which network to pay on - the same pill + list as Pay's token picker.
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold text-text-secondary">Pay on network</p>
                <div style={{ position: 'relative', zIndex: netMenu ? 41 : undefined }}>
                  <button type="button" onClick={e => { e.stopPropagation(); setNetMenu(v => !v) }} aria-expanded={netMenu} aria-label={`Network: ${net.label}`}
                    className="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full active:opacity-70"
                    style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
                    <img decoding="async" src={net.logo} alt="" width={22} height={22} style={{ borderRadius: '50%' }} />
                    <span className="flex-1 min-w-0 truncate text-left text-sm font-bold text-text-primary">{net.label}</span>
                    <svg className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--brand-text)', transform: netMenu ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <AnimatePresence>
                    {netMenu && <TokenMenu ariaLabel="Choose network" maxHeight={320} selected={netId} options={netOptions} onSelect={setNetId} onClose={() => setNetMenu(false)} />}
                  </AnimatePresence>
                </div>
                <p className="text-[12px] leading-snug text-text-muted">
                  Send only <b className="text-text-primary">USDC on {net.label}</b> - other tokens or networks won't reach {view.merchantName ?? 'them'}.
                </p>
              </div>
            )}
            {(!isAuthenticated || chainOnly) && remaining > 0 && (onSolana && solanaTo
              ? <SolanaPayPanel key="solana" to={solanaTo} amount={remaining} code={view.code} orderNumber={view.orderNumber} label={view.merchantName ?? undefined} onPaid={() => setWalletPaid(true)} />
              : <WalletPayPanel key={payChain.id} to={view.merchantWallet} amount={remaining} code={view.code} orderNumber={view.orderNumber} chain={payChain} onPaid={() => setWalletPaid(true)} />
            )}
            {/* MeshPort pays on Arc only. */}
            {!walletPaid && !chainOnly && onArc && <button onClick={payWithMeshPort} disabled={isAuthenticated && arcBalance < remaining}
              className="w-full bg-surface border border-border rounded-3xl p-4 flex items-center gap-3 text-left disabled:opacity-60">
              <img decoding="async" src={logo('Arc_Testnet')} alt="" className="w-10 h-10 rounded-full" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">Pay with MeshPort</p>
                <p className="text-xs text-text-secondary">
                  {!isAuthenticated ? 'Sign in to pay from your Arc balance'
                    : arcBalance >= remaining ? `Arc balance $${formatAmount(arcBalance)} USDC`
                    : `Not enough on Arc ($${formatAmount(arcBalance)} USDC)`}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-text-secondary" />
            </button>}

          </>
        )}

        {isMerchantSelf && !closed && (
          <p className="text-center text-sm text-text-secondary">This is your own payment request. Share the link or QR with your customer.</p>
        )}
        <p className="text-center text-[11px] text-text-secondary">Secured by MeshPort · payments are confirmed on-chain</p>
      </div>
    </div>
  )
}
