// Home → Receive → "Merchant QR" (approved merchants only).
// The merchant enters an amount and picks the network; MeshPort creates an
// order (unique order number) and shows an EIP-681 QR — any wallet that scans
// it (MetaMask, OKX, Trust…) opens on that network with the amount filled in.
// The deposit watcher links the payment to the order within about a minute;
// the status below updates live. The network can be switched for the same
// order (the watcher checks every supported chain).
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, Download, Share2, Plus, Copy } from 'lucide-react'
import { ExpiryChips } from '@/features/receive/RequestQrPanel'
import { useAuthStore, useUIStore } from '@/store'
import { formatAmount, copyToClipboard } from '@/lib/utils'
import {
  createPaymentRequest, watchPayment, orderLabel, STATUS_LABEL, orderChainPayLink,
  type MerchantIntent, type PaymentView,
} from '@/lib/merchantPay'
import { MERCHANT_QR_EXTERNAL, MERCHANT_QR_NETWORK_NAME, merchantQrChain } from '@/lib/merchantQr'


const box: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow-1)' }
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }

export function ChainPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
      {MERCHANT_QR_EXTERNAL.map(c => {
        const on = c.id === value
        return (
          <button key={c.id} type="button" onClick={() => onChange(c.id)}
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '7px 11px 7px 8px', borderRadius: 999, cursor: 'pointer',
              border: on ? '1px solid var(--brand)' : '1px solid var(--border)',
              background: on ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'transparent',
              color: on ? 'var(--brand)' : 'var(--text-secondary)', fontSize: 12.5, fontWeight: 700 }}>
            <img src={c.logo} alt="" width={18} height={18} style={{ borderRadius: '50%' }}
              onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/** How to scan + the payment written out, for wallets that ignore the QR's details. */
export function WalletPaymentDetails({ chainId, to, amount }: { chainId: string; to: string; amount: number }) {
  const { showToastMessage } = useUIStore()
  const c = merchantQrChain(chainId)
  const net = MERCHANT_QR_NETWORK_NAME[c.id] ?? c.label
  const copy = async (v: string, what: string) => { const ok = await copyToClipboard(v); showToastMessage(ok ? `${what} copied` : 'Could not copy', ok ? 'success' : 'error') }
  const row = (k: string, v: string, copyVal?: string, what?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: 'var(--text-secondary)', width: 64, flexShrink: 0 }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
      {copyVal && (
        <button type="button" onClick={() => copy(copyVal, what ?? k)} aria-label={`Copy ${k}`}
          style={{ flexShrink: 0, background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}><Copy size={13} /></button>
      )}
    </div>
  )
  return (
    <div style={{ width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.45 }}>
        Scan with any wallet app (MetaMask, OKX, Trust, Coinbase…) — it opens the payment on <b style={{ color: 'var(--text-primary)' }}>{net}</b> with the address and amount filled in, and adds the network if the wallet doesn't have it.
      </div>
      <div style={{ padding: '9px 11px', borderRadius: 12, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {row('Network', `${net} · chain ${c.chainId}`)}
        {row('Token', c.native ? 'USDC (native coin)' : `USDC · ${c.usdc!.slice(0, 6)}…${c.usdc!.slice(-4)}`, c.native ? undefined : c.usdc!, 'Token address')}
        {row('To', `${to.slice(0, 8)}…${to.slice(-6)}`, to, 'Address')}
        {row('Amount', `${formatAmount(amount)} USDC (exact)`, String(amount), 'Amount')}
      </div>
    </div>
  )
}

export function MerchantQrPanel() {
  const { showToastMessage } = useUIStore()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [amount, setAmount] = useState('')
  const [chain, setChain] = useState(MERCHANT_QR_EXTERNAL[0].id)
  const [expiry, setExpiry] = useState(60)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<MerchantIntent | null>(null)
  const [live, setLive] = useState<PaymentView | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const c = merchantQrChain(chain)
  // The order page for this network: a wallet app's scanner opens it in the
  // wallet's browser, which adds/switches to the network and fills in the
  // address and amount (WalletPayPanel). MeshPort's scanner opens the order.
  const uri = order ? orderChainPayLink(order.code, order.orderNumber, chain) : ''

  useEffect(() => {
    if (!uri || !canvasRef.current) return
    import('qrcode').then(Q => Q.toCanvas(canvasRef.current!, uri, { width: 220, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'H' })).catch(() => {})
  }, [uri])

  useEffect(() => (order ? watchPayment(order.code, setLive, 5000) : undefined), [order?.code])

  const create = async () => {
    const n = Number(amount)
    if (!(n > 0)) { showToastMessage('Enter an amount', 'error'); return }
    setBusy(true)
    try {
      // Merchant QR: amount + network + expiry only.
      const it = await createPaymentRequest({ amount: n, expiresInMinutes: expiry || null })
      setLive(null); setOrder(it)
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not create the payment QR', 'error')
    }
    setBusy(false)
  }

  const reset = () => { setOrder(null); setLive(null); setAmount('') }

  const qrFile = async (): Promise<File | null> => {
    const qr = canvasRef.current
    if (!qr || !order) return null
    const W = 600, H = 760
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const g = cv.getContext('2d'); if (!g) return null
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.textAlign = 'center'
    g.fillStyle = '#111'; g.font = '700 26px system-ui, sans-serif'; g.fillText('Scan to pay', W / 2, 58)
    g.font = '800 44px system-ui, sans-serif'; g.fillText(`$${formatAmount(order.amount)} USDC`, W / 2, 118)
    g.fillStyle = '#444'; g.font = '600 22px system-ui, sans-serif'; g.fillText(`Order #${orderLabel(order)} · ${c.label}`, W / 2, 156)
    g.drawImage(qr, (W - 420) / 2, 182, 420, 420)
    g.fillStyle = '#555'; g.font = '500 18px system-ui, sans-serif'
    g.fillText(`Scan with any wallet app · ${MERCHANT_QR_NETWORK_NAME[c.id] ?? c.label}`, W / 2, 648)
    g.fillText(`Pay exactly ${formatAmount(order.amount)} USDC`, W / 2, 676)
    const blob: Blob | null = await new Promise(r => cv.toBlob(b => r(b), 'image/png'))
    return blob ? new File([blob], `order-${orderLabel(order)}-${c.label.toLowerCase()}.png`, { type: 'image/png' }) : null
  }
  const save = async () => {
    const f = await qrFile(); if (!f) return
    const url = URL.createObjectURL(f); const a = document.createElement('a'); a.href = url; a.download = f.name
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const share = async () => {
    if (!order) return
    const f = await qrFile().catch(() => null)
    const text = `Pay $${formatAmount(order.amount)} USDC on ${c.label} · Order #${orderLabel(order)}\n${uri}`
    try {
      if (f && navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: 'Payment QR', text }); return }
      if (navigator.share) { await navigator.share({ title: 'Payment QR', text }); return }
    } catch (e: any) { if (e?.name === 'AbortError') return }
    if (f) void save()
    const ok = await copyToClipboard(text)
    showToastMessage(ok ? 'QR saved and link copied' : 'Could not copy', ok ? 'success' : 'error')
  }
  // ── Result: QR for the order ─────────────────────────────────────────────
  if (order) {
    const st = live?.status ?? 'pending'
    const paid = st === 'paid'
    const closed = ['expired', 'cancelled', 'failed'].includes(st)
    return (
      <div style={{ ...box, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.4px' }}>
            ${formatAmount(order.amount)} <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>USDC</span>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', marginTop: 2 }}>
            Order #{orderLabel(order)}
          </div>
        </div>

        {!paid && !closed && <ChainPicker value={chain} onChange={setChain} />}

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', background: '#fff', padding: 6, borderRadius: 14, opacity: paid || closed ? 0.35 : 1 }}>
            <canvas ref={canvasRef} style={{ display: 'block', width: 220, height: 220 }} />
            <img src={c.logo} alt="" width={34} height={34}
              style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', borderRadius: '50%', background: '#fff', padding: 3 }} />
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
            color: paid ? 'var(--success)' : closed ? 'var(--text-secondary)' : 'var(--warning)',
            background: paid ? 'color-mix(in srgb, var(--success) 14%, transparent)' : closed ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'color-mix(in srgb, var(--warning) 14%, transparent)' }}>
            {paid ? <CheckCircle2 size={14} /> : <Clock size={14} />}
            {paid ? 'Payment received' : closed ? STATUS_LABEL[st] : st === 'pending' ? `Waiting for payment on ${c.label}` : STATUS_LABEL[st]}
          </div>
          {!paid && !closed && walletAddress && (
            <WalletPaymentDetails chainId={chain} to={walletAddress} amount={order.amount} />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} style={ghost}><Download size={15} /> Save QR</button>
          <button onClick={share} style={ghost}><Share2 size={15} /> Share</button>
          <button onClick={async () => { const ok = !!walletAddress && await copyToClipboard(walletAddress); showToastMessage(ok ? 'Address copied' : 'Could not copy', ok ? 'success' : 'error') }} style={ghost}><Copy size={15} /> Address</button>
        </div>
        <button onClick={reset} style={{ ...primary }}><Plus size={16} /> New payment QR</button>
      </div>
    )
  }

  // ── Form ────────────────────────────────────────────────────────────────
  return (
    <div style={{ ...box, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-secondary)' }}>$</span>
          <input inputMode="decimal" value={amount} placeholder="0.00" aria-label="Amount in USDC"
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,6}).*$/, '$1'))}
            style={{ width: `${Math.max(4, amount.length) + 0.6}ch`, maxWidth: 240, fontSize: 36, fontWeight: 800, textAlign: 'center', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)' }} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>USDC</div>
      </div>

      <div>
        <div style={label}>Network</div>
        <ChainPicker value={chain} onChange={setChain} />
      </div>

      <div>
        <div style={label}>Expires</div>
        <ExpiryChips value={expiry} onChange={setExpiry} />
      </div>

      <button onClick={create} disabled={busy || !(Number(amount) > 0)} style={{ ...primary, opacity: busy || !(Number(amount) > 0) ? 0.5 : 1 }}>
        {busy ? 'Creating…' : 'Generate payment QR'}
      </button>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', marginTop: -4 }}>A unique order number is created for every QR.</div>
    </div>
  )
}

const ghost: React.CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 8px', borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primary: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '13px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
