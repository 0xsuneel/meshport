// "Pay from your wallet" — for someone who scanned a MeshPort QR with their
// wallet app (MetaMask, OKX, Trust, Coinbase…): the wallet opens this page in
// its own browser, we add Arc Testnet to the wallet if it's missing, and the
// wallet shows the send with address, amount and network filled in.
// In a normal browser (no wallet inside) it offers "Open in <wallet>" links
// and the payment details to copy.
import { useEffect, useState } from 'react'
import { CheckCircle2, Copy, Wallet, ExternalLink } from 'lucide-react'
import { useUIStore } from '@/store'
import { formatAmount, copyToClipboard } from '@/lib/utils'
import {
  discoverWallets, payArcFromBrowserWallet, payWithBrowserWallet, walletAppLinks, submitPayment, gasCoin, txExplorerUrl,
  ARC_PAY_CHAIN, type BrowserWallet, type PayChain,
} from '@/lib/merchantPay'
import { MERCHANT_QR_NETWORK_NAME } from '@/lib/merchantQr'

type Props = {
  /** Recipient wallet on Arc. */
  to: string
  /** Fixed amount (orders / requests). Null → the payer types it. */
  amount: number | null
  /** Order code: the payment is confirmed against the order after sending. */
  code?: string
  orderNumber?: string | null
  /** Network to pay on (Merchant QR). Default: Arc. */
  chain?: PayChain
  onPaid?: () => void
}

export function WalletPayPanel({ to, amount, code, orderNumber, chain = ARC_PAY_CHAIN, onPaid }: Props) {
  const isArc = chain.id === 'Arc_Testnet'
  const netName = MERCHANT_QR_NETWORK_NAME[chain.id] ?? chain.label
  const { showToastMessage } = useUIStore()
  const [wallets, setWallets] = useState<BrowserWallet[] | null>(null)
  const [typed, setTyped] = useState('')
  const [step, setStep] = useState<'idle' | 'working' | 'confirming' | 'done'>('idle')
  const [error, setError] = useState('')
  const [hash, setHash] = useState('')

  useEffect(() => { discoverWallets(600).then(setWallets).catch(() => setWallets([])) }, [])

  const value = amount ?? Number(typed)
  const valid = Number.isFinite(value) && value > 0

  const pay = async (w: BrowserWallet) => {
    if (!valid) { setError('Enter an amount'); return }
    setError(''); setStep('working')
    try {
      // Arc: native USDC send. Other chains: USDC token transfer there.
      const h = isArc ? await payArcFromBrowserWallet(w, to, value) : await payWithBrowserWallet(w, chain, to, value)
      setHash(h)
      if (code) {
        setStep('confirming')
        await submitPayment(code, chain.id, h, { orderNumber: orderNumber ?? undefined, amount: value }).catch(() => null)
      }
      setStep('done')
      onPaid?.()
    } catch (e: any) {
      setStep('idle')
      const msg = String(e?.message ?? e ?? '')
      setError(e?.code === 4001 || /reject|denied|cancel/i.test(msg) ? 'Payment cancelled in the wallet' : msg || 'Payment failed')
    }
  }

  const copy = async (v: string, what: string) => {
    const ok = await copyToClipboard(v)
    showToastMessage(ok ? `${what} copied` : 'Could not copy', ok ? 'success' : 'error')
  }

  const box: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }
  const btn: React.CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '13px 14px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }
  const row = (k: string, v: string, full?: string, what?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
      <span style={{ width: 64, flexShrink: 0, color: 'var(--text-secondary)' }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
      {full && (
        <button onClick={() => copy(full, what ?? k)} aria-label={`Copy ${k}`}
          style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}><Copy size={14} /></button>
      )}
    </div>
  )

  if (step === 'done') {
    return (
      <div style={{ ...box, alignItems: 'center', textAlign: 'center' }}>
        <CheckCircle2 size={44} color="var(--success)" />
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Payment sent</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>${formatAmount(value)} USDC on {chain.label}{orderNumber ? ` · Order #${orderNumber}` : ''}</div>
        {hash && txExplorerUrl(chain.id, hash) && (
          <a href={txExplorerUrl(chain.id, hash)!} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            View transaction <ExternalLink size={12} />
          </a>
        )}
      </div>
    )
  }

  const pageUrl = typeof window !== 'undefined' ? window.location.href.replace(/[?&]stay=1/, '') : ''

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Wallet size={18} color="var(--brand)" />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Pay from your wallet</span>
      </div>

      {amount == null && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 4 }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-secondary)' }}>$</span>
          <input inputMode="decimal" value={typed} placeholder="0.00" aria-label="Amount in USDC"
            onChange={e => setTyped(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,6}).*$/, '$1'))}
            style={{ width: `${Math.max(4, typed.length) + 0.6}ch`, maxWidth: 220, fontSize: 32, fontWeight: 800, textAlign: 'center', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)' }} />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>USDC</span>
        </div>
      )}

      <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {row('Network', `${netName} · chain ${chain.chainId}`)}
        {row('To', `${to.slice(0, 8)}…${to.slice(-6)}`, to, 'Address')}
        {valid && row('Amount', `${formatAmount(value)} USDC`, String(value), 'Amount')}
      </div>

      {wallets === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center' }}>Looking for your wallet…</div>
      ) : wallets.length > 0 ? (
        <>
          {wallets.slice(0, 3).map(w => (
            <button key={w.id} onClick={() => pay(w)} disabled={step !== 'idle' || !valid}
              style={{ ...btn, opacity: step !== 'idle' || !valid ? 0.6 : 1 }}>
              {w.icon ? <img src={w.icon} alt="" width={20} height={20} style={{ borderRadius: 5 }} /> : <Wallet size={18} />}
              {step === 'working' ? 'Confirm in your wallet…'
                : step === 'confirming' ? 'Confirming payment…'
                : `Pay${valid ? ` $${formatAmount(value)}` : ''} with ${wallets.length > 1 ? w.name : 'this wallet'}`}
            </button>
          ))}
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.45 }}>
            Your wallet adds {netName} if it doesn't have it yet, then shows the payment to confirm. Gas is paid in {gasCoin(chain.id)}.
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Open this page in your wallet app to pay — it fills in the network, address and amount:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {walletAppLinks(pageUrl).map(l => (
              <a key={l.id} href={l.href}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 8px', borderRadius: 12, border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                {l.name}
              </a>
            ))}
          </div>
        </>
      )}

      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', textAlign: 'center' }}>{error}</div>}
    </div>
  )
}
