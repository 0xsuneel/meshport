// /pay/r/:code — a customer pays a merchant's payment request.
//
// Pay with MeshPort → normal Pay/Send on Arc (direct transfer), amount and
// order number fixed. Opened in a wallet app (its scanner opens the QR's link
// in the wallet browser) → "Pay from your wallet": Arc added if needed, then
// the wallet's send with address, amount and network filled in.
// The server (merchant-pay) confirms every payment from the chain itself.
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Clock, XCircle, ChevronRight, Home } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'
import { WalletPayPanel } from '@/features/pay/WalletPayPanel'
import { formatAmount } from '@/lib/utils'
import {
  watchPayment, STATUS_LABEL, orderPaySendUrl, isOrderPayable, ARC_PAY_CHAIN, type PaymentView,
} from '@/lib/merchantPay'

const CHAIN_LOGO: Record<string, string> = {
  Arc_Testnet: 'arc', Ethereum_Sepolia: 'ethereum', Base_Sepolia: 'base', Arbitrum_Sepolia: 'arbitrum',
  Optimism_Sepolia: 'optimism', Polygon_Sepolia: 'polygon', Avalanche_Fuji: 'avalanche', HyperEVM_Testnet: 'hyperevm',
  Sei_Testnet: 'sei', Unichain_Sepolia: 'unichain',
}
const logo = (id: string) => `/logos/chains/${CHAIN_LOGO[id] ?? '_fallback'}.svg`

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
    else { try { sessionStorage.setItem('meshport_return_to', `/pay/r/${view.code}`) } catch { /* ignore */ } navigate('/auth') }
  }

  // Scanned in MeshPort / opened from a shared link: go straight to the pay
  // screen (order number attached, amount fixed). Paid / closed orders, your
  // own request, or ?stay=1 (coming back from paying) show this page instead.
  const [params] = useSearchParams()
  // Merchant QR: ?chain=<network> — a wallet pays there (default Arc).
  const wantChain = params.get('chain')
  const payChain = (wantChain && view?.chains?.find(c => c.id === wantChain)) || ARC_PAY_CHAIN
  const redirected = useRef(false)
  useEffect(() => {
    if (!view || redirected.current || !isAuthenticated || isMerchantSelf || params.get('stay')) return
    if (!isOrderPayable(view)) return
    redirected.current = true
    navigate(orderPaySendUrl(view), { replace: true })
  }, [view, isAuthenticated, isMerchantSelf, params, navigate])

  if (!view) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: 'var(--bg)' }}>
        {notFound ? (
          <>
            <XCircle className="w-10 h-10 text-danger" />
            <p className="text-base font-bold text-text-primary">Payment request not found</p>
            <button onClick={() => navigate('/')} className="mt-2 px-5 py-3 rounded-2xl text-sm font-semibold text-white flex items-center gap-2" style={{ background: 'var(--brand)' }}><Home className="w-4 h-4" /> MeshPort</button>
          </>
        ) : <div className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--brand) 30%, transparent)', borderTopColor: 'var(--brand)' }} />}
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
          <p className="text-xl font-bold text-text-primary">{view.merchantName ?? 'Merchant'}</p>
          <p className="text-4xl font-extrabold text-text-primary">${formatAmount(view.amount)} <span className="text-lg font-semibold text-text-secondary">USDC</span></p>
          {view.orderNumber && <p className="text-sm font-semibold text-text-primary">Order #{view.orderNumber}</p>}
          {view.note && <p className="text-sm text-text-secondary">{view.note}</p>}
          {view.kind === 'invoice' && !!view.items?.length && (
            <div className="bg-surface border border-border rounded-2xl p-4 text-left mt-2">
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-2">Bill</p>
              {view.items.map((i, k) => (
                <div key={k} className="flex justify-between gap-3 text-sm py-1">
                  <span className="text-text-primary truncate">{i.name} <span className="text-text-secondary">× {Number(i.qty)} @ ${formatAmount(Number(i.price))}</span></span>
                  <span className="text-text-primary font-semibold">${formatAmount(Number(i.total ?? i.qty * i.price))}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-border mt-2 pt-2 text-sm font-bold text-text-primary">
                <span>Total</span><span>${formatAmount(view.amount)} USDC</span>
              </div>
            </div>
          )}
          <p className="text-xs font-semibold" style={{ color: statusColor }}>{STATUS_LABEL[view.status]}</p>
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
              ? `${view.merchantName ?? 'The merchant'} marked this order as completed.`
              : `$${formatAmount(view.received)} USDC to ${view.merchantName}`}</p>
          </div>
        )}
        {view.status === 'processing' && (
          <div className="bg-surface border border-border rounded-3xl p-6 flex flex-col items-center gap-2 text-center">
            <Clock className="w-12 h-12 text-warning" />
            <p className="text-base font-bold text-text-primary">Payment sent</p>
            <p className="text-sm text-text-secondary">Your ${formatAmount(view.received)} USDC reached {view.merchantName}. It’s being moved to their main balance — nothing more to do.</p>
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
            {!isAuthenticated && remaining > 0 && (
              <WalletPayPanel to={view.merchantWallet} amount={remaining} code={view.code} orderNumber={view.orderNumber} chain={payChain} onPaid={() => setWalletPaid(true)} />
            )}
            {!walletPaid && <button onClick={payWithMeshPort} disabled={isAuthenticated && arcBalance < remaining}
              className="w-full bg-surface border border-border rounded-3xl p-4 flex items-center gap-3 text-left disabled:opacity-60">
              <img src={logo('Arc_Testnet')} alt="" className="w-10 h-10 rounded-full" />
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
